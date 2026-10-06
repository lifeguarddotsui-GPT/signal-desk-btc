import test from "node:test";
import assert from "node:assert/strict";
import {createRoundDecisionTracker} from "../server/waterx/round-decision";
import {validateDecisionSnapshot,getAtomicDecisionView} from "../client/src/live-decision-contract";
import {validWaterxProbabilityPair} from "../shared/round-decision";
import {lockPolicy} from "../shared/lock-readiness";
import {indicativeFiveDollar,verifiedEconomics} from "../shared/manual-opportunity";
import {captureLockObservation} from "../server/waterx/lock-store";
const round={intervalMinutes:5 as const,roundId:"7364372d-1d49-43d6-a6a9-a43ab434ebe2",
  startMs:1791217800000,expiryMs:1791218100000};
test("real API probabilities and asks represent different contracts; asks are never normalized",()=>{
  assert.equal(validWaterxProbabilityPair(.775,.225),true);
  assert.equal(validWaterxProbabilityPair(.792,.242),false);
  assert.equal(validWaterxProbabilityPair(0,1),true);
  assert.equal(validWaterxProbabilityPair(null,1),false);
  assert.equal(validWaterxProbabilityPair(undefined,1),false);
});
test("stale source with an empty stability window is valid retained evidence, not READINESS_SOURCE_MISMATCH",()=>{
  const t=createRoundDecisionTracker(),observed=round.startMs+100000,now=observed+25000;
  t.observe(round,{atMs:observed,receivedAtMs:observed,providerSourceAtMs:null,
    probabilityUp:.775,probabilityDown:.225,sourceHealthy:true});
  const d=t.read(round,now)!,p={intervalMinutes:5,round:{id:round.roundId,...round},
    serverTime:new Date(now).toISOString(),decision:d};
  assert.equal(d.readiness.components.observationCount,0);
  assert.equal(d.readiness.components.fresh,false);
  assert.equal(validateDecisionSnapshot(p,5),null);
  assert.equal(getAtomicDecisionView(p,5,p.round,now).lean,null);
});
test("unchanged probability remains fresh on a new receipt; cached replays do not refresh it",()=>{
  const t=createRoundDecisionTracker(),at=round.startMs+100000;
  const observation={atMs:at,receivedAtMs:at,providerSourceAtMs:null,probabilityUp:.775,probabilityDown:.225,sourceHealthy:true};
  t.observe(round,observation);
  t.observe(round,{...observation,atMs:at+20000,receivedAtMs:at+20000});
  assert.equal(t.read(round,at+21000)!.readiness.components.ageMs,1000);
  t.observe(round,{...observation,atMs:at+30000,receivedAtMs:at+20000});
  assert.equal(t.read(round,at+31000)!.readiness.components.fresh,false);
});
test("saved early research choice survives odds outage, stays separate from canonical and cannot change",()=>{
  const t=createRoundDecisionTracker(),now=round.startMs+190000;
  t.discovered(round,now);
  t.earlySaved(round,{side:"DOWN",probabilityUp:.2,decisionAtMs:now,committedAtMs:now+1,
    policyVersion:lockPolicy(5).version,observationId:"fixture",eventId:"42",workerReceivedAtMs:null});
  t.earlySaved(round,{side:"UP",probabilityUp:.8,decisionAtMs:now+2,committedAtMs:now+3,
    policyVersion:lockPolicy(5).version,observationId:"different",eventId:"43",workerReceivedAtMs:null});
  const d=t.read(round,now+5000)!;
  assert.equal(d.earlyDecision!.side,"DOWN");assert.equal(d.canonical,null);
  assert.equal(d.tradeAllowed,false);assert.equal(d.earlyPersistence!.status,"SAVED");
});
test("canonical rejected evidence has a specific state, not a fabricated committed choice",()=>{
  const t=createRoundDecisionTracker(),now=round.expiryMs-30000;
  t.discovered(round,now);t.writeFinished(round,now,"Research evidence rejected: INVALID_PROBABILITIES;");
  assert.equal(t.read(round,now)!.persistence.errorClass,"CANONICAL_INPUT_REJECTED");
});
test("verified economics include loss costs and an unqualified probability has no expected value",()=>{
  assert.deepEqual(verifiedEconomics(5.2,7,null),{netProfitIfWin:1.7999999999999998,
    expectedNet:null,breakEvenProbability:5.2/7,lossIfIncorrect:5.2});
  assert.equal(verifiedEconomics(5.2,7,.8).expectedNet,.8*7-5.2);
  assert.equal(indicativeFiveDollar(0,1).grossReceiptIfCorrect,null);
  assert.equal(indicativeFiveDollar(79.2,2).expectedNet,null);
  assert.equal(indicativeFiveDollar(79.2,2).winningProfitFilter,"UNQUALIFIED");
});
test("pinned early windows intentionally wait 180 seconds for 5m and 540 for 15m",()=>{
  assert.equal(5*60-lockPolicy(5).windows[0],180);
  assert.equal(15*60-lockPolicy(15).windows[0],540);
});
test("early record and durable event are committed together; failed commit never returns a saved choice",async()=>{
  const original=Date.now,now=round.startMs+200000;
  Date.now=()=>now;
  try{
    for(const commitFails of [false,true]){
      const calls:string[]=[];
      const history=Array.from({length:10},(_,i)=>({observed_at_ms:now-50000+i*5000,
        received_at_ms:now-50000+i*5000,provider_source_at_ms:null,probability_up:.9,probability_down:.1,source_healthy:true}));
      const client={release(){calls.push("RELEASE");},async query(sql:string){
        calls.push(sql);
        if(sql==="COMMIT"&&commitFails)throw new Error("connection reset");
        if(sql.includes("SELECT policy"))return {rows:[{policy:lockPolicy(5)}]};
        if(sql.includes("SELECT * FROM bluewater_lock_observations"))return {rows:history};
        if(sql.includes("INSERT INTO bluewater_lock_candidates"))return {rows:[{round_id:round.roundId}]};
        if(sql.includes("SELECT c.*"))return {rows:[{side:"UP",probability_up:.9,decision_at_ms:now,
          policy_version:lockPolicy(5).version,event_id:"42",received_at_ms:now}]};
        return {rows:[]};
      }};
      const operation=captureLockObservation(round,{atMs:now,receivedAtMs:now,providerSourceAtMs:null,
        probabilityUp:.9,probabilityDown:.1,sourceHealthy:true},{connect:async()=>client} as never);
      if(commitFails)await assert.rejects(operation,/connection reset/);
      else {const saved=await operation;assert.equal(saved!.side,"UP");assert.equal(saved!.eventId,"42");}
      assert(calls.some(sql=>sql.includes("INSERT INTO bluewater_early_outbox")));
      assert(calls.findIndex(sql=>sql.includes("INSERT INTO bluewater_early_outbox"))<calls.indexOf("COMMIT"));
      if(commitFails)assert(calls.includes("ROLLBACK"));
    }
  }finally{Date.now=original;}
});
