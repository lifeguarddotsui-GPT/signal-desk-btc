import test from "node:test";
import assert from "node:assert/strict";
import {TIMED_STRATEGY,LEGACY_TIMED_STRATEGY,timedWindow,earlyHorizons} from "../shared/timed-decision";
import {freezeEarlyHorizon,digestEarlySnapshot} from "../server/waterx/early-horizons";
import {trainEarlyHorizon} from "../server/waterx/early-training";
import {projectTimedResult,timedHistoryQuery} from "../server/waterx/timed-history";
import {journalTimedAcknowledgement,retryTimedAcknowledgements,timedAcknowledgementHealth} from "../server/waterx/timed-acknowledgement";
import type {TimedDecision} from "../shared/timed-decision";
import {evaluateEarlyStopping} from "../server/waterx/early-stopping";
const start=1700000000000;
const input={intervalMinutes:5 as const,roundId:"round-test",startMs:start,expiryMs:start+300000,
  observedAt:new Date(start+30000).toISOString(),receivedAtMs:start+30000,probabilityUp:.8,probabilityDown:.2};
test("new timing is explicitly versioned and legacy windows are immutable",()=>{
  assert.deepEqual(timedWindow(5),{targetSeconds:60,hardSeconds:300});
  assert.deepEqual(timedWindow(15),{targetSeconds:180,hardSeconds:900});
  assert.deepEqual(timedWindow(5,LEGACY_TIMED_STRATEGY),{targetSeconds:120,hardSeconds:150});
  assert.deepEqual(timedWindow(15,LEGACY_TIMED_STRATEGY),{targetSeconds:300,hardSeconds:450});
  assert.notEqual(TIMED_STRATEGY,LEGACY_TIMED_STRATEGY);
  assert.throws(()=>timedWindow(5,"unknown"));
});
test("prospective horizon excludes post-horizon odds and does not reconstruct late captures",()=>{
  const future={...input,receivedAtMs:start+30001,probabilityUp:.05,probabilityDown:.95};
  const frozen=freezeEarlyHorizon(input,30,[input,future],start+30010,false);
  assert.equal(frozen.status,"FROZEN");assert.equal(frozen.snapshot.probabilityUp,.8);
  assert.equal(frozen.snapshot.provenance.length,1);
  const missed=freezeEarlyHorizon(input,30,[input,future],start+33000,true);
  assert.equal(missed.status,"MISSED_HORIZON");assert.equal(missed.snapshot.probabilityUp,null);
  assert.equal(missed.snapshot.features,null);
  assert.equal(freezeEarlyHorizon(input,30,[{...input,receivedAtMs:start+10000}],start+30001,false).status,"DATA_FAILURE");
  assert.equal(digestEarlySnapshot({a:1,b:{c:2,d:3}}),digestEarlySnapshot({b:{d:3,c:2},a:1}));
});
test("late correctness remains correctness; disputed and withdrawn labels never score",()=>{
  const d={status:"LOCKED",side:"UP",onTime:false} as TimedDecision;
  assert.equal(projectTimedResult(d,true,"UP",false),"CORRECT");
  assert.equal(projectTimedResult(d,true,"DOWN",false),"INCORRECT");
  assert.equal(projectTimedResult(d,true,"UP",true),"DISPUTED");
  assert.equal(projectTimedResult(d,false,"UP",false),"PENDING");
  assert.equal(projectTimedResult({...d,status:"NO_VALID_INPUT"},true,"UP",false),"NO_VALID_INPUT");
  assert.equal(timedHistoryQuery.parse({interval:"all",strategy:"all",window:"7d",limit:"20"}).limit,20);
  assert.throws(()=>timedHistoryQuery.parse({interval:"10"}));
});
test("ack failure is recorded and retry writes only the actual observed response time",async()=>{
  const times:unknown[]=[];let fail=true;
  const db={query:async(_sql:string,args?:unknown[])=>{
    if(fail)throw Object.assign(new Error("injected"),{code:"CONNECTION_FAILURE"});
    times.push(args?.[1]);return {rows:[{committed_ack_at_ms:args?.[1]}]};
  }};
  assert.equal(await journalTimedAcknowledgement("ack-test",start+60,db),false);
  assert(timedAcknowledgementHealth().pending>0);
  fail=false;await retryTimedAcknowledgements(db,Date.now()+60000);
  assert.deepEqual(times,[start+60]);
});
test("training refuses duplicate snapshots and late-label leakage across chronological partitions",()=>{
  const now=Date.UTC(2026,9,6),day=86400000;
  const row={interval:5 as const,roundId:"one",startMs:now-8*day,expiryMs:now-8*day+300000,
    horizon:60,probability:.8,outcome:"UP" as const,labelAvailableAtMs:now,snapshotDigest:"fixture"};
  const report=trainEarlyHorizon([row,row],5,60,now);
  assert.equal(report.status,"INSUFFICIENT");
  assert.equal(report.counts.training,0);assert.equal(report.rejected.duplicates,1);
  assert.equal(report.rejected.partitionBoundaryOrLabelEmbargo,1);
});
test("sequential policy counts one decision per round, uses calibration to select threshold, and retains live baseline",()=>{
  const now=Date.UTC(2026,9,6),day=86400000;
  const forecasts=earlyHorizons(5).map(horizon=>({horizon,artifact:{
    parameters:{intercept:0,coefficients:[1]},calibration:{intercept:0,coefficients:[1]}}}));
  const rows=Array.from({length:140},(_,i)=>earlyHorizons(5).map(horizon=>({
    interval:5 as const,roundId:`fixture-${i}`,startMs:now-(i<70?3:1)*day+i*300000,
    expiryMs:now-(i<70?3:1)*day+i*300000+300000,horizon,
    probability:i%2?.2:.8,outcome:i%2?"DOWN" as const:"UP" as const,
    labelAvailableAtMs:now-(i<70?3:1)*day+i*300000+301000,snapshotDigest:"fixture",
     features:{sameSideMs:horizon===30?0:30000,sourceAgeMs:0,validObservationCount:4,
       recentReversals:0,probabilityRange:0,missingProbabilities:false},
  }))).flat();
  const report=evaluateEarlyStopping(rows,5,forecasts,now);
  assert.equal(report.status,"EVALUATED");
  assert.equal(report.promotion,"RETAIN_BASELINE");
  if("test"in report){
    assert.equal(report.test.roundN,70);assert.equal(report.test.decisionN,70);
    assert.equal(report.test.meanElapsedSeconds,60);
    assert.equal(report.test.quoteAdjustedEconomics,null);
  }
});
