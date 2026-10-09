import {eventQualification} from "../../shared/event-lock";
import {defaultValuePreference} from "../../shared/lock-economics";
import type {StageInput,ResearchPreference,StageDiagnostics} from "../../shared/two-stage";
import {priceAreaFeatures} from "../../shared/price-area";

/** Preregistered before evaluation. Selection is research-only, never an order authority. */
export const EARLY_CANDIDATE_PROTOCOL="early-preregistered-six-v1";
export const EARLY_DEFAULT_POLICY="early-tw72-12-v1";
export const researchPreference:ResearchPreference={...defaultValuePreference,mode:"PREFERRED"};
export const EARLY_CANDIDATES=Object.freeze([
  {version:"unchanged-event-control-v1",strength:.72,seconds5:24,seconds15:45,pullback:0,priceGuard:false,control:true},
  {version:EARLY_DEFAULT_POLICY,strength:.72,seconds5:12,seconds15:24,pullback:.035,priceGuard:false,control:false},
  {version:"early-tw74-12-v1",strength:.74,seconds5:12,seconds15:24,pullback:.025,priceGuard:false,control:false},
  {version:"early-tw70-18-v1",strength:.70,seconds5:18,seconds15:36,pullback:.025,priceGuard:false,control:false},
  {version:"early-tw72-pullback18-v1",strength:.72,seconds5:18,seconds15:36,pullback:.05,priceGuard:false,control:false},
  {version:"early-tw72-price18-v1",strength:.72,seconds5:18,seconds15:36,pullback:.035,priceGuard:true,control:false},
]);
export function earlyCandidate(input:StageInput,version=input.earlyPolicyVersion??EARLY_DEFAULT_POLICY){
  const policy=EARLY_CANDIDATES.find(p=>p.version===version);
  if(!policy)throw new Error("UNKNOWN_PREREGISTERED_EARLY_POLICY");
  if(policy.control){
    const q=eventQualification(input,input.observations,input.nowMs);
    return {...q,diagnostics:{message:q.remainingRequirement,
      measurements:{...q.components},thresholds:{version:policy.version,baselineUnchanged:true}} as StageDiagnostics};
  }
  const rows=input.observations.filter(o=>o.availableAtMs<=input.nowMs&&o.receivedAtMs<=input.nowMs);
  const latest=rows.at(-1);
  const side=latest&&latest.probabilityUp!==.5?(latest.probabilityUp>.5?"UP":"DOWN") as "UP"|"DOWN":null;
  const strength=latest?Math.max(latest.probabilityUp,1-latest.probabilityUp):0;
  const requiredMs=(input.intervalMinutes===5?policy.seconds5:policy.seconds15)*1000;
  let supportedMs=0,weighted=0;const distinct=new Set<string>();
  let segmentStart=rows.length-1;
  for(let i=rows.length-1;i>=0;i--){
    const o=rows[i],s=side==="UP"?o.probabilityUp:1-o.probabilityUp;
    if(!o.sourceHealthy||!Number.isFinite(s)||s<.5||s<policy.strength-policy.pullback||
      o.features.eventGapResetAtMs)break;
    if(i<rows.length-1&&rows[i+1].receivedAtMs-o.receivedAtMs>12000)break;
    segmentStart=i;
  }
  for(let i=Math.max(0,segmentStart);i<rows.length;i++){
    const o=rows[i],cmp=o.features.comparison as {price?:number;asOf?:string}|undefined;
    // Fresh receipts prove continuing availability, not independent probabilities.
    distinct.add(JSON.stringify([o.probabilityUp,cmp?.price??null,cmp?.asOf??null]));
    if(i>segmentStart){
      const previous=rows[i-1],dt=o.receivedAtMs-previous.receivedAtMs;
      supportedMs+=dt;weighted+=dt*((side==="UP"?previous.probabilityUp+o.probabilityUp:
        2-previous.probabilityUp-o.probabilityUp)/2);
    }
  }
  const average=supportedMs?weighted/supportedMs:strength;
  const area=priceAreaFeatures({points:input.priceObservations??[],startMs:input.startMs,expiryMs:input.expiryMs,
    asOfMs:input.nowMs,reference:typeof latest?.features.reference==="number"?latest.features.reference:null,
    referenceConfirmed:latest?.features.referenceQuality==="confirmed"});
  const momentum=area.windows[30].momentumUsd,priceReversal=side==="UP"?(momentum??0)<0:(momentum??0)>0;
  const materialReversal=priceReversal&&Math.abs(momentum??0)>3*(area.volatilityUsd??0);
  let blocker="CONDITIONS_SATISFIED",message="Evidence qualifies; saving decision";
  if(!latest?.sourceHealthy||input.nowMs-latest.receivedAtMs>5000){blocker="WAITING_FOR_FRESH_DATA";message="Fresh odds unavailable";}
  else if(!side){blocker="AMBIGUOUS_TIE";message="Direction tied; waiting for separation";}
  else if(strength<policy.strength||average<policy.strength-policy.pullback/2){
    blocker="DIRECTIONAL_SEPARATION_BELOW_POLICY";message="Directional strength below policy";
  }else if(supportedMs<requiredMs){
    blocker="SAME_SIDE_PERSISTENCE_INCOMPLETE";message=`Needs ${Math.ceil((requiredMs-supportedMs)/1000)} seconds more stable evidence.`;
  }else if(distinct.size<2){blocker="IDENTICAL_EVIDENCE";message="Needs genuinely changed evidence; identical polls are not independent";}
  else if(policy.priceGuard&&(area.coverageFraction??0)<.7){blocker="INSUFFICIENT_PRICE_COVERAGE";message="Price coverage insufficient";}
  else if(policy.priceGuard&&materialReversal){blocker="MATERIAL_PRICE_REVERSAL";message="Recent price reversal exceeds policy";}
  const qualified=blocker==="CONDITIONS_SATISFIED"&&input.nowMs<input.expiryMs;
  return {qualified,liveSide:side,blocker,remainingRequirement:message,
    diagnostics:{message,measurements:{strength,timeWeightedStrength:average,supportedSameSideMs:supportedMs,
      distinctEvidence:distinct.size,oddsAgeMs:latest?input.nowMs-latest.receivedAtMs:null,
      remainingMs:input.expiryMs-input.nowMs,recentMomentumUsd:momentum,volatilityUsd:area.volatilityUsd},
      thresholds:{version:policy.version,strength:policy.strength,requiredSameSideMs:requiredMs,
        pullbackTolerance:policy.pullback,maximumEvidenceGapMs:12000,maximumOddsAgeMs:5000,
        minimumDistinctEvidence:2,priceGuard:policy.priceGuard,experimental:true}}};
}
