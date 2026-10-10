import test from "node:test";
import assert from "node:assert/strict";
import {defaultAgentPolicy} from "../shared/agent-policy";
import {assessMainnetPilot,type PilotPreflightInput} from "../shared/agent-mainnet-preflight";

function input():PilotPreflightInput{
  return {policy:{...defaultAgentPolicy,signalSource:"EXPERIMENTAL_QUALIFICATION_GATES",
    intervals:[5],compound:false,sessionGasBudgetMist:10000000,
    sizingMode:"AVAILABLE_PERCENT",sizingPercent:5,roundCollateralCents:500},
    nowMs:100000,ownerSessionExpiresAtMs:200000,accountId:"verified-account",
    accountBalanceAtomic:"5000000",accountBalanceReadAtMs:99999,
    controlPlaneIsolated:false,onChainDelegateVerified:false,signerProvisioned:false,
    executableQuoteVerified:false,continuouslyLeasedWorkerVerified:false,releaseApproved:false};
}
const check=(r:ReturnType<typeof assessMainnetPilot>,id:string)=>
  r.checks.find(x=>x.id===id)?.status;
test("Read-only preflight finds configured wallet but cannot authorize live trading",()=>{
  const r=assessMainnetPilot(input());
  assert.equal(r.observedAvailableCents,500);
  assert.equal(r.plannedStakeCents,25); // 5% of $5 = $0.25, never silently increases to $5
  assert.equal(check(r,"positive-executable-stake"),"PASS");
  assert.equal(check(r,"signer"),"UNVERIFIED");
  assert.equal(check(r,"on-chain-delegate"),"UNVERIFIED");
  assert.equal(check(r,"executable-quote"),"UNVERIFIED");
  assert.equal(check(r,"independent-worker"),"UNVERIFIED");
  assert.equal(r.ready,false);
  assert.equal(r.canSign,false);assert.equal(r.canSubmit,false);
});
test("No cached balance or bad balance can count as funded mainnet account",()=>{
  for(const value of [null,"", "-1","1.5","NaN","999999999999999999999999999999999999999"]){
    const r=assessMainnetPilot({...input(),accountBalanceAtomic:value});
    assert.equal(check(r,"account-credit-read"),"UNVERIFIED");
    assert.equal(r.plannedStakeCents,null);
  }
  assert.equal(check(assessMainnetPilot({...input(),accountBalanceReadAtMs:1}),"account-credit-read"),"UNVERIFIED");
  assert.equal(check(assessMainnetPilot({...input(),accountBalanceReadAtMs:100001}),"account-credit-read"),"UNVERIFIED");
});
test("Policy reserve, default gas=0 and false champion readiness block live pilot",()=>{
  const base=input();
  const r=assessMainnetPilot({...base,policy:{...defaultAgentPolicy}});
  assert.equal(check(r,"strategy"),"BLOCKED");
  assert.equal(check(r,"session-gas-budget"),"BLOCKED");
  assert.equal(r.plannedStakeCents,300); // $5 funded minus $2 reserve
  const insufficient=assessMainnetPilot({...base,policy:{...base.policy,reserveCents:500}});
  assert.equal(insufficient.plannedStakeCents,0);
  assert.equal(check(insufficient,"positive-executable-stake"),"BLOCKED");
  const enlarged=assessMainnetPilot({...base,policy:{...base.policy,roundCollateralCents:1000}});
  assert.equal(check(enlarged,"pilot-cap"),"BLOCKED");
});
test("Explicit safety authorizations are independent of network and wallet",()=>{
  const base=input();
  const r=assessMainnetPilot({...base,controlPlaneIsolated:true,onChainDelegateVerified:true,
    signerProvisioned:true,executableQuoteVerified:true,continuouslyLeasedWorkerVerified:true,
    releaseApproved:false});
  assert.equal(check(r,"release-authority"),"BLOCKED");
  assert.equal(r.ready,false);
  const expired=assessMainnetPilot({...base,ownerSessionExpiresAtMs:100001});
  assert.equal(check(expired,"owner-session"),"BLOCKED");
});

test("First real-money pilot cannot exceed a smaller daily-loss or percentage exposure ceiling",()=>{
  const base=input();
  const policy={...base.policy,sizingMode:"FIXED" as const,fixedCents:500,reserveCents:0,
    dailyLoss:{mode:"AMOUNT" as const,value:100},
    maxUnresolved:{mode:"PERCENT" as const,value:50}};
  assert.equal(assessMainnetPilot({...base,policy}).plannedStakeCents,100);
  assert.equal(assessMainnetPilot({...base,policy:{...policy,dailyLoss:null}}).plannedStakeCents,250);
});
