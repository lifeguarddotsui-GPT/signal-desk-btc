import type { WaterxHealthDiagnostics, WaterxInterval } from "./types";

const intervals: WaterxInterval[] = [5, 15];
const health = new Map<WaterxInterval, WaterxHealthDiagnostics>(intervals.map(interval => [
  interval, {
    intervalMinutes: interval,
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
): void {
  const current = state(interval);
  current.lastFetchSuccessAt = new Date(at).toISOString();
  current.lastError = null;
  if (validObservation) {
    current.lastValidObservationAt = current.lastFetchSuccessAt;
    current.roundId = round.id;
    current.roundStartsAt = round.startsAt;
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
): void {
  const current = state(interval);
  current.lastError = error.slice(0, 180);
  current.retryDelayMs = retryDelayMs;
  current.retryAt = new Date(at + retryDelayMs).toISOString();
  current.consecutiveFailures += 1;
  current.fetchInFlight = false;
}

export function waterxFetchFinished(interval: WaterxInterval): void {
  state(interval).fetchInFlight = false;
}

export function getWaterxDiagnostics(interval: WaterxInterval): WaterxHealthDiagnostics {
  return { ...state(interval) };
}

export function getAllWaterxDiagnostics(): WaterxHealthDiagnostics[] {
  return intervals.map(getWaterxDiagnostics);
}