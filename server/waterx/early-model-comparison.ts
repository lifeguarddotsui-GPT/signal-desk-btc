import {createHash} from "node:crypto";
import {earlyFeatureVector,inferEarlyModel,EARLY_FEATURE_SCHEMA,type EarlyLinearModel} from "../../shared/early-features";
import {fitLogistic} from "./research-training-model";
import {metrics} from "./bluewater-metrics";
import {logit,sigmoid} from "./bluewater-fast";
import {digestEarlySnapshot} from "./early-horizons";
import type {EarlyTrainingRow} from "./early-training";

const day=86400000;
export function earlyPartitions(now:number){
  const cutoff=Math.floor(now/day)*day;
  return {from:cutoff-14*day,trainEnd:cutoff-4*day,calibrationEnd:cutoff-3*day,policyEnd:cutoff-2*day,testEnd:cutoff};
}
export function partitionEarlyRow(r:EarlyTrainingRow,now:number){
  const p=earlyPartitions(now),blockStart=Math.floor(r.startMs/900000)*900000,blockEnd=Math.ceil(r.expiryMs/900000)*900000;
  if(r.startMs<p.from||r.labelAvailableAtMs>now||!Number.isFinite(r.labelAvailableAtMs))return "EXCLUDED";
  if(blockEnd<=p.trainEnd&&r.labelAvailableAtMs<=p.trainEnd)return "TRAIN";
  if(blockStart>=p.trainEnd&&blockEnd<=p.calibrationEnd&&r.labelAvailableAtMs<=p.calibrationEnd)return "CALIBRATION";
  if(blockStart>=p.calibrationEnd&&blockEnd<=p.policyEnd&&r.labelAvailableAtMs<=p.policyEnd)return "POLICY";
  if(blockStart>=p.policyEnd&&blockEnd<=p.testEnd)return "TEST";
  return "EXCLUDED";
}
function independentRows(rows:EarlyTrainingRow[],interval:5|15,now:number){
  const groups=new Map<string,EarlyTrainingRow[]>();
  for(const r of rows){
    if(r.interval!==interval||!Number.isFinite(r.probability)||r.probability<0||r.probability>1||
      partitionEarlyRow(r,now)==="EXCLUDED")continue;
    const key=`${r.roundId}:${r.startMs}:${r.expiryMs}`,list=groups.get(key)??[];list.push(r);groups.set(key,list);
  }
  return Array.from(groups.entries()).flatMap(([key,rs])=>{
    if(new Set(rs.map(r=>r.horizon)).size!==rs.length||new Set(rs.map(r=>r.outcome)).size!==1)return [];
    rs.sort((a,b)=>a.horizon-b.horizon);
    return [rs[createHash("sha256").update(key).digest().readUInt32BE(0)%rs.length]];
  }).sort((a,b)=>a.startMs-b.startMs||a.roundId.localeCompare(b.roundId));
}
function fitScaled(vectors:number[][],labels:number[]):EarlyLinearModel{
  const means=vectors[0].map((_,i)=>vectors.reduce((s,v)=>s+v[i],0)/vectors.length);
  const scales=means.map((m,i)=>Math.max(1e-6,Math.sqrt(vectors.reduce((s,v)=>s+(v[i]-m)**2,0)/vectors.length)));
  const scaled=vectors.map(v=>v.map((x,i)=>(x-means[i])/scales[i]));
  return {...fitLogistic(scaled,labels,.25,400),means,scales};
}
/** Fixed paired comparison, four chronological partitions, no automatic promotion.
 * All family fits use the exact same round/held-out identities. */
export function compareEarlyModels(rows:EarlyTrainingRow[],interval:5|15,now:number){
  const unique=independentRows(rows,interval,now),part=(name:string)=>unique.filter(r=>partitionEarlyRow(r,now)===name);
  const train=part("TRAIN"),cal=part("CALIBRATION"),policy=part("POLICY"),test=part("TEST");
  const counts={training:train.length,calibration:cal.length,policy:policy.length,test:test.length};
  const base={version:"early-independent-cross-paired-v1",featureSchema:EARLY_FEATURE_SCHEMA,interval,counts,
    partitions:earlyPartitions(now),datasetDigest:digestEarlySnapshot(unique.map(r=>[r.roundId,r.startMs,r.horizon,r.snapshotDigest,r.outcome,r.labelAvailableAtMs])),
    statisticalUnit:"One preregistered hash-selected snapshot per exact round; all snapshots stay in its 15m UTC block",
    promotion:"RETAIN_BASELINE",automaticPromotion:false,prospectiveEvaluation:{status:"NOT_YET_COLLECTED",n:0},
    tradingEconomics:null,executionCutoff:null};
  if(train.length<200||cal.length<60||policy.length<60||test.length<60||
    [train,cal,policy,test].some(rs=>new Set(rs.map(r=>r.outcome)).size<2))
    return {...base,status:"INSUFFICIENT",reason:"Requires 200/60/60/60 independent train/calibration/policy/test rounds, two classes and actual label availability. No confidence invented."};
  const y=(r:EarlyTrainingRow)=>r.outcome==="UP"?1:0;
  const calibrator=fitLogistic(cal.map(r=>[logit(r.probability)]),cal.map(y),.25,400);
  const calibrated=(r:EarlyTrainingRow)=>sigmoid(calibrator.intercept+calibrator.coefficients[0]*logit(r.probability));
  const score=(f:(r:EarlyTrainingRow)=>number)=>metrics(test.map(r=>({probability:f(r),outcome:r.outcome})));
  const fit=(cross:boolean)=>{
    const vector=(r:EarlyTrainingRow)=>earlyFeatureVector(r.probability,r.horizon,interval,r.features??{},cross);
    const model=fitScaled(train.map(vector),train.map(y));
    const raw=(r:EarlyTrainingRow)=>inferEarlyModel(model,vector(r));
    const c=fitLogistic(cal.map(r=>[logit(raw(r))]),cal.map(y),.25,400);
    const probability=(r:EarlyTrainingRow)=>sigmoid(c.intercept+c.coefficients[0]*logit(raw(r)));
    return {model,calibration:c,probability,metrics:score(probability)};
  };
  const independent=fit(false),cross=fit(true),crossCoverage=unique.filter(r=>
    (r.features?.crossInterval as {available?:boolean}|undefined)?.available===true).length/unique.length;
  // Earlier POLICY data chooses threshold; final TEST data is never reused to tune.
  const thresholds=[.70,.74,.78] as const;
  const policyCandidates=thresholds.map(threshold=>{
    const chosen=policy.filter(r=>Math.max(independent.probability(r),1-independent.probability(r))>=threshold);
    const m=metrics(chosen.map(r=>({probability:independent.probability(r),outcome:r.outcome})));
    return {threshold,coverage:chosen.length/policy.length,metrics:m,
      objective:(m.brier??1)+.2*(1-chosen.length/policy.length)};
  }).sort((a,b)=>a.objective-b.objective||a.threshold-b.threshold);
  const diff=dayBlockDifference(test,independent.probability,cross.probability);
  const crossAddedValue=crossCoverage>=.8&&diff.blockN>=8&&diff.upper95!==null&&diff.upper95<0;
  const artifact={featureSchema:EARLY_FEATURE_SCHEMA,interval,trainedAtMs:now,evidenceThroughMs:base.partitions.testEnd,
    independent:{model:independent.model,calibration:independent.calibration},
    crossInterval:{model:cross.model,calibration:cross.calibration},policyThreshold:policyCandidates[0].threshold,
    shadowOnly:true,active:false};
  return {...base,status:"EVALUATED",raw:score(r=>r.probability),calibratedWaterx:score(calibrated),
    independent:independent.metrics,crossInterval:cross.metrics,crossCoverage,
    heldOutRoundIds:test.map(r=>({roundId:r.roundId,startMs:r.startMs})),policyCandidates,
    crossDifference:diff,crossAddedValue,artifact:{...artifact,digest:digestEarlySnapshot(artifact)},
    reason:"Paired offline comparison only. Cross context retained only as a shadow candidate; prospective evidence and full-sequence stopping replay required."};
}
function dayBlockDifference(rows:EarlyTrainingRow[],a:(r:EarlyTrainingRow)=>number,b:(r:EarlyTrainingRow)=>number){
  const blocks=new Map<number,number[]>();
  for(const r of rows){const k=Math.floor(r.startMs/(6*3600000)),ys=blocks.get(k)??[],y=r.outcome==="UP"?1:0;
    ys.push((b(r)-y)**2-(a(r)-y)**2);blocks.set(k,ys);}
  const means=Array.from(blocks.values()).map(rs=>rs.reduce((s,x)=>s+x,0)/rs.length),n=means.length;
  const mean=n?means.reduce((s,x)=>s+x,0)/n:null;
  const se=n>1?Math.sqrt(means.reduce((s,x)=>s+(x-mean!)**2,0)/(n*(n-1))):null;
  return {method:"6h UTC paired Brier block differences; conservative approximate t interval, <8 blocks insufficient",blockN:n,
    meanDifference:mean,lower95:se===null?null:mean!-2.365*se,upper95:se===null?null:mean!+2.365*se};
}
