import test from "node:test";
import assert from "node:assert/strict";
import {parseWaterxResponse} from "../server/waterx/source";
import {buildWaterxLivePayload,calculateWaterxRetryDelay} from "../server/waterx/service";
import {createRoundDecisionTracker,roundDecisions} from "../server/waterx/round-decision";
import {createRefreshHealth} from "../server/waterx/refresh-health";
import {WaterxProviderError} from "../server/waterx/source";
import {probabilityState} from "../shared/waterx-data-health";
import {captureTimedDecision} from "../server/waterx/timed-decision-store";
import {earlyDeliveryMetrics} from "../server/waterx/early-delivery-metrics";

const start=1800000000000,now=start+10000;
function fixture(interval:5|15,up:unknown=null,down:unknown=null){
  return {success:true,data:{detail:{
    market:{slug:`crypto-btc-updown-${interval}m`,marketId:`incident-${interval}`},
    round:{id:interval===5?"cf13bba1-c235-4d3c-9bf6-41f1275a0fb0":"19194584-e2aa-42ea-a253-3a5ca5a0293e",
      startsAt:start/1000,endsAt:start/1000+interval*60,phase:"live",anchorPrice:85000,anchorPriceConfirmed:false,
      sides:[{key:"up",oddsCents:null,probabilityCents:up},{key:"down",oddsCents:null,probabilityCents:down}]},
    neighbors:{past:[],upcoming:[]}}}};
}
function payload(interval:5|15,up:unknown=null,down:unknown=null,sourceError:string|null=null){
  const round=parseWaterxResponse(fixture(interval,up,down),interval).round;
  return buildWaterxLivePayload(interval,{round,status:"LIVE",observedAt:new Date(now).toISOString(),
    receivedAtMs:now,sourceError,reason:"Metadata received"},now+1000,null);
}
for(const interval of [5,15] as const){
  test(`${interval}m fresh metadata with missing probabilities preserves identity and reference`,()=>{
    const p=payload(interval);
    assert.equal(p.status,"LIVE");assert.ok(p.round);
    assert.equal(p.round.referencePrice,85000);
    assert.equal(p.dataHealth.round.status,"KNOWN");
    assert.equal(p.dataHealth.transport.status,"HEALTHY");
    assert.equal(p.dataHealth.probabilities.status,"PROBABILITIES_MISSING");
    assert.equal(p.dataHealth.primaryReason,"PROBABILITIES_MISSING");
    assert.equal(p.odds?.asOf,null);
    assert.equal(p.dataHealth.execution.eligible,false);
  });
  test(`${interval}m one missing side and invalid pair are distinct`,()=>{
    assert.equal(payload(interval,60,null).dataHealth.primaryReason,"PROBABILITIES_MISSING");
    const p=payload(interval,60,60);
    assert.equal(p.dataHealth.primaryReason,"PROBABILITY_PAIR_INVALID");
    assert.notEqual(p.availability.odds.status,"available");
    assert.equal(payload(interval,"garbage",40).dataHealth.primaryReason,"PROBABILITY_PAIR_INVALID");
  });
  test(`${interval}m timeout remains independent of known round and later recovery`,()=>{
    const unavailable=payload(interval,60,40,"PROVIDER_TIMEOUT");
    assert.equal(unavailable.dataHealth.transport.status,"PROVIDER_TIMEOUT");
    assert.equal(unavailable.dataHealth.round.status,"KNOWN");
    assert.equal(unavailable.odds?.asOf,null);
    assert.equal(payload(interval,60,40).dataHealth.primaryReason,"CURRENT");
  });
}
test("new metadata without odds suppresses a recent valid pair without losing its original clock",()=>{
  const intervalMinutes=5 as const,round=parseWaterxResponse(fixture(5),5).round;
  const identity={intervalMinutes,roundId:round.id,startMs:start,expiryMs:start+300000};
  roundDecisions.discovered(identity,now-1000);
  roundDecisions.observe(identity,{atMs:now-1000,receivedAtMs:now-1000,providerSourceAtMs:null,
    probabilityUp:.6,probabilityDown:.4,sourceHealthy:true});
  roundDecisions.context(identity,{sourceId:"waterx.public.crypto.v1",observationId:"missing",receivedAtMs:now,
    providerEventAtMs:null,priceLastChangedAtMs:null,reference:{price:85000,status:"provisional"},
    marketId:round.marketId,url:"https://waterx.app",orderCutoffAtMs:null,probabilityEvidence:"unavailable",
    purchase:{up:{status:"unavailable",askCents:null,marketObjectId:null,selection:null},
      down:{status:"unavailable",askCents:null,marketObjectId:null,selection:null}}});
  const p=payload(5);
  assert.equal(p.decision?.market,null);
  assert.equal(p.decision?.readiness.components.fresh,false);
  assert.equal(p.decision?.timedDecision?.qualified,false);
  assert.deepEqual(p.dataHealth.probabilities.lastValid,{up:.6,down:.4,receivedAtMs:now-1000,ageMs:2000});
  // A new round has no previous-round odds.
  const next={...identity,roundId:"next-round",startMs:start+300000,expiryMs:start+600000};
  roundDecisions.discovered(next,next.startMs+1);
  assert.equal(roundDecisions.lastValid(next),null);
});
test("independent interval state and repeated simulated rollovers never transfer an observation",()=>{
  const t=createRoundDecisionTracker();
  for(let n=0;n<3;n++)for(const intervalMinutes of [5,15] as const){
    const r={intervalMinutes,roundId:`i${intervalMinutes}-r${n}`,startMs:start+n*intervalMinutes*60000,
      expiryMs:start+(n+1)*intervalMinutes*60000};
    const at=r.startMs+1000;
    t.discovered(r,at);assert.equal(t.lastValid(r),null);
    if(intervalMinutes===5){t.observe(r,{atMs:at,receivedAtMs:at,sourceHealthy:true,
      providerSourceAtMs:null,probabilityUp:.7,probabilityDown:.3});assert.ok(t.lastValid(r));}
    else assert.equal(t.lastValid(r),null);
  }
});
test("Retry-After on 503 is honored, and bounded ordinary retries remain independent",()=>{
  assert.ok(calculateWaterxRetryDelay(5,new WaterxProviderError("busy",503,90000),2,0)>=90000);
  assert.ok(calculateWaterxRetryDelay(15,new WaterxProviderError("429",429,120000),2,0)>=120000);
  assert.notEqual(calculateWaterxRetryDelay(5,new Error("timeout"),1,0),
    calculateWaterxRetryDelay(15,new Error("timeout"),1,0));
  assert.ok(calculateWaterxRetryDelay(5,new Error("timeout"),99,0)<=60000);
});
test("missing-input rejections do not become database errors or clear other failing stages",()=>{
  const h=createRefreshHealth(()=>now);
  h.record({interval:5,stage:"DATABASE_WRITE",outcome:"error",errorClass:"TIMEOUT"});
  h.record({interval:5,stage:"READINESS_INPUT",outcome:"rejected",errorClass:"PROBABILITIES_MISSING"});
  assert.equal(h.read(5).errors.length,1);
  assert.equal(h.read(5).errors[0].stage,"DATABASE_WRITE");
  assert.equal(h.read(5).rejections.length,1);
});
test("a failed database acquisition reports the earliest actual failing timed-capture stage",async()=>{
  const at=Date.now(),roundStart=Math.floor(at/300000)*300000;
  const input={intervalMinutes:5 as const,roundId:"acquisition-failure",startMs:roundStart,expiryMs:roundStart+300000,
    observedAt:new Date(at).toISOString(),receivedAtMs:at,probabilityUp:null,probabilityDown:null,
    anchorPrice:85000,anchorConfirmed:false,source:"WaterX"};
  const db={connect:async()=>{throw new Error("connection timeout");},query:async()=>({rows:[]})};
  await assert.rejects(()=>captureTimedDecision(input,db as never),/connection timeout/);
  assert.ok(earlyDeliveryMetrics().stages.some(s=>s.interval===5&&s.stage==="DATABASE_ACQUISITION"&&s.failures>0));
});
test("probability age is receipt-based, never refreshed by a metadata timestamp",()=>{
  assert.equal(probabilityState(.6,.4,now-11000,now),"PROBABILITIES_STALE");
  assert.equal(probabilityState(null,null,now,now),"PROBABILITIES_MISSING");
});
test("a replayed valid payload publishes the original receipt, not its newer processing timestamp",()=>{
  const round=parseWaterxResponse(fixture(15,60,40),15).round;
  const p=buildWaterxLivePayload(15,{round,status:"LIVE",receivedAtMs:now,
    observedAt:new Date(now+3000).toISOString(),sourceError:null,reason:"Cached payload"},now+4000,null);
  assert.equal(p.odds?.asOf,new Date(now).toISOString());
});
test("a transport failure vetoes live readiness while retaining the last pair; only a newer valid observation recovers",()=>{
  const t=createRoundDecisionTracker();
  const r={intervalMinutes:5 as const,roundId:"transport-veto",startMs:start,expiryMs:start+300000};
  const observation={atMs:now,receivedAtMs:now,providerSourceAtMs:null,sourceHealthy:true,
    probabilityUp:.6,probabilityDown:.4};
  t.observe(r,observation);t.sourceUnavailable(r);
  assert.equal(t.read(r,now+1)?.market,null);
  assert.equal(t.read(r,now+1)?.timedDecision?.qualified,false);
  assert.equal(t.lastValid(r)?.receivedAtMs,now);
  t.observe(r,observation);
  assert.equal(t.read(r,now+1)?.market,null,"replaying an old receipt cannot recover");
  t.observe(r,{...observation,atMs:now+2,receivedAtMs:now+2});
  assert.ok(t.read(r,now+3)?.market);
});
