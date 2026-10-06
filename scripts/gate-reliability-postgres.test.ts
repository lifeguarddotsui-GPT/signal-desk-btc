import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {captureTimedDecision,loadTimedDecision} from "../server/waterx/timed-decision-store";
import {TIMED_STRATEGY} from "../shared/timed-decision";
import {earlyDeliveryMetrics} from "../server/waterx/early-delivery-metrics";
import {drainGateResearch} from "../server/waterx/gate-research-queue";

const safe=(()=>{try{const u=new URL(process.env.DATABASE_URL!);
  return u.hostname==="127.0.0.1"&&u.pathname==="/waterx_timed_test";
}catch{return false;}})();
for(const intervalMinutes of [5,15] as const){
  test(`${intervalMinutes}m isolated acquisition timeout, advisory contention, recovery and duplicate writers`,
    {skip:safe&&process.env.RUN_TIMED_POSTGRES_TESTS==="1"?false:"Disposable loopback waterx_timed_test required",timeout:20000},async()=>{
    const schema=`qa_reliability_${randomUUID().replaceAll("-","")}`;
    const admin=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2,
      connectionTimeoutMillis:100,options:`-c search_path=${schema} -c statement_timeout=1000`});
    try{
      await pool.query("CREATE TABLE bluewater_agent_ledger(owner text,round_key text,event text)");
      for(const file of ["waterx-timed-decisions.sql","waterx-early-horizons.sql",
        "early-training-retry.sql","waterx-qualification-gates.sql",
        "waterx-gate-horizons.sql","waterx-accepted-default-publish.sql"])
        await pool.query(readFileSync(`migrations/${file}`,"utf8"));
      const now=Date.now(),startMs=now-60000,roundId=randomUUID(),expiryMs=startMs+intervalMinutes*60000;
      const input={intervalMinutes,roundId,startMs,expiryMs,receivedAtMs:now,
        observedAt:new Date(now).toISOString(),probabilityUp:.8,probabilityDown:.2,
        discoveredAtMs:startMs+1000,features:{persistenceFailureCount:2}};
      await pool.query(`INSERT INTO waterx_timed_rounds VALUES('sui:mainnet',$1,$2,$3,$4,$5,$6)`,
        [TIMED_STRATEGY,intervalMinutes,roundId,startMs,expiryMs,startMs+1000]);
      for(let at=startMs;at<now;at+=5000)
        await pool.query(`INSERT INTO waterx_timed_observations VALUES('sui:mainnet',$1,$2,$3,$4,$5,$4)`,
          [TIMED_STRATEGY,intervalMinutes,roundId,at,JSON.stringify({...input,receivedAtMs:at})]);
      const one=await pool.connect(),two=await pool.connect();
      try{await assert.rejects(captureTimedDecision(input,pool),/timeout/i);}
      finally{one.release();two.release();}
      assert.equal(await loadTimedDecision(input,pool),null);
      const holder=await pool.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))",
        [["sui:mainnet",TIMED_STRATEGY,intervalMinutes,roundId].join(":")]);
      const contentionPool={query:pool.query.bind(pool),connect:async()=>{
        const c=await pool.connect();await c.query("SET statement_timeout=120");return c;
      }} as unknown as pg.Pool;
      try{await assert.rejects(captureTimedDecision(input,contentionPool),/timeout|canceling/i);}
      finally{await holder.query("ROLLBACK");holder.release();}
      assert.equal(await loadTimedDecision(input,pool),null);
      // Controlled policy clock; SQL contention/acquisition durations above
      // are real, but this is not evidence of a live two-second delivery SLA.
      const originalClock=Date.now;Date.now=()=>now;
      let a,b;
      try{[a,b]=await Promise.all([captureTimedDecision(input,pool),captureTimedDecision(input,pool)]);}
      finally{Date.now=originalClock;}
      assert(a&&b);assert.equal(a.id,b.id);assert.equal(a.status,"LOCKED");assert.equal(a.side,"UP");
      assert.equal(a.evidence.persistenceFailureCount,2);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM waterx_timed_decisions")).rows[0].n,1);
      const clock=Date.now;
      try{Date.now=()=>now+3000;await captureTimedDecision(input,pool);}finally{Date.now=clock;}
      const gates=await pool.query("SELECT journal FROM waterx_gate_journals ORDER BY gate_index");
      assert.equal(gates.rows.length,2);assert.equal(gates.rows[0].journal.result,"MISSED_GATE");
      assert.equal(gates.rows[1].journal.result,"QUALIFIED");
      assert(gates.rows.every(r=>r.journal.evidenceSnapshot.researchFreeze));
      const stages=earlyDeliveryMetrics().stages.filter(s=>s.interval===intervalMinutes);
      assert(stages.some(s=>s.stage==="DATABASE_ACQUISITION"&&s.failures>0));
      assert(stages.some(s=>s.stage==="DATABASE_LOCK_WAIT"&&s.failures>0));
      assert(stages.some(s=>s.stage==="DATABASE_TRANSACTION"&&s.failures>0));
    }finally{
      await drainGateResearch();await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    }
  });
}
