import {
  WATERX_RESEARCH_POLICY as POLICY,
  type ResearchInterval, type ResearchReport, type ResearchWindow,
} from "../../shared/waterx-research";
import { checkpointAt } from "./research-decision";
import {
  choiceFromRow, researchChoicesSelect, researchPool, researchSchemaMissing,
} from "./research-store";
import { getResearchDailyJob } from "./research-training";
import { getResearchForwardEvaluation, type ResearchForwardEvaluation } from "./research-shadow";
import { getResearchAudit } from "./research-audit";

const windowsSql = `windows(name,since) AS (
  VALUES ('24h',$3::bigint),('7d',$4::bigint),('lifetime',0::bigint)
)`;
const joinedSql = `joined AS (
  SELECT c.*,l.label_status,l.settlement_disputed,l.outcome AS label_outcome,
    s.correct,s.brier,s.log_loss,s.market_baseline_brier,s.market_baseline_log_loss,
    s.reference_discrepancy_usd,s.outcome AS scored_outcome,
    (s.round_id IS NOT NULL AND l.label_status='verified' AND NOT l.settlement_disputed
      AND upper(l.outcome)=s.outcome) AS valid_score
  FROM waterx_research_choices c
  LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=c.interval_minutes AND l.round_id=c.round_id
    AND l.start_ms=c.start_ms AND l.expiry_ms=c.expiry_ms
  LEFT JOIN waterx_research_scores s ON s.interval_minutes=c.interval_minutes AND s.round_id=c.round_id
  WHERE c.interval_minutes=$1
)`;
const statsSql = `WITH ${windowsSql},${joinedSql}
  SELECT w.name,count(c.round_id) FILTER(WHERE c.state='FROZEN') AS choices,
    count(c.round_id) FILTER(WHERE c.state='NO_VALID_CHOICE') AS no_choice,
    count(c.round_id) FILTER(WHERE c.valid_score) AS scored,
    count(c.round_id) FILTER(WHERE c.valid_score AND c.correct) AS correct,
    avg(c.brier) FILTER(WHERE c.valid_score) AS brier,
    avg(c.log_loss) FILTER(WHERE c.valid_score) AS log_loss,
    avg(c.market_baseline_brier) FILTER(WHERE c.valid_score) AS baseline_brier,
    avg(c.market_baseline_log_loss) FILTER(WHERE c.valid_score) AS baseline_log_loss,
    count(c.round_id) FILTER(WHERE c.state='FROZEN' AND NOT c.valid_score
      AND NOT COALESCE(c.settlement_disputed,false)
      AND COALESCE(c.label_status,'unresolved') NOT IN ('withheld')) AS pending,
    count(c.round_id) FILTER(WHERE c.settlement_disputed) AS disputed,
    count(c.round_id) FILTER(WHERE c.label_status='withheld' AND NOT c.settlement_disputed) AS withheld,
    count(c.round_id) FILTER(WHERE c.state='FROZEN' AND c.evidence->'reference'->>'quality'='provisional') AS provisional,
    count(c.round_id) FILTER(WHERE c.state='FROZEN' AND c.evidence->'reference'->>'quality'='confirmed') AS confirmed,
    count(c.round_id) FILTER(WHERE c.state='FROZEN' AND c.evidence->'reference'->>'quality'='unavailable') AS unavailable_reference,
    count(c.round_id) FILTER(WHERE c.valid_score AND c.reference_discrepancy_usd<>0) AS discrepancies,
    (SELECT count(*) FROM waterx_research_capture_events e WHERE e.interval_minutes=$1
      AND e.stage='OBSERVED' AND extract(epoch FROM e.recorded_at)*1000>=w.since) AS observed,
    (SELECT count(*) FROM waterx_research_capture_events e WHERE e.interval_minutes=$1
      AND e.stage='NO_VALID_CHOICE' AND e.round_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM waterx_research_choices x WHERE x.interval_minutes=e.interval_minutes AND x.start_ms=e.start_ms)
      AND extract(epoch FROM e.recorded_at)*1000>=w.since) AS missing_identity,
    (SELECT count(*) FROM waterx_research_capture_events e JOIN waterx_learning_rounds l
      ON l.interval_minutes=e.interval_minutes AND l.round_id=e.round_id
      WHERE e.interval_minutes=$1 AND e.stage='OBSERVED' AND l.label_status='verified'
      AND NOT l.settlement_disputed AND extract(epoch FROM e.recorded_at)*1000>=w.since) AS verified_settlements,
    count(c.round_id) FILTER(WHERE c.evidence->'qualityFlags' @> '["COINBASE_LOOKBACK_INCOMPLETE"]'::jsonb
      OR c.evidence->'qualityFlags' @> '["REFERENCE_UNAVAILABLE"]'::jsonb) AS feature_failures
  FROM windows w LEFT JOIN joined c ON c.decision_at_ms>=w.since AND c.decision_at_ms<=$2
  GROUP BY w.name,w.since`;
const bucketsSql = `WITH ${windowsSql},${joinedSql},
  scored AS (SELECT w.name,c.* FROM windows w JOIN joined c
    ON c.decision_at_ms>=w.since AND c.decision_at_ms<=$2 AND c.valid_score)
  SELECT name,'calibration' AS kind,
    least(9,floor(probability_up*10))::text AS bucket,count(*) AS n,
    avg(probability_up) AS predicted,avg((scored_outcome='UP')::int) AS observed,
    avg(brier) AS brier,avg(log_loss) AS log_loss,avg(correct::int)*100 AS accuracy
  FROM scored GROUP BY name,least(9,floor(probability_up*10))
  UNION ALL SELECT name,'cohort',evidence->'reference'->>'quality',count(*),
    NULL,NULL,avg(brier),avg(log_loss),avg(correct::int)*100 FROM scored
    GROUP BY name,evidence->'reference'->>'quality'
  UNION ALL SELECT name,'discrepancy',
    (evidence->'reference'->>'quality')||':'||
      CASE WHEN reference_discrepancy_usd IS NULL THEN 'unavailable'
        WHEN reference_discrepancy_usd=0 THEN 'unchanged' ELSE 'changed' END,count(*),
    NULL,NULL,avg(brier),avg(log_loss),avg(correct::int)*100 FROM scored
    GROUP BY name,evidence->'reference'->>'quality',CASE WHEN reference_discrepancy_usd IS NULL THEN 'unavailable'
      WHEN reference_discrepancy_usd=0 THEN 'unchanged' ELSE 'changed' END
  UNION ALL SELECT name,'time',CASE WHEN expiry_ms-decision_at_ms<=60000 THEN '≤60s'
      WHEN expiry_ms-decision_at_ms<=180000 THEN '61–180s' ELSE '>180s' END,count(*),
    NULL,NULL,avg(brier),avg(log_loss),NULL FROM scored
    GROUP BY name,CASE WHEN expiry_ms-decision_at_ms<=60000 THEN '≤60s'
      WHEN expiry_ms-decision_at_ms<=180000 THEN '61–180s' ELSE '>180s' END`;
const reasonsSql = `SELECT code,min(reason) AS reason,count(*) AS count FROM (
  SELECT no_choice_code AS code,no_choice_reason AS reason FROM waterx_research_choices
    WHERE interval_minutes=$1 AND state='NO_VALID_CHOICE'
  UNION ALL SELECT e.code,e.reason FROM waterx_research_capture_events e
    WHERE e.interval_minutes=$1 AND e.stage='NO_VALID_CHOICE' AND e.round_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM waterx_research_choices c
        WHERE c.interval_minutes=e.interval_minutes AND c.start_ms=e.start_ms)
  ) failures GROUP BY code ORDER BY count(*) DESC,code`;
type Cached = {
  expires: number; promise: Promise<{
    windows: ResearchWindow[]; reasons: ResearchReport["noChoiceReasons"]; firstObservedAt: number|null;
    forward: ResearchForwardEvaluation;
  }>;
};
const summaryCache = new Map<ResearchInterval,Cached>();
const n = (x:unknown) => Number(x ?? 0);
const nullable = (x:unknown) => x == null ? null : Number(x);
async function summaries(interval:ResearchInterval,now:number) {
  const cached = summaryCache.get(interval);
  if (cached && cached.expires>now) return cached.promise;
  const promise = (async()=>{
    const params=[interval,now,now-86400000,now-7*86400000];
    const [stats,buckets,reasons,first,forward] = await Promise.all([
      researchPool.query(statsSql,params),researchPool.query(bucketsSql,params),
      researchPool.query(reasonsSql,[interval]),
      researchPool.query(`SELECT min(recorded_at) AS first_at FROM waterx_research_capture_events
        WHERE interval_minutes=$1`,[interval]),
      getResearchForwardEvaluation(interval,researchPool),
    ]);
    const firstAt = first.rows[0]?.first_at ? new Date(first.rows[0].first_at).getTime() : null;
    const windows:ResearchWindow[] = ["24h","7d","lifetime"].map(name=>{
      const r=stats.rows.find(r=>r.name===name)!;
      const windowStart=name==="24h" ? now-86400000 : name==="7d" ? now-7*86400000 : 0;
      const cadence=interval*60000,buffer=POLICY.checkpointSecondsBeforeClose[interval]*1000;
      const firstSlot=firstAt===null ? null : Math.floor(firstAt/cadence)*cadence;
      const lastSlot=Math.floor((now-cadence+buffer)/cadence)*cadence;
      const from=firstSlot===null ? null : Math.max(firstSlot,
        Math.ceil((windowStart-cadence+buffer)/cadence)*cadence);
      const checkpoints=from===null || lastSlot<from ? 0 : (lastSlot-from)/cadence+1;
      const b=buckets.rows.filter(b=>b.name===name);
      return {
        name:name as ResearchWindow["name"],observedRounds:n(r.observed),officialChoices:n(r.choices),
        noValidChoice:n(r.no_choice)+n(r.missing_identity),
        coveragePercent:checkpoints ? Math.min(100,n(r.choices)/checkpoints*100) : null,
        scheduledCheckpoints:checkpoints,
        unobservedCheckpoints:Math.max(0,checkpoints-n(r.choices)-n(r.no_choice)-n(r.missing_identity)),
        scoredChoices:n(r.scored),correct:n(r.correct),
        verifiedSettlements:n(r.verified_settlements),
        accuracyPercent:n(r.scored) ? n(r.correct)/n(r.scored)*100 : null,
        brier:nullable(r.brier),logLoss:nullable(r.log_loss),
        marketBaselineBrier:nullable(r.baseline_brier),marketBaselineLogLoss:nullable(r.baseline_log_loss),
        pending:n(r.pending),disputed:n(r.disputed),withheld:n(r.withheld),
        provisional:n(r.provisional),confirmed:n(r.confirmed),unavailableReference:n(r.unavailable_reference),
        referenceDiscrepancies:n(r.discrepancies),featureCoverageFailures:n(r.feature_failures),
        calibration:b.filter(b=>b.kind==="calibration").map(b=>({lower:n(b.bucket)/10,upper:(n(b.bucket)+1)/10,
          n:n(b.n),predictedUpMean:n(b.predicted),observedUpRate:n(b.observed)})),
        cohorts:b.filter(b=>b.kind==="cohort").map(b=>({referenceQuality:b.bucket,n:n(b.n),
          accuracyPercent:nullable(b.accuracy),brier:nullable(b.brier),logLoss:nullable(b.log_loss)})),
        referenceDiscrepancyCohorts:b.filter(b=>b.kind==="discrepancy").map(b=>({
          referenceQuality:b.bucket.split(":")[0],cohort:b.bucket.split(":")[1],n:n(b.n),
          accuracyPercent:nullable(b.accuracy),brier:nullable(b.brier),logLoss:nullable(b.log_loss)})),
        timeRemaining:b.filter(b=>b.kind==="time").map(b=>({bucket:b.bucket,n:n(b.n),
          brier:nullable(b.brier),logLoss:nullable(b.log_loss)})),
      };
    });
    return {windows,reasons:reasons.rows.map(r=>({code:r.code,reason:r.reason,count:n(r.count)})),
      firstObservedAt:firstAt,forward};
  })();
  summaryCache.set(interval,{expires:now+10000,promise});
  try { return await promise; }
  catch(error) { if(summaryCache.get(interval)?.promise===promise) summaryCache.delete(interval);throw error; }
}

export async function getResearchReport(interval:ResearchInterval,
  round:ResearchReport["currentRound"],now=Date.now()):Promise<ResearchReport> {
  const job=await cachedDailyJob(interval,now);
  const base:ResearchReport={
    intervalMinutes:interval,asOf:new Date(now).toISOString(),schemaStatus:"unavailable",
    reason:null,policy:POLICY,currentRound:round,currentChoice:null,latestChoice:null,
    currentState:"UNAVAILABLE",currentReason:null,
    liveModelEstimate:{status:"unavailable",probabilityUp:null,probabilityDown:null,
      modelVersion:null,calibrationVersion:null,observedAtMs:null,
      reason:"No explicitly promoted, forward-approved WaterX research model exists. Market odds are not model estimates."},
    windows:[],noChoiceReasons:[],alert:{active:false,reason:null,delivery:"dashboard-and-server-log"},
    dailyJob:job,note:"Research prediction · not an entry recommendation. Direction and probability scores do not measure hypothetical $5 profitability. Coverage uses scheduled checkpoints since this research policy was first observed, not all historical WaterX rounds. Missing periods and disputes are not wins or losses.",
  };
  if (!process.env.DATABASE_URL) return {...base,reason:"Research database is not configured."};
  try {
    const [summary,latest,current,audit] = await Promise.all([
      summaries(interval,now),
      researchPool.query(`${researchChoicesSelect} WHERE c.interval_minutes=$1
        ORDER BY c.decision_at_ms DESC LIMIT 20`,[interval]),
      round ? researchPool.query(`${researchChoicesSelect} WHERE c.interval_minutes=$1 AND c.round_id=$2
        AND c.start_ms=$3 AND c.expiry_ms=$4`,[interval,round.id,round.startMs,round.expiryMs])
        : Promise.resolve({rows:[]}),
      getResearchAudit(researchPool,interval,now,round ? {
        intervalMinutes:interval,roundId:round.id,startMs:round.startMs,expiryMs:round.expiryMs,
      } : null),
    ]);
    const choice=current.rows[0] ? choiceFromRow(current.rows[0]) : null;
    const lifetime=summary.windows.find(w=>w.name==="lifetime")!;
    const alert=lifetime.observedRounds>=3 && lifetime.officialChoices===0 &&
      summary.firstObservedAt!==null && now-summary.firstObservedAt>=interval*120000;
    let reason:string|null = null;
    let state:ResearchReport["currentState"] = choice?.state ?? "AWAITING_CHECKPOINT";
    if(!round) {
      state="UNAVAILABLE";reason="Current WaterX round identity is unavailable; an old choice is never shown as current.";
    } else if(!choice) {
      const at=checkpointAt(interval,round.expiryMs);
      reason=now<at ? `Primary checkpoint is ${POLICY.checkpointSecondsBeforeClose[interval]} seconds before close.`
        : "Checkpoint persistence is pending; no unlocked or inferred prediction is shown.";
    }
    const diagnosticAlert=(audit.diagnostics ?? []).filter(d=>d.severity!=="info" && d.code!=="LIFECYCLE_SCHEMA_UNAVAILABLE");
    return {...base,...audit,schemaStatus:"available",reason:null,currentChoice:choice,
      latestChoice:latest.rows[0] ? choiceFromRow(latest.rows[0]) : null,
      recentChoices:latest.rows.map(choiceFromRow),
      currentState:state,currentReason:choice?.noChoiceReason ?? reason,
      windows:summary.windows,noChoiceReasons:summary.reasons,
      forwardEvaluation:summary.forward,
      alert:{active:alert||diagnosticAlert.length>0,reason:diagnosticAlert.length
        ? diagnosticAlert.map(d=>`${d.code}: ${d.reason}`).join(" ")
        : alert ? "Fresh rounds are being observed, but no official checkpoint choices have been frozen." : null,
        delivery:"dashboard-and-server-log"}};
  } catch(error) {
    if(!researchSchemaMissing(error)) throw error;
    return {...base,reason:"Research schema is not installed. No startup migration or historical prediction backfill was attempted.",
      currentReason:"Research schema unavailable."};
  }
}
const dailyCache=new Map<ResearchInterval,{expires:number,promise:ReturnType<typeof getResearchDailyJob>}>();
function cachedDailyJob(interval:ResearchInterval,now:number) {
  const cached=dailyCache.get(interval);
  if(cached && cached.expires>now) return cached.promise;
  const promise=getResearchDailyJob(interval);
  dailyCache.set(interval,{expires:now+60000,promise});
  void promise.catch(()=>{if(dailyCache.get(interval)?.promise===promise) dailyCache.delete(interval);});
  return promise;
}