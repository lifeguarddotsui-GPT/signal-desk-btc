import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySettlementDiscoveryLag,
  marketCaptureCoverage,
  marketProbabilityPredictionCoverage,
  settlementCompletionCoverage,
} from "../server/waterx/coverage";

test("market-capture coverage counts expected cadence slots only since first persisted round", () => {
  const first = Date.UTC(2026, 0, 1);
  const now = first + 4 * 5 * 60_000 + 1_000;
  const result = marketCaptureCoverage(5, 3, first, now);
  assert.equal(result.numerator, 3);
  assert.equal(result.denominator, 5);
  assert.equal(result.percent, 60);
  assert.equal(result.expectedScheduledRounds, 5);
  assert.equal(result.windowStartAt, new Date(first).toISOString());
  assert.match(result.basis, /does not describe earlier history/);

  const empty = marketCaptureCoverage(15, 0, null, now);
  assert.equal(empty.denominator, 0);
  assert.equal(empty.percent, null);
  assert.equal(empty.status, "unavailable");
});

test("settlement and market-probability coverage expose exact numerators and eligible denominators", () => {
  assert.deepEqual(
    (({ numerator, denominator, percent }) =>
      ({ numerator, denominator, percent }))(settlementCompletionCoverage(7, 10)),
    { numerator: 7, denominator: 10, percent: 70 },
  );
  const noSettlements = settlementCompletionCoverage(0, 0);
  assert.equal(noSettlements.percent, null);
  assert.equal(noSettlements.status, "unavailable");

  const predictions = marketProbabilityPredictionCoverage(4, 7);
  assert.equal(predictions.numerator, 4);
  assert.equal(predictions.denominator, 7);
  assert.equal(predictions.percent, 57.14);
  assert.match(predictions.series, /not a Bluewater model forecast/);
  assert.match(predictions.basis, /Candidate features are not counted/);
});

test("settlement delays are categorized by elapsed interval without claiming backfill provenance", () => {
  assert.equal(classifySettlementDiscoveryLag(-5_000, 5), "clock_uncertain");
  assert.equal(classifySettlementDiscoveryLag(5 * 60_000, 5), "within_interval");
  assert.equal(classifySettlementDiscoveryLag(82 * 60_000, 5), "delayed_discovery");
  assert.equal(classifySettlementDiscoveryLag(16 * 60_000, 15), "delayed_discovery");
});