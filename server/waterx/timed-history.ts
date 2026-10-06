import {z} from "zod";
import {timedPool} from "./timed-db";
import type {LockDb} from "./lock-store";
import {TIMED_STRATEGY,PREVIOUS_TIMED_STRATEGY,LEGACY_TIMED_STRATEGY,type TimedDecision} from "../../shared/timed-decision";
export const timedHistoryQuery=z.object({
  interval:z.enum(["all","5","15"]).default("all"),
  strategy:z.enum(["all",TIMED_STRATEGY,PREVIOUS_TIMED_STRATEGY,LEGACY_TIMED_STRATEGY]).default(TIMED_STRATEGY),
  window:z.enum(["lifetime","24h","7d","20","50","100"]).default("lifetime"),
  limit:z.coerce.number().int().min(1).max(200).default(50),
}).strict();
export type TimedResult="CORRECT"|"INCORRECT"|"PENDING"|"DISPUTED"|"NO_VALID_INPUT"|"MISSED_DEADLINE"|"ABSTENTION"|"DATA_FAILURE";
export function projectTimedResult(d:TimedDecision,verified:boolean,outcome:unknown,disputed:boolean):TimedResult{
  if(d.status==="NO_VALID_INPUT")return "NO_VALID_INPUT";
  if(d.status==="MISSED_DEADLINE")return "MISSED_DEADLINE";
  if(d.status==="ABSTAINED_NO_QUALIFIED_SIGNAL")return "ABSTENTION";
  if(d.status==="DATA_FAILURE")return "DATA_FAILURE";
  if(disputed)return "DISPUTED";
  if(!verified||(outcome!=="UP"&&outcome!=="DOWN"))return "PENDING";
  return d.side===outcome?"CORRECT":"INCORRECT";
}
/** All metrics are computed in PostgreSQL over the cohort, not the display page.
 * The join is reevaluated on every read: withdrawn/disputed labels cease scoring immediately.
 * No settled choice, future odds or account P/L is backfilled into a prediction. */
export async function scoredTimedHistory(query:unknown,now=Date.now(),db:LockDb=timedPool){
  const q=timedHistoryQuery.parse(query),since=q.window==="24h"?now-86400000:q.window==="7d"?now-604800000:0;
  const cohortLimit=["20","50","100"].includes(q.window)?Number(q.window):null;
  const args=[q.interval==="all"?null:Number(q.interval),q.strategy==="all"?null:q.strategy,since,now,cohortLimit];
  const cte=`WITH cohort AS (
    SELECT r.* FROM waterx_timed_rounds r
    WHERE r.network='sui:mainnet' AND ($1::int IS NULL OR r.interval_minutes=$1)
      AND ($2::text IS NULL OR r.strategy_version=$2) AND r.start_ms >= $3 AND r.start_ms <= $4
    ORDER BY r.start_ms DESC,r.interval_minutes,r.strategy_version,r.round_id LIMIT $5
  ), facts AS (
    SELECT r.start_ms,r.interval_minutes,r.strategy_version,r.round_id,d.decision,d.id,
      d.status,o.committed_ack_at_ms,o.worker_received_at_ms,upper(l.outcome) AS outcome,
      l.settlement_disputed AS disputed,
      COALESCE(l.label_status='verified' AND NOT l.settlement_disputed
        AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
        AND l.settled_at>r.expiry_ms AND l.settled_at<=$4
        AND l.first_verified_at<=to_timestamp($4::double precision/1000)
        AND l.settle_price>0 AND l.settlement_anchor_price>0
        AND l.settle_price<'Infinity'::float8 AND l.settlement_anchor_price<'Infinity'::float8
        AND ((upper(l.outcome)='UP' AND l.settle_price>=l.settlement_anchor_price)
          OR (upper(l.outcome)='DOWN' AND l.settle_price<l.settlement_anchor_price)),false) AS verified
    FROM cohort r LEFT JOIN waterx_timed_decisions d
      USING(network,strategy_version,interval_minutes,round_id)
    LEFT JOIN waterx_timed_outbox o ON o.decision_id=d.id
    LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=r.interval_minutes AND l.round_id=r.round_id
      AND l.start_ms=r.start_ms AND l.expiry_ms=r.expiry_ms
  ), scored AS (
    SELECT *, CASE WHEN id IS NULL THEN 'MISSING_RECORD'
      WHEN status='NO_VALID_INPUT' THEN 'NO_VALID_INPUT'
      WHEN status='MISSED_DEADLINE' THEN 'MISSED_DEADLINE'
       WHEN status='ABSTAINED_NO_QUALIFIED_SIGNAL' THEN 'ABSTENTION'
       WHEN status='DATA_FAILURE' THEN 'DATA_FAILURE'
      WHEN disputed THEN 'DISPUTED'
      WHEN NOT verified THEN 'PENDING'
      WHEN decision->>'side'=outcome THEN 'CORRECT' ELSE 'INCORRECT' END AS result,
      status='LOCKED' AND committed_ack_at_ms <= (decision->>'hardDeadlineAtMs')::bigint AS on_time
    FROM facts
  )`;
  const summary=await db.query(`${cte} SELECT count(*)::int AS cohort_n,count(id)::int AS n,
    count(*) FILTER(WHERE status='LOCKED')::int AS locks,
    count(*) FILTER(WHERE on_time)::int AS on_time_locks,
    count(*) FILTER(WHERE decision->>'lockReason' LIKE 'DEADLINE%')::int AS deadline_locks,
    count(*) FILTER(WHERE status IN('MISSED_DEADLINE','DATA_FAILURE') OR
      (status='LOCKED' AND committed_ack_at_ms>(decision->>'hardDeadlineAtMs')::bigint))::int AS missed,
    count(*) FILTER(WHERE status='ABSTAINED_NO_QUALIFIED_SIGNAL')::int AS abstained,
    count(*) FILTER(WHERE status='DATA_FAILURE')::int AS data_failures,
     count(*) FILTER(WHERE status='MISSED_DEADLINE' OR
       (status='LOCKED' AND committed_ack_at_ms>(decision->>'hardDeadlineAtMs')::bigint))::int AS deadline_misses,
     count(*) FILTER(WHERE result='MISSING_RECORD' OR status IN('NO_VALID_INPUT','DATA_FAILURE','MISSED_DEADLINE') OR
       (status='LOCKED' AND (committed_ack_at_ms IS NULL OR committed_ack_at_ms>(decision->>'hardDeadlineAtMs')::bigint)))::int AS operational_failures,
    count(*) FILTER(WHERE result='MISSING_RECORD')::int AS missing_records,
    count(*) FILTER(WHERE result='NO_VALID_INPUT')::int AS no_valid_input,
    count(*) FILTER(WHERE result='CORRECT')::int AS correct,
    count(*) FILTER(WHERE result='INCORRECT')::int AS incorrect,
    count(*) FILTER(WHERE result='PENDING')::int AS pending,
    count(*) FILTER(WHERE result='DISPUTED')::int AS disputed,
    percentile_cont(0.5) WITHIN GROUP(ORDER BY (decision->>'elapsedMs')::double precision)
      FILTER(WHERE status='LOCKED') AS median_elapsed_ms FROM scored`,args);
  const rows=await db.query(`${cte} SELECT * FROM scored WHERE id IS NOT NULL
    ORDER BY start_ms DESC,interval_minutes,strategy_version,round_id LIMIT $6`,[...args,q.limit]);
  const s=summary.rows[0],correct=Number(s.correct),incorrect=Number(s.incorrect),settledN=correct+incorrect,n=Number(s.cohort_n);
  const entries=rows.rows.map(row=>{
    const d={...(row.decision as TimedDecision)},ack=row.committed_ack_at_ms==null?null:Number(row.committed_ack_at_ms);
    return {...d,committedAtMs:ack,workerReceivedAtMs:row.worker_received_at_ms==null?null:Number(row.worker_received_at_ms),
      onTime:ack===null||d.status!=="LOCKED"?null:ack<=d.hardDeadlineAtMs,
      acknowledgementStatus:ack===null?"UNKNOWN":"JOURNALED",
      lifecycle:d.status!=="LOCKED"?"OBSERVING":row.disputed===true?"DISPUTED":row.verified===true?
        d.side===row.outcome?"CORRECT":"INCORRECT":now>=d.expiryMs?"RESULT_PENDING":
        d.side==="UP"?"LOCKED_UP":d.side==="DOWN"?"LOCKED_DOWN":"OBSERVING",
      operationalFailure:d.status==="LOCKED"&&ack!==null&&ack>d.hardDeadlineAtMs?
        d.strategyVersion===TIMED_STRATEGY?"COMMIT_AFTER_GATE_GRACE":"COMMIT_AFTER_HARD_DEADLINE":null,
      result:projectTimedResult(d,row.verified===true,row.outcome,row.disputed===true),
      verifiedOutcome:row.verified===true?row.outcome:null,
      executionStatus:"NOT_INFERRED",actualPnl:null};
  });
  return {strategyVersion:q.strategy,asOfMs:now,cohort:q,entries,metrics:{
    n:Number(s.n),cohortN:n,onTimeLocks:Number(s.on_time_locks),deadlineLocks:Number(s.deadline_locks),
    missed:Number(s.missed),missingRecords:Number(s.missing_records),noValidInput:Number(s.no_valid_input),
    deadlineMisses:Number(s.deadline_misses),operationalFailures:Number(s.operational_failures),
    operationalCoverage:n?1-Number(s.operational_failures)/n:null,
    settledN,correct,incorrect,pending:Number(s.pending),disputed:Number(s.disputed),
    ratio:`${correct}:${incorrect}`,hitRate:settledN?correct/settledN:null,
    choiceCoverage:n?Number(s.locks)/n:null,onTimeCoverage:n?Number(s.on_time_locks)/n:null,
    abstained:Number(s.abstained),dataFailures:Number(s.data_failures),
    abstentionRate:n?Number(s.abstained)/n:null,operationalFailureRate:n?Number(s.operational_failures)/n:null,
    medianElapsedMs:s.median_elapsed_ms===null?null:Number(s.median_elapsed_ms)},
    rowsTruncated:Number(s.n)>entries.length,
    qualification:"Verified exact-round settlements only. All-policy totals count policy-round decisions, not independent training outcomes. Coverage denominator is discovered strategy-rounds; unobserved rounds are not claimed. Trading and actual P/L remain separate."};
}
