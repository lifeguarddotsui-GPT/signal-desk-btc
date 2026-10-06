import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readFileSync } from "node:fs";
import { canonical, digest, buildFeatureSnapshot, infer, FEATURE_SCHEMA, type ModelArtifact } from "../server/waterx/bluewater-fast";
import { persistArtifact } from "../server/waterx/bluewater-store";
import { getBluewaterReport } from "../server/waterx/bluewater-report";
import { researchPool } from "../server/waterx/research-store";
const url=process.env.WATERX_REFERENCE_CONFIRMATION_TEST_DATABASE_URL;
const safe=(()=>{try{const u=new URL(url!);return ["127.0.0.1","localhost","[::1]"].includes(u.hostname)&&
  /waterx_reference_test$/.test(u.pathname)&&!/production/i.test(u.pathname);}catch{return false;}})();
test("disposable PostgreSQL enforces separate immutable raw/calibrated forecasts, timing, identity, results and manual promotion",{
  skip:safe?false:"Disposable loopback waterx_reference_test database required; never writes app or production database.",
},async()=>{
  const db=new pg.Client({connectionString:url});await db.connect();const schema=`bluewater_test_${process.pid}`;
  try{
    await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path TO ${schema}`);
    for(const file of ["waterx-learning.sql","waterx-reference-confirmations.sql","waterx-research.sql","waterx-research-lifecycle.sql","waterx-research-features.sql",
      "waterx-research-shadow.sql","bluewater-research-architecture.sql"])await db.query(readFileSync(`migrations/${file}`,"utf8"));
    // Migration is idempotent and does not remove the original guard names.
    await db.query(readFileSync("migrations/bluewater-research-architecture.sql","utf8"));
    const old=(await db.query("SELECT count(*)::int n FROM pg_trigger WHERE tgname LIKE 'waterx_research_%' AND NOT tgisinternal")).rows[0].n;
    assert.ok(old>=5);
    const t=Date.now(),start=t-250000,end=start+300000;
    await db.query(`INSERT INTO waterx_research_round_policy(interval_minutes,round_id,start_ms,expiry_ms,primary_lock_seconds,
      horizon_seconds,horizon_capture_grace_ms,policy_version)
      VALUES(5,'fixture',$1,$2,60,'[60,45,30,15]',5000,'waterx-research-lifecycle-v2')`,[start,end]);
    const body={formatVersion:"bluewater-numeric-v1" as const,intervalMinutes:5 as const,family:"platt_waterx" as const,
      version:"disposable-synthetic-fixture",featureSchema:FEATURE_SCHEMA,featureNames:["waterx_probability_up"],
      fittedAtMs:t-1000,evidenceThroughMs:t-2000,datasetFingerprint:"a".repeat(64),calibration:{slope:2,intercept:0},
      parameters:{},protocol:{eligible:true,records:120,spanMs:172800000,training:70,calibration:24,test:24},
      dateRange:{fromMs:t-172800000,throughMs:t-2000},partitions:{},hyperparameters:{},metrics:{}};
    const artifact:ModelArtifact={...body,id:digest(body),artifactDigest:digest(body)};await persistArtifact(db,artifact);
    const decision=Date.now(),f=buildFeatureSnapshot({intervalMinutes:5,roundId:"fixture",startMs:start,expiryMs:end,decisionAtMs:decision,
      market:[{sourceAtMs:decision,receivedAtMs:decision,probabilityUp:.6,probabilityDown:.4}],ticks:[],reference:null});
    const save=async(point:typeof f)=>{const {digest:h,...payload}=point;return db.query(`INSERT INTO waterx_research_feature_snapshots
      (feature_snapshot_digest,interval_minutes,round_id,start_ms,expiry_ms,decision_at_ms,feature_schema_version,feature_snapshot,canonical_payload)
      VALUES($1,5,'fixture',$2,$3,$4,$5,$6::jsonb,$7)`,[h,start,end,point.decisionAtMs,FEATURE_SCHEMA,JSON.stringify(payload),canonical(payload)]);};
    await save(f);const result=infer(artifact,f);
    const values=[start,end,decision,artifact.id,artifact.version,FEATURE_SCHEMA,f.digest,result.rawProbabilityUp,
      result.calibratedProbabilityUp,result.displayedProbabilityUp,result.chosenSide];
    const insert=`INSERT INTO waterx_research_model_forecasts
      (interval_minutes,round_id,start_ms,expiry_ms,lock_seconds,decision_at_ms,model_artifact_id,model_family,model_version,
       artifact_digest,feature_schema_version,feature_snapshot_digest,raw_probability_up,calibrated_probability_up,
       displayed_probability_up,chosen_side,forecast_status)
      VALUES(5,'fixture',$1,$2,60,$3,$4,'platt_waterx',$5,$4,$6,$7,$8,$9,$10,$11,'SHADOW')`;
    // Current synthetic round is late for 60s but on-time for 45s.
    await assert.rejects(db.query(insert,values),/pinned horizon/);
    const validInsert=insert.replace("60,$3","45,$3");
    // Freeze at a controlled future 45s target without backdating any forecast.
    const wait=end-45000-Date.now();if(wait>0)await new Promise(r=>setTimeout(r,wait+10));
    const d=Date.now(),point=buildFeatureSnapshot({...f,decisionAtMs:d,market:[{sourceAtMs:d,receivedAtMs:d,probabilityUp:.6,probabilityDown:.4}],ticks:[],reference:null});
    await save(point);const output=infer(artifact,point),v=[start,end,d,artifact.id,artifact.version,FEATURE_SCHEMA,point.digest,
      output.rawProbabilityUp,output.calibratedProbabilityUp,output.displayedProbabilityUp,output.chosenSide];
    await db.query(validInsert,v);
    for(const table of ["waterx_research_model_forecasts","waterx_research_artifacts","waterx_research_feature_snapshots"])
      for(const mutation of [`DELETE FROM ${table}`,`UPDATE ${table} SET ${table.includes("forecasts")?"raw_probability_up=0.1":table.includes("artifacts")?"model_version='changed'":"feature_schema_version='changed'"}`])
        await assert.rejects(db.query(mutation),/append-only/);
    await assert.rejects(db.query(validInsert,v),/duplicate key/);
    await assert.rejects(db.query(validInsert.replace("'SHADOW'","'CHAMPION'"),v),/manual approval/);
    const changed=[...v];changed[7]=.61;
    await assert.rejects(db.query(validInsert,changed),/not reproducible/);
    const tampered={...point,values:{...point.values,waterx_probability_up:.99}};const {digest:h,...payload}=tampered;
    await assert.rejects(save({...tampered,digest:digest(payload)}),/provenance/);
    for(const key of ["sourceAtMs","receivedAtMs"] as const){
      const payload={...point,provenance:{...point.provenance,market:[{...point.provenance.market[0],[key]:d+1000}]}};
      const {digest:h,...body}=payload;await assert.rejects(save({...payload,digest:digest(body)}),/anti-lookahead/);
    }
    await assert.rejects(db.query(`INSERT INTO waterx_research_champion_events
      (interval_minutes,artifact_id,event_type,approval_source,approval_reason,promotion_report)
      VALUES(5,$1,'ACTIVATE','development-owner-cli','explicit fixture manual approval','{"eligible":true}')`,[artifact.id]),/insufficient/);
    await assert.rejects(db.query(`INSERT INTO waterx_research_model_results
      (interval_minutes,round_id,model_artifact_id,lock_seconds,event_type,outcome,correct,brier,log_loss,label_available_at,settlement_evidence)
      VALUES(5,'fixture',$1,45,'SCORED','UP',true,0.1,0.1,clock_timestamp(),'{}')`,[artifact.id]),/verified WaterX settlement/);
    assert.equal((await db.query("SELECT count(*)::int n FROM waterx_research_choices")).rows[0].n,0,"Separate forecasts do not create/rewrite baseline choices");
    const report=await getBluewaterReport(5,{id:"fixture"},db);
    assert.equal(report.schemaStatus,"available",report.reason??"");assert.equal(report.status,"SHADOW");
    assert.equal(report.currentForecast,null);assert.equal(report.qualifiedCalibration,false);
  }finally{await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();}
});
test.after(()=>researchPool.end());