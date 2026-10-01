import assert from "node:assert/strict";
import test from "node:test";
import { quoteMatchesSizingMode } from "../client/src/economics-contract";

test("a retained quote is never shown under a different sizing selection", () => {
  const budget = { sizingMode: "SPEND_BUDGET", sizing: { mode: "SPEND_BUDGET" } };
  const payout = { sizingMode: "PAYOUT_QUANTITY", sizing: { mode: "PAYOUT_QUANTITY" } };
  assert.equal(quoteMatchesSizingMode(budget, "budget"), true);
  assert.equal(quoteMatchesSizingMode(budget, "payout"), false);
  assert.equal(quoteMatchesSizingMode(payout, "payout"), true);
  assert.equal(quoteMatchesSizingMode(payout, "budget"), false);
});

test("a delayed, malformed, or inconsistent quote fails closed", () => {
  assert.equal(quoteMatchesSizingMode(null, "budget"), false);
  assert.equal(quoteMatchesSizingMode({ sizing: { mode: "SPEND_BUDGET" } }, "budget"), false);
  assert.equal(quoteMatchesSizingMode({
    sizingMode: "SPEND_BUDGET", sizing: { mode: "PAYOUT_QUANTITY" },
  }, "budget"), false);
});