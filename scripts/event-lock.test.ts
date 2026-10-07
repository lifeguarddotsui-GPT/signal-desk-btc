import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {randomUUID} from "node:crypto";
import {readFileSync,mkdirSync,writeFileSync} from "node:fs";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {createEventLockRuntime} from "../server/waterx/event-lock-runtime";
import {readEventLock} from "../server/waterx/event-lock-store";
import {EVENT_LOCK_STRATEGY,EVENT_FEATURE_VERSION,eventQualification,type EventObservation} from "../shared/event-lock";
import {evaluateQualificationGate} from "../server/waterx/timed-decision-builder";
import {scoredTimedHistory} from "../server/waterx/timed-history";
import {timedPool} from "../server/waterx/timed-db";
import {researchPool} from "../server/waterx/research-store";
import {parseWaterxResponse} from "../server/waterx/source";
import {EventChallengerPanel} from "../client/src/EventChallengerPanel";
import {trainEventStopping,eventPartition,selectFirstSequential,type EventTrajectory} from "../server/waterx/event-lock-learning";
import {supportFractionExperiment} from "../server/waterx/event-stability-experiment";
import {decisionWriterAllowed,setDecisionWorkerLease} from "../server/waterx/decision-authority";
import type {TimedInput} from "../server/waterx/timed-decision-store";
import {earlyDeliveryMetrics} from "../server/waterx/early-delivery-metrics";
import {eventLockReport} from "../server/waterx/event-lock-report";

const row=(at:number,p=.8):EventObservation=>({id:String(at),atMs:at,receivedAtMs:at,availableAtMs:at,
  databaseAcceptedAtMs:null,providerSourceAtMs:null,probabilityUp:p,probabilityDown:1-p,
  sourceHealthy:true,provenance:"SYNTHETIC",features:{}});
test("event qualification changes timing, not thresholds; distinct identical values qualify and reversal/outage reset",()=>{
  for(const intervalMinutes of [5,15] as const){
    const r={intervalMinutes,roundId:"unit",startMs:0,expiryMs:intervalMinutes*60000};
    const times=intervalMinutes===5?[50000,56000,62000,68000,74000]:[191000,200000,209000,218000,227000,232000,236000];
    const observations=times.map(t=>row(t));
    assert.equal(eventQualification(r,observations,times.at(-1)!).qualified,true);
    const backwards=observations.map(o=>({...o,probabilityUp:.7,probabilityDown:.3}));
    assert.equal(eventQualification(r,backwards,times.at(-1)!).qualified,false);
    const reversed=[...observations,row(times.at(-1)!+1000,.2)];
    assert.equal(eventQualification(r,reversed,times.at(-1)!+1000).qualified,false);
    const outage=[...observations,{...row(times.at(-1)!+1000),sourceHealthy:false}];
    assert.equal(eventQualification(r,outage,times.at(-1)!+1000).qualified,false);
    assert.equal(eventQualification(r,[...outage,row(times.at(-1)!+2000)],times.at(-1)!+2000).qualified,false);
    assert.equal(eventQualification(r,observations,times.at(-1)!+11000).qualified,false);
  }
});
test("boundary embargo groups whole overlapping intervals; synthetic trajectories never train",()=>{
  const now=Date.UTC(2026,9,7),boundary=now-4*86400000;
  const make=(intervalMinutes:5|15,startMs:number):EventTrajectory=>({intervalMinutes,roundId:"split",startMs,
    expiryMs:startMs+intervalMinutes*60000,outcome:"UP",verified:true,labelAvailableAtMs:startMs+intervalMinutes*60000+1000,
    observations:[row(startMs+1000)]});
  assert.equal(eventPartition(make(15,boundary-60000),now),"EXCLUDED");
  assert.equal(eventPartition(make(5,boundary-60000),now),"EXCLUDED");
  assert.equal(eventPartition(make(5,boundary),now),"CALIBRATION");
  const report=trainEventStopping([make(5,boundary)],5,now);
  assert.equal(report.status,"INSUFFICIENT");
  assert.equal(report.excluded.syntheticOrReconstructed,1);
  assert.equal(report.automaticPromotion,false);
});
test("whole sequential policy selects FIRST stop or abstains, never hindsight-best",()=>{
  const outcome={intercept:0,coefficients:[1]},calibration={intercept:0,coefficients:[1]},
    stop={intercept:10,coefficients:[0,0]};
  const points=[{at:74,qualified:true,probability:.8,features:[2],outcome:"UP" as const},
    {at:90,qualified:true,probability:.99,features:[4],outcome:"UP" as const}];
  assert.equal(selectFirstSequential(points,outcome,calibration,stop)?.at,74);
  assert.equal(selectFirstSequential(points,outcome,calibration,{...stop,intercept:-10}),null);
});
test("one stability experiment exposes adverse moves and reversal rather than smoothing them",()=>{
  const result=supportFractionExperiment([row(60000,.73),row(68000,.82),row(74000,.79)],74000);
  assert.equal(result.active,false);assert.equal(result.componentPass,true);assert(result.maximumAdverseMove!>.029);
  assert.throws(()=>supportFractionExperiment([],0,.6));
});
test("outcome fit, calibration and stopping selection are invariant to final TEST labels",()=>{
  const now=Date.UTC(2026,9,7);
  // Laboratory fixture with a prospective-shaped schema, never persisted or
  // presented as prospective evidence.
  const trajectories:EventTrajectory[]=[10,4,3,2].flatMap(offset=>Array.from({length:60},(_,i)=>{
    const startMs=now-offset*86400000+i*900000,outcome=i%2?"UP" as const:"DOWN" as const;
    return {intervalMinutes:5 as const,roundId:`fixture-${offset}-${i}`,startMs,expiryMs:startMs+300000,
      verified:true,labelAvailableAtMs:startMs+301000,outcome,
      observations:[50,56,62,68,74,80,86,92].map(s=>({...row(startMs+s*1000,outcome==="UP"?.8:.2),
        provenance:"PROSPECTIVE" as const,features:{eventFeatureVersion:EVENT_FEATURE_VERSION}}))};
  }));
  const first=trainEventStopping(trajectories,5,now);
  const flipped=trainEventStopping(trajectories.map(r=>eventPartition(r,now)==="TEST"?
    {...r,outcome:r.outcome==="UP"?"DOWN":"UP"}:r),5,now);
  assert.equal(first.status,"EVALUATED");assert.equal(flipped.status,"EVALUATED");
  assert.deepEqual(first.artifact!.outcome,flipped.artifact!.outcome);
  assert.deepEqual(first.artifact!.calibration,flipped.artifact!.calibration);
  assert.deepEqual(first.artifact!.stopping,flipped.artifact!.stopping);
  assert.equal(first.artifact!.delayCost,flipped.artifact!.delayCost);
  assert.equal(first.automaticPromotion,false);
});
test("external-worker setting denies website decision writes until the leased worker owns authority",()=>{
  const old=process.env.WATERX_EXTERNAL_COLLECTOR;
  try{process.env.WATERX_EXTERNAL_COLLECTOR="true";setDecisionWorkerLease(false);
    assert.equal(decisionWriterAllowed(),false);setDecisionWorkerLease(true);assert.equal(decisionWriterAllowed(),true);
  }finally{setDecisionWorkerLease(false);if(old===undefined)delete process.env.WATERX_EXTERNAL_COLLECTOR;else process.env.WATERX_EXTERNAL_COLLECTOR=old;}
});

test("SYNTHETIC PostgreSQL: event locks between gates, commits once, survives outage/restart, scores both intervals/sides/outcomes",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1",timeout:60000},async t=>{
  const schema=`qa_event_${randomUUID().replaceAll("-","")}`,admin=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1}),
    db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:4,options:`-c search_path=${schema}`});
  const cases:Record<string,unknown>[]=[];
  const start=Math.floor(Date.now()/1000)*1000;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    await db.query("CREATE TABLE bluewater_agent_ledger(owner text,round_key text,event text)");
    for(const file of ["waterx-timed-decisions.sql","waterx-qualification-gates.sql","waterx-early-horizons.sql","early-training-retry.sql"])
      await db.query(readFileSync(new URL(`../migrations/${file}`,import.meta.url),"utf8"));
    await db.query(`CREATE TABLE waterx_learning_rounds(interval_minutes int,round_id text,start_ms bigint,expiry_ms bigint,
      outcome text,label_status text,settlement_disputed boolean,settlement_quarantine jsonb,
      settled_at bigint,first_verified_at timestamptz,settle_price float8,settlement_anchor_price float8)`);
    for(const intervalMinutes of [5,15] as const)for(const side of ["UP","DOWN"] as const)
      for(const outcome of ["UP","DOWN"] as const)await t.test(`${intervalMinutes}m ${side} → ${outcome}`,async()=>{
        const r={intervalMinutes,roundId:randomUUID(),startMs:start,expiryMs:start+intervalMinutes*60000},
          times=intervalMinutes===5?[50,56,62,68,74]:[191,200,209,218,227,232,236];
        let clock=start,releaseCommit:()=>void=()=>{},savingResolve:()=>void=()=>{};
        const savingReached=new Promise<void>(resolve=>{savingResolve=resolve;});
        const held=new Promise<void>(resolve=>{releaseCommit=resolve;});
        let hold=true;
        const wrapped={...db,connect:async()=>{
          const c=await db.connect();
          return {query:async(sql:string,args?:unknown[])=>{
            if(sql==="COMMIT"&&hold){savingResolve();await held;hold=false;}
            return c.query(sql,args);
          },release:()=>c.release()};
        }} as unknown as pg.Pool;
        const runtime=createEventLockRuntime({db:wrapped,archiveDb:db,now:()=>clock,provenance:"SYNTHETIC"});
        const probability=side==="UP"?.8:.2,observations:EventObservation[]=[];
        const input=(seconds:number,p:number|null=probability):TimedInput=>{
          clock=start+seconds*1000;
          const raw={success:true,data:{detail:{market:{slug:`crypto-btc-updown-${intervalMinutes}m`,marketId:"synthetic-event"},
            round:{id:r.roundId,marketId:"synthetic-event",startsAt:start/1000,endsAt:r.expiryMs/1000,phase:"live",anchorPrice:100,anchorPriceConfirmed:true,
              sides:[{key:"up",probabilityCents:p==null?null:p*100,oddsCents:p==null?null:80},
                {key:"down",probabilityCents:p==null?null:(1-p)*100,oddsCents:p==null?null:20}]},
              neighbors:{past:[],upcoming:[]}}}};
          const parsed=parseWaterxResponse(raw,intervalMinutes).round;
          return {...r,observedAt:new Date(clock).toISOString(),receivedAtMs:clock,
            probabilityUp:parsed.sides.up.probabilityCents==null?null:parsed.sides.up.probabilityCents/100,
            probabilityDown:parsed.sides.down.probabilityCents==null?null:parsed.sides.down.probabilityCents/100,
            features:{synthetic:true,decisionClockDomain:"synthetic-clock"}};
        };
        for(const seconds of times.slice(0,-1)){
          await runtime.observe(input(seconds));observations.push(row(clock,probability));
        }
        const last=input(times.at(-1)!),pending=runtime.observe(last);observations.push(row(clock,probability));
        await savingReached;
        assert.equal(runtime.read(r)!.state,"SAVING");assert.equal(await readEventLock(r,db),null);
        const savingHtml=renderToStaticMarkup(React.createElement(EventChallengerPanel,
          {projection:runtime.read(r),round:{id:r.roundId,...r},now:clock}));
        assert.match(savingHtml,/SAVING/);releaseCommit();await pending;await runtime.idle();
        const saved=runtime.read(r)!.saved!;assert(saved);assert.equal(saved.side,side);
        assert.equal(saved.elapsedMs,times.at(-1)!*1000);
        const priorGate=Math.floor(times.at(-1)!/30)*30,nextGate=priorGate+30;
        assert.notEqual(evaluateQualificationGate(r,observations,priorGate/30,start+priorGate*1000).result,"QUALIFIED");
        // Continue the SAME unchanged evidence stream to the next benchmark
        // gate; freezing the last receipt at 74s would instead create a stale
        // input at 90s, and must not be misreported as checkpoint waiting.
        if(intervalMinutes===5){
          for(const seconds of [80,86,89]){
            await runtime.observe(input(seconds));observations.push(row(clock,probability));
          }
        }
        assert.equal(evaluateQualificationGate(r,observations,nextGate/30,start+nextGate*1000).result,"QUALIFIED");
        await runtime.observe(last);assert.equal(runtime.read(r)!.duplicateDeliveries,1);
        const frozen=saved.probabilityUp;hold=false;
        await runtime.observe(input(nextGate+2,probability===.8?.9:.1));
        await runtime.observe(input(nextGate+4,null));await runtime.idle();
        assert.equal(runtime.read(r)!.saved!.probabilityUp,frozen);
        assert.match(renderToStaticMarkup(React.createElement(EventChallengerPanel,
          {projection:runtime.read(r),round:{id:r.roundId,...r},now:clock})),new RegExp(`LOCKED ${side}`));
        const counts=(await db.query(`SELECT (SELECT count(*) FROM waterx_timed_decisions WHERE round_id=$1)::int AS d,
          (SELECT count(*) FROM waterx_timed_outbox o JOIN waterx_timed_decisions d ON d.id=o.decision_id WHERE d.round_id=$1)::int AS o`,
          [r.roundId])).rows[0];assert.deepEqual(counts,{d:1,o:1});
        const child=await promisify(execFile)(process.execPath,["--import","tsx","--input-type=module","-e",`
          import pg from 'pg';import {readEventLock} from './server/waterx/event-lock-store.ts';
          const p=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+process.env.QA_SCHEMA});
          const d=await readEventLock(JSON.parse(process.env.QA_ROUND),p);
          console.log(JSON.stringify({id:d.id,side:d.side,probability:d.probabilityUp}));await p.end();process.exit(0);`],
          {cwd:process.cwd(),env:{PATH:process.env.PATH,DATABASE_URL:process.env.DATABASE_URL,QA_SCHEMA:schema,QA_ROUND:JSON.stringify(r)},timeout:10000});
        assert.equal(JSON.parse(child.stdout).id,saved.id);
        await db.query(`INSERT INTO waterx_learning_rounds VALUES($1,$2,$3,$4,$5,'verified',false,'[]',$6,
          to_timestamp($6::bigint::float8/1000),$7,100)`,
          [intervalMinutes,r.roundId,r.startMs,r.expiryMs,outcome,r.expiryMs+1000,outcome==="UP"?101:99]);
        const history=await scoredTimedHistory({interval:String(intervalMinutes),strategy:EVENT_LOCK_STRATEGY},
          r.expiryMs+2000,db);
        const entry=history.entries.find(e=>e.roundId===r.roundId)!;
        assert.equal(entry.result,side===outcome?"CORRECT":"INCORRECT");
        cases.push({intervalMinutes,side,outcome,eventElapsedSeconds:times.at(-1),benchmarkNextSeconds:nextGate,
          secondsCheckpointWaitRemoved:nextGate-times.at(-1)!,result:entry.result,decisionId:saved.id,
          persistedDecisions:counts.d,outbox:counts.o,restart:true,providerProof:false});
      });
    const makeInput=(r:{intervalMinutes:5;roundId:string;startMs:number;expiryMs:number},at:number,p=.8):TimedInput=>
      ({...r,receivedAtMs:at,observedAt:new Date(at).toISOString(),probabilityUp:p,probabilityDown:1-p,features:{synthetic:true}});
    await t.test("reversal before COMMIT vetoes the obsolete candidate; stale/late/out-of-order and rollover are separate",async()=>{
      const r={intervalMinutes:5 as const,roundId:randomUUID(),startMs:start,expiryMs:start+300000};let clock=start;
      let runtime:ReturnType<typeof createEventLockRuntime>,injected=false;
      const wrapped={connect:async()=>{
        const c=await db.connect();return {query:async(sql:string,args?:unknown[])=>{
          const result=await c.query(sql,args);
          if(sql.startsWith("INSERT INTO waterx_timed_outbox")&&!injected){
            injected=true;clock=start+75000;void runtime.observe(makeInput(r,clock,.2));
          }
          return result;
        },release:()=>c.release()};
      }} as unknown as pg.Pool;
      runtime=createEventLockRuntime({db:wrapped,archiveDb:db,now:()=>clock,provenance:"SYNTHETIC"});
      for(const s of [50,56,62,68,74]){clock=start+s*1000;await runtime.observe(makeInput(r,clock));}
      await runtime.idle();assert(injected);assert.equal(await readEventLock(r,db),null);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM waterx_timed_outbox")).rows[0].n,8);
      await runtime.observe(makeInput(r,start+72000));assert.equal(runtime.read(r)!.outOfOrderInputs,1);
      clock=start+200000;await runtime.observe(makeInput(r,start+76000));assert.equal(runtime.read(r)!.qualification.qualified,false);
      const future=makeInput(r,start+210000);await runtime.observe(future);assert.equal(runtime.read(r)!.saved,null);
      clock=r.expiryMs+1;await runtime.observe(makeInput(r,r.expiryMs));assert.equal(runtime.read(r)!.state,"ROUND_COMPLETE");
      const next={...r,roundId:randomUUID(),startMs:r.expiryMs,expiryMs:r.expiryMs+300000};
      await runtime.observe(makeInput(next,clock,.6));assert.equal(runtime.read(r),null);assert.equal(runtime.read(next)!.saved,null);
      const other={intervalMinutes:15 as const,roundId:randomUUID(),startMs:start,expiryMs:start+900000};
      await runtime.observe({...makeInput(next,clock,.6),...other});
      assert.equal(runtime.read(next)!.roundId,next.roundId);assert.equal(runtime.read(other)!.roundId,other.roundId);
    });
    await t.test("simultaneous writers share one immutable identity; recovery never invents a historical lock",async()=>{
      const r={intervalMinutes:5 as const,roundId:randomUUID(),startMs:start,expiryMs:start+300000};let clock=start;
      const writers=[0,1].map(()=>createEventLockRuntime({db,archiveDb:db,now:()=>clock,provenance:"SYNTHETIC"}));
      for(const s of [50,56,62,68,74]){clock=start+s*1000;await Promise.all(writers.map(w=>w.observe(makeInput(r,clock))));}
      const saved=await readEventLock(r,db);assert(saved);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM waterx_timed_decisions WHERE round_id=$1",[r.roundId])).rows[0].n,1);
      await Promise.all(writers.map(w=>w.recover()));assert(writers.some(w=>w.read(r)?.saved?.id===saved.id));
      // Other subtests have a different 5m identity at +300s. Use a later
      // actual slot so recovery cannot legitimately reject a conflicting UUID.
      const unlocked={...r,roundId:randomUUID(),startMs:start+600000,expiryMs:start+900000};
      clock=unlocked.startMs+200000;
      await db.query(`INSERT INTO waterx_timed_rounds VALUES('sui:mainnet',$1,5,$2,$3,$4,$3)`,
        [EVENT_LOCK_STRATEGY,unlocked.roundId,unlocked.startMs,unlocked.expiryMs]);
      await db.query(`INSERT INTO waterx_timed_observations(network,strategy_version,interval_minutes,round_id,received_at_ms,input)
        VALUES('sui:mainnet',$1,5,$2,$3,$4)`,[EVENT_LOCK_STRATEGY,unlocked.roundId,unlocked.startMs+74000,
          JSON.stringify(makeInput(unlocked,unlocked.startMs+74000))]);
      const restarted=createEventLockRuntime({db,archiveDb:db,now:()=>clock,provenance:"SYNTHETIC"});
      await restarted.recover();await restarted.observe(makeInput(unlocked,unlocked.startMs+74000));
      assert.equal(restarted.read(unlocked)!.saved,null);
      assert.equal(restarted.read(unlocked)!.qualification.qualified,false);assert.equal(await readEventLock(unlocked,db),null);
    });
    await t.test("lost COMMIT acknowledgement is read back, not inserted twice",async()=>{
      const r={intervalMinutes:5 as const,roundId:randomUUID(),startMs:start,expiryMs:start+300000};let clock=start,lost=false;
      const wrapped={connect:async()=>{
        const c=await db.connect();return {query:async(sql:string,args?:unknown[])=>{
          const result=await c.query(sql,args);
          if(sql==="COMMIT"&&!lost){lost=true;throw new Error("simulated acknowledgement transport loss");}
          return result;
        },release:()=>c.release()};
      }} as unknown as pg.Pool;
      const runtime=createEventLockRuntime({db:wrapped,archiveDb:db,now:()=>clock,provenance:"SYNTHETIC"});
      for(const s of [50,56,62,68,74]){clock=start+s*1000;await runtime.observe(makeInput(r,clock));}
      assert(lost);const saved=await readEventLock(r,db);assert(saved);assert.equal(runtime.read(r)!.saved!.id,saved.id);
      assert.equal(saved.acknowledgementStatus,"UNKNOWN");
      clock=start+80000;await runtime.observe(makeInput(r,clock));assert.equal((await db.query(
        "SELECT count(*)::int AS n FROM waterx_timed_decisions WHERE round_id=$1",[r.roundId])).rows[0].n,1);
    });
    await t.test("transient observation-insert failure keeps a bounded retry batch rather than dropping valid inputs",async()=>{
      const r={intervalMinutes:5 as const,roundId:randomUUID(),startMs:start,expiryMs:start+300000};let clock=start,failed=false;
      const wrapped={connect:async()=>{
        const c=await db.connect();return {query:async(sql:string,args?:unknown[])=>{
          if(sql.startsWith("INSERT INTO waterx_timed_observations")&&!failed){failed=true;throw new Error("transient insert timeout");}
          return c.query(sql,args);
        },release:()=>c.release()};
      }} as unknown as pg.Pool;
      const runtime=createEventLockRuntime({db:wrapped,archiveDb:db,now:()=>clock,provenance:"SYNTHETIC"});
      for(const s of [50,56,62,68,74]){clock=start+s*1000;await runtime.observe(makeInput(r,clock));}
      assert(failed);assert(runtime.read(r)!.saved);assert.equal(runtime.read(r)!.droppedInputs,0);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM waterx_timed_observations WHERE round_id=$1",[r.roundId])).rows[0].n,5);
    });
    await t.test("probability recovery must rebuild persistence; the outage is not a continuous forecast",async()=>{
      const r={intervalMinutes:5 as const,roundId:randomUUID(),startMs:start,expiryMs:start+300000};let clock=start;
      const runtime=createEventLockRuntime({db,archiveDb:db,now:()=>clock,provenance:"SYNTHETIC"});
      for(const s of [50,56,62]){clock=start+s*1000;await runtime.observe(makeInput(r,clock));}
      clock=start+68000;await runtime.observe({...makeInput(r,clock),probabilityUp:null,probabilityDown:null});
      for(const s of [74,80,86,92]){clock=start+s*1000;await runtime.observe(makeInput(r,clock));assert.equal(runtime.read(r)!.saved,null);}
      clock=start+98000;await runtime.observe(makeInput(r,clock));assert.equal(runtime.read(r)!.saved!.elapsedMs,98000);
    });
    mkdirSync("reports/event-lock",{recursive:true});
    const prospective=await eventLockReport(5,start+1000000,db);
    assert.equal(prospective.prospective.cohortN,0,"Synthetic decisions and synthetic no-lock rounds are not a prospective cohort");
    writeFileSync("reports/event-lock/synthetic-replay.json",JSON.stringify({mode:"SYNTHETIC",
      caveat:"Virtual application clocks; loopback PostgreSQL; parser/transaction/UI/restart/verified-history path. Benchmark timing is same-input pure-policy replay, not a prospective comparison or production latency.",
      latency:earlyDeliveryMetrics(),cases},null,2));
  }finally{await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    await timedPool.end();await researchPool.end();}
});
