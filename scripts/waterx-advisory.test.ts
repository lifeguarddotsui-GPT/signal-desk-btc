import assert from "node:assert/strict";
import test from "node:test";
import {
  assessWaterxEvidence, assessWaterxEvidenceWithHysteresis, buildWaterxAdvisory,
  calculateVerifiedBinaryNet, type WaterxEvidence,
} from "../server/waterx/advisory";
import { buildWaterxLivePayload } from "../server/waterx/service";
import type { WaterxInterval, WaterxRound } from "../server/waterx/types";

const start = 1_800_000_000;
const at = (seconds: number) => seconds * 1000;
function observed(interval: WaterxInterval, changes: Partial<WaterxRound> = {}, now = at(start + 10)) {
  const round: WaterxRound = {
    id: `round-${interval}`, marketId: `market-${interval}`,
    slug: `crypto-btc-updown-${interval}m`,
    startsAt: start, endsAt: start + interval * 60,
    phase: "active", anchorPrice: 80000, anchorPriceConfirmed: true,
    referenceUnavailableReason: null,
    sides: {
      up: { oddsCents: 40, probabilityCents: 60, availability: "reported", reason: null },
      down: { oddsCents: 65, probabilityCents: 40, availability: "reported", reason: null },
    },
    settlement: null, settlePrice: null, resolutionStatus: null,
    ...changes,
  };
  return buildWaterxLivePayload(interval, {
    observedAt: new Date(now - 1000).toISOString(),
    status: "LIVE", round, reason: "Active", sourceError: null,
  }, now, null);
}

test("a $5 spend uses side-specific indicative binary arithmetic without inventing fees or expected net value", () => {
  const live = observed(5);
  const result = buildWaterxAdvisory(live, 5, 5, at(start + 10));
  assert.equal(result.state, "OBSERVE");
  assert.equal(result.identity?.roundId, "round-5");
  assert.equal(result.identity?.marketId, "market-5");
  assert.equal(result.sides.up.quote.grossReceiptIfWinIndicative, 12.5);
  assert.equal(result.sides.down.quote.grossReceiptIfWinIndicative, 5 / .65);
  assert.equal(result.sides.up.quote.breakEvenProbabilityBeforeFeesIndicative, .4);
  assert.equal(result.sides.up.marketProbability, .6);
  assert.equal(result.sides.up.calibratedProbability, null);
  assert.equal(result.sides.up.quote.estimatedExpectedNetValue, null);
  assert.equal(result.sides.up.quote.estimatedTotalCost, null);
  assert.equal(result.sides.up.quote.netProfitIfWin, null);
  assert.equal(result.sides.up.quote.executable, false);
  assert.ok(result.reasonCodes.includes("FEES_UNVERIFIED"));
  assert.ok(result.reasonCodes.includes("MODEL_NOT_PROMOTED"));
});

test("one valid quote stays available without a reference; missing probabilities never become forecasts", () => {
  const live = observed(15, {
    anchorPrice: null, anchorPriceConfirmed: false,
    sides: {
      up: { oddsCents: 25, probabilityCents: null, availability: "reported", reason: null },
      down: { oddsCents: null, probabilityCents: null, availability: "unavailable", reason: null },
    },
  });
  const result = buildWaterxAdvisory(live, 15, 5, at(start + 10));
  assert.equal(result.state, "OBSERVE");
  assert.equal(result.reference.price, null);
  assert.equal(result.sides.up.quote.grossReceiptIfWinIndicative, 20);
  assert.equal(result.sides.up.marketProbability, null);
  assert.equal(result.sides.down.quote.grossReceiptIfWinIndicative, null);
  assert.match(result.sides.down.reason, /probabilities missing/i);
});

test("expired, stale, mismatched, out-of-window and locked inputs immediately withhold both quotes", () => {
  const now = at(start + 10);
  const fresh = observed(5);
  const wrongInterval = buildWaterxAdvisory(fresh, 15, 5, now);
  assert.equal(wrongInterval.state, "UNAVAILABLE");
  assert.equal(wrongInterval.identity, null);
  assert.equal(wrongInterval.sides.up.quote.priceCents, null);

  const wrongSource = buildWaterxAdvisory({
    ...fresh, odds: { ...fresh.odds!, source: "Coinbase" },
  }, 5, 5, now);
  assert.equal(wrongSource.state, "OBSERVE");
  assert.equal(wrongSource.sides.up.quote.priceCents, null);

  const oldQuote = buildWaterxAdvisory({
    ...fresh, odds: { ...fresh.odds!, asOf: new Date(now - 25_000).toISOString(),
      priceAsOf: new Date(now-25_000).toISOString() },
  }, 5, 5, now);
  assert.equal(oldQuote.state, "OBSERVE");
  assert.ok(oldQuote.reasonCodes.includes("QUOTE_EXPIRED_OR_MISMATCHED"));

  const locked = observed(5, { sides: {
    up: { oddsCents: 40, probabilityCents: 60, availability: "locked", reason: null },
    down: { oddsCents: 65, probabilityCents: 40, availability: "locked", reason: null },
  } });
  assert.equal(buildWaterxAdvisory(locked, 5, 5, now).state, "LOCKED");
  assert.equal(buildWaterxAdvisory(locked, 5, 5, now).sides.up.quote.priceCents, null);

  const expired = observed(5, {}, at(start + 300));
  assert.equal(buildWaterxAdvisory(expired, 5, 5, at(start + 300)).state, "EXPIRED");
  assert.equal(buildWaterxAdvisory(expired, 5, 5, at(start + 300)).identity, null);
});

test("an invalid budget is rejected, never rounded into an apparently executable quote", () => {
  for (const amount of [0, -5, NaN, Infinity, 10_001]) {
    assert.throws(() => buildWaterxAdvisory(observed(5), 5, amount));
  }
});

test("even a 99% market-derived probability cannot activate a favorable entry without a qualified model and executable economics", () => {
  const live = observed(5, { sides: {
    up: { oddsCents: 99, probabilityCents: 99, availability: "reported", reason: null },
    down: { oddsCents: 1, probabilityCents: 1, availability: "reported", reason: null },
  } });
  const result = buildWaterxAdvisory(live, 5, 5, at(start + 10));
  assert.equal(result.sides.up.marketProbability, .99);
  assert.equal(result.state, "OBSERVE");
  assert.equal(result.sides.up.quote.estimatedExpectedNetValue, null);
  assert.equal(result.tradingCutoffMs, null);
  assert.equal(result.action, "HOLD");
});

test("verified binary economics include entry cost and exit deductions exactly once", () => {
  // Hypothetical verified values only: $5 budget + $0.20 entry fee,
  // $12.50 gross winning receipt - $0.25 exit deduction.
  const result = calculateVerifiedBinaryNet(.6, 12.25, 5.2);
  assert.ok(Math.abs(result.expectedNet - 2.15) < 1e-12);
  assert.equal(result.breakEvenProbability, 5.2 / 12.25);
  assert.equal(result.netProfitIfWin, 7.05);
  assert.equal(result.lossIfUnsuccessful, 5.2);
  assert.throws(() => calculateVerifiedBinaryNet(.6, 0, 5));
  assert.throws(() => calculateVerifiedBinaryNet(1.1, 10, 5));
});

const hypotheticalEvidence = (): WaterxEvidence => ({
  identity: { marketId: "m", roundId: "r", intervalMinutes: 5, startMs: at(start), expiryMs: at(start + 300) },
  side: "up",
  reference: {
    marketId: "m", roundId: "r", intervalMinutes: 5, startMs: at(start), expiryMs: at(start + 300),
    sourceName: "WaterX confirmed round reference", confirmed: true, price: 80_000, observedAtMs: at(start + 9),
  },
  quote: {
    kind: "accurate-simulation", amountUsd: 5, allInCostUsd: 5,
    grossWinningReceiptUsd: 12, winningFeesUsd: .2,
    losingGrossReceiptUsd: .1, losingFeesUsd: .1,
    feesIncluded: true, minimumsIncluded: true, priceImpactIncluded: true, receiptVerified: true,
    simulationVerified: true,
    quoteId: "hypothetical-test-only", quotedAtMs: at(start + 9), expiresAtMs: at(start + 20),
    synthetic: true,
  },
  model: {
    marketId: "m", roundId: "r", intervalMinutes: 5, side: "up",
    policyId: "waterx-value-policy-v1", policyEligibilityEnabled: true,
    status: "promoted", independent: true, heldoutForwardAccepted: true,
    version: "hypothetical-test-only", evidenceId: "hypothetical-test-only", qualifiedSampleCount: 120,
    calibratedProbability: .75, lowerBoundProbability: .7, uncertaintyMargin: .05,
    calibration: { method: "test-only", lowerBoundMethod: "test-only", verified: true },
    probabilityAtMs: at(start + 9.5),
  },
  timing: {
    cutoffVerified: true, cutoffSource: "test-only", cutoffAtMs: at(start + 250),
    measuredAtMs: at(start + 10), requiredBufferMs: 10_000,
  },
  fixture: true,
});

test("only hypothetical test proof can pass the conservative server-side $5 policy", () => {
  const evidence = hypotheticalEvidence();
  const expected = evidence.identity;
  const now = at(start + 10);
  const pass = assessWaterxEvidence(evidence, expected, now, true);
  assert.equal(pass.state, "FAVORABLE_RISK_REWARD");
  assert.equal(pass.economics?.totalCostUsd, 5);
  assert.equal(pass.economics?.grossReceiptIfWinUsd, 12);
  assert.equal(pass.economics?.netReceiptIfWinUsd, 11.8);
  assert.ok(Math.abs(pass.economics!.netProfitIfWinUsd - 6.8) < 1e-12);
  assert.ok(pass.economics!.conservativeExpectedNetUsd > pass.economics!.expectedNetUncertaintyUsd);
  assert.equal(assessWaterxEvidence(evidence, expected, now, false).state, "OBSERVE");
  const nonsynthetic = {
    ...evidence, fixture: false,
    quote: { ...evidence.quote, synthetic: false },
  };
  assert.equal(assessWaterxEvidence(nonsynthetic, expected, now, false).state, "OBSERVE",
    "experimental unvalidated thresholds must not qualify live opportunities");
});

test("the shared experimental policy distinguishes high likelihood from favorable risk/reward", () => {
  const evidence: WaterxEvidence = {
    ...hypotheticalEvidence(),
    quote: { ...hypotheticalEvidence().quote, grossWinningReceiptUsd: 8.2 },
    model: { ...hypotheticalEvidence().model, calibratedProbability: .9, lowerBoundProbability: .85 },
  };
  const result = assessWaterxEvidence(evidence, evidence.identity, at(start + 10), true);
  assert.equal(result.state, "HIGH_LIKELIHOOD");
  assert.ok(result.economics!.conservativeExpectedNetUsd > 0);
});

test("shadow models, forged cost flags, mismatched rounds and stale cutoffs remain neutral", () => {
  const evidence = hypotheticalEvidence();
  const expected = evidence.identity;
  const now = at(start + 10);
  for (const invalid of [
    { ...evidence, model: { ...evidence.model, status: "shadow" as const } },
    { ...evidence, quote: { ...evidence.quote, allInCostUsd: 4.99 } },
    { ...evidence, identity: { ...evidence.identity, roundId: "other" } },
    { ...evidence, timing: { ...evidence.timing, cutoffAtMs: now } },
    { ...evidence, timing: { ...evidence.timing, cutoffAtMs: now + 9_999 } },
    { ...evidence, model: { ...evidence.model, qualifiedSampleCount: 20 } },
    { ...evidence, reference: { ...evidence.reference, confirmed: false } },
    { ...evidence, reference: { ...evidence.reference, roundId: "other" } },
  ]) assert.equal(assessWaterxEvidence(invalid, expected, now, true).state, "OBSERVE");
});

test("hysteresis softens only the positive-edge threshold and never rescues expired proof", () => {
  const evidence = hypotheticalEvidence();
  const expected = evidence.identity;
  const now = at(start + 10);
  assert.equal(assessWaterxEvidenceWithHysteresis(evidence, expected, now, true).state, "FAVORABLE_RISK_REWARD");
  const borderline: WaterxEvidence = {
    ...evidence,
    quote: { ...evidence.quote, grossWinningReceiptUsd: 10.28 },
    model: { ...evidence.model, calibratedProbability: .6, lowerBoundProbability: .55 },
  };
  assert.equal(assessWaterxEvidence(borderline, expected, now, true).state, "OBSERVE");
  assert.equal(assessWaterxEvidenceWithHysteresis(borderline, expected, now, true).state, "FAVORABLE_RISK_REWARD");
  assert.equal(assessWaterxEvidenceWithHysteresis(
    borderline, expected, now, true, "HIGH_LIKELIHOOD",
  ).state, "OBSERVE", "a mismatched claimed state cannot inherit a prior classification");
  const stale: WaterxEvidence = { ...borderline, quote: { ...borderline.quote, expiresAtMs: now } };
  assert.equal(assessWaterxEvidenceWithHysteresis(stale, expected, now, true).state, "OBSERVE");
  const referenceLost: WaterxEvidence = {
    ...borderline, reference: { ...borderline.reference, confirmed: false },
  };
  assert.equal(assessWaterxEvidenceWithHysteresis(referenceLost, expected, now, true).state, "OBSERVE");
});

test("a lower bound crossing a classification threshold cannot inherit the prior state", () => {
  const evidence = hypotheticalEvidence();
  const expected = evidence.identity;
  const now = at(start + 10);
  assert.equal(assessWaterxEvidenceWithHysteresis(evidence, expected, now, true).state, "FAVORABLE_RISK_REWARD");
  const belowRiskRewardThreshold: WaterxEvidence = {
    ...evidence, model: { ...evidence.model, calibratedProbability: .54, lowerBoundProbability: .49 },
  };
  assert.equal(assessWaterxEvidenceWithHysteresis(belowRiskRewardThreshold, expected, now, true).state, "OBSERVE");
});

test("hysteresis is market/interval isolated and a hard failure clears its previous entry", () => {
  const evidence = hypotheticalEvidence();
  const now = at(start + 10);
  assert.equal(assessWaterxEvidenceWithHysteresis(evidence, evidence.identity, now, true).state, "FAVORABLE_RISK_REWARD");
  const fifteenIdentity = { ...evidence.identity, intervalMinutes: 15, expiryMs: at(start + 900) };
  const fifteen: WaterxEvidence = {
    ...evidence, identity: fifteenIdentity,
    reference: { ...evidence.reference, ...fifteenIdentity },
    model: { ...evidence.model, intervalMinutes: 15 },
  };
  assert.equal(assessWaterxEvidenceWithHysteresis(fifteen, fifteen.identity, now, true).state, "FAVORABLE_RISK_REWARD");
  const borderline: WaterxEvidence = {
    ...evidence,
    quote: { ...evidence.quote, grossWinningReceiptUsd: 10.28 },
    model: { ...evidence.model, calibratedProbability: .6, lowerBoundProbability: .55 },
  };
  assert.equal(assessWaterxEvidenceWithHysteresis(borderline, borderline.identity, now, true).state, "FAVORABLE_RISK_REWARD");
  const otherMarket: WaterxEvidence = {
    ...borderline, identity: { ...borderline.identity, marketId: "other-market" },
    reference: { ...borderline.reference, marketId: "other-market" },
    model: { ...borderline.model, marketId: "other-market" },
  };
  assert.equal(assessWaterxEvidenceWithHysteresis(otherMarket, otherMarket.identity, now, true).state, "OBSERVE");
  assert.equal(assessWaterxEvidenceWithHysteresis({
    ...borderline, reference: { ...borderline.reference, confirmed: false },
  }, borderline.identity, now, true).state, "OBSERVE");
  assert.equal(assessWaterxEvidenceWithHysteresis(borderline, borderline.identity, now, true).state, "OBSERVE");
});