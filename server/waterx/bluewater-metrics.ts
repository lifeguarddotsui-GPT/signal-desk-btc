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
/** Day-blocked paired model-vs-market error uncertainty.
 * Adjacent five-minute observations are correlated; a round-level iid SE
 * falsely acts as if many closely spaced predictions were independent.
 * At least 7 distinct UTC date blocks are needed even to report this
 * conservative screening interval. It is not a profit-confidence interval.
 */
export function paired(rows:MatchedPoint[],artifactId:string):BluewaterComparison{
  const selected=rows.filter(r=>r.artifactId===artifactId &&
    Number.isFinite(r.decisionAtMs) && Number.isFinite(r.probability) &&
    Number.isFinite(r.baseline) && r.probability>=0 && r.probability<=1 &&
    r.baseline>=0 && r.baseline<=1);
  const days=new Map<number,{sum:number;n:number}>();
  for(const row of selected){
    const y=row.outcome==="UP"?1:0;
    const delta=(row.probability-y)**2-(row.baseline-y)**2;
    const day=Math.floor(row.decisionAtMs/86_400_000);
    const b=days.get(day)??{sum:0,n:0};b.sum+=delta;b.n++;days.set(day,b);
  }
  const blockMeans=Array.from(days.values()).map(x=>x.sum/x.n);
  const mean=blockMeans.length?blockMeans.reduce((a,b)=>a+b,0)/blockMeans.length:0;
  const variance=blockMeans.length>1?blockMeans.reduce((a,b)=>a+(b-mean)**2,0)/(blockMeans.length-1):0;
  // t critical at df=6, conservative for >=7 days (higher df -> smaller).
  const margin=blockMeans.length>=7 ? 2.446912*Math.sqrt(variance/blockMeans.length) : null;
  return {artifactId,modelFamily:selected[0]?.modelFamily??"platt_waterx",matchedN:selected.length,
    candidate:metrics(selected),baseline:metrics(selected.map(r=>({probability:r.baseline,outcome:r.outcome}))),
    uncertaintyDayBlocks:blockMeans.length,
    pairedBrierDifference:margin===null?null:{mean,lower95:mean-margin,upper95:mean+margin}};
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
  if(input.spanMs<7*86400000)reasons.push("Prospective matched history span is insufficient.");
  if((input.comparison.uncertaintyDayBlocks??0)<7)
    reasons.push("At least seven distinct UTC daily blocks are required for correlated-round uncertainty.");
  if(!input.comparison.pairedBrierDifference||input.comparison.pairedBrierDifference.upper95>=0)
    reasons.push("Upper 95% paired Brier interval must be below zero versus the same-time WaterX control.");
  if(input.hasChampion&&(!input.championComparison||input.championComparison.matchedN<90||
    !input.championComparison.pairedBrierDifference||input.championComparison.pairedBrierDifference.upper95>=0))
    reasons.push("Sufficient matched evidence of improvement against the current champion is absent.");
  const sparse=input.comparison.candidate.calibration.filter(b=>b.n<20);
  if(!input.comparison.candidate.calibration.length||sparse.length)reasons.push("Every occupied prospective reliability bin needs at least 20 observations.");
  return {eligible:!reasons.length,automatic:false as const,manualApprovalRequired:true,
    criteria:"Conservative development gate v2: >=90 matched primary rounds over at least 7 days and 7 UTC blocks, each occupied bin >=20, qualified chronological calibration and negative upper95 day-blocked paired Brier versus baseline and champion; no unresolved integrity issues. This is not a profitability test.",
    reasons,comparison:input.comparison,championComparison:input.championComparison??null,spanMs:input.spanMs};
}