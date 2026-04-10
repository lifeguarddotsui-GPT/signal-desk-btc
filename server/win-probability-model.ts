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
import { probabilityPredictions, closeOutcomes } from "@shared/schema";
import { toProbabilityDisplay, resolveProbabilityBucket, resolveProbabilityTier } from "./probability-buckets";
import { getCalibrationForBucket } from "./probability-calibration-engine";
import { PROBABILITY_MODEL_VERSION } from "./trading-constants";
import { eq, and, desc } from "drizzle-orm";
import { filterAndDeduplicateOutcomes } from "./learning-engine";

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
  // Frozen snapshot fields — written to position at entry
  probabilityDisplay: number;
  probabilityBucket: string;
  tier: string;
  calibrationAdjustmentApplied: boolean;
}

export async function computeWinProbability(
  input: WinProbabilityInput
): Promise<WinProbabilityResult> {
  const [features, sentiment, perf, regimeSideStats] = await Promise.all([
    getLatestFeaturesForAgent(input.agentId, input.side),
    getCachedSentimentSnapshot() ?? getLatestSentimentSnapshot().catch(() => null),
    getRecentAgentPerformanceSnapshot(input.agentId).catch(() => null),
    getRecentRegimeSideStats(input.agentId, input.regime, input.side, 8),
  ]);

  const coldStart = (perf?.sampleCount ?? 0) < 3;

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
  let probability = coldStart
    ? 0.6 * 0.5 + rawProbability * 0.5  // 50/50 blend with neutral
    : rawProbability;

  // ── Regime×Side outcome override — MOST IMPORTANT CALIBRATION SIGNAL ──────
  // Actual trade outcomes in the same (regime, side) combo override the model.
  // If we've been consistently losing these setups, downgrade immediately.
  // Minimum 1 sample needed — no waiting required when we have real outcome data.
  let regimeSideAdjNote = "";
  if (regimeSideStats.sampleCount >= 1) {
    const { consecutiveLosses: rsLosses, winRate: rsWR, sampleCount: rsN } = regimeSideStats;

    // Full override: 4+ consecutive losses → SKIP-level (won't open this direction)
    if (rsLosses >= 4) {
      probability = Math.min(probability, 0.52);
      regimeSideAdjNote = ` | HARD BLOCK: ${rsLosses} consec losses → capped at ${Math.round(probability * 100)}%`;
      console.log(`[WinProb] HARD DOWNGRADE for ${input.agentId.slice(0, 8)}: ${rsLosses} consecutive ${input.side} losses in ${input.regime} — cap to ${Math.round(probability * 100)}%`);
    }
    // Strong downgrade: 3 consecutive losses → push toward WEAK
    else if (rsLosses >= 3) {
      const before = probability;
      probability = probability * 0.72;
      regimeSideAdjNote = ` | -28%: 3 consec losses → ${Math.round(before * 100)}%→${Math.round(probability * 100)}%`;
      console.log(`[WinProb] DOWNGRADE -28% for ${input.agentId.slice(0, 8)}: 3 consecutive ${input.side} losses in ${input.regime}`);
    }
    // Meaningful: 2 consecutive losses → reduce confidence noticeably
    else if (rsLosses >= 2) {
      const before = probability;
      probability = probability * 0.84;
      regimeSideAdjNote = ` | -16%: 2 consec losses → ${Math.round(before * 100)}%→${Math.round(probability * 100)}%`;
      console.log(`[WinProb] DOWNGRADE -16% for ${input.agentId.slice(0, 8)}: 2 consecutive ${input.side} losses in ${input.regime}`);
    }
    // Moderate: win rate <30% in recent history for this setup
    else if (rsN >= 3 && rsWR < 0.30) {
      const before = probability;
      probability = probability * 0.82;
      regimeSideAdjNote = ` | WR downgrade: WR=${Math.round(rsWR * 100)}% (${rsN} trades) → ${Math.round(before * 100)}%→${Math.round(probability * 100)}%`;
      console.log(`[WinProb] WR DOWNGRADE for ${input.agentId.slice(0, 8)}: ${input.side} in ${input.regime} WR=${Math.round(rsWR * 100)}% over ${rsN} trades`);
    }
    // Mild: win rate <40% with enough samples
    else if (rsN >= 4 && rsWR < 0.40) {
      probability = probability * 0.92;
      regimeSideAdjNote = ` | mild downgrade: WR=${Math.round(rsWR * 100)}% (${rsN} trades)`;
    }

    probability = Math.max(0.01, Math.min(0.99, probability));
  }

  // ── Calibration haircut — reduce overconfident buckets ───────────────────
  let calibrationAdjustmentApplied = false;
  const preHaircutDisplay = toProbabilityDisplay(probability);
  const preHaircutBucket = resolveProbabilityBucket(preHaircutDisplay);

  if (!coldStart) {
    const calData = await getCalibrationForBucket(input.agentId, preHaircutBucket.label, 5).catch(() => null);
    if (calData) {
      const { calibrationGap, sampleSize } = calData;
      // Stronger haircuts: when bucket is consistently overstating, apply significant reduction
      if (preHaircutDisplay >= 90 && calibrationGap < -0.10) {
        probability -= 0.10;
        calibrationAdjustmentApplied = true;
        console.log(`[WinProb] Cal haircut -10% for ${input.agentId.slice(0, 8)}: bucket 90-99 overstated (gap=${calibrationGap.toFixed(3)}, n=${sampleSize})`);
      } else if (preHaircutDisplay >= 80 && calibrationGap < -0.15) {
        // Severe overstatement in 80-89 bucket — large haircut
        probability -= 0.12;
        calibrationAdjustmentApplied = true;
        console.log(`[WinProb] Cal haircut -12% for ${input.agentId.slice(0, 8)}: bucket 80-89 severely overstated (gap=${calibrationGap.toFixed(3)}, n=${sampleSize})`);
      } else if (preHaircutDisplay >= 80 && calibrationGap < -0.08) {
        probability -= 0.06;
        calibrationAdjustmentApplied = true;
        console.log(`[WinProb] Cal haircut -6% for ${input.agentId.slice(0, 8)}: bucket 80-89 overstated (gap=${calibrationGap.toFixed(3)}, n=${sampleSize})`);
      } else if (preHaircutDisplay >= 70 && calibrationGap < -0.06) {
        probability -= 0.04;
        calibrationAdjustmentApplied = true;
        console.log(`[WinProb] Cal haircut -4% for ${input.agentId.slice(0, 8)}: bucket 70-79 overstated (gap=${calibrationGap.toFixed(3)}, n=${sampleSize})`);
      } else if (preHaircutDisplay >= 80 && calibrationGap > 0.08) {
        // Slight boost for consistently understated buckets (capped small)
        probability = Math.min(probability + 0.015, 0.99);
      }
      probability = Math.max(0.01, Math.min(0.99, probability));
    }
  }

  const confidence = computeConfidence(features, sentiment, perf, mtfAlignment, coldStart);
  const expectedRR = input.takeProfitBps / Math.max(1, input.stopLossBps);
  const expectedEdgeBps = probability * input.takeProfitBps - (1 - probability) * input.stopLossBps;

  // Verdict: if regime+side outcome override capped probability severely,
  // also downgrade confidence so STRONG can't survive a sustained loss streak
  const adjustedConfidence = regimeSideStats.consecutiveLosses >= 3
    ? Math.min(confidence, 0.60)
    : confidence;

  const verdict: "STRONG" | "WEAK" | "SKIP" =
    probability >= 0.72 && adjustedConfidence >= 0.65 ? "STRONG"
    : probability >= 0.58 && adjustedConfidence >= 0.48 ? "WEAK"
    : "SKIP";

  // Frozen display snapshot fields
  const probabilityDisplay = toProbabilityDisplay(probability);
  const finalBucket = resolveProbabilityBucket(probabilityDisplay);
  const tier = resolveProbabilityTier(probabilityDisplay);

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

  const reason = buildReason(probability, adjustedConfidence, expectedEdgeBps, sentiment, coldStart, verdict, calibrationAdjustmentApplied);

  console.log("[WinProb]", {
    agentId: input.agentId.slice(0, 8),
    side: input.side,
    probability: probability.toFixed(3),
    display: probabilityDisplay,
    bucket: finalBucket.label,
    tier,
    confidence: adjustedConfidence.toFixed(3),
    expectedEdgeBps: expectedEdgeBps.toFixed(1),
    verdict,
    coldStart,
    calAdjusted: calibrationAdjustmentApplied,
    regimeSideLosses: regimeSideStats.consecutiveLosses,
    regimeSideWR: regimeSideStats.sampleCount > 0 ? (regimeSideStats.winRate * 100).toFixed(0) + "%" : "n/a",
    regimeSideAdj: regimeSideAdjNote || "none",
  });

  const result: WinProbabilityResult = {
    probability,
    confidence: adjustedConfidence,
    expectedEdgeBps,
    expectedRR,
    featureContributions,
    verdict,
    reason,
    modelVersion: PROBABILITY_MODEL_VERSION,
    generatedAt: Date.now(),
    probabilityDisplay,
    probabilityBucket: finalBucket.label,
    tier,
    calibrationAdjustmentApplied,
  };

  // Persist prediction for later calibration
  try {
    const [pred] = await db.insert(probabilityPredictions).values({
      agentId: input.agentId,
      side: input.side,
      regime: input.regime,
      predictedProbability: probability,
      confidence: adjustedConfidence,
      expectedEdgeBps,
      expectedRR,
      verdict,
      modelVersion: PROBABILITY_MODEL_VERSION,
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

/**
 * Fetches recent close outcomes for this agent in the same (regime, side) combo.
 * Returns the consecutive loss streak and recent win rate.
 * This is the most important real-time calibration signal — actual outcomes beat
 * any model estimate. If the agent has been losing consistently in this setup, we
 * must reflect that BEFORE entering the next trade.
 */
async function getRecentRegimeSideStats(
  agentId: string,
  regime: string,
  side: string,
  lookback: number = 8
): Promise<{ consecutiveLosses: number; winRate: number; sampleCount: number }> {
  try {
    // Primary: regime+side specific query (most precise signal)
    const rawRegimeOutcomes = await db
      .select({
        pnlSui: closeOutcomes.pnlSui,
        closeTxDigest: closeOutcomes.closeTxDigest,
        regime: closeOutcomes.regime,
        createdAt: closeOutcomes.createdAt,
      })
      .from(closeOutcomes)
      .where(
        and(
          eq(closeOutcomes.agentId, agentId),
          eq(closeOutcomes.side, side.toLowerCase()),
          eq(closeOutcomes.regime, regime)
        )
      )
      .orderBy(desc(closeOutcomes.createdAt))
      .limit(lookback * 2);

    const regimeOutcomes = filterAndDeduplicateOutcomes(rawRegimeOutcomes as any)
      .sort((a: any, b: any) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0))
      .slice(0, lookback);

    // Fallback: side-only query when regime-specific results are insufficient.
    // This handles: (1) existing closed_outcomes with regime=null (before the fix),
    // (2) new agents with <2 regime-specific trades. Side pattern is still meaningful.
    let outcomes = regimeOutcomes;
    if (outcomes.length < 2) {
      const rawSideOutcomes = await db
        .select({
          pnlSui: closeOutcomes.pnlSui,
          closeTxDigest: closeOutcomes.closeTxDigest,
          regime: closeOutcomes.regime,
          createdAt: closeOutcomes.createdAt,
        })
        .from(closeOutcomes)
        .where(
          and(
            eq(closeOutcomes.agentId, agentId),
            eq(closeOutcomes.side, side.toLowerCase())
          )
        )
        .orderBy(desc(closeOutcomes.createdAt))
        .limit(lookback * 2);

      const sideOutcomes = filterAndDeduplicateOutcomes(rawSideOutcomes as any)
        .sort((a: any, b: any) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0))
        .slice(0, lookback);

      // Prefer regime-specific if we got any; blend with side-only for more data
      outcomes = sideOutcomes.length > outcomes.length ? sideOutcomes : outcomes;
    }

    if (outcomes.length === 0) return { consecutiveLosses: 0, winRate: 0.5, sampleCount: 0 };

    let consecutiveLosses = 0;
    for (const o of outcomes) {
      if (((o as any).pnlSui ?? 0) <= 0) consecutiveLosses++;
      else break;
    }

    const wins = outcomes.filter((o: any) => ((o as any).pnlSui ?? 0) > 0).length;
    const winRate = wins / outcomes.length;

    return { consecutiveLosses, winRate, sampleCount: outcomes.length };
  } catch {
    return { consecutiveLosses: 0, winRate: 0.5, sampleCount: 0 };
  }
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
  verdict: string,
  calibrationAdjusted = false
): string {
  const parts: string[] = [];
  if (coldStart) parts.push("Warm-up mode (limited history)");
  if (calibrationAdjusted) parts.push("Calibration adjustment applied");
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
