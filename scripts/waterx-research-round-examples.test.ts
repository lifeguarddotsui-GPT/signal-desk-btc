import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { captureResearchObservation, scoreResearchChoices, researchChoicesSelect, choiceFromRow } from "../server/waterx/research-store";
import { getResearchLifecycleState, getResearchLiveObservation } from "../server/waterx/research-lifecycle";
import { sideAuditSql, featureAuditSql, diagnosticsSql, getResearchAudit } from "../server/waterx/research-audit";

const url = process.env.WATERX_REFERENCE_CONFIRMATION_TEST_DATABASE_URL;
const safe = (() => {
  if (!url) return false;
  try {
    const value = new URL(url);
    return ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname)
      && value.pathname === "/waterx_reference_test";
  } catch { return false; }
})();

test("six isolated prospective fixtures prove finals, changed live odds, verified results, calibration and retained wrong choices", {
  skip: !safe && "Requires disposable loopback waterx_reference_test; never uses app or production database.",
}, async () => {
  const bootstrap = new pg.Pool({ connectionString: url, max: 1 });
  const schema = `research_examples_${process.pid}`;
  const q = await bootstrap.connect();
  let db: pg.Pool | undefined;
  try {
    await q.query(`CREATE SCHEMA ${schema}`);
    await q.query(`SET search_path TO ${schema}`);
    await q.query(`CREATE TABLE waterx_learning_rounds (
      interval_minutes smallint NOT NULL,round_id text NOT NULL,start_ms bigint NOT NULL,expiry_ms bigint NOT NULL,
      label_status text,outcome text,settlement_disputed boolean DEFAULT false,
      settlement_anchor_price numeric,settlement_evidence jsonb,settlement_observed_at timestamptz,
      first_verified_at timestamptz,settled_at bigint,PRIMARY KEY(interval_minutes,round_id))`);
    await q.query(await readFile(new URL("../migrations/waterx-research.sql", import.meta.url), "utf8"));
    await q.query(await readFile(new URL("../migrations/waterx-research-lifecycle.sql", import.meta.url), "utf8"));
    await q.query(await readFile(new URL("../migrations/waterx-research-features.sql", import.meta.url), "utf8"));
    await q.query(await readFile(new URL("../migrations/waterx-research-shadow.sql", import.meta.url), "utf8"));
    db = new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
    const expiry = Math.floor(Date.now()/1000)*1000+10_000;
    const examples: { interval: 5 | 15; id: string; probabilityUp: number; outcome: "UP" | "DOWN" }[] = [];
    for (const interval of [5, 15] as const) {
      for (const [index, probabilityUp, outcome] of [
        [0, 0.68, "UP"], [1, 0.43, "UP"], [2, 0.5, "DOWN"],
      ] as const) {
        examples.push({ interval, id: `fixture-${interval}-${index}`, probabilityUp, outcome });
      }
    }
    for (const e of examples) {
      const input = {
        intervalMinutes: e.interval, roundId: e.id, startMs: expiry-e.interval*60_000,
        expiryMs: expiry, probabilityUp: e.probabilityUp, probabilityDown: 1-e.probabilityUp,
        observedAt: new Date().toISOString(), anchorPrice: null, anchorConfirmed: false,
      };
      await captureResearchObservation(input, { db });
      const final = (await db.query("SELECT * FROM waterx_research_choices WHERE interval_minutes=$1 AND round_id=$2", [e.interval, e.id])).rows[0];
      assert.equal(final.state, "FROZEN");
      assert.equal(final.side, e.probabilityUp>=0.5 ? "UP" : "DOWN");
      assert.equal(Number(final.probability_up), e.probabilityUp);
      await captureResearchObservation({ ...input, probabilityUp: 0.91, probabilityDown: 0.09, observedAt: new Date().toISOString() }, { db });
      const retained = (await db.query("SELECT * FROM waterx_research_choices WHERE interval_minutes=$1 AND round_id=$2", [e.interval, e.id])).rows[0];
      assert.equal(Number(retained.probability_up), e.probabilityUp);
      const live = await getResearchLiveObservation(db, input);
      assert.equal(live.probabilityUp, 0.91);
      assert.equal((await getResearchLifecycleState(db, input)).state, "FINAL_CHOICE");
    }
    // Separate still-open exact rounds hit each real cutoff. This does not
    // backdate an observation or pretend all horizons came from one round.
    for (const interval of [5,15] as const) {
      for (const seconds of interval===5 ? [90,60,45,30,15] : [180,90,60,45,30,15]) {
        const at=Date.now();
        const horizonExpiry=Math.floor(at/1000)*1000+seconds*1000;
        const input={intervalMinutes:interval,roundId:`on-time-${interval}-${seconds}`,
          startMs:horizonExpiry-interval*60_000,expiryMs:horizonExpiry,
          probabilityUp:0.62,probabilityDown:0.38,observedAt:new Date(at).toISOString(),
          anchorPrice:null,anchorConfirmed:false};
        await captureResearchObservation(input,{db,nowMs:at});
        const sample=(await db.query(`SELECT eligible,actual_at_ms FROM waterx_research_horizon_snapshots
          WHERE interval_minutes=$1 AND round_id=$2 AND lock_seconds=$3`,[interval,input.roundId,seconds])).rows[0];
        assert.equal(sample?.eligible,true,`real ${interval}m ${seconds}s cutoff must persist an on-time sample`);
        assert.equal(Number(sample.actual_at_ms),at);
        const snapshots=(await db.query(`SELECT lock_seconds,eligible FROM waterx_research_horizon_snapshots
          WHERE interval_minutes=$1 AND round_id=$2`,[interval,input.roundId])).rows;
        assert.deepEqual(snapshots.filter(r=>r.eligible).map(r=>Number(r.lock_seconds)),[seconds],
          "earlier alternate horizons must not be retrospectively filled");
      }
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry+30-Date.now())));
    for (const e of examples) {
      const now = Date.now();
      await db.query(`INSERT INTO waterx_learning_rounds
        (interval_minutes,round_id,start_ms,expiry_ms,label_status,outcome,settlement_anchor_price,
         settlement_evidence,settlement_observed_at,first_verified_at,settled_at)
        VALUES($1,$2,$3,$4,'verified',$5,100,'{"controlledFixture":true}',$6,$6,$7)`,
      [e.interval,e.id,expiry-e.interval*60_000,expiry,e.outcome==="UP" ? "Up" : "Down",new Date(now),now]);
    }
    for (const interval of [5,15] as const) {
      assert.equal(await scoreResearchChoices(interval,db),3);
      assert.equal(await scoreResearchChoices(interval,db),0);
      // Execute the real audit SQL as well as the decision/scoring path.
      const params=[interval,Date.now(),0];
      assert.ok((await db.query(sideAuditSql,params)).rows.length>0);
      assert.ok((await db.query(featureAuditSql,params)).rows.length>0);
      assert.equal((await db.query(diagnosticsSql,params)).rows.length,3);
      const audit=await getResearchAudit(db,interval,Date.now(),null);
      assert.ok("sideCalibration" in audit);
      if ("sideCalibration" in audit) {
        assert.equal(audit.sideCalibration.reduce((n,r)=>n+r.n,0),3);
        assert.equal(audit.previousCandidate.matchedN,0);
        assert.equal(audit.entryEvaluation.status,"unavailable");
        assert.equal(audit.horizonEvaluation.filter(r=>r.eligibleN>0).length,interval===5?5:6);
      }
    }
    const evidence = [];
    for (const e of examples) {
      const choice = choiceFromRow((await db.query(`${researchChoicesSelect} WHERE c.interval_minutes=$1 AND c.round_id=$2`, [e.interval,e.id])).rows[0]);
      const lifecycle = await getResearchLifecycleState(db,{intervalMinutes:e.interval,roundId:e.id,startMs:choice.startMs,expiryMs:expiry});
      assert.equal(lifecycle.state,"RESULT");
      assert.equal(lifecycle.outcome,e.outcome);
      assert.equal(lifecycle.result,choice.side===e.outcome ? "CORRECT" : "INCORRECT");
      assert.ok(choice.settlement.brier!==null);
      const events=(await db.query(`SELECT event_type,side,result,outcome,actual_at_ms
        FROM waterx_research_lifecycle_events WHERE interval_minutes=$1 AND round_id=$2 ORDER BY id`,[e.interval,e.id])).rows;
      assert.deepEqual(events.map(r=>r.event_type),["WATCHING","LEANING","FINAL_CHOICE","RESULT"]);
      await assert.rejects(db.query("UPDATE waterx_research_choices SET probability_up=.99 WHERE interval_minutes=$1 AND round_id=$2",[e.interval,e.id]),/immutable/i);
      evidence.push({environment:"ISOLATED CONTROLLED FIXTURE — NOT LIVE MARKET PERFORMANCE",
        intervalMinutes:e.interval,roundId:e.id,side:choice.side,probabilityUp:choice.probabilityUp,
        decisionAt:new Date(choice.decisionAtMs).toISOString(),expiry:new Date(expiry).toISOString(),
        actualSecondsBeforeExpiry:(expiry-choice.decisionAtMs)/1000,
        outcome:choice.settlement.outcome,result:lifecycle.result,brier:choice.settlement.brier,
        logLoss:choice.settlement.logLoss,initialReferenceQuality:choice.evidence.reference.quality,
        lifecycle:events});
    }
    await mkdir("reports",{recursive:true});
    await writeFile("reports/waterx-lifecycle-controlled-rounds.json",JSON.stringify({
      capturedAt:new Date().toISOString(),environment:"DISPOSABLE LOOPBACK POSTGRESQL, synthetic inputs",
      note:"These six inputs were captured before their fixture expiry and scored afterward. They are simulations, not historical WaterX forecasts, real model performance, or production acceptance.",
      examples:evidence,
    },null,2));
  } finally {
    await db?.end();
    await q.query("RESET search_path");
    await q.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    q.release(); await bootstrap.end();
  }
});