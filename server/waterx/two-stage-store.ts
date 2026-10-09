import {randomUUID} from "node:crypto";
import type {LockDb} from "./lock-store";
import {TWO_STAGE_STRATEGY,TWO_STAGE_FEATURES,type StageLock,type StageInput,type LockStage} from "../../shared/two-stage";
import {assessStage,type LearnedStagePolicy} from "./two-stage-policy";
import {sameWaterxRound,canonicalWaterxRoundKey} from "../../shared/waterx-round-identity";
export const stageIdentity=(r:Pick<StageInput,"marketId"|"roundId"|"intervalMinutes">)=>
  ["sui:mainnet",r.marketId,r.roundId,r.intervalMinutes,TWO_STAGE_STRATEGY];
export async function readStageLocks(input:StageInput,db:LockDb){
  canonicalWaterxRoundKey(input);
  const rows=await db.query(`SELECT d.decision,o.committed_ack_at_ms FROM waterx_two_stage_locks d
    JOIN waterx_two_stage_outbox o ON o.decision_id=d.id WHERE network=$1 AND market_id=$2
    AND round_id=$3 AND interval_minutes=$4 AND strategy_version=$5`,stageIdentity(input));
  return rows.rows.map(row=>{
    const d={...(row.decision as StageLock),commitVerified:true as const};
    if(d.marketId!==input.marketId||!sameWaterxRound(d,input)||d.network!=="sui:mainnet"||
       d.strategyVersion!==TWO_STAGE_STRATEGY||!["EARLY","CONFIRMATION"].includes(d.stage))
      throw new Error("TWO_STAGE_IDENTITY_MISMATCH");
    d.committedAtMs=row.committed_ack_at_ms==null?null:Number(row.committed_ack_at_ms);return d;
  });
}
export async function commitStage(input:StageInput,stage:LockStage,early:StageLock|null,policy:LearnedStagePolicy|null,
  db:LockDb,current:()=>boolean,now:()=>number){
  canonicalWaterxRoundKey(input);
  input={...input,observations:input.observations.filter(o=>o.availableAtMs<=input.nowMs&&o.receivedAtMs<=input.nowMs)};
  const assessment=assessStage(input,stage,early,policy),latest=input.observations.at(-1);
  if(!assessment.eligible||!assessment.side||!assessment.economics||!latest||!current())return null;
  const frozen=input.observations.filter(o=>o.availableAtMs<=input.nowMs);
  const d:StageLock={...input,observations:undefined,nowMs:undefined,id:randomUUID(),network:"sui:mainnet",
    marketId:input.marketId,strategyVersion:TWO_STAGE_STRATEGY,stage,side:assessment.side,
    evidenceCutoffMs:input.nowMs,qualifiedAtMs:input.nowMs,committedAtMs:null,
    elapsedMs:input.nowMs-input.startMs,remainingMs:input.expiryMs-input.nowMs,
    probabilityUp:assessment.probabilityUp!,probabilitySource:assessment.probabilitySource!,
    calibrationStatus:assessment.calibrationStatus!,modelVersion:assessment.modelVersion!,
    policyVersion:assessment.policyVersion!,featureVersion:TWO_STAGE_FEATURES,
    observationIds:frozen.map(o=>o.id),economics:assessment.economics,
    researchPreference:assessment.researchPreference,valueStatus:assessment.valueStatus,
    diagnostics:assessment.diagnostics,
    timing:{receivedAtMs:latest.receivedAtMs,acceptedAtMs:latest.availableAtMs,qualifiedAtMs:input.nowMs,
      acquisitionStartedAtMs:typeof latest.features.shadowAcquisitionStartedAtMs==="number"?latest.features.shadowAcquisitionStartedAtMs:null,
      acquiredAtMs:typeof latest.features.shadowAcquiredAtMs==="number"?latest.features.shadowAcquiredAtMs:null,
      commitAcknowledgedAtMs:null,projectionAtMs:null},
    reference:{value:latest.features.reference??null,status:latest.features.referenceQuality??"unavailable",
      providerUrl:latest.features.providerUrl??null,oracleVerification:"UNVERIFIED"},
    coverage:{observations:frozen.length,sourceHealthy:latest.sourceHealthy,
      missingIntervals:assessment.priceFeatures?.missingMs??null,clockDomain:latest.features.decisionClockDomain??null,
      deploymentId:latest.features.deploymentId??null,
       availabilityBasis:"APPLICATION_AVAILABLE_BEFORE_ARCHIVE; frozen qualification cutoff; commit follows durable observation read"},
    features:{...assessment.priceFeatures,marketProbabilityUp:latest.probabilityUp,
      priceObservations:input.priceObservations??[],researchPolicyExperimental:true},
    captureMode:latest.provenance,shadowOnly:true,automaticExecutionAllowed:false} as StageLock;
  let attempted=false,began=false;
  try{
    await db.query("BEGIN");began=true;
    const lock=await db.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",[stageIdentity(input).join(":")]);
    if(!lock.rows[0]?.acquired){await db.query("ROLLBACK");began=false;return null;}
    const round=(await db.query(`SELECT start_ms,expiry_ms FROM waterx_two_stage_rounds WHERE network=$1 AND market_id=$2
      AND round_id=$3 AND interval_minutes=$4 AND strategy_version=$5 FOR SHARE`,stageIdentity(input))).rows[0];
    if(!round||Number(round.start_ms)!==input.startMs||Number(round.expiry_ms)!==input.expiryMs)throw new Error("TWO_STAGE_IDENTITY_MISMATCH");
    const existing=(await readStageLocks(input,db)).find(d=>d.stage===stage);
    if(existing){await db.query("ROLLBACK");began=false;return existing;}
    const newest=(await db.query(`SELECT input FROM waterx_two_stage_observations
      WHERE network=$1 AND market_id=$2 AND round_id=$3 AND interval_minutes=$4 AND strategy_version=$5
      ORDER BY received_at_ms DESC LIMIT 1`,stageIdentity(input))).rows[0]?.input;
    const materiallyValid=!newest||candidateStillValid(input,newest as import("../../shared/event-lock").EventObservation,now());
    if(!current()||!materiallyValid||!assessStage({...input,nowMs:now()},stage,early,policy).eligible){
      await db.query("ROLLBACK");began=false;return null;
    }
    await db.query(`INSERT INTO waterx_two_stage_locks(id,network,market_id,round_id,interval_minutes,strategy_version,lock_stage,decision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[d.id,...stageIdentity(input),stage,JSON.stringify(d)]);
    await db.query("INSERT INTO waterx_two_stage_outbox(decision_id) VALUES($1)",[d.id]);
    if(!current()||now()>=input.expiryMs){await db.query("ROLLBACK");began=false;return null;}
    attempted=true;await db.query("COMMIT");began=false;
    d.committedAtMs=now();d.commitVerified=true;
    if(d.timing)d.timing.commitAcknowledgedAtMs=d.committedAtMs;
    // Visibility of the immutable row proves commit even if this ACK journal fails.
    await db.query("UPDATE waterx_two_stage_outbox SET committed_ack_at_ms=coalesce(committed_ack_at_ms,$2) WHERE decision_id=$1",
      [d.id,d.committedAtMs]).catch(()=>{});
    return d;
  }catch(error){
    if(began)await db.query("ROLLBACK").catch(()=>{});
    if(attempted){
      try{const saved=(await readStageLocks(input,db)).find(d=>d.stage===stage);if(saved)return saved;}
      catch{throw new Error("UNKNOWN_TWO_STAGE_COMMIT",{cause:error});}
    }
    throw error;
  }
}
/** A new receipt alone never invalidates a frozen candidate. A stale, failed,
 * opposite-side or below-floor latest receipt does. Identity/expiry stay guarded. */
export function candidateStillValid(input:StageInput,newest:import("../../shared/event-lock").EventObservation,now:number){
  const anchor=input.observations.at(-1);
   if(!anchor||now>=input.expiryMs||now-anchor.receivedAtMs>5000||!newest.sourceHealthy||now-newest.receivedAtMs>5000||
    newest.receivedAtMs>=input.expiryMs||newest.availableAtMs>now||
    newest.features.eventGapResetAtMs)return false;
   if(newest.features.reference!==anchor.features.reference)return false;
  if(newest.receivedAtMs<=anchor.receivedAtMs)return true;
  const side=anchor.probabilityUp>.5?"UP":"DOWN",strength=side==="UP"?newest.probabilityUp:1-newest.probabilityUp;
  return Number.isFinite(strength)&&strength>=.5&&strength>=Math.max(.5,
    Math.max(anchor.probabilityUp,1-anchor.probabilityUp)-.05);
}
