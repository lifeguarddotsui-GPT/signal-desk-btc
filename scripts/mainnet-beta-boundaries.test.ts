import test from "node:test";
import assert from "node:assert/strict";
import { agentPolicySchema, defaultAgentPolicy } from "../shared/agent-policy";
import { projectHistory, historySummary, type HistoryFact } from "../shared/canonical-history";
import { historyQuerySchema } from "../server/waterx/canonical-history";
import { evaluateRisk, type ExecutionEvidence, type Equity } from "../server/agent/risk";

test("mainnet beta prefills $5 without compounding; explicitly reviewed limits are owner-editable",()=>{
  const p=agentPolicySchema.parse(defaultAgentPolicy);
  assert.equal(p.network,"mainnet");assert.equal(p.sizingMode,"FIXED");assert.equal(p.compound,false);
  assert.equal(p.maxOrderCents,500);assert.deepEqual(p.intervals,[5,15]);
  assert.equal(agentPolicySchema.safeParse({...p,fixedCents:501}).success,false);
  for(const patch of [{fixedCents:700,roundCollateralCents:1000},{sizingMode:"AVAILABLE_PERCENT"},{sizingMode:"ALLOCATION_PERCENT"},
    {compound:true},{maxOrderCents:null},{maxOrderCents:501}])
    assert.equal(agentPolicySchema.safeParse({...p,...patch}).success,true,JSON.stringify(patch));
  assert.equal(agentPolicySchema.safeParse({...p,fixedCents:100,maxOrderCents:100}).success,true);
  for(const patch of [{dailyTurnoverCents:null},{dailyTurnoverCents:2500},
    {maxUnresolved:{mode:"PERCENT",value:30}},{maxUnresolved:{mode:"AMOUNT",value:1001}}])
    assert.equal(agentPolicySchema.safeParse({...p,...patch}).success,true);
  assert.equal(p.dailyTurnoverCents,1000);assert.deepEqual(p.maxUnresolved,{mode:"AMOUNT",value:500});
});
test("mainnet risk ceiling includes settlement fees, independently from the order-sizing cap",()=>{
  const now=290000;
  const equity:Equity={availableCents:10000,committedCents:0,startingCents:10000,dayStartingCents:10000,
    dayTurnoverCents:0,dayRealizedPnlCents:0,highWaterCents:10000,consecutiveLosses:0};
  const evidence:ExecutionEvidence={nowMs:now,mode:"SHADOW",paused:false,killed:false,releaseApproved:false,
    delegateValid:true,delegateExpiresAtMs:900000,network:"mainnet",accountVerified:true,providerEligible:true,
    duplicate:false,simulationPassed:true,
    signal:{source:"BLUEWATER_CHAMPION",qualified:true,frozen:true,roundId:"fixture",interval:5,
      startMs:0,expiryMs:300000,atMs:289000,side:"UP",probability:.7},
    market:{id:"fixture-market",roundId:"fixture",interval:5,startMs:0,expiryMs:300000,
      underlying:"BTC",open:true,semanticsVerified:true,yesMeans:"UP",network:"mainnet"},
    quote:{atMs:289900,marketId:"fixture-market",selection:"YES",spendCents:500,totalFeeCents:1,
      payoutIfWinCents:1000,priceBps:5000,minSharesAtomic:"1000",economicsVerified:true}};
  assert.equal(evaluateRisk(defaultAgentPolicy,equity,evidence).reason,"BETA_ALL_IN_COLLATERAL_CAP");
  evidence.quote!.totalFeeCents=0;
  assert.equal(evaluateRisk(defaultAgentPolicy,equity,evidence).action,"QUALIFIED");
  evidence.duplicate=true;
  assert.equal(evaluateRisk(defaultAgentPolicy,equity,evidence).action,"HOLD");
  // QUALIFIED here is synthetic risk evidence, not permission to submit a trade.
});
const fact:HistoryFact={intervalMinutes:5,roundId:"fixture",startMs:1000,expiryMs:301000,
  choiceState:"FROZEN",choiceCount:1,side:"UP",probabilityUp:.7,lockAtMs:240000,modelVersion:"fixture",
  outcome:"UP",verificationState:"verified",verifiedOutcome:true,disputed:false};
test("canonical projection uses immutable choice, never later odds, and keeps trade economics separate",()=>{
  const r=projectHistory(fact,"baseline");
  assert.equal(r.result,"CORRECT");assert.equal(r.secondsBeforeExpiry,61);
  assert.equal(r.source,"WaterX Market Baseline");assert.equal(r.realizedPnl,null);
  assert.equal(projectHistory({...fact,outcome:"DOWN"},"baseline").result,"INCORRECT");
  assert.ok(Math.abs(projectHistory({...fact,side:"DOWN"},"bluewater").probability!-.3)<1e-12);
  for(const patch of [{choiceState:null},{side:null},{lockAtMs:null},{lockAtMs:301000},
    {probabilityUp:NaN},{choiceCount:2},{choiceCount:0}])
    assert.equal(projectHistory({...fact,...patch},"bluewater").result,"NO CHOICE");
  assert.equal(projectHistory({...fact,verifiedOutcome:false},"baseline").result,"PENDING");
});
test("settlement withdrawal removes a frozen prediction from scored denominators, restoration recomputes ratio",()=>{
  const correct=projectHistory(fact,"baseline"),incorrect=projectHistory({...fact,outcome:"DOWN"},"baseline");
  const pending=projectHistory({...fact,verifiedOutcome:false},"baseline");
  const noChoice=projectHistory({...fact,choiceCount:0,disputed:true},"baseline");
  const withdrawn=projectHistory({...fact,disputed:true},"baseline");
  const s=historySummary([correct,incorrect,pending,noChoice,withdrawn]);
  assert.equal(s.ratio,"1:1");assert.equal(s.hitRate,.5);assert.equal(s.scored,2);
  assert.equal(s.pending,1);assert.equal(s.withdrawn,1);assert.equal(s.noChoice,1);
  assert.equal(historySummary([correct,withdrawn]).hitRate,1);
  assert.equal(historySummary([correct,incorrect]).hitRate,.5);
  assert.equal(historySummary([]).hitRate,null);
});
test("history cohorts reject unbounded arbitrary input and keep source and interval identity separate",()=>{
  assert.deepEqual(historyQuerySchema.parse({}),{interval:"all",window:"lifetime",source:"baseline"});
  for(const interval of ["all","5","15"])for(const window of ["lifetime","100","50","20","24h","7d"])
    assert.equal(historyQuerySchema.safeParse({interval,window,source:"bluewater"}).success,true);
  for(const patch of [{interval:"1"},{window:"last-win"},{source:"latest-odds"},{wallet:"private"}])
    assert.equal(historyQuerySchema.safeParse(patch).success,false);
});