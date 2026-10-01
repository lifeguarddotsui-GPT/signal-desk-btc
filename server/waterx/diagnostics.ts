import { randomUUID } from "node:crypto";
import type { WaterxHealthDiagnostics, WaterxInterval } from "./types";

export type WaterxFailureStage = "provider" | "parse" | "round_validation" | "timeout" | "storage";
export type WaterxOperationalDiagnostics = WaterxHealthDiagnostics & {
  lastSuccessfulRequestAt: string | null;
  lastValidRoundId: string | null;
  providerSourceTimestamp: string | null;
  lastFailureStage: WaterxFailureStage | null;
  retryAttempt: number;
  requestAttempt: number;
  lastRejectionReason: string | null;
  lastCandidateCaptureAt: string | null;
  lastCandidateCaptureReason: string | null;
};

const intervals: WaterxInterval[] = [5, 15];
// The collector ordinarily polls every 5s (5m rounds) or 10s (15m rounds).
// Match the live snapshot's freshness bounds, with a second bound for a
// collector that has remained overdue for substantially longer.
const freshnessThresholdMs: Record<WaterxInterval, number> = { 5: 16_000, 15: 31_000 };
const processWorkerId = randomUUID();
const health = new Map<WaterxInterval, WaterxOperationalDiagnostics>(intervals.map(interval => [
  interval, {
    intervalMinutes: interval,
    collectorStatus: "WAITING",
    healthState: "DEGRADED",
    observationFreshness: "WAITING",
    lastObservationAgeMs: null,
    freshnessThresholdMs: freshnessThresholdMs[interval],
    lastFetchAttemptAt: null,
    lastFetchSuccessAt: null,
    lastSuccessfulRequestAt: null,
    lastValidObservationAt: null,
    lastError: null,
    roundId: null,
    lastValidRoundId: null,
    roundStartsAt: null,
    providerSourceTimestamp: null,
    lastFailureStage: null,
    retryAttempt: 0,
    requestAttempt: 0,
    lastRejectionReason: null,
    lastCandidateCaptureAt: null,
    lastCandidateCaptureReason: null,
    retryAt: null,
    retryDelayMs: null,
    consecutiveFailures: 0,
    fetchInFlight: false,
    fetchInFlightAgeMs: null,
    workerId: null,
    workerHeartbeatAt: null,
    lastScheduledExecutionAt: null,
    nextExpectedExecutionAt: null,
    lastRecoveryAttemptAt: null,
    backgroundObservationInFlight: false,
    backgroundObservationStartedAt: null,
    lastObservationPersistedAt: null,
    lastBackgroundError: null,
    missedRoundCount: 0,
    lastMissedRoundAt: null,
  },
]));

function state(interval: WaterxInterval): WaterxOperationalDiagnostics {
  return health.get(interval)!;
}

export function waterxScheduleTick(interval: WaterxInterval, at = Date.now()): void {
  const current = state(interval);
  current.workerId = processWorkerId;
  current.workerHeartbeatAt = new Date(at).toISOString();
  current.lastScheduledExecutionAt = current.workerHeartbeatAt;
  current.nextExpectedExecutionAt = null;
}

export function waterxScheduleNext(interval: WaterxInterval, at: number): void {
  state(interval).nextExpectedExecutionAt = new Date(at).toISOString();
}

export function waterxWorkerHeartbeat(interval: WaterxInterval, at = Date.now()): void {
  const current = state(interval);
  current.workerId = processWorkerId;
  current.workerHeartbeatAt = new Date(at).toISOString();
}

export function waterxRecoveryAttempt(interval: WaterxInterval, at = Date.now()): void {
  state(interval).lastRecoveryAttemptAt = new Date(at).toISOString();
}

export function waterxObservationBackgroundStarted(interval: WaterxInterval, at = Date.now()): void {
  const current = state(interval);
  current.backgroundObservationInFlight = true;
  current.backgroundObservationStartedAt = new Date(at).toISOString();
}

/** Process-local visibility only; never reconstruct historical skip reasons. */
export function waterxCandidateCaptureFinished(
  interval: WaterxInterval, reason: string, at = Date.now(),
): void {
  const current = state(interval);
  current.lastCandidateCaptureAt = new Date(at).toISOString();
  current.lastCandidateCaptureReason = reason.slice(0, 240);
}

export function waterxObservationBackgroundFinished(
  interval: WaterxInterval, error: string | null, at = Date.now(),
): void {
  const current = state(interval);
  current.backgroundObservationInFlight = false;
  current.lastBackgroundError = error?.slice(0, 180) ?? null;
  if (!error) current.lastObservationPersistedAt = new Date(at).toISOString();
}

export function waterxFetchStarted(interval: WaterxInterval, at = Date.now()): void {
  const current = state(interval);
  current.lastFetchAttemptAt = new Date(at).toISOString();
  current.requestAttempt += 1;
  current.fetchInFlight = true;
}

export function waterxFetchSucceeded(
  interval: WaterxInterval,
  round: { id: string; startsAt: number },
  at = Date.now(),
  validObservation = true,
  collectorStatus?: WaterxHealthDiagnostics["collectorStatus"],
  providerSourceTimestamp: string | null = null,
  requestReceivedAt?: string,
): void {
  const current = state(interval);
  current.lastFetchSuccessAt = new Date(at).toISOString();
  current.lastSuccessfulRequestAt = requestReceivedAt ?? current.lastFetchSuccessAt;
  current.providerSourceTimestamp = providerSourceTimestamp;
  current.lastError = null;
  current.retryAttempt = 0;
  if (collectorStatus) current.collectorStatus = collectorStatus;
  current.lastValidRoundId = round.id;
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
  stage: WaterxFailureStage = "provider",
): void {
  const current = state(interval);
  current.lastError = error.slice(0, 180);
  current.lastFailureStage = stage;
  current.lastRejectionReason = error.slice(0, 180);
  current.collectorStatus = status;
  current.retryDelayMs = retryDelayMs;
  current.retryAt = new Date(at + retryDelayMs).toISOString();
  current.consecutiveFailures += 1;
  current.retryAttempt = current.consecutiveFailures;
  current.fetchInFlight = false;
}

export function waterxRequestSucceeded(interval: WaterxInterval, requestReceivedAt: string): void {
  state(interval).lastSuccessfulRequestAt = requestReceivedAt;
}

export function waterxStorageFailed(interval: WaterxInterval, error: string): void {
  const current = state(interval);
  current.lastFailureStage = "storage";
  current.lastRejectionReason = error.slice(0, 180);
  current.lastBackgroundError = error.slice(0, 180);
}

export function waterxFetchFinished(interval: WaterxInterval): void {
  state(interval).fetchInFlight = false;
}

export function getWaterxDiagnostics(interval: WaterxInterval, now = Date.now()): WaterxOperationalDiagnostics {
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
  const started = current.lastFetchAttemptAt ? Date.parse(current.lastFetchAttemptAt) : NaN;
  const fetchInFlightAgeMs = current.fetchInFlight && Number.isFinite(started)
    ? Math.max(0, now - started) : null;
  const heartbeatAt = current.workerHeartbeatAt ? Date.parse(current.workerHeartbeatAt) : NaN;
  const attemptAge = Number.isFinite(started) ? now - started : Infinity;
  const recoverAt = current.lastRecoveryAttemptAt ? Date.parse(current.lastRecoveryAttemptAt) : NaN;
  const healthState: WaterxHealthDiagnostics["healthState"] =
    (current.collectorStatus === "DISCONNECTED" || current.collectorStatus === "INVALID_RESPONSE") &&
      current.lastError ? "PROVIDER_UNAVAILABLE"
    : (fetchInFlightAgeMs !== null && fetchInFlightAgeMs > 30_000) ||
      (observationFreshness === "STALLED" && attemptAge > (interval === 5 ? 25_000 : 30_000))
      ? "STALLED"
    : Number.isFinite(recoverAt) && now - recoverAt < 30_000 && observationFreshness !== "FRESH"
      ? "RECOVERING"
    : collectorStatus === "LIVE" && observationFreshness === "FRESH" &&
      Number.isFinite(heartbeatAt) && now - heartbeatAt < 45_000 &&
      !current.lastBackgroundError ? "LIVE"
    : "DEGRADED";
  return {
    ...current,
    collectorStatus,
    healthState,
    observationFreshness,
    lastObservationAgeMs: age,
    freshnessThresholdMs: threshold,
    fetchInFlightAgeMs,
  };
}

export function getAllWaterxDiagnostics(): WaterxOperationalDiagnostics[] {
  return intervals.map(getWaterxDiagnostics);
}