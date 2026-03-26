import { db } from "./db";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  closeOutcomes, policyWeights, agents, precisionAdjustmentLogs,
  type CloseOutcome, type InsertCloseOutcome,
  type PolicyWeight, type PrecisionAdjustmentLog,
} from "@shared/schema";

const EWMA_ALPHA = 0.22;
const UCB_C = 1.5;

const MIN_SAMPLES_FOR_PENALTY = 4;
const POOR_WIN_RATE_THRESHOLD = 0.40;
const REGIME_BLOCK_WIN_RATE = 0.30;
const REGIME_BLOCK_MIN_SAMPLES = 3;
const SCORE_PENALTY_PER_LOSS_PCT = 10;
const MAX_SCORE_PENALTY = 35;
const CONSECUTIVE_LOSS_BLOCK_THRESHOLD = 3;
const DIRECTION_LOSS_BLOCK_THRESHOLD = 3;

const FAKE_CLOSE_DIGEST_SET = new Set(["closed_externally", "closed_external", "settled_onchain", "cancelled_unfilled", "liquidated_onchain"]);
const FAKE_CLOSE_PREFIXES = ["sim_", "recovered_", "db_", "reopened_"];

export function filterAndDeduplicateOutcomes(outcomes: CloseOutcome[]): CloseOutcome[] {
  const filtered = outcomes.filter(o => {
    if (!o.closeTxDigest) return false;
    if (FAKE_CLOSE_DIGEST_SET.has(o.closeTxDigest)) return false;
    for (const prefix of FAKE_CLOSE_PREFIXES) {
      if (o.closeTxDigest.startsWith(prefix)) return false;
    }
    return true;
  });

  const positionSeen = new Map<string, CloseOutcome>();
  for (const o of filtered) {
    const existing = positionSeen.get(o.positionDbId);
    if (!existing) {
      positionSeen.set(o.positionDbId, o);
    } else {
      const existingTime = existing.createdAt?.getTime() ?? 0;
      const candidateTime = o.createdAt?.getTime() ?? 0;
      if (candidateTime > existingTime) {
        positionSeen.set(o.positionDbId, o);
      }
    }
  }
  return Array.from(positionSeen.values());
}

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
  openTxDigest?: string;
  onChainPositionId?: string;
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
  if (input.closeTxDigest && !input.closeTxDigest.startsWith("sim_")) return "SUCCESS";
  if (input.onChainSuccess && input.closeTxDigest) return "SUCCESS";
  if (input.closeMethod === "liquidated" || input.closeMethod === "DB-fallback") return "PARTIAL";
  if (input.onChainSuccess) return "PARTIAL";
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
  const isSyntheticDigest = input.closeTxDigest && FAKE_CLOSE_DIGEST_SET.has(input.closeTxDigest);
  const isSyntheticPrefix = input.closeTxDigest && FAKE_CLOSE_PREFIXES.some(p => input.closeTxDigest!.startsWith(p));
  if ((isSyntheticDigest || isSyntheticPrefix) && input.positionDbId) {
    try {
      const existing = await db.select()
        .from(closeOutcomes)
        .where(
          and(
            eq(closeOutcomes.positionDbId, input.positionDbId),
            eq(closeOutcomes.closeTxDigest, input.closeTxDigest!)
          )
        )
        .limit(1);
      if (existing.length > 0) {
        console.log(`[Learning] DEDUP: Skipping duplicate ${input.closeTxDigest} outcome for position ${input.positionDbId}`);
        return existing[0];
      }
    } catch (dedupErr: any) {
      console.log(`[Learning] Dedup check failed: ${dedupErr.message} — proceeding with insert`);
    }
  }

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
    openTxDigest: input.openTxDigest || null,
    onChainPositionId: input.onChainPositionId || null,
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

      if (stats.winRate < REGIME_BLOCK_WIN_RATE && stats.count >= REGIME_BLOCK_MIN_SAMPLES) {
        regimeSideBlocked = true;
        reasons.push(`${regime}+${side} blocked: winRate ${(stats.winRate * 100).toFixed(0)}% < ${REGIME_BLOCK_WIN_RATE * 100}% with ${stats.count} samples`);
      }
    }
  }

  if (consecutiveLosses >= 2) {
    if (consecutiveLosses >= CONSECUTIVE_LOSS_BLOCK_THRESHOLD) {
      regimeSideBlocked = true;
      reasons.push(`${consecutiveLosses} consecutive losses — circuit breaker BLOCKED`);
    } else {
      const lossPenalty = consecutiveLosses === 2 ? 15 : 25;
      scorePenalty += lossPenalty;
      reasons.push(`${consecutiveLosses} consecutive losses — penalty +${lossPenalty}`);
    }
  }

  // Direction-specific consecutive loss block: if last N trades in this direction all lost
  if (agentId && consecutiveLosses < CONSECUTIVE_LOSS_BLOCK_THRESHOLD) {
    try {
      const rawSideOutcomes = await db.select().from(closeOutcomes)
        .where(and(eq(closeOutcomes.agentId, agentId), eq(closeOutcomes.side, side.toLowerCase())))
        .orderBy(desc(closeOutcomes.createdAt))
        .limit(30);

      const sideOutcomes = filterAndDeduplicateOutcomes(rawSideOutcomes)
        .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));

      let sameSideLosses = 0;
      for (const o of sideOutcomes) {
        if ((o.pnlSui || 0) <= 0) sameSideLosses++;
        else break;
      }

      if (sameSideLosses >= DIRECTION_LOSS_BLOCK_THRESHOLD) {
        regimeSideBlocked = true;
        reasons.push(`${sameSideLosses} consecutive ${side} losses — direction blocked`);
      } else if (sameSideLosses >= 2) {
        const dirPenalty = sameSideLosses === 2 ? 12 : 20;
        scorePenalty += dirPenalty;
        reasons.push(`${sameSideLosses} consecutive ${side} losses — direction penalty +${dirPenalty}`);
      }
    } catch {
      // Non-fatal — direction tracking is best-effort
    }
  }

  return {
    scorePenalty: Math.min(scorePenalty, MAX_SCORE_PENALTY),
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
  const rawRecent = await db.select().from(closeOutcomes)
    .where(eq(closeOutcomes.agentId, agentId))
    .orderBy(desc(closeOutcomes.createdAt))
    .limit(lookback * 5);

  const recent = filterAndDeduplicateOutcomes(rawRecent)
    .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0))
    .slice(0, lookback);

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

const agentCompetitiveScoreCache = new Map<string, { score: number; rank: number; total: number; updatedAt: number }>();
const COMPETITIVE_CACHE_TTL = 120_000;

export async function getAgentCompetitiveScore(agentId: string): Promise<{ score: number; rank: number; total: number; scorePenalty: number }> {
  const cached = agentCompetitiveScoreCache.get(agentId);
  if (cached && Date.now() - cached.updatedAt < COMPETITIVE_CACHE_TTL) {
    const penalty = cached.rank <= Math.ceil(cached.total * 0.33) ? -2 : cached.rank > Math.ceil(cached.total * 0.66) ? 3 : 0;
    return { score: cached.score, rank: cached.rank, total: cached.total, scorePenalty: penalty };
  }

  try {
    const rawOutcomes = await db.select().from(closeOutcomes).orderBy(desc(closeOutcomes.createdAt)).limit(2000);
    const allOutcomes = filterAndDeduplicateOutcomes(rawOutcomes);
    const agentMap = new Map<string, { wins: number; trades: number; totalPnl: number; gasEfficiency: number }>();

    for (const o of allOutcomes) {
      const entry = agentMap.get(o.agentId) || { wins: 0, trades: 0, totalPnl: 0, gasEfficiency: 0 };
      entry.trades++;
      if (o.label === "SUCCESS") {
        entry.wins++;
        entry.gasEfficiency += 1;
      } else if (o.label === "FAIL") {
        entry.gasEfficiency -= 0.5;
      }
      entry.totalPnl += o.pnlSui || 0;
      agentMap.set(o.agentId, entry);
    }

    const scored = Array.from(agentMap.entries()).map(([id, stats]) => {
      const winRate = stats.trades > 0 ? stats.wins / stats.trades : 0;
      const compositeScore = (winRate * 40) + (Math.min(stats.totalPnl, 10) * 3) + (stats.gasEfficiency * 2);
      return { id, compositeScore };
    }).sort((a, b) => b.compositeScore - a.compositeScore);

    const total = scored.length;
    for (let i = 0; i < scored.length; i++) {
      agentCompetitiveScoreCache.set(scored[i].id, {
        score: scored[i].compositeScore,
        rank: i + 1,
        total,
        updatedAt: Date.now(),
      });
    }

    const myEntry = agentCompetitiveScoreCache.get(agentId);
    if (!myEntry) {
      return { score: 0, rank: total + 1, total, scorePenalty: 0 };
    }
    const penalty = myEntry.rank <= Math.ceil(total * 0.33) ? -2 : myEntry.rank > Math.ceil(total * 0.66) ? 3 : 0;
    return { score: myEntry.score, rank: myEntry.rank, total, scorePenalty: penalty };
  } catch {
    return { score: 0, rank: 0, total: 0, scorePenalty: 0 };
  }
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

export async function getCloseStats(agentId?: string, activeAgentIds?: string[]): Promise<{
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

  if (!agentId && activeAgentIds !== undefined) {
    if (activeAgentIds.length === 0) {
      allOutcomes = [];
    } else {
      const activeSet = new Set(activeAgentIds);
      allOutcomes = allOutcomes.filter(o => activeSet.has(o.agentId));
    }
  }

  allOutcomes = filterAndDeduplicateOutcomes(allOutcomes);

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

  let weights = await db.select().from(policyWeights).orderBy(desc(policyWeights.updatedAt));

  if (!agentId && activeAgentIds && activeAgentIds.length > 0) {
    const activeSet = new Set(activeAgentIds);
    weights = weights.filter(w => {
      if (w.actionKey.startsWith("entry:")) return true;
      const agentMatch = w.actionKey.match(/^agent:([^:]+)/);
      if (agentMatch) return activeSet.has(agentMatch[1]);
      return true;
    });
  }

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

export type CloseFailureType = 
  | "too_many_linked_orders"
  | "rate_limited"
  | "close_gas_cap"
  | "close_attempt_cap"
  | "position_not_found"
  | "order_not_found"
  | "dry_run_failed"
  | "close_pending_stale"
  | "close_permanently_blocked"
  | "insufficient_gas"
  | "move_abort"
  | "unknown";

interface CloseFailureRecord {
  agentId: string;
  agentName: string;
  positionId: string;
  onChainPositionId?: string;
  failureType: CloseFailureType;
  errorMessage: string;
  closeReason?: string;
  attemptNumber: number;
  timestamp: number;
}

interface AgentCloseHealth {
  agentId: string;
  agentName: string;
  totalCloseAttempts: number;
  totalCloseSuccesses: number;
  totalCloseFailures: number;
  failureRate: number;
  failuresByType: Record<CloseFailureType, number>;
  recentFailures: CloseFailureRecord[];
  correctiveActions: string[];
  preEmptiveActions: string[];
}

const closeFailureHistory = new Map<string, CloseFailureRecord[]>();
const closeSuccessCount = new Map<string, number>();
const MAX_FAILURE_HISTORY_PER_AGENT = 100;

const perPositionFailures = new Map<string, { types: CloseFailureType[]; lastAttempt: number }>();

function classifyCloseError(errorMessage: string): CloseFailureType {
  const e = errorMessage.toLowerCase();
  if (e.includes("too_many_linked_orders")) return "too_many_linked_orders";
  if (e.includes("rate_limited") || e.includes("rate limited") || e.includes("429")) return "rate_limited";
  if (e.includes("close_gas_cap") || e.includes("gas cap")) return "close_gas_cap";
  if (e.includes("close_attempt_cap") || e.includes("max close attempts")) return "close_attempt_cap";
  if (e.includes("position_not_found")) return "position_not_found";
  if (e.includes("order_not_found")) return "order_not_found";
  if (e.includes("dry_run_failed") || e.includes("dry-run")) return "dry_run_failed";
  if (e.includes("close_pending") || e.includes("pending close")) return "close_pending_stale";
  if (e.includes("close_permanently_blocked") || e.includes("permanently blocked")) return "close_permanently_blocked";
  if (e.includes("insufficient") || e.includes("gasbalancetoolow")) return "insufficient_gas";
  if (e.includes("moveabort") || e.includes("key_not_found") || e.includes("keyed_big_vector")) return "move_abort";
  return "unknown";
}

export function logCloseFailure(params: {
  agentId: string;
  agentName: string;
  positionId: string;
  onChainPositionId?: string;
  errorMessage: string;
  closeReason?: string;
  attemptNumber?: number;
}): void {
  const failureType = classifyCloseError(params.errorMessage);
  const record: CloseFailureRecord = {
    agentId: params.agentId,
    agentName: params.agentName,
    positionId: params.positionId,
    onChainPositionId: params.onChainPositionId,
    failureType,
    errorMessage: params.errorMessage.slice(0, 300),
    closeReason: params.closeReason,
    attemptNumber: params.attemptNumber || 1,
    timestamp: Date.now(),
  };

  const existing = closeFailureHistory.get(params.agentId) || [];
  existing.push(record);
  if (existing.length > MAX_FAILURE_HISTORY_PER_AGENT) {
    existing.splice(0, existing.length - MAX_FAILURE_HISTORY_PER_AGENT);
  }
  closeFailureHistory.set(params.agentId, existing);

  const posKey = `${params.agentId}:${params.positionId}`;
  const posRecord = perPositionFailures.get(posKey) || { types: [], lastAttempt: 0 };
  posRecord.types.push(failureType);
  posRecord.lastAttempt = Date.now();
  perPositionFailures.set(posKey, posRecord);

  console.log(`[Learning] CLOSE FAILURE: ${params.agentName} pos=${params.positionId.slice(0, 8)} type=${failureType} attempt=${record.attemptNumber} reason=${params.closeReason || "?"} error=${params.errorMessage.slice(0, 120)}`);
}

export function logCloseSuccess(agentId: string, positionId: string): void {
  const count = closeSuccessCount.get(agentId) || 0;
  closeSuccessCount.set(agentId, count + 1);
  const posKey = `${agentId}:${positionId}`;
  perPositionFailures.delete(posKey);
}

export function getPositionClosePreEmptiveActions(agentId: string, positionId: string): string[] {
  const actions: string[] = [];
  const posKey = `${agentId}:${positionId}`;
  const posRecord = perPositionFailures.get(posKey);

  if (posRecord) {
    // NOTE: pre_cancel_linked_orders is permanently removed.
    // We always use unlinked reduce-only closes (linked_position_id=null).
    // cancel_linked_orders fills the linked_orders array and causes the exact
    // problem it was trying to fix. Never add it back.
    const dryRunCount = posRecord.types.filter(t => t === "dry_run_failed").length;
    if (dryRunCount >= 2) {
      actions.push("skip_dry_run");
    }
    const rateCount = posRecord.types.filter(t => t === "rate_limited").length;
    if (rateCount >= 2) {
      actions.push("extended_backoff");
    }
  }

  const agentFailures = closeFailureHistory.get(agentId) || [];
  const recentWindow = Date.now() - 5 * 60_000;
  const recentFailures = agentFailures.filter(f => f.timestamp > recentWindow);
  // NOTE: too_many_linked_orders is no longer possible — we always use unlinked closes.
  // pre_cancel_linked_orders has been permanently removed as a corrective action.
  const recentRateLimited = recentFailures.filter(f => f.failureType === "rate_limited").length;
  if (recentRateLimited >= 3) {
    actions.push("stagger_close_delay");
  }

  return actions;
}

export function getCloseFailureDiagnostics(agentId: string): AgentCloseHealth | null {
  const failures = closeFailureHistory.get(agentId);
  if (!failures || failures.length === 0) {
    const successes = closeSuccessCount.get(agentId) || 0;
    if (successes === 0) return null;
    return {
      agentId,
      agentName: "unknown",
      totalCloseAttempts: successes,
      totalCloseSuccesses: successes,
      totalCloseFailures: 0,
      failureRate: 0,
      failuresByType: {} as Record<CloseFailureType, number>,
      recentFailures: [],
      correctiveActions: [],
      preEmptiveActions: [],
    };
  }

  const successes = closeSuccessCount.get(agentId) || 0;
  const totalAttempts = failures.length + successes;
  const failuresByType: Record<string, number> = {};
  for (const f of failures) {
    failuresByType[f.failureType] = (failuresByType[f.failureType] || 0) + 1;
  }

  const correctiveActions: string[] = [];
  const preEmptiveActions: string[] = [];

  if ((failuresByType["too_many_linked_orders"] || 0) >= 2) {
    // NOTE: pre_cancel_linked_orders permanently removed — all closes now use
    // unlinked reduce-only (linked_position_id=null) so too_many_linked_orders
    // is impossible. No corrective action needed for historical records of this failure.
    correctiveActions.push("Resolved: too_many_linked_orders no longer possible — agent uses unlinked reduce-only closes.");
  }
  if ((failuresByType["rate_limited"] || 0) >= 3) {
    correctiveActions.push("Agent is frequently rate-limited during closes. Progressive backoff with jitter is applied.");
    preEmptiveActions.push("extended_backoff");
    preEmptiveActions.push("stagger_close_delay");
  }
  if ((failuresByType["close_gas_cap"] || 0) >= 1) {
    correctiveActions.push("Agent hit gas cap on close attempts. Emergency close with minimal gas budget attempted before pausing.");
  }
  if ((failuresByType["dry_run_failed"] || 0) >= 2) {
    correctiveActions.push("Dry-run preflight failures detected. Subsequent close attempts will skip dry-run for this position.");
    preEmptiveActions.push("skip_dry_run");
  }
  if ((failuresByType["close_pending_stale"] || 0) >= 2) {
    correctiveActions.push("Stale pending close orders detected. Keeper-fill polling is intensified during wait period.");
  }
  if ((failuresByType["insufficient_gas"] || 0) >= 1) {
    correctiveActions.push("Insufficient gas for close operations. Emergency gas reserve being utilized.");
  }

  const recentWindow = Date.now() - 10 * 60_000;
  const recentFailures = failures.filter(f => f.timestamp > recentWindow).slice(-20);

  return {
    agentId,
    agentName: failures[0]?.agentName || "unknown",
    totalCloseAttempts: totalAttempts,
    totalCloseSuccesses: successes,
    totalCloseFailures: failures.length,
    failureRate: totalAttempts > 0 ? failures.length / totalAttempts : 0,
    failuresByType: failuresByType as Record<CloseFailureType, number>,
    recentFailures,
    correctiveActions,
    preEmptiveActions,
  };
}

export function getCloseHealthReport(): {
  agents: AgentCloseHealth[];
  globalFailureRate: number;
  mostCommonErrors: { type: string; count: number }[];
  totalCloseAttempts: number;
  totalFailures: number;
} {
  const allAgentIds = new Set([...closeFailureHistory.keys(), ...closeSuccessCount.keys()]);
  const agents: AgentCloseHealth[] = [];
  let globalAttempts = 0;
  let globalFailures = 0;
  const globalErrorCounts: Record<string, number> = {};

  for (const agentId of allAgentIds) {
    const diag = getCloseFailureDiagnostics(agentId);
    if (diag) {
      agents.push(diag);
      globalAttempts += diag.totalCloseAttempts;
      globalFailures += diag.totalCloseFailures;
      for (const [type, count] of Object.entries(diag.failuresByType)) {
        globalErrorCounts[type] = (globalErrorCounts[type] || 0) + count;
      }
    }
  }

  const mostCommonErrors = Object.entries(globalErrorCounts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  return {
    agents: agents.sort((a, b) => b.failureRate - a.failureRate),
    globalFailureRate: globalAttempts > 0 ? globalFailures / globalAttempts : 0,
    mostCommonErrors,
    totalCloseAttempts: globalAttempts,
    totalFailures: globalFailures,
  };
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

export interface CapitalPlanThought {
  category: "analysis" | "decision" | "risk" | "opportunity" | "constraint" | "adaptation";
  title: string;
  detail: string;
  impact: "positive" | "negative" | "neutral" | "warning";
}

export interface DynamicSlTp {
  slSoftBps: number;
  slHardBps: number;
  tpSoftBps: number;
  tpHardBps: number;
  earlyCloseAggression: number;
  slMode: "tight" | "standard" | "wide";
  tpMode: "aggressive" | "balanced" | "patient";
  description: string;
}

export interface CapitalPlan {
  agentId: string;
  recommendedMaxPositions: number;
  sizeMultiplier: number;
  freeSuiReserveTarget: number;
  hedgeEligible: boolean;
  hedgeReason: string;
  profitReinvestmentRate: number;
  adaptiveScoreBonus: number;
  recentWinRate: number;
  reasoning: string[];
  thoughts: CapitalPlanThought[];
  capitalProfile: "micro" | "small" | "medium" | "large";
  capitalProfileLabel: string;
  positionCapacity: number;
  collateralEfficiency: number;
  growthPhase: "bootstrap" | "building" | "scaling" | "mature";
  growthPhaseLabel: string;
  gasSafety: {
    sessionGasUsed: number;
    effectiveCap: number;
    utilizationPct: number;
    breached: boolean;
    status: "safe" | "warning" | "critical" | "breached";
    reason?: string;
  };
  dynamicSlTp: DynamicSlTp;
}

const capitalPlanCache = new Map<string, { plan: CapitalPlan; updatedAt: number }>();
const CAPITAL_PLAN_CACHE_TTL = 60_000;

function capitalPlanCacheKey(agentId: string, balance: number, positions: number, gasBreached?: boolean): string {
  const balBucket = Math.floor(balance * 10);
  return `${agentId}:${balBucket}:${positions}:${gasBreached ? 1 : 0}`;
}

export async function getCapitalPlan(agentId: string, currentBalance: number = 0, openPositionCount: number = 0, gasCapInfo?: { sessionGasUsed: number; effectiveCap: number; utilizationPct: number; breached: boolean; reason?: string }): Promise<CapitalPlan> {
  const cacheKey = capitalPlanCacheKey(agentId, currentBalance, openPositionCount, gasCapInfo?.breached);
  const cached = capitalPlanCache.get(cacheKey);
  if (cached && Date.now() - cached.updatedAt < CAPITAL_PLAN_CACHE_TTL) {
    return cached.plan;
  }

  const reasoning: string[] = [];
  const thoughts: CapitalPlanThought[] = [];

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  const minColl = agent?.minCollateral ?? 0.4;
  const maxColl = agent?.maxCollateral ?? 10;
  const leverage = agent?.leverage ?? 5;
  const balance = currentBalance || agent?.balance || 0;

  const rawRecent = await db.select().from(closeOutcomes)
    .where(eq(closeOutcomes.agentId, agentId))
    .orderBy(desc(closeOutcomes.createdAt))
    .limit(250);

  const recent = filterAndDeduplicateOutcomes(rawRecent)
    .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0))
    .slice(0, 50);

  const tradeCount = recent.length;
  let wins = 0;
  let totalPnl = 0;
  let totalWinPnl = 0;
  let totalLossPnl = 0;
  let totalLatency = 0;
  let latencyCount = 0;
  let totalSlippage = 0;
  let slippageCount = 0;
  let consecutiveWins = 0;
  let consecutiveLosses = 0;
  let maxDrawdownSui = 0;
  let runningPnl = 0;
  let peakPnl = 0;
  let bestTradePnl = -Infinity;
  let worstTradePnl = Infinity;

  const regimeStats = new Map<string, { wins: number; trades: number; pnl: number }>();

  for (const o of recent) {
    const pnl = o.pnlSui || 0;
    totalPnl += pnl;
    if (pnl > 0) { wins++; totalWinPnl += pnl; }
    else { totalLossPnl += Math.abs(pnl); }
    if (o.latencyMs && o.latencyMs > 0) { totalLatency += o.latencyMs; latencyCount++; }
    if (o.slippageBps !== null && o.slippageBps !== undefined) { totalSlippage += o.slippageBps; slippageCount++; }
    if (pnl > bestTradePnl) bestTradePnl = pnl;
    if (pnl < worstTradePnl) worstTradePnl = pnl;

    const rKey = `${o.regime || "UNKNOWN"}:${o.side || "UNKNOWN"}`;
    const rs = regimeStats.get(rKey) || { wins: 0, trades: 0, pnl: 0 };
    rs.trades++;
    rs.pnl += pnl;
    if (pnl > 0) rs.wins++;
    regimeStats.set(rKey, rs);
  }

  if (tradeCount > 0) {
    const firstPnl = recent[0].pnlSui || 0;
    if (firstPnl > 0) {
      for (const o of recent) {
        if ((o.pnlSui || 0) > 0) consecutiveWins++;
        else break;
      }
    } else {
      for (const o of recent) {
        if ((o.pnlSui || 0) <= 0) consecutiveLosses++;
        else break;
      }
    }
  }

  const chronological = [...recent].reverse();
  maxDrawdownSui = 0;
  runningPnl = 0;
  peakPnl = 0;
  for (const o of chronological) {
    runningPnl += (o.pnlSui || 0);
    if (runningPnl > peakPnl) peakPnl = runningPnl;
    const drawdown = peakPnl - runningPnl;
    if (drawdown > maxDrawdownSui) maxDrawdownSui = drawdown;
  }

  const winRate = tradeCount > 0 ? wins / tradeCount : 0.5;
  const avgPnl = tradeCount > 0 ? totalPnl / tradeCount : 0;

  let capitalProfile: "micro" | "small" | "medium" | "large" = "medium";
  let capitalProfileLabel = "";
  if (maxColl <= 1.0) {
    capitalProfile = "micro";
    capitalProfileLabel = "Micro Trader";
  } else if (maxColl <= 3.0) {
    capitalProfile = "small";
    capitalProfileLabel = "Small Position";
  } else if (maxColl <= 8.0) {
    capitalProfile = "medium";
    capitalProfileLabel = "Standard";
  } else {
    capitalProfile = "large";
    capitalProfileLabel = "Heavy Hitter";
  }

  const MIN_FREE_SUI_FLOOR = 2.5;
  const GAS_PER_CLOSE = 0.25;
  const COLLATERAL_GAS_RESERVE = 2.0;
  const effectiveBalance = balance;
  const freeForPositions = Math.max(0, effectiveBalance - MIN_FREE_SUI_FLOOR - COLLATERAL_GAS_RESERVE);
  const positionCapacity = minColl > 0 ? Math.floor(freeForPositions / (minColl + GAS_PER_CLOSE)) : 1;
  const collateralEfficiency = maxColl > 0 ? minColl / maxColl : 1;

  thoughts.push({
    category: "analysis",
    title: "Capital Profile Assessment",
    detail: `${capitalProfileLabel} profile — collateral range ${minColl.toFixed(1)}–${maxColl.toFixed(1)} SUI at ${leverage}x leverage. Each position controls ${(minColl * leverage).toFixed(0)}–${(maxColl * leverage).toFixed(0)} SUI notional.`,
    impact: "neutral",
  });

  if (balance > 0) {
    thoughts.push({
      category: "analysis",
      title: "Balance Capacity Scan",
      detail: `Current balance ${balance.toFixed(4)} SUI, after reserves (${MIN_FREE_SUI_FLOOR.toFixed(1)} floor + ${COLLATERAL_GAS_RESERVE.toFixed(1)} gas) = ${freeForPositions.toFixed(4)} SUI available. Can theoretically support ${Math.max(1, positionCapacity)} concurrent positions at min collateral.`,
      impact: positionCapacity >= 3 ? "positive" : positionCapacity >= 2 ? "neutral" : "warning",
    });
  }

  let growthPhase: "bootstrap" | "building" | "scaling" | "mature" = "bootstrap";
  let growthPhaseLabel = "Bootstrap";
  if (tradeCount < 3) {
    growthPhase = "bootstrap";
    growthPhaseLabel = "Bootstrap — Learning";
  } else if (tradeCount < 15) {
    growthPhase = "building";
    growthPhaseLabel = "Building — Calibrating";
  } else if (tradeCount < 40 || winRate < 0.45) {
    growthPhase = "scaling";
    growthPhaseLabel = "Scaling — Optimizing";
  } else {
    growthPhase = "mature";
    growthPhaseLabel = "Mature — Full Authority";
  }

  thoughts.push({
    category: "analysis",
    title: "Growth Phase",
    detail: `${growthPhaseLabel} (${tradeCount} trades completed). ${tradeCount < 3 ? "Gathering baseline data before increasing exposure." : tradeCount < 15 ? "Building trade history to refine strategy parameters." : tradeCount < 40 ? "Enough data to optimize — adapting sizing and position limits dynamically." : "Fully calibrated — strategy parameters driven by extensive data."}`,
    impact: growthPhase === "mature" ? "positive" : growthPhase === "scaling" ? "neutral" : "warning",
  });

  let performanceMaxPositions = 2;
  if (tradeCount < 3) {
    performanceMaxPositions = 2;
    reasoning.push("New agent (<3 trades) — 2 slots to gather data quickly");
  } else if (winRate >= 0.50 && avgPnl > 0) {
    performanceMaxPositions = 4;
    reasoning.push(`Strong performance (${(winRate * 100).toFixed(0)}% win rate, +${avgPnl.toFixed(3)} avg PnL) — up to 4 concurrent positions`);
  } else if (winRate >= 0.35) {
    performanceMaxPositions = 3;
    reasoning.push(`Moderate performance (${(winRate * 100).toFixed(0)}% win rate) — up to 3 concurrent positions`);
  } else if (winRate >= 0.20) {
    performanceMaxPositions = 2;
    reasoning.push(`Building win rate (${(winRate * 100).toFixed(0)}%) — 2 concurrent positions to accelerate learning`);
  } else {
    performanceMaxPositions = 2;
    reasoning.push(`Low win rate (${(winRate * 100).toFixed(0)}%) — maintaining 2 positions for continued data gathering`);
  }

  let collateralMaxPositions = 1;
  if (capitalProfile === "micro") {
    collateralMaxPositions = Math.min(5, Math.max(2, positionCapacity));
    thoughts.push({
      category: "opportunity",
      title: "Micro-Position Multi-Slot Strategy",
      detail: `Small collateral (${minColl.toFixed(1)} SUI) enables running up to ${collateralMaxPositions} positions simultaneously. Low per-position risk (${(minColl * leverage).toFixed(0)} SUI notional each) allows diversified exposure including hedged pairs.`,
      impact: "positive",
    });
  } else if (capitalProfile === "small") {
    collateralMaxPositions = Math.min(4, Math.max(2, positionCapacity));
    thoughts.push({
      category: "opportunity",
      title: "Small Position Multi-Entry",
      detail: `Moderate collateral (${minColl.toFixed(1)}–${maxColl.toFixed(1)} SUI) supports ${collateralMaxPositions} concurrent slots. Balanced risk-reward with room for directional + hedge positions.`,
      impact: "positive",
    });
  } else if (capitalProfile === "medium") {
    collateralMaxPositions = Math.min(3, Math.max(1, positionCapacity));
    thoughts.push({
      category: "decision",
      title: "Standard Position Allocation",
      detail: `Standard collateral sizing (${maxColl.toFixed(1)} SUI max) — allocating ${collateralMaxPositions} position slot${collateralMaxPositions > 1 ? "s" : ""}. Each position represents meaningful capital exposure.`,
      impact: "neutral",
    });
  } else {
    collateralMaxPositions = Math.min(2, Math.max(1, positionCapacity));
    thoughts.push({
      category: "risk",
      title: "Heavy Position — Conservative Slots",
      detail: `Large collateral (${maxColl.toFixed(1)} SUI) concentrates risk. Limiting to ${collateralMaxPositions} position${collateralMaxPositions > 1 ? "s" : ""} to protect capital — each trade locks significant equity.`,
      impact: "warning",
    });
  }

  let recommendedMaxPositions = 2;

  reasoning.push("Dual-position mode: up to 2 positions per agent — hedge opposite direction freely, double-down same direction only when existing position is profitable and established (min 5min open).");

  let hedgeEligible = true;
  let hedgeReason = "Hedge always enabled — opposing positions reduce directional risk";
  const trendLong = regimeStats.get("TREND:long");
  const trendShort = regimeStats.get("TREND:short");
  const rangeLong = regimeStats.get("RANGE:long");
  const rangeShort = regimeStats.get("RANGE:short");

  const hasGoodTrend = (trendLong && trendLong.trades >= 3 && trendLong.wins / trendLong.trades > 0.30) ||
                       (trendShort && trendShort.trades >= 3 && trendShort.wins / trendShort.trades > 0.30);
  const hasGoodRange = (rangeLong && rangeLong.trades >= 3 && rangeLong.wins / rangeLong.trades > 0.30) ||
                       (rangeShort && rangeShort.trades >= 3 && rangeShort.wins / rangeShort.trades > 0.30);

  if (hasGoodTrend && hasGoodRange && recommendedMaxPositions >= 2) {
    hedgeReason = "Capable in both TREND and RANGE regimes — optimal hedge positioning";
    reasoning.push("Hedge eligible: profitable in both TREND and RANGE regimes");
    thoughts.push({
      category: "opportunity",
      title: "Dual-Regime Hedge Mode",
      detail: `Proven profitability in both trending and ranging markets. With ${recommendedMaxPositions} slots, can hold long + short simultaneously to capture profits in either direction while limiting drawdown.`,
      impact: "positive",
    });
  } else if (hasGoodTrend || hasGoodRange) {
    hedgeReason = "Active hedge — signal flip triggers opposing position to limit drawdown";
    reasoning.push("Hedge eligible: active in at least one regime, hedging reduces risk");
    if (false) {
      thoughts.push({
        category: "constraint",
        title: "Hedge Not Ready",
        detail: `Only profitable in ${hasGoodTrend ? "trending" : "ranging"} markets. Need consistent wins in both regime types before enabling hedged positions.`,
        impact: "warning",
      });
    }
  }

  const gasPerPosition = 0.15;
  const baseReserve = 1.0;
  const freeSuiReserveTarget = baseReserve + (Math.max(openPositionCount, recommendedMaxPositions) * gasPerPosition) + 0.2;
  reasoning.push(`Free SUI reserve target: ${freeSuiReserveTarget.toFixed(2)} SUI (base ${baseReserve} + ${recommendedMaxPositions} positions × ${gasPerPosition} gas + 0.2 buffer)`);

  // ── Fractional Kelly Criterion sizing ───────────────────────────────────────
  // Formula: Kelly% = W - [(1-W) / R]  where W = win rate, R = avg win / avg loss
  // We use Quarter-Kelly (0.25×) as the practical fraction for crypto perpetuals.
  // This grows capital faster than fixed sizing while controlling drawdown risk.
  const lossTrades = tradeCount - wins;
  const avgWin = wins > 0 ? totalWinPnl / wins : 0;
  const avgLoss = lossTrades > 0 ? totalLossPnl / lossTrades : avgWin * 0.5;

  let kellyFraction = 0;
  if (tradeCount >= 5 && wins > 0 && avgLoss > 0) {
    const W = winRate;
    const R = avgWin / avgLoss;
    const rawKelly = W - (1 - W) / R;
    // Quarter-Kelly for safety: protects against estimation error and fat tails
    kellyFraction = Math.max(0, rawKelly * 0.25);
  }

  let sizeMultiplier = 1.0;
  if (tradeCount < 3) {
    sizeMultiplier = 0.65;
    reasoning.push("New agent — starting with 65% position sizing to gather data");
  } else if (tradeCount >= 5 && kellyFraction > 0) {
    // Map Kelly fraction to a sensible multiplier range [0.55, 1.15]
    // Full Kelly of 25% (quarter) → maps to 1.0x. Lower → scale down. Higher → scale up.
    const kellySizeMult = Math.max(0.55, Math.min(1.15, 0.55 + kellyFraction * 2.4));
    sizeMultiplier = kellySizeMult;
    reasoning.push(
      `Fractional Kelly sizing: W=${(winRate * 100).toFixed(0)}% R=${(avgWin / Math.max(avgLoss, 0.001)).toFixed(2)} → Kelly=${(kellyFraction * 100).toFixed(1)}% → ${(sizeMultiplier * 100).toFixed(0)}% sizing`
    );
    thoughts.push({
      category: "adaptation",
      title: "Kelly Criterion Active",
      detail: `Win rate ${(winRate * 100).toFixed(0)}%, avg win ${avgWin.toFixed(4)} SUI, avg loss ${avgLoss.toFixed(4)} SUI. Quarter-Kelly fraction: ${(kellyFraction * 100).toFixed(1)}%. Position size set to ${(sizeMultiplier * 100).toFixed(0)}% to compound at optimal rate.`,
      impact: kellyFraction > 0.08 ? "positive" : kellyFraction > 0.03 ? "neutral" : "warning",
    });
  } else if (winRate >= 0.50 && avgPnl > 0.1) {
    sizeMultiplier = 1.0;
    reasoning.push("Strong win rate — full position sizing");
  } else if (winRate >= 0.35) {
    sizeMultiplier = 0.85;
    reasoning.push("Moderate win rate — 85% position sizing");
  } else if (winRate >= 0.20) {
    sizeMultiplier = 0.70;
    reasoning.push("Building win rate — 70% position sizing while learning");
  } else {
    sizeMultiplier = 0.60;
    reasoning.push("Low win rate — 60% position sizing (floor) to preserve capital while trading");
  }

  // ── Compound Sizing Bonus ────────────────────────────────────────────────────
  // When balance has grown meaningfully above the starting deposit, increase sizing
  // proportionally (capped at +20%) to compound the gains rather than keeping the
  // same absolute collateral as the wallet grows.
  const depositedBase = (agent?.totalDeposited ?? 0) - (agent?.protocolFeePaid ?? 0);
  if (depositedBase > 1 && balance > depositedBase * 1.15 && winRate >= 0.40) {
    const growthRatio = Math.min(balance / depositedBase, 2.0);
    const compoundBonus = Math.min(0.20, (growthRatio - 1.0) * 0.25);
    const boostedMult = Math.min(1.20, sizeMultiplier + compoundBonus);
    if (boostedMult > sizeMultiplier + 0.005) {
      thoughts.push({
        category: "opportunity",
        title: "Compound Growth Bonus",
        detail: `Balance ${balance.toFixed(2)} SUI is ${(growthRatio * 100 - 100).toFixed(0)}% above starting capital. Applying +${(compoundBonus * 100).toFixed(0)}% compound bonus: sizing ${(sizeMultiplier * 100).toFixed(0)}% → ${(boostedMult * 100).toFixed(0)}%.`,
        impact: "positive",
      });
      sizeMultiplier = boostedMult;
    }
  }

  if (capitalProfile === "micro" && sizeMultiplier < 1.0 && tradeCount >= 5) {
    const boosted = Math.min(1.0, sizeMultiplier + 0.25);
    thoughts.push({
      category: "adaptation",
      title: "Micro Sizing Boost",
      detail: `Micro agent sizing boosted from ${(sizeMultiplier * 100).toFixed(0)}% → ${(boosted * 100).toFixed(0)}%. Small collateral means absolute risk per position remains low even at higher sizing.`,
      impact: "neutral",
    });
    sizeMultiplier = boosted;
  }

  if (maxDrawdownSui > 0 && tradeCount >= 5) {
    const drawdownRatio = maxDrawdownSui / Math.max(balance, 1);
    if (drawdownRatio > 0.3) {
      const reducedSize = Math.max(0.25, sizeMultiplier * 0.75);
      thoughts.push({
        category: "risk",
        title: "Drawdown Protection",
        detail: `Max drawdown of ${maxDrawdownSui.toFixed(4)} SUI (${(drawdownRatio * 100).toFixed(0)}% of balance) detected. Reducing sizing from ${(sizeMultiplier * 100).toFixed(0)}% → ${(reducedSize * 100).toFixed(0)}% until equity recovers.`,
        impact: "negative",
      });
      sizeMultiplier = reducedSize;
    } else if (drawdownRatio < 0.1 && tradeCount >= 10) {
      thoughts.push({
        category: "opportunity",
        title: "Low Drawdown Advantage",
        detail: `Maximum drawdown only ${(drawdownRatio * 100).toFixed(1)}% of balance — strong risk management. Current sizing levels are well-supported.`,
        impact: "positive",
      });
    }
  }

  let profitReinvestmentRate = 0.10;
  if (winRate > 0.50 && avgPnl > 0) {
    profitReinvestmentRate = 0.30;
    reasoning.push("High performer — 30% profit reinvestment (growing capital)");
  } else if (winRate > 0.40 && avgPnl > 0) {
    profitReinvestmentRate = 0.20;
    reasoning.push("Good performer — 20% profit reinvestment");
  } else {
    profitReinvestmentRate = 0.10;
    reasoning.push("Conservative — 10% profit reinvestment (preserving capital)");
  }

  let adaptiveScoreBonus = 0;
  const recentTen = recent.slice(0, 10);
  let planRecentWinRate = 0.5;
  if (recentTen.length >= 5) {
    const recentWins = recentTen.filter(o => (o.pnlSui || 0) > 0).length;
    const recentWinRate = recentWins / recentTen.length;
    planRecentWinRate = recentWinRate;
    if (recentWinRate < 0.20) {
      adaptiveScoreBonus = 5;
      reasoning.push(`Poor recent performance (${(recentWinRate * 100).toFixed(0)}% last ${recentTen.length}) — raising signal threshold by +${adaptiveScoreBonus}`);
      thoughts.push({
        category: "risk",
        title: "Signal Gate Tightened",
        detail: `Only ${recentWins}/${recentTen.length} recent trades profitable. Requiring stronger signals (+${adaptiveScoreBonus} threshold) to filter out low-quality entries until performance rebounds.`,
        impact: "negative",
      });
    } else if (recentWinRate < 0.30) {
      adaptiveScoreBonus = 3;
      reasoning.push(`Below-average recent performance — raising signal threshold by +${adaptiveScoreBonus}`);
      thoughts.push({
        category: "risk",
        title: "Moderate Signal Filter",
        detail: `Recent win rate ${(recentWinRate * 100).toFixed(0)}% is below target. Applying moderate signal threshold increase (+${adaptiveScoreBonus}) for entry quality.`,
        impact: "warning",
      });
    } else if (recentWinRate > 0.60) {
      adaptiveScoreBonus = -3;
      reasoning.push(`Strong recent performance — lowering signal threshold by 3`);
      thoughts.push({
        category: "opportunity",
        title: "Hot Streak — Signal Gate Relaxed",
        detail: `${recentWins}/${recentTen.length} recent trades profitable (${(recentWinRate * 100).toFixed(0)}%). Lowering entry barrier to capture more opportunities during this strong phase.`,
        impact: "positive",
      });
    }

    if (consecutiveLosses >= 3 && tradeCount >= 5) {
      thoughts.push({
        category: "risk",
        title: "Consecutive Loss Streak",
        detail: `${consecutiveLosses} consecutive losses detected. Position sizing already reduced via loss reduction factor. Capital plan monitoring for recovery signals.`,
        impact: "negative",
      });
    } else if (consecutiveWins >= 3 && consecutiveLosses === 0) {
      thoughts.push({
        category: "opportunity",
        title: "Winning Momentum",
        detail: `${consecutiveWins}+ consecutive wins — strategy is well-aligned with current market conditions. Maintaining or expanding position exposure.`,
        impact: "positive",
      });
    }
  }

  for (const [rKey, rs] of regimeStats) {
    if (rs.trades >= 3) {
      const rWinRate = rs.wins / rs.trades;
      const [regime, side] = rKey.split(":");
      const regimeLabel = regime === "UNKNOWN" ? "Mixed" : regime;
      if (rWinRate < 0.25) {
        thoughts.push({
          category: "constraint",
          title: `Regime Block: ${regimeLabel} ${side}`,
          detail: `Only ${(rWinRate * 100).toFixed(0)}% win rate in ${regimeLabel.toLowerCase()} ${side} trades (${rs.trades} samples). These entries are blocked until performance improves.`,
          impact: "negative",
        });
      } else if (rWinRate >= 0.60) {
        thoughts.push({
          category: "opportunity",
          title: `Strong Regime: ${regimeLabel} ${side}`,
          detail: `${(rWinRate * 100).toFixed(0)}% win rate in ${regimeLabel.toLowerCase()} ${side} trades — this is the agent's strongest edge. Prioritizing these setups.`,
          impact: "positive",
        });
      }
    }
  }

  const gasUtilization = gasCapInfo?.utilizationPct || 0;
  let gasStatus: "safe" | "warning" | "critical" | "breached" = "safe";
  if (gasCapInfo?.breached) {
    gasStatus = "breached";
    reasoning.push(`GAS CAP BREACHED: ${gasCapInfo.reason || "Gas spending exceeded safety limits"}. Agent paused.`);
    thoughts.push({
      category: "constraint",
      title: "Gas Cap Breached — Paused",
      detail: `${gasCapInfo.reason || "Gas spending exceeded safety limits"}. Agent is paused until topped up and resumed.`,
      impact: "negative",
    });
  } else if (gasUtilization >= 75) {
    gasStatus = "critical";
    reasoning.push(`Gas usage critical (${gasUtilization.toFixed(0)}% of cap) — reducing position sizing to conserve gas`);
    sizeMultiplier = Math.min(sizeMultiplier, 0.5);
    recommendedMaxPositions = Math.min(recommendedMaxPositions, 1);
    thoughts.push({
      category: "constraint",
      title: "Gas Critical — Emergency Reduction",
      detail: `Gas usage at ${gasUtilization.toFixed(0)}% of session cap. Overriding to 1 position max and 50% sizing to preserve remaining gas for closes.`,
      impact: "negative",
    });
  } else if (gasUtilization >= 50) {
    gasStatus = "warning";
    reasoning.push(`Gas usage elevated (${gasUtilization.toFixed(0)}% of cap) — monitoring closely`);
    sizeMultiplier = Math.min(sizeMultiplier, 0.75);
    thoughts.push({
      category: "risk",
      title: "Gas Budget Elevated",
      detail: `Gas usage at ${gasUtilization.toFixed(0)}% of cap. Capping sizing at 75% as a precaution. Consider gas top-off to unlock full strategy.`,
      impact: "warning",
    });
  }

  // ── Dynamic SL/TP Personality ─────────────────────────────────────────────
  // Personalized per agent based on historical performance.
  // Ranges: SL 25–50bps | TP 50–100bps.
  // Each agent operates within this range — closing early when market conditions
  // confirm the action, rather than waiting for strict hard limits.

  let slSoftBps = 32;
  let slHardBps = 50;
  let tpSoftBps = 62;
  let tpHardBps = 90;
  let earlyCloseAggression = 0.55;
  let slMode: DynamicSlTp["slMode"] = "standard";
  let tpMode: DynamicSlTp["tpMode"] = "balanced";

  if (tradeCount < 3) {
    // New agent — conservative/defensive defaults, close early to learn fast
    slSoftBps = 28; slHardBps = 45;
    tpSoftBps = 55; tpHardBps = 80;
    earlyCloseAggression = 0.70;
    slMode = "tight"; tpMode = "aggressive";
  } else if (winRate >= 0.55 && avgPnl > 0.05) {
    // Strong performer — patient TP, standard SL (let winners run)
    slSoftBps = 35; slHardBps = 50;
    tpSoftBps = 72; tpHardBps = 100;
    earlyCloseAggression = 0.40;
    slMode = "standard"; tpMode = "patient";
  } else if (winRate >= 0.42 && avgPnl > 0) {
    // Good performer — balanced
    slSoftBps = 32; slHardBps = 50;
    tpSoftBps = 63; tpHardBps = 92;
    earlyCloseAggression = 0.55;
    slMode = "standard"; tpMode = "balanced";
  } else if (winRate >= 0.28) {
    // Below average — take profits earlier, cut losses sooner
    slSoftBps = 28; slHardBps = 45;
    tpSoftBps = 55; tpHardBps = 80;
    earlyCloseAggression = 0.70;
    slMode = "tight"; tpMode = "aggressive";
  } else {
    // Poor performer — maximum protection, always close early
    slSoftBps = 25; slHardBps = 40;
    tpSoftBps = 50; tpHardBps = 75;
    earlyCloseAggression = 0.85;
    slMode = "tight"; tpMode = "aggressive";
  }

  // Consecutive-streak adjustments
  if (consecutiveLosses >= 3) {
    slSoftBps = Math.max(25, slSoftBps - 5);
    slHardBps = Math.max(35, slHardBps - 5);
    earlyCloseAggression = Math.min(1.0, earlyCloseAggression + 0.15);
    slMode = "tight";
    reasoning.push(`Loss streak (${consecutiveLosses}): SL tightened to ${slSoftBps}–${slHardBps}bps, early-close aggression raised`);
  } else if (consecutiveWins >= 3) {
    tpSoftBps = Math.min(80, tpSoftBps + 7);
    tpHardBps = Math.min(100, tpHardBps + 5);
    earlyCloseAggression = Math.max(0.30, earlyCloseAggression - 0.10);
    tpMode = "patient";
    reasoning.push(`Win streak (${consecutiveWins}): TP extended to ${tpSoftBps}–${tpHardBps}bps, letting winners run`);
  }

  // Gas pressure tightens both sides (close sooner = less gas risk)
  if (gasStatus === "critical" || gasStatus === "breached") {
    slSoftBps = Math.max(25, slSoftBps - 3);
    tpSoftBps = Math.max(50, tpSoftBps - 8);
    earlyCloseAggression = Math.min(1.0, earlyCloseAggression + 0.20);
    reasoning.push(`Gas pressure: SL/TP tightened (close sooner to conserve gas)`);
  }

  const slTpModeLabel = `${slMode === "tight" ? "Tight SL" : slMode === "wide" ? "Wide SL" : "Standard SL"} / ${tpMode === "aggressive" ? "Aggressive TP" : tpMode === "patient" ? "Patient TP" : "Balanced TP"}`;
  const dynamicSlTp: DynamicSlTp = {
    slSoftBps,
    slHardBps,
    tpSoftBps,
    tpHardBps,
    earlyCloseAggression,
    slMode,
    tpMode,
    description: slTpModeLabel,
  };

  thoughts.push({
    category: "decision",
    title: `Exit Strategy: ${slTpModeLabel}`,
    detail: `SL range ${slSoftBps}–${slHardBps}bps (early-cut at ${slSoftBps}bps, hard-stop at ${slHardBps}bps). TP range ${tpSoftBps}–${tpHardBps}bps (soft-target at ${tpSoftBps}bps, hard-exit at ${tpHardBps}bps). Early-close aggression ${(earlyCloseAggression * 100).toFixed(0)}% — agent closes before strict limits when momentum or signals confirm the move.`,
    impact: slMode === "tight" || tpMode === "aggressive" ? "warning" : "positive",
  });

  thoughts.push({
    category: "decision",
    title: "Final Capital Allocation",
    detail: `Positions: ${recommendedMaxPositions} max | Sizing: ${(sizeMultiplier * 100).toFixed(0)}% | Reserve: ${freeSuiReserveTarget.toFixed(2)} SUI | Reinvest: ${(profitReinvestmentRate * 100).toFixed(0)}% | Hedge: ${hedgeEligible ? "Yes" : "No"} | Phase: ${growthPhaseLabel}`,
    impact: "neutral",
  });

  const plan: CapitalPlan = {
    agentId,
    recommendedMaxPositions,
    sizeMultiplier,
    freeSuiReserveTarget,
    hedgeEligible,
    hedgeReason,
    profitReinvestmentRate,
    adaptiveScoreBonus,
    recentWinRate: planRecentWinRate,
    reasoning,
    thoughts,
    capitalProfile,
    capitalProfileLabel,
    positionCapacity: Math.max(1, positionCapacity),
    collateralEfficiency,
    growthPhase,
    growthPhaseLabel,
    gasSafety: {
      sessionGasUsed: gasCapInfo?.sessionGasUsed || 0,
      effectiveCap: gasCapInfo?.effectiveCap || 3.0,
      utilizationPct: gasUtilization,
      breached: gasCapInfo?.breached || false,
      status: gasStatus,
      reason: gasCapInfo?.reason,
    },
    dynamicSlTp,
  };

  capitalPlanCache.set(cacheKey, { plan, updatedAt: Date.now() });
  return plan;
}

export interface QualityMetrics {
  agentId: string;
  avgLatencyMs: number;
  avgSlippageBps: number;
  fillRate: number;
  gasEfficiency: number;
  tradeCount: number;
  onChainVerifiedRate: number;
  regimeBlocking: Array<{ regime: string; side: string; winRate: number; blocked: boolean; samples: number }>;
  adaptiveScoreAdjustment: number;
  qualityScore: number;
}

export async function getQualityMetrics(agentId: string): Promise<QualityMetrics> {
  const rawOutcomes = await db.select().from(closeOutcomes)
    .where(eq(closeOutcomes.agentId, agentId))
    .orderBy(desc(closeOutcomes.createdAt))
    .limit(500);

  const outcomes = filterAndDeduplicateOutcomes(rawOutcomes)
    .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0))
    .slice(0, 100);

  let totalLatency = 0, latencyCount = 0;
  let totalSlippage = 0, slippageCount = 0;
  let successCount = 0, failCount = 0;
  let onChainVerified = 0;

  const regimeMap = new Map<string, { wins: number; trades: number }>();

  for (const o of outcomes) {
    if (o.latencyMs && o.latencyMs > 0) { totalLatency += o.latencyMs; latencyCount++; }
    if (o.slippageBps !== null && o.slippageBps !== undefined) { totalSlippage += o.slippageBps; slippageCount++; }
    if (o.label === "SUCCESS") successCount++;
    if (o.label === "FAIL") failCount++;
    if (o.closeTxDigest && !o.closeTxDigest.startsWith("sim_")) onChainVerified++;

    const rKey = `${o.regime || "UNKNOWN"}:${o.side || "UNKNOWN"}`;
    const entry = regimeMap.get(rKey) || { wins: 0, trades: 0 };
    entry.trades++;
    if ((o.pnlSui || 0) > 0) entry.wins++;
    regimeMap.set(rKey, entry);
  }

  const avgLatencyMs = latencyCount > 0 ? totalLatency / latencyCount : 0;
  const avgSlippageBps = slippageCount > 0 ? totalSlippage / slippageCount : 0;
  const fillRate = outcomes.length > 0 ? successCount / outcomes.length : 0;
  const gasEfficiency = outcomes.length > 0 ? (successCount - failCount * 0.5) / Math.max(1, outcomes.length) : 0;
  const onChainVerifiedRate = outcomes.length > 0 ? onChainVerified / outcomes.length : 0;

  const regimeBlocking: QualityMetrics["regimeBlocking"] = [];
  for (const [key, stats] of regimeMap.entries()) {
    const [regime, side] = key.split(":");
    const winRate = stats.trades > 0 ? stats.wins / stats.trades : 0;
    const blocked = winRate < REGIME_BLOCK_WIN_RATE && stats.trades >= REGIME_BLOCK_MIN_SAMPLES;
    regimeBlocking.push({ regime, side, winRate, blocked, samples: stats.trades });
  }

  const plan = await getCapitalPlan(agentId);
  const adaptiveScoreAdjustment = plan.adaptiveScoreBonus;

  const latencyScore = avgLatencyMs > 0 ? Math.max(0, 1 - avgLatencyMs / 30000) : 0.5;
  const slippageScore = avgSlippageBps > 0 ? Math.max(0, 1 - avgSlippageBps / 200) : 0.5;
  const qualityScore = Math.round(((fillRate * 30) + (latencyScore * 25) + (slippageScore * 25) + (gasEfficiency * 20)) * 100) / 100;

  return {
    agentId,
    avgLatencyMs: Math.round(avgLatencyMs),
    avgSlippageBps: Math.round(avgSlippageBps * 100) / 100,
    fillRate: Math.round(fillRate * 1000) / 1000,
    gasEfficiency: Math.round(gasEfficiency * 1000) / 1000,
    tradeCount: outcomes.length,
    onChainVerifiedRate: Math.round(onChainVerifiedRate * 1000) / 1000,
    regimeBlocking,
    adaptiveScoreAdjustment,
    qualityScore,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PRECISION ADJUSTMENTS — Auto-tune agent config based on learning data
// ─────────────────────────────────────────────────────────────────────────────

const MIN_TRADES_FOR_PRECISION = 5;
const PRECISION_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between adjustments per agent

const _precisionLastRun = new Map<string, number>();

export async function applyPrecisionAdjustments(agentId: string): Promise<{ adjusted: boolean; changes: { field: string; oldValue: number; newValue: number; reason: string }[] }> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) return { adjusted: false, changes: [] };
  if (!agent.precisionAdjustmentsEnabled) return { adjusted: false, changes: [] };

  // Cooldown check
  const lastRun = _precisionLastRun.get(agentId);
  if (lastRun && Date.now() - lastRun < PRECISION_COOLDOWN_MS) return { adjusted: false, changes: [] };

  // Fetch recent outcomes (last 50 real trades)
  const rawOutcomes = await db.select().from(closeOutcomes)
    .where(eq(closeOutcomes.agentId, agentId))
    .orderBy(desc(closeOutcomes.createdAt))
    .limit(250);
  const outcomes = filterAndDeduplicateOutcomes(rawOutcomes).slice(0, 50);

  if (outcomes.length < MIN_TRADES_FOR_PRECISION) return { adjusted: false, changes: [] };

  // Compute performance stats
  let wins = 0, losses = 0, totalPnl = 0, totalWinPnl = 0, totalLossPnl = 0;
  let consecutiveLosses = 0, consecutiveWins = 0;
  for (const o of outcomes) {
    const pnl = o.pnlSui || 0;
    totalPnl += pnl;
    if (pnl > 0) { wins++; totalWinPnl += pnl; }
    else { losses++; totalLossPnl += Math.abs(pnl); }
  }
  const tradeCount = outcomes.length;
  const winRate = wins / tradeCount;
  const avgPnl = totalPnl / tradeCount;
  const avgWin = wins > 0 ? totalWinPnl / wins : 0;
  const avgLoss = losses > 0 ? totalLossPnl / losses : 0;

  // Consecutive streaks (from most recent)
  for (const o of outcomes) {
    if ((o.pnlSui || 0) <= 0) { consecutiveLosses++; } else break;
  }
  for (const o of outcomes) {
    if ((o.pnlSui || 0) > 0) { consecutiveWins++; } else break;
  }

  const changes: { field: string; oldValue: number; newValue: number; reason: string }[] = [];

  const currentSL = agent.stopLossBps ?? 80;
  const currentTP = agent.takeProfitBps ?? 100;
  const currentMinColl = agent.minCollateral ?? 0.4;
  const currentMaxColl = agent.maxCollateral ?? 10;
  const currentLeverage = agent.leverage ?? 5;

  // ── Stop Loss BPS ──────────────────────────────────────────────────────────
  // Tighten SL when on a losing streak; loosen when performing well
  let newSL = currentSL;
  if (consecutiveLosses >= 4 && currentSL > 30) {
    newSL = Math.max(30, Math.round(currentSL * 0.90)); // tighten 10%
    changes.push({ field: "stopLossBps", oldValue: currentSL, newValue: newSL, reason: `${consecutiveLosses} consecutive losses — tightening stop-loss to reduce drawdown` });
  } else if (winRate >= 0.60 && consecutiveWins >= 3 && currentSL < 100) {
    newSL = Math.min(100, Math.round(currentSL * 1.08)); // widen 8%
    changes.push({ field: "stopLossBps", oldValue: currentSL, newValue: newSL, reason: `${(winRate * 100).toFixed(0)}% win rate with ${consecutiveWins} consecutive wins — widening stop-loss to let profitable trades breathe` });
  } else if (winRate < 0.30 && tradeCount >= 15 && currentSL > 35) {
    newSL = Math.max(35, Math.round(currentSL * 0.88)); // tighten 12%
    changes.push({ field: "stopLossBps", oldValue: currentSL, newValue: newSL, reason: `Sustained low win rate (${(winRate * 100).toFixed(0)}%) — tightening stop-loss for capital protection` });
  }

  // ── Take Profit BPS ────────────────────────────────────────────────────────
  // Raise TP when agent is consistently hitting targets; lower if rarely profits
  let newTP = currentTP;
  if (winRate >= 0.55 && avgWin > avgLoss * 1.2 && currentTP < 180) {
    newTP = Math.min(180, Math.round(currentTP * 1.10)); // raise 10%
    changes.push({ field: "takeProfitBps", oldValue: currentTP, newValue: newTP, reason: `High win rate (${(winRate * 100).toFixed(0)}%) with avg win ${avgWin.toFixed(3)} SUI exceeding avg loss — raising take-profit target` });
  } else if (winRate < 0.35 && avgWin < avgLoss * 0.8 && currentTP > 40) {
    newTP = Math.max(40, Math.round(currentTP * 0.90)); // lower 10%
    changes.push({ field: "takeProfitBps", oldValue: currentTP, newValue: newTP, reason: `Low win rate with small avg win (${avgWin.toFixed(3)} SUI) — lowering take-profit target for faster captures` });
  }

  // ── Min Collateral ─────────────────────────────────────────────────────────
  // Modestly increase min collateral when consistently profitable (more capital per trade)
  let newMinColl = currentMinColl;
  if (winRate >= 0.60 && avgPnl > 0 && currentMinColl < 5 && tradeCount >= 20) {
    newMinColl = Math.round(Math.min(5, currentMinColl * 1.15) * 100) / 100;
    if (Math.abs(newMinColl - currentMinColl) >= 0.02) {
      changes.push({ field: "minCollateral", oldValue: currentMinColl, newValue: newMinColl, reason: `Consistent profitability (${(winRate * 100).toFixed(0)}% win rate) — increasing minimum position size to compound gains` });
    } else {
      newMinColl = currentMinColl; // change too small, skip
    }
  } else if (winRate < 0.35 && consecutiveLosses >= 3 && currentMinColl > 0.3) {
    newMinColl = Math.round(Math.max(0.3, currentMinColl * 0.90) * 100) / 100;
    if (Math.abs(newMinColl - currentMinColl) >= 0.02) {
      changes.push({ field: "minCollateral", oldValue: currentMinColl, newValue: newMinColl, reason: `Underperformance (${consecutiveLosses} consecutive losses) — reducing minimum position size to conserve capital` });
    } else {
      newMinColl = currentMinColl;
    }
  }

  // ── Max Collateral ─────────────────────────────────────────────────────────
  // Scale max collateral when the agent earns it
  let newMaxColl = currentMaxColl;
  if (winRate >= 0.55 && avgPnl > 0 && totalPnl > 0.5 && currentMaxColl < 30 && tradeCount >= 20) {
    newMaxColl = Math.round(Math.min(30, currentMaxColl * 1.10) * 100) / 100;
    if (Math.abs(newMaxColl - currentMaxColl) >= 0.1) {
      changes.push({ field: "maxCollateral", oldValue: currentMaxColl, newValue: newMaxColl, reason: `Positive cumulative PnL (${totalPnl.toFixed(3)} SUI) with strong win rate — expanding max position ceiling` });
    } else {
      newMaxColl = currentMaxColl;
    }
  } else if (winRate < 0.30 && totalPnl < -0.3 && currentMaxColl > 1) {
    newMaxColl = Math.round(Math.max(1, currentMaxColl * 0.88) * 100) / 100;
    if (Math.abs(newMaxColl - currentMaxColl) >= 0.1) {
      changes.push({ field: "maxCollateral", oldValue: currentMaxColl, newValue: newMaxColl, reason: `Negative cumulative PnL (${totalPnl.toFixed(3)} SUI) — reducing max position ceiling to limit downside` });
    } else {
      newMaxColl = currentMaxColl;
    }
  }

  // ── Leverage ───────────────────────────────────────────────────────────────
  // Very conservative lever adjustments — only 1x per session, bounded 2-20x
  let newLeverage = currentLeverage;
  if (winRate >= 0.65 && avgPnl > 0 && tradeCount >= 30 && currentLeverage < 20) {
    newLeverage = Math.min(20, currentLeverage + 1);
    changes.push({ field: "leverage", oldValue: currentLeverage, newValue: newLeverage, reason: `Exceptional win rate (${(winRate * 100).toFixed(0)}%) over ${tradeCount} trades — incrementing leverage by 1x` });
  } else if (consecutiveLosses >= 5 && currentLeverage > 2) {
    newLeverage = Math.max(2, currentLeverage - 1);
    changes.push({ field: "leverage", oldValue: currentLeverage, newValue: newLeverage, reason: `${consecutiveLosses} consecutive losses — reducing leverage by 1x to protect capital` });
  }

  if (changes.length === 0) {
    _precisionLastRun.set(agentId, Date.now());
    return { adjusted: false, changes: [] };
  }

  // Apply all changes atomically
  const updatePayload: Record<string, any> = {};
  for (const c of changes) {
    if (c.field === "stopLossBps") updatePayload.stopLossBps = c.newValue;
    else if (c.field === "takeProfitBps") updatePayload.takeProfitBps = c.newValue;
    else if (c.field === "minCollateral") updatePayload.minCollateral = c.newValue;
    else if (c.field === "maxCollateral") updatePayload.maxCollateral = c.newValue;
    else if (c.field === "leverage") updatePayload.leverage = c.newValue;
  }
  await db.update(agents).set(updatePayload).where(eq(agents.id, agentId));

  // Log each change
  for (const c of changes) {
    await db.insert(precisionAdjustmentLogs).values({
      agentId,
      field: c.field,
      oldValue: c.oldValue,
      newValue: c.newValue,
      reason: c.reason,
      winRate,
      tradeCount,
    });
  }

  _precisionLastRun.set(agentId, Date.now());
  return { adjusted: true, changes };
}

export async function getPrecisionAdjustmentLogs(agentId: string): Promise<PrecisionAdjustmentLog[]> {
  return db.select().from(precisionAdjustmentLogs)
    .where(eq(precisionAdjustmentLogs.agentId, agentId))
    .orderBy(desc(precisionAdjustmentLogs.appliedAt))
    .limit(50);
}
