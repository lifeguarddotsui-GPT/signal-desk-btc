import {logit,sigmoid} from "./bluewater-fast";
import {earlyHorizons} from "../../shared/timed-decision";
import {metrics} from "./bluewater-metrics";
import {digestEarlySnapshot} from "./early-horizons";
import type {EarlyTrainingRow} from "./early-training";
type Forecast={horizon:number;artifact:null|{
 parameters:{intercept:number;coefficients:number[]};calibration:{intercept:number;coefficients:number[]}}};
/** Evaluate an entire frozen sequence once per round. Threshold selection uses
 * calibration only; test results never choose the runtime candidate. */
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
  const select=(s:EarlyTrainingRow[],threshold:number)=>s.find(r=>valid(r)&&earlyHorizons(interval).includes(r.horizon)&&
    r.horizon<interval*60&&Math.max(probability(r),1-probability(r))>=threshold);
  const evaluate=(part:EarlyTrainingRow[][],threshold:number)=>{
    const complete=part.filter(s=>s.length===earlyHorizons(interval).length);
    const picked=complete.flatMap(s=>{const r=select(s,threshold);return r?[r]:[];});
    const forecast=metrics(picked.map(r=>({probability:probability(r),outcome:r.outcome})));
    const sameTimeMarket=metrics(picked.map(r=>({probability:r.probability,outcome:r.outcome})));
    const fixed=part.flatMap(s=>{const r=s.find(r=>r.horizon===target&&valid(r));return r?[r]:[];});
    const fixedTargetMarket=metrics(fixed.map(r=>({probability:r.probability,outcome:r.outcome})));
    return {roundN:part.length,decisionN:picked.length,coverage:part.length?picked.length/part.length:null,
      missingHorizonDecisions:part.length-picked.length,
      incompletePaths:part.filter(s=>s.length!==earlyHorizons(interval).length).length,
      incompletePathPolicy:"Incomplete paths stay in the denominator as operational gaps and never generate stopped choices.",
      forecast,sameTimeMarket,fixedTargetMarket,
      fixedTargetCoverage:part.length?fixed.length/part.length:null,
      meanElapsedSeconds:picked.length?picked.reduce((a,r)=>a+r.horizon,0)/picked.length:null,
      meanSecondsBeforeExpiry:picked.length?picked.reduce((a,r)=>a+(r.expiryMs-r.startMs)/1000-r.horizon,0)/picked.length:null,
      quoteAdjustedEconomics:null,durableDeadlineMisses:null,
      limitation:"Capture gaps counted; replay of frozen prospective sequences is not actual commit/submission latency or fill evidence."};
  };
  const calibration=sequences.filter(s=>s[0].startMs>=cutoff-3*day&&s[0].expiryMs<=calEnd&&s.every(r=>r.labelAvailableAtMs<=calEnd));
  const test=sequences.filter(s=>s[0].startMs>=calEnd&&s[0].expiryMs<=cutoff);
  if(calibration.length<60||test.length<60)return {status:"INSUFFICIENT",reason:"Requires 60 distinct calibration and untouched test rounds for the full sequence.",promotion:"RETAIN_BASELINE"};
  const candidates=[.70,.74,.78].map(threshold=>({threshold,...evaluate(calibration,threshold)}));
  // Predeclared calibration objective: Brier + coverage penalty + small time
  // penalty. No held-out outcomes or later per-round information selects a lock.
  const objective=(r:typeof candidates[number])=>(r.forecast.brier??1)+.2*(1-(r.coverage??0))+.02*(r.meanElapsedSeconds??hard)/hard;
  candidates.sort((a,b)=>objective(a)-objective(b)||a.threshold-b.threshold);
  const selected=candidates[0],heldOut=evaluate(test,selected.threshold);
  const ece=(m:typeof heldOut.forecast)=>m.n?m.calibration.reduce((sum,b)=>
    sum+b.n*Math.abs(b.meanProbability-b.observedUpRate),0)/m.n:null;
  const pass=heldOut.decisionN>=60&&(heldOut.coverage??0)>=(heldOut.fixedTargetCoverage??0)-.05&&
    heldOut.forecast.brier!==null&&heldOut.sameTimeMarket.brier!==null&&
    heldOut.forecast.brier<=heldOut.sameTimeMarket.brier&&
    heldOut.forecast.logLoss!==null&&heldOut.sameTimeMarket.logLoss!==null&&
    heldOut.forecast.logLoss<=heldOut.sameTimeMarket.logLoss*1.03&&
    (ece(heldOut.forecast)??1)<=(ece(heldOut.sameTimeMarket)??0)+.03&&
    heldOut.meanElapsedSeconds!==null&&heldOut.meanElapsedSeconds<=target*.9;
  const report={status:"EVALUATED",version:"early-full-sequence-shadow-v1",interval,threshold:selected.threshold,
    calibrationCandidates:candidates,test:heldOut,heldOutCriteriaPassed:pass,
    criteria:">=60 test decisions; coverage decline <=5pp; Brier no worse; log loss <=3% worse; ECE <=3pp worse; >=10% target time gained",
    promotion:"RETAIN_BASELINE",reason:pass?"Qualified for prospective shadow review only; explicit versioned live promotion still required.":"Speed/quality criteria did not pass; retain deterministic live baseline.",
    repeatedChecks:"One selected decision per distinct round. Chronological day boundaries and label embargo match forecast models.",
    denominator:"Verified captured round sequences including missing-input horizons; entirely uncaptured rounds are not inferred."};
  return {...report,digest:digestEarlySnapshot(report)};
}
