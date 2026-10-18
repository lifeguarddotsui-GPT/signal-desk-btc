import test from "node:test";
import assert from "node:assert/strict";
import {defaultAgentPolicy,agentPolicySchema} from "../shared/agent-policy";
import {previewPilotBudget} from "../server/agent/pilot-budget";

test("funded wallet could budget a sub-$1 preliminary position; live authority is still absent",()=>{
  // 95 cents is only an illustrative collateral allocation. It does NOT
  // establish actual WaterX fees, order size minimum, fill or gas sufficiency.
  const pilot=agentPolicySchema.parse({...defaultAgentPolicy,
    signalSource:"EXPERIMENTAL_QUALIFICATION_GATES",
    fixedCents:95,maxOrderCents:95,roundCollateralCents:100,
    dailyTurnoverCents:100,sessionTurnoverCents:100,
    sessionLossCents:100,maxUnresolved:{mode:"AMOUNT",value:100},
    sessionGasBudgetMist:20000000,compound:false});
  const report=previewPilotBudget("5000000",pilot);
  assert.equal(report.availableCents,500);
  assert.equal(report.reserveCents,200);
  assert.equal(report.hypotheticalStakeCents,95);
  assert.equal(report.targetStakeCents,95);
  assert.equal(report.orderAuthorized,false);
  assert.ok(report.blockers.includes("LIVE_SIGNER_DELEGATION_QUOTE_FEES_AND_RELEASE_UNVERIFIED"));
  assert.ok(!report.blockers.includes("POSITIVE_RESTRICTED_SESSION_GAS_BUDGET_REQUIRED"));
  assert.equal(pilot.roundCollateralCents,100);
  assert.equal(pilot.sessionTurnoverCents,100);
  // Simulated session gas is a spending ceiling, not verified gas funding.
});

test("even with valid small-position policy, a $1 order cannot be inferred from unknown fees",()=>{
  const proposed={...defaultAgentPolicy,fixedCents:100,maxOrderCents:100,
    roundCollateralCents:100,sessionTurnoverCents:100,
    dailyTurnoverCents:100,maxUnresolved:{mode:"AMOUNT" as const,value:100}};
  const policy=agentPolicySchema.parse(proposed);
  assert.equal(previewPilotBudget("5000000",policy).orderAuthorized,false);
  assert.equal(policy.sessionGasBudgetMist,0);
  assert.ok(previewPilotBudget("5000000",policy).blockers.includes("POSITIVE_RESTRICTED_SESSION_GAS_BUDGET_REQUIRED"));
});
