import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {canonicalWaterxRoundKey,sameWaterxRound,stageScore} from "../shared/waterx-round-identity";
import {createSettlementReconciler} from "../server/waterx/settlement-reconciler";
import {waterxSettlementRejection} from "../server/waterx/learning";
import {scoreStageRounds} from "../server/waterx/two-stage-history";
import {recoverMissingStageAssessments} from "../server/waterx/two-stage-recovery";
import {TWO_STAGE_STRATEGY,type TwoStageRoundRow,type StageLock} from "../shared/two-stage";
import type {WaterxDetail} from "../server/waterx/types";

const round={intervalMinutes:5 as const,roundId:"audit-round",startMs:1791493200000,expiryMs:1791493500000};
const detail:WaterxDetail={market:{slug:"crypto-btc-updown-5m",marketId:"audit-market"},
  round:{id:round.roundId,marketId:"audit-market",slug:"crypto-btc-updown-5m",
    startsAt:round.startMs/1000,endsAt:round.expiryMs/1000,phase:"ended",anchorPrice:100,anchorPriceConfirmed:true,
    referenceUnavailableReason:null,settlePrice:101,resolutionStatus:"resolved",
    settlement:{outcome:"up",settledAt:round.expiryMs/1000+53},
    sides:{up:{oddsCents:null,probabilityCents:null,availability:"unavailable",reason:null},
      down:{oddsCents:null,probabilityCents:null,availability:"unavailable",reason:null}}},
  neighbors:{past:[],upcoming:[]}};
function harness(){
  let now=round.expiryMs+120000,claimedAt=-Infinity,verified=false,outage=false,proof=structuredClone(detail);
  const events:string[]=[],rejections:string[]=[],counts={saves:0,reads:0};
  const deps:Parameters<typeof createSettlementReconciler>[0]={
    now:()=>now,
    list:async()=>!verified&&now-claimedAt>=30000?[round]:[],
    claim:async()=>{if(verified||now-claimedAt<30000)return false;claimedAt=now;return true;},
    read:async()=>{counts.reads++;if(outage)throw new Error("fixture provider outage");return proof;},
    save:async input=>{
      counts.saves++;
      const rejection=waterxSettlementRejection(input,{start_ms:round.startMs,expiry_ms:round.expiryMs,
        interval_minutes:5,round_id:round.roundId,anchor_price:100,anchor_confirmed:true,outcome:null});
      if(rejection)rejections.push(rejection);else verified=true;
      return !rejection;
    },
    event:async(_round,code)=>{events.push(code);},
  };
  return {deps,counts,events,rejections,get verified(){return verified;},
    advance:()=>{now+=60000;},outage:(value:boolean)=>{outage=value;},
    proof:(value:WaterxDetail)=>{proof=value;}};
}
test("canonical identity rejects interval, ID, start and closing-boundary mismatches",()=>{
  assert.ok(canonicalWaterxRoundKey(round));
  assert.ok(sameWaterxRound(round,{...round}));
  assert.equal(sameWaterxRound(round,{...round,roundId:"another"}),false);
  assert.equal(sameWaterxRound(round,{...round,startMs:round.startMs+1}),false);
  assert.equal(sameWaterxRound(round,{...round,intervalMinutes:15}),false);
});
test("settlement outage recovery survives a new reconciler without a live quote or frontend session",async()=>{
  const h=harness();h.outage(true);
  await createSettlementReconciler(h.deps).run(5);
  assert.equal(h.verified,false);assert.equal(h.counts.saves,0);
  h.advance();h.outage(false);
  await createSettlementReconciler(h.deps).run(5);
  assert.ok(h.verified);assert.ok(h.events.includes("SETTLEMENT_RETRY_FAILED"));
  assert.ok(h.events.includes("SETTLEMENT_LABEL_ACCEPTED"));
});
test("duplicate jobs coalesce and restarted consumers cannot relabel a verified round",async()=>{
  const h=harness(),worker=createSettlementReconciler(h.deps);
  await Promise.all([worker.run(5),worker.run(5),worker.run(5)]);
  await createSettlementReconciler(h.deps).run(5);
  assert.equal(h.counts.reads,1);assert.equal(h.counts.saves,1);
});
test("withheld settlement retains strict post-expiry timestamp proof; recovery never invents the timestamp",async()=>{
  const h=harness(),bad=structuredClone(detail);bad.round.settlement!.settledAt=round.expiryMs/1000;
  h.proof(bad);await createSettlementReconciler(h.deps).run(5);
  assert.equal(h.verified,false);assert.match(h.rejections[0],/after the round end/);
  assert.ok(h.events.includes("SETTLEMENT_PROOF_WITHHELD"));
  h.advance();h.proof(detail);await createSettlementReconciler(h.deps).run(5);
  assert.ok(h.verified);
});
test("identity mismatch never persists a provider outcome under a different exact round",async()=>{
  const h=harness(),wrong=structuredClone(detail);wrong.round.startsAt++;
  h.proof(wrong);await createSettlementReconciler(h.deps).run(5);
  assert.equal(h.counts.saves,0);assert.equal(h.verified,false);
  assert.ok(h.events.includes("SETTLEMENT_IDENTITY_MISMATCH"));
});
test("unresolved provider proofs are retained without creating historical predictions or verified labels",async()=>{
  const h=harness(),pending=structuredClone(detail);
  pending.round.resolutionStatus="pending";pending.round.settlement=null;pending.round.settlePrice=null;
  h.proof(pending);await createSettlementReconciler(h.deps).run(5);
  assert.equal(h.verified,false);assert.equal(h.counts.saves,1);
  assert.match(h.rejections[0],/resolutionStatus/);
});
test("each lock scores independently; missing, abstained, withheld and disputed states are separate",()=>{
  const base={outcome:"UP" as const,settlementStatus:"VERIFIED" as const,reason:"",dataFailure:false};
  assert.equal(stageScore({...base,side:"UP"}),"CORRECT");
  assert.equal(stageScore({...base,side:"DOWN"}),"INCORRECT");
  assert.equal(stageScore({...base,side:"UP",settlementStatus:"DISPUTED"}),"DISPUTED");
  assert.equal(stageScore({...base,side:"UP",settlementStatus:"WITHHELD"}),"WITHHELD");
  assert.equal(stageScore({...base,side:null}),"NO_LOCK");
  assert.equal(stageScore({...base,side:null,reason:"CONFIRMATION_POLICY_NOT_QUALIFIED"}),"ABSTAINED");
  assert.equal(stageScore({...base,side:null,dataFailure:true}),"DATA_FAILURE");
});
test("paired win rates use only both-locked verified pairs, not early-only or disputed rounds",()=>{
  const lock=(side:"UP"|"DOWN")=>({side,economics:{kind:"INDICATIVE"},committedAtMs:null,
    calibrationStatus:"UNQUALIFIED"}) as StageLock;
  const row=(early:"UP"|"DOWN",confirmation:"UP"|"DOWN",status:"VERIFIED"|"DISPUTED"="VERIFIED")=>
    ({...round,marketId:"audit-market",early:lock(early),confirmation:lock(confirmation),
      outcome:"UP",settlementStatus:status,disputed:status==="DISPUTED",dataFailure:false,
      earlyReason:"",confirmationReason:"",relationship:"Changed direction"}) as TwoStageRoundRow;
  const result=scoreStageRounds([row("UP","DOWN"),row("DOWN","UP"),row("UP","UP","DISPUTED")]);
  assert.equal(result.pairedRates.scoredN,2);assert.equal(result.pairedRates.earlyAccuracy,.5);
  assert.equal(result.pairedRates.confirmationAccuracy,.5);
  assert.equal(result.paired.BOTH_PENDING_OR_DISPUTED,1);
  assert.equal(scoreStageRounds([]).pairedRates.earlyAccuracy,null);
});
test("restart records missing expired assessments idempotently without inserting late locks",
  {skip:process.env.RUN_TIMED_POSTGRES_TESTS!=="1"},async()=>{
    const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1}),id=`audit-recovery-${randomUUID()}`;
    try{
      await db.query(readFileSync(new URL("../migrations/waterx-two-stage.sql",import.meta.url),"utf8"));
      await db.query(`INSERT INTO waterx_two_stage_rounds
        (network,market_id,round_id,interval_minutes,strategy_version,start_ms,expiry_ms,discovered_at_ms,capture_mode)
        VALUES('sui:mainnet','audit-market',$1,5,$2,300000,600000,300001,'PROSPECTIVE')`,[id,TWO_STAGE_STRATEGY]);
      await recoverMissingStageAssessments(db,600001);
      await recoverMissingStageAssessments(db,600001);
      const assessments=await db.query("SELECT * FROM waterx_two_stage_assessments WHERE round_id=$1",[id]);
      assert.equal(assessments.rows.length,2);
      assert.ok(assessments.rows.every(r=>r.reason==="MISSING_DURABLE_ASSESSMENT_AFTER_RECOVERY"));
      const locks=await db.query("SELECT * FROM waterx_two_stage_locks WHERE round_id=$1",[id]);
      assert.equal(locks.rows.length,0);
    }finally{await db.query("DELETE FROM waterx_two_stage_assessments WHERE round_id=$1",[id]);
      await db.query("DELETE FROM waterx_two_stage_rounds WHERE round_id=$1",[id]);await db.end();}
  });
