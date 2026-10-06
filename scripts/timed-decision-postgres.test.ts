import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {captureTimedDecision,loadTimedDecision,consumeTimedDecisionReceipts} from "../server/waterx/timed-decision-store";
import {lockPool} from "../server/waterx/lock-store";
import {TIMED_STRATEGY} from "../shared/timed-decision";
import {scoredTimedHistory} from "../server/waterx/timed-history";
import {buildTimedDecision,evaluateQualificationGate} from "../server/waterx/timed-decision-builder";
import {captureEarlyHorizons} from "../server/waterx/early-horizons";
import {drainGateResearch} from "../server/waterx/gate-research-queue";
import {runEarlyDailyTraining,earlyLearningReport} from "../server/waterx/early-training";
test("isolated PostgreSQL proves serialized immutable timed lock/outbox, rollback, receipt and restart recovery",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1",timeout:30000},async()=>{
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
  const schema=`qa_timed_${randomUUID().replaceAll("-","")}`;
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:4,options:`-c search_path=${schema}`});
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query("CREATE TABLE bluewater_agent_ledger(owner text,round_key text,event text)");
    await pool.query(readFileSync(new URL("../migrations/waterx-timed-decisions.sql",import.meta.url),"utf8"));
    await pool.query(readFileSync(new URL("../migrations/agent-durable-auth.sql",import.meta.url),"utf8"));
    await pool.query(readFileSync(new URL("../migrations/waterx-early-horizons.sql",import.meta.url),"utf8"));
    await pool.query(readFileSync(new URL("../migrations/early-training-retry.sql",import.meta.url),"utf8"));
    await pool.query(readFileSync(new URL("../migrations/waterx-qualification-gates.sql",import.meta.url),"utf8"));
    await pool.query(readFileSync(new URL("../migrations/waterx-gate-horizons.sql",import.meta.url),"utf8"));
    await pool.query(readFileSync(new URL("../migrations/waterx-accepted-default-publish.sql",import.meta.url),"utf8"));
    const storedDefault=(await pool.query(`SELECT pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attrdef d
      JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
      WHERE d.adrelid='waterx_timed_observations'::regclass AND a.attname='accepted_at_ms'`)).rows[0].expression as string;
    // Keep casts out of nested defaults: Publish truncated the original numeric
    // cast inside epoch*1000, producing an unbalanced ADD COLUMN statement.
    assert.equal((storedDefault.match(/::/g)??[]).length,1);
    assert.match(storedDefault,/\/ 0\.001/);assert.match(storedDefault,/::bigint$/);
    const nonce="0".repeat(64);
    await pool.query(`INSERT INTO bluewater_agent_challenges(token_hash,owner,origin,network,expires_at)
      VALUES($1,'test-owner','https://qa.invalid','sui:mainnet',clock_timestamp()+interval '2 minutes')`,[nonce]);
    const consume=()=>pool.query(`UPDATE bluewater_agent_challenges SET consumed_at=clock_timestamp()
      WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING token_hash`,[nonce]);
    const consumed=await Promise.all([consume(),consume()]);
    assert.equal(consumed.reduce((sum,r)=>sum+r.rows.length,0),1);
    assert.equal((await consume()).rows.length,0);
    const now=Date.now(),start=now-60000,round={intervalMinutes:5 as const,roundId:randomUUID(),startMs:start,expiryMs:start+300000};
    // Test-only prospective observations; no production data or funded transaction.
    await pool.query(`INSERT INTO waterx_timed_rounds VALUES('sui:mainnet',$1,5,$2,$3,$4,$5)`,
      [TIMED_STRATEGY,round.roundId,start,round.expiryMs,start+1000]);
    for(let at=now-60000;at<now;at+=5000){
      const input={...round,receivedAtMs:at,observedAt:new Date(at).toISOString(),probabilityUp:.8,probabilityDown:.2};
      await pool.query(`INSERT INTO waterx_timed_observations VALUES('sui:mainnet',$1,5,$2,$3,$4,$3)`,
        [TIMED_STRATEGY,round.roundId,at,JSON.stringify(input)]);
    }
    const input={...round,receivedAtMs:now,observedAt:new Date(now).toISOString(),probabilityUp:.8,probabilityDown:.2};
    const [a,b]=await Promise.all([captureTimedDecision(input,pool),captureTimedDecision(input,pool)]);
    assert(a&&b);assert.equal(a.id,b.id);assert.equal(a.side,"UP");
    // A losing concurrent writer may read the committed choice before the
    // producer journals its acknowledgement; UNKNOWN is honest in that race.
    assert([a,b].some(d=>d.onTime===true&&d.acknowledgementStatus==="JOURNALED"));
    assert.equal((await loadTimedDecision(round,pool))!.onTime,true);
    const counts=await pool.query("SELECT (SELECT count(*) FROM waterx_timed_decisions) AS d,(SELECT count(*) FROM waterx_timed_outbox) AS o");
    assert.deepEqual(counts.rows[0],{d:"1",o:"1"});
    await assert.rejects(pool.query("UPDATE waterx_timed_decisions SET status='NO_VALID_INPUT'"),(e:{code:string})=>e.code==="23514");
    await consumeTimedDecisionReceipts(pool);
    const restored=await loadTimedDecision(round,pool);
    assert.equal(restored!.id,a.id);assert(restored!.workerReceivedAtMs);
    await pool.query(`CREATE TABLE waterx_learning_rounds(interval_minutes int,round_id text,start_ms bigint,expiry_ms bigint,
      outcome text,label_status text,settlement_disputed boolean,settlement_quarantine jsonb,
      settled_at bigint,first_verified_at timestamptz,settle_price float8,settlement_anchor_price float8)`);
    for(const [i,outcome]of ["UP","DOWN"].entries()){
      const oldStart=now-3600000-i*300000,old={...round,roundId:randomUUID(),startMs:oldStart,expiryMs:oldStart+300000};
      const at=oldStart+60000,observations=Array.from({length:13},(_,i)=>({atMs:at-i*5000,receivedAtMs:at-i*5000,
        providerSourceAtMs:null,probabilityUp:.8,probabilityDown:.2,sourceHealthy:true}));
      const d=buildTimedDecision(old,observations,oldStart,at,true)!;
      await pool.query("INSERT INTO waterx_timed_rounds VALUES('sui:mainnet',$1,5,$2,$3,$4,$3)",[TIMED_STRATEGY,old.roundId,old.startMs,old.expiryMs]);
      await pool.query(`INSERT INTO waterx_timed_decisions VALUES($1,'sui:mainnet',$2,5,$3,$4,'LOCKED',$5)`,
        [d.id,TIMED_STRATEGY,old.roundId,at,JSON.stringify(d)]);
      await pool.query("INSERT INTO waterx_timed_outbox(decision_id,committed_ack_at_ms) VALUES($1,$2)",[d.id,at+10000]); // Correctness and late delivery independent.
      await pool.query(`INSERT INTO waterx_learning_rounds VALUES(5,$1,$2,$3,$4,'verified',false,'[]',$5::bigint,to_timestamp($5::bigint::float8/1000),$6,100)`,
        [old.roundId,old.startMs,old.expiryMs,outcome,old.expiryMs+1000,outcome==="UP"?101:99]);
    }
    const scored=await scoredTimedHistory({interval:"5",limit:1},Date.now(),pool);
    assert.equal(scored.entries.length,1);
    assert.equal(scored.metrics.correct,1);assert.equal(scored.metrics.incorrect,1);
    assert.equal(scored.metrics.settledN,2);assert.equal(scored.metrics.hitRate,.5);assert.equal(scored.metrics.missed,2);
    await pool.query("UPDATE waterx_learning_rounds SET settlement_disputed=true WHERE outcome='UP'");
    const disputed=await scoredTimedHistory({interval:"5"},Date.now(),pool);
    assert.equal(disputed.metrics.disputed,1);assert.equal(disputed.metrics.settledN,1);
    await pool.query("UPDATE waterx_learning_rounds SET label_status='withdrawn' WHERE outcome='DOWN'");
    assert.equal((await scoredTimedHistory({interval:"5"},Date.now(),pool)).metrics.settledN,0);
    await captureEarlyHorizons(input,Date.now(),pool);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM waterx_early_horizons")).rows[0].n,2);
    await assert.rejects(pool.query("UPDATE waterx_early_horizons SET status='FROZEN'"),(e:{code:string})=>e.code==="23514");
    await runEarlyDailyTraining(Date.now(),pool);
    const learning=await earlyLearningReport(pool);
    assert.equal(learning.jobs.length,2);assert(learning.jobs.every(j=>j.status==="INSUFFICIENT"));
    assert.equal(learning.affectedArtifacts.length,0);
    await runEarlyDailyTraining(Date.now(),pool);
    assert.equal((await earlyLearningReport(pool)).jobs.length,2);
    // A same-day insufficient job retries when actual label eligibility changes.
    // These are isolated synthetic labels, not live settlement evidence.
    await pool.query(`INSERT INTO waterx_learning_rounds VALUES(5,$1,$2,$3,'UP','verified',false,NULL,
      $4,to_timestamp($5::bigint::float8/1000),101,100)`,
      [round.roundId,round.startMs,round.expiryMs,round.expiryMs+1000,round.expiryMs+2000]);
    const laterCutoff=Date.now()+600000;
    await runEarlyDailyTraining(laterCutoff,pool);
    const retried=await earlyLearningReport(pool);
    assert.equal(retried.jobs.length,3);
    const changed=retried.jobs.find(j=>Number(j.interval_minutes)===5&&Number(j.attempt)===2)!;
    assert.equal((changed.report as any).newEligibleSincePreviousAttempt,1);
    assert.equal((changed.report as any).funnel.selected,1);
    await runEarlyDailyTraining(laterCutoff,pool);
    assert.equal((await earlyLearningReport(pool)).jobs.length,3);
    // Weak evidence cannot freeze just because the former forced deadline passes.
    const fallbackNow=Date.now(),fallbackStart=fallbackNow-90000;
    const fallbackRound={...round,roundId:randomUUID(),startMs:fallbackStart,expiryMs:fallbackStart+300000};
    let selected=0;
    const fallback=await captureTimedDecision({...input,...fallbackRound,receivedAtMs:fallbackNow,
      discoveredAtMs:fallbackStart+1000,observedAt:new Date(fallbackNow).toISOString(),
      probabilityUp:.56,probabilityDown:.44},pool,()=>{selected++;});
    assert.equal(fallback,null);assert.equal(selected,0);
    // The current gate commits without waiting for older missed-gate recovery.
    // Outside grace, a subsequent capture records the old miss honestly.
    const clock=Date.now;
    try{Date.now=()=>now+3000;await captureTimedDecision(input,pool);}finally{Date.now=clock;}
    const journals=await pool.query("SELECT journal FROM waterx_gate_journals WHERE round_id=$1 ORDER BY gate_index",[round.roundId]);
    assert.equal(journals.rows.length,2);
    assert.equal(journals.rows[1].journal.decisionId,a.id);
    await assert.rejects(pool.query("UPDATE waterx_gate_journals SET result='QUALIFIED'"),(e:{code:string})=>e.code==="23514");
    const failedStart=Date.now()-301000;
    const failedRound={...round,roundId:randomUUID(),startMs:failedStart,expiryMs:failedStart+300000};
    // Recovery has a four-gate transaction budget. Previous immutable misses
    // stay committed if a later final/outbox transaction fails.
    const failedInput={...input,...failedRound,receivedAtMs:failedStart+270000};
    await captureTimedDecision(failedInput,pool);
    await captureTimedDecision(failedInput,pool);
    await pool.query(`CREATE FUNCTION fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected event storage failure'; END $$;
      CREATE TRIGGER fail_outbox BEFORE INSERT ON waterx_timed_outbox FOR EACH ROW EXECUTE FUNCTION fail_outbox()`);
    await assert.rejects(captureTimedDecision({...input,...failedRound,receivedAtMs:failedStart+270000},pool),/Injected event storage failure/);
    assert.equal(await loadTimedDecision(failedRound,pool),null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM waterx_gate_journals WHERE round_id=$1",[failedRound.roundId])).rows[0].n,8);
    await pool.query("DROP TRIGGER fail_outbox ON waterx_timed_outbox");
    const recovered=await captureTimedDecision({...input,...failedRound,receivedAtMs:failedStart+270000},pool);
    assert.equal(recovered!.status,"DATA_FAILURE");assert.equal(recovered!.side,null);
    // Synthetic durable history models nine successfully evaluated weak gates,
    // not nine independent outcomes and not a fabricated prospective collection.
    const abstain={...failedRound,roundId:randomUUID()};
    await pool.query("INSERT INTO waterx_timed_rounds VALUES('sui:mainnet',$1,5,$2,$3,$4,$3)",
      [TIMED_STRATEGY,abstain.roundId,abstain.startMs,abstain.expiryMs]);
    for(let index=1;index<=9;index++){
      const at=abstain.startMs+index*30000,observation={atMs:at,receivedAtMs:at,providerSourceAtMs:null,
        probabilityUp:.525,probabilityDown:.475,sourceHealthy:true};
      const gate=evaluateQualificationGate(abstain,[observation],index,at+1);
      await pool.query(`INSERT INTO waterx_gate_journals VALUES('sui:mainnet',$1,5,$2,$3,$4,$5,$4,$6,NULL,$7)`,
        [TIMED_STRATEGY,abstain.roundId,index,at,at+1,gate.result,JSON.stringify(gate)]);
    }
    const abstained=await captureTimedDecision({...input,...abstain,receivedAtMs:abstain.startMs+270000},pool);
    assert.equal(abstained!.status,"ABSTAINED_NO_QUALIFIED_SIGNAL");assert.equal(abstained!.side,null);
    assert.equal(abstained!.onTime,null);
  }finally{
    await drainGateResearch();
    await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await lockPool.end();
  }
});
