import test from "node:test";
import assert from "node:assert/strict";
import { defaultAgentPolicy, policySummary } from "../../shared/agent-policy";
import { agentDate, agentMoney, canStartGuidedShadow, changePolicyLimitMode, copyPolicy, dollarsToSafeCents, mistToSui, paperCapitalFromInput, policyAmountInputValue, policyValueFromInput, suiToMist, validateGuidedSession } from "./agent-format";

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

test("SUI decimal input converts exactly to safe integer MIST and rejects unsafe precision", () => {
  assert.equal(suiToMist("0"), 0);
  assert.equal(suiToMist("0.000000001"), 1);
  assert.equal(suiToMist("0.125000007"), 125_000_007);
  assert.equal(suiToMist("0.5"), 500_000_000);
  assert.equal(suiToMist("0.0000000001"), null);
  assert.equal(suiToMist("1e-3"), null);
  assert.equal(suiToMist("-1"), null);
  assert.equal(suiToMist("9007199.254740992"), null);
  assert.equal(mistToSui(125_000_007), "0.125000007");
  assert.equal(mistToSui(Number.MAX_SAFE_INTEGER + 1), "");
});

test("guided spend cap conversion accepts cents precision and safe integers only", () => {
  assert.equal(dollarsToSafeCents("5"), 500);
  assert.equal(dollarsToSafeCents("12.34"), 1234);
  assert.equal(dollarsToSafeCents("0.01"), 1);
  assert.equal(dollarsToSafeCents("1.234"), null);
  assert.equal(dollarsToSafeCents("1e6"), null);
  assert.equal(dollarsToSafeCents("-1"), null);
  assert.equal(dollarsToSafeCents("90071992547410.00"), null);
});

test("guided session validator enforces finite reviewed caps and a conservative beta envelope", () => {
  assert.deepEqual(validateGuidedSession(defaultAgentPolicy, "0", "10.00"), []);
  const broader = {
    ...defaultAgentPolicy,
    maxOrderCents: 501,
    roundCollateralCents: 500,
    sessionTurnoverCents: 1_000,
    sessionDurationMs: 45 * 60 * 1000,
    sessionGasBudgetMist: 500_000_001,
    dailyTurnoverCents: null,
    compound: true,
  };
  const issues = validateGuidedSession(broader, "0.500000001", "45.00");
  assert.ok(issues.some(issue => issue.includes("$5 beta ceiling")));
  assert.ok(issues.some(issue => issue.includes("finite cumulative session spend cap")));
  assert.ok(issues.some(issue => issue.includes("supported finite session duration")));
  assert.ok(issues.some(issue => issue.includes("0 to 0.5 SUI")));
  assert.ok(issues.some(issue => issue.includes("under Advanced")));
});

test("paper shadow capital is a bounded cents amount, never a funding instruction", () => {
  assert.equal(paperCapitalFromInput("0.01"), 1);
  assert.equal(paperCapitalFromInput("1000000.00"), 100_000_000);
  assert.equal(paperCapitalFromInput("0"), null);
  assert.equal(paperCapitalFromInput("1000000.01"), null);
  assert.equal(paperCapitalFromInput("1.001"), null);
});

test("shadow eligibility permits explicitly reviewed PAUSED state but prevents duplicate or stale-draft starts", () => {
  const approvedPausedState = {
    policy: defaultAgentPolicy,
    gasInput: "0",
    spendInput: "10.00",
    authorized: true,
    shadowAvailable: true,
    dirty: false,
    paperExists: true,
    paperCapital: "",
    status: "PAUSED",
    busy: false,
    reviewed: true,
    everyRoundAck: false,
    edgeOffAck: false,
    zeroReserveAck: false,
  };
  assert.equal(canStartGuidedShadow(approvedPausedState), true);
  assert.equal(canStartGuidedShadow({ ...approvedPausedState, status: "SHADOW" }), false);
  assert.equal(canStartGuidedShadow({ ...approvedPausedState, dirty: true }), false);
  assert.equal(canStartGuidedShadow({ ...approvedPausedState, gasInput: "0.5" }), false);
  assert.equal(canStartGuidedShadow({ ...approvedPausedState, spendInput: "9.99" }), false);
  assert.equal(canStartGuidedShadow({ ...approvedPausedState, reviewed: false }), false);
  assert.equal(canStartGuidedShadow({ ...approvedPausedState, paperExists: false, paperCapital: "" }), false);
  assert.equal(canStartGuidedShadow({ ...approvedPausedState, policy: { ...defaultAgentPolicy, frequency: "EVERY_ELIGIBLE_ROUND" } }), false);
  assert.equal(canStartGuidedShadow({ ...approvedPausedState, policy: { ...defaultAgentPolicy, frequency: "EVERY_ELIGIBLE_ROUND" }, everyRoundAck: true }), true);
  assert.equal(canStartGuidedShadow({ ...approvedPausedState, policy: { ...defaultAgentPolicy, edgeEnabled: false } }), false);
  assert.equal(canStartGuidedShadow({ ...approvedPausedState, policy: { ...defaultAgentPolicy, edgeEnabled: false }, edgeOffAck: true }), true);
  assert.equal(canStartGuidedShadow({ ...approvedPausedState, policy: { ...defaultAgentPolicy, reserveCents: 0 } }), false);
  assert.equal(canStartGuidedShadow({ ...approvedPausedState, policy: { ...defaultAgentPolicy, reserveCents: 0 }, zeroReserveAck: true }), true);
});