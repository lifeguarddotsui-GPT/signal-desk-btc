import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readFile } from "node:fs/promises";
import {
  WATERX_RESEARCH_POLICY as POLICY,
  createWaterxResearchConfig,
  type ResearchInterval,
} from "../shared/waterx-research";
import {
  freezeResearchDecision, unavailableComparison, type ResearchObservation,
} from "../server/waterx/research-decision";
import {
  captureResearchObservation, researchChoiceInsert, researchChoiceValues, scoreResearchChoices,
} from "../server/waterx/research-store";
import {
  getResearchHorizonEvaluations, getResearchLifecycleState, getResearchLiveObservation,
  researchHorizonEvaluationSelect,
} from "../server/waterx/research-lifecycle";

function observation(interval:ResearchInterval,now:number,expiry=now+60_000):ResearchObservation {
  const start=expiry-interval*60_000;
  return {intervalMinutes:interval,roundId:`lifecycle-${interval}-${start}`,startMs:start,expiryMs:expiry,
    anchorPrice:null,anchorConfirmed:false,probabilityUp:0.61,probabilityDown:0.39,
    observedAt:new Date(now).toISOString()};
}

test("development-only pure primary policy factory validates overrides and pins horizons",()=>{
  const defaults=createWaterxResearchConfig("development",{});
  assert.deepEqual(defaults.primaryLockSeconds,{5:60,15:180});
  const changed=createWaterxResearchConfig("development",{
    WATERX_RESEARCH_PRIMARY_LOCK_SECONDS_5M:"47",
    WATERX_RESEARCH_PRIMARY_LOCK_SECONDS_15M:"121",
  });
  assert.equal(changed.primaryLockSeconds[5],47);
  assert.equal(changed.primaryLockSeconds[15],121);
  assert.deepEqual(changed.horizonSecondsBeforeClose[5],[90,60,47,45,30,15]);
  assert.deepEqual(changed.horizonSecondsBeforeClose[15],[180,121,90,60,45,30,15]);
  assert.deepEqual(createWaterxResearchConfig("production",{
    WATERX_RESEARCH_PRIMARY_LOCK_SECONDS_5M:"not-a-number",
  }).primaryLockSeconds,{5:60,15:180});
  assert.throws(()=>createWaterxResearchConfig("development",{
    WATERX_RESEARCH_PRIMARY_LOCK_SECONDS_5M:"300",
  }),/must be 1\.\.299/);
  assert.throws(()=>createWaterxResearchConfig("development",{
    WATERX_RESEARCH_PRIMARY_LOCK_SECONDS_15M:"1.5",
  }),/expected integer/);
});

for(const interval of [5,15] as const) {
  test(`${interval}m fresh raw market input locks after grace but never after expiry`,()=>{
    const now=1_900_000_000_000;
    const input=observation(interval,now);
    const checkpoint=input.expiryMs-POLICY.checkpointSecondsBeforeClose[interval]*1000;
    const lateAt=checkpoint+POLICY.checkpointGraceMs+1;
    const late=freezeResearchDecision({...input,observedAt:new Date(lateAt).toISOString()},lateAt,
      unavailableComparison("Coinbase unavailable"));
    assert.equal(late?.state,"FROZEN");
    assert.equal(late?.side,"UP");
    assert.ok(late?.evidence.qualityFlags.includes("PRIMARY_LOCK_LATE_ACTUAL_TIMING"));
    assert.equal(late?.evidence.reference.quality,"unavailable");
    const expired=freezeResearchDecision(input,input.expiryMs,
      unavailableComparison("Coinbase unavailable"));
    assert.equal(expired?.state,"NO_VALID_CHOICE");
    assert.equal(expired?.noChoiceCode,"CHECKPOINT_MISSED");
    assert.equal(expired?.side,null);
  });
  test(`${interval}m primary research choice does not require anchor confirmation or Coinbase`,()=>{
    const now=1_900_000_000_000;
    const input=observation(interval,now);
    const choice=freezeResearchDecision(input,now,unavailableComparison("not collected"));
    assert.equal(choice?.state,"FROZEN");
    assert.equal(choice?.choiceSource,"market_baseline");
    assert.equal(choice?.side,"UP");
    assert.equal(choice?.evidence.reference.quality,"unavailable");
    assert.ok(choice?.evidence.qualityFlags.includes("COINBASE_LOOKBACK_INCOMPLETE"));
    const bogusReference=freezeResearchDecision({...input,anchorPrice:-1,anchorConfirmed:true},
      now,unavailableComparison("not collected"));
    assert.equal(bogusReference?.state,"FROZEN");
    assert.equal(bogusReference?.evidence.reference.quality,"unavailable");
  });
}

test("lifecycle schema is exact-round append-only, one snapshot per horizon, and late lock is not grace-filtered",async()=>{
  const migration=await readFile(new URL("../migrations/waterx-research-lifecycle.sql",import.meta.url),"utf8");
  assert.match(migration,/PRIMARY KEY \(interval_minutes,round_id,lock_seconds\)/);
  assert.match(migration,/PRIMARY KEY \(interval_minutes,round_id\)/);
  assert.match(migration,/RESULT_WITHDRAWN/);
  assert.match(migration,/primary_lock_seconds SMALLINT NOT NULL/);
  assert.match(migration,/NEW.decision_at_ms>=NEW.expiry_ms/);
  assert.doesNotMatch(migration,/checkpoint_at_ms\+15000/);
  assert.match(researchChoiceInsert,/extract\(epoch FROM clock_timestamp\(\)\)\*1000 < \$4::bigint/);
  assert.doesNotMatch(researchChoiceInsert,/checkpoint_at_ms.*grace/s);
  const scored=researchHorizonEvaluationSelect.split("AS scored_n")[0].split("count(*) FILTER").at(-1)!;
  assert.doesNotMatch(scored,/upper\(l\.outcome\)=h\.side/);
  assert.match(researchHorizonEvaluationSelect,/AS correct_n/);
});

const isolated=process.env.WATERX_REFERENCE_CONFIRMATION_TEST_DATABASE_URL;
const safeIsolated=(()=>{
  if(!isolated) return false;
  try {
    const u=new URL(isolated);
    return ["localhost","127.0.0.1","[::1]"].includes(u.hostname) &&
      /waterx_reference_test$/.test(u.pathname) && !/production/i.test(u.pathname);
  } catch { return false; }
})();
test("disposable PostgreSQL persists canonical choice, lifecycle, pinned policy, horizons and restart reads",{
  skip:safeIsolated ? false : "Requires disposable loopback waterx_reference_test DB; never writes application or production DB.",
},async()=>{
  const bootstrap=new pg.Pool({connectionString:isolated,max:1});
  const setup=await bootstrap.connect();
  const schema=`waterx_lifecycle_test_${process.pid}`;
  let pool:pg.Pool|undefined;
  let setupReleased=false;
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(`SET search_path TO ${schema}`);
    await setup.query(`CREATE TABLE waterx_learning_rounds (
      interval_minutes smallint NOT NULL,round_id text NOT NULL,start_ms bigint NOT NULL,expiry_ms bigint NOT NULL,
      label_status text,outcome text,settlement_disputed boolean DEFAULT false,
      settlement_anchor_price numeric,settlement_evidence jsonb,settlement_observed_at timestamptz,
      first_verified_at timestamptz,settled_at bigint,PRIMARY KEY(interval_minutes,round_id))`);
    await setup.query(await readFile(new URL("../migrations/waterx-research.sql",import.meta.url),"utf8"));
    await setup.query(await readFile(new URL("../migrations/waterx-research-lifecycle.sql",import.meta.url),"utf8"));
    await setup.query(`CREATE TABLE waterx_comparison_ticks (
      id bigserial PRIMARY KEY,source text NOT NULL,source_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL,price numeric NOT NULL)`);
    setup.release();
    setupReleased=true;
    pool=new pg.Pool({connectionString:isolated,max:2,options:`-c search_path=${schema}`});
    for(const interval of [5,15] as const) {
      const now=Date.now();
      const expiry=Math.ceil((now+(interval===5?30_000:120_000))/1000)*1000;
      const input=observation(interval,now,expiry);
      const source="Coinbase comparison only (not settlement oracle)";
      await pool.query(`INSERT INTO waterx_comparison_ticks(source,source_at,received_at,price)
        VALUES ($1,$2,$2,100),($1,$3,$3,100.5)`,
      [source,new Date(now-179_000),new Date(now-1_000)]);
      assert.match(await captureResearchObservation(input,{db:pool,nowMs:now}),/primary choice frozen/);
      const choice=(await pool.query(`SELECT state,side,decision_at_ms,evidence FROM waterx_research_choices
        WHERE interval_minutes=$1 AND round_id=$2`,[interval,input.roundId])).rows[0];
      assert.equal(choice.state,"FROZEN");
      assert.equal(choice.side,"UP");
      assert.ok(choice.evidence.qualityFlags.includes("REFERENCE_UNAVAILABLE"));
      const policy=(await pool.query(`SELECT primary_lock_seconds,horizon_seconds FROM waterx_research_round_policy
        WHERE interval_minutes=$1 AND round_id=$2`,[interval,input.roundId])).rows[0];
      assert.equal(Number(policy.primary_lock_seconds),POLICY.checkpointSecondsBeforeClose[interval]);
      const events=(await pool.query(`SELECT event_type,actual_at_ms,details FROM waterx_research_lifecycle_events
        WHERE interval_minutes=$1 AND round_id=$2 ORDER BY actual_at_ms,id`,[interval,input.roundId])).rows;
      assert.deepEqual(events.map(e=>e.event_type),["WATCHING","LEANING","FINAL_CHOICE"]);
      assert.ok(Number(events[0].actual_at_ms)>=now);
      assert.equal(events[1].details.inputObservedAt,input.observedAt);
      const snapshots=(await pool.query(`SELECT lock_seconds,is_primary,eligible,actual_at_ms,odds_observed_at_ms
        FROM waterx_research_horizon_snapshots WHERE interval_minutes=$1 AND round_id=$2`,
      [interval,input.roundId])).rows;
      const primary=snapshots.find(s=>s.is_primary);
      assert.ok(primary,JSON.stringify((await pool.query(`SELECT code,reason,details
        FROM waterx_research_capture_events WHERE interval_minutes=$1 AND round_id=$2`,
      [interval,input.roundId])).rows));
      assert.equal(Number(choice.decision_at_ms),Number(primary.actual_at_ms));
      assert.equal(Number(primary.odds_observed_at_ms),now);
      assert.equal(primary.eligible,false,"late official choice must not masquerade as an on-time horizon sample");
      const later=Date.now();
      await captureResearchObservation({...input,probabilityUp:0.4,probabilityDown:0.6,
        observedAt:new Date(later).toISOString()},{db:pool,nowMs:later});
      const live=await getResearchLiveObservation(pool,input,Date.now());
      assert.equal(live.fresh,true);
      assert.equal(live.probabilityDown,0.6,"live odds continue updating after the official lock");
      const lifecycle=await getResearchLifecycleState(pool,input);
      assert.equal(lifecycle.state,"FINAL_CHOICE");
      assert.equal(lifecycle.side,"UP");
      assert.equal((await pool.query(`SELECT count(*) FROM waterx_research_lifecycle_events
        WHERE interval_minutes=$1 AND round_id=$2 AND event_type='LEANING'`,
      [interval,input.roundId])).rows[0].count,"1","live updates after final cannot regress lifecycle");
      await assert.rejects(pool.query(`UPDATE waterx_research_lifecycle_events SET side='DOWN'
        WHERE interval_minutes=$1 AND round_id=$2`,[interval,input.roundId]),/append-only/);
      await assert.rejects(pool.query(`DELETE FROM waterx_research_horizon_snapshots
        WHERE interval_minutes=$1 AND round_id=$2`,[interval,input.roundId]),/append-only/);
      const evaluation=await getResearchHorizonEvaluations(pool,interval);
      const primaryEvaluation=evaluation.find(item=>item.lockSeconds===POLICY.checkpointSecondsBeforeClose[interval]);
      assert.equal(primaryEvaluation?.recordedN,1);
      assert.equal(primaryEvaluation?.eligibleN,0);
    }
    const resultNow=Date.now();
    const resultExpiry=Math.ceil((resultNow+1_000)/1000)*1000;
    const resultInput=observation(15,resultNow,resultExpiry);
    await captureResearchObservation(resultInput,{db:pool,nowMs:resultNow});
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,resultExpiry+25-Date.now())));
    const verifiedAt=new Date(resultExpiry+10);
    await pool.query(`INSERT INTO waterx_learning_rounds
      (interval_minutes,round_id,start_ms,expiry_ms,label_status,outcome,settlement_disputed,
       settlement_anchor_price,settlement_evidence,settlement_observed_at,first_verified_at,settled_at)
      VALUES (15,$1,$2,$3,'verified','Up',false,101,'{\"verifiedFixture\":true}',$4,$4,$5)`,
    [resultInput.roundId,resultInput.startMs,resultInput.expiryMs,verifiedAt,resultExpiry+10]);
    assert.equal(await scoreResearchChoices(15,pool as never,Date.now()),1);
    assert.equal((await pool.query(`SELECT event_type,result,outcome FROM waterx_research_lifecycle_events
      WHERE interval_minutes=15 AND round_id=$1 AND event_type='RESULT'`,[resultInput.roundId])).rowCount,1);
    await pool.query(`UPDATE waterx_learning_rounds SET settlement_disputed=true
      WHERE interval_minutes=15 AND round_id=$1`,[resultInput.roundId]);
    const { withdrawDisputedResearchResult }=await import("../server/waterx/research-lifecycle");
    await withdrawDisputedResearchResult(pool,{
      intervalMinutes:15,roundId:resultInput.roundId,startMs:resultInput.startMs,
      expiryMs:resultInput.expiryMs,side:"UP",previousOutcome:"UP",
      actualAtMs:Date.now(),reason:"Controlled dispute after an accepted result.",
    });
    const transitions=(await pool.query(`SELECT event_type FROM waterx_research_lifecycle_events
      WHERE interval_minutes=15 AND round_id=$1 ORDER BY actual_at_ms,id`,[resultInput.roundId])).rows;
    assert.ok(transitions.some(event=>event.event_type==="RESULT"));
    assert.ok(transitions.some(event=>event.event_type==="RESULT_WITHDRAWN"));
    const restart=new pg.Pool({connectionString:isolated,max:1,options:`-c search_path=${schema}`});
    try {
      assert.equal((await restart.query("SELECT count(*) FROM waterx_research_choices")).rows[0].count,"3");
      assert.equal((await restart.query("SELECT count(*) FROM waterx_research_lifecycle_events WHERE event_type='FINAL_CHOICE'")).rows[0].count,"3");
    } finally { await restart.end(); }
  } finally {
    await pool?.end();
    if(!setupReleased) setup.release();
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await bootstrap.end();
  }
});