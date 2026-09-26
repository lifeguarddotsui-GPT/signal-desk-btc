import test from "node:test";
import assert from "node:assert/strict";
import { evaluateShadow, type ShadowRow } from "../server/btc/model";

function rows(count: number, startMs = Date.UTC(2025, 0, 1), stepMs = 5 * 60_000): ShadowRow[] {
  return Array.from({ length: count }, (_, i) => {
    const observedMs = startMs + i * stepMs;
    return {
      id: `round-${i}`,
      observedMs,
      expiryMs: observedMs + 60_000,
      outcome: i % 3 === 0 || i % 3 === 1 ? "UP" : "DOWN",
      indicativeUp: 0.25 + ((i * 17) % 50) / 100,
      comparisonReturn: ((i % 11) - 5) / 10_000,
      realizedVolatility: 0.001 + (i % 7) / 10_000,
      remainingSeconds: 60,
    };
  });
}

test("walk-forward training, calibration, and test windows are strictly ordered", () => {
  const history = rows(420);
  const result = evaluateShadow(history);
  assert.equal(result.status, "shadow");
  assert.equal(result.eligible, true);
  assert.ok(result.challenger);
  const { training, calibration, test: heldOut } = result.evaluated.split;
  assert.ok(training.endUtc! < calibration.startUtc!);
  assert.ok(calibration.endUtc! < heldOut.startUtc!);
  assert.equal(result.challenger!.trainingCount, training.count);
  assert.equal(result.challenger!.calibrationCount, calibration.count);
  assert.equal(result.challenger!.metrics.count, heldOut.count);
  assert.equal(result.lastTrainingAt, training.endUtc);
  assert.ok(result.challenger!.method.includes("untouched later test window"));
  assert.ok(Date.parse(calibration.startUtc!) - Date.parse(training.endUtc!) >= 90_000);
  assert.ok(Date.parse(heldOut.startUtc!) - Date.parse(calibration.endUtc!) >= 90_000);
  assert.ok(!("champion" in result));
});

test("90-second embargo purges close boundary rows and volatility benchmark stays unavailable", () => {
  const closeObservations = rows(420, Date.UTC(2025, 0, 1), 30_000);
  const result = evaluateShadow(closeObservations);
  const { training, calibration, test: heldOut } = result.evaluated.split;
  assert.ok(Date.parse(calibration.startUtc!) - Date.parse(training.endUtc!) >= 90_000);
  assert.ok(Date.parse(heldOut.startUtc!) - Date.parse(calibration.endUtc!) >= 90_000);
  assert.equal(result.baselines.volatilityNeutral, null);
  assert.match(result.baselines.volatilityNeutralUnavailableReason, /settlement-relevant signed distance/);
});

test("changing untouched test outcomes cannot change fitted model or calibration", () => {
  const history = rows(420);
  const first = evaluateShadow(history);
  const calibrationEnd = Math.floor(history.length * 0.6) + Math.floor(history.length * 0.2);
  const changedTest = history.map((row, index) => index >= calibrationEnd
    ? { ...row, outcome: row.outcome === "UP" ? "DOWN" as const : "UP" as const }
    : row);
  const second = evaluateShadow(changedTest);
  assert.deepEqual(second.challenger!.coefficients, first.challenger!.coefficients);
  assert.deepEqual(second.challenger!.plattCalibration, first.challenger!.plattCalibration);
  assert.notEqual(second.challenger!.metrics.brier, first.challenger!.metrics.brier);
});

test("shadow probabilities and calibration bins stay bounded and sum to evaluated count", () => {
  const result = evaluateShadow(rows(420));
  const challenger = result.challenger!;
  const metrics = challenger.metrics;
  assert.ok(metrics.brier >= 0 && metrics.brier <= 1);
  assert.ok(metrics.logLoss >= 0);
  assert.equal(metrics.calibrationBins.reduce((sum, bin) => sum + bin.count, 0), metrics.count);
  for (const bin of metrics.calibrationBins) {
    assert.ok(bin.lower >= 0 && bin.upper <= 1 && bin.lower < bin.upper);
    if (bin.count) {
      assert.ok(bin.meanPredicted! >= 0 && bin.meanPredicted! <= 1);
      assert.ok(bin.observedUpRate! >= 0 && bin.observedUpRate! <= 1);
    } else {
      assert.equal(bin.meanPredicted, null);
      assert.equal(bin.observedUpRate, null);
    }
  }
  assert.equal(metrics.upCount + metrics.downCount, metrics.count);
  assert.ok(metrics.brierUncertainty.lower >= 0);
  assert.ok(metrics.brierUncertainty.upper <= 1);
  assert.ok(metrics.brierUncertainty.method.includes("serial dependence"));
});

test("duplicate rounds and future or invalid probability features are rejected", () => {
  const duplicate = rows(3);
  duplicate[2] = { ...duplicate[2], id: duplicate[1].id };
  assert.throws(() => evaluateShadow(duplicate), /Duplicate round id/);

  const future = rows(2);
  future[1] = { ...future[1], observedMs: future[1].expiryMs + 1 };
  assert.throws(() => evaluateShadow(future), /Future observation/);

  const invalidProbability = rows(2);
  invalidProbability[0] = { ...invalidProbability[0], indicativeUp: 1.01 };
  assert.throws(() => evaluateShadow(invalidProbability), /must be a probability/);
});

test("low sample history returns insufficient shadow status without a challenger", () => {
  const result = evaluateShadow(rows(120));
  assert.equal(result.status, "insufficient");
  assert.equal(result.eligible, false);
  assert.match(result.reason, /at least 300/);
  assert.equal(result.challenger, null);
});

test("single UTC day history fails the multi-day eligibility gate", () => {
  const oneDay = rows(300, Date.UTC(2025, 0, 1), 60_000);
  const result = evaluateShadow(oneDay);
  assert.equal(result.status, "insufficient");
  assert.equal(result.eligible, false);
  assert.match(result.reason, /distinct UTC days/);
  assert.equal(result.challenger, null);
});

test("repeated evaluation of identical history is deterministic", () => {
  const history = rows(420);
  const first = evaluateShadow(history);
  const second = evaluateShadow(history);
  assert.deepEqual(second, first);
  assert.equal(first.challenger!.metrics.count, first.evaluated.count);
});

test("history spanning multiple UTC days passes the minimum-day gate", () => {
  const history = rows(420, Date.UTC(2025, 0, 1, 12));
  assert.ok(new Set(history.map(row => new Date(row.observedMs).toISOString().slice(0, 10))).size >= 2);
  const result = evaluateShadow(history);
  assert.equal(result.status, "shadow");
  assert.equal(result.eligible, true);
});