import {logit,sigmoid} from "./bluewater-fast";
import {earlyHorizons,timedPolicy} from "../../shared/timed-decision";
import {metrics} from "./bluewater-metrics";
import {digestEarlySnapshot} from "./early-horizons";
import type {EarlyTrainingRow} from "./early-training";
import {partitionEarlyRow} from "./early-model-comparison";
type Forecast={horizon:number;artifact:null|{
 parameters:{intercept:number;coefficients:number[]};calibration:{intercept:number;coefficients:number[]}}};
/** Forecast calibration, policy selection and final evaluation are disjoint.
 * One FIRST qualifying gate per round, never the hindsight-best checkpoint. */
export function evaluateEarlyStopping(rows:EarlyTrainingRow[],interval:5|15,forecasts:Forecast[],now:number){
  const day=86400000,cutoff=Math.floor(now/day)*day,trainEnd=cutoff-4*day,calEnd=cutoff-2*day;
  const target=interval===5?60:180,hard=interval*60;
  if(forecasts.some(f=>!f.artifact)||earlyHorizons(interval).some(h=>!forecasts.some(f=>f.horizon===h&&f.artifact)))
    return {status:"INSUFFICIENT",reason:"Every sequential gate needs a trained/calibrated artifact; isolated thresholds are not qualified.",promotion:"RETAIN_BASELINE"};
  const artifacts=new Map(forecasts.map(f=>[f.horizon,f.artifact!]));
  const groups=new Map<string,EarlyTrainingRow[]>();
  for(const r of rows.filter(r=>r.interval===interval&&earlyHorizons(interval).includes(r.horizon)&&
    r.startMs>=cutoff-14*day&&r.expiryMs<=cutoff&&r.labelAvailableAtMs<=now)){
    const key=r.roundId+":"+r.startMs+":"+r.expiryMs;
    const list=groups.get(key)??[];
    list.push(r);
    groups.set(key,list);
  }
  const sequences=Array.from(groups.values()).filter(s=>new Set(s.map(r=>r.horizon)).size===s.length&&
    new Set(s.map(r=>r.outcome)).size===1).map(s=>s.sort((a,b)=>a.horizon-b.horizon));
  const probability=(r:EarlyTrainingRow)=>{
    const a=artifacts.get(r.horizon)!;
    const raw=sigmoid(a.parameters.intercept+a.parameters.coefficients[0]*logit(r.probability)+
      (a.parameters.coefficients[1]??0)*r.horizon/(interval*60));
    return sigmoid(a.calibration.intercept+a.calibration.coefficients[0]*logit(raw));
  };
  const valid=(r:EarlyTrainingRow)=>Number.isFinite(r.probability)&&r.probability>=0&&r.probability<=1;
  const policy=timedPolicy(interval);
  const eligible=(r:EarlyTrainingRow)=>{
    const f=r.features;
    return valid(r)&&r.probability!==.5&&Math.max(r.probability,1-r.probability)>=policy.earlyStrength&&
      !!f&&f.missingProbabilities!==true&&typeof f.sourceAgeMs==="number"&&f.sourceAgeMs>=0&&f.sourceAgeMs<=policy.maxAgeMs&&
      typeof f.sameSideMs==="number"&&f.sameSideMs>=policy.earlyPersistenceMs&&
      typeof f.validObservationCount==="number"&&f.validObservationCount>=policy.minObservations&&
      f.recentReversals===0&&typeof f.probabilityRange==="number"&&
      (f.probabilityRange<=policy.maxRange||f.trendKind==="STRENGTHENING");
  };
  const select=(s:EarlyTrainingRow[],threshold:number)=>s.find(r=>eligible(r)&&earlyHorizons(interval).includes(r.horizon)&&
     earlyHorizons(interval).filter(h=>h<=r.horizon).every(h=>s.some(x=>x.horizon===h))&&
     r.horizon<interval*60&&(probability(r)>.5)===(r.probability>.5)&&
     Math.max(probability(r),1-probability(r))>=threshold);
  const evaluate=(part:EarlyTrainingRow[][],threshold:number)=>{
    const picked=part.flatMap(s=>{const r=select(s,threshold);return r?[r]:[];});
    const forecast=metrics(picked.map(r=>({probability:probability(r),outcome:r.outcome})));
    const sameTimeMarket=metrics(picked.map(r=>({probability:r.probability,outcome:r.outcome})));
    const fixed=part.flatMap(s=>{const r=s.find(r=>r.horizon===target&&valid(r));return r?[r]:[];});
    const fixedTargetMarket=metrics(fixed.map(r=>({probability:r.probability,outcome:r.outcome})));
     const elapsed=picked.map(r=>r.horizon).sort((a,b)=>a-b);
     const quantile=(q:number)=>elapsed.length?elapsed[Math.ceil((elapsed.length-1)*q)]:null;
     const buckets=[interval===5?90:300,interval===5?180:600,interval*60];
     const accuracyByLockTime=buckets.map((end,i)=>{
       const selected=picked.filter(r=>r.horizon>(i?buckets[i-1]:0)&&r.horizon<=end);
       return {afterSeconds:i?buckets[i-1]:0,throughSeconds:end,
         ...metrics(selected.map(r=>({probability:probability(r),outcome:r.outcome})))};
     });
     const blocks=new Map<number,number[]>();
     for(const r of picked){
       const y=r.outcome==="UP"?1:0,k=Math.floor(r.startMs/21600000),v=blocks.get(k)??[];
       v.push((probability(r)-y)**2-(r.probability-y)**2);blocks.set(k,v);
     }
     const means=Array.from(blocks.values()).map(v=>v.reduce((s,x)=>s+x,0)/v.length);
     const mean=means.length?means.reduce((s,x)=>s+x,0)/means.length:null;
     const se=means.length>1?Math.sqrt(means.reduce((s,x)=>s+(x-mean!)**2,0)/(means.length*(means.length-1))):null;
    return {roundN:part.length,decisionN:picked.length,coverage:part.length?picked.length/part.length:null,
       decisions:picked.map(r=>({roundId:r.roundId,startMs:r.startMs,horizon:r.horizon,
         probabilityUp:probability(r),outcome:r.outcome})),
       medianTimeToLockSeconds:quantile(.5),p90TimeToLockSeconds:quantile(.9),p95TimeToLockSeconds:quantile(.95),
       targetWindow:{fromSeconds:interval===5?60:180,toSeconds:interval===5?90:300},
       withinTargetWindowRate:picked.length?picked.filter(r=>r.horizon>=(interval===5?60:180)&&r.horizon<=(interval===5?90:300)).length/picked.length:null,
       lockedByTargetEndRate:part.length?picked.filter(r=>r.horizon<=(interval===5?90:300)).length/part.length:null,
       accuracyByLockTime,
       blockPairedBrier:{method:"6h UTC round blocks; approximate conservative t interval",
         blockN:means.length,mean,lower95:se===null?null:mean!-2.365*se,upper95:se===null?null:mean!+2.365*se},
       unqualifiedGates:part.reduce((n,s)=>n+s.filter(r=>!eligible(r)).length,0),
      missingHorizonDecisions:part.length-picked.length,
      incompletePaths:part.filter(s=>s.length!==earlyHorizons(interval).length).length,
      incompletePathPolicy:"Missing earlier gates prevent first-lock claims. Missing later gates are operational gaps, not grounds to erase an earlier qualified choice. Every captured round stays in the denominator.",
      forecast,sameTimeMarket,fixedTargetMarket,
      fixedTargetCoverage:part.length?fixed.length/part.length:null,
      meanElapsedSeconds:picked.length?picked.reduce((a,r)=>a+r.horizon,0)/picked.length:null,
      meanSecondsBeforeExpiry:picked.length?picked.reduce((a,r)=>a+(r.expiryMs-r.startMs)/1000-r.horizon,0)/picked.length:null,
      quoteAdjustedEconomics:null,durableDeadlineMisses:null,
      limitation:"Capture gaps counted; replay of frozen prospective sequences is not actual commit/submission latency or fill evidence."};
  };
  const calibration=sequences.filter(s=>s.every(r=>partitionEarlyRow(r,now)==="POLICY"));
  const test=sequences.filter(s=>s.every(r=>partitionEarlyRow(r,now)==="TEST"));
  if(calibration.length<60||test.length<60)return {status:"INSUFFICIENT",reason:"Requires 60 distinct policy-selection and untouched test rounds for sequential evaluation.",
    nextEligibility:{policyRounds:Math.max(0,60-calibration.length),testRounds:Math.max(0,60-test.length)},promotion:"RETAIN_BASELINE"};
  const ece=(m:ReturnType<typeof metrics>)=>m.n?m.calibration.reduce((sum,b)=>
    sum+b.n*Math.abs(b.meanProbability-b.observedUpRate),0)/m.n:null;
  const candidates=[.72,.74,.78].map(threshold=>({threshold,...evaluate(calibration,threshold)}));
  const eligibleCandidates=candidates.filter(r=>r.decisionN>=60&&
    (r.coverage??0)>=(r.fixedTargetCoverage??0)-.05&&
    (r.forecast.accuracy??0)>=(r.sameTimeMarket.accuracy??1)&&
    (ece(r.forecast)??1)<=(ece(r.sameTimeMarket)??0)+.03);
  if(!eligibleCandidates.length)return {status:"INSUFFICIENT",reason:"No policy-selection candidate passes 60 decisions, baseline accuracy, calibration and coverage constraints.",
    policyCandidates:candidates,promotion:"RETAIN_BASELINE"};
  // Predeclared calibration objective: Brier + coverage penalty + small time
  // penalty. No held-out outcomes or later per-round information selects a lock.
  const objective=(r:typeof candidates[number])=>(r.forecast.brier??1)+.2*(1-(r.coverage??0))+.02*(r.meanElapsedSeconds??hard)/hard;
  eligibleCandidates.sort((a,b)=>objective(a)-objective(b)||a.threshold-b.threshold);
  const selected=eligibleCandidates[0],heldOut=evaluate(test,selected.threshold);
  const pass=heldOut.decisionN>=60&&(heldOut.coverage??0)>=(heldOut.fixedTargetCoverage??0)-.05&&
    heldOut.forecast.brier!==null&&heldOut.sameTimeMarket.brier!==null&&
    heldOut.forecast.brier<=heldOut.sameTimeMarket.brier&&
    heldOut.forecast.logLoss!==null&&heldOut.sameTimeMarket.logLoss!==null&&
    heldOut.forecast.logLoss<=heldOut.sameTimeMarket.logLoss*1.03&&
    (ece(heldOut.forecast)??1)<=(ece(heldOut.sameTimeMarket)??0)+.03&&
    heldOut.meanElapsedSeconds!==null&&heldOut.meanElapsedSeconds<=target*.9&&
    (heldOut.forecast.accuracy??0)>=(heldOut.sameTimeMarket.accuracy??1)&&
    heldOut.blockPairedBrier.blockN>=8&&heldOut.blockPairedBrier.upper95!==null&&heldOut.blockPairedBrier.upper95<=0;
  const report={status:"EVALUATED",version:"early-full-sequence-shadow-v2",interval,threshold:selected.threshold,
    championComparison:{status:"BASELINE_CHAMPION",method:"Paired same-time WaterX market probability"},
    earlierLockingPolicy:{status:"UNAVAILABLE",reason:"Matched earlier-strategy lock records have not been joined to this current-strategy cohort; fixed-time market control is not an earlier-policy result."},
    policySelectionPartition:"POLICY; disjoint from forecast calibration and untouched TEST",
    selectionSemantics:"Calibrated forecast overlay with unchanged market persistence/stability guards and same-side agreement; independent forecast-side persistence is not inferred.",
    calibrationCandidates:candidates,test:heldOut,heldOutCriteriaPassed:pass,
    criteria:">=60 policy/test decisions; accuracy no worse; coverage decline <=5pp; Brier no worse; log loss <=3% worse; ECE <=3pp worse; >=10% target time gained; >=8 six-hour blocks with upper95 paired Brier <=0",
    promotion:"RETAIN_BASELINE",reason:pass?"Qualified for prospective shadow review only; explicit versioned live promotion still required.":"Speed/quality criteria did not pass; retain deterministic live baseline.",
    repeatedChecks:"One selected decision per distinct round. Chronological day boundaries and label embargo match forecast models.",
    denominator:"Verified captured round sequences including missing-input horizons; entirely uncaptured rounds are not inferred."};
  return {...report,digest:digestEarlySnapshot(report)};
}
