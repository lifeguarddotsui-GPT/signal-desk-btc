import test from "node:test";
import assert from "node:assert/strict";
import { classifySettlement, primaryDecisionWindow, probabilityLoss } from "../server/btc/policy";

test("strict price comparison keeps equality and missing reference out of DOWN", () => {
  assert.deepEqual(classifySettlement(101,100),{outcome:"UP",quality:"VERIFIED_SETTLEMENT"});
  assert.deepEqual(classifySettlement(99,100),{outcome:"DOWN",quality:"VERIFIED_SETTLEMENT"});
  assert.deepEqual(classifySettlement(100,100),{outcome:"UNKNOWN",quality:"EQUALITY_RULE_UNVERIFIED"});
  assert.deepEqual(classifySettlement(100,null),{outcome:"UNKNOWN",quality:"MISSING_REFERENCE"});
  assert.throws(()=>classifySettlement(NaN,100));
});

test("probability scoring uses the forecast probability and clips log loss at the SQL floor", () => {
  assert.deepEqual(probabilityLoss(0.8, "UP"), {
    brier: 0.03999999999999998,
    logLoss: -Math.log(0.8),
  });
  assert.deepEqual(probabilityLoss(0.8, "DOWN"), {
    brier: 0.6400000000000001,
    logLoss: -Math.log(0.19999999999999996),
  });
  assert.equal(probabilityLoss(1, "DOWN").logLoss, -Math.log(1e-9));
  assert.throws(() => probabilityLoss(1.01, "UP"), /between zero and one/);
});

test("the fixed primary window excludes late, future, and clock-skewed captures", () => {
  const expiry = 1_800_000_000_000;
  assert.equal(primaryDecisionWindow(expiry-45_000,expiry),true);
  assert.equal(primaryDecisionWindow(expiry-30_000,expiry),true);
  assert.equal(primaryDecisionWindow(expiry-29_999,expiry),false);
  assert.equal(primaryDecisionWindow(expiry+1,expiry),false);
  assert.equal(primaryDecisionWindow(expiry-120_000,expiry),false);
  assert.equal(primaryDecisionWindow(NaN,expiry),false);
});