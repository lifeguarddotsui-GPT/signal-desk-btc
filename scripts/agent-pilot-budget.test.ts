import test from "node:test";
import assert from "node:assert/strict";
import { defaultAgentPolicy } from "../shared/agent-policy";
import {previewPilotBudget} from "../server/agent/pilot-budget";

test("exact funded pilot: 5 WaterX USD credit, 2-dollar reserve, default 5-dollar stake and zero gas",()=>{
  const p=previewPilotBudget("5000000",defaultAgentPolicy);
  assert.equal(p.status,"PREFLIGHT_ONLY");
  assert.equal(p.availableCents,500);
  assert.equal(p.reserveCents,200);
  assert.equal(p.hypotheticalStakeCents,300);
  assert.equal(p.targetStakeCents,500);
  assert.ok(p.blockers.includes("FIXED_STAKE_REDUCED_BY_BALANCE_RESERVE_OR_LIMITS"));
  assert.ok(p.blockers.includes("POSITIVE_RESTRICTED_SESSION_GAS_BUDGET_REQUIRED"));
  assert.ok(p.blockers.includes("LIVE_SIGNER_DELEGATION_QUOTE_FEES_AND_RELEASE_UNVERIFIED"));
  assert.equal(p.orderAuthorized,false);
});

test("even additional collateral and positive gas do not turn read-only preflight into order authorization",()=>{
  const p=previewPilotBudget("7000000",{...defaultAgentPolicy,sessionGasBudgetMist:100000000});
  assert.equal(p.availableCents,700);
  assert.equal(p.hypotheticalStakeCents,500);
  assert.ok(!p.blockers.includes("POSITIVE_RESTRICTED_SESSION_GAS_BUDGET_REQUIRED"));
  assert.equal(p.orderAuthorized,false);
});

test("zero credit is unfunded, tiny fractional credit never rounds up",()=>{
  const empty=previewPilotBudget("0",defaultAgentPolicy);
  assert.equal(empty.status,"UNFUNDED");
  assert.equal(empty.hypotheticalStakeCents,0);
  assert.ok(empty.blockers.includes("WATERX_ACCOUNT_CREDIT_ZERO"));
  assert.equal(previewPilotBudget("9999",{...defaultAgentPolicy,reserveCents:0}).hypotheticalStakeCents,0);
});

test("negative, scientific, malformed and unsafe credit is rejected",()=>{
  for(const input of ["-1","1e6","001","5.00","", "0x10","900719925474099300000000000"])
    assert.throws(()=>previewPilotBudget(input,defaultAgentPolicy),/credit|required|range/i);
});
