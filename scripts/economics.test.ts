import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PAYOUT_QUANTITY_USD,
  DEFAULT_SPEND_BUDGET_USD,
  MAX_SOURCE_TIMESTAMP_AGE_MS,
  classifyQuoteFailure,
  economicsFromMintQuote,
  quoteRoundEconomics,
  validateQuoteSourceFreshness,
} from "../server/btc/economics";

const quote = {
  quantity: BigInt(5_000_000),
  entry_probability: BigInt(500_000_000),
  premium: BigInt(2_500_000),
  trading_fee: BigInt(100_000),
  fee_incentive_subsidy: BigInt(20_000),
  builder_fee: BigInt(10_000),
  penalty_fee: BigInt(5_000),
  inventory_impact_charge: BigInt(2_000),
  all_in_cost: BigInt(2_597_000),
};

test("anonymous MintQuote accounting includes fee subsidy exactly once", () => {
  const result = economicsFromMintQuote(quote, "UP", 5);
  assert.equal(result.status, "AVAILABLE");
  assert.equal(result.quantity, 5);
  assert.equal(result.entryProbability, .5);
  assert.equal(result.premium, 2.5);
  assert.equal(result.netTradingFee, .08);
  assert.equal(result.feeIncentiveSubsidy, .02);
  assert.equal(result.allInCost, 2.597);
  assert.equal(result.grossWinningPayout, 5);
  assert.equal(result.winningNetBeforeNetworkCosts, 2.403);
  assert.equal(result.losingNetBeforeNetworkCosts, -2.597);
  assert.equal(result.breakEvenProbability, 2_597_000 / 5_000_000);
  assert.equal(result.networkCostsIncluded, false);
});

test("subsidy/refund accounting is applied once and retains gross fee detail", () => {
  const withNoSubsidy = economicsFromMintQuote({
    ...quote, fee_incentive_subsidy: BigInt(0), all_in_cost: BigInt(2_617_000),
  }, "UP", 5);
  const withSubsidy = economicsFromMintQuote(quote, "UP", 5);
  assert.equal(withNoSubsidy.fees.trading, .1);
  assert.equal(withSubsidy.fees.trading, .1);
  assert.equal(withSubsidy.feeIncentiveSubsidy, .02);
  assert.equal(withSubsidy.netTradingFee, .08);
  assert.ok(Math.abs((withNoSubsidy.allInCost - withSubsidy.allInCost) - .02) < 1e-12);
  assert.equal(withSubsidy.winningNetBeforeNetworkCosts + withSubsidy.allInCost, 5);
  assert.equal(withSubsidy.losingNetBeforeNetworkCosts, -withSubsidy.allInCost);
});

test("a $5 quote is explicitly a payout quantity, not a $5 spend cap", () => {
  const result = economicsFromMintQuote(quote, "DOWN", DEFAULT_PAYOUT_QUANTITY_USD);
  assert.equal(result.sizeMode, "PAYOUT_QUANTITY");
  assert.equal(result.requestedPayoutQuantity, 5);
  assert.equal(result.quantity, 5);
  assert.notEqual(result.allInCost, 5);
});

test("default sizing is a $5 all-in spend budget with integer-raw unspent accounting", () => {
  const result = economicsFromMintQuote(quote, "UP", {
    mode: "SPEND_BUDGET", spendBudget: DEFAULT_SPEND_BUDGET_USD,
  });
  assert.equal(result.sizeMode, "SPEND_BUDGET");
  assert.equal(result.requestedSpendBudget, 5);
  assert.equal(result.requestedPayoutQuantity, null);
  assert.equal(result.quantity, 5);
  assert.equal(result.allInCost, 2.597);
  assert.equal(result.unspentBudget, 2.403);
  assert.equal(result.winningNetBeforeNetworkCosts, 2.403);
  assert.deepEqual(result.networkGas, { status: "UNKNOWN", included: false });
});

test("budget quote fails closed when all-in debit exceeds budget or quantity is off lot", () => {
  assert.throws(() => economicsFromMintQuote({
    ...quote, all_in_cost: BigInt(5_000_001), premium: BigInt(4_903_001),
  }, "DOWN", { mode: "SPEND_BUDGET", spendBudget: 5 }), /exceeds the requested spend budget/);
  assert.throws(() => economicsFromMintQuote({
    ...quote, quantity: BigInt(5_005_000),
  }, "UP", { mode: "SPEND_BUDGET", spendBudget: 5 }, { allowOverBudgetProbe: true }), /position-lot grid/);
});

test("budget amounts accept USDC micro precision without floating fee arithmetic", () => {
  const result = economicsFromMintQuote({
    ...quote, premium: BigInt(2_501_001), all_in_cost: BigInt(2_598_001),
  }, "DOWN", { mode: "SPEND_BUDGET", spendBudget: 5.000001 });
  assert.equal(result.unspentBudget, 2.402);
  assert.equal(result.allInCost, 2.598001);
  assert.equal(result.winningNetBeforeNetworkCosts, 2.401999);
});

test("quote decomposition mismatch or a subsidy above the trading fee fails closed", () => {
  assert.throws(() => economicsFromMintQuote({ ...quote, all_in_cost: BigInt(2_596_999) }, "UP", 5),
    /decomposition/);
  assert.throws(() => economicsFromMintQuote({
    ...quote, fee_incentive_subsidy: BigInt(100_001), all_in_cost: BigInt(2_516_999),
  }, "UP", 5), /fee subsidy/);
});

test("economics reject changed quantity, invalid probability, and cost above payout", () => {
  assert.throws(() => economicsFromMintQuote({ ...quote, quantity: BigInt(4_990_000) }, "UP", 5),
    /different payout quantity/);
  assert.throws(() => economicsFromMintQuote({ ...quote, entry_probability: BigInt(1_000_000_001) }, "UP", 5),
    /invalid probability/);
  assert.throws(() => economicsFromMintQuote({
    ...quote, premium: BigInt(4_999_001), all_in_cost: BigInt(5_096_001),
  }, "UP", 5), /exceeds its gross payout/);
});

test("round mismatch, expiry, and late entry do not call or invent a quote", async () => {
  const now = 1_800_000_000_000;
  const base = { marketId: "0x" + "1".repeat(64), expiryMs: now + 60_000 };
  const invalid = await quoteRoundEconomics({ ...base, marketId: "bad" }, { now: () => now });
  assert.equal(invalid.status, "INVALID_REQUEST");
  assert.equal(invalid.up, null);
  const expired = await quoteRoundEconomics({ ...base, expiryMs: now - 1 }, { now: () => now });
  assert.equal(expired.status, "EXPIRED");
  const late = await quoteRoundEconomics({ ...base, expiryMs: now + 18_000 }, { now: () => now });
  assert.equal(late.status, "TOO_LATE");
  assert.equal(late.down, null);
  assert.equal(late.sizingMode, "SPEND_BUDGET");
  assert.equal(late.totalSpendBudget, 5);
  assert.deepEqual(late.unspentBudget, { up: null, down: null });
  const payout = await quoteRoundEconomics({
    ...base, sizing: { mode: "PAYOUT_QUANTITY", payoutQuantity: 5 },
  }, { now: () => now });
  assert.equal(payout.sizingMode, "PAYOUT_QUANTITY");
  assert.equal(payout.totalSpendBudget, null);
});

test("malformed input is distinct from on-chain admission and adapter failures", async () => {
  const now = 1_800_000_000_000;
  const invalid = await quoteRoundEconomics({
    marketId: "bad", expiryMs: now + 60_000, payoutQuantity: 0,
  }, { now: () => now });
  assert.equal(invalid.status, "INVALID_REQUEST");
  assert.match(invalid.reason ?? "", /market ID or round expiry/);
  assert.equal(invalid.up, null);
  const admission = classifyQuoteFailure({ abort_code: 77, message: "insufficient market capacity" }, true);
  assert.equal(admission.status, "ONCHAIN_REJECTED");
  assert.equal(admission.reason, "The market could not admit this quote right now.");
  assert.match(admission.technicalDetail, /capacity/);
  assert.doesNotMatch(admission.reason, /capacity|abort_code/);
  const adapter = classifyQuoteFailure(new Error("Malformed BCS MintQuote return value."));
  assert.equal(adapter.status, "ADAPTER_ERROR");
  assert.equal(adapter.reason, "Quote data could not be verified; no economics are shown.");
});

test("provider, stale-input, paused, and timing errors have distinct safe explanations", () => {
  assert.equal(classifyQuoteFailure(new Error("HTTP 429 too many requests")).status, "PROVIDER_ERROR");
  assert.equal(classifyQuoteFailure(new Error("oracle source timestamp stale")).status, "STALE_QUOTE");
  assert.equal(classifyQuoteFailure({ code: "MINT_PAUSED" }, true).status, "PAUSED_MARKET");
  assert.equal(classifyQuoteFailure(new Error("expiry window closed"), true).status, "TOO_LATE");
});

test("aged but well-formed oracle/reference timestamps withhold quote freshness", () => {
  const at = 1_800_000_000_000;
  const iso = (age: number) => new Date(at - age).toISOString();
  const freshOracleTimes = {
    pythSpot: iso(1_000),
    blockScholesSpot: iso(1_000),
    blockScholesForward: iso(1_000),
    blockScholesSvi: iso(1_000),
  };
  const timestampLabels = {
    pythSpot: "Pyth spot",
    blockScholesSpot: "Block Scholes spot",
    blockScholesForward: "Block Scholes forward",
    blockScholesSvi: "Block Scholes SVI",
  } as const;
  for (const key of Object.keys(timestampLabels) as (keyof typeof timestampLabels)[]) {
    const result = validateQuoteSourceFreshness({
      ...freshOracleTimes, [key]: iso(MAX_SOURCE_TIMESTAMP_AGE_MS + 1),
    }, iso(1_000), at);
    assert.equal(result.fresh, false, `${key} must be fresh`);
    assert.match(result.reason ?? "", /stale/);
    assert.match(result.technicalDetail ?? "", new RegExp(timestampLabels[key]));
  }

  const staleReference = validateQuoteSourceFreshness(freshOracleTimes,
    iso(MAX_SOURCE_TIMESTAMP_AGE_MS + 1), at);
  assert.equal(staleReference.fresh, false);
  assert.match(staleReference.technicalDetail ?? "", /reference source timestamp/);
  const freshAtBoundary = validateQuoteSourceFreshness({
    ...freshOracleTimes, blockScholesSvi: iso(MAX_SOURCE_TIMESTAMP_AGE_MS),
  }, iso(MAX_SOURCE_TIMESTAMP_AGE_MS), at);
  assert.equal(freshAtBoundary.fresh, true);
});

test("missing, malformed, and future source times cannot claim verified freshness", () => {
  const at = 1_800_000_000_000;
  const sourceAt = new Date(at - 1_000).toISOString();
  const oracleTimes = {
    pythSpot: null,
    blockScholesSpot: sourceAt,
    blockScholesForward: sourceAt,
    blockScholesSvi: sourceAt,
  };
  assert.match(validateQuoteSourceFreshness(oracleTimes, null, at).reason ?? "", /could not be verified/);
  assert.match(validateQuoteSourceFreshness({
    ...oracleTimes, blockScholesForward: "not-a-timestamp",
  }, sourceAt, at).reason ?? "", /could not be verified/);
  assert.match(validateQuoteSourceFreshness({
    ...oracleTimes, pythSpot: new Date(at + 3_000).toISOString(),
  }, sourceAt, at).reason ?? "", /could not be verified/);
  assert.equal(validateQuoteSourceFreshness(oracleTimes, sourceAt, at).fresh, true);
});