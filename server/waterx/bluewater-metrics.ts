import type { BluewaterMetrics, BluewaterComparison } from "../../shared/bluewater-research";
export type MatchedPoint={key:string;artifactId:string;modelFamily:BluewaterComparison["modelFamily"];
  probability:number;baseline:number;outcome:"UP"|"DOWN";decisionAtMs:number};
export function metrics(rows:{probability:number;outcome:"UP"|"DOWN"}[]):BluewaterMetrics{
  const bins=Array.from({length:10},(_,i)=>({lower:i/10,upper:(i+1)/10,n:0,meanProbability:0,observedUpRate:0}));
  if(!rows.length)return {n:0,brier:null,logLoss:null,accuracy:null,predictedUpRate:null,observedUpRate:null,highConfidenceErrors:0,calibration:[]};
  let b=0,ll=0,correct=0,pUp=0,up=0,errors=0;
  for(const row of rows){const p=row.probability,y=row.outcome==="UP"?1:0;
    if(!Number.isFinite(p)||p<0||p>1)throw new Error("Invalid scoring probability");
    b+=(p-y)**2;ll-=Math.log(Math.max(1e-10,Math.min(1-1e-10,y?p:1-p)));
    const hit=(p>=.5)===(y===1);correct+=hit?1:0;pUp+=p>=.5?1:0;up+=y;
    errors+=!hit&&Math.max(p,1-p)>=.9?1:0;
    const bin=bins[Math.min(9,Math.floor(p*10))];bin.n++;bin.meanProbability+=p;bin.observedUpRate+=y;
  }
  return {n:rows.length,brier:b/rows.length,logLoss:ll/rows.length,accuracy:correct/rows.length,
    predictedUpRate:pUp/rows.length,observedUpRate:up/rows.length,highConfidenceErrors:errors,
    calibration:bins.filter(b=>b.n).map(b=>({...b,meanProbability:b.meanProbability/b.n,observedUpRate:b.observedUpRate/b.n}))};
}
export function paired(rows:MatchedPoint[],artifactId:string):BluewaterComparison{
  const selected=rows.filter(r=>r.artifactId===artifactId);
  const d=selected.map(r=>{const y=r.outcome==="UP"?1:0;return (r.probability-y)**2-(r.baseline-y)**2;});
  const mean=d.length?d.reduce((a,b)=>a+b,0)/d.length:0;
  const se=d.length>1?Math.sqrt(d.reduce((a,b)=>a+(b-mean)**2,0)/(d.length-1)/d.length):null;
  return {artifactId,modelFamily:selected[0]?.modelFamily??"platt_waterx",matchedN:selected.length,
    candidate:metrics(selected),baseline:metrics(selected.map(r=>({probability:r.baseline,outcome:r.outcome}))),
    pairedBrierDifference:se===null?null:{mean,lower95:mean-1.96*se,upper95:mean+1.96*se}};
}
export function compareMatched(rows:MatchedPoint[],ids:string[]){
  const byId=ids.map(id=>new Map(rows.filter(r=>r.artifactId===id).map(r=>[r.key,r])));
  const keys=byId[0]?Array.from(byId[0].keys()).filter(k=>byId.every(m=>m.has(k))):[];
  const common=byId.flatMap(m=>keys.map(k=>m.get(k)!));
  return {matchedN:keys.length,comparisons:ids.map(id=>paired(common,id)),
    note:"Exact same round/horizon/feature-snapshot cohort; descriptive, not causal."};
}
export function promotionGate(input:{interval:5|15;comparison:BluewaterComparison;spanMs:number;
  chronologicalEligible:boolean;calibrated:boolean;integrityIssues:string[];championComparison?:BluewaterComparison|null;hasChampion:boolean}){
  const reasons=[...input.integrityIssues];
  if(!input.chronologicalEligible)reasons.push("Chronological training evidence is insufficient.");
  if(!input.calibrated)reasons.push("Qualified calibration evidence is absent.");
  if(input.comparison.matchedN<90)reasons.push("Need at least 90 prospective matched primary rounds.");
  if(input.spanMs<(input.interval===5?48*3600000:7*86400000))reasons.push("Prospective matched history span is insufficient.");
  if(!input.comparison.pairedBrierDifference||input.comparison.pairedBrierDifference.upper95>=0)
    reasons.push("Upper 95% paired Brier interval must be below zero versus the same-time WaterX control.");
  if(input.hasChampion&&(!input.championComparison||input.championComparison.matchedN<90||
    !input.championComparison.pairedBrierDifference||input.championComparison.pairedBrierDifference.upper95>=0))
    reasons.push("Sufficient matched evidence of improvement against the current champion is absent.");
  const sparse=input.comparison.candidate.calibration.filter(b=>b.n<20);
  if(!input.comparison.candidate.calibration.length||sparse.length)reasons.push("Every occupied prospective reliability bin needs at least 20 observations.");
  return {eligible:!reasons.length,automatic:false as const,manualApprovalRequired:true,
    criteria:"Conservative development gate v1: >=90 matched primary rounds, interval history minimum, each occupied bin >=20, chronological qualified calibration and upper95 paired Brier <0 against baseline and any active champion; no unresolved integrity issues.",
    reasons,comparison:input.comparison,championComparison:input.championComparison??null,spanMs:input.spanMs};
}