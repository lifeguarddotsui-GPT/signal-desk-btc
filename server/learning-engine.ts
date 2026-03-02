import { db } from "./db";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  closeOutcomes, policyWeights,
  type CloseOutcome, type InsertCloseOutcome,
  type PolicyWeight,
} from "@shared/schema";

const EWMA_ALPHA = 0.15;
const UCB_C = 1.5;

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
}

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

  if (pnlSui && pnlSui > 0.5) reward += 0.5;
  else if (pnlSui && pnlSui > 0.1) reward += 0.2;

  return reward;
}

export async function logCloseOutcome(input: CloseOutcomeInput): Promise<CloseOutcome> {
  const label = computeLabel(input);
  const slippageBps = computeSlippageBps(input);

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

  const reward = computeReward(label, input.latencyMs, slippageBps, input.pnlSui);
  const regime = input.regime || "UNKNOWN";
  const actionKey = input.closeMethod;

  await updateWeights("SUI-PERP", regime, actionKey, reward, label === "SUCCESS" || label === "PARTIAL");

  console.log(`[Learning] Outcome: ${label} | method=${input.closeMethod} regime=${regime} pnl=${input.pnlSui?.toFixed(3) ?? "?"} reward=${reward.toFixed(2)} agent=${input.agentId.slice(0, 8)}`);

  return outcome;
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

export async function getCloseStats(): Promise<{
  outcomes: { label: string; count: number; avgPnl: number }[];
  byRegime: { regime: string; count: number; winRate: number; avgReward: number }[];
  weights: PolicyWeight[];
  recentOutcomes: CloseOutcome[];
}> {
  const allOutcomes = await db.select().from(closeOutcomes).orderBy(desc(closeOutcomes.createdAt));

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
    if (o.label === "SUCCESS" || o.label === "PARTIAL") entry.wins++;
    entry.totalReward += computeReward(o.label, o.latencyMs, o.slippageBps, o.pnlSui);
    regimeMap.set(r, entry);
  }
  const byRegime = Array.from(regimeMap.entries()).map(([regime, d]) => ({
    regime,
    count: d.count,
    winRate: d.count > 0 ? d.wins / d.count : 0,
    avgReward: d.count > 0 ? d.totalReward / d.count : 0,
  }));

  const weights = await db.select().from(policyWeights).orderBy(desc(policyWeights.updatedAt));

  const recentOutcomes = allOutcomes.slice(0, 20);

  return { outcomes, byRegime, weights, recentOutcomes };
}

export async function getPreferredCloseMethod(regime: string): Promise<string | null> {
  const weights = await db.select().from(policyWeights).where(
    and(
      eq(policyWeights.market, "SUI-PERP"),
      eq(policyWeights.regime, regime),
    )
  );

  if (weights.length === 0) return null;

  const totalTrials = weights.reduce((sum, w) => sum + w.trials, 0);
  let bestScore = -Infinity;
  let bestAction: string | null = null;

  for (const w of weights) {
    if (w.trials === 0) continue;
    const ucbScore = w.avgReward + UCB_C * Math.sqrt(Math.log(totalTrials + 1) / w.trials);
    if (ucbScore > bestScore) {
      bestScore = ucbScore;
      bestAction = w.actionKey;
    }
  }

  return bestAction;
}
