import test from "node:test";
import assert from "node:assert/strict";
import {evaluateTimedDecision,timedWindow,TIMED_STRATEGY,PREVIOUS_TIMED_STRATEGY,LEGACY_TIMED_STRATEGY,earlyHorizons} from "../shared/timed-decision";
import type {LockObservation} from "../shared/lock-readiness";
import {buildTimedDecision,evaluateQualificationGate} from "../server/waterx/timed-decision-builder";
import {createRoundDecisionTracker} from "../server/waterx/round-decision";
const start=1700000000000;
const round=(intervalMinutes:5|15)=>({intervalMinutes,roundId:`timed-${intervalMinutes}`,startMs:start,expiryMs:start+intervalMinutes*60000});
function samples(at:number,p=.8):LockObservation[]{
 return Array.from({length:13},(_,i)=>({atMs:at-60000+i*5000,receivedAtMs:at-60000+i*5000,
 providerSourceAtMs:null,probabilityUp:p,probabilityDown:1-p,sourceHealthy:true}));
}
test("versioned gates preserve both previous schedules without rewriting them",()=>{
 assert.equal(TIMED_STRATEGY,"waterx-qualification-gates-v3");
 assert.deepEqual(timedWindow(5,PREVIOUS_TIMED_STRATEGY),{targetSeconds:60,hardSeconds:90});
 assert.deepEqual(timedWindow(15,LEGACY_TIMED_STRATEGY),{targetSeconds:300,hardSeconds:450});
 assert.deepEqual(earlyHorizons(5),[30,60,90,120,150,180,210,240,270]);
 assert.equal(earlyHorizons(15).at(-1),870);
});
for(const interval of [5,15] as const){
 const r=round(interval),gate=start+60000;
 test(`${interval}m qualifies a scheduled gate without mandatory target waiting`,()=>{
   assert.equal(buildTimedDecision(r,samples(gate-1),start,gate-1,true),null);
   const d=buildTimedDecision(r,samples(gate),start,gate,true)!;
   assert.equal(d.status,"LOCKED");assert.equal(d.lockReason,"QUALIFIED_SCHEDULED_GATE");
   assert.equal(d.gateIndex,2);assert.equal(d.targetAtMs,gate);assert.equal(d.hardDeadlineAtMs,gate+2000);
 });
 test(`${interval}m weak observations never lock at old deadline, fallback window or expiry`,()=>{
   for(const elapsed of [60000,85000,90000,180000,297000,300000,interval*60000]){
     assert.equal(buildTimedDecision(r,samples(start+elapsed,.525),start,start+elapsed,true,{},true),null);
   }
 });
 test(`${interval}m ties remain ambiguous and cannot create a lock`,()=>{
   assert.equal(buildTimedDecision(r,samples(gate,.5),start,gate,true),null);
   assert.equal(evaluateQualificationGate(r,samples(gate,.5),2,gate).result,"WAIT_WEAK_EVIDENCE");
   assert.equal(evaluateTimedDecision(r,samples(gate,.5),gate).liveSide,null);
 });
 test(`${interval}m missed gates do not use later observations or disable later valid gates`,()=>{
   assert.equal(evaluateQualificationGate(r,samples(gate+3000),2,gate+3000).result,"MISSED_GATE");
   assert.equal(buildTimedDecision(r,samples(gate+3000),start,gate+3000,true),null);
   assert.equal(buildTimedDecision(r,samples(gate+30000),start,gate+30000,true)!.status,"LOCKED");
 });
 test(`${interval}m invalid latest input and stale evidence wait, without permanent failure choice`,()=>{
   assert.equal(evaluateQualificationGate(r,[],2,gate,false).result,"WAIT_FRESH_DATA");
   assert.equal(evaluateQualificationGate(r,samples(gate-20000),2,gate,true).result,"WAIT_FRESH_DATA");
   assert.equal(buildTimedDecision(r,[],start,gate,false),null);
 });
 test(`${interval}m feature cutoff excludes strong evidence after the scheduled gate`,()=>{
   const rows=[...samples(gate,.525),...samples(gate+1000,.9).filter(o=>o.receivedAtMs>gate)];
   assert.equal(evaluateQualificationGate(r,rows,2,gate+1000).result,"WAIT_WEAK_EVIDENCE");
 });
}
test("strengthening is distinguishable from oscillation and recent reversal",()=>{
 const r=round(5),at=start+60000;
 const growing=samples(at).map((o,i)=>({...o,probabilityUp:.74+i*.02,probabilityDown:1-(.74+i*.02)}));
 const state=evaluateTimedDecision(r,growing,at);
 assert.equal(state.components!.trendKind,"STRENGTHENING");assert.equal(state.qualified,true);
 const reversed=growing.map((o,i)=>i===11?{...o,probabilityUp:.2,probabilityDown:.8}:o);
 assert.equal(evaluateTimedDecision(r,reversed,at).components!.trendKind,"RECENT_REVERSAL");
 assert.equal(evaluateTimedDecision(r,reversed,at).qualified,false);
});
test("a genuine primary lock cannot be replaced or cross rollover",()=>{
 const r=round(5),at=start+60000,d=buildTimedDecision(r,samples(at),start,at,true)!;
 const t=createRoundDecisionTracker();t.discovered(r,at);t.timedSaved(r,d);
 t.timedSaved(r,{...d,id:"other",side:"DOWN"});
 assert.equal(t.read(r,at)!.timedDecision!.saved!.id,d.id);
 const next={...r,roundId:"next",startMs:r.expiryMs,expiryMs:r.expiryMs+300000};
 t.discovered(next,next.startMs);assert.equal(t.read(next,next.startMs)!.timedDecision!.saved,null);
});
test("unhealthy or pre-round rows cannot choose the frozen side or pollute its provenance",()=>{
 const r=round(5),at=start+60000;
 const input=[...samples(at),{...samples(at)[0],receivedAtMs:at,probabilityUp:.01,probabilityDown:.99,sourceHealthy:false}];
 const d=buildTimedDecision(r,input,start,at,true)!;
 assert.equal(d.side,"UP");assert.equal(d.probabilityUp,.8);
 assert.equal(evaluateQualificationGate(r,input,2,at).observationIds.length,13);
});
