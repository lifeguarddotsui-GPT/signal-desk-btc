import assert from "node:assert/strict";
import test from "node:test";
import {
  auditWaterxValueCohort, binaryValue, wilson95,
  type ValueEvidenceRow, type VerifiableQuote,
} from "../shared/waterx-ev-evidence";

const start = Date.UTC(2026, 9, 25, 12, 0, 0);
const quote = (roundKey: string, overrides: Partial<VerifiableQuote> = {}): VerifiableQuote => ({
  roundKey, quoteId: "certified-round-quote", kind: "EXECUTABLE",
  quotedAtMs: start + 89_000, expiresAtMs: start + 110_000,
  allInCostUsd: 5, grossWinningReceiptUsd: 6.5, winningReceiptFeesUsd: 0,
  grossLosingReceiptUsd: 0, losingReceiptFeesUsd: 0,
  networkCostUsd: 0, feesVerified: true, receiptVerified: true,
  ...overrides,
});
function record(n: number, patch: Partial<ValueEvidenceRow> = {}): ValueEvidenceRow {
  const roundStart = start + n * 300_000;
  const key = `BTC:5:${roundStart}`;
  return {
    roundKey: key, intervalMinutes: 5, startMs: roundStart,
    expiryMs: roundStart + 300_000, decisionAtMs: roundStart + 90_000,
    decision: "UP", modelProbabilityForDecision: .85, independentModel: true,
    quote: quote(key, { quotedAtMs: roundStart + 89_000, expiresAtMs: roundStart + 110_000 }),
    settlement: { outcome: "UP", source: "WATERX_VERIFIED", disputed: false,
      observedAtMs: roundStart + 300_100 },
    ...patch,
  };
}

test("the $5 lesson illustrates only $0.10 EV after a separate $0.10 cost", () => {
  const q = quote("illustration", { networkCostUsd: .10 });
  const value = binaryValue(q, .8)!;
  assert.ok(Math.abs(value.breakEvenProbability - 5.1 / 6.5) < 1e-10);
  assert.ok(Math.abs(value.expectedNetUsd - .1) < 1e-10);
  assert.ok(Math.abs(value.winNetProfitUsd - 1.4) < 1e-10);
  assert.ok(Math.abs(value.lossNetProfitUsd + 5.1) < 1e-10);
});

test("all-in quote and receipt deductions are counted exactly once", () => {
  const v = binaryValue(quote("fee", {
    allInCostUsd: 5, networkCostUsd: 0, grossWinningReceiptUsd: 6.75,
    winningReceiptFeesUsd: .25, grossLosingReceiptUsd: 1,
    losingReceiptFeesUsd: .1,
  }), .8)!;
  assert.equal(v.winNetProfitUsd, 1.5);
  assert.equal(v.lossNetProfitUsd, -4.1);
  assert.ok(Math.abs(v.breakEvenProbability - 4.1 / 5.6) < 1e-12);
  assert.ok(Math.abs(v.expectedNetUsd - (.8 * 1.5 - .2 * 4.1)) < 1e-12);
});

test("unknown network costs, unverified fees, and impossible quotes are withheld", () => {
  assert.equal(binaryValue(quote("gas", { networkCostUsd: null }), .9), null);
  assert.equal(binaryValue(quote("fee", { feesVerified: false }), .9), null);
  assert.equal(binaryValue(quote("receipt", { receiptVerified: false }), .9), null);
  assert.equal(binaryValue(quote("bad", { winningReceiptFeesUsd: 7 }), .9), null);
  assert.equal(binaryValue(quote("cost", { allInCostUsd: -1 }), .9), null);
  assert.equal(binaryValue(quote("normal"), Number.NaN), null);
});

test("two-sided Wilson interval declines to assert sample certainty", () => {
  const a = wilson95(80, 100)!;
  const b = wilson95(240, 300)!;
  assert.ok(a.lower < .8 && a.upper > .8);
  assert.ok(b.lower > a.lower);
  assert.equal(wilson95(5, 3), null);
  assert.equal(wilson95(0, 0), null);
});

test("correctly matched, settled, quote-backed signals produce descriptive outcomes only", () => {
  const rows = [record(0), record(1, {
    settlement: { outcome: "DOWN", source: "WATERX_VERIFIED", disputed: false,
      observedAtMs: start + 600_100 },
  }), record(2, { decision: "NO_TRADE", modelProbabilityForDecision: null, quote: null, settlement: null })];
  const audit = auditWaterxValueCohort(rows);
  assert.equal(audit.verdict, "NO_TRADE_RESEARCH_ONLY");
  assert.equal(audit.captured, 3);
  assert.equal(audit.noTradeCaptured, 1);
  assert.equal(audit.signaled, 2);
  assert.equal(audit.matchedVerifiedQuoteAndOutcome, 2);
  assert.equal(audit.wins, 1);
  assert.equal(audit.losses, 1);
  assert.equal(audit.quoteMatchedCounterfactualNetUsd, -3.5);
  assert.ok(audit.reasons.some(x => /counterfactual/.test(x)));
});

test("missing quote, provisional settlement, and market-baseline-only probability remain in capture totals", () => {
  const rows = [
    record(0, { quote: null }),
    record(1, { independentModel: false }),
    record(2, { settlement: { outcome: "UP", source: "UNVERIFIED", disputed: false,
      observedAtMs: start + 900_100 } }),
    record(3),
  ];
  const a = auditWaterxValueCohort(rows);
  assert.equal(a.signaled, 4);
  assert.equal(a.matchedVerifiedQuoteAndOutcome, 1);
  assert.equal(a.missingOrInvalidEvidence, 3);
  assert.equal(a.verdict, "NO_TRADE_RESEARCH_ONLY");
});

test("wrong-round, stale, indicative, and unfillable quotes cannot manufacture EV", () => {
  const bad = [
    record(0, { quote: quote("different", { quotedAtMs: start + 89_000 }) }),
    record(1, { quote: quote(`BTC:5:${start + 300_000}`, {
      kind: "INDICATIVE", quotedAtMs: start + 389_000, expiresAtMs: start + 410_000 }) }),
    record(2, { quote: quote(`BTC:5:${start + 600_000}`, {
      quotedAtMs: start + 670_000, expiresAtMs: start + 710_000 }) }),
  ];
  const a = auditWaterxValueCohort(bad);
  assert.equal(a.matchedVerifiedQuoteAndOutcome, 0);
  assert.equal(a.quoteMatchedCounterfactualNetUsd, null);
});

test("duplicate round identifiers are excluded and clearly flagged", () => {
  const a = auditWaterxValueCohort([record(0), record(0)]);
  assert.equal(a.duplicateRoundKeys, 1);
  assert.equal(a.matchedVerifiedQuoteAndOutcome, 1);
  assert.ok(a.reasons.some(x => /Duplicate/.test(x)));
});

test("model EV can be positive despite losing a quoted hypothetical trade", () => {
  const a = auditWaterxValueCohort([record(0, {
    modelProbabilityForDecision: .9,
    settlement: { outcome: "DOWN", source: "WATERX_VERIFIED", disputed: false,
      observedAtMs: start + 300_100 },
  })]);
  assert.equal(a.quoteMatchedCounterfactualNetUsd, -5);
  assert.ok(a.meanModelExpectedNetUsd! > 0);
  assert.equal(a.wins, 0);
  assert.equal(a.verdict, "NO_TRADE_RESEARCH_ONLY");
});
