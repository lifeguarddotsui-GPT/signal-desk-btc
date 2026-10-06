import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { WATERX_RESEARCH_POLICY as POLICY } from "../shared/waterx-research";
import {
  comparisonFeatures, freezeResearchDecision, researchScore, unavailableComparison,
  type ResearchObservation,
} from "../server/waterx/research-decision";
import {
  researchChoiceInsert, researchChoiceValues, scoreResearchChoices, choiceFromRow,
  captureResearchObservation,
} from "../server/waterx/research-store";
import { runResearchTrainingDay } from "../server/waterx/research-training";

function observation(interval:5|15,now=Date.now()):ResearchObservation {
  const decision=Math.floor(now/1000)*1000;
  const expiry=decision+POLICY.checkpointSecondsBeforeClose[interval]*1000;
  return {intervalMinutes:interval,roundId:`controlled-${interval}-${decision}`,startMs:expiry-interval*60000,
    expiryMs:expiry,anchorPrice:100,anchorConfirmed:false,probabilityUp:0.63,
    probabilityDown:0.37,observedAt:new Date(decision).toISOString()};
}
for(const interval of [5,15] as const) {
  test(`${interval}m fixed checkpoint freezes provisional baseline without requiring entry proofs`,()=>{
    const input=observation(interval),now=Date.parse(input.observedAt);
    assert.equal(freezeResearchDecision(input,now-1,unavailableComparison("warming")),null);
    const c=freezeResearchDecision(input,now,unavailableComparison("warming"))!;
    assert.equal(c.state,"FROZEN");assert.equal(c.side,"UP");assert.equal(c.choiceSource,"market_baseline");
    assert.equal(c.evidence.reference.quality,"provisional");
    assert.ok(c.evidence.qualityFlags.includes("COINBASE_LOOKBACK_INCOMPLETE"));
    assert.equal(c.expiryMs-c.checkpointAtMs,POLICY.checkpointSecondsBeforeClose[interval]*1000);
  });
  test(`${interval}m deterministic tie is explicitly frozen, and missing side is never reconstructed`,()=>{
    const input=observation(interval),now=Date.parse(input.observedAt);
    const tie=freezeResearchDecision({...input,probabilityUp:0.5,probabilityDown:0.5},now,unavailableComparison("x"))!;
    assert.equal(tie.side,"UP");assert.equal(tie.evidence.tieBreakApplied,true);
    const missing=freezeResearchDecision({...input,probabilityDown:null},now,unavailableComparison("x"))!;
    assert.equal(missing.state,"NO_VALID_CHOICE");assert.equal(missing.noChoiceCode,"MARKET_ODDS_INVALID");
    assert.equal(missing.probabilityUp,null);
  });
  test(`${interval}m stale, future, incomplete and late evidence cannot create a choice`,()=>{
    const input=observation(interval),now=Date.parse(input.observedAt);
    for(const at of [now-10001,now+1]) {
      assert.equal(freezeResearchDecision({...input,observedAt:new Date(at).toISOString()},now,unavailableComparison("x"))!.noChoiceCode,
        "MARKET_ODDS_NOT_TIMELY");
    }
    assert.equal(freezeResearchDecision(input,now+15001,unavailableComparison("x"))!.noChoiceCode,"MARKET_ODDS_NOT_TIMELY");
    assert.equal(freezeResearchDecision({...input,observedAt:new Date(now+15001).toISOString()},
      now+15001,unavailableComparison("x"))!.state,"FROZEN","fresh pre-expiry evidence still locks after the original grace window");
    assert.equal(freezeResearchDecision(input,input.expiryMs+1,unavailableComparison("x"))!.side,null);
    assert.throws(()=>freezeResearchDecision({...input,startMs:input.startMs+1},now,unavailableComparison("x")),/identity/);
  });
  test(`${interval}m later reference and market updates cannot mutate the original frozen evidence`,()=>{
    const input=observation(interval),now=Date.parse(input.observedAt);
    const c=freezeResearchDecision(input,now,unavailableComparison("x"))!;
    input.anchorPrice=110;input.anchorConfirmed=true;input.probabilityUp=0.1;
    assert.equal(c.evidence.reference.price,100);assert.equal(c.evidence.reference.quality,"provisional");
    assert.equal(c.probabilityUp,0.63);
    const s=researchScore(c,"UP",110);
    assert.equal(s.referenceDiscrepancyUsd,10);assert.ok(Math.abs(s.brier-0.1369)<1e-12);
    assert.equal(s.marketBaselineBrier,s.brier);
  });
}
test("comparison features use the real complete three-minute predecision window and reject source/receive lookahead",()=>{
  const now=1_800_000;
  const ticks=Array.from({length:181},(_,i)=>({id:String(i),sourceAtMs:now-180000+i*1000,
    receivedAtMs:now-180000+i*1000,price:100+i/100}));
  const c=comparisonFeatures(ticks,now);assert.equal(c.coverage,"complete");
  assert.equal(c.tickCount,181);assert.ok(c.return1m!>0);
  const polluted=comparisonFeatures([...ticks,{id:"future",sourceAtMs:now+1,receivedAtMs:now+1,price:999},
    {id:"late-received",sourceAtMs:now-100,receivedAtMs:now+100,price:888}],now);
  assert.equal(polluted.price,c.price);assert.equal(polluted.tickCount,c.tickCount);
  assert.equal(comparisonFeatures(ticks.slice(40),now).coverage,"partial");
  assert.equal(comparisonFeatures(ticks.filter((_,i)=>i<50||i>80),now).coverage,"partial");
});
test("invalid optional model cannot poison a good baseline; qualified matching model is distinct",()=>{
  const input=observation(5),now=Date.parse(input.observedAt);
  const model={status:"available" as const,probabilityUp:0.2,probabilityDown:0.8,modelVersion:"fixture-model",
    calibrationVersion:"fixture-calibration",observedAtMs:now,reason:null,forwardApproved:true,
    intervalMinutes:5 as const,roundId:input.roundId};
  const m=freezeResearchDecision(input,now,unavailableComparison("x"),model)!;
  assert.equal(m.choiceSource,"bluewaterai_model");assert.equal(m.side,"DOWN");
  const wrong=freezeResearchDecision(input,now,unavailableComparison("x"),{...model,roundId:"other-round"})!;
  assert.equal(wrong.choiceSource,"market_baseline");
  assert.equal(wrong.side,"UP");assert.match(wrong.modelVersion!,/^market-baseline:/);
});
test("dispute withdrawal hides original score without erasing immutable choice evidence",()=>{
  const input=observation(5),now=Date.parse(input.observedAt);
  const c=freezeResearchDecision(input,now,unavailableComparison("x"))!;
  const r={interval_minutes:5,round_id:c.roundId,start_ms:c.startMs,expiry_ms:c.expiryMs,
    checkpoint_at_ms:c.checkpointAtMs,decision_at_ms:now,state:c.state,side:c.side,
    probability_up:c.probabilityUp,probability_down:c.probabilityDown,choice_source:c.choiceSource,
    model_version:null,calibration_version:null,policy_version:c.policyVersion,
    no_choice_code:null,no_choice_reason:null,evidence:c.evidence,label_status:"verified",
    label_outcome:"Up",scored_outcome:"UP",correct:true,brier:0.1369,log_loss:0.4,
    settlement_disputed:true};
  const disputed=choiceFromRow(r);
  assert.equal(disputed.settlement.state,"disputed");assert.equal(disputed.settlement.brier,null);
  assert.equal(disputed.side,"UP");assert.equal(disputed.evidence.reference.price,100);
});
test("research pipeline cannot supply entry eligibility or force a live glow",async()=>{
  const policy=await import("../shared/waterx-value-policy");
  assert.equal(policy.WATERX_VALUE_POLICY.eligibilityEnabled,false);
  const source=await readFile(new URL("../server/waterx/research-store.ts",import.meta.url),"utf8");
  assert.doesNotMatch(source,/buildWaterxAdvisory|eligibilityEnabled\s*=/);
});
test("a rejected queued observation cannot consume the grace window before fresh checkpoint evidence arrives",async()=>{
  const input=observation(5),now=Date.parse(input.observedAt);
  let insertions=0;
  const db={query:async(sql:string)=>{
    if(sql===researchChoiceInsert) {insertions++;return {rows:[{round_id:input.roundId}]};}
    if(sql.includes("SELECT primary_lock_seconds,horizon_seconds")) return {rows:[{
      primary_lock_seconds:60,horizon_seconds:[90,60,45,30,15],
      horizon_capture_grace_ms:POLICY.horizonCaptureGraceMs,policy_version:POLICY.version,
    }]};
    if(sql.startsWith("INSERT INTO waterx_research_lifecycle_events")) return {rows:[{id:1}]};
    return {rows:[]};
  }};
  const stale={...input,observedAt:new Date(now-10001).toISOString()};
  assert.match(await captureResearchObservation(stale,{db:db as unknown as pg.Pool,nowMs:now}),/awaiting fresh valid WaterX odds before expiry/);
  assert.equal(insertions,0);
  assert.match(await captureResearchObservation({...input,observedAt:new Date(now+2000).toISOString()},
    {db:db as unknown as pg.Pool,nowMs:now+2000}),/primary choice frozen/);
  assert.equal(insertions,1);
});

const isolated=process.env.WATERX_REFERENCE_CONFIRMATION_TEST_DATABASE_URL;
const safeIsolated=(()=>{
  if(!isolated) return false;
  const u=new URL(isolated);
  return ["localhost","127.0.0.1","[::1]"].includes(u.hostname) &&
    /waterx_reference_test$/.test(u.pathname) && !/production/i.test(u.pathname);
})();
test("controlled PostgreSQL 5m/15m lifecycles: actual immutable inserts, duplicates, scoring, disputed withdrawal and restart",{
  skip:safeIsolated ? false : "Requires disposable loopback waterx_reference_test DB; never uses app or production DB.",
},async()=>{
  const pool=new pg.Pool({connectionString:isolated,max:1});
  const client=await pool.connect();
  const schema=`waterx_loop_test_${process.pid}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(`CREATE TABLE waterx_learning_rounds (
      interval_minutes smallint,round_id text,start_ms bigint,expiry_ms bigint,
      label_status text,outcome text,settlement_disputed boolean DEFAULT false,
      settlement_anchor_price numeric,settle_price numeric,settlement_quarantine jsonb DEFAULT '[]',
      settlement_evidence jsonb,settlement_observed_at timestamptz,
      settlement_first_observed_at timestamptz,first_verified_at timestamptz,
      settled_at bigint,PRIMARY KEY(interval_minutes,round_id))`);
    await client.query(await readFile(new URL("../migrations/waterx-research.sql",import.meta.url),"utf8"));
    for(const interval of [5,15] as const) {
      const input=observation(interval),now=Date.parse(input.observedAt);
      const c=freezeResearchDecision(input,now,unavailableComparison("controlled incomplete lookback"))!;
      assert.equal((await client.query(researchChoiceInsert,researchChoiceValues(c))).rowCount,1);
      assert.equal((await client.query(researchChoiceInsert,researchChoiceValues(c))).rowCount,0);
      await client.query("SAVEPOINT attempt_mutation");
      await assert.rejects(client.query("UPDATE waterx_research_choices SET side='DOWN' WHERE interval_minutes=$1",[interval]),/immutable/);
      await client.query("ROLLBACK TO SAVEPOINT attempt_mutation");
      await client.query(`INSERT INTO waterx_learning_rounds
        (interval_minutes,round_id,start_ms,expiry_ms,label_status,outcome,settlement_anchor_price,
         settlement_evidence,settlement_observed_at,settlement_first_observed_at,first_verified_at,settled_at)
        VALUES ($1,$2,$3,$4,'verified','Up',110,'{\"fixture\":true}',$5,$5,$5,$6)`,
      [interval,input.roundId,input.startMs,input.expiryMs,new Date(input.expiryMs+2000),input.expiryMs+1000]);
      // Test-only logical clock advances after expiry. No fake labels enter application DB.
      assert.equal(await scoreResearchChoices(interval,client as unknown as pg.Pool,input.expiryMs+3000),1);
      assert.equal(await scoreResearchChoices(interval,client as unknown as pg.Pool,input.expiryMs+4000),0);
      const score=(await client.query("SELECT * FROM waterx_research_scores WHERE interval_minutes=$1",[interval])).rows[0];
      assert.equal(score.correct,true);assert.equal(Number(score.reference_discrepancy_usd),10);
      await client.query("UPDATE waterx_learning_rounds SET settlement_disputed=true WHERE interval_minutes=$1",[interval]);
      const join=(await client.query(`SELECT c.*,l.label_status,l.settlement_disputed,l.outcome AS label_outcome,
        s.outcome AS scored_outcome,s.correct,s.brier,s.log_loss FROM waterx_research_choices c
        JOIN waterx_learning_rounds l USING(interval_minutes,round_id)
        JOIN waterx_research_scores s USING(interval_minutes,round_id) WHERE c.interval_minutes=$1`,[interval])).rows[0];
      assert.equal(choiceFromRow(join).settlement.state,"disputed");
      const expired={...c,roundId:`expired-${interval}`,startMs:c.startMs-interval*60000,
        expiryMs:c.expiryMs-interval*60000,checkpointAtMs:c.checkpointAtMs-interval*60000,
        decisionAtMs:c.decisionAtMs-interval*60000};
      assert.equal((await client.query(researchChoiceInsert,researchChoiceValues(expired))).rowCount,0);
      await client.query("SAVEPOINT direct_backfill");
      await assert.rejects(client.query(researchChoiceInsert.replace(/WHERE \(\$7='NO_VALID_CHOICE'[\s\S]*?ON CONFLICT/,"ON CONFLICT"),
        researchChoiceValues(expired).slice(0,17)),/backfilled/);
      await client.query("ROLLBACK TO SAVEPOINT direct_backfill");
    }
    const choices=await client.query("SELECT round_id,evidence FROM waterx_research_choices ORDER BY interval_minutes");
    assert.equal(choices.rowCount,2);
    await client.query("COMMIT");
    const sessions=new pg.Pool({connectionString:isolated,max:2,options:`-c search_path=${schema}`});
    try {
      // The lease is genuinely session-scoped: a second connection cannot
      // reserve a daily job while this one owns it.
      await client.query("SELECT pg_advisory_lock(95695,51516)");
      const held=await runResearchTrainingDay(sessions,5);
      assert.equal(held.outcome,"lease-unavailable");
      await client.query("SELECT pg_advisory_unlock(95695,51516)");
      const failed=await runResearchTrainingDay(sessions,5,{
        train:()=>{throw new Error("Controlled trainer failure.");},
      });
      assert.equal(failed.outcome,"failed");
      const failure=(await sessions.query("SELECT status,report,error FROM waterx_research_daily_runs WHERE interval_minutes=5")).rows[0];
      assert.equal(failure.status,"failed");assert.deepEqual(failure.report,{});
      assert.match(failure.error,/Controlled trainer failure/);
      const insufficient=await runResearchTrainingDay(sessions,15);
      assert.equal(insufficient.outcome,"insufficient");
      assert.equal((await runResearchTrainingDay(sessions,15)).outcome,"not-due");
      const locks=await sessions.query(`SELECT count(*) FROM pg_locks
        WHERE classid=95695::oid AND objid=51516::oid AND objsubid=2`);
      assert.equal(Number(locks.rows[0].count),0);
    } finally { await sessions.end(); }
    // Fresh transaction re-reads durable evidence rather than reconstructing prediction.
    await client.query("BEGIN");await client.query(`SET LOCAL search_path TO ${schema}`);
    assert.equal((await client.query("SELECT * FROM waterx_research_choices")).rowCount,2);
    await client.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK").catch(()=>{});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();await pool.end();
  }
});

test("pending settlement retries prioritize newly frozen research rounds and preserve the legacy schema path", {
  skip: safeIsolated ? false : "Requires disposable loopback waterx_reference_test DB; never uses app or production DB.",
}, async () => {
  const pool = new pg.Pool({ connectionString: isolated, max: 1 });
  const client = await pool.connect();
  const researchSchema = `waterx_retry_research_${process.pid}`;
  const legacySchema = `waterx_retry_legacy_${process.pid}`;
  const createLearningTable = `CREATE TABLE waterx_learning_rounds (
    interval_minutes smallint NOT NULL, round_id text NOT NULL,
    start_ms bigint NOT NULL, expiry_ms bigint NOT NULL,
    label_status text NOT NULL, outcome text,
    last_settlement_attempt_at timestamptz,
    PRIMARY KEY(interval_minutes,round_id))`;
  const queryAt = (schema: string, nowMs: number, interval: 5 | 15 = 5) => {
    const source = `Date.now=()=>Number(process.env.WATERX_PENDING_TEST_NOW_MS);
      const {listPendingWaterxSettlements}=await import('./server/waterx/learning.ts');
      const result=await listPendingWaterxSettlements(
        Number(process.env.WATERX_PENDING_TEST_INTERVAL),1);
      await new Promise(resolve=>process.stdout.write(JSON.stringify(result),resolve));
      process.exit(0);`;
    return JSON.parse(execFileSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e", source,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: isolated!,
        PGOPTIONS: `-c search_path=${schema}`,
        WATERX_PENDING_TEST_NOW_MS: String(nowMs),
        WATERX_PENDING_TEST_INTERVAL: String(interval),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim());
  };
  try {
    await client.query(`CREATE SCHEMA ${researchSchema}`);
    await client.query(`CREATE SCHEMA ${legacySchema}`);

    await client.query(`SET search_path TO ${researchSchema}`);
    await client.query(createLearningTable);
    await client.query(await readFile(
      new URL("../migrations/waterx-research.sql", import.meta.url), "utf8",
    ));

    const now = Date.now();
    const priorityChoices = new Map<5 | 15, ReturnType<typeof freezeResearchDecision>>();
    for (const interval of [5, 15] as const) {
      const observationInput = observation(interval, now);
      const choice = freezeResearchDecision(
        observationInput,
        Date.parse(observationInput.observedAt),
        unavailableComparison("settlement retry priority fixture"),
      )!;
      assert.equal(choice.state, "FROZEN");
      assert.equal((await client.query(researchChoiceInsert,
        researchChoiceValues(choice))).rowCount, 1);
      priorityChoices.set(interval, choice);
      const archiveNullExpiry = choice.startMs - 3_600_000;
      const archiveRetriedExpiry = choice.startMs - 7_200_000;
      await client.query(
        `INSERT INTO waterx_learning_rounds
          (interval_minutes,round_id,start_ms,expiry_ms,label_status,outcome,
           last_settlement_attempt_at)
         VALUES ($1,$2,$3,$4,'unresolved',NULL,NULL),
                ($1,$5,$6,$7,'unresolved',NULL,NULL),
                ($1,$8,$9,$10,'withheld',NULL,$11)`,
        [interval, choice.roundId, choice.startMs, choice.expiryMs,
          `old-archive-null-${interval}`,
          archiveNullExpiry - interval * 60_000, archiveNullExpiry,
          `old-archive-retried-${interval}`,
          archiveRetriedExpiry - interval * 60_000, archiveRetriedExpiry,
          new Date(now - 120_000)],
      );
    }
    for (const interval of [5, 15] as const) {
      const choice = priorityChoices.get(interval)!;
      const advancedNow = choice.expiryMs + 8 * 60_000;
      const prioritized = queryAt(researchSchema, advancedNow, interval) as {
        roundId: string; startMs: number; expiryMs: number;
      }[];
      assert.deepEqual(prioritized, [{
        roundId: choice.roundId,
        startMs: choice.startMs,
        expiryMs: choice.expiryMs,
      }]);
    }

    await client.query(`SET search_path TO ${legacySchema}`);
    await client.query(createLearningTable);
    const legacyReference = priorityChoices.get(5)!;
    const legacyNullExpiry = legacyReference.startMs - 3_600_000;
    const legacyRetriedExpiry = legacyReference.startMs - 7_200_000;
    await client.query(
      `INSERT INTO waterx_learning_rounds
        (interval_minutes,round_id,start_ms,expiry_ms,label_status,outcome,
         last_settlement_attempt_at)
       VALUES (5,'legacy-retried',$1,$2,'withheld',NULL,$3),
              (5,'legacy-null',$4,$5,'unresolved',NULL,NULL)`,
      [legacyRetriedExpiry - 5 * 60_000, legacyRetriedExpiry,
        new Date(now - 120_000), legacyNullExpiry - 5 * 60_000, legacyNullExpiry],
    );
    const legacy = queryAt(legacySchema, legacyReference.expiryMs + 8 * 60_000) as {
      roundId: string; startMs: number; expiryMs: number;
    }[];
    assert.deepEqual(legacy, [{
      roundId: "legacy-null",
      startMs: legacyNullExpiry - 5 * 60_000,
      expiryMs: legacyNullExpiry,
    }]);
  } finally {
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${researchSchema} CASCADE`).catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  }
});