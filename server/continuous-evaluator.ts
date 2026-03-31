/**
 * Continuous Evaluator — live rolling health diagnostics for each agent.
 *
 * Runs every 30 seconds. Evaluates:
 *   - Recent win rates (10/25/50 trades)
 *   - PnL per risk, slippage, latency
 *   - Model calibration (predicted prob vs actual outcome)
 *   - Regime fit and side bias
 *   - Execution quality
 *   - Deployment status: GREEN / YELLOW / RED
 *
 * Results feed into the Risk Management Agent for pre-trade decisions.
 */

import { db } from "./db";
import { eq, desc } from "drizzle-orm";
import { closeOutcomes, probabilityPredictions, evaluationSnapshots, agents } from "@shared/schema";

export interface ContinuousEvaluationSnapshot {
  agentId: string;
  timestamp: number;
  winRate10: number;
  winRate25: number;
  winRate50: number;
  avgPnl10: number;
  avgPnlPerRisk10: number;
  avgSlippageBps10: number;
  avgLatencyMs10: number;
  drawdownPct: number;
  modelCalibrationScore: number;
  regimeFitScore: number;
  sideBiasScore: number;
  executionQualityScore: number;
  deploymentStatus: "GREEN" | "YELLOW" | "RED";
  recommendations: string[];
  sampleCount: number;
}

const snapshotCache = new Map<string, { snap: ContinuousEvaluationSnapshot; ts: number }>();
const CACHE_TTL_MS = 30000;

export async function evaluateAgentContinuously(agentId: string): Promise<ContinuousEvaluationSnapshot> {
  const cached = snapshotCache.get(agentId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.snap;
  }

  const [recentTrades, recentPreds] = await Promise.allSettled([
    db.select().from(closeOutcomes)
      .where(eq(closeOutcomes.agentId, agentId))
      .orderBy(desc(closeOutcomes.createdAt))
      .limit(50),
    db.select().from(probabilityPredictions)
      .where(eq(probabilityPredictions.agentId, agentId))
      .orderBy(desc(probabilityPredictions.createdAt))
      .limit(50),
  ]);

  const trades = recentTrades.status === "fulfilled" ? recentTrades.value : [];
  const preds = recentPreds.status === "fulfilled" ? recentPreds.value : [];

  const t10 = trades.slice(0, 10);
  const t25 = trades.slice(0, 25);
  const t50 = trades.slice(0, 50);

  const winRate10 = computeWinRate(t10);
  const winRate25 = computeWinRate(t25);
  const winRate50 = computeWinRate(t50);

  const avgPnl10 = avg(t10.map(t => t.pnlSui ?? 0));
  const avgPnlPerRisk10 = avg(t10.map(t => safePnlPerRisk(t)));
  const avgSlippageBps10 = avg(t10.filter(t => t.slippageBps != null).map(t => t.slippageBps!));
  const avgLatencyMs10 = avg(t10.filter(t => t.latencyMs != null).map(t => t.latencyMs!));

  const drawdownPct = computeRollingDrawdown(trades);
  const modelCalibrationScore = computeCalibration(preds, trades);
  const regimeFitScore = computeRegimeFit(trades);
  const sideBiasScore = computeSideBias(trades);
  const executionQualityScore = computeExecutionQuality(trades);

  const deploymentStatus = deriveDeploymentStatus({
    winRate10,
    drawdownPct,
    executionQualityScore,
    modelCalibrationScore,
    sampleCount: trades.length,
  });

  const recommendations = buildRecommendations({
    winRate10,
    avgSlippageBps10,
    drawdownPct,
    sideBiasScore,
    modelCalibrationScore,
    sampleCount: trades.length,
  });

  const snap: ContinuousEvaluationSnapshot = {
    agentId,
    timestamp: Date.now(),
    winRate10,
    winRate25,
    winRate50,
    avgPnl10,
    avgPnlPerRisk10,
    avgSlippageBps10,
    avgLatencyMs10,
    drawdownPct,
    modelCalibrationScore,
    regimeFitScore,
    sideBiasScore,
    executionQualityScore,
    deploymentStatus,
    recommendations,
    sampleCount: trades.length,
  };

  snapshotCache.set(agentId, { snap, ts: Date.now() });

  await persistEvaluationSnapshot(snap);

  console.log("[ContinuousEval]", {
    agentId: agentId.slice(0, 8),
    winRate10: winRate10.toFixed(2),
    drawdownPct: drawdownPct.toFixed(3),
    executionQualityScore: executionQualityScore.toFixed(0),
    modelCalibrationScore: modelCalibrationScore.toFixed(2),
    deploymentStatus,
  });

  return snap;
}

export async function getRecentAgentPerformanceSnapshot(agentId: string): Promise<ContinuousEvaluationSnapshot> {
  return evaluateAgentContinuously(agentId);
}

export function getCachedEvaluation(agentId: string): ContinuousEvaluationSnapshot | null {
  const cached = snapshotCache.get(agentId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS * 4) {
    return cached.snap;
  }
  return null;
}

export async function evaluateAllAgentsContinuously(): Promise<void> {
  try {
    const allAgents = await db.select({ id: agents.id })
      .from(agents)
      .where(eq(agents.status, "active"));
    for (const agent of allAgents) {
      await evaluateAgentContinuously(agent.id).catch(() => {});
    }
  } catch (e: any) {
    console.warn("[ContinuousEval] evaluateAll error:", e.message);
  }
}

function computeWinRate(trades: any[]): number {
  if (trades.length === 0) return 0.5;
  const wins = trades.filter(t => t.label === "SUCCESS" || (t.pnlSui ?? 0) > 0).length;
  return wins / trades.length;
}

function computeRollingDrawdown(trades: any[]): number {
  if (trades.length < 3) return 0;
  let peak = 0;
  let cumPnl = 0;
  let maxDrawdown = 0;
  for (const t of [...trades].reverse()) {
    cumPnl += t.pnlSui ?? 0;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak > 0 ? (peak - cumPnl) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  return maxDrawdown;
}

function computeCalibration(preds: any[], trades: any[]): number {
  const matched = preds.filter(p => p.resolvedOutcome != null);
  if (matched.length < 3) return 0.5;

  let calibrationError = 0;
  for (const pred of matched) {
    const actual = pred.resolvedOutcome === "SUCCESS" ? 1 : 0;
    const predicted = pred.predictedProbability ?? 0.5;
    calibrationError += Math.abs(predicted - actual);
  }

  const meanError = calibrationError / matched.length;
  return Math.max(0, 1 - meanError * 2);
}

function computeRegimeFit(trades: any[]): number {
  if (trades.length < 5) return 0.5;
  const regimeWins: Record<string, { wins: number; total: number }> = {};
  for (const t of trades) {
    const r = t.regime ?? "UNKNOWN";
    if (!regimeWins[r]) regimeWins[r] = { wins: 0, total: 0 };
    regimeWins[r].total++;
    if (t.label === "SUCCESS") regimeWins[r].wins++;
  }
  const rates = Object.values(regimeWins).map(r => r.wins / r.total);
  return avg(rates);
}

function computeSideBias(trades: any[]): number {
  if (trades.length < 5) return 0;
  const longWins = trades.filter(t => t.side === "long" && t.label === "SUCCESS").length;
  const longTotal = trades.filter(t => t.side === "long").length;
  const shortWins = trades.filter(t => t.side === "short" && t.label === "SUCCESS").length;
  const shortTotal = trades.filter(t => t.side === "short").length;
  const longRate = longTotal > 0 ? longWins / longTotal : 0.5;
  const shortRate = shortTotal > 0 ? shortWins / shortTotal : 0.5;
  return Math.abs(longRate - shortRate);
}

function computeExecutionQuality(trades: any[]): number {
  if (trades.length === 0) return 50;
  let score = 70;
  const recent10 = trades.slice(0, 10);
  const avgSlip = avg(recent10.filter(t => t.slippageBps != null).map(t => t.slippageBps!));
  const avgLat = avg(recent10.filter(t => t.latencyMs != null).map(t => t.latencyMs!));

  if (avgSlip < 15) score += 15;
  else if (avgSlip < 30) score += 5;
  else if (avgSlip > 80) score -= 20;
  else if (avgSlip > 50) score -= 10;

  if (avgLat < 2000) score += 10;
  else if (avgLat > 15000) score -= 15;
  else if (avgLat > 8000) score -= 5;

  return Math.max(0, Math.min(100, score));
}

function deriveDeploymentStatus(params: {
  winRate10: number;
  drawdownPct: number;
  executionQualityScore: number;
  modelCalibrationScore: number;
  sampleCount: number;
}): "GREEN" | "YELLOW" | "RED" {
  if (params.sampleCount < 5) return "GREEN"; // Warm-up: assume healthy

  if (params.drawdownPct > 0.25 || params.winRate10 < 0.20) return "RED";
  if (
    params.drawdownPct > 0.12 ||
    params.winRate10 < 0.35 ||
    params.executionQualityScore < 40 ||
    params.modelCalibrationScore < 0.30
  ) return "YELLOW";
  return "GREEN";
}

function buildRecommendations(params: {
  winRate10: number;
  avgSlippageBps10: number;
  drawdownPct: number;
  sideBiasScore: number;
  modelCalibrationScore: number;
  sampleCount: number;
}): string[] {
  const recs: string[] = [];
  if (params.sampleCount < 5) {
    recs.push("Building history — operating in warm-up mode");
    return recs;
  }

  if (params.winRate10 < 0.35) recs.push("Win rate below 35% — apply tighter signal filters");
  if (params.drawdownPct > 0.12) recs.push("Drawdown elevated — reduce position sizing");
  if (params.avgSlippageBps10 > 50) recs.push("Slippage too high — check liquidity conditions");
  if (params.sideBiasScore > 0.3) recs.push("Significant side bias detected — rebalance direction exposure");
  if (params.modelCalibrationScore < 0.4) recs.push("Model calibration needs improvement — collect more outcome data");
  if (recs.length === 0) recs.push("Performing well — maintain current posture");

  return recs;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function safePnlPerRisk(t: any): number {
  const collateral = t.collateral ?? 0;
  if (collateral <= 0) return 0;
  return (t.pnlSui ?? 0) / collateral;
}

async function persistEvaluationSnapshot(snap: ContinuousEvaluationSnapshot): Promise<void> {
  try {
    await db.insert(evaluationSnapshots).values({
      agentId: snap.agentId,
      winRate10: snap.winRate10,
      winRate25: snap.winRate25,
      winRate50: snap.winRate50,
      avgPnl10: snap.avgPnl10,
      avgPnlPerRisk10: snap.avgPnlPerRisk10,
      avgSlippageBps10: snap.avgSlippageBps10,
      avgLatencyMs10: snap.avgLatencyMs10,
      drawdownPct: snap.drawdownPct,
      modelCalibrationScore: snap.modelCalibrationScore,
      regimeFitScore: snap.regimeFitScore,
      sideBiasScore: snap.sideBiasScore,
      executionQualityScore: snap.executionQualityScore,
      deploymentStatus: snap.deploymentStatus,
      recommendationsJson: snap.recommendations,
    });
  } catch (e: any) {
    console.warn("[ContinuousEval] Persist failed:", e.message);
  }
}
