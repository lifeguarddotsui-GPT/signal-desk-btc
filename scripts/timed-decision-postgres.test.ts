import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {captureTimedDecision,loadTimedDecision,consumeTimedDecisionReceipts} from "../server/waterx/timed-decision-store";
import {lockPool} from "../server/waterx/lock-store";
import {TIMED_STRATEGY} from "../shared/timed-decision";
test("isolated PostgreSQL proves serialized immutable timed lock/outbox, rollback, receipt and restart recovery",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1",timeout:30000},async()=>{
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
  const schema=`qa_timed_${randomUUID().replaceAll("-","")}`;
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:4,options:`-c search_path=${schema}`});
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query("CREATE TABLE bluewater_agent_ledger(owner text,round_key text,event text)");
    await pool.query(readFileSync(new URL("../migrations/waterx-timed-decisions.sql",import.meta.url),"utf8"));
    const now=Date.now(),start=now-125000,round={intervalMinutes:5 as const,roundId:randomUUID(),startMs:start,expiryMs:start+300000};
    // Test-only prospective observations; no production data or funded transaction.
    await pool.query(`INSERT INTO waterx_timed_rounds VALUES('sui:mainnet',$1,5,$2,$3,$4,$5)`,
      [TIMED_STRATEGY,round.roundId,start,round.expiryMs,start+1000]);
    for(let at=now-60000;at<now;at+=5000){
      const input={...round,receivedAtMs:at,observedAt:new Date(at).toISOString(),probabilityUp:.8,probabilityDown:.2};
      await pool.query(`INSERT INTO waterx_timed_observations VALUES('sui:mainnet',$1,5,$2,$3,$4)`,
        [TIMED_STRATEGY,round.roundId,at,JSON.stringify(input)]);
    }
    const input={...round,receivedAtMs:now,observedAt:new Date(now).toISOString(),probabilityUp:.8,probabilityDown:.2};
    const [a,b]=await Promise.all([captureTimedDecision(input,pool),captureTimedDecision(input,pool)]);
    assert(a&&b);assert.equal(a.id,b.id);assert.equal(a.side,"UP");assert.equal(a.onTime,true);
    const counts=await pool.query("SELECT (SELECT count(*) FROM waterx_timed_decisions) AS d,(SELECT count(*) FROM waterx_timed_outbox) AS o");
    assert.deepEqual(counts.rows[0],{d:"1",o:"1"});
    await assert.rejects(pool.query("UPDATE waterx_timed_decisions SET status='NO_VALID_INPUT'"),(e:{code:string})=>e.code==="23514");
    await consumeTimedDecisionReceipts(pool);
    const restored=await loadTimedDecision(round,pool);
    assert.equal(restored!.id,a.id);assert(restored!.workerReceivedAtMs);
    // Real PostgreSQL fallback preparation: weak valid evidence freezes before
    // the hard cutoff, rather than requiring a transaction starting at cutoff.
    const fallbackNow=Date.now(),fallbackStart=fallbackNow-146000;
    const fallbackRound={...round,roundId:randomUUID(),startMs:fallbackStart,expiryMs:fallbackStart+300000};
    let selected=0;
    const fallback=await captureTimedDecision({...input,...fallbackRound,receivedAtMs:fallbackNow,
      discoveredAtMs:fallbackStart+1000,observedAt:new Date(fallbackNow).toISOString(),
      probabilityUp:.56,probabilityDown:.44},pool,()=>{selected++;});
    assert(fallback);assert.equal(selected,1);
    assert.equal(fallback.lockReason,"DEADLINE_BEST_SUPPORTED_CHOICE");
    assert.equal(fallback.probabilityUp,.56);assert.equal(fallback.onTime,true);
    assert(fallback.decisionAtMs<fallback.hardDeadlineAtMs);
    assert(fallback.committedAtMs!<=fallback.hardDeadlineAtMs);
    const failedStart=Date.now()-160000;
    const failedRound={...round,roundId:randomUUID(),startMs:failedStart,expiryMs:failedStart+300000};
    await pool.query(`CREATE FUNCTION fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected event storage failure'; END $$;
      CREATE TRIGGER fail_outbox BEFORE INSERT ON waterx_timed_outbox FOR EACH ROW EXECUTE FUNCTION fail_outbox()`);
    await assert.rejects(captureTimedDecision({...input,...failedRound},pool),/Injected event storage failure/);
    assert.equal(await loadTimedDecision(failedRound,pool),null);
  }finally{
    await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await lockPool.end();
  }
});
