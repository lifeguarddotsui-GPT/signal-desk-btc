import {createHash,randomUUID} from "node:crypto";
import {eventPartition,type EventTrajectory} from "./event-lock-learning";
import {fitLogistic} from "./research-training-model";
import {sigmoid,logit} from "./bluewater-fast";
import {metrics} from "./bluewater-metrics";
import {eventQualification,type EventObservation} from "../../shared/event-lock";
import {economicEvidenceFromFeatures} from "../../shared/lock-economics";
import {TWO_STAGE_FEATURES,TWO_STAGE_STRATEGY,type StageInput,type LockStage} from "../../shared/two-stage";
import {stageModelFeatures,assessStage,type LearnedStagePolicy} from "./two-stage-policy";
import {STAGE_TRAINING_PROTOCOL} from "./two-stage-registry";
import {EARLY_CANDIDATES,EARLY_CANDIDATE_PROTOCOL} from "./early-policy";
import type {StageLock} from "../../shared/two-stage";
import type {PricePoint} from "../../shared/price-area";
import {researchPool} from "./research-store";
import type {LockDb} from "./lock-store";
export type StageTrajectory=EventTrajectory&{marketId:string;priceObservations?:PricePoint[]};
type Trajectory=StageTrajectory;
type Point={input:StageInput;x:number[];observation:EventObservation};
type Numeric=ReturnType<typeof fitLogistic>;
const probability=(model:Numeric,x:number[])=>sigmoid(model.intercept+x.reduce((s,v,i)=>s+v*model.coefficients[i],0));
const sample=(points:Point[])=>points.length<=12?points:Array.from({length:12},(_,i)=>points[Math.floor(i*(points.length-1)/11)]);
function points(r:Trajectory){
  const out:Point[]=[];
  for(let i=0;i<r.observations.length;i++){
    const observation=r.observations[i],input:StageInput={...r,observations:r.observations.slice(0,i+1),nowMs:observation.availableAtMs};
    const x=stageModelFeatures(input);
     if(x)out.push({input,x,observation});
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
     if(!r.verified||!["UP","DOWN"].includes(r.outcome)||!Number.isFinite(r.labelAvailableAtMs)||
       r.labelAvailableAtMs<=r.expiryMs||r.labelAvailableAtMs>now||
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
   const digest=createHash("sha256").update(JSON.stringify({protocol:STAGE_TRAINING_PROTOCOL,strategy:TWO_STAGE_STRATEGY,
     interval,partitionDay:Math.floor(now/86400000),rows:rows.map(r=>({round:r.roundId,market:r.marketId,
     start:r.startMs,outcome:r.outcome,available:r.labelAvailableAtMs,observations:r.observations,
     prices:r.priceObservations??[]}))})).digest("hex");
   const base={protocol:STAGE_TRAINING_PROTOCOL,interval,counts,deficits,excluded,
    trajectoryN:rows.length,fullSizeQuotePoints,datasetDigest:digest,
    featureVersion:TWO_STAGE_FEATURES,positiveModelEdgeAuthorized:false,automaticPromotion:false,
    stages:{EARLY:{status:"NOT_QUALIFIED"},CONFIRMATION:{status:"NOT_QUALIFIED"}},
    ablations:["MARKET_ODDS_ONLY","EXISTING_QUALIFICATION","EVENT_UNCHANGED","EVENT_PRICE_AREA","TWO_STAGE"],
     forecastRequiresExecutableQuotes:false,selectorParity:true,
     preregisteredEarlyCandidates:evaluateEarlyCandidates(rows,now),
     reason:"Require 60 whole verified trajectories in each disjoint partition, both outcomes and stage-selected calibration. Forecast qualification is separate from economic/execution qualification."};
   if(Object.values(partitions).some(r=>r.length<60||!both(r)))return base;
  const fitted=partitions.TRAIN.flatMap(r=>sample(points(r)).map(p=>({x:p.x,y:r.outcome==="UP"?1:0})));
  if(fitted.length<60)return {...base,reason:"Too few compatible accumulated-price feature observations."};
  const outcome=fitLogistic(fitted.map(p=>p.x),fitted.map(p=>p.y),.01,500);
  const strength=(p:Point)=>{const up=probability(outcome,p.x);return Math.max(up,1-up);};
  const candidates=partitions.POLICY.flatMap(r=>points(r).map(strength)).sort((a,b)=>a-b);
  const thresholds=Array.from(new Set([.5,...Array.from({length:9},(_,i)=>candidates[Math.floor((i+1)*candidates.length/10)])])).filter(Number.isFinite);
   const simulationPolicy=(threshold:number,stage:LockStage,calibration:Numeric={intercept:0,coefficients:[1]} as Numeric):LearnedStagePolicy=>({
     version:"VALIDATION_REPLAY_NOT_LIVE",stage,interval,modelVersion:"VALIDATION_REPLAY_NOT_LIVE",
     trainedBeforeMs:Math.min(...rows.map(r=>r.startMs))-1,featureVersion:TWO_STAGE_FEATURES,
     minimumStrength:threshold,outcome,calibration,selectedCalibrationN:60,
     selectedBothOutcomes:true,selectedBrier:0,qualified:true,economicQuotesVerified:false});
   const select=(r:Trajectory,threshold:number,stage:LockStage,calibration?:Numeric)=>{
     const early=stage==="CONFIRMATION"?replayRuleEarly(r):null;
     const policy=simulationPolicy(threshold,stage,calibration);
    for(const p of points(r)){
       const a=assessStage(p.input,stage,early&&early.evidenceCutoffMs<=p.input.nowMs?early:null,policy);
       if(!a.eligible||!a.side||a.probabilityUp==null||!a.economics)continue;
       const up=a.probabilityUp,side=a.side,economic=a.economics;
       const profit=economic.kind==="VERIFIED_QUOTE"&&economic.netProfitIfCorrectUsd!=null&&economic.lossIfIncorrectUsd!=null?
         side===r.outcome?economic.netProfitIfCorrectUsd:-economic.lossIfIncorrectUsd:null;
      return {p,up,profit,side,economic};
    }return null;
  };
  const artifacts:Partial<Record<LockStage,LearnedStagePolicy>>={},stageReports:Record<string,unknown>={};
  for(const stage of ["EARLY","CONFIRMATION"] as const){
     const choices=thresholds.map(threshold=>{
      const selected=partitions.POLICY.flatMap(r=>{
         const s=select(r,threshold,stage);return s?[{...s,outcome:r.outcome}]:[];
      });
       return {threshold,selected,utility:selected.length?
         selected.reduce((s,p)=>s+(p.side===p.outcome?1:-1),0)/partitions.POLICY.length:-Infinity};
    }).filter(c=>c.selected.length>=60).sort((a,b)=>b.utility-a.utility||a.threshold-b.threshold);
     const chosen=choices[0];if(!chosen){stageReports[stage]={status:"NOT_QUALIFIED",reason:"Insufficient stage-selected POLICY forecasts."};continue;}
    const selectedCal=partitions.CALIBRATION.flatMap(r=>{
       const s=select(r,chosen.threshold,stage);return s?[{...s,outcome:r.outcome}]:[];
    });
    if(selectedCal.length<60||new Set(selectedCal.map(p=>p.outcome)).size<2){
      stageReports[stage]={status:"NOT_QUALIFIED",selectedCalibrationN:selectedCal.length,reason:"Stage-selected calibration insufficient."};continue;
    }
    const calibration=fitLogistic(selectedCal.map(p=>[logit(p.up)]),selectedCal.map(p=>p.outcome==="UP"?1:0),.01,500);
     const finalCal=partitions.CALIBRATION.flatMap(r=>{
       const s=select(r,chosen.threshold,stage,calibration);return s?[s]:[];
     });
     if(finalCal.length!==selectedCal.length||finalCal.some((p,i)=>p.p.observation.id!==selectedCal[i].p.observation.id)){
       stageReports[stage]={status:"NOT_QUALIFIED",reason:"Calibration changes the selected subset; live-selector parity fails.",
         selectedCalibrationN:selectedCal.length};continue;
     }
    const test=partitions.TEST.flatMap(r=>{
       const s=select(r,chosen.threshold,stage,calibration);
       return s?[{...s,outcome:r.outcome,calibrated:s.up}]:[];
    });
    const scored=metrics(test.map(p=>({probability:p.calibrated,outcome:p.outcome})));
    const baseline=metrics(test.map(p=>({probability:p.p.observation.probabilityUp,outcome:p.outcome})));
     const economicTest=test.filter((p):p is typeof p&{profit:number}=>p.profit!=null);
     const mean=economicTest.length?economicTest.reduce((s,p)=>s+p.profit,0)/economicTest.length:null;
     const variance=economicTest.length>1?economicTest.reduce((s,p)=>s+(p.profit-mean!)**2,0)/(economicTest.length-1):Infinity;
     const lower95=mean==null?null:mean-1.96*Math.sqrt(variance/Math.max(1,economicTest.length));
    const qualified=test.length>=60&&new Set(test.map(p=>p.outcome)).size===2&&scored.brier!=null&&baseline.brier!=null&&
       scored.brier<baseline.brier&&scored.brier<.25;
    stageReports[stage]={status:qualified?"QUALIFIED_SHADOW_ONLY":"NOT_QUALIFIED",threshold:chosen.threshold,
       selectedCalibrationN:selectedCal.length,test:scored,matchedMarketBaseline:baseline,
       economicQuoteN:economicTest.length,meanNetUsd:mean,lower95NetUsd:lower95,
       economicQualification:lower95!=null&&lower95>0&&economicTest.length===test.length?"QUALIFIED_SHADOW_ESTIMATE":"NOT_QUALIFIED",
       forecastQualificationIndependentOfExecution:true};
    if(qualified)artifacts[stage]={version:`two-stage-${interval}-${stage}-${digest.slice(0,16)}`,stage,interval,
      modelVersion:`area-outcome-${interval}-${digest.slice(0,16)}`,trainedBeforeMs:now,featureVersion:TWO_STAGE_FEATURES,
      minimumStrength:chosen.threshold,outcome,calibration,selectedCalibrationN:selectedCal.length,
       selectedBothOutcomes:true,selectedBrier:scored.brier!,qualified:true,
       economicQuotesVerified:economicTest.length===test.length};
  }
  return {...base,stages:stageReports,artifacts,reason:"Final test evaluated; artifacts remain shadow-only and require manual review. No automatic promotion."};
}
function replayRuleEarly(r:Trajectory,version?:string):StageLock|null{
  for(let i=0;i<r.observations.length;i++){
    const latest=r.observations[i],input:StageInput={...r,earlyPolicyVersion:version,
      observations:r.observations.slice(0,i+1),nowMs:latest.availableAtMs};
    const a=assessStage(input,"EARLY",null);
    if(a.eligible&&a.side)return {stage:"EARLY",side:a.side,probabilityUp:a.probabilityUp,
      observationIds:input.observations.map(o=>o.id),evidenceCutoffMs:input.nowMs,
      elapsedMs:input.nowMs-r.startMs,features:{...a.priceFeatures,marketProbabilityUp:latest.probabilityUp},
      economics:a.economics,calibrationStatus:"UNQUALIFIED",modelVersion:null} as StageLock;
  }return null;
}
/** All six candidates are fixed before labels are read; only POLICY can choose
 * a recommendation. TEST is reported once, never used to choose another winner. */
export function evaluateEarlyCandidates(rows:Trajectory[],now:number){
  const report=(data:Trajectory[],version:string)=>{
    const selected=data.flatMap(r=>{const lock=replayRuleEarly(r,version);return lock?[{r,lock}]:[];});
    const times=selected.map(s=>s.lock.elapsedMs).sort((a,b)=>a-b),correct=selected.filter(s=>s.lock.side===s.r.outcome).length;
    return {cohortN:data.length,locks:selected.length,coverage:data.length?selected.length/data.length:null,
      correct,incorrect:selected.length-correct,scoredN:selected.length,accuracy:selected.length?correct/selected.length:null,
      marketDerivedUncalibrated:true,calibration:null,
      brier:metrics(selected.map(s=>({probability:s.lock.probabilityUp,outcome:s.r.outcome}))).brier,
      medianElapsedMs:times.length?times[Math.ceil(times.length/2)-1]:null,
      p90ElapsedMs:times.length?times[Math.ceil(times.length*.9)-1]:null,
      earlyWindows:(data[0]?.intervalMinutes===15?[60,120,180,300]:[30,60,90,120]).map(seconds=>({
        seconds,locks:selected.filter(s=>s.lock.elapsedMs<=seconds*1000).length,
        rate:data.length?selected.filter(s=>s.lock.elapsedMs<=seconds*1000).length/data.length:null})),
      entryEconomics:{indicative:selected.filter(s=>s.lock.economics.kind==="INDICATIVE").length,
        belowPreferred:selected.filter(s=>(s.lock.economics.totalReturnedIfCorrectUsd??0)<6).length,
        missingReturn:selected.filter(s=>s.lock.economics.totalReturnedIfCorrectUsd==null).length,
        verifiedQuotes:selected.filter(s=>s.lock.economics.kind==="VERIFIED_QUOTE").length},
      utility:data.length?(2*correct-selected.length)/data.length:null};
  };
  const policy=rows.filter(r=>eventPartition(r,now)==="POLICY"),test=rows.filter(r=>eventPartition(r,now)==="TEST");
  const candidates=EARLY_CANDIDATES.map(p=>({version:p.version,POLICY:report(policy,p.version),TEST:report(test,p.version)}));
  const eligible=candidates.filter(c=>c.POLICY.scoredN>=60&&c.POLICY.correct>0&&c.POLICY.incorrect>0);
  const selected=eligible.sort((a,b)=>(b.POLICY.utility??-Infinity)-(a.POLICY.utility??-Infinity))[0];
  return {protocol:EARLY_CANDIDATE_PROTOCOL,candidates,selectedOnPolicy:selected?.version??null,
    evidenceKind:"RETROSPECTIVE_WHOLE_TRAJECTORY_REPLAY_NOT_PROSPECTIVE_LOCKS",
    automaticActivation:false,reason:selected?"POLICY-selected challenger requires review of untouched TEST and prospective evidence":
      "Insufficient chronological POLICY evidence; no candidate selected or promoted"};
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
       AND o.strategy_version=r.strategy_version),'[]'::jsonb) AS observations,
     coalesce((SELECT jsonb_agg(p.point ORDER BY p.source_at_ms,p.point_id) FROM waterx_two_stage_prices p
       WHERE p.network=r.network AND p.market_id=r.market_id AND p.round_id=r.round_id
       AND p.interval_minutes=r.interval_minutes AND p.strategy_version=r.strategy_version),'[]'::jsonb) AS prices
    FROM waterx_two_stage_rounds r LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=r.interval_minutes
      AND l.round_id=r.round_id AND l.start_ms=r.start_ms AND l.expiry_ms=r.expiry_ms
    WHERE r.strategy_version=$1 AND r.interval_minutes=$2 AND r.capture_mode='PROSPECTIVE'
      AND r.expiry_ms<$3 AND r.start_ms>=$3-14*86400000 ORDER BY r.start_ms`,
    [TWO_STAGE_STRATEGY,interval,now]);
  const rows=result.rows.map(r=>({marketId:String(r.market_id),roundId:String(r.round_id),intervalMinutes:interval,
     startMs:Number(r.start_ms),expiryMs:Number(r.expiry_ms),observations:r.observations as EventObservation[],
     priceObservations:r.prices as PricePoint[],
    outcome:String(r.outcome).toUpperCase() as "UP"|"DOWN",verified:r.verified===true,
    labelAvailableAtMs:r.first_verified_at==null?NaN:new Date(String(r.first_verified_at)).getTime()}));
  const report=trainTwoStage(rows,interval,now);
  await db.query(`INSERT INTO waterx_two_stage_training(id,interval_minutes,created_at_ms,dataset_digest,report)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(interval_minutes,dataset_digest) DO NOTHING`,
    [randomUUID(),interval,now,report.datasetDigest,JSON.stringify(report)]);
  return report;
}
