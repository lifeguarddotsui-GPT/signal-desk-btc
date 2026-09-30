import type { WaterxInterval } from "./types";

type CoverageCount = {
  numerator: number;
  denominator: number;
  percent: number | null;
};

function safeCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Expected market starts are estimated prospectively from the first persisted
 * WaterX round through the most recent scheduled start as of the query time. */
export function marketCaptureCoverage(
  intervalMinutes: WaterxInterval,
  observedRoundStarts: number,
  firstObservedRoundStartMs: number | null,
  asOfMs: number,
) {
  const cadenceMs = intervalMinutes * 60_000;
  const numerator = safeCount(observedRoundStarts);
  const validWindow = firstObservedRoundStartMs !== null &&
    Number.isSafeInteger(firstObservedRoundStartMs) &&
    Number.isFinite(asOfMs) && firstObservedRoundStartMs <= asOfMs;
  const denominator = validWindow
    ? Math.floor((asOfMs - firstObservedRoundStartMs!) / cadenceMs) + 1 : 0;
  const counts: CoverageCount = {
    numerator,
    denominator,
    percent: denominator > 0 ? Number((numerator / denominator * 100).toFixed(2)) : null,
  };
  return {
    status: denominator > 0 ? "measured" : "unavailable",
    ...counts,
    expectedScheduledRounds: denominator,
    observedRoundStarts: numerator,
    windowStartAt: validWindow ? new Date(firstObservedRoundStartMs!).toISOString() : null,
    windowEndAt: validWindow
      ? new Date(firstObservedRoundStartMs! + (denominator - 1) * cadenceMs).toISOString() : null,
    measuredAt: Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString() : null,
    basis: "Distinct observed WaterX round starts divided by expected cadence slots, from the earliest persisted round start through the latest scheduled start at query time. This is prospective capture coverage only from the recorded start; it does not describe earlier history.",
  };
}

export function settlementCompletionCoverage(
  acceptedLabels: number,
  eligibleExpiredObservedRounds: number,
) {
  const numerator = safeCount(acceptedLabels);
  const denominator = safeCount(eligibleExpiredObservedRounds);
  return {
    status: denominator > 0 ? "measured" : "unavailable",
    numerator,
    denominator,
    percent: denominator > 0 ? Number((numerator / denominator * 100).toFixed(2)) : null,
    acceptedLabels: numerator,
    eligibleExpiredObservedRounds: denominator,
    basis: "Accepted, undisputed labels divided by observed rounds whose market interval has expired. Unobserved scheduled rounds are not part of this settlement denominator.",
  };
}

export function marketProbabilityPredictionCoverage(
  scoredMarketProbabilities: number,
  eligibleAcceptedLabels: number,
) {
  const numerator = safeCount(scoredMarketProbabilities);
  const denominator = safeCount(eligibleAcceptedLabels);
  return {
    status: denominator > 0 ? "measured" : "unavailable",
    numerator,
    denominator,
    percent: denominator > 0 ? Number((numerator / denominator * 100).toFixed(2)) : null,
    scoredMarketProbabilityRounds: numerator,
    eligibleAcceptedLabelRounds: denominator,
    series: "prospective WaterX market-probability baseline; not a Bluewater model forecast",
    basis: "Verified, undisputed expired rounds with a valid pre-expiry frozen WaterX probability, divided by all verified, undisputed expired observed rounds. Candidate features are not counted as predictions.",
  };
}

export type SettlementLagClass = "clock_uncertain" | "within_interval" | "delayed_discovery";

/** Timing classification only: the persisted schema cannot prove whether a
 * late observation came from ordinary retry, restart recovery, or backfill. */
export function classifySettlementDiscoveryLag(
  latencyMs: number,
  intervalMinutes: WaterxInterval,
): SettlementLagClass {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return "clock_uncertain";
  return latencyMs <= intervalMinutes * 60_000 ? "within_interval" : "delayed_discovery";
}