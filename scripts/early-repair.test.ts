import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import pg from "pg";
import {assessStage,accumulatedFeatures,type LearnedStagePolicy} from "../server/waterx/two-stage-policy";
import {earlyCandidate,EARLY_DEFAULT_POLICY,EARLY_CANDIDATES} from "../server/waterx/early-policy";
import {candidateStillValid,readStageLocks} from "../server/waterx/two-stage-store";
import {createTwoStageRuntime} from "../server/waterx/two-stage-runtime";
import {createStagePolicyRegistry,STAGE_TRAINING_PROTOCOL} from "../server/waterx/two-stage-registry";
import {TWO_STAGE_FEATURES,type StageInput} from "../shared/two-stage";
import type {EventObservation} from "../shared/event-lock";
import type {TimedInput} from "../server/waterx/timed-decision-store";
import {evaluateEarlyCandidates,trainTwoStage} from "../server/waterx/two-stage-learning";
const start=1791300000000;
const fixture=(id="repair-fixture",up=.8):StageInput=>({marketId:"SYNTHETIC_TEST_MARKET",roundId:id,intervalMinutes:5,
  startMs:start,expiryMs:start+300000,nowMs:start+12000,observations:Array.from({length:7},(_,i)=>({
    id:`${id}-${i}`,atMs:start+i*2000,receivedAtMs:start+i*2000,availableAtMs:start+i*2000,
    databaseAcceptedAtMs:null,providerSourceAtMs:null,probabilityUp:up,probabilityDown:1-up,
    sourceHealthy:true,provenance:"SYNTHETIC" as const,features:{marketId:"SYNTHETIC_TEST_MARKET",
      reference:100,comparison:{price:100+i*.01,asOf:new Date(start+i*2000).toISOString()},
      purchaseUp:{status:"reported",askCents:98},purchaseDown:{status:"reported",askCents:98}}}))});
const policy=(stage:"EARLY"|"CONFIRMATION"="CONFIRMATION"):LearnedStagePolicy=>({
  version:"SYNTHETIC_TEST_ONLY",stage,interval:5,modelVersion:"SYNTHETIC_TEST_ONLY",
  trainedBeforeMs:start-1,featureVersion:TWO_STAGE_FEATURES,minimumStrength:.8,
  outcome:{intercept:Math.log(.9/.1),coefficients:Array(8).fill(0)},calibration:{intercept:0,coefficients:[1]},
  selectedCalibrationN:100,selectedBothOutcomes:true,selectedBrier:.1,qualified:true,economicQuotesVerified:false});
test("preferred records below-return and missing-return research; required abstains without changing trading eligibility",()=>{
  const r=fixture(),preferred=assessStage(r,"EARLY",null);
  assert.equal(preferred.eligible,true);assert.equal(preferred.valueStatus,"BELOW_PREFERRED");
  assert.equal(preferred.economics?.executionEligible,false);assert.equal(preferred.economics?.expectedNetUsd,null);
  const required=assessStage({...r,researchPreference:{mode:"REQUIRED",collateralUsd:5,minimumReturnUsd:6,preferredReturnUsd:7}},"EARLY",null);
  assert.equal(required.eligible,false);assert.match(required.diagnostics?.message??"",/below your \$6/);
  const absent={...r,observations:r.observations.map(o=>({...o,features:{...o.features,purchaseUp:{status:"unavailable"}}}))};
  assert.equal(assessStage(absent,"EARLY",null).eligible,true);
  assert.equal(assessStage(absent,"EARLY",null).valueStatus,"UNAVAILABLE");
});
test("preregistered event-driven 12s challenger differs from unchanged control; no deadline forces a weak lock",()=>{
  assert.equal(EARLY_CANDIDATES.length,6);
  const r=fixture();assert.equal(earlyCandidate(r,EARLY_DEFAULT_POLICY).qualified,true);
  assert.equal(earlyCandidate(r,"unchanged-event-control-v1").qualified,false);
  assert.equal(earlyCandidate(fixture("weak",.6)).qualified,false);
  const incomplete={...r,nowMs:start+4000,observations:r.observations.slice(0,3)};
  assert.match(earlyCandidate(incomplete).diagnostics.message,/8 seconds/);
});
test("identical repeated polls are availability receipts, not independent evidence; outages reset support",()=>{
  const r=fixture(),same={...r,observations:r.observations.map(o=>({...o,features:{marketId:r.marketId}}))};
  assert.equal(earlyCandidate(same).blocker,"IDENTICAL_EVIDENCE");
  const failed={...r,observations:r.observations.map((o,i)=>i===5?{...o,sourceHealthy:false}:o)};
  assert.equal(earlyCandidate(failed).qualified,false);
});
test("independent 3s prices repair odds-coupled 12s gaps without widening the 5s interpolation veto",()=>{
  const r=fixture(),sparse={...r,observations:[r.observations[0],r.observations[6]]};
  assert.equal(accumulatedFeatures(sparse).coverageFraction,0);
  const points=Array.from({length:5},(_,i)=>({id:`independent-${i}`,atMs:start+i*3000,
    receivedAtMs:start+i*3000+10,availableAtMs:start+i*3000+10,price:100+i*.01,
    reference:100,source:"SYNTHETIC_COINBASE_TEST"}));
  const repaired=accumulatedFeatures({...sparse,nowMs:start+12010,priceObservations:points});
  assert.equal(repaired.observedMs,12000);assert.ok(repaired.coverageFraction!>.99);
  assert.equal(repaired.maxSupportedGapMs,5000);assert.equal(repaired.rawObservationCoverage.medianSourceCadenceMs,3000);
  assert.equal(repaired.remainingReversalAveragePrice,null);
});
test("qualified forecast evaluation does not require an executable quote or fabricate positive EV",()=>{
  const r=fixture();const a=assessStage(r,"EARLY",null,policy("EARLY"));
  assert.equal(a.eligible,true);assert.equal(a.calibrationStatus,"QUALIFIED");
  assert.equal(a.economics?.kind,"INDICATIVE");assert.equal(a.economics?.expectedNetUsd,null);
  assert.equal(a.economics?.executionEligible,false);
});
test("version changes alone cannot starve a frozen candidate; material invalidation and freshness still veto",()=>{
  const r=fixture(),latest=r.observations.at(-1)!;
  const arrival={...latest,id:"NEW_REAL_RECEIPT",receivedAtMs:start+13000,availableAtMs:start+13000,probabilityUp:.81,probabilityDown:.19};
  assert.equal(candidateStillValid(r,arrival,start+13000),true);
  assert.equal(candidateStillValid(r,{...arrival,probabilityUp:.4,probabilityDown:.6},start+13000),false);
  assert.equal(candidateStillValid(r,{...arrival,sourceHealthy:false},start+13000),false);
  assert.equal(candidateStillValid(r,arrival,start+19000),false);
});
test("registry loads only matching stage/interval/cutoff/evidence, reloads after restart and rejects legacy selectors",async()=>{
  const p=policy(),report={protocol:STAGE_TRAINING_PROTOCOL,featureVersion:TWO_STAGE_FEATURES,datasetDigest:"a".repeat(64),
    selectorParity:true,artifacts:{CONFIRMATION:p},stages:{CONFIRMATION:{status:"QUALIFIED_SHADOW_ONLY",
      selectedCalibrationN:100,test:{n:100,brier:.1,observedUpRate:.5},matchedMarketBaseline:{brier:.2}}}};
  const db={query:async()=>({rows:[{interval_minutes:5,report}]})} as any;
  const registry=createStagePolicyRegistry();await registry.refresh(db,start+12000);
  assert.equal(registry.policy(fixture(),"CONFIRMATION")?.version,p.version);
  assert.equal(registry.policy({...fixture(),intervalMinutes:15},"CONFIRMATION"),null);
  assert.equal(registry.policy(fixture(),"EARLY"),null);
  const restarted=createStagePolicyRegistry();await restarted.refresh(db,start+13000);
  assert.equal(restarted.policy(fixture(),"CONFIRMATION")?.version,p.version);
  registry.ingest([{interval_minutes:5,report:{...report,protocol:"legacy-mismatched-selector"}}],start+14000);
  assert.equal(registry.policy(fixture(),"CONFIRMATION"),null);
  assert.match(registry.health().deficits["5:CONFIRMATION"],/failed validation/);
  registry.ingest([{interval_minutes:5,report:{...report,artifacts:{CONFIRMATION:{...p,trainedBeforeMs:start+999999}}}}],start+15000);
  assert.equal(registry.policy(fixture(),"CONFIRMATION"),null);
});
test("candidate evaluation is chronological and does not select from TEST; quote deficit is not forecast deficit",()=>{
  const result=evaluateEarlyCandidates([],start+86400000);
  assert.equal(result.selectedOnPolicy,null);assert.equal(result.automaticActivation,false);
  assert.equal(result.candidates.length,6);
  const training=trainTwoStage([],5,start+86400000);
  assert.equal(training.forecastRequiresExecutableQuotes,false);assert.equal(training.selectorParity,true);
});
test("late discovery is not backdated and missing odds cannot qualify",()=>{
  const r=fixture("late"),late={...r,nowMs:start+90000,
    observations:r.observations.map((o,i)=>({...o,atMs:start+78000+i*2000,receivedAtMs:start+78000+i*2000,
      availableAtMs:start+78000+i*2000}))};
  assert.equal(assessStage(late,"EARLY",null).eligible,true);
  assert.equal(late.nowMs-late.startMs,90000);
  assert.equal(assessStage({...late,observations:late.observations.map(o=>({...o,sourceHealthy:false}))},"EARLY",null).reason,
    "WAITING_FOR_FRESH_DATA");
  assert.equal(candidateStillValid(r,{...r.observations.at(-1)!,features:{reference:101}},r.nowMs),false);
});
test("an empty read-only recovery lookup never backs off the writer",async()=>{
  let connected=0;
  const db={query:async()=>({rows:[]}),connect:async()=>{
    connected++;return {query:async()=>({rows:[]}),release:()=>{}};
  }} as any;
  const r=fixture("empty-read"),runtime=createTwoStageRuntime({db,now:()=>start,provenance:"SYNTHETIC"});
  await runtime.restore(r);
  await runtime.observe({...r,receivedAtMs:start,observedAt:new Date(start).toISOString(),
    probabilityUp:.8,probabilityDown:.2,features:r.observations[0].features});
  assert.equal(connected,1);
});
test("isolated DB: qualification precedes slowed acquisition; eligible Confirmation loads and both stages restore without new odds",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1"},async()=>{
  const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3});
  for(const migration of ["waterx-two-stage.sql","waterx-two-stage-prices.sql"])
    await db.query(readFileSync(new URL(`../migrations/${migration}`,import.meta.url),"utf8"));
  let time=start,connectN=0,release!:()=>void,entered!:()=>void;
  const blocked=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
  const wrapped={query:db.query.bind(db),connect:async()=>{
    const c=await db.connect();if(++connectN===7){entered();await gate;}return c;
  }} as any;
  const runtime=createTwoStageRuntime({db:wrapped,now:()=>time,provenance:"SYNTHETIC",
    policies:()=>({CONFIRMATION:policy()})}),r=fixture("acquisition-"+Date.now());
  const input=(i:number):TimedInput=>{
    const at=start+i*2000;
    return {...r,observedAt:new Date(at).toISOString(),receivedAtMs:at,probabilityUp:.8,probabilityDown:.2,
      features:{...r.observations[0].features,comparison:{price:100+i*.01,asOf:new Date(at).toISOString()}}};
  };
  try{
    for(let i=0;i<6;i++){time=start+i*2000;await runtime.observe(input(i));}
    time=start+12000;const saving=runtime.observe(input(6));await blocked;
    assert.equal(runtime.read(r)?.early.persistence,"SAVING");
    assert.equal(runtime.read(r)?.early.lock,null);
    assert.equal(runtime.read(r)?.early.timing?.qualifiedAtMs,start+12000);
    time=start+14000;release();await saving;
    const early=runtime.read(r)?.early.lock!;assert.ok(early);
    assert.equal(early.qualifiedAtMs,start+12000);assert.equal(early.timing?.acquiredAtMs,start+14000);
    for(let i=7;i<=15;i++){time=start+i*2000;await runtime.observe(input(i));}
    assert.equal(runtime.read(r)?.confirmation.persistence,"COMMITTED");
    assert.equal(runtime.read(r)?.confirmation.lock?.calibrationStatus,"QUALIFIED");
    assert.equal(runtime.read(r)?.confirmation.lock?.economics.executionEligible,false);
    const original=(await readStageLocks(r,db)).map(l=>l.id).sort();assert.equal(original.length,2);
    time=start+60000;
    const readonly=createTwoStageRuntime({db:db as any,now:()=>time,provenance:"SYNTHETIC"});
    await readonly.restore(r);
    assert.equal(readonly.read(r)?.early.lock?.id,early.id);
    assert.equal(readonly.read(r)?.confirmation.persistence,"COMMITTED");
    assert.deepEqual((await readStageLocks(r,db)).map(l=>l.id).sort(),original);
  }finally{release();await db.end();}
});
test("isolated DB: lost COMMIT reply remains UNKNOWN until immutable row/outbox reconciliation, never a duplicate",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1"},async()=>{
  const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3});
  for(const migration of ["waterx-two-stage.sql","waterx-two-stage-prices.sql"])
    await db.query(readFileSync(new URL(`../migrations/${migration}`,import.meta.url),"utf8"));
  let time=start,uncertain=false,disconnected=false;
  const wrapped={query:db.query.bind(db),connect:async()=>{
    const c=await db.connect();return {release:()=>c.release(),query:async(sql:string,args?:any[])=>{
      if(disconnected&&sql.startsWith("SELECT d.decision"))throw new Error("synthetic connection loss");
      const result=await c.query(sql,args);
      if(sql==="COMMIT"&&!uncertain){uncertain=true;disconnected=true;throw new Error("synthetic lost COMMIT reply");}
      return result;
    }};
  }} as any;
  const r=fixture("uncertain-"+Date.now()),runtime=createTwoStageRuntime({db:wrapped,now:()=>time,provenance:"SYNTHETIC"});
  try{
    for(const o of r.observations){
      time=o.receivedAtMs;await runtime.observe({...r,receivedAtMs:time,observedAt:new Date(time).toISOString(),
        probabilityUp:o.probabilityUp,probabilityDown:o.probabilityDown,features:o.features});
    }
    assert.equal(runtime.read(r)?.early.persistence,"UNKNOWN");assert.equal(runtime.read(r)?.early.lock,null);
    const saved=await readStageLocks(r,db);assert.equal(saved.length,1);assert.equal(saved[0].committedAtMs,null);
    disconnected=false;time=start+18000;
    await runtime.observe({...r,receivedAtMs:time,observedAt:new Date(time).toISOString(),probabilityUp:.8,probabilityDown:.2,
      features:{...r.observations.at(-1)!.features,comparison:{price:100.09,asOf:new Date(time).toISOString()}}});
    assert.equal(runtime.read(r)?.early.persistence,"COMMITTED");
    assert.equal(runtime.read(r)?.early.lock?.id,saved[0].id);
    assert.equal((await readStageLocks(r,db)).length,1);
  }finally{await db.end();}
});
test("real isolated DB: continuous arrivals during a slowed write cannot starve durable lock; restart and rollover preserve identity",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1"},async()=>{
  const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3});
  for(const migration of ["waterx-two-stage.sql","waterx-two-stage-prices.sql"])
    await db.query(readFileSync(new URL(`../migrations/${migration}`,import.meta.url),"utf8"));
  let time=start,releaseWrite!:()=>void,enteredWrite!:()=>void,paused=false;
  const entered=new Promise<void>(resolve=>{enteredWrite=resolve;}),release=new Promise<void>(resolve=>{releaseWrite=resolve;});
  const wrapped={connect:async()=>{
    const c=await db.connect();return {release:()=>c.release(),query:async(sql:string,args?:any[])=>{
      if(sql.startsWith("INSERT INTO waterx_two_stage_locks")&&!paused){paused=true;enteredWrite();await release;}
      return c.query(sql,args);
    }};
  },query:db.query.bind(db)} as any;
  const runtime=createTwoStageRuntime({db:wrapped,now:()=>time,provenance:"SYNTHETIC"}),r=fixture("continuous-"+Date.now());
  const input=(o:EventObservation):TimedInput=>({...r,observedAt:new Date(o.receivedAtMs).toISOString(),
    receivedAtMs:o.receivedAtMs,probabilityUp:o.probabilityUp,probabilityDown:o.probabilityDown,features:o.features});
  try{
    for(const o of r.observations.slice(0,6)){time=o.receivedAtMs;await runtime.observe(input(o));}
    time=start+12000;const writing=runtime.observe(input(r.observations[6]));await entered;
    assert.equal(runtime.read(r)?.early.persistence,"SAVING");
    assert.equal(runtime.read(r)?.early.lock,null);
    for(let i=1;i<=20;i++){
      time=start+12000+i*100;
      const o={...r.observations[6],id:`arrival-${i}`,receivedAtMs:time,availableAtMs:time,
        features:{...r.observations[6].features,comparison:{price:100+.06+i*.001,asOf:new Date(time).toISOString()}}};
      void runtime.observe(input(o));
    }
    releaseWrite();await writing;
    const locks=await readStageLocks(r,db);assert.equal(locks.length,1);assert.equal(locks[0].side,"UP");
    assert.equal(locks[0].evidenceCutoffMs,start+12000);assert.equal(locks[0].commitVerified,true);
    assert.equal(locks[0].valueStatus,"BELOW_PREFERRED");
    time=start+15000;await runtime.observe(input({...r.observations[6],receivedAtMs:time,availableAtMs:time}));
    time++;
    const restarted=createTwoStageRuntime({db:db as any,now:()=>time,provenance:"SYNTHETIC"});
    await restarted.observe(input({...r.observations[6],receivedAtMs:time,availableAtMs:time}));
    assert.equal(restarted.read(r)?.early.lock?.id,locks[0].id);
    time=start+300000;
    const next={...input(r.observations[0]),roundId:r.roundId+"-next",startMs:time,expiryMs:time+300000,
      receivedAtMs:time,observedAt:new Date(time).toISOString()};
    await runtime.observe(next);assert.equal(runtime.read(r),null);
    assert.equal(runtime.read(next)?.early.lock,null);
    assert.equal((await readStageLocks(r,db))[0].id,locks[0].id);
  }finally{releaseWrite();await db.end();}
});
