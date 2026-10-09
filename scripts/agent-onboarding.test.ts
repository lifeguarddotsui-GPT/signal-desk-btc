import test from "node:test";
import assert from "node:assert/strict";
import { discoveredAccountSelection, selectFundingCoins, usdBalanceLabel } from "../shared/agent-onboarding";

test("discovery auto-selects exactly one account and preserves an owned saved selection", () => {
  assert.equal(discoveredAccountSelection(["a"], null), "a");
  assert.equal(discoveredAccountSelection(["a", "B"], "b"), "b");
  assert.equal(discoveredAccountSelection(["a", "b"], null), null);
  assert.equal(discoveredAccountSelection([], "a"), null);
  assert.equal(discoveredAccountSelection(["a", "b"], "unowned"), null);
});
test("reported settlement balances are exact even above the JS safe integer limit", () => {
  assert.equal(usdBalanceLabel("0"), "0.00");
  assert.equal(usdBalanceLabel("25000000"), "25.00");
  assert.equal(usdBalanceLabel("1009999"), "1.00");
  assert.equal(usdBalanceLabel("18446744073709551615"), "18446744073709.55");
  assert.throws(() => usdBalanceLabel("-1"));
  assert.throws(() => usdBalanceLabel("NaN"));
});
test("funding automatically chooses sufficient owned coins without floating point or IDs from the user", () => {
  const coins = [{ objectId: "small", balance: "5000000" }, { objectId: "large", balance: "20000000" }];
  assert.deepEqual(selectFundingCoins(coins, "25000000"), ["large", "small"]);
  assert.deepEqual(selectFundingCoins(coins, "10000000"), ["large"]);
  assert.throws(() => selectFundingCoins(coins, "30000000"), /Not enough/);
  assert.throws(() => selectFundingCoins(coins, "18446744073709551616"), /valid positive/);
});
test("funding rejects unowned, duplicate and malformed coin inputs and caps transaction inputs", () => {
  const coins = [{ objectId: "owned", balance: "10000000" }];
  assert.throws(() => selectFundingCoins(coins, "1", ["not-owned"]), /belong/);
  assert.throws(() => selectFundingCoins(coins, "1", ["owned", "owned"]), /belong/);
  assert.throws(() => selectFundingCoins([...coins, ...coins], "1"), /verified/);
  assert.throws(() => selectFundingCoins([{ objectId: "owned", balance: "1.5" }], "1"), /verified/);
  assert.throws(() => selectFundingCoins(Array.from({ length: 21 }, (_, i) => ({ objectId: `c${i}`, balance: "1" })), "21"), /Not enough/);
  assert.deepEqual(selectFundingCoins(coins, "1", ["owned"]), ["owned"]);
});
