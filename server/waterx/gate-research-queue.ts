import {createWaterxBackgroundQueue} from "./background-queue";
import {persistFrozenHorizon,freezeEarlyHorizon} from "./early-horizons";
import {researchPool} from "./research-store";
import type {TimedInput} from "./timed-decision-store";
import type {LockDb} from "./lock-store";

type Job={intervalMinutes:5|15;input:TimedInput;db?:LockDb;
  horizons:{seconds:number;frozen:ReturnType<typeof freezeEarlyHorizon>}[]};
let dropped=0;
/** Research writes cannot roll back or delay a committed gate. The frozen
 * evidence has the original gate clock, never a later recovery clock. */
const queue=createWaterxBackgroundQueue<Job>(async job=>{
  for(const h of job.horizons)
    await persistFrozenHorizon(job.input,h.seconds,h.frozen,job.db??researchPool);
},()=>{console.error("[waterx-timed] optional gate research persistence failed; gate journal preserved");});
export function enqueueGateResearch(input:TimedInput,horizons:Job["horizons"],db?:LockDb){
  if(!horizons.length)return;
  // Never silently coalesce distinct immutable gates as though they were
  // replaceable quotes. The durable gate journal is the recovery source.
  if(queue.active.has(input.intervalMinutes)||queue.pending.has(input.intervalMinutes)){
    dropped+=horizons.length;return;
  }
  queue.enqueue({intervalMinutes:input.intervalMinutes,input,horizons,db});
}
export const gateResearchHealth=()=>({...queue.metrics(),deferredToDurableJournal:dropped,
  recoverySource:"Immutable gate journal evidence; deferred research is not a failed decision",
  criticalTransaction:false});
/** Recover only the originally frozen journal, never refetch historical odds
 * or compute a replacement on-time result using later evidence. */
export const drainGateResearch=()=>Promise.all(Array.from(queue.active.values()));
export async function recoverGateResearch(db:LockDb=researchPool){
  const rows=await db.query(`SELECT g.interval_minutes,g.round_id,
      r.start_ms,r.expiry_ms,g.gate_index,g.journal
    FROM waterx_gate_journals g JOIN waterx_timed_rounds r
      USING(network,strategy_version,interval_minutes,round_id)
    LEFT JOIN waterx_early_horizons h ON h.network=g.network
      AND h.strategy_version=g.strategy_version AND h.interval_minutes=g.interval_minutes
      AND h.round_id=g.round_id AND h.horizon_seconds=g.gate_index*30
    WHERE h.round_id IS NULL AND g.journal->'evidenceSnapshot'->'researchFreeze' IS NOT NULL
    ORDER BY g.scheduled_at_ms DESC LIMIT 2`);
  for(const row of rows.rows){
    const journal=row.journal as {evidenceSnapshot:{researchFreeze:ReturnType<typeof freezeEarlyHorizon>}};
    const frozen=journal.evidenceSnapshot.researchFreeze;
    if(!frozen?.snapshot||!frozen.digest)continue;
    const input:TimedInput={intervalMinutes:Number(row.interval_minutes) as 5|15,
      roundId:String(row.round_id),startMs:Number(row.start_ms),expiryMs:Number(row.expiry_ms),
      observedAt:new Date(Number(row.start_ms)).toISOString(),probabilityUp:null,probabilityDown:null};
    enqueueGateResearch(input,[{seconds:Number(row.gate_index)*30,frozen}],db);
  }
}
