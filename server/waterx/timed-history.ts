import {z} from "zod";
import {researchPool} from "./research-store";
import type {LockDb} from "./lock-store";
import {TIMED_STRATEGY,PREVIOUS_TIMED_STRATEGY,LEGACY_TIMED_STRATEGY,type TimedDecision} from "../../shared/timed-decision";
import {EVENT_LOCK_STRATEGY} from "../../shared/event-lock";
import {economicEvidenceFromFeatures,frozenEntryFeatures} from "../../shared/lock-economics";
import {decisionDeploymentId} from "./decision-authority";
export const timedHistoryQuery=z.object({
  interval:z.enum(["all","5","15"]).default("all"),
  strategy:z.enum(["all",TIMED_STRATEGY,PREVIOUS_TIMED_STRATEGY,LEGACY_TIMED_STRATEGY,EVENT_LOCK_STRATEGY]).default(TIMED_STRATEGY),
  window:z.enum(["lifetime","today","24h","7d","custom","20","50","100"]).default("lifetime"),
  fromMs:z.coerce.number().int().nonnegative().optional(),
  toMs:z.coerce.number().int().nonnegative().optional(),
  timezoneOffsetMinutes:z.coerce.number().int().min(-840).max(840).default(0),
  deployment:z.enum(["all","current","unknown"]).default("all"),
  limit:z.coerce.number().int().min(1).max(200).default(50),
}).strict().superRefine((q,ctx)=>{
  if(q.window==="custom"&&(q.fromMs==null||q.toMs==null||q.toMs<=q.fromMs||q.toMs-q.fromMs>366*86400000))
    ctx.addIssue({code:"custom",message:"Choose a valid custom interval of at most 366 days."});
});
export function historyTimeRange(q:z.infer<typeof timedHistoryQuery>,now:number){
  const offset=q.timezoneOffsetMinutes*60000;
  const since=q.window==="today"?Math.floor((now-offset)/86400000)*86400000+offset:
    q.window==="24h"?now-86400000:q.window==="7d"?now-604800000:q.window==="custom"?q.fromMs!:0;
  return {since,until:q.window==="custom"?Math.min(q.toMs!,now+1):now+1};
}
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
export async function scoredTimedHistory(query:unknown,now=Date.now(),db:LockDb=researchPool){
  const q=timedHistoryQuery.parse(query),{since,until}=historyTimeRange(q,now);
  const cohortLimit=["20","50","100"].includes(q.window)?Number(q.window):null;
  const args=[q.interval==="all"?null:Number(q.interval),q.strategy==="all"?null:q.strategy,since,now,cohortLimit,
    until,q.deployment,decisionDeploymentId];
  const cte=`WITH cohort AS (
    SELECT r.*,p.deployment_id FROM waterx_timed_rounds r
    LEFT JOIN LATERAL(SELECT coalesce(
      (SELECT coalesce(nullif(d.decision#>>'{evidence,deploymentId}','unknown'),
        nullif(d.decision#>>'{evidence,features,deploymentId}','unknown')) FROM waterx_timed_decisions d
        WHERE d.network=r.network AND d.strategy_version=r.strategy_version
          AND d.interval_minutes=r.interval_minutes AND d.round_id=r.round_id),
      (SELECT nullif(o.input#>>'{features,deploymentId}','unknown') FROM waterx_timed_observations o
        WHERE o.network=r.network AND o.strategy_version=r.strategy_version
          AND o.interval_minutes=r.interval_minutes AND o.round_id=r.round_id
        ORDER BY o.received_at_ms LIMIT 1)) AS deployment_id) p ON true
    WHERE r.network='sui:mainnet' AND ($1::int IS NULL OR r.interval_minutes=$1)
      AND ($2::text IS NULL OR r.strategy_version=$2) AND r.start_ms >= $3 AND r.start_ms < $6
      AND ($7='all' OR ($7='current' AND p.deployment_id=$8 AND $8<>'unknown')
        OR ($7='unknown' AND p.deployment_id IS NULL))
    ORDER BY r.start_ms DESC,r.interval_minutes,r.strategy_version,r.round_id LIMIT $5
  ), facts AS (
    SELECT r.start_ms,r.expiry_ms,r.interval_minutes,r.strategy_version,r.round_id,r.deployment_id,d.decision,d.id,
      d.status,o.committed_ack_at_ms,o.worker_received_at_ms,upper(l.outcome) AS outcome,
      l.settlement_disputed AS disputed,
      coalesce(g.source_unavailable,0) AS source_unavailable_gates,
      coalesce(g.no_qualified_signal,0) AS no_qualified_signal_gates,
      coalesce(g.scheduler_missed,0) AS scheduler_missed_gates,
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
    LEFT JOIN LATERAL (SELECT
      count(*) FILTER(WHERE j.result IN('WAIT_FRESH_DATA','INVALID_ROUND'))::int AS source_unavailable,
      count(*) FILTER(WHERE j.result IN('WAIT_WEAK_EVIDENCE','WAIT_UNSTABLE'))::int AS no_qualified_signal,
      count(*) FILTER(WHERE j.result='MISSED_GATE')::int AS scheduler_missed
      FROM waterx_gate_journals j WHERE j.network=r.network AND j.strategy_version=r.strategy_version
        AND j.interval_minutes=r.interval_minutes AND j.round_id=r.round_id) g ON true
    LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=r.interval_minutes AND l.round_id=r.round_id
      AND l.start_ms=r.start_ms AND l.expiry_ms=r.expiry_ms
  ), scored AS (
    SELECT *, CASE WHEN id IS NULL AND expiry_ms>$4 THEN 'PENDING'
      WHEN id IS NULL THEN 'MISSING_RECORD'
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
    count(*) FILTER(WHERE source_unavailable_gates>0)::int AS source_unavailable_rounds,
    count(*) FILTER(WHERE scheduler_missed_gates>0)::int AS scheduler_missed_rounds,
    count(*) FILTER(WHERE decision->'evidence'->>'persistenceFailureCount' IS NOT NULL
      AND (decision->'evidence'->>'persistenceFailureCount')::int>0)::int AS persistence_failure_rounds,
    coalesce(sum(source_unavailable_gates),0)::int AS source_unavailable_gates,
    coalesce(sum(no_qualified_signal_gates),0)::int AS no_qualified_signal_gates,
    coalesce(sum(scheduler_missed_gates),0)::int AS scheduler_missed_gates,
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
     count(*) FILTER(WHERE result='MISSED_DEADLINE')::int AS missed_records,
     percentile_cont(0.5) WITHIN GROUP(ORDER BY (decision->>'elapsedMs')::double precision)
       FILTER(WHERE status='LOCKED') AS median_elapsed_ms,
     percentile_cont(0.9) WITHIN GROUP(ORDER BY (decision->>'elapsedMs')::double precision)
       FILTER(WHERE status='LOCKED') AS p90_elapsed_ms FROM scored`,args);
  const rows=await db.query(`${cte} SELECT * FROM scored WHERE id IS NOT NULL
     ORDER BY start_ms DESC,interval_minutes,strategy_version,round_id LIMIT $9`,[...args,q.limit]);
  const s=summary.rows[0],correct=Number(s.correct),incorrect=Number(s.incorrect),settledN=correct+incorrect,n=Number(s.cohort_n);
  const entries=rows.rows.map(row=>{
    const d={...(row.decision as TimedDecision)},ack=row.committed_ack_at_ms==null?null:Number(row.committed_ack_at_ms);
    const features=frozenEntryFeatures(d.evidence,d.observationId,d.decisionAtMs);
    return {...d,committedAtMs:ack,workerReceivedAtMs:row.worker_received_at_ms==null?null:Number(row.worker_received_at_ms),
      deploymentId:row.deployment_id??null,
      entryEconomics:d.status==="LOCKED"&&d.side?economicEvidenceFromFeatures(features,d.roundId,d.side,d.decisionAtMs):null,
      onTime:ack===null||d.status!=="LOCKED"?null:ack<=d.hardDeadlineAtMs,
      acknowledgementStatus:ack===null?"UNKNOWN":"JOURNALED",
      lifecycle:d.status!=="LOCKED"?"OBSERVING":row.disputed===true?"DISPUTED":row.verified===true?
        d.side===row.outcome?"CORRECT":"INCORRECT":now>=d.expiryMs?"RESULT_PENDING":
        d.side==="UP"?"LOCKED_UP":d.side==="DOWN"?"LOCKED_DOWN":"OBSERVING",
      operationalFailure:d.status==="LOCKED"&&ack!==null&&ack>d.hardDeadlineAtMs?
        d.strategyVersion===TIMED_STRATEGY?"COMMIT_AFTER_GATE_GRACE":"COMMIT_AFTER_HARD_DEADLINE":null,
      result:projectTimedResult(d,row.verified===true,row.outcome,row.disputed===true),
      verifiedOutcome:row.verified===true?row.outcome:null,
      operationalReasons:[
        ...(Number(row.source_unavailable_gates)>0?["SOURCE_UNAVAILABLE"]:[]),
        ...(Number(row.scheduler_missed_gates)>0?["SCHEDULER_MISSED_GATE"]:[]),
        ...(d.status==="ABSTAINED_NO_QUALIFIED_SIGNAL"?["NO_QUALIFIED_SIGNAL"]:[]),
        ...(Number((d.evidence as Record<string,unknown>)?.persistenceFailureCount)>0?["PERSISTENCE_FAILURE"]:[]),
        ...(d.status==="LOCKED"&&ack===null?["COMMIT_ACKNOWLEDGEMENT_UNKNOWN"]:[]),
        ...(d.status==="LOCKED"&&ack!==null&&ack>d.hardDeadlineAtMs?["COMMIT_AFTER_GATE_GRACE"]:[]),
      ],
      executionStatus:"NOT_INFERRED",actualPnl:null};
  });
  const topLevelOutcomes={CORRECT:correct,INCORRECT:incorrect,PENDING:Number(s.pending),DISPUTED:Number(s.disputed),
    ABSTENTION:Number(s.abstained),DATA_FAILURE:Number(s.data_failures),NO_VALID_INPUT:Number(s.no_valid_input),
    MISSED_DEADLINE:Number(s.missed_records),MISSING_RECORD:Number(s.missing_records)};
  return {strategyVersion:q.strategy,asOfMs:now,cohort:q,entries,
    provenance:{denominator:"DISCOVERED_STRATEGY_ROUNDS",expectedSlotsVerified:false,
      deploymentOptions:[{value:"all",label:"All recorded deployments"},{value:"current",label:decisionDeploymentId==="development-unpackaged"?
        "Unpackaged development observations":"Current packaged build"},{value:"unknown",label:"Unrecorded deployment provenance"}]},
    metrics:{
    locks:Number(s.locks),dataFailureRate:n?Number(s.data_failures)/n:null,
    missingRecordRate:null,discoveredMissingRecordRate:n?Number(s.missing_records)/n:null,expectedCohortN:null,
    expectedCohortStatus:"NOT_INDEPENDENTLY_VERIFIED",topLevelOutcomes,
    n:Number(s.n),cohortN:n,onTimeLocks:Number(s.on_time_locks),deadlineLocks:Number(s.deadline_locks),
    missed:Number(s.missed),missingRecords:Number(s.missing_records),noValidInput:Number(s.no_valid_input),
    deadlineMisses:Number(s.deadline_misses),operationalFailures:Number(s.operational_failures),
    operationalCoverage:n?1-Number(s.operational_failures)/n:null,
    settledN,correct,incorrect,pending:Number(s.pending),disputed:Number(s.disputed),
    ratio:`${correct}:${incorrect}`,hitRate:settledN?correct/settledN:null,
    choiceCoverage:n?Number(s.locks)/n:null,onTimeCoverage:n?Number(s.on_time_locks)/n:null,
    abstained:Number(s.abstained),dataFailures:Number(s.data_failures),
    operationalBreakdown:{sourceUnavailable:Number(s.source_unavailable_rounds??0),
      noQualifiedSignal:Number(s.abstained??0),schedulerMissedGate:Number(s.scheduler_missed_rounds??0),
      persistenceFailure:Number(s.persistence_failure_rounds??0),
      unclassifiedMissingRecords:Number(s.missing_records??0),
      gates:{sourceUnavailable:Number(s.source_unavailable_gates??0),
        noQualifiedSignal:Number(s.no_qualified_signal_gates??0),schedulerMissedGate:Number(s.scheduler_missed_gates??0)},
      semantics:"Overlapping round categories and distinct gate counts; zero confirmed persistence failures is not proof of no failures. Missing records have an unknown cause."},
    abstentionRate:n?Number(s.abstained)/n:null,operationalFailureRate:n?Number(s.operational_failures)/n:null,
    medianElapsedMs:s.median_elapsed_ms===null?null:Number(s.median_elapsed_ms),
    p90ElapsedMs:s.p90_elapsed_ms==null?null:Number(s.p90_elapsed_ms)},
    rowsTruncated:Number(s.n)>entries.length,
    qualification:"Verified exact-round settlements only. All-policy totals count policy-round decisions, not independent training outcomes. Coverage denominator is discovered strategy-rounds; unobserved rounds are not claimed. Trading and actual P/L remain separate."};
}
