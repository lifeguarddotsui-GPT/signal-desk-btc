import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lockPolicy, type LockObservation } from "../shared/lock-readiness";
import { evaluateLockReadiness, lockLatency, validateLockPolicy } from "../server/waterx/lock-readiness";
import { createLockTimers } from "../server/waterx/lock-timers";
import { speedForRound, getLockReport, lockMatchedSql } from "../server/waterx/lock-report";

const start=1_800_000_000_000,end=start+300_000,now=end-95_000,p=lockPolicy(5);
const obs=(atMs:number,up=.73):LockObservation=>({atMs,receivedAtMs:atMs,providerSourceAtMs:null,
  probabilityUp:up,probabilityDown:1-up,sourceHealthy:true});
const stable=[24,18,12,6,0].map(s=>obs(now-s*1000));
const evaluate=(rows:LockObservation[],at=now,policy=p)=>evaluateLockReadiness(policy,start,end,rows,at);
test("fallbacks and experimental checkpoints remain exactly 60/180 and requested research windows",()=>{
  assert.deepEqual(p.windows,[120,90,60]);assert.deepEqual(lockPolicy(15).windows,[360,300,240,180]);
  assert.equal(p.fallbackSeconds,60);assert.equal(lockPolicy(15).fallbackSeconds,180);
});
test("one short-lived 70 percent spike cannot early lock",()=>{
  const r=evaluate([obs(now,.70)]);assert.notEqual(r.state,"READY");assert.ok(r.score<100);assert.equal(r.sameSideMs,0);
});
test("fresh stable persistent signal becomes READY without independent model claim",()=>{
  const r=evaluate(stable);assert.equal(r.state,"READY");assert.equal(r.score,100);assert.equal(r.side,"UP");
  assert.equal(r.probability,.73);assert.equal(r.sameSideMs,24000);assert.equal(r.health,"WAITING FOR EVIDENCE");
});
test("strength and duration thresholds monotonically relax only within pinned early window",()=>{
  const a=evaluate(stable,end-120000),b=evaluate(stable,end-61000);
  assert.ok(a.components.requiredStrength>b.components.requiredStrength);
  assert.ok(a.components.requiredPersistenceMs>b.components.requiredPersistenceMs);
  assert.equal(a.components.requiredStrength,.72);
});
test("strength below threshold reports precise directional condition",()=>{
  const r=evaluate(stable.map(o=>({...o,probabilityUp:.60,probabilityDown:.40})));
  assert.notEqual(r.state,"READY");assert.equal(r.reason,"Needs stronger directional separation");
});
test("recent reversal resets same-side timer",()=>{
  const r=evaluate([obs(now-12000,.72),obs(now-6000,.3),obs(now,.73)]);
  assert.equal(r.sameSideMs,0);assert.equal(r.components.reversals,2);assert.match(r.reason,/reversal/i);
});
test("missing observation gap is data delay, not evidence hesitation",()=>{
  const r=evaluate([obs(now-24000),obs(now)]);assert.equal(r.sameSideMs,0);
  assert.equal(r.health,"DATA/COLLECTOR DELAY");assert.match(r.reason,/gap/i);
});
test("gap recovery needs new observed persistence and then returns to evidence health",()=>{
  const r=evaluate([obs(now-45000),...stable]);assert.equal(r.state,"READY");assert.equal(r.components.gapReset,false);
});
test("stale cached observation cannot become READY as reporting clock advances",()=>{
  const r=evaluate(stable,now+11000);assert.notEqual(r.state,"READY");
  assert.equal(r.sameSideMs,24000);assert.match(r.reason,/fresh WaterX/);assert.equal(r.health,"DATA/COLLECTOR DELAY");
});
test("provider source age and failed source health independently block readiness",()=>{
  const r=evaluate(stable.map(o=>({...o,sourceHealthy:false})));assert.notEqual(r.state,"READY");
  assert.equal(r.health,"DATA/COLLECTOR DELAY");
  assert.notEqual(evaluate(stable.map(o=>({...o,providerSourceAtMs:o.atMs-11000}))).state,"READY");
});
test("oscillation/velocity and insufficient density cannot satisfy stability",()=>{
  const r=evaluate(stable.map((o,i)=>obs(o.atMs,i%2?.74:.85)));assert.notEqual(r.state,"READY");
  assert.equal(r.components.stable,false);
});
test("early candidate cannot occur before allowed window or at canonical fallback",()=>{
  assert.notEqual(evaluate(stable,end-121000).state,"READY");
  const fallback=evaluate([24,18,12,6,0].map(s=>obs(end-60000-s*1000)),end-60000);
  assert.notEqual(fallback.state,"READY");assert.match(fallback.reason,/fallback/);
});
test("conditional lock time solves relaxing persistence curve and never invents elapsed observations",()=>{
  const rows=[24,18,12,6,0].map(s=>obs(now-s*1000,.68));
  const r=evaluate(rows);
  assert.equal(r.state,"LEANING");assert.ok(r.earliestPossibleAtMs!==null);
  assert.ok(r.earliestPossibleAtMs!>=now&&r.earliestPossibleAtMs!<end-60000);
  const expected=end-120000+(.72-.68)/(.72-.65)*60000;
  assert.ok(Math.abs(r.earliestPossibleAtMs!-expected)<=1);
  assert.equal(evaluate(rows.map(o=>({...o,probabilityUp:.6,probabilityDown:.4}))).earliestPossibleAtMs,null);
});
test("UP tie convention does not make weak signal READY",()=>{
  const r=evaluate([obs(now,.5)]);assert.equal(r.side,"UP");assert.notEqual(r.state,"READY");
});
test("future receipts and observations are not usable point-in-time evidence",()=>{
  const r=evaluate([obs(now+1)]);assert.equal(r.probability,null);
  assert.equal(evaluate([{...obs(now),receivedAtMs:now+1}]).probability,null);
});
test("duplicate timestamps and invalid policy are rejected rather than silently repaired",()=>{
  assert.throws(()=>evaluate([obs(now),obs(now)]),/Duplicate/);
  assert.throws(()=>validateLockPolicy({...p,fallbackSeconds:90}),/Invalid/);
  assert.throws(()=>validateLockPolicy({...p,lateStrength:.8}),/Invalid/);
});
test("persisted JSON replay reproduces all readiness components after restart",()=>{
  assert.deepEqual(evaluate(stable),evaluateLockReadiness(JSON.parse(JSON.stringify(p)),start,end,
    JSON.parse(JSON.stringify(stable)),now));
});
test("15-minute persistence uses its independent longer threshold",()=>{
  const q=lockPolicy(15),finish=start+900000,at=finish-300000;
  const rows=[48,42,36,30,24,18,12,6,0].map(s=>obs(at-s*1000));
  const r=evaluateLockReadiness(q,start,finish,rows,at);assert.equal(r.state,"READY");
  assert.ok(r.components.requiredPersistenceMs>20000);
});
test("latency exposes unknown provider tick timestamp rather than invented zero",()=>{
  const r=lockLatency("CANONICAL_LOCK",obs(now),now+20,now+25,now+40);
  assert.equal(r.providerToReceiptMs,null);assert.equal(r.receiptToEvaluationMs,20);
  assert.equal(r.measurementVersion,"final-write-v1");
  assert.equal(r.evaluationToTransactionMs,5);assert.equal(r.commitMs,15);assert.equal(r.totalMs,40);
  assert.throws(()=>lockLatency("OBSERVATION",obs(now),now-1,now,now),/order/);
});
test("round timers pre-arm lead/exact/bounded retry without fabricating a lock",async()=>{
  const scheduled:{fn:()=>void;delay:number;cancelled:boolean}[]=[],calls:number[]=[];
  const t=createLockTimers(async i=>{calls.push(i);},{now:()=>start,
    schedule:((fn:()=>void,delay:number)=>{const record={fn,delay,cancelled:false};scheduled.push(record);
      return record;}) as unknown as typeof setTimeout,
    cancel:((record:typeof scheduled[number])=>{record.cancelled=true;}) as unknown as typeof clearTimeout});
  const round={intervalMinutes:5 as const,roundId:"a",startMs:start,expiryMs:end};t.arm(round);
  assert.equal(scheduled.length,9);t.arm(round);assert.equal(scheduled.length,9);
  assert.ok(scheduled.some(r=>r.delay===180000));scheduled[0].fn();await Promise.resolve();assert.deepEqual(calls,[5]);
  t.arm({...round,roundId:"b"});assert.ok(scheduled.slice(0,9).every(r=>r.cancelled));
  scheduled[0].fn();assert.equal(calls.length,1);t.stop();assert.ok(scheduled.every(r=>r.cancelled));
});
test("speed/movement uses actual lean/final timestamps and chosen-side probabilities",()=>{
  const round={round_id:"a",start_ms:start,expiry_ms:end};
  const lean={actual_at_ms:now-24000,details:{probabilityUp:.6}};
  const rows=stable.map(o=>({observed_at_ms:o.atMs,probability_up:o.probabilityUp}));
  const r=speedForRound(round,rows,lean,{state:"FROZEN",side:"DOWN",probability_up:.3,decision_at_ms:now},
    {side:"DOWN",probability_up:.4},undefined);
  assert.equal(r.leanToFinalSeconds,24);assert.equal(r.secondsRemainingAtFinal,95);
  assert.equal(r.probabilityAtLean,.4);assert.equal(r.probabilityAtFinal,.7);
  assert.ok(Math.abs(r.marketMovementSinceLean!-.3)<1e-10);
});
test("matched scoring uses exact verified post-expiry undisputed identity, no model qualification",()=>{
  assert.match(lockMatchedSql,/USING\(interval_minutes,round_id,start_ms,expiry_ms\)/);
  assert.match(lockMatchedSql,/NOT l.settlement_disputed/);assert.match(lockMatchedSql,/settlement_quarantine/);
  assert.match(lockMatchedSql,/first_verified_at>/);
  const store=readFileSync("server/waterx/lock-store.ts","utf8");assert.doesNotMatch(store,/INSERT INTO waterx_research_choices|promote|signTransaction/);
});
test("canonical priority queue is independent of optional legacy persistence and inference in both runtimes",()=>{
  const service=readFileSync("server/waterx/service.ts","utf8"),store=readFileSync("server/waterx/research-store.ts","utf8");
  assert.match(service,/canonicalLockQueue=createWaterxBackgroundQueue/);
  assert.match(service,/captureResearchObservation\(input,\{deferEnrichment:true\}\)/);
  assert.match(service,/skipResearch:true/);
  assert.match(store,/if\(options\.deferEnrichment\)void enrichFinalChoice/);
  assert.ok(service.indexOf("canonicalLockQueue.enqueue(input)")<service.indexOf("observationQueue.enqueue(input)",service.indexOf("canonicalLockQueue.enqueue(input)")));
});
test("late evaluation is collector delay even when an old source tick was within the checkpoint",()=>{
  const store=readFileSync("server/waterx/lock-store.ts","utf8");
  assert.match(store,/evaluatedAtMs>target\+p\.captureGraceMs\)\?\s*"DATA_COLLECTOR_DELAY"/);
});
test("production readiness report reads research data and explicitly reports a missing schema",async()=>{
  const prior=process.env.NODE_ENV;process.env.NODE_ENV="production";
  let queried=false;
  try{const r=await getLockReport(5,null,true,{query:async()=>{
      queried=true;throw Object.assign(new Error("missing research table"),{code:"42P01"});}});
    assert.equal(queried,true);assert.equal(r.researchOnly,true);
    assert.equal(r.schemaStatus,"unavailable");assert.equal(r.counts.candidates,0);
    assert.match(r.reason??"",/schema is unavailable/);}
  finally{if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior;}
});