/**
 * Win Probability Model (WPM v1) — pre-trade success probability estimation.
 *
 * Phase 1: deterministic sigmoid model using weighted feature components.
 * Phase 2: trainable logistic regression calibrated from outcome history.
 *
 * Cold-start handling: agents with <5 trades get a neutral probability (~0.60)
 * with low confidence — the risk agent will apply DEFENSIVE posture until
 * sufficient history exists for confident predictions.
 *
 * Verdict thresholds:
 *   STRONG:  probability >= 0.72 AND confidence >= 0.65
 *   WEAK:    probability >= 0.58 AND confidence >= 0.48
 *   SKIP:    everything else
 */

import { getLatestFeaturesForAgent, type MarketFeatureSnapshot } from "./feature-store";
import { getLatestSentimentSnapshot, getCachedSentimentSnapshot, type SentimentSnapshot } from "./analysis-agent";
import { getRecentAgentPerformanceSnapshot, type ContinuousEvaluationSnapshot } from "./continuous-evaluator";
import { db } from "./db";
import { probabilityPredictions } from "@shared/schema";

export interface WinProbabilityInput {
  agentId: string;
  side: "long" | "short";
  regime: string;
  entryPrice: number;
  stopLossBps: number;
  takeProfitBps: number;
  leverage: number;
}

export interface WinProbabilityResult {
  probability: number;
  confidence: number;
  expectedEdgeBps: number;
  expectedRR: number;
  featureContributions: Array<{ name: string; value: number; impact: number }>;
  verdict: "STRONG" | "WEAK" | "SKIP";
  reason: string;
  modelVersion: string;
  generatedAt: number;
  predictionId?: string;
}

export async function computeWinProbability(
  input: WinProbabilityInput
): Promise<WinProbabilityResult> {
  const [features, sentiment, perf] = await Promise.all([
    getLatestFeaturesForAgent(input.agentId, input.side),
    getCachedSentimentSnapshot() ?? getLatestSentimentSnapshot().catch(() => null),
    getRecentAgentPerformanceSnapshot(input.agentId).catch(() => null),
  ]);

  const coldStart = (perf?.sampleCount ?? 0) < 5;

  const technicalScore = normalizeTechnicalScore(features, input.side);
  const mtfAlignment = normalizeAlignment(features, input.side);
  const regimeFit = normalizeRegimeFit(features, input.regime, input.side);
  const agentPerformance = normalizeAgentPerformance(perf, input.side);
  const sentimentAlignment = normalizeSentimentAlignment(sentiment, input.side);
  const slippageRisk = normalizeSlippageRisk(features);
  const drawdownRisk = normalizeDrawdownRisk(perf);
  const lossStreakPenalty = normalizeLossStreak(features);

  // Weighted sigmoid components
  const z =
    1.35 * technicalScore +
    1.10 * mtfAlignment +
    0.95 * regimeFit +
    1.00 * agentPerformance +
    0.80 * sentimentAlignment -
    1.15 * slippageRisk -
    0.90 * drawdownRisk -
    0.85 * lossStreakPenalty;

  // Cold start: blend model output with neutral prior (0.60)
  const rawProbability = sigmoid(z);
  const probability = coldStart
    ? 0.6 * 0.5 + rawProbability * 0.5  // 50/50 blend with neutral
    : rawProbability;

  const confidence = computeConfidence(features, sentiment, perf, mtfAlignment, coldStart);
  const expectedRR = input.takeProfitBps / Math.max(1, input.stopLossBps);
  const expectedEdgeBps = probability * input.takeProfitBps - (1 - probability) * input.stopLossBps;

  const verdict: "STRONG" | "WEAK" | "SKIP" =
    probability >= 0.72 && confidence >= 0.65 ? "STRONG"
    : probability >= 0.58 && confidence >= 0.48 ? "WEAK"
    : "SKIP";

  const featureContributions = [
    { name: "technicalScore",    value: technicalScore,    impact: 1.35 * technicalScore },
    { name: "mtfAlignment",      value: mtfAlignment,      impact: 1.10 * mtfAlignment },
    { name: "regimeFit",         value: regimeFit,         impact: 0.95 * regimeFit },
    { name: "agentPerformance",  value: agentPerformance,  impact: 1.00 * agentPerformance },
    { name: "sentimentAlignment",value: sentimentAlignment, impact: 0.80 * sentimentAlignment },
    { name: "slippageRisk",      value: slippageRisk,      impact: -1.15 * slippageRisk },
    { name: "drawdownRisk",      value: drawdownRisk,      impact: -0.90 * drawdownRisk },
    { name: "lossStreakPenalty", value: lossStreakPenalty,  impact: -0.85 * lossStreakPenalty },
  ];

  const reason = buildReason(probability, confidence, expectedEdgeBps, sentiment, coldStart, verdict);

  console.log("[WinProb]", {
    agentId: input.agentId.slice(0, 8),
    side: input.side,
    probability: probability.toFixed(3),
    confidence: confidence.toFixed(3),
    expectedEdgeBps: expectedEdgeBps.toFixed(1),
    verdict,
    coldStart,
  });

  const result: WinProbabilityResult = {
    probability,
    confidence,
    expectedEdgeBps,
    expectedRR,
    featureContributions,
    verdict,
    reason,
    modelVersion: "wpm-v1",
    generatedAt: Date.now(),
  };

  // Persist prediction for later calibration
  try {
    const [pred] = await db.insert(probabilityPredictions).values({
      agentId: input.agentId,
      side: input.side,
      regime: input.regime,
      predictedProbability: probability,
      confidence,
      expectedEdgeBps,
      expectedRR,
      verdict,
      modelVersion: "wpm-v1",
      featureJson: Object.fromEntries(featureContributions.map(f => [f.name, f.value])),
    }).returning({ id: probabilityPredictions.id });
    result.predictionId = pred.id;
  } catch (e: any) {
    console.warn("[WinProb] Failed to persist prediction:", e.message);
  }

  return result;
}

export async function resolvePrediction(predictionId: string, outcome: string): Promise<void> {
  try {
    await db.update(probabilityPredictions)
      .set({ resolvedOutcome: outcome, resolvedAt: new Date() })
      .where(
        require("drizzle-orm").eq(probabilityPredictions.id, predictionId)
      );
  } catch {}
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function normalizeTechnicalScore(features: MarketFeatureSnapshot, side: "long" | "short"): number {
  let score = 0;
  let count = 0;

  const rsi = features.rsi;
  if (rsi != null) {
    count++;
    if (side === "long") {
      score += rsi < 30 ? 1 : rsi < 45 ? 0.5 : rsi > 70 ? -0.5 : rsi > 60 ? -0.2 : 0;
    } else {
      score += rsi > 70 ? 1 : rsi > 55 ? 0.5 : rsi < 30 ? -0.5 : rsi < 40 ? -0.2 : 0;
    }
  }

  const macd = features.macdHist;
  if (macd != null) {
    count++;
    score += side === "long" ? clamp(macd * 50, -1, 1) : clamp(-macd * 50, -1, 1);
  }

  const emaSpread = features.emaSpread;
  if (emaSpread != null) {
    count++;
    score += side === "long" ? clamp(emaSpread * 20, -1, 1) : clamp(-emaSpread * 20, -1, 1);
  }

  const volumeRatio = features.volumeRatio;
  if (volumeRatio != null) {
    count++;
    score += volumeRatio > 1.5 ? 0.6 : volumeRatio > 1.2 ? 0.3 : volumeRatio < 0.7 ? -0.3 : 0;
  }

  return count > 0 ? clamp(score / count, -1, 1) : 0;
}

function normalizeAlignment(features: MarketFeatureSnapshot, side: "long" | "short"): number {
  const mtf = features.mtfAlignmentScore;
  // Convert 0-1 to -1 to 1 with side consideration
  const aligned = side === "long" ? mtf : (1 - mtf);
  return clamp(aligned * 2 - 1, -1, 1);
}

function normalizeRegimeFit(features: MarketFeatureSnapshot, regime: string, side: "long" | "short"): number {
  const tradability = features.tradabilityScore / 100;
  let regimeBonus = 0;

  if (regime === "TREND") {
    regimeBonus = features.mtfAlignmentScore > 0.6 ? 0.3 : 0.1;
  } else if (regime === "RANGE" || regime === "CHOP_SCALP") {
    regimeBonus = -0.1;
  } else if (regime === "VOLATILE") {
    regimeBonus = -0.2;
  }

  return clamp(tradability * 1.5 - 0.75 + regimeBonus, -1, 1);
}

function normalizeAgentPerformance(
  perf: ContinuousEvaluationSnapshot | null,
  side: "long" | "short"
): number {
  if (!perf || perf.sampleCount < 3) return 0; // neutral on cold start

  const wrScore = (perf.winRate10 - 0.5) * 2; // -1 to 1
  const pnlScore = clamp(perf.avgPnlPerRisk10 * 2, -1, 1);
  const ddPenalty = clamp(perf.drawdownPct * -4, -1, 0);

  return clamp((wrScore * 0.5 + pnlScore * 0.3 + ddPenalty * 0.2), -1, 1);
}

function normalizeSentimentAlignment(
  sentiment: SentimentSnapshot | null,
  side: "long" | "short"
): number {
  if (!sentiment) return 0;

  const overallBias = side === "long" ? sentiment.overallScore : -sentiment.overallScore;
  const suiBias = side === "long" ? sentiment.suiScore : -sentiment.suiScore;
  const btcBias = side === "long" ? sentiment.btcScore : -sentiment.btcScore;

  return clamp(overallBias * 0.4 + suiBias * 0.4 + btcBias * 0.2, -1, 1);
}

function normalizeSlippageRisk(features: MarketFeatureSnapshot): number {
  const slip = features.slippageEstimateBps;
  if (slip == null) return 0.2; // small default risk
  if (slip < 10) return 0;
  if (slip < 25) return 0.3;
  if (slip < 50) return 0.6;
  return 1;
}

function normalizeDrawdownRisk(perf: ContinuousEvaluationSnapshot | null): number {
  if (!perf) return 0;
  return clamp(perf.drawdownPct * 4, 0, 1);
}

function normalizeLossStreak(features: MarketFeatureSnapshot): number {
  const losses = features.consecutiveLosses;
  if (losses <= 1) return 0;
  if (losses <= 3) return 0.3;
  if (losses <= 6) return 0.6;
  return 0.9;
}

function computeConfidence(
  features: MarketFeatureSnapshot,
  sentiment: SentimentSnapshot | null,
  perf: ContinuousEvaluationSnapshot | null,
  mtfAlignment: number,
  coldStart: boolean
): number {
  let confidence = 0.50;

  // Feature completeness
  let featureCount = 0;
  if (features.rsi != null) featureCount++;
  if (features.macdHist != null) featureCount++;
  if (features.emaSpread != null) featureCount++;
  if (features.volumeRatio != null) featureCount++;
  confidence += Math.min(0.15, featureCount * 0.04);

  // Oracle freshness
  const freshMs = features.oracleFreshnessMs ?? 5000;
  if (freshMs < 2000) confidence += 0.10;
  else if (freshMs > 30000) confidence -= 0.15;

  // MTF agreement (0.5 = mixed, closer to 0 or 1 = more aligned)
  const mtfAgreement = Math.abs(mtfAlignment * 2 - 1);
  confidence += mtfAgreement * 0.08;

  // Historical sample size
  const samples = perf?.sampleCount ?? 0;
  confidence += Math.min(0.12, samples * 0.006);

  // Sentiment available?
  if (sentiment && sentiment.confidence > 0.5) confidence += 0.05;

  // Cold start penalty
  if (coldStart) confidence *= 0.75;

  return Math.max(0.25, Math.min(0.90, confidence));
}

function buildReason(
  probability: number,
  confidence: number,
  expectedEdgeBps: number,
  sentiment: SentimentSnapshot | null,
  coldStart: boolean,
  verdict: string
): string {
  const parts: string[] = [];
  if (coldStart) parts.push("Warm-up mode (limited history)");
  parts.push(`Win probability: ${(probability * 100).toFixed(0)}%`);
  parts.push(`Confidence: ${(confidence * 100).toFixed(0)}%`);
  parts.push(`Expected edge: ${expectedEdgeBps.toFixed(1)}bps`);
  if (sentiment) parts.push(`Market bias: ${sentiment.bias}`);
  parts.push(`Verdict: ${verdict}`);
  return parts.join(" | ");
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
