import type { WaterxHealthDiagnostics, WaterxInterval } from "./types";

const intervals: WaterxInterval[] = [5, 15];
// The collector ordinarily polls every 5s (5m rounds) or 10s (15m rounds).
// Match the live snapshot's freshness bounds, with a second bound for a
// collector that has remained overdue for substantially longer.
const freshnessThresholdMs: Record<WaterxInterval, number> = { 5: 16_000, 15: 31_000 };
const health = new Map<WaterxInterval, WaterxHealthDiagnostics>(intervals.map(interval => [
  interval, {
    intervalMinutes: interval,
    collectorStatus: "WAITING",
    observationFreshness: "WAITING",
    lastObservationAgeMs: null,
    freshnessThresholdMs: freshnessThresholdMs[interval],
    lastFetchAttemptAt: null,
    lastFetchSuccessAt: null,
    lastValidObservationAt: null,
    lastError: null,
    roundId: null,
    roundStartsAt: null,
    retryAt: null,
    retryDelayMs: null,
    consecutiveFailures: 0,
    fetchInFlight: false,
    missedRoundCount: 0,
    lastMissedRoundAt: null,
  },
]));

function state(interval: WaterxInterval): WaterxHealthDiagnostics {
  return health.get(interval)!;
}

export function waterxFetchStarted(interval: WaterxInterval, at = Date.now()): void {
  const current = state(interval);
  current.lastFetchAttemptAt = new Date(at).toISOString();
  current.fetchInFlight = true;
}

export function waterxFetchSucceeded(
  interval: WaterxInterval,
  round: { id: string; startsAt: number },
  at = Date.now(),
  validObservation = true,
  collectorStatus?: WaterxHealthDiagnostics["collectorStatus"],
): void {
  const current = state(interval);
  current.lastFetchSuccessAt = new Date(at).toISOString();
  current.lastError = null;
  if (collectorStatus) current.collectorStatus = collectorStatus;
  if (validObservation) {
    if (collectorStatus !== "NO_ACTIVE_MARKET") {
      const priorStart = current.roundStartsAt;
      const cadenceSeconds = interval * 60;
      if (priorStart !== null && round.startsAt > priorStart + cadenceSeconds) {
        current.missedRoundCount += Math.floor((round.startsAt - priorStart) / cadenceSeconds) - 1;
        current.lastMissedRoundAt = current.lastFetchSuccessAt;
      }
      current.roundId = round.id;
      current.roundStartsAt = round.startsAt;
    }
    current.lastValidObservationAt = current.lastFetchSuccessAt;
  }
  current.retryAt = null;
  current.retryDelayMs = null;
  current.consecutiveFailures = 0;
  current.fetchInFlight = false;
}

export function waterxFetchFailed(
  interval: WaterxInterval,
  error: string,
  retryDelayMs: number,
  at = Date.now(),
  status: "DISCONNECTED" | "INVALID_RESPONSE" = "DISCONNECTED",
): void {
  const current = state(interval);
  current.lastError = error.slice(0, 180);
  current.collectorStatus = status;
  current.retryDelayMs = retryDelayMs;
  current.retryAt = new Date(at + retryDelayMs).toISOString();
  current.consecutiveFailures += 1;
  current.fetchInFlight = false;
}

export function waterxFetchFinished(interval: WaterxInterval): void {
  state(interval).fetchInFlight = false;
}

export function getWaterxDiagnostics(interval: WaterxInterval, now = Date.now()): WaterxHealthDiagnostics {
  const current = state(interval);
  const observationAt = current.lastValidObservationAt === null
    ? NaN : Date.parse(current.lastValidObservationAt);
  const age = Number.isFinite(observationAt) ? Math.max(0, now - observationAt) : null;
  const threshold = freshnessThresholdMs[interval];
  const observationFreshness = age === null ? "WAITING"
    : age > threshold * 2 ? "STALLED"
    : age > threshold ? "OVERDUE"
    : "FRESH";
  // A previous LIVE result is not evidence that the collector remains live.
  // Never leak that status after its observation expires (or if its timestamp
  // is missing/invalid).
  const collectorStatus = current.collectorStatus === "LIVE" &&
    observationFreshness !== "FRESH" ? "STALE" : current.collectorStatus;
  return {
    ...current,
    collectorStatus,
    observationFreshness,
    lastObservationAgeMs: age,
    freshnessThresholdMs: threshold,
  };
}

export function getAllWaterxDiagnostics(): WaterxHealthDiagnostics[] {
  return intervals.map(getWaterxDiagnostics);
}