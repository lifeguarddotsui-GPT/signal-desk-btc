import {createHash,randomUUID} from "node:crypto";
import {eventPartition,type EventTrajectory} from "./event-lock-learning";
import {fitLogistic} from "./research-training-model";
import {sigmoid,logit} from "./bluewater-fast";
import {metrics} from "./bluewater-metrics";
import {eventQualification,type EventObservation} from "../../shared/event-lock";
import {economicEvidenceFromFeatures} from "../../shared/lock-economics";
import {TWO_STAGE_FEATURES,TWO_STAGE_STRATEGY,type StageInput,type LockStage} from "../../shared/two-stage";
import {stageModelFeatures,type LearnedStagePolicy} from "./two-stage-policy";
import {researchPool} from "./research-store";
import type {LockDb} from "./lock-store";
type Trajectory=EventTrajectory&{marketId:string};
type Point={input:StageInput;x:number[];observation:EventObservation};
type Numeric=ReturnType<typeof fitLogistic>;
const probability=(model:Numeric,x:number[])=>sigmoid(model.intercept+x.reduce((s,v,i)=>s+v*model.coefficients[i],0));
const sample=(points:Point[])=>points.length<=12?points:Array.from({length:12},(_,i)=>points[Math.floor(i*(points.length-1)/11)]);
function points(r:Trajectory){
  const out:Point[]=[];
  for(let i=0;i<r.observations.length;i++){
    const observation=r.observations[i],input:StageInput={...r,observations:r.observations.slice(0,i+1),nowMs:observation.availableAtMs};
    const x=stageModelFeatures(input);
    if(x&&eventQualification(input,input.observations,input.nowMs).qualified)out.push({input,x,observation});
  }
  return out;
}
const both=(rows:Trajectory[])=>new Set(rows.map(r=>r.outcome)).size===2;
/** Whole trajectories, shared calendar embargo across overlapping intervals.
 * Policy selection consumes POLICY labels; selection-subset calibration only
 * CALIBRATION labels; final TEST is evaluated once and never tunes thresholds. */
export function trainTwoStage(trajectories:Trajectory[],interval:5|15,now:number){
  const excluded:Record<string,number>={},seen=new Set<string>();
  const rows=trajectories.filter(r=>{
    if(r.intervalMinutes!==interval)return false;
    const key=`${r.marketId}:${r.roundId}:${r.startMs}:${r.expiryMs}`;
    if(seen.has(key)){excluded.duplicate=(excluded.duplicate??0)+1;return false;}seen.add(key);
    if(!r.verified||!["UP","DOWN"].includes(r.outcome)||r.labelAvailableAtMs<=r.expiryMs||r.labelAvailableAtMs>now||
      !r.observations.length||r.observations.some(o=>o.provenance!=="PROSPECTIVE"||o.availableAtMs<o.receivedAtMs||
        o.availableAtMs>=r.expiryMs||o.receivedAtMs<r.startMs)){
      excluded.invalidOrUnavailable=(excluded.invalidOrUnavailable??0)+1;return false;
    }
    return true;
  });
  const partitions=Object.fromEntries(["TRAIN","CALIBRATION","POLICY","TEST"].map(stage=>
    [stage,rows.filter(r=>eventPartition(r,now)===stage)])) as Record<string,Trajectory[]>;
  const counts=Object.fromEntries(Object.entries(partitions).map(([s,r])=>[s,r.length]));
  const deficits=Object.fromEntries(Object.entries(partitions).map(([s,r])=>[s,{minimumRounds:60,
    missingRounds:Math.max(0,60-r.length),bothOutcomes:both(r)}]));
  const allPoints=rows.flatMap(r=>points(r)),fullSizeQuotePoints=allPoints.filter(p=>{
    const side=p.observation.probabilityUp>=.5?"UP":"DOWN";
    return economicEvidenceFromFeatures(p.observation.features,p.input.roundId,side,p.input.nowMs).kind==="VERIFIED_QUOTE";
  }).length;
  const digest=createHash("sha256").update(JSON.stringify(rows.map(r=>({round:r.roundId,market:r.marketId,
    start:r.startMs,outcome:r.outcome,available:r.labelAvailableAtMs,observations:r.observations})))).digest("hex");
  const base={protocol:"two-stage-whole-trajectory-selected-calibration-v1",interval,counts,deficits,excluded,
    trajectoryN:rows.length,fullSizeQuotePoints,datasetDigest:digest,
    featureVersion:TWO_STAGE_FEATURES,positiveModelEdgeAuthorized:false,automaticPromotion:false,
    stages:{EARLY:{status:"NOT_QUALIFIED"},CONFIRMATION:{status:"NOT_QUALIFIED"}},
    ablations:["MARKET_ODDS_ONLY","EXISTING_QUALIFICATION","EVENT_UNCHANGED","EVENT_PRICE_AREA","TWO_STAGE"],
    reason:"Require 60 whole verified trajectories in each disjoint stage, both outcomes, full-size quotes, stage-selected calibration and untouched matched final-test economics."};
  if(Object.values(partitions).some(r=>r.length<60||!both(r))||fullSizeQuotePoints===0)return base;
  const fitted=partitions.TRAIN.flatMap(r=>sample(points(r)).map(p=>({x:p.x,y:r.outcome==="UP"?1:0})));
  if(fitted.length<60)return {...base,reason:"Too few compatible accumulated-price feature observations."};
  const outcome=fitLogistic(fitted.map(p=>p.x),fitted.map(p=>p.y),.01,500);
  const strength=(p:Point)=>{const up=probability(outcome,p.x);return Math.max(up,1-up);};
  const candidates=partitions.POLICY.flatMap(r=>points(r).map(strength)).sort((a,b)=>a-b);
  const thresholds=Array.from(new Set([.5,...Array.from({length:9},(_,i)=>candidates[Math.floor((i+1)*candidates.length/10)])])).filter(Number.isFinite);
  const select=(r:Trajectory,threshold:number,stage:LockStage,earlyAt:number|null=null)=>{
    for(const p of points(r)){
      if(earlyAt!=null&&p.input.nowMs<=earlyAt||strength(p)<threshold)continue;
      const up=probability(outcome,p.x),side=up>=.5?"UP":"DOWN";
      const economic=economicEvidenceFromFeatures(p.observation.features,r.roundId,side,p.input.nowMs);
      if(economic.kind!=="VERIFIED_QUOTE"||economic.totalCostUsd==null||economic.lossIfIncorrectUsd==null)continue;
      if(stage==="EARLY"&&(economic.totalReturnedIfCorrectUsd??0)<6)continue;
      const profit=side===r.outcome?economic.netProfitIfCorrectUsd!:-economic.lossIfIncorrectUsd!;
      return {p,up,profit,side,economic};
    }return null;
  };
  const artifacts:Partial<Record<LockStage,LearnedStagePolicy>>={},stageReports:Record<string,unknown>={};
  let earlyThreshold=.5;
  for(const stage of ["EARLY","CONFIRMATION"] as const){
    const choices=thresholds.filter(t=>stage==="EARLY"||t>earlyThreshold).map(threshold=>{
      const selected=partitions.POLICY.flatMap(r=>{
        const early=stage==="CONFIRMATION"?select(r,earlyThreshold,"EARLY"):null;
        const s=select(r,threshold,stage,early?.p.input.nowMs??null);return s?[s]:[];
      });
      return {threshold,selected,utility:selected.length?selected.reduce((s,p)=>s+p.profit,0)/partitions.POLICY.length:-Infinity};
    }).filter(c=>c.selected.length>=60).sort((a,b)=>b.utility-a.utility||a.threshold-b.threshold);
    const chosen=choices[0];if(!chosen){stageReports[stage]={status:"NOT_QUALIFIED",reason:"Insufficient stage-selected POLICY quotes."};continue;}
    if(stage==="EARLY")earlyThreshold=chosen.threshold;
    const selectedCal=partitions.CALIBRATION.flatMap(r=>{
      const early=stage==="CONFIRMATION"?select(r,earlyThreshold,"EARLY"):null;
      const s=select(r,chosen.threshold,stage,early?.p.input.nowMs??null);return s?[{...s,outcome:r.outcome}]:[];
    });
    if(selectedCal.length<60||new Set(selectedCal.map(p=>p.outcome)).size<2){
      stageReports[stage]={status:"NOT_QUALIFIED",selectedCalibrationN:selectedCal.length,reason:"Stage-selected calibration insufficient."};continue;
    }
    const calibration=fitLogistic(selectedCal.map(p=>[logit(p.up)]),selectedCal.map(p=>p.outcome==="UP"?1:0),.01,500);
    const test=partitions.TEST.flatMap(r=>{
      const early=stage==="CONFIRMATION"?select(r,earlyThreshold,"EARLY"):null;
      const s=select(r,chosen.threshold,stage,early?.p.input.nowMs??null);
      return s?[{...s,outcome:r.outcome,calibrated:probability(calibration,[logit(s.up)])}]:[];
    });
    const scored=metrics(test.map(p=>({probability:p.calibrated,outcome:p.outcome})));
    const baseline=metrics(test.map(p=>({probability:p.p.observation.probabilityUp,outcome:p.outcome})));
    const mean=test.length?test.reduce((s,p)=>s+p.profit,0)/test.length:0;
    const variance=test.length>1?test.reduce((s,p)=>s+(p.profit-mean)**2,0)/(test.length-1):Infinity;
    const lower95=mean-1.96*Math.sqrt(variance/Math.max(1,test.length));
    const qualified=test.length>=60&&new Set(test.map(p=>p.outcome)).size===2&&scored.brier!=null&&baseline.brier!=null&&
      scored.brier<baseline.brier&&scored.brier<.25&&lower95>0;
    stageReports[stage]={status:qualified?"QUALIFIED_SHADOW_ONLY":"NOT_QUALIFIED",threshold:chosen.threshold,
      selectedCalibrationN:selectedCal.length,test:scored,matchedMarketBaseline:baseline,meanNetUsd:mean,lower95NetUsd:lower95};
    if(qualified)artifacts[stage]={version:`two-stage-${interval}-${stage}-${digest.slice(0,16)}`,stage,interval,
      modelVersion:`area-outcome-${interval}-${digest.slice(0,16)}`,trainedBeforeMs:now,featureVersion:TWO_STAGE_FEATURES,
      minimumStrength:chosen.threshold,outcome,calibration,selectedCalibrationN:selectedCal.length,
      selectedBothOutcomes:true,selectedBrier:scored.brier!,qualified:true,economicQuotesVerified:true};
  }
  return {...base,stages:stageReports,artifacts,reason:"Final test evaluated; artifacts remain shadow-only and require manual review. No automatic promotion."};
}
export async function runTwoStageLearning(interval:5|15,now=Date.now(),db:LockDb=researchPool){
  const result=await db.query(`SELECT r.*,l.outcome,l.first_verified_at,
    coalesce(l.label_status='verified' AND NOT l.settlement_disputed AND l.settled_at>r.expiry_ms AND
      l.settled_at<=$3 AND l.settle_price>0 AND l.settle_price<'Infinity'::float8 AND l.settlement_anchor_price>0 AND
      l.settlement_anchor_price<'Infinity'::float8 AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
      AND ((upper(l.outcome)='UP' AND l.settle_price>=l.settlement_anchor_price) OR
      (upper(l.outcome)='DOWN' AND l.settle_price<l.settlement_anchor_price)),false) AS verified,
    coalesce((SELECT jsonb_agg(o.input ORDER BY o.received_at_ms,o.observation_id) FROM waterx_two_stage_observations o
      WHERE o.network=r.network AND o.market_id=r.market_id AND o.round_id=r.round_id AND o.interval_minutes=r.interval_minutes
      AND o.strategy_version=r.strategy_version),'[]'::jsonb) AS observations
    FROM waterx_two_stage_rounds r LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=r.interval_minutes
      AND l.round_id=r.round_id AND l.start_ms=r.start_ms AND l.expiry_ms=r.expiry_ms
    WHERE r.strategy_version=$1 AND r.interval_minutes=$2 AND r.capture_mode='PROSPECTIVE'
      AND r.expiry_ms<$3 AND r.start_ms>=$3-14*86400000 ORDER BY r.start_ms`,
    [TWO_STAGE_STRATEGY,interval,now]);
  const rows=result.rows.map(r=>({marketId:String(r.market_id),roundId:String(r.round_id),intervalMinutes:interval,
    startMs:Number(r.start_ms),expiryMs:Number(r.expiry_ms),observations:r.observations as EventObservation[],
    outcome:String(r.outcome).toUpperCase() as "UP"|"DOWN",verified:r.verified===true,
    labelAvailableAtMs:r.first_verified_at==null?NaN:new Date(String(r.first_verified_at)).getTime()}));
  const report=trainTwoStage(rows,interval,now);
  await db.query(`INSERT INTO waterx_two_stage_training(id,interval_minutes,created_at_ms,dataset_digest,report)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(interval_minutes,dataset_digest) DO NOTHING`,
    [randomUUID(),interval,now,report.datasetDigest,JSON.stringify(report)]);
  return report;
}
