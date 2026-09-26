import test from "node:test";
import assert from "node:assert/strict";
import { classifySettlement, primaryDecisionWindow } from "../server/btc/policy";

test("strict price comparison keeps equality and missing reference out of DOWN", () => {
  assert.deepEqual(classifySettlement(101,100),{outcome:"UP",quality:"VERIFIED_SETTLEMENT"});
  assert.deepEqual(classifySettlement(99,100),{outcome:"DOWN",quality:"VERIFIED_SETTLEMENT"});
  assert.deepEqual(classifySettlement(100,100),{outcome:"UNKNOWN",quality:"EQUALITY_RULE_UNVERIFIED"});
  assert.deepEqual(classifySettlement(100,null),{outcome:"UNKNOWN",quality:"MISSING_REFERENCE"});
  assert.throws(()=>classifySettlement(NaN,100));
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