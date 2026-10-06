import test from "node:test";
import assert from "node:assert/strict";
import { agentPolicySchema, defaultAgentPolicy, policySummary } from "../shared/agent-policy";
import { evaluateRisk, sizePosition, type ExecutionEvidence, type Equity } from "../server/agent/risk";
import { readFileSync } from "node:fs";
// Preserve legacy testnet sizing coverage independently from the fixed beta.
const p=()=>({...structuredClone(defaultAgentPolicy),network:"testnet" as const,intervals:[5] as (5|15)[],
  sizingMode:"AVAILABLE_PERCENT" as const,compound:true,maxOrderCents:2000,dailyTurnoverCents:2500,maxUnresolved:{mode:"PERCENT" as const,value:30}});
const equity=():Equity=>({availableCents:10000,committedCents:0,startingCents:10000,dayStartingCents:10000,dayTurnoverCents:0,dayRealizedPnlCents:0,highWaterCents:10000,consecutiveLosses:0});
const evidence=():ExecutionEvidence=>({nowMs:290000,mode:"SHADOW",paused:false,killed:false,releaseApproved:false,
  delegateValid:true,delegateExpiresAtMs:900000,network:"testnet",accountVerified:true,providerEligible:true,duplicate:false,simulationPassed:true,
  signal:{source:"BLUEWATER_CHAMPION",qualified:true,frozen:true,atMs:289000,roundId:"fixture",interval:5,startMs:0,expiryMs:300000,side:"UP",probability:.7},
  market:{id:"market-fixture",roundId:"fixture",interval:5,startMs:0,expiryMs:300000,underlying:"BTC",open:true,semanticsVerified:true,yesMeans:"UP",network:"testnet"},
  quote:{atMs:289900,marketId:"market-fixture",selection:"YES",spendCents:1000,totalFeeCents:0,payoutIfWinCents:2000,priceBps:5000,minSharesAtomic:"2000",economicsVerified:true}});
test("agent policies reject unknown fields, Infinity, duplicate intervals and fractional money",()=>{
  for(const patch of [{dailyTurnoverCents:Infinity},{maxOrderCents:Infinity},{intervals:[5,5]},{privateKey:"never"},{maxUnresolved:{mode:"AMOUNT",value:3.5}},{dailyLoss:{mode:"PERCENT",value:101}}])assert.equal(agentPolicySchema.safeParse({...p(),...patch}).success,false);
  assert.equal(agentPolicySchema.parse({...p(),dailyTurnoverCents:null}).dailyTurnoverCents,null);
});
test("fixed stake and compounding grow and decline symmetrically",()=>{
  assert.equal(sizePosition({...p(),sizingMode:"FIXED"},equity()),500);
  assert.equal(sizePosition(p(),equity()),1000);
  assert.equal(sizePosition(p(),{...equity(),availableCents:20000,highWaterCents:20000}),2000);
  assert.equal(sizePosition(p(),{...equity(),availableCents:5000}),500);
  assert.equal(sizePosition({...p(),compound:false},equity()),100);
  assert.equal(sizePosition({...p(),sizingMode:"ALLOCATION_PERCENT",compound:false},equity()),100);
  assert.equal(sizePosition({...p(),sizingMode:"ALLOCATION_PERCENT",compound:true},equity()),100);
});
test("all ceilings preserve cents and no daily cap does not disable reserve",()=>{
  assert.equal(sizePosition({...p(),dailyTurnoverCents:950},equity()),950);
  assert.equal(sizePosition({...p(),maxOrderCents:350},equity()),350);
  assert.equal(sizePosition({...p(),reserveCents:9900,dailyTurnoverCents:null},equity()),100);
  assert.equal(sizePosition({...p(),maxUnresolved:{mode:"AMOUNT",value:50}},equity()),50);
  assert.equal(sizePosition(p(),{...equity(),committedCents:10000}),0);
  assert.throws(()=>sizePosition(p(),{...equity(),availableCents:NaN}));
});
test("exact threshold edge, net fees, selective and every-round independent",()=>{
  const v=evidence();v.signal!.probability=.55;
  const policy={...p(),frequency:"EVERY_ELIGIBLE_ROUND" as const};
  assert.equal(evaluateRisk(policy,equity(),v).action,"QUALIFIED");
  v.signal!.probability=.549;assert.equal(evaluateRisk(policy,equity(),v).reason,"EDGE_BELOW_LIMIT");
  assert.equal(evaluateRisk({...policy,edgeEnabled:false},equity(),v).action,"QUALIFIED");
  assert.equal(evaluateRisk({...policy,frequency:"SELECTIVE"},equity(),v).reason,"SELECTIVE_PROBABILITY_BELOW_LIMIT");
  v.signal!.probability=.7;v.quote!.totalFeeCents=100;
  const d=evaluateRisk(policy,equity(),v);assert.equal(d.effectiveBreakEvenProbability,.55);assert.ok(Math.abs(d.edgePp!-15)<1e-8);
});
const gates:[string,(v:ExecutionEvidence)=>void,string][]=[
  ["pause",v=>{v.paused=true;},"PAUSED"],
  ["kill",v=>{v.killed=true;},"GLOBAL_EXECUTION_DISABLED"],
  ["live release",v=>{v.mode="LIVE";},"MAINNET_RELEASE_NOT_APPROVED"],
  ["network",v=>{v.network="mainnet";},"WRONG_NETWORK"],
  ["account",v=>{v.accountVerified=false;},"ACCOUNT_UNVERIFIED"],
  ["eligibility",v=>{v.providerEligible=false;},"PROVIDER_ELIGIBILITY_UNVERIFIED"],
  ["delegate",v=>{v.delegateValid=false;},"DELEGATE_INVALID_OR_EXPIRED"],
  ["delegate expiry",v=>{v.delegateExpiresAtMs=290001;},"DELEGATE_INVALID_OR_EXPIRED"],
  ["duplicate",v=>{v.duplicate=true;},"DUPLICATE_ROUND"],
  ["baseline never champion",v=>{v.signal!.source="WaterX Market Baseline";},"NO_QUALIFIED_CHAMPION_FINAL_CHOICE"],
  ["unqualified",v=>{v.signal!.qualified=false;},"NO_QUALIFIED_CHAMPION_FINAL_CHOICE"],
  ["not frozen",v=>{v.signal!.frozen=false;},"NO_QUALIFIED_CHAMPION_FINAL_CHOICE"],
  ["stale signal",v=>{v.signal!.atMs=100;},"STALE_OR_INVALID_SIGNAL"],
  ["future signal",v=>{v.signal!.atMs=290001;},"STALE_OR_INVALID_SIGNAL"],
  ["NaN signal",v=>{v.signal!.probability=NaN;},"STALE_OR_INVALID_SIGNAL"],
  ["semantics",v=>{v.market!.semanticsVerified=false;},"MARKET_SEMANTICS_UNVERIFIED"],
  ["wrong market",v=>{v.market!.roundId="different";},"WRONG_OR_CLOSED_MARKET"],
  ["wrong boundary",v=>{v.market!.expiryMs++;},"WRONG_OR_CLOSED_MARKET"],
  ["closed",v=>{v.market!.open=false;},"WRONG_OR_CLOSED_MARKET"],
  ["underlying",v=>{v.market!.underlying="ETH";},"WRONG_OR_CLOSED_MARKET"],
  ["time",v=>{v.nowMs=299999;},"INSUFFICIENT_TIME"],
  ["missing quote",v=>{v.quote=null;},"EXECUTABLE_ECONOMICS_UNVERIFIED"],
  ["indicative quote",v=>{v.quote!.economicsVerified=false;},"EXECUTABLE_ECONOMICS_UNVERIFIED"],
  ["stale quote",v=>{v.quote!.atMs=100;},"STALE_QUOTE"],
  ["future quote",v=>{v.quote!.atMs=290001;},"STALE_QUOTE"],
  ["quote market",v=>{v.quote!.marketId="different";},"QUOTE_IDENTITY_MISMATCH"],
  ["quote selection",v=>{v.quote!.selection="NO";},"QUOTE_IDENTITY_MISMATCH"],
  ["quote amount",v=>{v.quote!.spendCents++;},"QUOTE_ECONOMICS_OR_PRICE_CAP_INVALID"],
  ["price cap",v=>{v.quote!.priceBps=10001;},"QUOTE_ECONOMICS_OR_PRICE_CAP_INVALID"],
  ["no shares",v=>{v.quote!.minSharesAtomic="0";},"QUOTE_ECONOMICS_OR_PRICE_CAP_INVALID"],
  ["simulation",v=>{v.simulationPassed=false;},"SIMULATION_FAILED"],
  ["missing simulation",v=>{v.simulationPassed=null;},"SIMULATION_REQUIRED"],
];
for(const [label,mutate,reason]of gates)test(`agent hard gate: ${label}`,()=>{const v=evidence();mutate(v);assert.equal(evaluateRisk(p(),equity(),v).reason,reason);});
test("goals, daily losses, drawdown and consecutive stops at equality",()=>{
  assert.equal(evaluateRisk({...p(),targetCents:10000},equity(),evidence()).reason,"TARGET_REACHED");
  assert.equal(evaluateRisk(p(),{...equity(),dayRealizedPnlCents:-400},evidence()).reason,"DAILY_LOSS_STOP");
  assert.equal(evaluateRisk({...p(),dailyLoss:{mode:"PERCENT",value:10}}, {...equity(),dayRealizedPnlCents:-1000},evidence()).reason,"DAILY_LOSS_STOP");
  assert.equal(evaluateRisk(p(),{...equity(),availableCents:8000},evidence()).reason,"DRAWDOWN_STOP");
  assert.equal(evaluateRisk(p(),{...equity(),consecutiveLosses:3},evidence()).reason,"CONSECUTIVE_LOSS_STOP");
  assert.equal(evaluateRisk({...p(),dailyProfitTargetCents:100}, {...equity(),dayRealizedPnlCents:100},evidence()).reason,"DAILY_PROFIT_TARGET");
});
test("verified YES/NO mapping does not assume UP is YES",()=>{
  const v=evidence();v.market!.yesMeans="DOWN";v.quote!.selection="NO";assert.equal(evaluateRisk(p(),equity(),v).selection,"NO");
});
test("clock must be verified and entry fees cannot exceed unresolved exposure",()=>{
  const v=evidence();v.nowMs=NaN;assert.equal(evaluateRisk(p(),equity(),v).reason,"INVALID_CLOCK");
  const q=evidence();q.quote!.totalFeeCents=100;
  assert.equal(evaluateRisk({...p(),maxUnresolved:{mode:"AMOUNT",value:1000}},equity(),q).reason,"QUOTE_ECONOMICS_OR_PRICE_CAP_INVALID");
});
test("agent source has no signing/submission and immutable research remains separate",()=>{
  const source=readFileSync("server/agent/worker.ts","utf8");
  assert.doesNotMatch(source,/signAndExecute|signTransaction|executeTransaction/);
  assert.doesNotMatch(source,/UPDATE waterx_research|INSERT INTO waterx_research/);
  assert.match(source,/ON CONFLICT DO NOTHING/);
  assert.ok(policySummary({...p(),dailyTurnoverCents:null}).some(s=>s.includes("Unlimited")));
});