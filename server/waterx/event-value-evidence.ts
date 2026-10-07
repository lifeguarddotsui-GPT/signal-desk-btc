import {economicEvidenceFromFeatures,entryEconomics,defaultValuePreference,frozenEntryFeatures,
  type EntryEconomics,type QualifiedForecast,type VerifiedEntryQuote,type ValuePreference} from "../../shared/lock-economics";
import type {TimedDecision} from "../../shared/timed-decision";
import {eventPartition,type EventTrajectory} from "./event-lock-learning";

export function decisionEntryEconomics(d:TimedDecision|null):EntryEconomics|null{
  if(!d||d.status!=="LOCKED"||!d.side)return null;
  const features=frozenEntryFeatures(d.evidence,d.observationId,d.decisionAtMs);
  // An archived estimate is sufficient for display, not permission to execute.
  return economicEvidenceFromFeatures(features,d.roundId,d.side,d.decisionAtMs);
}
export function compareEntryEconomics(rows:{event:TimedDecision|null;benchmark:TimedDecision|null;verified:unknown}[]){
  const describe=(key:"event"|"benchmark")=>{
    const locks=rows.flatMap(r=>{const e=decisionEntryEconomics(r[key]);return e?[e]:[];});
    return {locks:locks.length,indicativeN:locks.filter(e=>e.kind==="INDICATIVE").length,
      verifiedFullSizeQuoteN:locks.filter(e=>e.kind==="VERIFIED_QUOTE").length,
      unknownN:locks.filter(e=>e.kind==="UNAVAILABLE").length,
      calibratedExpectedValueN:locks.filter(e=>e.expectedNetUsd!=null).length,
      expectedNetUsd:null,realizedTradingPnlUsd:null,drawdownUsd:null,
      reason:"Indicative asks cannot establish full-size fills, positive edge, executable historical profits or drawdown."};
  };
  return {version:"matched-first-lock-entry-value-v1",scope:"DECISION_TIME_TERMS_NOT_TRADING_PNL",
    preference:defaultValuePreference,event:describe("event"),benchmark:describe("benchmark"),
    matched:rows.filter(r=>r.verified&&r.event?.status==="LOCKED"&&r.benchmark?.status==="LOCKED")
      .map(r=>({roundId:r.event!.roundId,event:decisionEntryEconomics(r.event),benchmark:decisionEntryEconomics(r.benchmark)}))};
}
/** A value candidate can only act on independent qualified forecasts and
 * verified full-size quotes, never market odds or presumed historical fills. */
export function firstValueOpportunity(observations:readonly {
  atMs:number;qualified:boolean;roundId:string;marketId:string;side:"UP"|"DOWN";
  quote:VerifiedEntryQuote|null;forecast:QualifiedForecast|null;
}[],preference:ValuePreference=defaultValuePreference,minimumExpectedNetUsd=0){
  if(!Number.isFinite(minimumExpectedNetUsd)||minimumExpectedNetUsd<0)throw new Error("Invalid value-policy objective");
  let previous=-Infinity;
  for(const o of observations){
    if(o.atMs<previous)throw new Error("Value policy requires chronological available observations");
    previous=o.atMs;
    if(!o.qualified)continue;
    const economics=entryEconomics({...o,nowMs:o.atMs,preference});
    if(economics.kind==="VERIFIED_QUOTE"&&economics.forecast&&economics.preferenceMet&&
      economics.expectedNetUsd!==null&&economics.expectedNetUsd>minimumExpectedNetUsd)
      return {action:"LOCK" as const,atMs:o.atMs,side:o.side,economics};
  }
  return {action:"ABSTAIN" as const,reason:"No qualified forecast with fresh full-size terms satisfies the reviewed value preference."};
}
/** Audit opportunity to train value stopping; do not train on illustrative asks. */
export function economicTrainingReadiness(trajectories:EventTrajectory[],interval:5|15,now:number){
  const counts={TRAIN:0,CALIBRATION:0,POLICY:0,TEST:0};
  const outcomes={TRAIN:new Set<string>(),CALIBRATION:new Set<string>(),POLICY:new Set<string>(),TEST:new Set<string>()};
  let indicativeOnly=0,unverifiedLabels=0,unknownQuotes=0;
  for(const r of trajectories.filter(r=>r.intervalMinutes===interval)){
    if(!r.verified||!Number.isSafeInteger(r.labelAvailableAtMs)||r.labelAvailableAtMs<=r.expiryMs||r.labelAvailableAtMs>now){
      unverifiedLabels++;continue;
    }
    // Missing receipts/provenance cannot become an economic training example.
    if(!r.observations.length||r.observations.some(o=>o.provenance!=="PROSPECTIVE"||
      !Number.isSafeInteger(o.availableAtMs)||o.availableAtMs<o.receivedAtMs||o.availableAtMs>=r.expiryMs)){
      unknownQuotes++;continue;
    }
    const quoted=r.observations.some(o=>{
      const q=o.features.executableQuote as VerifiedEntryQuote|null;
      return q&&entryEconomics({roundId:r.roundId,marketId:String(o.features.marketId??""),side:q.side,
        nowMs:o.availableAtMs,quote:q}).kind==="VERIFIED_QUOTE";
    });
    if(!quoted){
      if(r.observations.some(o=>o.features.purchaseUp||o.features.purchaseDown))indicativeOnly++;
      else unknownQuotes++;
      continue;
    }
    const stage=eventPartition(r,now);
    if(stage==="EXCLUDED")continue;
    counts[stage]++;outcomes[stage].add(r.outcome);
  }
  return {protocol:"event-value-whole-trajectory-readiness-v1",status:"NOT_QUALIFIED",
    counts,deficits:Object.fromEntries(Object.entries(counts).map(([stage,n])=>[stage,{
      requiredRounds:60,missingRounds:Math.max(0,60-n),bothOutcomes:outcomes[stage as keyof typeof outcomes].size===2}])),
    exclusions:{indicativeOnly,unverifiedLabels,unknownQuotes},
    positiveModelEdgeAuthorized:false,learnedEconomicStoppingArtifact:null,
    nextEligibilityCondition:"Four chronological disjoint stages, each with 60 verified compatible complete trajectories and both outcomes, plus verified full-size decision-time quotes and independently qualified selected-subset calibration.",
    reason:"The existing timing/error stopping model is not an economically trained or qualified policy. No indicative asks are scored as executable profits."};
}
