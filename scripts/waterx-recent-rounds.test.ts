import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {recentWaterxRounds} from "../server/waterx/source";
import {captureRecentWaterxSettlement,createRecentRoundsCollector} from "../server/waterx/recent-rounds";
import {recordWaterxSettlement,finishWaterxSettlementAttempt} from "../server/waterx/learning";
import {recoverSavedPredictionSettlementQueue} from "../server/waterx/two-stage-recovery";
import {freezeResearchDecision,unavailableComparison} from "../server/waterx/research-decision";
import {researchChoiceInsert,researchChoiceValues} from "../server/waterx/research-store";
import type {WaterxDetail,WaterxRound} from "../server/waterx/types";
const start=1791493200000,end=start+300000,now=end+120000;
function round(outcome:"up"|"down"="up"):WaterxRound{
  return {id:randomUUID(),marketId:"fixture-market",slug:"crypto-btc-updown-5m",
    startsAt:start/1000,endsAt:end/1000,phase:"ended",anchorPrice:100,anchorPriceConfirmed:true,
    referenceUnavailableReason:null,settlePrice:outcome==="up"?101:99,resolutionStatus:"resolved",
    settlement:{outcome,settledAt:end/1000+53},
    sides:{up:{oddsCents:null,probabilityCents:null,availability:"unavailable",reason:null},
      down:{oddsCents:null,probabilityCents:null,availability:"unavailable",reason:null}}};
}
function detail(past:unknown[]):WaterxDetail{return {
  market:{slug:"crypto-btc-updown-5m",marketId:"fixture-market"},
  round:{...round(),startsAt:end/1000,endsAt:end/1000+300,phase:"live",settlement:null,resolutionStatus:null},
  neighbors:{past,upcoming:[]}};}
test("Recent Rounds validates full identity, ignores active entries and does not zip display outcomes",()=>{
  const ended=round(),d=detail([ended]);
  d.neighbors.past.unshift(d.round);
  assert.deepEqual(recentWaterxRounds(d,5,now).rounds.map(r=>r.id),[ended.id]);
  assert.throws(()=>recentWaterxRounds(d,15,now),/interval mismatch/);
  const malformed=recentWaterxRounds(detail([{...ended,marketId:"wrong"}, {id:randomUUID()},ended]),5,now);
  assert.equal(malformed.rejected.length,2);assert.equal(malformed.rounds.length,1);
  const conflicting=recentWaterxRounds(detail([ended,{...ended,startsAt:ended.startsAt-300,endsAt:ended.endsAt-300}]),5,now);
  assert.equal(conflicting.rounds.length,0);assert.equal(conflicting.rejected.length,1);
});
test("optional Recent Rounds buffering retries outages without another API read or browser",async()=>{
  let at=now,fail=true,writes=0;
  const collector=createRecentRoundsCollector({db:{} as any,allowed:()=>true,now:()=>at,
    save:async()=>{writes++;if(fail)throw new Error("fixture outage");return true;}});
  const d=detail([round()]);
  collector.observe(d,5);await collector.idle();
  assert.equal(collector.health().queued,1);
  fail=false;await collector.tick();assert.equal(writes,1);
  at+=30000;await collector.tick();assert.equal(collector.health().queued,0);
  collector.observe(d,5);await collector.idle();assert.equal(writes,2);
  assert.equal(collector.health().providerReadsAdded,0);
});
test("Recent Rounds capture verifies UP and DOWN, holds incomplete proofs, and never changes decisions",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1"},async()=>{
    const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
    try{
      for(const name of ["waterx-learning.sql","waterx-reference-confirmations.sql","waterx-two-stage.sql"])
        await db.query(readFileSync(`migrations/${name}`,"utf8"));
      const fingerprint=async()=> (await db.query(`SELECT md5(coalesce(string_agg(id::text||decision::text,',' ORDER BY id),'')) AS hash
        FROM waterx_two_stage_locks`)).rows[0].hash;
      const before=await fingerprint();
      for(const outcome of ["up","down"] as const){
        const r=round(outcome);
        const acceptedAfter=Date.now();
        assert.equal(await captureRecentWaterxSettlement(5,r,now,db),true);
        assert.equal(await captureRecentWaterxSettlement(5,r,now+1,db),true);
        const saved=(await db.query("SELECT * FROM waterx_learning_rounds WHERE round_id=$1",[r.id])).rows[0];
        assert.equal(saved.label_status,"verified");assert.equal(saved.outcome,outcome==="up"?"Up":"Down");
        assert.equal(saved.probability_up,null);assert.equal(Number(saved.anchor_price),100);
        assert.equal(Number(saved.settle_price),r.settlePrice);
        assert.ok(new Date(saved.first_verified_at).getTime()>=acceptedAfter);
      }
      const provisional=round();provisional.settlement!.settledAt=null;
      assert.equal(await captureRecentWaterxSettlement(5,provisional,now,db,["DOWN","UP"]),false);
      const withheld=(await db.query("SELECT * FROM waterx_learning_rounds WHERE round_id=$1",[provisional.id])).rows[0];
      assert.equal(withheld.outcome,null);assert.equal(withheld.label_status,"withheld");
      assert.equal(withheld.source_proof.recentRoundsEvidence.providerOutcome,"UP");
      assert.equal(withheld.source_proof.recentRoundsEvidence.unassociatedDisplay.status,"PROVISIONAL_UNASSOCIATED");
      assert.deepEqual(withheld.source_proof.recentRoundsEvidence.unassociatedDisplay.outcomes,["DOWN","UP"]);
      assert.match(withheld.withheld_reason,/settledAt/);
      provisional.settlement!.settledAt=end/1000+53;
      assert.equal(await captureRecentWaterxSettlement(5,provisional,now+1,db),true);
      assert.equal(await fingerprint(),before);
      assert.equal(await recordWaterxSettlement({intervalMinutes:5,roundId:provisional.id,
        startMs:start+1,expiryMs:end,anchorPrice:100,anchorConfirmed:true,settlePrice:101,
        outcome:"up",settledAt:end+53000,observedAt:new Date(now).toISOString(),resolutionStatus:"resolved"},db),false);
    }finally{await db.end();}
  });
test("persistent retry state retains outages and honors bounded exponential delay across restarts",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1"},async()=>{
    const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1}),r=round();
    try{
      r.settlement=null;r.resolutionStatus=null;
      await captureRecentWaterxSettlement(5,r,now,db);
      await db.query(`UPDATE waterx_learning_rounds SET source_proof=source_proof||
        '{"settlementRecovery":{"attempts":4}}'::jsonb WHERE round_id=$1`,[r.id]);
      const before=Date.now();
      await finishWaterxSettlementAttempt(5,r.id,"fixture 503 outage",0,db);
      const proof=(await db.query("SELECT source_proof FROM waterx_learning_rounds WHERE round_id=$1",[r.id])).rows[0].source_proof;
      assert.equal(proof.settlementRecovery.lastError,"fixture 503 outage");
      assert.ok(proof.settlementRecovery.nextAttemptAtMs>=before+239000);
      assert.ok(proof.settlementRecovery.nextAttemptAtMs<=Date.now()+241000);
      assert.equal(proof.recentRoundsEvidence.roundId,r.id);
      await finishWaterxSettlementAttempt(5,r.id,"rate limited",600000,db);
      const updated=(await db.query("SELECT source_proof FROM waterx_learning_rounds WHERE round_id=$1",[r.id])).rows[0].source_proof;
      assert.ok(updated.settlementRecovery.nextAttemptAtMs>=before+600000);
    }finally{await db.end();}
  });
test("saved-primary orphan recovery is idempotent and never redefines it as a stage prediction",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1"},async()=>{
    const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1}),r=round(),at=Date.now();
    const liveStart=Math.floor(at/1000)*1000-240000,liveEnd=liveStart+300000;
    r.startsAt=liveStart/1000;r.endsAt=liveEnd/1000;
    try{
      for(const name of ["waterx-learning.sql","waterx-reference-confirmations.sql","waterx-research.sql","waterx-two-stage.sql"])
        await db.query(readFileSync(`migrations/${name}`,"utf8"));
      const choice=freezeResearchDecision({intervalMinutes:5,roundId:r.id,startMs:liveStart,expiryMs:liveEnd,
        anchorPrice:null,anchorConfirmed:false,probabilityUp:.8,probabilityDown:.2,
        observedAt:new Date(at).toISOString()},at,unavailableComparison("Disposable synthetic recovery test"))!;
      assert.equal(choice.state,"FROZEN");
      await db.query(researchChoiceInsert,researchChoiceValues(choice));
      const before=(await db.query("SELECT row_to_json(c) AS row FROM waterx_research_choices c WHERE round_id=$1",[r.id])).rows[0].row;
      // Simulate deadline passage for metadata only; never write a late decision
      // or claim a verified provider label at this simulated future clock.
      await recoverSavedPredictionSettlementQueue(db,liveEnd+1);
      await recoverSavedPredictionSettlementQueue(db,liveEnd+1);
      const metadata=(await db.query("SELECT * FROM waterx_learning_rounds WHERE round_id=$1",[r.id])).rows[0];
      assert.equal(metadata.probability_up,null);assert.equal(metadata.outcome,null);
      assert.equal(metadata.source_proof.kind,"SAVED_PRIMARY_SETTLEMENT_QUEUE_METADATA_RECOVERY");
      assert.deepEqual((await db.query("SELECT row_to_json(c) AS row FROM waterx_research_choices c WHERE round_id=$1",[r.id])).rows[0].row,before);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM waterx_two_stage_locks WHERE round_id=$1",[r.id])).rows[0].n,0);
    }finally{await db.end();}
  });
