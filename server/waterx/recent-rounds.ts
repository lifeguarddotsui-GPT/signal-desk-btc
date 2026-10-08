import pg from "pg";
import {recentWaterxRounds} from "./source";
import {recordWaterxSettlement,type WaterxQueryable} from "./learning";
import {decisionWriterAllowed} from "./decision-authority";
import type {WaterxDetail,WaterxInterval,WaterxRound} from "./types";
import {canonicalWaterxRoundKey} from "../../shared/waterx-round-identity";

/** Discovery metadata only: there was no historical model observation or lock. */
export async function captureRecentWaterxSettlement(interval:WaterxInterval,r:WaterxRound,observedAtMs:number,
  db:WaterxQueryable,displayOutcomes?:WaterxDetail["market"]["recentOutcomes"]){
  const identity={intervalMinutes:interval,roundId:r.id,startMs:r.startsAt*1000,expiryMs:r.endsAt*1000};
  canonicalWaterxRoundKey(identity);
  if(identity.expiryMs>observedAtMs)return false;
  const provisionalOutcome=/^(up|down)$/i.test(r.settlement?.outcome??"")?
    r.settlement!.outcome!.toUpperCase():null;
  const diagnostic={source:"WATERX_NEIGHBORS_PAST",...identity,marketId:r.marketId,
    unassociatedDisplay:displayOutcomes?{outcomes:displayOutcomes,status:"PROVISIONAL_UNASSOCIATED",
      note:"WaterX display badges have no round IDs. Never align them by array position or score them."}:null,
    observedAtMs,providerResolutionStatus:r.resolutionStatus,providerOutcome:provisionalOutcome,
    anchorPrice:r.anchorPrice,anchorConfirmed:r.anchorPriceConfirmed,settlePrice:r.settlePrice,
    settledAtMs:r.settlement?.settledAt==null?null:r.settlement.settledAt*1000,
    unverifiedPriceDirection:r.anchorPriceConfirmed&&r.anchorPrice&&r.settlePrice?
      r.settlePrice>=r.anchorPrice?"UP":"DOWN":null,
    note:"Price-derived direction is diagnostic only, never a verified provider outcome."};
  await db.query(`INSERT INTO waterx_learning_rounds(interval_minutes,round_id,start_ms,expiry_ms,
    anchor_price,anchor_confirmed,probability_up,observed_at,source_proof,label_status)
    VALUES($1,$2,$3,$4,NULL,false,NULL,to_timestamp($5::double precision/1000),$6,'unresolved')
    ON CONFLICT(interval_minutes,round_id) DO NOTHING`,
    [interval,r.id,identity.startMs,identity.expiryMs,observedAtMs,
      JSON.stringify({kind:"RECENT_ROUNDS_SETTLEMENT_METADATA_ONLY",recentRoundsEvidence:diagnostic})]);
  const updated=await db.query(`UPDATE waterx_learning_rounds SET source_proof=source_proof||
    jsonb_build_object('recentRoundsEvidence',$5::jsonb)
    WHERE interval_minutes=$1 AND round_id=$2 AND start_ms=$3 AND expiry_ms=$4 RETURNING round_id`,
    [interval,r.id,identity.startMs,identity.expiryMs,JSON.stringify(diagnostic)]);
  if(!updated.rows.length)throw new Error("RECENT_ROUNDS_EXACT_IDENTITY_MISMATCH");
  return recordWaterxSettlement({intervalMinutes:interval,roundId:r.id,startMs:identity.startMs,
    expiryMs:identity.expiryMs,anchorPrice:r.anchorPrice,anchorConfirmed:r.anchorPriceConfirmed,
    settlePrice:r.settlePrice,outcome:r.settlement?.outcome??null,
    settledAt:r.settlement?.settledAt==null?null:r.settlement.settledAt*1000,
    // Buffered source receipt is retained above, but a delayed database retry
    // must not backdate when the app actually accepted a verified label.
    observedAt:new Date().toISOString(),
    resolutionStatus:r.resolutionStatus?.trim().toLowerCase()},db);
}

export function createRecentRoundsCollector(options:{db:WaterxQueryable;now?:()=>number;allowed?:()=>boolean;
  save?:typeof captureRecentWaterxSettlement}){
  const now=options.now??Date.now,allowed=options.allowed??decisionWriterAllowed;
  const queued=new Map<string,{interval:WaterxInterval;round:WaterxRound;at:number;fingerprint:string;
    displayOutcomes?:WaterxDetail["market"]["recentOutcomes"]}>();
  const saved=new Map<string,string>();
  let job:Promise<void>|null=null,retryAt=0,failures=0,rejected=0,dropped=0,processed=0;
  const tick=()=>{
    if(job||!allowed()||now()<retryAt||!queued.size)return job??Promise.resolve();
    job=(async()=>{
      for(const [key,item] of Array.from(queued).slice(0,10)){
        await (options.save??captureRecentWaterxSettlement)(item.interval,item.round,item.at,options.db,item.displayOutcomes);
        saved.set(key,item.fingerprint);processed++;
        if(queued.get(key)===item)queued.delete(key);
        while(saved.size>256)saved.delete(saved.keys().next().value!);
      }
    })().catch(()=>{failures++;retryAt=now()+30000;})
      .finally(()=>{job=null;});
    return job;
  };
  return {tick,observe(detail:WaterxDetail,interval:WaterxInterval,at=now()){
    if(!allowed())return;
    const parsed=recentWaterxRounds(detail,interval,at);rejected+=parsed.rejected.length;
    for(const round of parsed.rounds){
      const key=canonicalWaterxRoundKey({intervalMinutes:interval,roundId:round.id,
        startMs:round.startsAt*1000,expiryMs:round.endsAt*1000});
      const fingerprint=JSON.stringify([round.anchorPrice,round.anchorPriceConfirmed,round.settlePrice,
        round.resolutionStatus,round.settlement]);
      if(saved.get(key)===fingerprint)continue;
      queued.set(key,{interval,round,at,fingerprint,displayOutcomes:detail.market.recentOutcomes});
      while(queued.size>64){queued.delete(queued.keys().next().value!);dropped++;}
    }
    void tick();
  },idle:async()=>{if(job)await job;},
    health:()=>({processed,failures,rejected,dropped,queued:queued.size,retryAtMs:retryAt,
      providerReadsAdded:0,mode:"EXISTING_COLLECTOR_NEIGHBORS_PAST"})};
}
const recentDb=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,
  connectionTimeoutMillis:5000,statement_timeout:5000,query_timeout:5000,allowExitOnIdle:true});
recentDb.on("error",()=>console.warn("Recent Rounds database connection unavailable; evidence will retry."));
export const recentRoundsCollector=createRecentRoundsCollector({db:recentDb});
