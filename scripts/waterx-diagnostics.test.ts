import assert from "node:assert/strict";
import test from "node:test";
import {
  getWaterxDiagnostics, waterxFetchFailed, waterxFetchStarted, waterxFetchSucceeded,
  waterxScheduleTick, waterxScheduleNext, waterxWorkerHeartbeat,
  waterxRecoveryAttempt, waterxObservationBackgroundStarted,
  waterxObservationBackgroundFinished, waterxRequestSucceeded, waterxStorageFailed,
  waterxCandidateCaptureFinished,
} from "../server/waterx/diagnostics";

test("candidate capture skip reasons remain explicit, interval-separated process-local diagnostics", () => {
  const prior = getWaterxDiagnostics(15).lastCandidateCaptureReason;
  waterxCandidateCaptureFinished(5, "Candidate capture skipped: incomplete preclose comparison ticks.", 1_800_000_000_000);
  assert.match(getWaterxDiagnostics(5).lastCandidateCaptureReason!, /incomplete preclose/);
  assert.equal(getWaterxDiagnostics(15).lastCandidateCaptureReason, prior);
});

test("collector diagnostics are interval-isolated and expose missed-round gaps and failures", () => {
  const start = 1_800_000_000;
  waterxFetchStarted(5, start * 1000);
  waterxFetchSucceeded(5, { id: "first", startsAt: start }, start * 1000, true, "LIVE");
  waterxFetchSucceeded(5, { id: "later", startsAt: start + 1_200 },
    (start + 1_200) * 1000, true, "LIVE");
  const five = getWaterxDiagnostics(5);
  assert.equal(five.missedRoundCount, 3);
  assert.equal(five.collectorStatus, "LIVE");
  assert.equal(five.roundId, "later");
  assert.equal(five.lastMissedRoundAt, new Date((start + 1_200) * 1000).toISOString());

  waterxFetchFailed(5, "Malformed WaterX response", 5_000, (start + 1_201) * 1000,
    "INVALID_RESPONSE");
  assert.equal(getWaterxDiagnostics(5).collectorStatus, "INVALID_RESPONSE");
  assert.equal(getWaterxDiagnostics(15).missedRoundCount, 0);
  assert.equal(getWaterxDiagnostics(15).lastFetchAttemptAt, null);

  const requestAt = new Date((start + 1_202) * 1000).toISOString();
  waterxFetchStarted(15, (start + 1_202) * 1000);
  waterxRequestSucceeded(15, requestAt);
  waterxFetchFailed(15, "WaterX response body timed out", 10_000,
    (start + 1_203) * 1000, "DISCONNECTED", "timeout");
  const failedRead = getWaterxDiagnostics(15);
  assert.equal(failedRead.lastSuccessfulRequestAt, requestAt);
  assert.equal(failedRead.lastValidRoundId, null);
  assert.equal(failedRead.providerSourceTimestamp, null);
  assert.equal(failedRead.lastFailureStage, "timeout");
  assert.equal(failedRead.retryAttempt, 1);
  assert.equal(failedRead.requestAttempt, 1);
  assert.equal(failedRead.lastRejectionReason, "WaterX response body timed out");
  waterxStorageFailed(15, "database unavailable");
  assert.equal(getWaterxDiagnostics(15).lastFailureStage, "storage");
});

test("collector freshness is per interval and an expired success cannot remain LIVE", () => {
  const observedAt = 1_700_000_000_000;
  waterxFetchStarted(15, observedAt);
  waterxFetchSucceeded(15, { id: "observed", startsAt: observedAt / 1000 },
    observedAt, true, "LIVE");

  const fresh = getWaterxDiagnostics(15, observedAt + 31_000);
  assert.equal(fresh.collectorStatus, "LIVE");
  assert.equal(fresh.observationFreshness, "FRESH");
  assert.equal(fresh.freshnessThresholdMs, 31_000);

  const overdue = getWaterxDiagnostics(15, observedAt + 31_001);
  assert.equal(overdue.collectorStatus, "STALE");
  assert.equal(overdue.observationFreshness, "OVERDUE");
  assert.equal(overdue.lastObservationAgeMs, 31_001);

  const stalled = getWaterxDiagnostics(15, observedAt + 62_001);
  assert.equal(stalled.collectorStatus, "STALE");
  assert.equal(stalled.observationFreshness, "STALLED");

  // The other interval retains its independent freshness bound/state.
  const fiveMinute = getWaterxDiagnostics(5, observedAt + 100_000);
  assert.equal(fiveMinute.freshnessThresholdMs, 16_000);
});

test("health separates a scheduled live worker, stalled attempt, provider failure, and storage error", () => {
  const now = 1_900_000_000_000;
  waterxScheduleTick(5, now);
  waterxScheduleNext(5, now + 5_000);
  waterxFetchStarted(5, now);
  waterxFetchSucceeded(5, { id: "health-round", startsAt: now / 1000 }, now, true, "LIVE");
  const live = getWaterxDiagnostics(5, now + 1_000);
  assert.equal(live.healthState, "LIVE");
  assert.ok(live.workerId);
  assert.equal(live.lastScheduledExecutionAt, new Date(now).toISOString());
  assert.equal(live.nextExpectedExecutionAt, new Date(now + 5_000).toISOString());
  assert.equal(live.fetchInFlightAgeMs, null);

  const stalled = getWaterxDiagnostics(5, now + 40_000);
  assert.equal(stalled.healthState, "STALLED");
  waterxFetchStarted(5, now + 40_000);
  waterxRecoveryAttempt(5, now + 40_000);
  waterxWorkerHeartbeat(5, now + 40_000);
  assert.equal(getWaterxDiagnostics(5, now + 40_100).healthState, "RECOVERING");
  waterxFetchFailed(5, "provider timeout", 5_000, now + 40_200);
  assert.equal(getWaterxDiagnostics(5, now + 40_300).healthState, "PROVIDER_UNAVAILABLE");

  waterxFetchSucceeded(5, { id: "health-round", startsAt: now / 1000 },
    now + 41_000, true, "LIVE");
  waterxObservationBackgroundStarted(5, now + 41_000);
  assert.equal(getWaterxDiagnostics(5, now + 41_100).backgroundObservationInFlight, true);
  waterxObservationBackgroundFinished(5, "database unavailable", now + 41_200);
  assert.equal(getWaterxDiagnostics(5, now + 41_300).healthState, "DEGRADED");
  assert.equal(getWaterxDiagnostics(5, now + 41_300).lastBackgroundError, "database unavailable");
});