import {randomUUID} from "node:crypto";
import {EVENT_LOCK_STRATEGY,EVENT_FEATURE_VERSION,eventQualification,type EventObservation} from "../../shared/event-lock";
import type {TimedDecision,TimedRound} from "../../shared/timed-decision";
import type {LockDb} from "./lock-store";
import {digestEarlySnapshot} from "./early-horizons";
import {recordEarlyDelivery} from "./early-delivery-metrics";
import {economicEvidenceFromFeatures} from "../../shared/lock-economics";

export const eventIdentity=(r:TimedRound)=>["sui:mainnet",EVENT_LOCK_STRATEGY,r.intervalMinutes,r.roundId];
export async function readEventLock(round:TimedRound,db:LockDb){
  const rows=await db.query(`SELECT d.decision,o.committed_ack_at_ms FROM waterx_timed_decisions d
    JOIN waterx_timed_outbox o ON o.decision_id=d.id WHERE d.network=$1 AND d.strategy_version=$2
    AND d.interval_minutes=$3 AND d.round_id=$4`,eventIdentity(round));
  if(!rows.rows[0])return null;
  const row=rows.rows[0],decision={...(row.decision as TimedDecision)};
  if(decision.strategyVersion!==EVENT_LOCK_STRATEGY||decision.startMs!==round.startMs||
    decision.expiryMs!==round.expiryMs||decision.intervalMinutes!==round.intervalMinutes)
    throw new Error("Event lock identity mismatch");
  decision.committedAtMs=row.committed_ack_at_ms==null?null:Number(row.committed_ack_at_ms);
  decision.acknowledgementStatus=decision.committedAtMs===null?"UNKNOWN":"JOURNALED";
  decision.onTime=decision.committedAtMs===null?null:decision.committedAtMs<round.expiryMs;
  return decision;
}
/** Evidence computation is outside BEGIN. The only work within it is identity,
 * nonblocking serialization, immutable choice/outbox insertion and COMMIT. */
export async function commitEventLock(round:TimedRound,observations:readonly EventObservation[],db:LockDb,
  stillEligible:()=>boolean,now:()=>number,onSaving:()=>void,firstQualifiedAtMs:number){
  const evaluationStarted=performance.now(),evaluatedAtMs=now(),state=eventQualification(round,observations,evaluatedAtMs);
  if(!state.qualified||!state.liveSide||!stillEligible())return null;
  const latest=observations.at(-1)!;
  const frozen=observations.filter(o=>o.availableAtMs<=evaluatedAtMs).map(o=>({...o}));
  const d:TimedDecision={id:randomUUID(),...round,network:"sui:mainnet",strategyVersion:EVENT_LOCK_STRATEGY,
    status:"LOCKED",side:state.liveSide,probabilityUp:latest.probabilityUp,probabilityDown:latest.probabilityDown,
    observationId:latest.id,receivedAtMs:latest.receivedAtMs,decisionAtMs:evaluatedAtMs,
    elapsedMs:evaluatedAtMs-round.startMs,targetAtMs:state.targetAtMs,hardDeadlineAtMs:round.expiryMs,
    lockReason:"FIRST_QUALIFIED_ACCEPTED_OBSERVATION",earlyBlocker:"CONDITIONS_SATISFIED",ambiguous:false,
    coverage:{n:frozen.length,firstAtMs:frozen[0]?.receivedAtMs??null,lastAtMs:latest.receivedAtMs,
      maxGapMs:frozen.length>1?Math.max(...frozen.slice(1).map((o,i)=>o.receivedAtMs-frozen[i].receivedAtMs)):null},
    committedAtMs:null,workerReceivedAtMs:null,onTime:null,operationalFailure:null,automaticExecutionAllowed:false,
    evidence:{featureVersion:EVENT_FEATURE_VERSION,qualification:state.components,firstQualifiedAtMs,
      deploymentId:latest.features.deploymentId??null,
      latestFeatures:{...latest.features},
      entryEconomics:economicEvidenceFromFeatures(latest.features,round.roundId,state.liveSide,evaluatedAtMs),
      evaluationAtMs:evaluatedAtMs,modelVersion:null,calibrationVersion:null,
      probabilitySource:"WaterX market",captureMode:latest.provenance,providerSourceAtMs:null,
      clockDomain:latest.features.decisionClockDomain??null,
      observations:frozen,evidenceDigest:digestEarlySnapshot(frozen),shadowOnly:true}};
  const transactionStarted=performance.now();
  d.evidence.beginRequestedAtMs=now();
  recordEarlyDelivery(round.intervalMinutes,round.roundId,"EVENT_EVALUATION_TO_BEGIN",transactionStarted-evaluationStarted,"ok");
  let began=false,commitAttempted=false;
  try{
    await db.query("BEGIN");began=true;
    const lock=await db.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
      [eventIdentity(round).join(":")]);
    if(!lock.rows[0]?.acquired){await db.query("ROLLBACK");began=false;return null;}
    const identity=(await db.query(`SELECT start_ms,expiry_ms FROM waterx_timed_rounds WHERE network=$1
      AND strategy_version=$2 AND interval_minutes=$3 AND round_id=$4 FOR SHARE`,eventIdentity(round))).rows[0];
    if(!identity||Number(identity.start_ms)!==round.startMs||Number(identity.expiry_ms)!==round.expiryMs)
      throw new Error("Event round identity mismatch");
    const existing=await readEventLock(round,db);
    if(existing){await db.query("ROLLBACK");began=false;return existing;}
    if(!stillEligible()||!eventQualification(round,observations,now()).qualified){
      await db.query("ROLLBACK");began=false;return null;
    }
    d.evidence.transactionBeginSemantics="Before advisory/identity validation; monotonic transaction duration measured separately";
    await db.query(`INSERT INTO waterx_timed_decisions(id,network,strategy_version,interval_minutes,round_id,
      decision_at_ms,status,decision) VALUES($1,$2,$3,$4,$5,$6,'LOCKED',$7)`,
      [d.id,...eventIdentity(round),d.decisionAtMs,JSON.stringify(d)]);
    await db.query("INSERT INTO waterx_timed_outbox(decision_id) VALUES($1)",[d.id]);
    // A new receipt, outage, reversal, rollover or freshness loss while waiting vetoes this candidate.
    if(!stillEligible()||!eventQualification(round,observations,now()).qualified){
      await db.query("ROLLBACK");began=false;return null;
    }
    onSaving();commitAttempted=true;
    await db.query("COMMIT");began=false;
    d.committedAtMs=now();d.acknowledgementStatus="UNJOURNALED";d.onTime=d.committedAtMs<round.expiryMs;
     recordEarlyDelivery(round.intervalMinutes,round.roundId,"EVENT_EVALUATION_TO_ACK",performance.now()-evaluationStarted,"ok");
    recordEarlyDelivery(round.intervalMinutes,round.roundId,"EVENT_FINAL_TRANSACTION",
      performance.now()-transactionStarted,"ok");
    // The immutable choice is already committed. Journal failure cannot erase it.
    try{
      await db.query(`UPDATE waterx_timed_outbox SET committed_ack_at_ms=coalesce(committed_ack_at_ms,$2)
        WHERE decision_id=$1`,[d.id,d.committedAtMs]);
      d.acknowledgementStatus="JOURNALED";
    }catch{recordEarlyDelivery(round.intervalMinutes,round.roundId,"EVENT_ACK_JOURNAL",null,"error");}
    return d;
  }catch(error){
    if(began)await db.query("ROLLBACK").catch(()=>{});
    recordEarlyDelivery(round.intervalMinutes,round.roundId,"EVENT_FINAL_TRANSACTION",
      performance.now()-transactionStarted,"error");
    if(commitAttempted){
      // Do not retry insertion on an ambiguous acknowledgement. Visibility of the
      // unique immutable row proves commit; a failed read remains explicitly UNKNOWN.
      try{const saved=await readEventLock(round,db);if(saved)return saved;}
      catch{throw new Error("UNKNOWN_EVENT_COMMIT",{cause:error});}
    }
    throw error;
  }
}
