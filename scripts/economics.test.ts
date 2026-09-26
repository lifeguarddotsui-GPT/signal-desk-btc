import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PAYOUT_QUANTITY_USD,
  economicsFromMintQuote,
  quoteRoundEconomics,
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
  assert.equal(result.allInCost, 2.597);
  assert.equal(result.grossWinningPayout, 5);
  assert.equal(result.winningNetBeforeNetworkCosts, 2.403);
  assert.equal(result.losingNetBeforeNetworkCosts, -2.597);
  assert.equal(result.breakEvenProbability, 2_597_000 / 5_000_000);
  assert.equal(result.networkCostsIncluded, false);
});

test("a $5 quote is explicitly a payout quantity, not a $5 spend cap", () => {
  const result = economicsFromMintQuote(quote, "DOWN", DEFAULT_PAYOUT_QUANTITY_USD);
  assert.equal(result.sizeMode, "PAYOUT_QUANTITY");
  assert.equal(result.requestedPayoutQuantity, 5);
  assert.equal(result.quantity, 5);
  assert.notEqual(result.allInCost, 5);
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
  assert.equal(invalid.status, "ROUND_MISMATCH");
  assert.equal(invalid.up, null);
  const expired = await quoteRoundEconomics({ ...base, expiryMs: now - 1 }, { now: () => now });
  assert.equal(expired.status, "EXPIRED");
  const late = await quoteRoundEconomics({ ...base, expiryMs: now + 18_000 }, { now: () => now });
  assert.equal(late.status, "TOO_LATE");
  assert.equal(late.down, null);
});