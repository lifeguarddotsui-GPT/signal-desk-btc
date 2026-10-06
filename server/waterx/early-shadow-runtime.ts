import {earlyFeatureVector,inferEarlyModel,EARLY_FEATURE_SCHEMA,type EarlyLinearModel} from "../../shared/early-features";
import {digestEarlySnapshot} from "./early-horizons";
import {researchPool} from "./research-store";
import {TIMED_STRATEGY} from "../../shared/timed-decision";
type CalibratedModel={model:EarlyLinearModel;calibration:{intercept:number;coefficients:number[]}};
type Artifact={featureSchema:string;interval:5|15;trainedAtMs:number;evidenceThroughMs:number;
  independent:CalibratedModel;crossInterval:CalibratedModel;policyThreshold:number;shadowOnly:true;active:false;digest:string};
const candidates=new Map<5|15,Artifact>();
let refreshing=false,lastRefreshAtMs:number|null=null,lastRefreshFailed=false;
export function validateShadowArtifact(raw:unknown,interval:5|15,now:number):Artifact{
  const a=raw as Artifact,{digest,...body}=a??{} as Artifact;
  if(!a||a.interval!==interval||a.featureSchema!==EARLY_FEATURE_SCHEMA||a.shadowOnly!==true||a.active!==false||
    !Number.isSafeInteger(a.trainedAtMs)||a.trainedAtMs>now||!Number.isSafeInteger(a.evidenceThroughMs)||
    a.evidenceThroughMs>a.trainedAtMs||digestEarlySnapshot(body)!==digest)
    throw new Error("Unverified prospective shadow artifact");
  for(const [fit,length] of [[a.independent,10],[a.crossInterval,14]] as const){
    if(!fit||fit.model.coefficients.length!==length||fit.calibration.coefficients.length!==1||
      [...fit.model.coefficients,...fit.model.means,...fit.model.scales,
        fit.model.intercept,fit.calibration.intercept,...fit.calibration.coefficients].some(v=>!Number.isFinite(v)))
      throw new Error("Invalid shadow model parameters");
    inferEarlyModel(fit.model,Array.from({length},()=>0));
  }
  return a;
}
/** Optional bounded read; NEVER awaited by the collector or gate transaction. */
export async function refreshEarlyShadowModels(now=Date.now()){
  if(refreshing)return;refreshing=true;
  try{
    const result=await researchPool.query(`SELECT j.interval_minutes,j.report->'modelComparison'->'artifact' AS artifact
      FROM waterx_early_training_jobs j WHERE j.strategy_version=$1 AND j.status='EVALUATED'
      AND j.report->'modelComparison'->>'status'='EVALUATED'
      AND jsonb_array_length(COALESCE(j.report->'references','[]'::jsonb))>0
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j.report->'references') ref
        LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=j.interval_minutes
          AND l.round_id=ref->>'roundId' AND l.start_ms=(ref->>'startMs')::bigint
          AND l.expiry_ms=(ref->>'expiryMs')::bigint
        WHERE l.label_status IS DISTINCT FROM 'verified' OR l.settlement_disputed
          OR (l.settlement_quarantine IS NOT NULL AND l.settlement_quarantine<>'[]'::jsonb)
          OR upper(l.outcome) IS DISTINCT FROM ref->>'outcome')
      ORDER BY j.started_at_ms DESC LIMIT 20`,[TIMED_STRATEGY]);
    for(const interval of [5,15] as const){
      const row=result.rows.find(r=>Number(r.interval_minutes)===interval);
      if(row)try{candidates.set(interval,validateShadowArtifact(row.artifact,interval,now));}catch{candidates.delete(interval);}
      else candidates.delete(interval);
    }
    lastRefreshAtMs=now;lastRefreshFailed=false;
  }catch{lastRefreshFailed=true;}finally{refreshing=false;}
}
export function forecastEarlyShadow(interval:5|15,horizon:number,probability:number,features:Record<string,unknown>,at:number){
  const a=candidates.get(interval);
  if(!a||a.trainedAtMs>at)return null;
  const probabilityFor=(fit:CalibratedModel,cross:boolean)=>{
    const p=inferEarlyModel(fit.model,earlyFeatureVector(probability,horizon,interval,features,cross));
    const bounded=Math.max(.000001,Math.min(.999999,p));
    const z=fit.calibration.intercept+fit.calibration.coefficients[0]*Math.log(bounded/(1-bounded));
    return 1/(1+Math.exp(-Math.max(-40,Math.min(40,z))));
  };
  return {probabilityUp:probabilityFor(a.independent,false),crossProbabilityUp:probabilityFor(a.crossInterval,true),
    modelVersion:a.digest,calibrationVersion:`${a.digest}:heldout-calibration`,
    active:false,shadowOnly:true,referenceReplacement:false};
}
export const earlyShadowStatus=()=>({candidateIntervals:Array.from(candidates.keys()),lastRefreshAtMs,
  lastRefreshFailed,activeModel:false,qualificationPolicy:"UNCHANGED_DETERMINISTIC_V3"});
