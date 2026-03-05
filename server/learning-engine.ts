import { db } from "./db";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  closeOutcomes, policyWeights,
  type CloseOutcome, type InsertCloseOutcome,
  type PolicyWeight,
} from "@shared/schema";

const EWMA_ALPHA = 0.15;
const UCB_C = 1.5;

const MIN_SAMPLES_FOR_PENALTY = 5;
const POOR_WIN_RATE_THRESHOLD = 0.35;
const SCORE_PENALTY_PER_LOSS_PCT = 8;
const MAX_SCORE_PENALTY = 20;

export interface CloseOutcomeInput {
  agentId: string;
  positionDbId: string;
  closeMethod: string;
  regime?: string;
  side?: string;
  entryPrice?: number;
  closePrice?: number;
  leverage?: number;
  collateral?: number;
  closeTxDigest?: string;
  errorCode?: string;
  latencyMs?: number;
  pnlSui?: number;
  onChainSuccess?: boolean;
  htfBias?: string;
  signalScore?: number;
  signalType?: string;
}

export interface EntryFeedback {
  scorePenalty: number;
  regimeSideBlocked: boolean;
  reason: string;
}

const entryStatsCache = new Map<string, { winRate: number; count: number; avgPnl: number; updatedAt: number }>();
const CACHE_TTL_MS = 60_000;

function computeLabel(input: CloseOutcomeInput): string {
  if (input.errorCode && !input.onChainSuccess) return "FAIL";
  if (input.onChainSuccess) return "SUCCESS";
  if (input.closeTxDigest) return "SUCCESS";
  if (input.closeMethod === "liquidated" || input.closeMethod === "DB-fallback") return "PARTIAL";
  return "TIMEOUT";
}

function computeSlippageBps(input: CloseOutcomeInput): number | null {
  if (!input.entryPrice || !input.closePrice) return null;
  return Math.abs(input.closePrice - input.entryPrice) / input.entryPrice * 10000;
}

export function computeReward(label: string, latencyMs?: number | null, slippageBps?: number | null, pnlSui?: number | null): number {
  let reward = 0;

  switch (label) {
    case "SUCCESS": reward = 2.5; break;
    case "PARTIAL": reward = 0.5; break;
    case "TIMEOUT": reward = -1.5; break;
    case "FAIL": reward = -2.5; break;
    default: reward = 0;
  }

  if (latencyMs && latencyMs < 3000) reward += 0.5;
  else if (latencyMs && latencyMs < 8000) reward += 0.2;
  else if (latencyMs && latencyMs > 30000) reward -= 0.3;

  if (slippageBps && slippageBps > 100) reward -= 0.5;
  else if (slippageBps && slippageBps > 50) reward -= 0.2;
  else if (slippageBps !== null && slippageBps !== undefined && slippageBps < 20) reward += 0.3;

  if (pnlSui !== null && pnlSui !== undefined) {
    if (pnlSui > 0.5) reward += 1.0;
    else if (pnlSui > 0.1) reward += 0.4;
    else if (pnlSui > 0) reward += 0.1;
    else if (pnlSui < -0.5) reward -= 1.0;
    else if (pnlSui < -0.1) reward -= 0.5;
    else if (pnlSui < 0) reward -= 0.2;
  }

  return reward;
}

export function computeEnrichedReward(input: {
  label: string;
  latencyMs?: number | null;
  slippageBps?: number | null;
  pnlSui?: number | null;
  closeTxDigest?: string | null;
  onChainSuccess?: boolean;
  collateral?: number | null;
}): number {
  let reward = computeReward(input.label, input.latencyMs, input.slippageBps, input.pnlSui);

  if (input.closeTxDigest && input.onChainSuccess) {
    reward += 0.5;
  }

  if (input.collateral && input.collateral > 0 && input.pnlSui !== undefined && input.pnlSui !== null) {
    const pnlPerRisk = input.pnlSui / input.collateral;
    if (pnlPerRisk > 0.5) reward += 0.8;
    else if (pnlPerRisk > 0.2) reward += 0.4;
    else if (pnlPerRisk > 0) reward += 0.1;
    else if (pnlPerRisk < -0.5) reward -= 0.6;
    else if (pnlPerRisk < -0.2) reward -= 0.3;
    else if (pnlPerRisk < 0) reward -= 0.1;
  }

  return reward;
}

export async function logCloseOutcome(input: CloseOutcomeInput): Promise<CloseOutcome> {
  const label = computeLabel(input);
  const slippageBps = computeSlippageBps(input);
  const isProfitable = (input.pnlSui || 0) > 0;

  const data: InsertCloseOutcome = {
    agentId: input.agentId,
    positionDbId: input.positionDbId,
    closeMethod: input.closeMethod,
    regime: input.regime || null,
    side: input.side || null,
    label,
    latencyMs: input.latencyMs || null,
    slippageBps,
    pnlSui: input.pnlSui || null,
    closeTxDigest: input.closeTxDigest || null,
    entryPrice: input.entryPrice || null,
    closePrice: input.closePrice || null,
    leverage: input.leverage || null,
    collateral: input.collateral || null,
    errorCode: input.errorCode || null,
  };

  const [outcome] = await db.insert(closeOutcomes).values(data).returning();

  const reward = computeEnrichedReward({
    label,
    latencyMs: input.latencyMs,
    slippageBps,
    pnlSui: input.pnlSui,
    closeTxDigest: input.closeTxDigest,
    onChainSuccess: input.onChainSuccess,
    collateral: input.collateral,
  });

  const regime = input.regime || "UNKNOWN";
  const side = input.side || "UNKNOWN";

  await updateWeights("SUI-PERP", regime, input.closeMethod, reward, isProfitable);

  const entryKey = `entry:${regime}:${side}`;
  await updateWeights("SUI-PERP", regime, entryKey, reward, isProfitable);

  const agentEntryKey = `agent:${input.agentId}:${regime}:${side}`;
  await updateWeights("SUI-PERP", regime, agentEntryKey, reward, isProfitable);

  if (input.htfBias) {
    const htfKey = `entry:${regime}:${side}:htf_${input.htfBias}`;
    await updateWeights("SUI-PERP", regime, htfKey, reward, isProfitable);
  }

  invalidateEntryStatsCache(regime, side);
  entryStatsCache.delete(agentEntryKey);

  console.log(`[Learning] Outcome: ${label} | method=${input.closeMethod} regime=${regime} side=${side} pnl=${input.pnlSui?.toFixed(3) ?? "?"} reward=${reward.toFixed(2)} profitable=${isProfitable} agent=${input.agentId.slice(0, 8)}`);

  return outcome;
}

function invalidateEntryStatsCache(regime: string, side: string): void {
  const key = `${regime}:${side}`;
  entryStatsCache.delete(key);
  entryStatsCache.delete(`${regime}:ALL`);
}

async function getEntryStats(regime: string, side: string): Promise<{ winRate: number; count: number; avgPnl: number }> {
  const key = `${regime}:${side}`;
  const cached = entryStatsCache.get(key);
  if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    return { winRate: cached.winRate, count: cached.count, avgPnl: cached.avgPnl };
  }

  const entryKey = `entry:${regime}:${side}`;
  const weights = await db.select().from(policyWeights).where(
    and(
      eq(policyWeights.market, "SUI-PERP"),
      eq(policyWeights.regime, regime),
      eq(policyWeights.actionKey, entryKey),
    )
  );

  if (weights.length === 0) {
    return { winRate: 0.5, count: 0, avgPnl: 0 };
  }

  const w = weights[0];
  const winRate = w.trials > 0 ? w.wins / w.trials : 0.5;
  const result = { winRate, count: w.trials, avgPnl: w.avgReward };
  entryStatsCache.set(key, { ...result, updatedAt: Date.now() });
  return result;
}

async function getAgentEntryStats(agentId: string, regime: string, side: string): Promise<{ winRate: number; count: number; avgPnl: number }> {
  const key = `agent:${agentId}:${regime}:${side}`;
  const cached = entryStatsCache.get(key);
  if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    return { winRate: cached.winRate, count: cached.count, avgPnl: cached.avgPnl };
  }

  const agentEntryKey = `agent:${agentId}:${regime}:${side}`;
  const weights = await db.select().from(policyWeights).where(
    and(
      eq(policyWeights.market, "SUI-PERP"),
      eq(policyWeights.regime, regime),
      eq(policyWeights.actionKey, agentEntryKey),
    )
  );

  if (weights.length === 0) {
    return { winRate: 0.5, count: 0, avgPnl: 0 };
  }

  const w = weights[0];
  const winRate = w.trials > 0 ? w.wins / w.trials : 0.5;
  const result = { winRate, count: w.trials, avgPnl: w.avgReward };
  entryStatsCache.set(key, { ...result, updatedAt: Date.now() });
  return result;
}

export async function getEntryFeedback(regime: string, side: string, consecutiveLosses: number, agentId?: string): Promise<EntryFeedback> {
  let stats: { winRate: number; count: number; avgPnl: number };

  if (agentId) {
    const agentStats = await getAgentEntryStats(agentId, regime, side);
    if (agentStats.count >= MIN_SAMPLES_FOR_PENALTY) {
      stats = agentStats;
    } else {
      stats = await getEntryStats(regime, side);
    }
  } else {
    stats = await getEntryStats(regime, side);
  }

  let scorePenalty = 0;
  let regimeSideBlocked = false;
  const reasons: string[] = [];

  if (stats.count >= MIN_SAMPLES_FOR_PENALTY) {
    if (stats.winRate < POOR_WIN_RATE_THRESHOLD) {
      const deficiency = POOR_WIN_RATE_THRESHOLD - stats.winRate;
      const regimePenalty = Math.round(deficiency * 100 * (SCORE_PENALTY_PER_LOSS_PCT / 10));
      scorePenalty += Math.min(regimePenalty, 15);
      reasons.push(`${regime}+${side} winRate=${(stats.winRate * 100).toFixed(0)}% (${stats.count} trades) — penalty +${regimePenalty}`);

      if (stats.winRate < 0.20 && stats.count >= 10) {
        regimeSideBlocked = true;
        reasons.push(`${regime}+${side} blocked: winRate ${(stats.winRate * 100).toFixed(0)}% < 20% with ${stats.count} samples`);
      }
    }
  }

  if (consecutiveLosses >= 2) {
    const lossPenalty = Math.min(consecutiveLosses * 5, MAX_SCORE_PENALTY);
    scorePenalty += lossPenalty;
    reasons.push(`${consecutiveLosses} consecutive losses — penalty +${lossPenalty}`);
  }

  return {
    scorePenalty: Math.min(scorePenalty, MAX_SCORE_PENALTY + 15),
    regimeSideBlocked,
    reason: reasons.join("; ") || "no penalty",
  };
}

export async function getRecentAgentPerformance(agentId: string, lookback: number = 20): Promise<{
  recentWinRate: number;
  recentAvgPnl: number;
  count: number;
  consecutiveLosses: number;
}> {
  const recent = await db.select().from(closeOutcomes)
    .where(eq(closeOutcomes.agentId, agentId))
    .orderBy(desc(closeOutcomes.createdAt))
    .limit(lookback);

  if (recent.length === 0) {
    return { recentWinRate: 0.5, recentAvgPnl: 0, count: 0, consecutiveLosses: 0 };
  }

  let wins = 0;
  let totalPnl = 0;
  let consecutiveLosses = 0;
  let countingStreak = true;

  for (const o of recent) {
    const pnl = o.pnlSui || 0;
    totalPnl += pnl;
    if (pnl > 0) {
      wins++;
      countingStreak = false;
    } else if (countingStreak) {
      consecutiveLosses++;
    }
  }

  return {
    recentWinRate: wins / recent.length,
    recentAvgPnl: totalPnl / recent.length,
    count: recent.length,
    consecutiveLosses,
  };
}

async function updateWeights(market: string, regime: string, actionKey: string, reward: number, isWin: boolean): Promise<void> {
  const existing = await db.select().from(policyWeights).where(
    and(
      eq(policyWeights.market, market),
      eq(policyWeights.regime, regime),
      eq(policyWeights.actionKey, actionKey),
    )
  );

  if (existing.length > 0) {
    const w = existing[0];
    const newAvg = w.avgReward * (1 - EWMA_ALPHA) + reward * EWMA_ALPHA;
    await db.update(policyWeights).set({
      trials: w.trials + 1,
      wins: w.wins + (isWin ? 1 : 0),
      avgReward: newAvg,
      updatedAt: new Date(),
    }).where(eq(policyWeights.id, w.id));
  } else {
    await db.insert(policyWeights).values({
      market,
      regime,
      actionKey,
      trials: 1,
      wins: isWin ? 1 : 0,
      avgReward: reward,
    });
  }
}

export async function getCloseStats(agentId?: string): Promise<{
  outcomes: { label: string; count: number; avgPnl: number }[];
  byRegime: { regime: string; count: number; winRate: number; avgReward: number }[];
  weights: PolicyWeight[];
  recentOutcomes: CloseOutcome[];
  entryStats: { key: string; winRate: number; count: number; avgReward: number }[];
  agentBreakdown?: { agentId: string; winRate: number; count: number; avgPnl: number; totalPnl: number; avgReward: number }[];
}> {
  let allOutcomes: CloseOutcome[];
  if (agentId) {
    allOutcomes = await db.select().from(closeOutcomes)
      .where(eq(closeOutcomes.agentId, agentId))
      .orderBy(desc(closeOutcomes.createdAt));
  } else {
    allOutcomes = await db.select().from(closeOutcomes).orderBy(desc(closeOutcomes.createdAt));
  }

  const labelMap = new Map<string, { count: number; totalPnl: number }>();
  for (const o of allOutcomes) {
    const entry = labelMap.get(o.label) || { count: 0, totalPnl: 0 };
    entry.count++;
    entry.totalPnl += o.pnlSui || 0;
    labelMap.set(o.label, entry);
  }
  const outcomes = Array.from(labelMap.entries()).map(([label, d]) => ({
    label,
    count: d.count,
    avgPnl: d.count > 0 ? d.totalPnl / d.count : 0,
  }));

  const regimeMap = new Map<string, { count: number; wins: number; totalReward: number }>();
  for (const o of allOutcomes) {
    const r = o.regime || "UNKNOWN";
    const entry = regimeMap.get(r) || { count: 0, wins: 0, totalReward: 0 };
    entry.count++;
    if ((o.pnlSui || 0) > 0) entry.wins++;
    entry.totalReward += computeEnrichedReward({
      label: o.label, latencyMs: o.latencyMs, slippageBps: o.slippageBps,
      pnlSui: o.pnlSui, closeTxDigest: o.closeTxDigest,
      onChainSuccess: !!o.closeTxDigest, collateral: o.collateral,
    });
    regimeMap.set(r, entry);
  }
  const byRegime = Array.from(regimeMap.entries()).map(([regime, d]) => ({
    regime,
    count: d.count,
    winRate: d.count > 0 ? d.wins / d.count : 0,
    avgReward: d.count > 0 ? d.totalReward / d.count : 0,
  }));

  const weights = await db.select().from(policyWeights).orderBy(desc(policyWeights.updatedAt));

  const entryWeights = weights.filter(w => w.actionKey.startsWith("entry:"));
  const entryStats = entryWeights.map(w => ({
    key: w.actionKey,
    winRate: w.trials > 0 ? w.wins / w.trials : 0,
    count: w.trials,
    avgReward: w.avgReward,
  }));

  const recentOutcomes = allOutcomes.slice(0, 20);

  const agentMap = new Map<string, { count: number; wins: number; totalPnl: number; totalReward: number }>();
  for (const o of allOutcomes) {
    const aid = o.agentId;
    const entry = agentMap.get(aid) || { count: 0, wins: 0, totalPnl: 0, totalReward: 0 };
    entry.count++;
    if ((o.pnlSui || 0) > 0) entry.wins++;
    entry.totalPnl += o.pnlSui || 0;
    entry.totalReward += computeEnrichedReward({
      label: o.label, latencyMs: o.latencyMs, slippageBps: o.slippageBps,
      pnlSui: o.pnlSui, closeTxDigest: o.closeTxDigest,
      onChainSuccess: !!o.closeTxDigest, collateral: o.collateral,
    });
    agentMap.set(aid, entry);
  }
  const agentBreakdown = Array.from(agentMap.entries()).map(([aid, d]) => ({
    agentId: aid,
    winRate: d.count > 0 ? d.wins / d.count : 0,
    count: d.count,
    avgPnl: d.count > 0 ? d.totalPnl / d.count : 0,
    totalPnl: d.totalPnl,
    avgReward: d.count > 0 ? d.totalReward / d.count : 0,
  }));

  return { outcomes, byRegime, weights, recentOutcomes, entryStats, agentBreakdown };
}

export async function getPreferredCloseMethod(regime: string): Promise<string | null> {
  const weights = await db.select().from(policyWeights).where(
    and(
      eq(policyWeights.market, "SUI-PERP"),
      eq(policyWeights.regime, regime),
    )
  );

  const closeWeights = weights.filter(w => !w.actionKey.startsWith("entry:"));
  if (closeWeights.length === 0) return null;

  const totalTrials = closeWeights.reduce((sum, w) => sum + w.trials, 0);
  let bestScore = -Infinity;
  let bestAction: string | null = null;

  for (const w of closeWeights) {
    if (w.trials === 0) continue;
    const ucbScore = w.avgReward + UCB_C * Math.sqrt(Math.log(totalTrials + 1) / w.trials);
    if (ucbScore > bestScore) {
      bestScore = ucbScore;
      bestAction = w.actionKey;
    }
  }

  return bestAction;
}
