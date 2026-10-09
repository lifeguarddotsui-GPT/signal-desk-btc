import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync,mkdirSync,writeFileSync} from "node:fs";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {setImmediate as immediate} from "node:timers/promises";
import {createServer} from "node:http";
import pg from "pg";
import * as React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {timedPool} from "../server/waterx/timed-db";
import {researchPool} from "../server/waterx/research-store";
import {lockPool} from "../server/waterx/lock-store";
import {acceptLiveTimedObservation} from "../server/waterx/live-observation";
import {parseWaterxResponse,verifiedHistoricalRound} from "../server/waterx/source";
import {buildWaterxLivePayload} from "../server/waterx/service";
import {roundDecisions} from "../server/waterx/round-decision";
import {stopTimedStrategy,timedStrategyQueueMetrics,type GateScheduler} from "../server/waterx/timed-decision-coordinator";
import {drainGateResearch} from "../server/waterx/gate-research-queue";
import {recordWaterxRound,recordWaterxSettlement} from "../server/waterx/learning";
import {loadTimedDecision,loadGateJournals} from "../server/waterx/timed-decision-store";
import {scoredTimedHistory} from "../server/waterx/timed-history";
import {getAtomicDecisionView,validateLiveEnvelope} from "../client/src/live-decision-contract";
import {ManualOpportunity} from "../client/src/ManualOpportunity";
import {TimedStrategyHistoryView} from "../client/src/TimedStrategyHistory";
import type {WaterxRound} from "../server/waterx/types";
import type {TimedInput} from "../server/waterx/timed-decision-store";

test("SYNTHETIC isolated end-to-end parser → production ingestion/scheduler → SQL commit → HTTP/API → UI → process restart → verified History",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1",timeout:90000},async t=>{
  const url=new URL(process.env.DATABASE_URL??"");
  assert(["127.0.0.1","localhost","::1"].includes(url.hostname));
  assert.equal(url.pathname,"/waterx_timed_test");
  const schema=`qa_replay_${randomUUID().replaceAll("-","")}`;
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
  const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2,options:`-c search_path=${schema}`});
  for(const pool of [timedPool,researchPool]){
    (pool as unknown as {options:pg.PoolConfig}).options.options=`-c search_path=${schema}`;
  }
  const start0=Math.floor(Date.now()/1000)*1000;
  t.mock.timers.enable({apis:["Date"],now:start0});
  let current:{interval:5|15;round:WaterxRound;input:TimedInput}|null=null;
  const live=()=>{
    assert(current);
    return buildWaterxLivePayload(current.interval,{observedAt:current.input.observedAt,
      receivedAtMs:current.input.receivedAtMs,status:"LIVE",round:current.round,
      sourceError:null,reason:"SYNTHETIC ISOLATED REPLAY"},Date.now(),null);
  };
  const markup=(payload:ReturnType<typeof live>)=>renderToStaticMarkup(React.createElement(ManualOpportunity,{
    view:getAtomicDecisionView(payload,payload.intervalMinutes,payload.round,Date.now()),
    now:Date.now(),interval:payload.intervalMinutes,round:payload.round,
    comparison:{price:85125,source:"Synthetic independent Coinbase comparison",receivedAtMs:Date.now()}}));
  const server=createServer(async(req,res)=>{
    try{
      const parsed=new URL(req.url!,"http://isolated.invalid");
      const body=parsed.pathname==="/api/waterx/live"?live():
        await scoredTimedHistory({interval:parsed.searchParams.get("interval"),limit:200},Date.now(),db);
      res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");
      res.end(JSON.stringify(body));
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const httpLive=async()=>{
    const response=await fetch(`${origin}/api/waterx/live?interval=${current!.interval}`);
    assert.equal(response.status,200);
    const body=await response.json() as ReturnType<typeof live>;
    assert.equal(validateLiveEnvelope(body,current!.interval),null);return body;
  };
  const drain=async()=>{
    for(let n=0;timedStrategyQueueMetrics().depth&&n<4000;n++)await immediate();
    assert.equal(timedStrategyQueueMetrics().depth,0);
    assert.equal(timedStrategyQueueMetrics().failures,0);
    await drainGateResearch();
  };
  const proof:unknown[]=[];
  // Observe the real COMMIT, without replacing its success, failure or transaction.
  const originalConnect=timedPool.connect.bind(timedPool);
  let beforeCommit:ReturnType<typeof live>|null=null;
  const watchedClients=new WeakSet<object>();
  timedPool.connect=(async()=>{
    const client=await originalConnect();
    if(!watchedClients.has(client)){
      watchedClients.add(client);const query=client.query.bind(client);
      client.query=(async(...args:unknown[])=>{
        if(args[0]==="COMMIT"&&current&&live().decision?.timedDecision?.persistence==="SAVING"){
          beforeCommit=live();
          assert(!/class="desk-state-tag[^"]*" role="status">LOCKED/.test(markup(beforeCommit)));
          assert.match(markup(beforeCommit),/>SAVING</);
          const outside=(await db.query("SELECT count(*)::int AS n FROM waterx_timed_decisions WHERE round_id=$1 AND strategy_version='waterx-qualification-gates-v3'",
            [current.round.id])).rows[0].n;
          assert.equal(outside,0,"Uncommitted choice is invisible to an independent DB connection");
        }
        return (query as (...args:unknown[])=>Promise<unknown>)(...args);
      }) as typeof client.query;
    }return client;
  }) as typeof timedPool.connect;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    // Index-only dependency of early-horizons; this replay creates no accounts,
    // order submissions, funding, agent ledger events or trading authority.
    await db.query("CREATE TABLE bluewater_agent_ledger(owner text,round_key text,event text)");
    for(const migration of ["waterx-timed-decisions","waterx-early-horizons","early-training-retry",
      "waterx-qualification-gates","waterx-gate-horizons","waterx-accepted-default-publish",
      "waterx-learning","waterx-reference-confirmations"]){
      await db.query(readFileSync(`migrations/${migration}.sql`,"utf8"));
    }
    // Disposable SQL-clock simulator. Only the DB INSERT assigns acceptance;
    // the driver never inserts observations, decisions, outbox or verified labels.
    await db.query(`CREATE TABLE qa_clock(now_ms bigint NOT NULL);
      INSERT INTO qa_clock VALUES(${start0});
      CREATE FUNCTION qa_clock_ms() RETURNS bigint LANGUAGE sql AS 'SELECT now_ms FROM qa_clock';
      ALTER TABLE waterx_timed_observations ALTER COLUMN accepted_at_ms SET DEFAULT qa_clock_ms()`);
    let index=0;
    for(const interval of [5,15] as const)for(const side of ["UP","DOWN"] as const)for(const outcome of ["UP","DOWN"] as const){
      stopTimedStrategy();beforeCommit=null;
      const start=start0+index++*1200000,roundId=randomUUID();
      const identity={intervalMinutes:interval,roundId,startMs:start,expiryMs:start+interval*60000};
      const pending=new Map<number,{at:number;callback:()=>void}>();
      let timerId=0;
      const scheduler:GateScheduler={schedule(callback,delayMs){
        const id=++timerId;pending.set(id,{at:Date.now()+delayMs,callback});return ()=>pending.delete(id);
      }};
      const advance=async(at:number)=>{
        t.mock.timers.setTime(at);await db.query("UPDATE qa_clock SET now_ms=$1",[at]);
        for(const [id,timer] of pending)if(timer.at<=at){pending.delete(id);timer.callback();}
        await drain();
      };
      const feed=async(seconds:number,up:number|null)=>{
        await advance(start+seconds*1000);
        const raw={success:true,data:{detail:{market:{slug:`crypto-btc-updown-${interval}m`,marketId:`synthetic-${interval}`},
          round:{id:roundId,marketId:`synthetic-${interval}`,startsAt:start/1000,endsAt:identity.expiryMs/1000,
            phase:"ACTIVE",anchorPrice:85000,anchorPriceConfirmed:true,
            sides:[{key:"up",probabilityCents:up==null?null:up*100,oddsCents:up==null?null:55},
              {key:"down",probabilityCents:up==null?null:(1-up)*100,oddsCents:up==null?null:45}],
            settlement:null,settlePrice:null},neighbors:{past:[],upcoming:[]}}}};
        const parsed=parseWaterxResponse(raw,interval),round=parsed.round;
        const input:TimedInput={...identity,receivedAtMs:Date.now(),observedAt:new Date().toISOString(),
          probabilityUp:round.sides.up.probabilityCents==null?null:round.sides.up.probabilityCents/100,
          probabilityDown:round.sides.down.probabilityCents==null?null:round.sides.down.probabilityCents/100,
          anchorPrice:round.anchorPrice,anchorConfirmed:round.anchorPriceConfirmed,
          features:{synthetic:true,syntheticProviderPayload:raw}};
        current={interval,round,input};
        acceptLiveTimedObservation(input,round,null,scheduler);await drain();
        return httpLive();
      };
      const initial=side==="UP"?.82:.18,reverse=side==="UP"?.18:.82;
      let payload=await feed(0,initial);
      assert.equal(payload.decision!.currentStrategy!.provisionalLean,side);
      const firstLean=markup(payload);
      assert.match(firstLean,/Purchase price \(not probability\)/);
      assert.match(firstLean,/UP 55¢/);assert.match(firstLean,/DOWN 45¢/);
      payload=await feed(5,reverse);
      assert.equal(payload.decision!.currentStrategy!.provisionalLean,side==="UP"?"DOWN":"UP");
      assert((payload.decision!.timedDecision!.components?.sameSideMs??0)<=5000);
      assert.equal((await loadGateJournals(identity,db)).length,0,"Lean changes between gates");
      await feed(10,initial);
      for(const seconds of [15,20,25])await feed(seconds,initial);
      await advance(start+30000);
      assert.equal((await loadGateJournals(identity,db)).length,1,"Real scheduled callback evaluated gate");
      payload=await feed(35,null);
      const missing=markup(payload);
      assert.equal((missing.match(/Waiting for WaterX odds\./g)??[]).length,1);
      assert.match(missing,/Not evaluated: missing odds/);assert(!/4 conditions|0 of 4/.test(missing));
      assert.match(missing,/>WATCHING</);assert.match(missing,/85,125/);
      await feed(40,initial);
      assert.match(markup(await httpLive()),new RegExp(`>LEANING ${side}<`),"Provider recovery needs no reload/restart");
      for(let seconds=45;seconds<=125;seconds+=5)await feed(seconds,initial);
      const saved=await loadTimedDecision(identity,db);
      assert(saved);assert.equal(saved.status,"LOCKED");assert.equal(saved.side,side);
      assert.equal(saved.gateScheduledAtMs!%30000,start%30000);
      assert.equal(saved.onTime,true);assert(beforeCommit);
      assert.match(markup(await httpLive()),new RegExp(`>LOCKED ${side}<`));
      const lockId=saved.id,frozen=saved.probabilityUp;
      const later=await feed(130,reverse);
      assert.equal(later.decision!.market!.probabilityUp,reverse);
      assert.equal(later.decision!.timedDecision!.saved!.id,lockId);
      assert.equal(later.decision!.timedDecision!.saved!.probabilityUp,frozen);
      const lockedHtml=markup(later);
      const lockedOutage=markup(await feed(135,null));
      assert.match(lockedOutage,new RegExp(`>LOCKED ${side}<`));
      assert.equal((lockedOutage.match(/Waiting for WaterX odds\./g)??[]).length,1);
      assert.equal((await loadTimedDecision(identity,db))!.id,lockId);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM waterx_timed_decisions WHERE round_id=$1",[roundId])).rows[0].n,1);
      const child=await promisify(execFile)(process.execPath,["--import","tsx","scripts/lean-lock-restart-probe.ts",
        schema,roundId,String(Date.now()+1000)],{env:process.env,timeout:20000,maxBuffer:500000});
      const restarted=JSON.parse(child.stdout.split("\n").find(line=>line.startsWith("RESTART_PROOF="))!.slice(14));
      assert.notEqual(restarted.pid,process.pid);
      assert.equal(restarted.payload.decision.timedDecision.saved.id,lockId);
      assert.equal(restarted.outbox.length,1);assert(restarted.outbox[0].committed_ack_at_ms);
      assert.match(restarted.html,new RegExp(`>LOCKED ${side}<`));
      // Persist a normal round observation, then pass a parsed final response
      // through the real identity/settlement validation and transaction.
      assert(await recordWaterxRound({...identity,anchorPrice:85000,anchorConfirmed:true,
        probabilityUp:initial,observedAt:new Date(start).toISOString(),source:"WaterX"},db));
      await advance(identity.expiryMs+5000);
      const finalRaw=structuredClone(current!.input.features!.syntheticProviderPayload) as any;
      finalRaw.data.detail.round.phase="RESOLVED";
      finalRaw.data.detail.round.resolutionStatus="resolved";
      finalRaw.data.detail.round.settlePrice=outcome==="UP"?85100:84900;
      finalRaw.data.detail.round.settlement={outcome:outcome==="UP"?"Up":"Down",settledAt:identity.expiryMs/1000+4};
      const final=verifiedHistoricalRound(parseWaterxResponse(finalRaw,interval),roundId,identity.expiryMs/1000);
      assert(await recordWaterxSettlement({intervalMinutes:interval,roundId,anchorPrice:final.anchorPrice,
        anchorConfirmed:final.anchorPriceConfirmed,settlePrice:final.settlePrice,outcome:final.settlement?.outcome??null,
        settledAt:final.settlement?.settledAt==null?null:final.settlement.settledAt*1000,observedAt:new Date().toISOString(),
        resolutionStatus:final.resolutionStatus??undefined},db));
      const response=await fetch(`${origin}/api/waterx/timed-history?interval=${interval}`);
      assert.equal(response.status,200);const history=await response.json();
      const result=side===outcome?"CORRECT":"INCORRECT";
      assert.equal(history.entries.find((entry:any)=>entry.id===lockId).result,result);
      const historyHtml=renderToStaticMarkup(React.createElement(TimedStrategyHistoryView,{interval,
        current:history,older:null}));
      assert.match(historyHtml,new RegExp(`>${result}<`));
      const availability=await db.query(`SELECT count(*)::int AS late FROM waterx_gate_journals g,
        jsonb_array_elements(g.journal->'evidenceSnapshot'->'observations') e
        JOIN waterx_timed_observations o ON o.round_id=e->>'roundId' AND o.received_at_ms=(e->>'receivedAtMs')::bigint
        WHERE g.round_id=$1 AND o.accepted_at_ms>g.scheduled_at_ms`,[roundId]);
      assert.equal(availability.rows[0].late,0);
      proof.push({synthetic:true,interval,side,outcome,result,lockId,gateIndex:saved.gateIndex,
        committedAtMs:saved.committedAtMs,beforeCommit:beforeCommit!,afterCommit:later,restartPid:restarted.pid,
        firstLeanHtml:firstLean,missingOddsHtml:missing,lockedHtml,historyHtml,
        historyResult:history.entries.find((entry:any)=>entry.id===lockId),lateEvidence:0});
    }
    mkdirSync("reports/odds-sidebar-repair",{recursive:true});
    writeFileSync("reports/odds-sidebar-repair/synthetic-replay.json",JSON.stringify({
      evidenceType:"SYNTHETIC DISPOSABLE POSTGRESQL REPLAY, NOT LIVE PROVIDER EVIDENCE",
      parser:"parseWaterxResponse",ingestion:"production acceptLiveTimedObservation",
      scheduler:"production observeTimedStrategy; deterministic timer delivery",
      clocks:"Virtual application/SQL acceptance clocks in an isolated schema; no timestamps or records backfilled into production",
      databaseScope:"New loopback disposable cluster; no production writes, training or real performance denominators",
      cases:proof},null,2));
  }finally{
    stopTimedStrategy();await drainGateResearch();timedPool.connect=originalConnect;
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    t.mock.timers.reset();
    await Promise.all([timedPool.end(),researchPool.end(),lockPool.end(),db.end()]);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  }
});
