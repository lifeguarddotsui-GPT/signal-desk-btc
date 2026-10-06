import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateWaterxRows,
  firstAcceptedWaterxLabelAvailableMs,
  freezeWaterxObservation,
  isWaterxSettlementPending,
  isWaterxSettlementObservation,
  recordWaterxRound,
  waterxOutcomeForPrices,
  waterxSettlementResult,
  waterxSettlementDecision,
  waterxSettlementRejection,
  waterxSettlementRevision,
  type WaterxEvaluationRow,
  type WaterxSettlementInput,
} from "../server/waterx/learning";

function history(intervalMinutes: 5 | 15, count: number): WaterxEvaluationRow[] {
  const start = Date.UTC(2025, 0, 1);
  const step = intervalMinutes * 60_000;
  return Array.from({ length: count }, (_, index) => {
    const startMs = start + index * step;
    return {
      roundId: `${intervalMinutes}m-round-${index}`,
      startMs,
      expiryMs: startMs + step,
      observedAt: new Date(startMs + 5_000).toISOString(),
      probabilityUp: 0.2 + (index % 7) * 0.1,
      outcome: index % 2 ? "Up" : "Down",
      settledAt: startMs + step + 2_000,
      labelAvailableMs: startMs + step + 10_000,
      labelStatus: "verified",
      withheldReason: null,
    };
  });
}

function settlement(overrides: Partial<WaterxSettlementInput> = {}): WaterxSettlementInput {
  return {
    intervalMinutes: 5,
    roundId: "round-a",
    anchorPrice: 100,
    anchorConfirmed: true,
    settlePrice: 100,
    outcome: "Up",
    settledAt: 1_000_001,
    observedAt: new Date(1_000_002).toISOString(),
    resolutionStatus: "resolved",
    ...overrides,
  };
}

test("repeated observations preserve the first frozen probability and round identity", () => {
  const earliest = {
    intervalMinutes: 5 as const,
    roundId: "same-id",
    probabilityUp: 0.61,
    observedAt: "2025-01-01T00:00:01.000Z",
  };
  const laterDelivery = { ...earliest, probabilityUp: 0.04, observedAt: "2025-01-01T00:00:02.000Z" };
  assert.equal(freezeWaterxObservation(earliest, laterDelivery), earliest);
  assert.equal(freezeWaterxObservation(null, earliest), earliest);
  assert.throws(() => freezeWaterxObservation(earliest, {
    ...laterDelivery, intervalMinutes: 15,
  }), /round identities/);
});

test("5m and 15m learning cohorts are interval-isolated and use cadence-specific readiness", () => {
  const fiveMinute = evaluateWaterxRows(5, history(5, 650));
  const fifteenMinute = evaluateWaterxRows(15, history(15, 850));
  assert.equal(fiveMinute.intervalMinutes, 5);
  assert.equal(fifteenMinute.intervalMinutes, 15);
  assert.equal(fiveMinute.readiness.minimumSpanHours, 48);
  assert.equal(fifteenMinute.readiness.minimumSpanHours, 168);
  assert.equal(fiveMinute.readiness.ready, true);
  assert.equal(fifteenMinute.readiness.ready, true);
  assert.throws(() => evaluateWaterxRows(5, [history(5, 2)[0], history(5, 2)[0]]),
    /Duplicate WaterX round ID/);
});

test("settlement equality labels Up, a provisional anchor may be confirmed later, and invalid authoritative evidence is withheld", () => {
  assert.equal(waterxOutcomeForPrices(100, 100), "Up");
  assert.equal(waterxOutcomeForPrices(100, 99.99), "Down");
  const round = {
    expiry_ms: 1_000_000,
    anchor_price: 100,
    anchor_confirmed: false,
    outcome: null,
  };
  // A provider-resolved final reference may confirm a previously provisional
  // observation with a different price. Probabilities/reference observations
  // remain frozen separately from this final settlement anchor.
  assert.equal(waterxSettlementRejection(settlement(), round), null);
  assert.equal(waterxSettlementRejection(settlement({
    anchorPrice: 101, settlePrice: 101,
  }), round), null);
  assert.match(waterxSettlementRejection(settlement({ resolutionStatus: "pending" }), round)!,
    /not verified as resolved/);
  assert.match(waterxSettlementRejection(settlement({ resolutionStatus: undefined }), round)!,
    /not verified as resolved/);
  assert.match(waterxSettlementRejection(settlement({ settlePrice: null }), round)!,
    /settlePrice is missing/);
  assert.match(waterxSettlementRejection(settlement({ outcome: "Down" }), round)!,
    /contradicts settlePrice/);
  assert.match(waterxSettlementRejection(settlement({
    anchorPrice: 101, settlePrice: 100,
  }), round)!, /contradicts settlePrice/);
  assert.match(waterxSettlementRejection(settlement({ anchorConfirmed: false }), round)!,
    /anchor is missing or unconfirmed/);
  assert.match(waterxSettlementRejection(settlement({ anchorPrice: 101 }), {
    ...round, anchor_confirmed: true,
  })!, /contradicts an already confirmed round reference/);
  assert.match(waterxSettlementRejection(settlement(), {
    ...round, interval_minutes: 15,
  })!, /interval does not match/);
  assert.match(waterxSettlementRejection(settlement(), {
    ...round, round_id: "another-round",
  })!, /round ID does not match/);
  assert.match(waterxSettlementRejection(settlement({ settledAt: 1_000_000 }), round)!,
    /does not prove settlement after/);
});

test("settlement labels reject evidence observed before its settledAt and timestamps in the future", () => {
  const now = Date.now();
  const closedRound = {
    expiry_ms: now - 10_000,
    anchor_price: 100,
    anchor_confirmed: false,
    outcome: null,
  };
  assert.match(waterxSettlementRejection(settlement({
    settledAt: now - 2_000,
    observedAt: new Date(now - 3_000).toISOString(),
  }), closedRound)!, /later than the settlement observation/);
  assert.match(waterxSettlementRejection(settlement({
    settledAt: now - 2_000,
    observedAt: new Date(now + 60_000).toISOString(),
  }), closedRound)!, /observedAt is in the future/);
  assert.match(waterxSettlementRejection(settlement({
    settledAt: now + 60_000,
    observedAt: new Date(now - 2_000).toISOString(),
  }), closedRound)!, /settledAt is in the future/);
});

test("chronological train/test embargo excludes boundary labels and held-out labels cannot affect training", () => {
  const rows = history(5, 650);
  const baseline = evaluateWaterxRows(5, rows);
  assert.equal(baseline.status, "evaluated");
  assert.ok(baseline.split.embargoExcludedCount > 0);
  assert.ok(baseline.split.trainingObservedThrough! < baseline.split.testObservedFrom!);
  assert.ok(baseline.split.testCount > 0);
  const testStartIndex = Math.floor(rows.length * 0.7);
  const changedTestLabels = rows.map((row, index) => index >= testStartIndex
    ? { ...row, outcome: row.outcome === "Up" ? "Down" as const : "Up" as const }
    : row);
  const changed = evaluateWaterxRows(5, changedTestLabels);
  assert.deepEqual(changed.trainingMetrics, baseline.trainingMetrics);
  assert.notEqual(changed.testMetrics?.brier, baseline.testMetrics?.brier);
  assert.equal(changed.promotedForecast, null);
  assert.equal(changed.action, null);
});

test("delayed app label discovery is embargoed from training even when provider settlement was early", () => {
  const rows = history(5, 650);
  const testStartMs = rows[Math.floor(rows.length * 0.7)].startMs;
  const delayedIndex = Math.floor(rows.length * 0.7) - 3;
  const delayed = rows[delayedIndex];
  assert.ok(delayed.settledAt! <= testStartMs - 5 * 60_000);
  const baseline = evaluateWaterxRows(5, rows);
  assert.ok(baseline.split.trainingCount > 0);
  assert.ok(baseline.split.trainingObservedThrough);

  rows[delayedIndex] = { ...delayed, labelAvailableMs: testStartMs + 1 };
  const delayedResult = evaluateWaterxRows(5, rows);
  assert.ok(delayedResult.split.embargoExcludedCount > baseline.split.embargoExcludedCount);
  assert.ok(!delayedResult.trainingMetrics ||
    delayedResult.trainingMetrics.count < baseline.trainingMetrics!.count);
});

test("first accepted app-observed label time stays fixed across later settlement retries", () => {
  const firstAcceptedAt = Date.UTC(2025, 0, 2);
  assert.equal(firstAcceptedWaterxLabelAvailableMs(null, false, firstAcceptedAt - 5_000), null);
  const frozen = firstAcceptedWaterxLabelAvailableMs(null, true, firstAcceptedAt);
  assert.equal(frozen, firstAcceptedAt);
  assert.equal(firstAcceptedWaterxLabelAvailableMs(frozen, true, firstAcceptedAt + 30_000),
    firstAcceptedAt);
});

test("unverified or incomplete settlements never become scored labels", () => {
  const rows = history(5, 10);
  rows[0] = { ...rows[0], outcome: null, labelStatus: "withheld",
    withheldReason: "resolutionStatus is missing" };
  rows[1] = { ...rows[1], outcome: "Down", labelStatus: "withheld",
    withheldReason: "provider outcome contradicts prices" };
  const result = evaluateWaterxRows(5, rows);
  assert.equal(result.readiness.eligibleRounds, 8);
  assert.equal(result.trainingMetrics?.count, 3);
  assert.equal(result.testMetrics?.count, 3);
});

test("pending settlement retries include only observed expired unresolved or withheld rounds", () => {
  const now = 2_000_000;
  assert.equal(isWaterxSettlementPending({
    expiryMs: now - 1, labelStatus: "unresolved", outcome: null,
  }, now), true);
  assert.equal(isWaterxSettlementPending({
    expiryMs: now - 1, labelStatus: "withheld", outcome: null,
  }, now), true);
  assert.equal(isWaterxSettlementPending({
    expiryMs: now - 1, labelStatus: "unresolved", outcome: null,
    lastAttemptAtMs: now - 29_999,
  }, now), false);
  assert.equal(isWaterxSettlementPending({
    expiryMs: now - 1, labelStatus: "unresolved", outcome: null,
    lastAttemptAtMs: now - 30_000,
  }, now), true);
  assert.equal(isWaterxSettlementPending({
    expiryMs: now + 1, labelStatus: "unresolved", outcome: null,
  }, now), false);
  assert.equal(isWaterxSettlementPending({
    expiryMs: now - 1, labelStatus: "verified", outcome: "Up",
  }, now), false);
  assert.equal(isWaterxSettlementPending({
    expiryMs: now - 1, labelStatus: "withheld", outcome: "Down",
  }, now), false);
});

test("settlement retry result is false for missing/withheld rows and true only for verified rows", () => {
  assert.equal(waterxSettlementResult(false, false), false);
  assert.equal(waterxSettlementResult(true, false), false);
  assert.equal(waterxSettlementResult(true, true), true);
  assert.equal(waterxSettlementResult(false, true), false);
});

test("identical provider settlements are idempotent while contradictory revisions are quarantinable", () => {
  const first = settlement();
  const priorEvidence = {
    resolutionStatus: "resolved",
    anchorPrice: first.anchorPrice,
    anchorConfirmed: first.anchorConfirmed,
    settlePrice: first.settlePrice,
    outcome: first.outcome,
    settledAt: first.settledAt,
  };
  assert.equal(waterxSettlementRevision(priorEvidence, {
    ...first, observedAt: new Date(1_000_100).toISOString(),
  }), "same");
  assert.equal(waterxSettlementRevision(priorEvidence, {
    ...first, outcome: "Down",
  }), "contradictory");
  assert.equal(waterxSettlementRevision(priorEvidence, {
    ...first, resolutionStatus: "pending",
  }), "not-comparable");
});

test("rejected settlement evidence can be corrected without being treated as a revision", () => {
  const rejected = settlement({ outcome: "Down" });
  const stored = {
    expiry_ms: 1_000_000,
    anchor_price: 100,
    anchor_confirmed: false,
    outcome: null,
    settlement_evidence: {
      resolutionStatus: "resolved",
      anchorPrice: 100,
      anchorConfirmed: true,
      settlePrice: 100,
      outcome: "Down",
      settledAt: 1_000_001,
    },
  };
  assert.equal(waterxSettlementDecision(rejected, stored).kind, "rejected");
  assert.equal(waterxSettlementDecision(settlement(), stored).kind, "accept");
});

test("a valid conflicting revision disputes but does not replace or train on the accepted label", () => {
  const accepted = settlement();
  const stored = {
    expiry_ms: 1_000_000,
    anchor_price: 100,
    anchor_confirmed: true,
    settlement_anchor_price: 100,
    settle_price: 100,
    outcome: "Up",
    settled_at: accepted.settledAt,
    settlement_evidence: {
      resolutionStatus: "resolved",
      anchorPrice: 100,
      anchorConfirmed: true,
      settlePrice: 100,
      outcome: "Up",
      settledAt: accepted.settledAt,
    },
  };
  assert.equal(waterxSettlementDecision(settlement({
    settlePrice: 99, outcome: "Down", settledAt: 1_000_003,
    observedAt: new Date(1_000_004).toISOString(),
  }), stored).kind, "disputed");
  assert.equal(waterxSettlementDecision(settlement({
    settlePrice: 101, outcome: "Down", settledAt: 1_000_003,
    observedAt: new Date(1_000_004).toISOString(),
  }), stored).kind, "rejected");
  assert.equal(stored.outcome, "Up");

  const rows = history(5, 10);
  rows[0] = { ...rows[0], outcome: "Up", labelStatus: "disputed",
    withheldReason: "Valid provider revision conflicts with the accepted label." };
  const result = evaluateWaterxRows(5, rows);
  assert.equal(result.readiness.eligibleRounds, 9);
});

test("pending responses do not count as first settlement observation", () => {
  assert.equal(isWaterxSettlementObservation(settlement({
    resolutionStatus: "pending", settledAt: null,
  })), false);
  assert.equal(isWaterxSettlementObservation(settlement({
    resolutionStatus: "resolved", settledAt: null,
  })), true);
  assert.equal(isWaterxSettlementObservation(settlement({
    resolutionStatus: "pending", settledAt: 1_000_001,
  })), true);
});

test("round persistence validates whole-second timestamps and exact interval duration", async () => {
  const input = {
    intervalMinutes: 5 as const,
    roundId: "validated-round",
    startMs: 1_800_000_000_000,
    expiryMs: 1_800_000_300_000,
    anchorPrice: 100,
    anchorConfirmed: true,
    probabilityUp: 0.5,
    observedAt: new Date(1_800_000_001_000).toISOString(),
    source: "WaterX" as const,
  };
  await assert.rejects(recordWaterxRound({ ...input, startMs: input.startMs + 1 }), /timestamps/);
  await assert.rejects(recordWaterxRound({ ...input, expiryMs: input.expiryMs + 1_000 }), /timestamps/);
});