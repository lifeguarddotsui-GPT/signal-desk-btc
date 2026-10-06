import {createHash} from "node:crypto";
import type {EarlyTrainingRow} from "./early-training";
import {fitLogistic} from "./research-training-model";
import {logit,sigmoid} from "./bluewater-fast";
import {metrics} from "./bluewater-metrics";
import {earlyHorizons,TIMED_STRATEGY} from "../../shared/timed-decision";
import {digestEarlySnapshot} from "./early-horizons";

/** Pool elapsed-aware evidence without calling correlated gates independent outcomes.
 * A predeclared hash, never an outcome/probability, selects ONE gate per training round.
 * This is a shadow challenger, not the production qualification policy. */
export function trainPooledGates(rows:EarlyTrainingRow[],interval:5|15,now:number){
  const day=86400000,cutoff=Math.floor(now/day)*day,trainEnd=cutoff-4*day,calEnd=cutoff-3*day,policyEnd=cutoff-2*day;
 const groups=new Map<string,EarlyTrainingRow[]>(),allowed=new Set(earlyHorizons(interval));
 for(const r of rows){
   if(r.interval!==interval||!allowed.has(r.horizon)||r.startMs<cutoff-14*day||r.expiryMs>cutoff||
     r.labelAvailableAtMs>now||!Number.isFinite(r.probability)||r.probability<0||r.probability>1)continue;
   const key=`${r.roundId}:${r.startMs}:${r.expiryMs}`,g=groups.get(key)??[];
   // Conflicting labels or duplicate snapshots must not quietly influence fitting.
   g.push(r);groups.set(key,g);
 }
 let rejectedRounds=0;
 const selected:EarlyTrainingRow[]=[];
 for(const [key,g]of Array.from(groups.entries())){
   if(new Set(g.map(r=>r.outcome)).size!==1||new Set(g.map(r=>r.horizon)).size!==g.length){rejectedRounds++;continue;}
   g.sort((a,b)=>a.horizon-b.horizon);
   const n=createHash("sha256").update(key).digest().readUInt32BE(0);
   selected.push(g[n%g.length]);
 }
 selected.sort((a,b)=>a.startMs-b.startMs||a.roundId.localeCompare(b.roundId));
 const training=selected.filter(r=>r.expiryMs<=trainEnd&&r.labelAvailableAtMs<=trainEnd);
 const calibration=selected.filter(r=>r.startMs>=trainEnd&&r.expiryMs<=calEnd&&r.labelAvailableAtMs<=calEnd);
  const test=selected.filter(r=>r.startMs>=policyEnd&&r.expiryMs<=cutoff);
 const base={interval,protocol:"elapsed-pooled-one-hash-selected-gate-per-round-v1",strategyVersion:TIMED_STRATEGY,
   statisticalUnit:"distinct exact round; one outcome per partition",
   features:["market_logit","elapsed_fraction"],counts:{eligible:selected.length,training:training.length,
     calibration:calibration.length,test:test.length},rejectedRounds,
   fingerprint:digestEarlySnapshot(selected.map(r=>[r.roundId,r.startMs,r.horizon,r.snapshotDigest,r.outcome])),
   promotion:"RETAIN_BASELINE" as const};
 if(training.length<200||calibration.length<60||test.length<60||
   [training,calibration,test].some(p=>new Set(p.map(r=>r.outcome)).size<2))
   return {...base,status:"INSUFFICIENT" as const,reason:"Same 200/60/60 independent-round and two-class requirements as per-gate training."};
 const vector=(r:EarlyTrainingRow)=>[logit(r.probability),r.horizon/(interval*60)];
 const y=(r:EarlyTrainingRow)=>r.outcome==="UP"?1:0;
 const parameters=fitLogistic(training.map(vector),training.map(y),.1,600);
 const raw=(r:EarlyTrainingRow)=>sigmoid(parameters.intercept+vector(r).reduce((s,x,i)=>s+x*parameters.coefficients[i],0));
 const calibrationFit=fitLogistic(calibration.map(r=>[logit(raw(r))]),calibration.map(y),.1,400);
 const probability=(r:EarlyTrainingRow)=>sigmoid(calibrationFit.intercept+calibrationFit.coefficients[0]*logit(raw(r)));
 return {...base,status:"EVALUATED" as const,artifact:{parameters,calibration:calibrationFit,
   featureNames:base.features,shadowOnly:true},test:metrics(test.map(r=>({probability:probability(r),outcome:r.outcome}))),
   sameTimeMarket:metrics(test.map(r=>({probability:r.probability,outcome:r.outcome})))};
}
