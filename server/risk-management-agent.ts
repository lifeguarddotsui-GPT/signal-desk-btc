/**
 * Risk Management Agent — pre-trade safety gate.
 *
 * Every trade must pass through this agent before execution.
 * It approves or rejects based on win probability, market conditions,
 * agent health, and portfolio exposure.
 *
 * Non-negotiable: this gate CANNOT be bypassed for live trades.
 *
 * Threshold alignment with capital mode:
 *   - Soft size cuts start at >10% drawdown
 *   - Hard block at >25% drawdown (aligned with new 30% RESTART threshold)
 *   - Cold start (<5 trades): DEFENSIVE posture, approved with small size
 */

import { computeWinProbability, type WinProbabilityInput, type WinProbabilityResult } from "./win-probability-model";
import { getCachedEvaluation, evaluateAgentContinuously, type ContinuousEvaluationSnapshot } from "./continuous-evaluator";
import { getLatestFeaturesForAgent, type MarketFeatureSnapshot } from "./feature-store";
import { getCachedSentimentSnapshot, getLatestSentimentSnapshot, type SentimentSnapshot } from "./analysis-agent";
import { db } from "./db";
import { riskDecisions } from "@shared/schema";

export interface RiskDecisionInput {
  agentId: string;
  side: "long" | "short";
  entryPrice: number;
  stopLossBps: number;
  takeProfitBps: number;
  leverage: number;
  regime: string;
  signalScore?: number;
}

export interface RiskDecisionResult {
  approved: boolean;
  sizeMultiplier: number;        // 0.0 to 1.5
  leverageMultiplier: number;    // 0.5 to 1.2
  stopLossMode: "tight" | "normal" | "wide";
  takeProfitMode: "conservative" | "normal" | "aggressive";
  maxPositionCount: number;
  cooldownMs: number;
  blockReason?: string;
  posture: "DEFENSIVE" | "CAUTIOUS" | "NEUTRAL" | "OFFENSIVE";
  notes: string[];
  probability: number;
  confidence: number;
  predictionId?: string;
}

const blockDecisionCache = new Map<string, { result: RiskDecisionResult; ts: number }>();
const BLOCK_CACHE_TTL_MS = 30000;

export async function getRiskDecision(params: RiskDecisionInput): Promise<RiskDecisionResult> {
  // Check block cache — if recently blocked, return cached block quickly
  const blockKey = `${params.agentId}:${params.side}`;
  const cached = blockDecisionCache.get(blockKey);
  if (cached && cached.result.approved === false && Date.now() - cached.ts < BLOCK_CACHE_TTL_MS) {
    return cached.result;
  }

  const [features, evalSnap, sentiment] = await Promise.all([
    getLatestFeaturesForAgent(params.agentId, params.side),
    (getCachedEvaluation(params.agentId) ?? await evaluateAgentContinuously(params.agentId).catch(() => null)),
    (getCachedSentimentSnapshot() ?? await getLatestSentimentSnapshot().catch(() => null)),
  ]);

  const coldStart = (evalSnap?.sampleCount ?? 0) < 5;

  let wp: WinProbabilityResult | null = null;
  try {
    wp = await computeWinProbability({
      agentId: params.agentId,
      side: params.side,
      regime: params.regime,
      entryPrice: params.entryPrice,
      stopLossBps: params.stopLossBps,
      takeProfitBps: params.takeProfitBps,
      leverage: params.leverage,
    });
  } catch (e: any) {
    console.warn("[RiskAgent] Win probability computation failed:", e.message);
  }

  const probability = wp?.probability ?? 0.60;
  const confidence = wp?.confidence ?? 0.40;
  const predictionId = wp?.predictionId;

  // ── HARD BLOCKS ────────────────────────────────────────────────────────────

  // Probability too low (skip cold-start block — insufficient history)
  if (!coldStart && probability < 0.52) {
    return blocked(`Win probability too low (${(probability * 100).toFixed(0)}%)`, probability, confidence, predictionId);
  }

  // Confidence too low (only block in non-cold-start with very low confidence)
  if (!coldStart && confidence < 0.40) {
    return blocked(`Model confidence too low (${(confidence * 100).toFixed(0)}%)`, probability, confidence, predictionId);
  }

  // Tradability too low
  const tradability = features?.tradabilityScore ?? 50;
  if (tradability < 40) {
    return blocked(`Market tradability too low (${tradability.toFixed(0)}/100)`, probability, confidence, predictionId);
  }

  // Drawdown hard block (25% — aligned with capital mode)
  const drawdown = evalSnap?.drawdownPct ?? 0;
  if (drawdown > 0.25) {
    return blocked(`Agent drawdown too high (${(drawdown * 100).toFixed(1)}%)`, probability, confidence, predictionId);
  }

  // Execution quality degraded (only when well past warm-up)
  if (!coldStart && (evalSnap?.executionQualityScore ?? 70) < 30) {
    return blocked("Execution quality severely degraded", probability, confidence, predictionId);
  }

  // Event risk hard block — only when extreme AND with high confidence
  if (
    sentiment &&
    (sentiment.eventRiskScore ?? 0) > 0.85 &&
    (sentiment.confidence ?? 0) > 0.65
  ) {
    return blocked("Extreme event risk detected in market intelligence", probability, confidence, predictionId);
  }

  // Slippage estimate too high
  const slip = features?.slippageEstimateBps ?? 0;
  if (slip > 100) {
    return blocked(`Estimated slippage too high (${slip.toFixed(0)}bps)`, probability, confidence, predictionId);
  }

  // ── POSTURE DETERMINATION ──────────────────────────────────────────────────

  let sizeMultiplier = 1.0;
  let leverageMultiplier = 1.0;
  let stopLossMode: RiskDecisionResult["stopLossMode"] = "normal";
  let takeProfitMode: RiskDecisionResult["takeProfitMode"] = "normal";
  let posture: RiskDecisionResult["posture"] = "NEUTRAL";
  const notes: string[] = [];

  if (coldStart) {
    posture = "DEFENSIVE";
    sizeMultiplier = 0.75;
    leverageMultiplier = 0.90;
    notes.push("Warm-up mode — reduced sizing until history builds");
  } else if (
    probability >= 0.72 &&
    drawdown < 0.04 &&
    (evalSnap?.executionQualityScore ?? 70) > 70 &&
    confidence >= 0.65
  ) {
    posture = "OFFENSIVE";
    sizeMultiplier = 1.15;
    leverageMultiplier = 1.05;
    takeProfitMode = "aggressive";
    notes.push("High-probability setup — offensive sizing");
  } else if (probability >= 0.62 && probability < 0.70 && drawdown <= 0.08) {
    posture = "CAUTIOUS";
    sizeMultiplier = 0.85;
    leverageMultiplier = 0.92;
    notes.push(`Tier-2 probability (${(probability * 100).toFixed(0)}%) — cautious sizing`);
  } else if (probability < 0.62 || drawdown > 0.08) {
    posture = "DEFENSIVE";
    sizeMultiplier = 0.70;
    leverageMultiplier = 0.85;
    stopLossMode = "tight";
    takeProfitMode = "conservative";
    notes.push(probability < 0.62 ? "Low probability — defensive" : "Elevated drawdown — defensive");
  }

  // Drawdown stress scaling
  if (drawdown > 0.20) {
    sizeMultiplier *= 0.50;
    posture = "DEFENSIVE";
    notes.push(`Heavy drawdown stress (${(drawdown * 100).toFixed(0)}%) — size halved`);
  } else if (drawdown > 0.12) {
    sizeMultiplier *= 0.65;
    notes.push(`Drawdown stress (${(drawdown * 100).toFixed(0)}%) — size cut 35%`);
  } else if (drawdown > 0.06) {
    sizeMultiplier *= 0.80;
    notes.push(`Drawdown caution (${(drawdown * 100).toFixed(0)}%) — size cut 20%`);
  }

  // Regime adjustments
  if (params.regime === "VOLATILE") {
    sizeMultiplier *= 0.80;
    leverageMultiplier *= 0.85;
    stopLossMode = "wide";
    notes.push("Volatile regime — reduced sizing");
  } else if (params.regime === "CHOP_SCALP") {
    sizeMultiplier *= 0.65;
    leverageMultiplier *= 0.80;
    stopLossMode = "tight";
    takeProfitMode = "conservative";
    notes.push("Chop regime — tight scalp parameters");
  } else if (params.regime === "RANGE") {
    leverageMultiplier *= 0.90;
    notes.push("Range regime — slight leverage reduction");
  }

  // Sentiment conflict — if strong sentiment contradicts side, apply reduction
  if (sentiment) {
    const sentimentConflict =
      (params.side === "long" && sentiment.bias === "BEARISH" && sentiment.overallScore < -0.4) ||
      (params.side === "short" && sentiment.bias === "BULLISH" && sentiment.overallScore > 0.4);
    if (sentimentConflict && (sentiment.confidence ?? 0) > 0.60) {
      sizeMultiplier *= 0.80;
      notes.push("Sentiment conflicts with trade direction — size reduced");
    }
  }

  sizeMultiplier = Math.max(0.20, Math.min(1.5, sizeMultiplier));
  leverageMultiplier = Math.max(0.50, Math.min(1.2, leverageMultiplier));

  const result: RiskDecisionResult = {
    approved: true,
    sizeMultiplier,
    leverageMultiplier,
    stopLossMode,
    takeProfitMode,
    maxPositionCount: posture === "OFFENSIVE" ? 2 : 1,
    cooldownMs: posture === "DEFENSIVE" ? 90000 : posture === "CAUTIOUS" ? 60000 : 30000,
    posture,
    notes,
    probability,
    confidence,
    predictionId,
  };

  await persistRiskDecision(params.agentId, params.side, result);

  console.log("[RiskAgent]", {
    agentId: params.agentId.slice(0, 8),
    approved: result.approved,
    posture: result.posture,
    sizeMultiplier: result.sizeMultiplier.toFixed(2),
    leverageMultiplier: result.leverageMultiplier.toFixed(2),
    probability: probability.toFixed(3),
    regime: params.regime,
    coldStart,
  });

  return result;
}

function blocked(
  reason: string,
  probability: number,
  confidence: number,
  predictionId?: string
): RiskDecisionResult {
  const result: RiskDecisionResult = {
    approved: false,
    sizeMultiplier: 0,
    leverageMultiplier: 0,
    stopLossMode: "normal",
    takeProfitMode: "normal",
    maxPositionCount: 0,
    cooldownMs: 60000,
    blockReason: reason,
    posture: "DEFENSIVE",
    notes: [reason],
    probability,
    confidence,
    predictionId,
  };

  persistRiskDecision("_blocked_", undefined, result).catch(() => {});
  console.log("[RiskAgent] BLOCKED:", reason, { probability: probability.toFixed(3) });
  return result;
}

async function persistRiskDecision(
  agentId: string,
  side: string | undefined,
  result: RiskDecisionResult
): Promise<void> {
  try {
    await db.insert(riskDecisions).values({
      agentId,
      side: side ?? null,
      approved: result.approved,
      sizeMultiplier: result.sizeMultiplier,
      leverageMultiplier: result.leverageMultiplier,
      stopLossMode: result.stopLossMode,
      takeProfitMode: result.takeProfitMode,
      posture: result.posture,
      notesJson: result.notes,
      blockReason: result.blockReason ?? null,
      probability: result.probability,
      confidence: result.confidence,
    });
  } catch (e: any) {
    console.warn("[RiskAgent] Failed to persist decision:", e.message);
  }
}
