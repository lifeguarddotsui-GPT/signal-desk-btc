import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readFileSync } from "node:fs";
import { lockPolicy, type LockObservation } from "../shared/lock-readiness";
import { evaluateLockReadiness } from "../server/waterx/lock-readiness";
import { captureLockObservation } from "../server/waterx/lock-store";
import { getLockReport } from "../server/waterx/lock-report";
import { maintainLockEvidence } from "../server/waterx/lock-maintenance";
import { freezeResearchDecision, unavailableComparison } from "../server/waterx/research-decision";
import { researchChoiceInsert, researchChoiceValues } from "../server/waterx/research-store";
import { pinResearchRoundPolicy } from "../server/waterx/research-lifecycle";

const url=process.env.WATERX_REFERENCE_CONFIRMATION_TEST_DATABASE_URL;
const safe=(()=>{try{const u=new URL(url!);return ["127.0.0.1","localhost","[::1]"].includes(u.hostname)&&
  /waterx_reference_test$/.test(u.pathname)&&!/production/i.test(u.pathname);}catch{return false;}})();
test("disposable PostgreSQL replays adaptive evidence, refuses forgery/backfill/mutation, and preserves baseline",{
  skip:safe?false:"Explicit disposable loopback waterx_reference_test database required.",
},async()=>{
  const db=new pg.Client({connectionString:url});await db.connect();
  const schema=`lock_test_${process.pid}`,prior=process.env.NODE_ENV;
  let writer:pg.Pool|undefined;
  try {
    process.env.NODE_ENV="development";
    await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path TO ${schema}`);
    for(const file of ["waterx-learning.sql","waterx-reference-confirmations.sql","waterx-research.sql",
      "waterx-research-lifecycle.sql","bluewater-research-architecture.sql","bluewater-lock-readiness.sql",
      "bluewater-lock-readiness.sql"])await db.query(readFileSync(`migrations/${file}`,"utf8"));
    const now=Date.now(),start=Math.floor(now/1000)*1000-230000,end=start+300000;
    const round={intervalMinutes:5 as const,roundId:"adaptive-fixture",startMs:start,expiryMs:end};
    const p=lockPolicy(5),values=[5,round.roundId,start,end];
    await db.query(`INSERT INTO bluewater_lock_policies(interval_minutes,round_id,start_ms,expiry_ms,policy)
      VALUES($1,$2,$3,$4,$5)`,[...values,JSON.stringify(p)]);
    const history:LockObservation[]=[];
    for(const ms of [24000,18000,12000,6000]){
      const o={atMs:now-ms,receivedAtMs:now-ms,providerSourceAtMs:null,probabilityUp:.73,probabilityDown:.27,sourceHealthy:true};
      history.push(o);
      const ready=evaluateLockReadiness(p,start,end,history,o.atMs);
      await db.query(`INSERT INTO bluewater_lock_observations
        (interval_minutes,round_id,start_ms,expiry_ms,observed_at_ms,received_at_ms,provider_source_at_ms,
        probability_up,probability_down,source_healthy,readiness)
        VALUES($1,$2,$3,$4,$5,$5,NULL,.73,.27,true,$6)`,[...values,o.atMs,JSON.stringify(ready)]);
    }
    writer=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:1});
    const at=Date.now(),last={atMs:at,receivedAtMs:at,providerSourceAtMs:null,probabilityUp:.73,probabilityDown:.27,sourceHealthy:true};
    await captureLockObservation(round,last,writer);
    const candidate=(await db.query("SELECT * FROM bluewater_lock_candidates WHERE checkpoint_seconds=0")).rows[0];
    assert.ok(candidate);assert.equal(candidate.status,"SHADOW");assert.equal(candidate.side,"UP");
    const timing=(await db.query("SELECT timing FROM bluewater_lock_latency WHERE kind='EARLY_CANDIDATE'")).rows[0].timing;
    assert.equal(timing.measurementVersion,"final-write-v1");
    assert.equal(timing.evaluationAtMs,Number(candidate.decision_at_ms));
    assert.ok(timing.transactionStartMs>=timing.evaluationAtMs);
    assert.equal((await db.query("SELECT count(*)::integer n FROM waterx_research_choices")).rows[0].n,0);
    assert.equal((await db.query("SELECT count(*)::integer n FROM waterx_research_champion_events")).rows[0].n,0);
    for(const table of ["bluewater_lock_policies","bluewater_lock_observations","bluewater_lock_candidates","bluewater_lock_latency"])
      await assert.rejects(db.query(`DELETE FROM ${table}`),/append-only/);
    await assert.rejects(db.query("UPDATE bluewater_lock_policies SET policy='{}'"),/append-only/);
    // Repeating a received observation neither rewrites policy nor creates a duplicate.
    await captureLockObservation(round,last,writer);
    assert.equal((await db.query("SELECT count(*)::integer n FROM bluewater_lock_candidates WHERE checkpoint_seconds=0")).rows[0].n,1);
    const report=await getLockReport(5,{id:round.roundId,startMs:start,expiryMs:end},true,db);
    assert.equal(report.current?.candidate?.side,"UP");assert.equal(report.comparison.state,"INSUFFICIENT");
    assert.equal(report.comparison.early.n,0);assert.equal(report.comparison.brierDifference,null);
    assert.equal(report.current?.readiness.state,"READY");
    const stale=await getLockReport(5,{id:round.roundId,startMs:start,expiryMs:end},false,db);
    assert.equal(stale.current?.readiness.health,"DATA/COLLECTOR DELAY");
    assert.notEqual(stale.current?.readiness.state,"READY");
    const wrong=await getLockReport(5,{id:round.roundId,startMs:start+1,expiryMs:end},true,db);
    assert.equal(wrong.current,null);
    const insert=`INSERT INTO bluewater_lock_candidates
      (interval_minutes,round_id,start_ms,expiry_ms,checkpoint_seconds,decision_at_ms,observed_at_ms,
        probability_up,side,policy_version,readiness)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
    const v=[...values,90,Number(candidate.decision_at_ms),last.atMs,.73,"UP",p.version,candidate.readiness];
    await assert.rejects(db.query(insert,v),/checkpoint missed/i);
    const changed=[...v];changed[4]=120;changed[7]=.9;
    await assert.rejects(db.query(insert,changed),/prospective READY/);
    const future=[...v];future[5]=Date.now()+10000;
    await assert.rejects(db.query(insert,future),/prospective READY/);
    const forged=[...v];forged[4]=0;forged[10]={...candidate.readiness,components:{...candidate.readiness.components,persistenceMs:999999}};
    await assert.rejects(db.query(insert,forged),/reproduce/);
    await assert.rejects(db.query(`INSERT INTO bluewater_lock_results
      (interval_minutes,round_id,checkpoint_seconds,event_type,outcome,label_available_at,brier,log_loss,correct)
      VALUES(5,$1,0,'SCORED','UP',clock_timestamp(),$2,$3,true)`,
    [round.roundId,(.73-1)**2,-Math.log(.73)]),/verified undisputed settlement/);
    await assert.rejects(db.query(`INSERT INTO bluewater_lock_policies(interval_minutes,round_id,start_ms,expiry_ms,policy)
      VALUES(5,'expired',$1,$2,$3)`,[now-600000,now-300000,JSON.stringify(p)]),/backfill/);
    await maintainLockEvidence(5,db);await maintainLockEvidence(5,db);
    assert.equal((await db.query("SELECT count(*)::integer n FROM bluewater_lock_diagnostics")).rows[0].n,2);
    assert.equal((await db.query("SELECT count(*)::integer n FROM bluewater_lock_results")).rows[0].n,0);
    const pinned=(await db.query("SELECT policy FROM bluewater_lock_policies")).rows[0].policy;
    assert.deepEqual(pinned,p);
    // The complete positive lifecycle uses the real database clock. No trigger
    // bypass, mocked expiry, or synthetic fixture is put in the application DB.
    await pinResearchRoundPolicy(db,round);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,end-60000-Date.now()+20)));
    const finalAt=Date.now(),choice=freezeResearchDecision({...round,anchorPrice:null,anchorConfirmed:false,
      probabilityUp:.7,probabilityDown:.3,observedAt:new Date(finalAt).toISOString()},finalAt,
      unavailableComparison("Disposable synthetic fixture"))!;
    assert.equal(choice.state,"FROZEN");await db.query(researchChoiceInsert,researchChoiceValues(choice));
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,end-Date.now()+20)));
    const settled=Date.now(),labelAt=new Date(settled);
    await db.query(`INSERT INTO waterx_learning_rounds
      (interval_minutes,round_id,start_ms,expiry_ms,observed_at,source_proof,label_status,outcome,
        settlement_anchor_price,settle_price,settled_at,first_verified_at)
      VALUES($1,$2,$3,$4,$5,'{"disposable_synthetic_fixture":true}','verified','Up',100,101,$6,$7)`,
    [...values,new Date(now),settled,labelAt]);
    await maintainLockEvidence(5,db);
    const scored=(await db.query("SELECT * FROM bluewater_lock_results")).rows[0];
    assert.equal(scored.event_type,"SCORED");assert.ok(Math.abs(scored.brier-(.73-1)**2)<1e-10);
    const matched=await getLockReport(5,null,true,db);
    assert.equal(matched.comparison.early.n,1);assert.equal(matched.comparison.canonical.n,1);
    assert.equal(matched.comparison.state,"INSUFFICIENT");
    assert.ok(Math.abs(matched.comparison.brierDifference!-((.73-1)**2-(.7-1)**2))<1e-10);
    assert.ok(matched.comparison.averageSecondsGained!>9);
    await db.query("UPDATE waterx_learning_rounds SET first_verified_at=NULL WHERE round_id=$1",[round.roundId]);
    await assert.rejects(db.query(`INSERT INTO bluewater_lock_results
      (interval_minutes,round_id,checkpoint_seconds,event_type,outcome,label_available_at,brier,log_loss,correct)
      VALUES(5,$1,0,'SCORED','UP',$2,$3,$4,true)`,
    [round.roundId,labelAt,(.73-1)**2,-Math.log(.73)]),/verified undisputed settlement/);
    await db.query("UPDATE waterx_learning_rounds SET first_verified_at=$1 WHERE round_id=$2",[labelAt,round.roundId]);
    await assert.rejects(db.query("DELETE FROM bluewater_lock_results"),/append-only/);
    await db.query(`UPDATE waterx_learning_rounds SET label_status='withheld',settlement_disputed=true WHERE round_id=$1`,[round.roundId]);
    await maintainLockEvidence(5,db);
    assert.equal((await db.query("SELECT count(*)::integer n FROM bluewater_lock_results WHERE event_type='WITHDRAWN'")).rows[0].n,1);
    assert.equal((await getLockReport(5,null,true,db)).comparison.early.n,0);
  } finally {
    if(writer)await writer.end();
    if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior;
    await db.query("SET search_path TO public");await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();
  }
});