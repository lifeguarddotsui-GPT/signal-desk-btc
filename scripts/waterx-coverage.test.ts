import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySettlementDiscoveryLag,
  marketCaptureCoverage,
  marketProbabilityPredictionCoverage,
  settlementCompletionCoverage,
  waterxObservedRoundCoverage,
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

test("durable round coverage reports observed cadence gaps independently for 5m and 15m", async () => {
  const first = Date.UTC(2026, 0, 1);
  const records: Record<number, Array<Record<string, unknown>>> = {
    5: [0, 1, 3].map((offset, index) => ({
      round_id: `five-${index}`,
      start_ms: String(first + offset * 5 * 60_000),
      expiry_ms: String(first + (offset + 1) * 5 * 60_000),
      observed_at: new Date(first + (offset + 1) * 5 * 60_000).toISOString(),
    })),
    15: [0, 1].map((offset, index) => ({
      round_id: `fifteen-${index}`,
      start_ms: String(first + offset * 15 * 60_000),
      expiry_ms: String(first + (offset + 1) * 15 * 60_000),
      observed_at: new Date(first + (offset + 1) * 15 * 60_000).toISOString(),
    })),
  };
  const db = {
    async query(sql: string, values: unknown[] = []) {
      const interval = Number(values[0]);
      const rounds = records[interval];
      if (sql.includes("ORDER BY start_ms ASC")) return { rows: rounds };
      if (sql.includes("ORDER BY start_ms DESC")) return { rows: [rounds.at(-1)] };
      return { rows: [{ observed_at: rounds.at(-1)?.observed_at }] };
    },
  };
  const report = await waterxObservedRoundCoverage(db);
  assert.equal(report.status, "available");
  assert.equal(report.intervals["5m"].earliestObservedRound, new Date(first).toISOString());
  assert.equal(report.intervals["5m"].latestObservedRound, new Date(first + 15 * 60_000).toISOString());
  assert.equal(report.intervals["5m"].expectedCadenceSlots, 4);
  assert.equal(report.intervals["5m"].observedDistinctRoundStarts, 3);
  assert.equal(report.intervals["5m"].missingInternalSlots, 1);
  assert.equal(report.intervals["5m"].lastStoredObservationAt, records[5][2].observed_at);
  assert.equal(report.intervals["15m"].expectedCadenceSlots, 2);
  assert.equal(report.intervals["15m"].missingInternalSlots, 0);
  assert.match(report.basis, /no unobserved rounds are inferred as complete/);
});

test("malformed and out-of-order rows are withheld and unavailable schema is explicit", async () => {
  const first = Date.UTC(2026, 0, 1);
  const rounds = [
    { round_id: "first", start_ms: first, expiry_ms: first + 300_000,
      observed_at: new Date(first + 10_000).toISOString() },
    { round_id: "bad", start_ms: first + 300_000, expiry_ms: first + 600_000,
      observed_at: "not-a-time" },
    { round_id: "late-start", start_ms: first + 600_000, expiry_ms: first + 900_000,
      observed_at: new Date(first + 5_000).toISOString() },
  ];
  const db = {
    async query(sql: string) {
      if (sql.includes("interval_minutes=$1")) {
        if (sql.includes("ORDER BY start_ms ASC")) return { rows: rounds };
        if (sql.includes("ORDER BY start_ms DESC")) return { rows: [rounds.at(-1)] };
      }
      return { rows: [{ observed_at: new Date(first + 10_000).toISOString() }] };
    },
  };
  const report = await waterxObservedRoundCoverage(db);
  assert.deepEqual(report.intervals["5m"].malformedDataWithheld, {
    count: 1, roundIds: ["bad"],
  });
  assert.deepEqual(report.intervals["5m"].outOfOrderDataWithheld, {
    count: 1, roundIds: ["late-start"],
  });
  assert.equal(report.intervals["5m"].observedDistinctRoundStarts, 1);
  assert.equal(report.intervals["5m"].latestObservedRound, new Date(first).toISOString());

  const unavailable = await waterxObservedRoundCoverage({
    async query() { throw Object.assign(new Error("missing table"), { code: "42P01" }); },
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.intervals, null);
});