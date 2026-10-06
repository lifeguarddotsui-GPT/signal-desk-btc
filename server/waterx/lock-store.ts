import pg from "pg";
import { lockPolicy, type LockObservation, type LockLatency } from "../../shared/lock-readiness";
import type { ResearchInterval } from "../../shared/waterx-research";
import { evaluateLockReadiness, validateLockPolicy, lockLatency } from "./lock-readiness";
import type {EarlyDecision} from "../../shared/manual-opportunity";
import {observationId} from "./observation-provenance";
import {validWaterxProbabilityPair} from "../../shared/round-decision";

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2,
  connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000});
export type LockRound={intervalMinutes:ResearchInterval;roundId:string;startMs:number;expiryMs:number};
export type LockDb={query:(sql:string,values?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>};
export async function loadEarlyDecision(round:LockRound,db:LockDb=pool):Promise<EarlyDecision|null>{
  const result=await db.query(`SELECT c.*,o.id AS event_id,o.worker_received_at_ms,b.received_at_ms
    FROM bluewater_lock_candidates c JOIN bluewater_early_outbox o
      ON o.interval_minutes=c.interval_minutes AND o.round_id=c.round_id AND o.checkpoint_seconds=c.checkpoint_seconds
    JOIN bluewater_lock_observations b ON b.interval_minutes=c.interval_minutes
      AND b.round_id=c.round_id AND b.observed_at_ms=c.observed_at_ms
    WHERE c.interval_minutes=$1 AND c.round_id=$2 AND c.start_ms=$3 AND c.expiry_ms=$4 AND c.checkpoint_seconds=0`,
    [round.intervalMinutes,round.roundId,round.startMs,round.expiryMs]);
  const row=result.rows[0];
  if(!row)return null;
  return {side:row.side as "UP"|"DOWN",probabilityUp:Number(row.probability_up),
    decisionAtMs:Number(row.decision_at_ms),committedAtMs:null,policyVersion:String(row.policy_version),
    observationId:observationId(round.intervalMinutes,round.roundId,Number(row.received_at_ms)),
    eventId:String(row.event_id),workerReceivedAtMs:row.worker_received_at_ms==null?null:Number(row.worker_received_at_ms)};
}
/** Receipt only: this consumer has no signer and does not create execution intents. */
export async function acknowledgeEarlyDecisionEvents(db:LockDb=pool){
  return db.query(`UPDATE bluewater_early_outbox SET worker_received_at_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
    WHERE id IN (SELECT id FROM bluewater_early_outbox WHERE worker_received_at_ms IS NULL ORDER BY id LIMIT 20)
    AND worker_received_at_ms IS NULL RETURNING id`);
}
export function lockObservation(row:Record<string,unknown>):LockObservation {
  return {atMs:Number(row.observed_at_ms),receivedAtMs:Number(row.received_at_ms),
    providerSourceAtMs:row.provider_source_at_ms==null?null:Number(row.provider_source_at_ms),
    probabilityUp:Number(row.probability_up),probabilityDown:Number(row.probability_down),
    sourceHealthy:row.source_healthy===true};
}
export async function appendLockTiming(db:LockDb,round:Pick<LockRound,"intervalMinutes"|"roundId">,timing:LockLatency) {
  await db.query(`INSERT INTO bluewater_lock_latency(interval_minutes,round_id,kind,timing)
    SELECT $1,$2,$3,$4::jsonb WHERE EXISTS(SELECT 1 FROM bluewater_lock_policies WHERE interval_minutes=$1 AND round_id=$2)`,
  [round.intervalMinutes,round.roundId,timing.kind,JSON.stringify(timing)]);
}
/** Independent optional research queue. No canonical writes, model fits, or execution. */
export async function captureLockObservation(round:LockRound,o:LockObservation,db=pool) {
  if(!Number.isSafeInteger(round.startMs)||!Number.isSafeInteger(round.expiryMs)||
    round.expiryMs-round.startMs!==round.intervalMinutes*60000)throw new Error("Invalid adaptive exact round.");
  if(!validWaterxProbabilityPair(o.probabilityUp,o.probabilityDown))throw new Error("INVALID_PROBABILITY_PAIR");
  const client=await db.connect();
  let committed=false;
  let evaluationAt=0,transactionAt=0;
  let candidate=false;
  let earlyInserted=false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(76349,$1)",[round.intervalMinutes]);
    const values=[round.intervalMinutes,round.roundId,round.startMs,round.expiryMs];
    if(Date.now()>=round.expiryMs)return;
    await client.query(`INSERT INTO bluewater_lock_policies(interval_minutes,round_id,start_ms,expiry_ms,policy)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(interval_minutes,round_id) DO NOTHING`,
    [...values,JSON.stringify(lockPolicy(round.intervalMinutes))]);
    const policyRows=await client.query(`SELECT policy FROM bluewater_lock_policies
      WHERE interval_minutes=$1 AND round_id=$2 AND start_ms=$3 AND expiry_ms=$4`,values);
    if(!policyRows.rows.length)throw new Error("Adaptive exact-round identity changed.");
    const p=validateLockPolicy(policyRows.rows[0].policy);
    const history=await client.query(`SELECT * FROM bluewater_lock_observations
      WHERE interval_minutes=$1 AND round_id=$2 ORDER BY observed_at_ms LIMIT 2001`,values.slice(0,2));
    if(history.rows.length>2000)throw new Error("Adaptive round history exceeded explicit bound.");
    if(history.rows.some(r=>Number(r.observed_at_ms)>=o.atMs||Number(r.received_at_ms)>=o.receivedAtMs))
      return await loadEarlyDecision(round,client);
    const rows=[...history.rows.map(lockObservation),o];
    // Use receipt time consistently with the live tracker; body processing is not a provider event.
    const evidence=rows.map(row=>({...row,atMs:row.receivedAtMs}));
    const computeStart=performance.now();
    const readiness=evaluateLockReadiness(p,round.startMs,round.expiryMs,evidence,Date.now());
    let evaluationComputeMs=performance.now()-computeStart;
    if(readiness.probability===null||rows.at(-1)!.atMs!==o.atMs)throw new Error("Invalid adaptive observation.");
    await client.query(`INSERT INTO bluewater_lock_observations
      (interval_minutes,round_id,start_ms,expiry_ms,observed_at_ms,received_at_ms,provider_source_at_ms,
        probability_up,probability_down,source_healthy,readiness)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [...values,o.atMs,o.receivedAtMs,o.providerSourceAtMs,o.probabilityUp,o.probabilityDown,o.sourceHealthy,JSON.stringify(readiness)]);
    // Re-evaluate with the real post-query clock. Never backdate a queued eligibility event.
    const decision=Date.now(),currentStart=performance.now(),
      current=evaluateLockReadiness(p,round.startMs,round.expiryMs,evidence,decision);
    evaluationComputeMs+=performance.now()-currentStart;
    // Like canonical capture, this is the final-write boundary inside the
    // already-open transaction, not its outer BEGIN or pool acquisition.
    evaluationAt=decision;transactionAt=Date.now();
    if(current.state==="READY") {
      for(const checkpoint of [0,...p.windows.filter(s=>s>p.fallbackSeconds&&
        decision>=round.expiryMs-s*1000&&decision<=round.expiryMs-s*1000+p.captureGraceMs)]) {
        const inserted=await client.query(`INSERT INTO bluewater_lock_candidates
          (interval_minutes,round_id,start_ms,expiry_ms,checkpoint_seconds,decision_at_ms,observed_at_ms,
            probability_up,side,policy_version,readiness)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING round_id`,
        [...values,checkpoint,decision,o.atMs,o.probabilityUp,current.side,p.version,JSON.stringify(current)]);
        candidate ||= inserted.rows.length>0;
        if(checkpoint===0&&inserted.rows.length>0)earlyInserted=true;
      }
    }
    // Same transaction as the immutable checkpoint-zero early decision.
    // Existing trustworthy active records may regain a missing event projection; their decision time is not rewritten.
    await client.query(`INSERT INTO bluewater_early_outbox(interval_minutes,round_id)
      SELECT interval_minutes,round_id FROM bluewater_lock_candidates
      WHERE interval_minutes=$1 AND round_id=$2 AND checkpoint_seconds=0
        AND start_ms=$3 AND expiry_ms=$4 AND expiry_ms>floor(extract(epoch FROM clock_timestamp())*1000)
      ON CONFLICT(network,interval_minutes,round_id) DO NOTHING`,
      [round.intervalMinutes,round.roundId,round.startMs,round.expiryMs]);
    if(earlyInserted)await client.query("SELECT pg_notify('bluewater_early_decision',$1)",[round.roundId]);
    for(const seconds of p.windows.filter(s=>s>p.fallbackSeconds)) {
      const target=round.expiryMs-seconds*1000;
      if(decision<=target+p.captureGraceMs)continue;
      const windowRows=await client.query(`SELECT readiness FROM bluewater_lock_observations
        WHERE interval_minutes=$1 AND round_id=$2 AND observed_at_ms BETWEEN $3 AND $4
        ORDER BY observed_at_ms`,[round.intervalMinutes,round.roundId,target,target+p.captureGraceMs]);
      const code=windowRows.rows.length===0?"DATA_COLLECTOR_DELAY":
        windowRows.rows.some(r=>(r.readiness as typeof readiness).evaluatedAtMs>target+p.captureGraceMs)?
          "DATA_COLLECTOR_DELAY":
        windowRows.rows.some(r=>(r.readiness as typeof readiness).state==="READY")?"DATA_COMMIT_DELAY":
        windowRows.rows.some(r=>(r.readiness as typeof readiness).health==="DATA/COLLECTOR DELAY")?
          "DATA_COLLECTOR_DELAY":"WAITING_FOR_EVIDENCE";
      await client.query(`INSERT INTO bluewater_lock_diagnostics
        (interval_minutes,round_id,lock_seconds,code,reason,at_ms,details)
        SELECT $1,$2,$3,$4,$5,$6,$7 WHERE NOT EXISTS(SELECT 1 FROM bluewater_lock_candidates
          WHERE interval_minutes=$1 AND round_id=$2 AND checkpoint_seconds=$3)
        ON CONFLICT DO NOTHING`,
      [round.intervalMinutes,round.roundId,seconds,code,
        code==="WAITING_FOR_EVIDENCE"?"Fresh observations did not satisfy pinned readiness at this checkpoint.":
          "Preferred checkpoint was not captured on time; data/collector/commit delay is not intelligent hesitation.",
        decision,JSON.stringify({targetAtMs:target,graceMs:p.captureGraceMs,readiness:current})]);
    }
    const saved=await loadEarlyDecision(round,client);
    await client.query("COMMIT");committed=true;
    const committedAt=Date.now();
    // Optional timing cannot roll back or conceal an already committed early decision.
    await appendLockTiming(client,round,{...lockLatency(candidate?"EARLY_CANDIDATE":"OBSERVATION",o,
      evaluationAt,transactionAt,committedAt),evaluationComputeMs}).catch(()=>{});
    return saved?{...saved,committedAtMs:earlyInserted?committedAt:null}:null;
  } finally {
    if(!committed)await client.query("ROLLBACK").catch(()=>{});
    client.release();
  }
}
export { pool as lockPool };