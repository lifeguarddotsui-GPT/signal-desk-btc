import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {stageCaptureCause} from "../shared/stage-capture-status";
import {stageScore} from "../shared/waterx-round-identity";
import {assessStage,CONFIRMATION_ORDER_RESERVE_MS,type LearnedStagePolicy} from "../server/waterx/two-stage-policy";
import {createStageLearningWake,runStageLearningDay} from "../server/waterx/two-stage-schedule";
import {recoverStageSettlementQueue,recoverMissingStageRounds,recoverMissingStageAssessments} from "../server/waterx/two-stage-recovery";
import {TWO_STAGE_STRATEGY,type StageInput} from "../shared/two-stage";
import {stageIdentity,commitStage,readStageLocks} from "../server/waterx/two-stage-store";
import {createTwoStageRuntime} from "../server/waterx/two-stage-runtime";
import type {TimedInput} from "../server/waterx/timed-decision-store";

const start=1791493200000;
const policy:LearnedStagePolicy={version:"SYNTHETIC_TEST_ONLY",stage:"CONFIRMATION",interval:5,
  modelVersion:"SYNTHETIC_TEST_ONLY",trainedBeforeMs:start-1,featureVersion:"price-area-proxy-v1",
  minimumStrength:.85,outcome:{intercept:Math.log(.9/.1),coefficients:Array(8).fill(0)},
  calibration:{intercept:0,coefficients:[1]},selectedCalibrationN:100,selectedBothOutcomes:true,
  selectedBrier:.1,qualified:true,economicQuotesVerified:false};
function frame(id=randomUUID(),side:"UP"|"DOWN"="UP"):StageInput{
  return {marketId:"repair-fixture",roundId:id,intervalMinutes:5,startMs:start,expiryMs:start+300000,
    nowMs:start+30000,observations:Array.from({length:16},(_,i)=>({
      id:`${id}-${i}`,atMs:start+i*2000,receivedAtMs:start+i*2000,availableAtMs:start+i*2000,
      databaseAcceptedAtMs:null,providerSourceAtMs:null,provenance:"SYNTHETIC" as const,sourceHealthy:true,
      probabilityUp:side==="UP"?.8+i*.0005:.2-i*.0005,
      probabilityDown:1-(side==="UP"?.8+i*.0005:.2-i*.0005),
      features:{marketId:"repair-fixture",reference:100,referenceQuality:"provisional",
        comparison:{price:side==="UP"?101+i*.1:99-i*.1,asOf:new Date(start+i*2000).toISOString()},
        purchaseUp:{status:"reported",askCents:70},purchaseDown:{status:"reported",askCents:70}}
    }))};
}
test("a recovered incident does not turn a genuine policy abstention into a prediction loss",()=>{
  assert.equal(stageScore({side:null,outcome:"DOWN",settlementStatus:"VERIFIED",
    reason:"CONFIRMATION_POLICY_NOT_QUALIFIED",dataFailure:true}),"ABSTAINED");
  assert.equal(stageCaptureCause("CONFIRMATION_POLICY_NOT_QUALIFIED",true),"NO_QUALIFIED_SIGNAL");
  assert.equal(stageCaptureCause("NO_VALID_INPUT",true),"NO_VALID_INPUT");
  assert.equal(stageCaptureCause("MISSED_DEADLINE_DATABASE_FAILURE",true),"DATABASE_FAILURE");
  assert.equal(stageCaptureCause("MISSED_GATE",true),"MISSED_GATE");
  assert.equal(stageCaptureCause("SCHEDULER_FAILURE",true),"SCHEDULER_FAILURE");
  assert.equal(stageCaptureCause("MISSING_DURABLE_ASSESSMENT_AFTER_RECOVERY",true),"UNCLASSIFIED");
  assert.equal(stageCaptureCause("WAITING_FOR_FRESH_DATA",false),"OBSERVING");
  assert.equal(stageCaptureCause("CONFIRMATION_POLICY_NOT_QUALIFIED",false),"OBSERVING");
  assert.equal(stageCaptureCause("ROUND_EXPIRED",true),"UNCLASSIFIED");
});
test("strict Confirmation qualifies independently in both directions, never reusing absent policy",()=>{
  assert.equal(assessStage(frame(),"CONFIRMATION",null,policy).side,"UP");
  const down={...policy,outcome:{...policy.outcome,intercept:Math.log(.1/.9)}};
  assert.equal(assessStage(frame(undefined,"DOWN"),"CONFIRMATION",null,down).side,"DOWN");
  assert.equal(assessStage(frame(),"CONFIRMATION",null,null).eligible,false);
  assert.equal(assessStage(frame(),"CONFIRMATION",null,{...policy,selectedCalibrationN:59}).eligible,false);
});
test("non-complementary input is not normalized even when sourceHealthy claims true",()=>{
  const input=frame();input.observations.at(-1)!.probabilityDown=.285;
  assert.equal(assessStage(input,"CONFIRMATION",null,policy).eligible,false);
});
test("Confirmation retains time for an order and cannot qualify after expiry",()=>{
  const input=frame();
  assert.equal(assessStage({...input,nowMs:input.expiryMs-CONFIRMATION_ORDER_RESERVE_MS+1},
    "CONFIRMATION",null,policy).reason,"ABSTAINED_INSUFFICIENT_ORDER_TIME");
  assert.equal(assessStage({...input,nowMs:input.expiryMs},"CONFIRMATION",null,policy).eligible,false);
});
test("training wake coalesces overlapping requests, respects authority and retries outages with backoff",async()=>{
  let now=start,connected=0,run=0,released=0,fail=true,allowed=true,refreshed=0;
  const wake=createStageLearningWake({now:()=>now,allowed:()=>allowed,
    connect:async()=>{connected++;if(fail)throw new Error("fixture DB outage");
      return {query:async()=>({rows:[]}),release:()=>{released++;}} as any;},
    run:async()=>{run++;return "RECORDED";},refresh:async()=>{refreshed++;}});
  await Promise.all([wake.wake(),wake.wake(),wake.wake()]);assert.equal(connected,1);
  fail=false;await wake.wake();assert.equal(run,0);
  now+=300000;await wake.wake();assert.equal(run,2);assert.equal(released,1);assert.equal(refreshed,1);
  now+=3600000;allowed=false;await wake.wake();assert.equal(run,2);
});
test("database training lock prevents restart/replica duplicates and deficient reports remain ineligible",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1"},async()=>{
    const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});
    await db.query(readFileSync(new URL("../migrations/waterx-learning.sql",import.meta.url),"utf8"));
    await db.query(readFileSync(new URL("../migrations/waterx-reference-confirmations.sql",import.meta.url),"utf8"));
    await db.query(readFileSync(new URL("../migrations/waterx-two-stage.sql",import.meta.url),"utf8"));
    await db.query(readFileSync(new URL("../migrations/waterx-two-stage-prices.sql",import.meta.url),"utf8"));
    const client=await db.connect(),at=1891493200000;
    try{
      assert.equal(await runStageLearningDay(client,5,at),"RECORDED");
      assert.equal(await runStageLearningDay(client,5,at),"ALREADY_RECORDED");
      const reports=await db.query("SELECT report FROM waterx_two_stage_training WHERE interval_minutes=5 AND created_at_ms=$1",[at]);
      assert.equal(reports.rows.length,1);assert.equal(reports.rows[0].report.stages.CONFIRMATION.status,"NOT_QUALIFIED");
    }finally{client.release();await db.end();}
  });
test("official-settlement metadata recovery never creates retrospective predictions or odds",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1"},async()=>{
    const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1}),id=`repair-${randomUUID()}`;
    try{
      await db.query(readFileSync(new URL("../migrations/waterx-learning.sql",import.meta.url),"utf8"));
      await db.query(readFileSync(new URL("../migrations/waterx-two-stage.sql",import.meta.url),"utf8"));
      const input=frame(id);
      await db.query(`INSERT INTO waterx_two_stage_rounds(network,market_id,round_id,interval_minutes,strategy_version,
        start_ms,expiry_ms,discovered_at_ms,capture_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PROSPECTIVE')`,
        [...stageIdentity(input),input.startMs,input.expiryMs,input.nowMs]);
      await recoverStageSettlementQueue(db,input.expiryMs+1);
      await recoverStageSettlementQueue(db,input.expiryMs+2);
      const row=(await db.query("SELECT * FROM waterx_learning_rounds WHERE round_id=$1",[id])).rows[0];
      assert.equal(row.probability_up,null);assert.equal(row.anchor_price,null);assert.equal(row.outcome,null);
      assert.equal(row.label_status,"unresolved");
      assert.equal((await readStageLocks(input,db)).length,0);
    }finally{await db.end();}
  });
test("a qualified prospective Confirmation commits immutably without Early and survives reload",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1"},async()=>{
    const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1}),input=frame();
    const c=await db.connect();
    try{
      await c.query(readFileSync(new URL("../migrations/waterx-two-stage.sql",import.meta.url),"utf8"));
      await c.query(`INSERT INTO waterx_two_stage_rounds(network,market_id,round_id,interval_minutes,strategy_version,
        start_ms,expiry_ms,discovered_at_ms,capture_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'SYNTHETIC')`,
        [...stageIdentity(input),input.startMs,input.expiryMs,input.nowMs]);
      const saved=await commitStage(input,"CONFIRMATION",null,policy,c,()=>true,()=>input.nowMs);
      assert.equal(saved?.side,"UP");assert.equal(saved?.automaticExecutionAllowed,false);
      assert.ok(saved!.committedAtMs!<input.expiryMs-CONFIRMATION_ORDER_RESERVE_MS);
      assert.equal((await readStageLocks(input,c))[0].id,saved!.id);
      await assert.rejects(c.query("UPDATE waterx_two_stage_locks SET decision=decision WHERE id=$1",[saved!.id]),/immutable/);
    }finally{c.release();await db.end();}
  });
test("input buffering retries database failures without needing another provider observation",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1"},async()=>{
    const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
    let now=start+2000,fail=true;
    const wrapped={query:db.query.bind(db),connect:async()=>{if(fail)throw new Error("fixture connection failure");return db.connect();}};
    const runtime=createTwoStageRuntime({db:wrapped as any,now:()=>now,provenance:"SYNTHETIC"});
    const round=frame();
    const input:TimedInput={...round,receivedAtMs:now,observedAt:new Date(now).toISOString(),
      probabilityUp:.8,probabilityDown:.2,features:{marketId:round.marketId,synthetic:true}};
    try{
      await runtime.observe(input);assert.equal(runtime.health().failures,1);
      fail=false;now+=5000;runtime.tick();
      for(let n=0;n<100;n++){
        const r=await db.query("SELECT count(*)::int AS n FROM waterx_two_stage_observations WHERE round_id=$1",[round.roundId]);
        if(r.rows[0].n===1)break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal((await db.query("SELECT count(*)::int AS n FROM waterx_two_stage_observations WHERE round_id=$1",[round.roundId])).rows[0].n,1);
    }finally{await db.end();}
  });
test("round rollover retains failed work for deadline diagnostics without making a late lock",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1"},async()=>{
    const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
    let now=start+1000,fail=true;
    const runtime=createTwoStageRuntime({db:{query:db.query.bind(db),
      connect:async()=>{if(fail)throw new Error("fixture rollover failure");return db.connect();}} as any,
      now:()=>now,provenance:"SYNTHETIC"});
    const r=frame();
    const make=(round:StageInput):TimedInput=>({...round,receivedAtMs:now,observedAt:new Date(now).toISOString(),
      probabilityUp:.8,probabilityDown:.2,features:{marketId:round.marketId,synthetic:true}});
    try{
      await runtime.observe(make(r));
      now=r.expiryMs+1000;
      const next={...r,roundId:randomUUID(),startMs:r.expiryMs,expiryMs:r.expiryMs+300000};
      await runtime.observe(make(next));assert.equal(runtime.health().retiredPendingN,1);
      await new Promise(resolve=>setTimeout(resolve,0));
      fail=false;now+=5000;runtime.tick();
      for(let n=0;n<100&&runtime.health().retiredPendingN;n++)await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(runtime.health().retiredPendingN,0);
      const assessments=await db.query("SELECT reason FROM waterx_two_stage_assessments WHERE round_id=$1",[r.roundId]);
      assert.equal(assessments.rows.length,2);
      assert.ok(assessments.rows.every(row=>row.reason==="MISSED_DEADLINE_DATABASE_FAILURE"));
      assert.equal((await readStageLocks(r,db)).length,0);
    }finally{await db.end();}
  });
test("missing discovered lifecycle recovery copies identity only, never historical decisions",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1"},async()=>{
    const db=new pg.Client({connectionString:process.env.DATABASE_URL});
    await db.connect();
    const schema=`confirmation_recovery_${process.pid}`,id=randomUUID();
    try{
      await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path TO ${schema}`);
      // Required dependency of the full timed migration's legacy index.
      await db.query("CREATE TABLE bluewater_agent_ledger(owner text,round_key text,event text)");
      for(const file of ["waterx-timed-decisions.sql","waterx-two-stage.sql","waterx-two-stage-prices.sql"])
        await db.query(readFileSync(`migrations/${file}`,"utf8"));
      await db.query(`INSERT INTO waterx_two_stage_rounds(network,market_id,round_id,interval_minutes,strategy_version,
        start_ms,expiry_ms,discovered_at_ms,capture_mode)
        VALUES('sui:mainnet','fixture','launch',5,$1,$2,$3,$2,'PROSPECTIVE')`,
        [TWO_STAGE_STRATEGY,start-300000,start]);
      await db.query(`INSERT INTO waterx_timed_rounds VALUES('sui:mainnet','waterx-qualification-gates-v3',5,$1,$2,$3,$2)`,
        [id,start,start+300000]);
      await db.query(`INSERT INTO waterx_timed_observations VALUES('sui:mainnet','waterx-qualification-gates-v3',5,$1,$2,$3)`,
        [id,start+1000,JSON.stringify({features:{marketId:"repair-fixture"},probabilityUp:.8})]);
      assert.equal(await recoverMissingStageRounds(db,start+300001),1);
      assert.equal(await recoverMissingStageRounds(db,start+300001),0);
      await recoverMissingStageAssessments(db,start+300001);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM waterx_two_stage_locks")).rows[0].n,0);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM waterx_two_stage_observations")).rows[0].n,0);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM waterx_two_stage_assessments WHERE round_id=$1",[id])).rows[0].n,2);
    }finally{await db.query("ROLLBACK").catch(()=>{});
      await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();}
  });
