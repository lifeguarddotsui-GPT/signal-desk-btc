import type { ResearchTrainingQueryable as Db } from "./research-training";
import type { CanonicalTrainingReport } from "./research-baseline-training";
import type { ResearchTrainingReport } from "./research-training-model";
import { canonical, digest, FEATURE_SCHEMA, infer, validateArtifact, buildFeatureSnapshot, type FeatureSnapshot, type ModelArtifact } from "./bluewater-fast";

export type { Db };
export const json = <T>(v:unknown):T => (typeof v==="string"?JSON.parse(v):v) as T;
const available=new WeakMap<object,{until:number;value:boolean}>();
export async function bluewaterSchema(db:Db){
  const cached=available.get(db);if(cached&&cached.until>Date.now())return cached.value;
  const r=await db.query("SELECT to_regclass('waterx_research_model_forecasts') IS NOT NULL AND to_regclass('waterx_research_artifacts') IS NOT NULL AS available");
  const value=r.rows[0]?.available===true;available.set(db,{until:Date.now()+30000,value});return value;
}
export async function persistArtifact(db:Db,a:ModelArtifact){
  validateArtifact(a,Date.now());const {id,artifactDigest,...body}=a;
  await db.query(`INSERT INTO waterx_research_artifacts
    (artifact_id,interval_minutes,model_family,model_version,artifact_digest,feature_schema_version,
     dataset_fingerprint,fitted_at_ms,evidence_through_ms,artifact,canonical_payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) ON CONFLICT DO NOTHING`,
  [id,a.intervalMinutes,a.family,a.version,artifactDigest,a.featureSchema,a.datasetFingerprint,
    a.fittedAtMs,a.evidenceThroughMs,JSON.stringify(body),canonical(body)]);
}
export function wrapArtifact(interval:5|15,report:CanonicalTrainingReport|ResearchTrainingReport,
  family:ModelArtifact["family"],now:number,range?:{fromMs:number;throughMs:number}):ModelArtifact|null{
  if(report.status!=="candidate-evaluated"||!report.eligibility.eligible)return null;
  const baseline="baselineArtifact" in report?report.baselineArtifact:null;
  const rich="shadowArtifact" in report?report.shadowArtifact:null;
  if(!baseline&&!rich)return null;
  if(!range||![range.fromMs,range.throughMs].every(Number.isFinite)||range.fromMs>range.throughMs)
    throw new Error("Exact input-cohort date range required for artifact registration.");
  const body:Omit<ModelArtifact,"id"|"artifactDigest">={
    formatVersion:"bluewater-numeric-v1",intervalMinutes:interval,family,
    version:`${(baseline??rich)!.version}-${family}`,featureSchema:FEATURE_SCHEMA,
    featureNames:baseline?["waterx_probability_up"]:rich!.featureNames,
    fittedAtMs:now,evidenceThroughMs:report.evidenceAvailableThroughMs,
    datasetFingerprint:report.datasetFingerprint,calibration:(baseline??rich)!.calibration,
    parameters:rich?{means:rich.means,scales:rich.scales,coefficients:rich.coefficients,intercept:rich.intercept}:{},
    protocol:{eligible:true,records:report.uniqueEligibleCount,spanMs:report.spanMs,
      training:report.split.trainingCount,calibration:report.split.calibrationCount,test:report.split.testCount},
    dateRange:range,
    partitions:report.split,hyperparameters:{ridge:0.1,iterations:baseline?0:1000,calibrationIterations:baseline?800:600,
      canonicalCalibrationLearningRate:baseline ? 0.05 : null,
      protocol:report.protocol,lookbackDays:14,maxRows:5000},metrics:report.test,
  };
  const hash=digest(body);return {...body,id:hash,artifactDigest:hash};
}
export async function registerDailyArtifacts(db:Db,interval:5|15,
  canonicalReport:CanonicalTrainingReport,richReport:ResearchTrainingReport,now:number,
  ranges?:{canonical:{fromMs:number;throughMs:number};rich:{fromMs:number;throughMs:number}}){
  if(!await bluewaterSchema(db))return;
  for(const a of [wrapArtifact(interval,canonicalReport,"platt_waterx",now,ranges?.canonical),
    wrapArtifact(interval,richReport,"rich_logistic",now,ranges?.rich)])if(a)await persistArtifact(db,a);
}
export async function currentChampion(db:Db,interval:5|15){
  const r=await db.query(`SELECT e.event_type,a.* FROM waterx_research_champion_events e
    JOIN waterx_research_artifacts a ON a.artifact_id=e.artifact_id
    WHERE e.interval_minutes=$1 AND e.effective_at<=clock_timestamp() ORDER BY e.effective_at DESC,e.id DESC LIMIT 1`,[interval]);
  const row=r.rows[0];return row?.event_type==="ACTIVATE"?row:null;
}
export async function captureBluewaterForecasts(db:Db,snapshot:FeatureSnapshot){
  if(!await bluewaterSchema(db))return;
  const policy=await db.query(`SELECT * FROM waterx_research_round_policy WHERE interval_minutes=$1 AND round_id=$2
    AND start_ms=$3 AND expiry_ms=$4`,[snapshot.intervalMinutes,snapshot.roundId,snapshot.startMs,snapshot.expiryMs]);
  const p=policy.rows[0];if(!p)return;
  const eligible=(at:number)=>json<number[]>(p.horizon_seconds).filter(h=>at>=snapshot.expiryMs-h*1000&&
    at<=snapshot.expiryMs-h*1000+Number(p.horizon_capture_grace_ms));
  if(!eligible(snapshot.decisionAtMs).length||Date.now()>=snapshot.expiryMs)return;
  const champion=await currentChampion(db,snapshot.intervalMinutes);
  const r=await db.query(`SELECT * FROM (SELECT a.*,row_number() OVER(PARTITION BY model_family ORDER BY fitted_at_ms DESC,artifact_id) AS rank
    FROM waterx_research_artifacts a WHERE interval_minutes=$1 AND fitted_at_ms<=$2 AND evidence_through_ms<=$2) ranked
    WHERE rank<=2 OR artifact_id=$3 OR artifact_id IN(SELECT DISTINCT ON(model_family) artifact_id
      FROM waterx_research_artifacts WHERE interval_minutes=$1 AND fitted_at_ms>=$2-1209600000
      ORDER BY model_family,fitted_at_ms,artifact_id)
    ORDER BY fitted_at_ms DESC LIMIT 10`,
  [snapshot.intervalMinutes,snapshot.decisionAtMs,champion?.artifact_id??""]);
  // Actual batch inference time, not an earlier queued observation timestamp.
  const at=Date.now();if(at>=snapshot.expiryMs)return;
  const horizons=eligible(at);if(!horizons.length)return;
  snapshot=buildFeatureSnapshot({intervalMinutes:snapshot.intervalMinutes,roundId:snapshot.roundId,
    startMs:snapshot.startMs,expiryMs:snapshot.expiryMs,decisionAtMs:at,...snapshot.provenance});
  const {digest:hash,...body}=snapshot;
  await db.query(`INSERT INTO waterx_research_feature_snapshots
    (feature_snapshot_digest,interval_minutes,round_id,start_ms,expiry_ms,decision_at_ms,
     feature_schema_version,feature_snapshot,canonical_payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT DO NOTHING`,
  [hash,snapshot.intervalMinutes,snapshot.roundId,snapshot.startMs,snapshot.expiryMs,
    snapshot.decisionAtMs,snapshot.schema,JSON.stringify(body),canonical(body)]);
  for(const row of r.rows){
    const a={...json<Omit<ModelArtifact,"id"|"artifactDigest">>(row.artifact),
      id:String(row.artifact_id),artifactDigest:String(row.artifact_digest)};
    let prediction;try{prediction=infer(a,snapshot);}catch{continue;}
    for(const h of horizons)await db.query(`INSERT INTO waterx_research_model_forecasts
      (interval_minutes,round_id,start_ms,expiry_ms,lock_seconds,decision_at_ms,model_artifact_id,
       model_family,model_version,artifact_digest,feature_schema_version,feature_snapshot_digest,
       raw_probability_up,calibrated_probability_up,displayed_probability_up,chosen_side,forecast_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING`,
    [snapshot.intervalMinutes,snapshot.roundId,snapshot.startMs,snapshot.expiryMs,h,snapshot.decisionAtMs,
      a.id,a.family,a.version,a.artifactDigest,a.featureSchema,snapshot.digest,prediction.rawProbabilityUp,
      prediction.calibratedProbabilityUp,prediction.displayedProbabilityUp,prediction.chosenSide,
      champion?.artifact_id===a.id?"CHAMPION":"SHADOW"]);
  }
}
export async function appendModelResults(db:Db,interval:5|15){
  if(!await bluewaterSchema(db))return;
  await db.query(`INSERT INTO waterx_research_model_results
    (interval_minutes,round_id,model_artifact_id,lock_seconds,event_type,outcome,correct,brier,log_loss,label_available_at,settlement_evidence)
    SELECT f.interval_minutes,f.round_id,f.model_artifact_id,f.lock_seconds,'SCORED',upper(l.outcome),
      f.chosen_side=upper(l.outcome),
      power(f.displayed_probability_up-CASE WHEN upper(l.outcome)='UP' THEN 1 ELSE 0 END,2),
      -ln(greatest(0.0000000001,least(0.9999999999,
        CASE WHEN upper(l.outcome)='UP' THEN f.displayed_probability_up ELSE 1-f.displayed_probability_up END))),
      l.first_verified_at,jsonb_build_object('roundId',l.round_id,'anchor',l.settlement_anchor_price,
        'settlePrice',l.settle_price,'settledAt',l.settled_at,'labelAvailableAt',l.first_verified_at)
    FROM waterx_research_model_forecasts f JOIN waterx_learning_rounds l
      ON l.interval_minutes=f.interval_minutes AND l.round_id=f.round_id AND l.start_ms=f.start_ms AND l.expiry_ms=f.expiry_ms
    WHERE f.interval_minutes=$1 AND l.label_status='verified' AND NOT l.settlement_disputed
      AND upper(l.outcome) IN('UP','DOWN') AND l.settled_at>f.expiry_ms AND l.settled_at<=extract(epoch FROM clock_timestamp())*1000
      AND l.first_verified_at<=clock_timestamp() AND l.first_verified_at>to_timestamp(f.expiry_ms::double precision/1000)
      AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
      AND ((upper(l.outcome)='UP' AND l.settle_price>=l.settlement_anchor_price)
        OR (upper(l.outcome)='DOWN' AND l.settle_price<l.settlement_anchor_price))
    ON CONFLICT DO NOTHING`,[interval]);
  await db.query(`INSERT INTO waterx_research_model_results
    (interval_minutes,round_id,model_artifact_id,lock_seconds,event_type,outcome,correct,brier,log_loss,label_available_at,settlement_evidence)
    SELECT r.interval_minutes,r.round_id,r.model_artifact_id,r.lock_seconds,'WITHDRAWN',r.outcome,r.correct,r.brier,r.log_loss,
      r.label_available_at,jsonb_build_object('reason','Accepted settlement disputed or no longer matches')
    FROM waterx_research_model_results r JOIN waterx_research_model_forecasts f
      USING(interval_minutes,round_id,model_artifact_id,lock_seconds)
    LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=f.interval_minutes AND l.round_id=f.round_id
      AND l.start_ms=f.start_ms AND l.expiry_ms=f.expiry_ms
    WHERE r.interval_minutes=$1 AND r.event_type='SCORED' AND
      (l.round_id IS NULL OR l.label_status<>'verified' OR l.settlement_disputed OR upper(l.outcome)<>r.outcome
       OR (l.settlement_quarantine IS NOT NULL AND l.settlement_quarantine<>'[]'::jsonb))
    ON CONFLICT DO NOTHING`,[interval]);
}