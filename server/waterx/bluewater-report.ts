import type { BluewaterReport, BluewaterFunnel, BluewaterForecast } from "../../shared/bluewater-research";
import { researchPool } from "./research-store";
import { bluewaterSchema, currentChampion, json, type Db } from "./bluewater-store";
import { FEATURE_SCHEMA, FEATURE_NAMES, type ModelArtifact } from "./bluewater-fast";
import { loadBluewaterCohort, inspectCanonicalCohort } from "./bluewater-cohort";
import { paired, promotionGate, metrics, type MatchedPoint } from "./bluewater-metrics";
import { researchHypotheses } from "./bluewater-agent";

export const activeForecastSql=`SELECT f.*,fs.feature_snapshot->'values' AS features,
  l.outcome,l.first_verified_at,l.settled_at,p.primary_lock_seconds,
  CASE WHEN l.label_status='verified' AND NOT l.settlement_disputed
    AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
    AND l.settled_at>f.expiry_ms AND l.settled_at<=$2
    AND l.first_verified_at<=to_timestamp($2::double precision/1000)
    AND ((upper(l.outcome)='UP' AND l.settle_price>=l.settlement_anchor_price)
      OR (upper(l.outcome)='DOWN' AND l.settle_price<l.settlement_anchor_price))
    THEN upper(l.outcome) END AS active_outcome
  FROM waterx_research_model_forecasts f
  JOIN waterx_research_feature_snapshots fs USING(feature_snapshot_digest)
  JOIN waterx_research_round_policy p ON p.interval_minutes=f.interval_minutes AND p.round_id=f.round_id
    AND p.start_ms=f.start_ms AND p.expiry_ms=f.expiry_ms
  LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=f.interval_minutes AND l.round_id=f.round_id
    AND l.start_ms=f.start_ms AND l.expiry_ms=f.expiry_ms
  WHERE f.interval_minutes=$1 AND f.decision_at_ms<=$2 AND f.decision_at_ms>=$3
    AND f.lock_seconds=p.primary_lock_seconds ORDER BY f.decision_at_ms DESC LIMIT 50001`;
export const allForecastReadSql=activeForecastSql.replace("AND f.lock_seconds=p.primary_lock_seconds ","").split("ORDER BY")[0];
const errorAggregateSql=`WITH model_rows AS (${allForecastReadSql})
 SELECT b.bucket,b.context,count(*)::integer AS n FROM model_rows r
 CROSS JOIN LATERAL (VALUES
  ('probabilityBin',least(9,floor((CASE WHEN r.chosen_side='UP' THEN r.displayed_probability_up ELSE 1-r.displayed_probability_up END)*10))::text),
  ('side',r.chosen_side),('horizon',r.lock_seconds::text),
  ('confidenceBucket',CASE WHEN greatest(r.displayed_probability_up,1-r.displayed_probability_up)>=.9 THEN 'HIGH'
    WHEN greatest(r.displayed_probability_up,1-r.displayed_probability_up)>=.7 THEN 'MID' ELSE 'LOW' END),
  ('volatilityBucket',CASE WHEN r.features->>'volatility_60s' IS NULL THEN 'UNAVAILABLE'
    WHEN (r.features->>'volatility_60s')::double precision<5 THEN 'LOW'
    WHEN (r.features->>'volatility_60s')::double precision<20 THEN 'MID' ELSE 'HIGH' END),
  ('distanceBucket',CASE WHEN r.features->>'reference_distance_bps' IS NULL THEN 'UNAVAILABLE'
    WHEN abs((r.features->>'reference_distance_bps')::double precision)<10 THEN 'NEAR' ELSE 'FAR' END),
  ('reversal',CASE WHEN r.features->>'recent_side_changes' IS NULL THEN 'UNAVAILABLE'
    WHEN (r.features->>'recent_side_changes')::integer>0 THEN 'REVERSAL' ELSE 'NO_REVERSAL' END)
 ) b(bucket,context) WHERE r.active_outcome IS NOT NULL AND r.chosen_side<>r.active_outcome
 GROUP BY b.bucket,b.context`;
export function pointsFromForecastRows(rows:Record<string,unknown>[]):MatchedPoint[]{
  return rows.filter(r=>r.active_outcome==="UP"||r.active_outcome==="DOWN").map(r=>({
    key:`${r.round_id}:${r.lock_seconds}:${r.feature_snapshot_digest}`,artifactId:String(r.model_artifact_id),
    modelFamily:r.model_family as MatchedPoint["modelFamily"],probability:Number(r.displayed_probability_up),
    baseline:Number(json<Record<string,number>>(r.features).waterx_probability_up),
    outcome:r.active_outcome as "UP"|"DOWN",decisionAtMs:Number(r.decision_at_ms)}));
}
const pct=(n:number,d:number)=>d?n/d*100:null;
export function buildFunnel(rows:Record<string,unknown>[],interval:5|15,now:number,since:number,
  training:Set<string>,rich:Set<string>,forecastCounts:{rounds:number;forecasts:number},window:string):BluewaterFunnel{
  const count=(k:string)=>rows.filter(r=>r[k]===true).length;
  const choices=count("canonical"),onTime=count("on_time"),scored=count("scored"),valid=count("valid_observation"),
    verified=count("verified"),richer=rows.filter(r=>rich.has(String(r.round_id))).length;
  return {window,since:new Date(since).toISOString(),through:new Date(now).toISOString(),expectedExactRounds:null,
    knownPublishedRounds:rows.length,theoreticalTimeSlots:Math.max(0,Math.floor(now/(interval*60000))-Math.ceil(since/(interval*60000))),
    discoveryScope:"Persisted exact WaterX published-round identities, including historical discovery. Not an exhaustive authoritative catalogue; historical discovery is not pre-expiry observation.",
    discovered:rows.length,validObservations:valid,watching:count("watching"),canonicalChoices:choices,onTimeChoices:onTime,
    lateChoices:count("late"),missingChoices:rows.length-choices,verifiedSettlements:verified,scoredChoices:scored,
    trainingEligible:rows.filter(r=>training.has(String(r.round_id))).length,withdrawnDisputed:count("disputed"),
    richFeatureChoices:richer,modelForecastRounds:forecastCounts.rounds,modelForecasts:forecastCounts.forecasts,
    rates:{canonicalCapture:pct(choices,rows.length),onTimeCapture:pct(onTime,rows.length),
      settlementCompletion:pct(verified,rows.length),scoringCompletion:pct(scored,choices),
      richFeatureCoverage:pct(richer,choices),modelForecastCoverage:pct(forecastCounts.rounds,valid)}};
}
function dto(r:Record<string,unknown>):BluewaterForecast{
  const outcome=r.active_outcome==="UP"||r.active_outcome==="DOWN"?r.active_outcome:null;
  return {intervalMinutes:Number(r.interval_minutes) as 5|15,roundId:String(r.round_id),startMs:Number(r.start_ms),
    expiryMs:Number(r.expiry_ms),lockSeconds:Number(r.lock_seconds),decisionAtMs:Number(r.decision_at_ms),
    artifactId:String(r.model_artifact_id),modelFamily:r.model_family as BluewaterForecast["modelFamily"],
    modelVersion:String(r.model_version),artifactDigest:String(r.artifact_digest),featureSnapshotDigest:String(r.feature_snapshot_digest),
    rawProbabilityUp:Number(r.raw_probability_up),calibratedProbabilityUp:r.calibrated_probability_up==null?null:Number(r.calibrated_probability_up),
    displayedProbabilityUp:Number(r.displayed_probability_up),chosenSide:r.chosen_side as "UP"|"DOWN",
    forecastStatus:r.forecast_status as "SHADOW"|"CHAMPION",
    outcome,result:outcome?(r.chosen_side===outcome?"CORRECT":"INCORRECT"):null};
}
const cache=new Map<number,{until:number;promise:Promise<BluewaterReport>}>();
export function getBluewaterReport(interval:5|15,round:{id:string}|null=null,db:Db=researchPool,now=Date.now()){
  if(db===researchPool){const c=cache.get(interval);if(c&&c.until>now)return c.promise;
    const promise=readReport(interval,round,db,now);cache.set(interval,{until:now+10000,promise});return promise;}
  return readReport(interval,round,db,now);
}
async function readReport(interval:5|15,round:{id:string}|null,db:Db,now:number):Promise<BluewaterReport>{
  const empty:BluewaterReport={intervalMinutes:interval,asOf:new Date(now).toISOString(),schemaStatus:"unavailable",
    reason:null,status:"INSUFFICIENT",developmentOnly:true,champion:null,challengers:[],qualifiedCalibration:false,
    currentForecast:null,priorForecast:null,funnels:[],training:{canonical:0,rich:0,currentAudit:null,lastDailyRun:null},
    comparisons:[],mistakes:[],research:{lastRun:null,mode:"bounded-report-only-planner",hypotheses:[],experiments:[]},
    promotion:{automatic:false,eligible:false,reasons:["No qualified manually approved champion."],reports:[]},
    featureSchema:FEATURE_SCHEMA,featureNames:[...FEATURE_NAMES],limitations:[
      "No production release, wallet execution, live trading or verified net entry economics.",
      "WaterX baseline is a market control, not independent AI. Shadow probability is never qualified public Bluewater probability.",
      "Legacy unpinned choices retain original evidence and are excluded from new pinned on-time/late timing classifications.",
      "Bounded 14-day / 5000-choice reports; opportunistic collector cannot prove continuous coverage or recover sleeping intervals.",
      "Rule-based research planner proposes only; it has no LLM, SQL, deployment, money or promotion capability.",
      "No nonlinear model dependency or unqualified calibration. Error associations are descriptive.",
    ]};
  try{
    if(!await bluewaterSchema(db))return {...empty,reason:"Reviewed additive Bluewater development schema not applied; no startup DDL."};
    const since=now-14*86400000;
    const [cohort,models,champion,known,forecasts,experiments,reports,daily,errorGroups]=await Promise.all([
      loadBluewaterCohort(db,interval,now),
      db.query("SELECT * FROM waterx_research_artifacts WHERE interval_minutes=$1 AND fitted_at_ms<=$2 ORDER BY fitted_at_ms DESC LIMIT 100",[interval,now]),
      currentChampion(db,interval),
      db.query(`SELECT l.round_id,l.start_ms,l.expiry_ms,
        (c.state='FROZEN') IS TRUE AS canonical,
        (p.round_id IS NOT NULL AND c.state='FROZEN' AND c.decision_at_ms>=c.expiry_ms-p.primary_lock_seconds*1000
         AND c.decision_at_ms<=c.expiry_ms-p.primary_lock_seconds*1000+p.horizon_capture_grace_ms) IS TRUE AS on_time,
        (p.round_id IS NOT NULL AND c.state='FROZEN' AND c.decision_at_ms>c.expiry_ms-p.primary_lock_seconds*1000+p.horizon_capture_grace_ms) IS TRUE AS late,
        (l.label_status='verified' AND NOT l.settlement_disputed AND l.first_verified_at<=to_timestamp($2::double precision/1000)
         AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)) AS verified,
        (s.round_id IS NOT NULL AND l.label_status='verified' AND NOT l.settlement_disputed AND upper(l.outcome)=s.outcome
         AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)) AS scored,
        (l.settlement_disputed OR l.label_status='withheld' OR EXISTS(SELECT 1 FROM waterx_research_lifecycle_events e
         WHERE e.interval_minutes=l.interval_minutes AND e.round_id=l.round_id AND e.event_type='RESULT_WITHDRAWN')) AS disputed,
        EXISTS(SELECT 1 FROM waterx_research_lifecycle_events e WHERE e.interval_minutes=l.interval_minutes AND e.round_id=l.round_id
          AND e.event_type='WATCHING') AS watching,
        (c.state='FROZEN' OR EXISTS(SELECT 1 FROM waterx_research_lifecycle_events e WHERE e.interval_minutes=l.interval_minutes
          AND e.round_id=l.round_id AND e.event_type='LEANING')) IS TRUE AS valid_observation
        FROM waterx_learning_rounds l LEFT JOIN waterx_research_choices c USING(interval_minutes,round_id,start_ms,expiry_ms)
        LEFT JOIN waterx_research_round_policy p USING(interval_minutes,round_id,start_ms,expiry_ms)
        LEFT JOIN waterx_research_scores s USING(interval_minutes,round_id)
        WHERE l.interval_minutes=$1 AND l.start_ms>=$3 AND l.expiry_ms<=$2 ORDER BY l.start_ms LIMIT 5001`,[interval,now,since]),
      db.query(activeForecastSql,[interval,now,since]),
      db.query("SELECT * FROM waterx_research_experiments WHERE interval_minutes=$1 ORDER BY created_at DESC LIMIT 20",[interval]),
      db.query("SELECT * FROM waterx_research_agent_reports WHERE interval_minutes=$1 ORDER BY scheduled_day DESC LIMIT 1",[interval]),
      db.query("SELECT finished_at FROM waterx_research_daily_runs WHERE interval_minutes=$1 ORDER BY scheduled_day DESC LIMIT 1",[interval]),
      db.query(errorAggregateSql,[interval,now,since]),
    ]);
    if(known.rows.length>5000||forecasts.rows.length>50000)throw new Error("Research read bound exceeded; no truncated scientific comparison.");
    const points=pointsFromForecastRows(forecasts.rows);
    const comparisons=models.rows.map(r=>({...paired(points,String(r.artifact_id)),modelFamily:r.model_family as BluewaterForecast["modelFamily"]}));
    const training=new Set(cohort.canonical.map(r=>r.roundId)),rich=new Set(cohort.rich.map(r=>r.roundId));
    const windows=[["24h",86400000],["7d",7*86400000],["14d",14*86400000]] as const;
    const funnels:BluewaterFunnel[]=[];
    for(const [name,ms] of windows){
      const count=await db.query(`SELECT count(*)::integer AS n,count(DISTINCT f.round_id)::integer AS rounds
        FROM waterx_research_model_forecasts f WHERE f.interval_minutes=$1 AND f.start_ms>=$2 AND f.expiry_ms<=$3`,[interval,now-ms,now]);
      funnels.push(buildFunnel(known.rows.filter(r=>Number(r.start_ms)>=now-ms),interval,now,now-ms,training,rich,
        {rounds:Number(count.rows[0]?.rounds??0),forecasts:Number(count.rows[0]?.n??0)},name));
    }
    const promotionReports=models.rows.map(r=>{
      const selected=points.filter(p=>p.artifactId===r.artifact_id),dates=selected.map(p=>p.decisionAtMs);
      const a=json<Omit<ModelArtifact,"id"|"artifactDigest">>(r.artifact);
      let championComparison=null;
      if(champion){const championPoints=new Map(points.filter(p=>p.artifactId===champion.artifact_id).map(p=>[p.key,p]));
        const matched=selected.filter(p=>championPoints.has(p.key)).map(p=>({...p,baseline:championPoints.get(p.key)!.probability}));
        championComparison=paired(matched,String(r.artifact_id));}
      return {artifactId:r.artifact_id,...promotionGate({interval,comparison:comparisons.find(c=>c.artifactId===r.artifact_id)!,
        spanMs:dates.length?Math.max(...dates)-Math.min(...dates):0,chronologicalEligible:a.protocol.eligible,
        calibrated:!!a.calibration,integrityIssues:funnels[0].withdrawnDisputed?["Unresolved withdrawn/disputed outcomes in current audit."]:[],
        championComparison,hasChampion:!!champion})};
    });
    const current=forecasts.rows.find(r=>r.round_id===round?.id&&r.forecast_status==="CHAMPION"&&r.model_artifact_id===champion?.artifact_id);
    const prior=forecasts.rows.find(r=>r.round_id!==round?.id&&r.active_outcome&&r.forecast_status==="CHAMPION"&&r.model_artifact_id===champion?.artifact_id);
    const allMistakes=forecasts.rows.filter(r=>r.active_outcome&&r.chosen_side!==r.active_outcome).map(r=>{
      const f=json<Record<string,number|null>>(r.features),p=Number(r.displayed_probability_up),chosen=String(r.chosen_side);
      const confidence=chosen==="UP"?p:1-p,vol=f.volatility_60s,dist=f.reference_distance_bps;
      return {artifactId:String(r.model_artifact_id),roundId:String(r.round_id),probability:confidence,side:chosen,
        lockSeconds:Number(r.lock_seconds),secondsBeforeExpiry:(Number(r.expiry_ms)-Number(r.decision_at_ms))/1000,
        baselineProbabilityUp:f.waterx_probability_up!,confidenceBucket:confidence>=.9?"HIGH":confidence>=.7?"MID":"LOW",
        volatilityBucket:vol==null?"UNAVAILABLE":vol<5?"LOW":vol<20?"MID":"HIGH",
        distanceBucket:dist==null?"UNAVAILABLE":Math.abs(dist)<10?"NEAR":"FAR",
        reversal:f.recent_side_changes==null?null:f.recent_side_changes>0,features:f};});
    const result:BluewaterReport={...empty,schemaStatus:"available",reason:null,status:champion?"QUALIFIED":models.rows.length?"SHADOW":"INSUFFICIENT",
      baselineMetrics:metrics(cohort.canonical.map(r=>({probability:r.probabilityUp,outcome:r.outcome}))),
      mistakeAggregates:errorGroups.rows.reduce<Record<string,Record<string,number>>>((out,r)=>{
        const key=String(r.bucket);out[key]??={};out[key][String(r.context)]=Number(r.n);return out;},{}),
      champion:champion?{artifactId:String(champion.artifact_id),modelFamily:champion.model_family as BluewaterForecast["modelFamily"],
        modelVersion:String(champion.model_version)}:null,
      challengers:models.rows.filter(r=>r.artifact_id!==champion?.artifact_id).slice(0,12).map(r=>({
        artifactId:String(r.artifact_id),modelFamily:r.model_family as BluewaterForecast["modelFamily"],
        modelVersion:String(r.model_version),fittedAt:new Date(Number(r.fitted_at_ms)).toISOString()})),
      qualifiedCalibration:champion?!!json<ModelArtifact>(champion.artifact).calibration:false,
      currentForecast:current?dto(current):null,priorForecast:prior?dto(prior):null,funnels,
      training:{canonical:cohort.canonical.length,rich:cohort.rich.length,
        currentAudit:inspectCanonicalCohort(cohort.canonical,interval),lastDailyRun:daily.rows[0]?.finished_at?new Date(String(daily.rows[0].finished_at)).toISOString():null},
      comparisons,mistakes:allMistakes.slice(0,100),research:{lastRun:reports.rows[0]?.created_at?new Date(String(reports.rows[0].created_at)).toISOString():null,
        mode:"bounded-report-only-planner",hypotheses:[],experiments:experiments.rows.map(r=>({id:String(r.experiment_id),
          kind:String(r.kind),status:String(r.status),createdAt:new Date(String(r.created_at)).toISOString(),result:r.result}))},
      promotion:{automatic:false,eligible:promotionReports.some(r=>r.eligible),reasons:models.rows.length?
        ["Explicit development-owner CLI approval required; no automatic activation."]:["No eligible artifact. Current evidence is insufficient."],reports:promotionReports}};
    result.research.hypotheses=researchHypotheses(result);return result;
  }catch(error){
    return {...empty,reason:`Bluewater research unavailable (${String((error as {code?:string}).code??"RESEARCH_READ_FAILED")}). No baseline substitution.`};
  }
}