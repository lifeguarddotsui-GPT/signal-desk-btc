import assert from "node:assert/strict";
import test from "node:test";
import {
  getWaterxDiagnostics, waterxFetchFailed, waterxFetchStarted, waterxFetchSucceeded,
} from "../server/waterx/diagnostics";

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
});