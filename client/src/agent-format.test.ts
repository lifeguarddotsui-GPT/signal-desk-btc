import test from "node:test";
import assert from "node:assert/strict";
import { defaultAgentPolicy, policySummary } from "../../shared/agent-policy";
import { agentDate, agentMoney, changePolicyLimitMode, copyPolicy, policyAmountInputValue, policyValueFromInput } from "./agent-format";

test("agent display helpers withhold unknown balances and timestamps", () => {
  assert.equal(agentMoney(null), "Not reported");
  assert.equal(agentMoney(0), "$0.00");
  assert.equal(agentMoney(27341), "$273.41");
  assert.equal(agentDate(null), "Not reported");
});

test("policy preview copies nested values and summarizes every-round and reserve boundaries", () => {
  const original = copyPolicy({ ...defaultAgentPolicy, intervals: [5] });
  const adjusted = copyPolicy({ ...original, frequency: "EVERY_ELIGIBLE_ROUND", edgeEnabled: false, reserveCents: 0 });
  adjusted.intervals.push(15);
  adjusted.dailyLoss!.value = 125;
  assert.deepEqual(original.intervals, [5]);
  assert.equal(original.dailyLoss?.value, 400);
  const summary = policySummary(adjusted);
  assert.ok(summary.some(item => item.includes("Every eligible BTC 5/15m")));
  assert.ok(summary.some(item => item.includes("Edge filter disabled")));
  assert.ok(summary.some(item => item.includes("all available capital may be committed")));
  assert.ok(summary.some(item => item.includes("Auto claim OFF")));
});

test("amount-valued policy controls display dollars but persist integer cents", () => {
  assert.equal(policyAmountInputValue("AMOUNT", 400), 4);
  assert.equal(policyValueFromInput("AMOUNT", "4.25"), 425);
  assert.equal(policyAmountInputValue("PERCENT", 4.25), 4.25);
  assert.equal(policyValueFromInput("PERCENT", "4.25"), 4.25);
  assert.equal(changePolicyLimitMode("AMOUNT", "PERCENT", 400), 4);
  assert.equal(changePolicyLimitMode("PERCENT", "AMOUNT", 4), 400);
});