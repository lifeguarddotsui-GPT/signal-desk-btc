import {TIMED_STRATEGY,type TimedDecision} from "../../shared/timed-decision";
import {timedPool} from "./timed-db";
import type {LockDb} from "./lock-store";
/** Outbox identity was committed atomically with the immutable prediction.
 * Repeated deliveries carry the same ID; consumers must deduplicate that ID.
 * This is research evidence, never permission to sign or spend. */
export async function committedFinalEvents(intervals:readonly (5|15)[],afterMs:number,db:LockDb=timedPool){
  const result=await db.query(`SELECT d.decision,o.committed_ack_at_ms FROM waterx_timed_outbox o
    JOIN waterx_timed_decisions d ON d.id=o.decision_id
    WHERE d.network='sui:mainnet' AND d.strategy_version=$1 AND d.status='LOCKED'
      AND d.interval_minutes=ANY($2::int[]) AND o.committed_ack_at_ms>$3
    ORDER BY o.committed_ack_at_ms,d.id LIMIT 100`,[TIMED_STRATEGY,intervals,afterMs]);
  return result.rows.map(r=>{
    const d=r.decision as TimedDecision,ack=Number(r.committed_ack_at_ms);
    return {eventVersion:"committed-qualification-final-v1",eventId:d.id,strategy:d.strategyVersion,
      network:d.network,roundId:d.roundId,intervalMinutes:d.intervalMinutes,startMs:d.startMs,
      expiryMs:d.expiryMs,side:d.side,gateIndex:d.gateIndex??null,gateScheduledAtMs:d.gateScheduledAtMs??null,
      evaluatedAtMs:d.decisionAtMs,committedAtMs:ack,researchOnly:true,
      decision:{...d,committedAtMs:ack,onTime:ack<=d.hardDeadlineAtMs,acknowledgementStatus:"JOURNALED" as const}};
  });
}
