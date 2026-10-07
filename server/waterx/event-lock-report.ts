import {EVENT_LOCK_STRATEGY} from "../../shared/event-lock";
import {TIMED_STRATEGY,type TimedDecision} from "../../shared/timed-decision";
import {eventLockRuntime} from "./event-lock-runtime";
import {researchPool} from "./research-store";
import {forecastMetrics} from "./event-report-metrics";
import type {LockDb} from "./lock-store";
import {earlyDeliveryMetrics} from "./early-delivery-metrics";
import {compareEntryEconomics} from "./event-value-evidence";
export async function eventLockReport(interval:5|15,now=Date.now(),db:LockDb=researchPool){
  const rows=await db.query(`WITH launch AS (
    SELECT min(r.start_ms) AS at FROM waterx_timed_rounds r WHERE r.strategy_version=$1 AND r.interval_minutes=$3
      AND EXISTS(SELECT 1 FROM waterx_timed_observations o WHERE o.network=r.network AND o.strategy_version=$1
        AND o.interval_minutes=r.interval_minutes AND o.round_id=r.round_id AND o.input#>>'{features,eventCaptureMode}'='PROSPECTIVE')
  ), cohort AS (
    SELECT DISTINCT network,interval_minutes,round_id,start_ms,expiry_ms FROM waterx_timed_rounds,launch
    WHERE strategy_version IN($1,$2) AND interval_minutes=$3 AND start_ms>=greatest(launch.at,$4)
      AND launch.at IS NOT NULL AND expiry_ms<=$5
  ) SELECT r.*,
    (e.decision-'evidence')||jsonb_build_object('evidence',(e.decision->'evidence')-'observations') AS event,
    (b.decision-'evidence')||jsonb_build_object('evidence',(b.decision->'evidence')-'observationHistory') AS benchmark,
    eo.committed_ack_at_ms AS event_ack,
    bo.committed_ack_at_ms AS benchmark_ack,l.outcome,
    coalesce(l.label_status='verified' AND NOT l.settlement_disputed
      AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
      AND l.settled_at>r.expiry_ms AND l.settled_at<=$5
      AND l.first_verified_at<=to_timestamp($5::double precision/1000)
      AND l.settle_price>0 AND l.settlement_anchor_price>0
      AND l.settle_price<'Infinity'::float8 AND l.settlement_anchor_price<'Infinity'::float8
      AND ((upper(l.outcome)='UP' AND l.settle_price>=l.settlement_anchor_price)
        OR(upper(l.outcome)='DOWN' AND l.settle_price<l.settlement_anchor_price)),false) AS verified,
    (SELECT count(*)::int FROM waterx_timed_observations o WHERE o.network=r.network AND o.strategy_version=$1
      AND o.interval_minutes=r.interval_minutes AND o.round_id=r.round_id) AS observations,
    EXISTS(SELECT 1 FROM waterx_timed_observations o WHERE o.network=r.network AND o.strategy_version=$1
      AND o.interval_minutes=r.interval_minutes AND o.round_id=r.round_id
      AND o.input#>>'{features,eventCaptureMode}'='SYNTHETIC') AS synthetic
    FROM cohort r
    LEFT JOIN waterx_timed_decisions e ON e.network=r.network AND e.strategy_version=$1 AND e.interval_minutes=r.interval_minutes AND e.round_id=r.round_id
      AND (e.decision->>'startMs')::bigint=r.start_ms AND (e.decision->>'expiryMs')::bigint=r.expiry_ms
    LEFT JOIN waterx_timed_decisions b ON b.network=r.network AND b.strategy_version=$2 AND b.interval_minutes=r.interval_minutes AND b.round_id=r.round_id
      AND (b.decision->>'startMs')::bigint=r.start_ms AND (b.decision->>'expiryMs')::bigint=r.expiry_ms
    LEFT JOIN waterx_timed_outbox eo ON eo.decision_id=e.id LEFT JOIN waterx_timed_outbox bo ON bo.decision_id=b.id
    LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=r.interval_minutes AND l.round_id=r.round_id
      AND l.start_ms=r.start_ms AND l.expiry_ms=r.expiry_ms
    ORDER BY r.start_ms DESC LIMIT 2000`,[EVENT_LOCK_STRATEGY,TIMED_STRATEGY,interval,now-14*86400000,now]);
  type Fact=Record<string,unknown>&{event:TimedDecision|null;benchmark:TimedDecision|null};
  const facts=rows.rows.map(r=>({...r,event:r.event as TimedDecision|null,benchmark:r.benchmark as TimedDecision|null} as Fact))
    .filter(r=>r.synthetic!==true&&r.event?.evidence?.captureMode!=="SYNTHETIC");
  const usable=facts.filter(r=>r.verified&&r.event?.status==="LOCKED"&&r.benchmark?.status==="LOCKED");
  const gains=usable.flatMap(r=>{
    const ec=r.event!.evidence.clockDomain,bc=(r.benchmark!.evidence.features as Record<string,unknown>)?.decisionClockDomain;
    return ec&&ec===bc?[(r.benchmark!.decisionAtMs-r.event!.decisionAtMs)/1000]:[];
  }).sort((a,b)=>a-b);
  const summary=(key:"event"|"benchmark")=>{
    const locked=facts.filter(r=>r[key]?.status==="LOCKED"),scored=locked.filter(r=>r.verified);
    return {discovered:facts.length,locks:locked.length,coverage:facts.length?locked.length/facts.length:null,
      missingRecord:facts.filter(r=>!r[key]).length,
      dataFailures:facts.filter(r=>r[key]?.status==="DATA_FAILURE").length,
      metrics:forecastMetrics(scored.map(r=>({probability:r[key]!.probabilityUp!,outcome:String(r.outcome).toUpperCase()})))};
  };
  const training=await db.query(`SELECT status,report,finished_at_ms,error_class FROM waterx_early_training_jobs
    WHERE strategy_version=$1 AND interval_minutes=$2 ORDER BY day DESC,attempt DESC LIMIT 1`,
    [EVENT_LOCK_STRATEGY,interval]);
  return {strategyVersion:EVENT_LOCK_STRATEGY,benchmarkVersion:TIMED_STRATEGY,interval,asOfMs:now,
    shadowOnly:true,activePolicy:"RETAIN_30_SECOND_BENCHMARK",promotion:"NOT_AUTHORIZED",
    rollout:{authoritative:false,blockers:["Adequate prospective matched comparison on both intervals",
      "Independent production collector and single-writer recovery proof","Production acquisition/persistence reliability",
      "Verified current backup restored in isolation before production collector changes",
      "Owner approval of recurring hosting/database costs before activation"],
      valuePolicy:"DIAGNOSTIC_ONLY_NOT_PROMOTED",qualificationChanged:false},
    entryEconomics:compareEntryEconomics(facts.map(r=>({event:r.event,benchmark:r.benchmark,verified:r.verified}))),
    clockSemantics:"Seconds gained only when both decisions carry the same application-process clock domain. Provider tick time and unmeasured UI latency remain unknown.",
    prospective:{cohortN:facts.length,matchedN:usable.length,event:summary("event"),benchmark:summary("benchmark"),
      matchedEvent:forecastMetrics(usable.map(r=>({probability:r.event!.probabilityUp!,outcome:String(r.outcome).toUpperCase()}))),
      matchedBenchmark:forecastMetrics(usable.map(r=>({probability:r.benchmark!.probabilityUp!,outcome:String(r.outcome).toUpperCase()}))),
      secondsGained:{n:gains.length,p50:gains.length?gains[Math.ceil(gains.length*.5)-1]:null,
        p95:gains.length?gains[Math.ceil(gains.length*.95)-1]:null,max:gains.at(-1)??null},
      sampleLimit:2000,denominator:"All captured completed discovered rounds since challenger capture began, including missing records and operational failures; FIRST immutable lock per policy."},
    runtime:eventLockRuntime.health(),latency:earlyDeliveryMetrics(),
    training:training.rows[0]??{status:"NOT_RUN",eligibleRounds:0,nextEligibilityCondition:"Collect proven prospective complete trajectories and verified labels in four disjoint stages; no synthetic or 30-second-only backfill."},
    qualification:"Unchanged market strength/persistence/stability guards. No promoted outcome/stopping model.",
    stabilityExperiment:{version:"support-fraction-shadow-v1",active:false,parameterSelection:"Validation only; final TEST untouched",status:"NOT_SELECTED"},
    rounds:facts.slice(0,50).map(r=>({roundId:r.round_id,startMs:Number(r.start_ms),expiryMs:Number(r.expiry_ms),
      observations:Number(r.observations),event:r.event??null,benchmark:r.benchmark??null,
      verified:r.verified,outcome:r.verified?r.outcome:null,eventAck:r.event_ack,benchmarkAck:r.benchmark_ack}))};
}
