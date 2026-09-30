import assert from "node:assert/strict";
import test from "node:test";
import { buildWaterxAdvisory, calculateVerifiedBinaryNet } from "../server/waterx/advisory";
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
  assert.ok(result.reasonCodes.includes("MODEL_UNQUALIFIED"));
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
  assert.equal(wrongSource.state, "UNAVAILABLE");
  assert.equal(wrongSource.sides.up.quote.priceCents, null);

  const oldQuote = buildWaterxAdvisory({
    ...fresh, odds: { ...fresh.odds!, asOf: new Date(now - 25_000).toISOString() },
  }, 5, 5, now);
  assert.equal(oldQuote.state, "UNAVAILABLE");
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