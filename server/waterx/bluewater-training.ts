import { fitLogistic } from "./research-training-model";
import { digest, FEATURE_NAMES, FEATURE_SCHEMA, sigmoid, logit, validateFeatureSnapshot, type FeatureSnapshot, type ModelArtifact } from "./bluewater-fast";
import { metrics } from "./bluewater-metrics";
export type NumericTrainingRow={snapshot:FeatureSnapshot;outcome:"UP"|"DOWN";labelAvailableAtMs:number;settledAtMs:number};
export function trainNumericChallenger(interval:5|15,rows:NumericTrainingRow[],names:string[],now:number,
  family:"rich_logistic"|"rich_logistic_no_market"="rich_logistic"){
  if(!names.length||new Set(names).size!==names.length||names.some(n=>!(FEATURE_NAMES as readonly string[]).includes(n)))
    throw new Error("Unsupported feature set");
  const keys=rows.map(r=>r.snapshot.roundId),duplicates=new Set(keys.filter((k,i)=>keys.indexOf(k)!==i));
  const valid=rows.filter(r=>{try{validateFeatureSnapshot(r.snapshot);}catch{return false;}
    return !duplicates.has(r.snapshot.roundId)&&r.snapshot.intervalMinutes===interval&&["UP","DOWN"].includes(r.outcome)&&
    r.snapshot.decisionAtMs<r.snapshot.expiryMs&&r.settledAtMs>r.snapshot.expiryMs&&
    r.labelAvailableAtMs>=r.settledAtMs&&r.labelAvailableAtMs<=now&&
    names.every(n=>r.snapshot.values[n]!==null&&Number.isFinite(r.snapshot.values[n]));})
    .sort((a,b)=>a.snapshot.startMs-b.snapshot.startMs||a.snapshot.roundId.localeCompare(b.snapshot.roundId));
  const fingerprint=digest(valid.map(r=>({snapshotDigest:r.snapshot.digest,outcome:r.outcome,labelAvailableAtMs:r.labelAvailableAtMs})));
  const trainEnd=Math.floor(valid.length*.6),calEnd=Math.floor(valid.length*.8),calStart=valid[trainEnd]?.snapshot.decisionAtMs,
    testStart=valid[calEnd]?.snapshot.decisionAtMs,embargo=interval*60000;
  const training=valid.slice(0,trainEnd).filter(r=>calStart!==undefined&&r.labelAvailableAtMs<=calStart-embargo);
  const calibration=valid.slice(trainEnd,calEnd).filter(r=>testStart!==undefined&&r.labelAvailableAtMs<=testStart-embargo);
  const test=valid.slice(calEnd),span=valid.length>1?valid.at(-1)!.snapshot.startMs-valid[0].snapshot.startMs:0;
  const reasons:string[]=[];
  if(valid.length<90)reasons.push(`Need 90 eligible unique records; found ${valid.length}.`);
  if(span<(interval===5?48*3600000:7*86400000))reasons.push("Insufficient chronological history span.");
  for(const [name,part,minimum] of [["training",training,40],["calibration",calibration,20],["test",test,20]] as const){
    if(part.length<minimum)reasons.push(`${name} needs ${minimum} post-embargo records; found ${part.length}.`);
    if(new Set(part.map(r=>r.outcome)).size<2)reasons.push(`${name} needs both outcomes.`);
  }
  const split={training:training.length,calibration:calibration.length,test:test.length,
    embargoExcluded:valid.length-training.length-calibration.length-test.length,
    trainThroughMs:training.at(-1)?.snapshot.decisionAtMs??null,calibrationFromMs:calStart??null,testFromMs:testStart??null};
  const base={datasetFingerprint:fingerprint,selectedCount:rows.length,eligibleCount:valid.length,spanMs:span,split,reasons};
  if(reasons.length)return {...base,status:"INSUFFICIENT",artifact:null,testMetrics:null,testKeys:[] as string[]};
  const vectors=(r:NumericTrainingRow)=>names.map(n=>r.snapshot.values[n]!);
  const means=names.map((_,i)=>training.reduce((s,r)=>s+vectors(r)[i],0)/training.length);
  const scales=names.map((_,i)=>Math.sqrt(training.reduce((s,r)=>s+(vectors(r)[i]-means[i])**2,0)/training.length)||1);
  const scaled=(r:NumericTrainingRow)=>vectors(r).map((v,i)=>(v-means[i])/scales[i]);
  const y=(r:NumericTrainingRow)=>r.outcome==="UP"?1:0;
  const fit=fitLogistic(training.map(scaled),training.map(y),.1,1000);
  const raw=(r:NumericTrainingRow)=>sigmoid(fit.intercept+scaled(r).reduce((s,v,i)=>s+v*fit.coefficients[i],0));
  const cal=fitLogistic(calibration.map(r=>[logit(raw(r))]),calibration.map(y),.1,600);
  const p=(r:NumericTrainingRow)=>sigmoid(cal.intercept+cal.coefficients[0]*logit(raw(r)));
  const testMetrics=metrics(test.map(r=>({probability:p(r),outcome:r.outcome})));
  const body:Omit<ModelArtifact,"id"|"artifactDigest">={formatVersion:"bluewater-numeric-v1",intervalMinutes:interval,family,
    version:`${family}-${fingerprint.slice(0,16)}-${digest(names).slice(0,8)}`,featureSchema:FEATURE_SCHEMA,
    featureNames:names,fittedAtMs:Date.now(),evidenceThroughMs:Math.max(...valid.map(r=>r.labelAvailableAtMs)),
    datasetFingerprint:fingerprint,calibration:{slope:cal.coefficients[0],intercept:cal.intercept},
    parameters:{means,scales,coefficients:fit.coefficients,intercept:fit.intercept},
    protocol:{eligible:true,records:valid.length,spanMs:span,training:training.length,calibration:calibration.length,test:test.length},
    dateRange:{fromMs:valid[0].snapshot.startMs,throughMs:valid.at(-1)!.snapshot.expiryMs},partitions:split,
    hyperparameters:{ridge:.1,iterations:1000,calibrationIterations:600,protocol:"chronological-60-20-20-label-embargo-v1"},
    metrics:testMetrics};
  const hash=digest(body);
  return {...base,status:"EVALUATED",artifact:{...body,id:hash,artifactDigest:hash},
    testMetrics,testKeys:test.map(r=>r.snapshot.roundId)};
}