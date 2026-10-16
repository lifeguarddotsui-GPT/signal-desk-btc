/**
 * REAL PostgreSQL integration smoke test in a disposable GitHub Actions
 * postgres:16 service. NEVER point at Replit or any nonlocal database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Pool} from "pg";
import {decisionLineage} from "../server/waterx/decision-lineage";
import {TIMED_STRATEGY} from "../shared/timed-decision";
import {TWO_STAGE_STRATEGY} from "../shared/two-stage";

const connectionString=process.env.TEST_POSTGRES_URL;
if(!connectionString)throw new Error("TEST_POSTGRES_URL required for isolated ephemeral CI database.");
const u=new URL(connectionString);
if(!["127.0.0.1","localhost"].includes(u.hostname)||u.pathname!=="/lineage_ci")
  throw new Error("Lineage SQL integration test REFUSES nonlocal or non-ephemeral DB.");
const pool=new Pool({connectionString,max:1,connectionTimeoutMillis:3000});
test("real PostgreSQL source schema, exact join, settlement scoring and read-only explain",async()=>{
  const client=await pool.connect();
  try{
    const sql=(path:string)=>readFileSync(new URL("../migrations/"+path,import.meta.url),"utf8");
    await client.query("CREATE TABLE bluewater_agent_ledger(owner text,round_key text,event text)");
    for(const name of [
      "waterx-learning.sql",
      "waterx-reference-confirmations.sql",
      "waterx-timed-decisions.sql",
      "waterx-two-stage.sql",
      "waterx-research.sql",
    ])await client.query(sql(name));
    const now=Date.now();
    const start=now-3_900_000,expiry=start+300_000;
    const round="lineage-integration-"+process.pid,market="waterx-fixture-market";
    const network="sui:mainnet",interval=5;
    await client.query(
      "INSERT INTO waterx_timed_rounds(network,strategy_version,interval_minutes,round_id,start_ms,expiry_ms,discovered_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [network,TIMED_STRATEGY,interval,round,start,expiry,start+1000]
    );
    const primary={
      strategyVersion:TIMED_STRATEGY,network,intervalMinutes:interval,roundId:round,
      startMs:start,expiryMs:expiry,status:"LOCKED",side:"DOWN",probabilityUp:.25,
      decisionAtMs:start+60_000,lockReason:"QUALIFIED"
    },primaryId="c7055c11-9542-4476-8c42-735725493631";
    await client.query(
      "INSERT INTO waterx_timed_decisions(id,network,strategy_version,interval_minutes,round_id,decision_at_ms,status,decision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [primaryId,network,TIMED_STRATEGY,interval,round,start+60_000,"LOCKED",primary]
    );
    await client.query(
      "INSERT INTO waterx_timed_outbox(decision_id,committed_ack_at_ms) VALUES($1,$2)",
      [primaryId,start+62_000]
    );
    await client.query(
      "INSERT INTO waterx_two_stage_rounds(network,market_id,round_id,interval_minutes,strategy_version,start_ms,expiry_ms,discovered_at_ms,capture_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [network,market,round,interval,TWO_STAGE_STRATEGY,start,expiry,start+2000,"PROSPECTIVE"]
    );
    const early={
      network,marketId:market,roundId:round,intervalMinutes:interval,startMs:start,expiryMs:expiry,
      strategyVersion:TWO_STAGE_STRATEGY,stage:"EARLY",side:"UP",
      probabilityUp:.75,qualifiedAtMs:start+23_000,policyVersion:"stage-evidence-v1",
      modelVersion:null,probabilitySource:"WATERX_MARKET",
      shadowOnly:true,automaticExecutionAllowed:false
    },earlyId="97b58032-f6d5-4254-b58a-89f1e6622d16";
    await client.query(
      "INSERT INTO waterx_two_stage_locks(id,network,market_id,round_id,interval_minutes,strategy_version,lock_stage,decision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [earlyId,network,market,round,interval,TWO_STAGE_STRATEGY,"EARLY",early]
    );
    await client.query(
      "INSERT INTO waterx_two_stage_outbox(decision_id,committed_ack_at_ms) VALUES($1,$2)",
      [earlyId,start+25_000]
    );
    await client.query(
      "INSERT INTO waterx_learning_rounds(interval_minutes,round_id,start_ms,expiry_ms,observed_at,source_proof,label_status,settlement_anchor_price,settle_price,outcome,settled_at,first_verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [interval,round,start,expiry,new Date(start+1000),{},"verified",100,99,"Down",expiry+2000,new Date(expiry+3000)]
    );
    const before=await client.query("SELECT count(*)::int AS n FROM waterx_timed_decisions");
    assert.equal(before.rows[0].n,1);
    await client.query("BEGIN TRANSACTION READ ONLY");
    try{
      let readSQL="",params:unknown[]=[];
      const db={query:async(text:string,args:unknown[])=>{
        readSQL=text;params=args;
        return client.query(text,args);
      }};
      const report=await decisionLineage({interval:"5",window:"24h",limit:20},now,db as any);
      assert.equal(report.cohortN,1);
      assert.equal(report.rows[0].primary.score,"CORRECT");
      assert.equal(report.rows[0].early.score,"INCORRECT");
      assert.equal(report.rows[0].confirmation.score,"NO_LOCK");
      assert.equal(report.stats.primary.correct,1);
      assert.equal(report.stats.early.incorrect,1);
      assert.equal(report.paired.verifiedN,1);
      const plan=await client.query(
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+readSQL,params
      );
      const item=plan.rows[0]["QUERY PLAN"][0];
      assert.equal(item.Plan["Actual Rows"],1);
      assert.ok(item["Execution Time"]>=0);
      console.log("POSTGRES LINEAGE CI: read-only EXPLAIN ms",item["Execution Time"]);
    }finally{await client.query("ROLLBACK")}
    const after=await client.query("SELECT count(*)::int AS n FROM waterx_timed_decisions");
    assert.equal(after.rows[0].n,before.rows[0].n,"lineage history must not mutate a row");
  }finally{client.release();await pool.end()}
},{timeout:120_000});
