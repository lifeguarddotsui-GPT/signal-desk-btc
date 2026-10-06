import type { WaterxInterval } from "./types";

export type WaterxCoverageQueryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

type StoredCoverageRound = {
  round_id: unknown;
  start_ms: unknown;
  expiry_ms: unknown;
  observed_at: unknown;
};

const ROUND_COVERAGE_ROW_LIMIT = 10_000;
const ROUND_COVERAGE_SELECT = `
  SELECT round_id,start_ms,expiry_ms,observed_at
    FROM waterx_learning_rounds
   WHERE interval_minutes=$1
`;

function missingCoverageSchema(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    ["42P01", "3F000", "42703"].includes(String((error as { code?: unknown }).code ?? ""));
}

function positiveSafeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value :
    typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function observedTime(value: unknown): { ms: number; iso: string } | null {
  const ms = value instanceof Date ? value.getTime() :
    typeof value === "string" || typeof value === "number" ? Date.parse(String(value)) : NaN;
  return Number.isFinite(ms) ? { ms, iso: new Date(ms).toISOString() } : null;
}

/**
 * Read-only inventory of persisted WaterX round starts. The row scan is capped;
 * when the cap is reached, internal-gap totals are withheld rather than
 * extrapolated from a partial sample.
 */
export async function waterxObservedRoundCoverage(db: WaterxCoverageQueryable) {
  try {
    const intervals = await Promise.all(([5, 15] as const).map(async intervalMinutes => {
      const [sampleResult, latestResult, observationResult] = await Promise.all([
        db.query(
          `${ROUND_COVERAGE_SELECT} ORDER BY start_ms ASC,round_id ASC LIMIT $2`,
          [intervalMinutes, ROUND_COVERAGE_ROW_LIMIT + 1],
        ),
        db.query(
          `${ROUND_COVERAGE_SELECT} ORDER BY start_ms DESC,round_id ASC LIMIT 1`,
          [intervalMinutes],
        ),
        db.query(
          `SELECT observed_at FROM waterx_learning_rounds
            WHERE interval_minutes=$1
            ORDER BY observed_at DESC,round_id ASC LIMIT 1`,
          [intervalMinutes],
        ),
      ]);
      const capped = sampleResult.rows.length > ROUND_COVERAGE_ROW_LIMIT;
      const sample = sampleResult.rows.slice(0, ROUND_COVERAGE_ROW_LIMIT) as StoredCoverageRound[];
      const cadenceMs = intervalMinutes * 60_000;
      const malformedRoundIds: string[] = [];
      const outOfOrderRoundIds: string[] = [];
      const valid: Array<{ roundId: string; startMs: number; observedMs: number }> = [];

      for (const raw of sample) {
        const row = raw as StoredCoverageRound;
        const roundId = typeof row.round_id === "string" ? row.round_id.trim() : "";
        const startMs = positiveSafeInteger(row.start_ms);
        const expiryMs = positiveSafeInteger(row.expiry_ms);
        const observed = observedTime(row.observed_at);
        if (!roundId || startMs === null || expiryMs === null || !observed ||
            startMs % cadenceMs !== 0 || expiryMs - startMs !== cadenceMs) {
          malformedRoundIds.push(roundId || "(missing round ID)");
          continue;
        }
        valid.push({ roundId, startMs, observedMs: observed.ms });
      }

      // Rows are ordered by round start. A backwards observation timestamp
      // means the stored observations do not follow that same round sequence.
      let latestObservedMs = -Infinity;
      const orderedValid = valid.filter(row => {
        if (row.observedMs < latestObservedMs) {
          outOfOrderRoundIds.push(row.roundId);
          return false;
        }
        latestObservedMs = row.observedMs;
        return true;
      });
      const starts = Array.from(new Set(orderedValid.map(row => row.startMs))).sort((a, b) => a - b);
      const earliest = starts[0] ?? null;
      const latestRow = latestResult.rows[0] as StoredCoverageRound | undefined;
      const latestStartRaw = latestRow ? positiveSafeInteger(latestRow.start_ms) : null;
      const latestExpiryRaw = latestRow ? positiveSafeInteger(latestRow.expiry_ms) : null;
      const latestRoundId = latestRow && typeof latestRow.round_id === "string"
        ? latestRow.round_id.trim() : "";
      const latestIsValid = latestStartRaw !== null && latestExpiryRaw !== null &&
        !!latestRoundId && latestStartRaw % cadenceMs === 0 &&
        latestExpiryRaw - latestStartRaw === cadenceMs;
      const latest = capped
        ? latestIsValid ? latestStartRaw : null
        : starts.at(-1) ?? null;
      let missingInternalSlots: number | null = null;
      if (!capped && starts.length > 0) {
        let missing = 0;
        for (let index = 1; index < starts.length; index++) {
          const gap = starts[index] - starts[index - 1];
          if (gap > cadenceMs) missing += Math.floor(gap / cadenceMs) - 1;
        }
        missingInternalSlots = missing;
      }
      const lastObserved = observedTime(
        (observationResult.rows[0] as { observed_at?: unknown } | undefined)?.observed_at,
      );
      return {
        intervalMinutes,
        status: sample.length ? "measured" : "unavailable",
        earliestObservedRound: earliest === null ? null : new Date(earliest).toISOString(),
        latestObservedRound: latest === null ? null : new Date(latest).toISOString(),
        expectedCadenceSlots: earliest !== null && latest !== null
          ? Math.floor((latest - earliest) / cadenceMs) + 1 : null,
        observedDistinctRoundStarts: starts.length,
        observedDistinctRoundStartsIsLowerBound: capped,
        missingInternalSlots,
        lastStoredObservationAt: lastObserved?.iso ?? null,
        malformedDataWithheld: { count: malformedRoundIds.length, roundIds: malformedRoundIds },
        outOfOrderDataWithheld: { count: outOfOrderRoundIds.length, roundIds: outOfOrderRoundIds },
        scanLimited: capped,
        basis: "Observed persisted WaterX rows only. This reports gaps between stored starts and cannot establish whether rounds before or after the observed range were missed.",
      };
    }));
    return {
      status: "available",
      intervals: { "5m": intervals[0], "15m": intervals[1] },
      basis: "Read-only observed-round coverage from waterx_learning_rounds; no unobserved rounds are inferred as complete.",
    };
  } catch (error) {
    if (missingCoverageSchema(error)) {
      return {
        status: "unavailable",
        reason: "WaterX learning-round schema is unavailable; coverage could not be measured.",
        intervals: null,
      };
    }
    throw error;
  }
}

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