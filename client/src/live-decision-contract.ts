import type {RoundDecision} from "../../shared/round-decision";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
import {lockPolicy} from "../../shared/lock-readiness";

export type LiveSnapshotEnvelope={
  serverTime?:string;intervalMinutes?:number;status?:string;reason?:string;
  round?:{id:string;startMs:number;expiryMs:number}|null;
  decision?:RoundDecision|null;
};
export const DECISION_FRESH_MS=10_000;
/** React's one-second display tick can precede a newly received response. */
export const projectServerClock=(serverAtMs:number,browserReceivedAtMs:number,browserNow:number)=>
  serverAtMs+Math.max(0,browserNow-browserReceivedAtMs);
const integer=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n);
const bounded=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=1;
const serverTime=(p:LiveSnapshotEnvelope)=>Date.parse(p.serverTime??"");
export function validateLiveEnvelope(p:LiveSnapshotEnvelope,interval:5|15,previous:LiveSnapshotEnvelope|null=null):string|null{
  const now=serverTime(p),prior=previous?serverTime(previous):NaN;
  if(!Number.isFinite(now)||p.intervalMinutes!==interval)return "INTERVAL_OR_SERVER_TIME_INVALID";
  if(Number.isFinite(prior)&&now<prior)return "SERVER_TIME_REGRESSION";
  const r=p.round;
  if(r!==null&&r!==undefined&&typeof r!=="object")return "ROUND_IDENTITY_INVALID";
  if(!r)return p.decision?"ROUND_IDENTITY_MISMATCH":null;
  if(typeof r.id!=="string"||!r.id||!integer(r.startMs)||!integer(r.expiryMs)||r.expiryMs-r.startMs!==interval*60000)
    return "ROUND_IDENTITY_INVALID";
  if(now<r.startMs||now>=r.expiryMs)return "ROUND_EXPIRED_OR_NOT_STARTED";
  if(previous?.round&&(r.startMs<previous.round.startMs||
    (r.startMs===previous.round.startMs&&(r.id!==previous.round.id||r.expiryMs!==previous.round.expiryMs))))
    return "ROUND_IDENTITY_REGRESSION";
  return null;
}
export function validateDecisionSnapshot(p:LiveSnapshotEnvelope,interval:5|15,previous:LiveSnapshotEnvelope|null=null):string|null{
  const envelopeError=validateLiveEnvelope(p,interval,previous);
  if(envelopeError)return envelopeError;
  if(!p.round)return "WAITING_FOR_ACTIVE_ROUND";
  const d=p.decision,r=p.round,now=serverTime(p),old=previous?.decision;
  if(!d)return "WAITING_FOR_EXACT_ROUND_SNAPSHOT";
  if(d.format!=="waterx-live-decision-v2"||typeof d.streamId!=="string"||!d.streamId||
    d.network!=="sui:mainnet"||d.intervalMinutes!==interval||d.roundId!==r.id||
    d.startMs!==r.startMs||d.expiryMs!==r.expiryMs||d.policyVersion!==lockPolicy(interval).version)
    return "ROUND_IDENTITY_OR_CONTRACT_MISMATCH";
  if(!integer(d.stateVersion)||d.stateVersion<1||!integer(d.updatedAtMs)||!integer(d.publishedAtMs)||
    d.updatedAtMs<r.startMs||d.updatedAtMs>now||d.publishedAtMs!==now||
    d.tradeAllowed!==false||d.latestSafeOrderAtMs!==null||d.executionWindowRemainingMs!==null||
    typeof d.executionBlocker!=="string"||!d.executionBlocker)
    return "PUBLICATION_OR_AUTHORITY_INVALID";
  if(old&&d.streamId===old.streamId&&d.stateVersion<=old.stateVersion)return "STATE_VERSION_REGRESSION";
  if(old&&old.roundId===d.roundId&&old.startMs===d.startMs&&old.expiryMs===d.expiryMs){
    if(d.publishedAtMs<old.publishedAtMs)return "STATE_VERSION_REGRESSION";
    if(d.updatedAtMs<old.updatedAtMs||(old.market&&d.market&&
      (d.market.observedAtMs<old.market.observedAtMs||d.market.receivedAtMs<old.market.receivedAtMs)))
      return "SOURCE_OBSERVATION_REGRESSION";
    if(old.canonical&&(!d.canonical||d.canonical.side!==old.canonical.side||
      d.canonical.probabilityUp!==old.canonical.probabilityUp||
      d.canonical.decisionAtMs!==old.canonical.decisionAtMs))
      return "IMMUTABLE_CHOICE_REGRESSION";
  }
  const ready=d.readiness;
  if(!ready||ready.evaluatedAtMs!==now||!ready.components||
    !Number.isFinite(ready.score)||ready.score<0||ready.score>100||
    !["WATCHING","LEANING","BUILDING LOCK","READY"].includes(ready.state)||
    (ready.side!==null&&ready.side!=="UP"&&ready.side!=="DOWN")||
    (ready.probability!==null&&!bounded(ready.probability))||
    typeof ready.reason!=="string"||!ready.reason||
    !["fresh","stable","sourceHealthy","withinWindow","gapReset"].every(k=>
      typeof ready.components[k as "fresh"]==="boolean")||
    !integer(ready.components.observationCount)||ready.components.observationCount<0||
    !bounded(ready.components.strength)||!bounded(ready.components.requiredStrength))
    return "READINESS_INVALID";
  const market=d.market;
  if(market&&(!validWaterxProbabilityPair(market.probabilityUp,market.probabilityDown)||
    !integer(market.observedAtMs)||!integer(market.receivedAtMs)||market.receivedAtMs<r.startMs||
    market.receivedAtMs>market.observedAtMs||market.observedAtMs>now||
    market.observedAtMs!==d.updatedAtMs||market.providerOddsAtMs!==null))return "SOURCE_OBSERVATION_INVALID";
  if(ready.components.fresh&&(!market||now-market.receivedAtMs>DECISION_FRESH_MS||
    now-market.observedAtMs>DECISION_FRESH_MS))return "SOURCE_STALE";
  // observationCount counts the stability window, not lifetime source evidence.
  if(market&&((ready.components.fresh&&ready.components.observationCount<1)||
    !ready.components.sourceHealthy||
    ready.components.ageMs!==now-market.receivedAtMs||
    ready.probability!==Math.max(market.probabilityUp,market.probabilityDown)||
    ready.side!==(market.probabilityUp>=market.probabilityDown?"UP":"DOWN")))
    return "READINESS_SOURCE_MISMATCH";
  if(!market&&(ready.components.fresh||ready.side!==null||ready.probability!==null))
    return "READINESS_SOURCE_MISMATCH";
  if(ready.state==="READY"&&(!ready.components.fresh||!ready.components.sourceHealthy||
    !ready.components.stable||!ready.components.withinWindow||ready.score!==100))
    return "READINESS_INVALID";
  if(d.canonical&&(!["UP","DOWN"].includes(d.canonical.side)||!bounded(d.canonical.probabilityUp)||
    !integer(d.canonical.decisionAtMs)||d.canonical.decisionAtMs<r.startMs||
    d.canonical.decisionAtMs>=r.expiryMs||d.canonical.decisionAtMs>now||
    (d.canonical.committedAtMs!==null&&(!integer(d.canonical.committedAtMs)||
      d.canonical.committedAtMs<d.canonical.decisionAtMs||d.canonical.committedAtMs>now))))return "CANONICAL_CHOICE_INVALID";
  const early=d.earlyDecision;
  if(early&&(!["UP","DOWN"].includes(early.side)||!bounded(early.probabilityUp)||
    !integer(early.decisionAtMs)||early.decisionAtMs<r.startMs||early.decisionAtMs>=r.expiryMs||
    early.decisionAtMs>now||early.policyVersion!==d.policyVersion||
    !early.observationId||!/^\d+$/.test(early.eventId)||
    (early.committedAtMs!==null&&(!integer(early.committedAtMs)||early.committedAtMs<early.decisionAtMs||
      early.committedAtMs>now))))return "EARLY_DECISION_INVALID";
  if(old?.roundId===d.roundId&&old.earlyDecision&&(!early||
    early.side!==old.earlyDecision.side||early.decisionAtMs!==old.earlyDecision.decisionAtMs||
    early.probabilityUp!==old.earlyDecision.probabilityUp||early.eventId!==old.earlyDecision.eventId))
    return "IMMUTABLE_EARLY_DECISION_REGRESSION";
  if(d.opportunity&&(d.opportunity.sourceId!=="waterx.public.crypto.v1"||
    !d.opportunity.observationId||!integer(d.opportunity.receivedAtMs)||
    d.opportunity.receivedAtMs<r.startMs||d.opportunity.receivedAtMs>now))
    return "OPPORTUNITY_PROVENANCE_INVALID";
  if(!d.persistence||!["WAITING_CHECKPOINT","QUEUED","WRITING","FAILED","AWAITING_CHOICE","COMMITTED"].includes(d.persistence.status)||
    !integer(d.persistence.updatedAtMs)||d.persistence.updatedAtMs<r.startMs||d.persistence.updatedAtMs>now||
    (d.canonical!==null)!==(d.persistence.status==="COMMITTED"))return "PERSISTENCE_STATE_INVALID";
  return null;
}
export type AtomicDecisionView={
  decision:RoundDecision|null;fresh:boolean;sourceAgeMs:number|null;
  lean:"UP"|"DOWN"|null;stage:string;score:number|null;reason:string;
};
/** Both current-round cards consume this projection; database reports cannot supply a live lean. */
export function getAtomicDecisionView(p:LiveSnapshotEnvelope|null,interval:5|15,activeRound:LiveSnapshotEnvelope["round"],now:number):AtomicDecisionView{
  const empty=(reason:string):AtomicDecisionView=>({decision:null,fresh:false,sourceAgeMs:null,lean:null,stage:"WATCHING",score:null,reason});
  if(!Number.isFinite(now))return empty("Current clock unavailable; live state withheld.");
  if(!p||!activeRound)return empty("Waiting for a valid active-round snapshot.");
  if(p.round?.id!==activeRound.id||p.round.startMs!==activeRound.startMs||p.round.expiryMs!==activeRound.expiryMs)
    return empty("Round identity mismatch: old-round state withheld.");
  const error=validateDecisionSnapshot(p,interval);
  if(error)return empty(error.replaceAll("_"," ").toLowerCase());
  const d=p.decision!;
  if(now>=d.expiryMs||now<d.startMs)return empty("Round expired or not started; previous state withheld.");
  const age=d.market?Math.max(now-d.market.receivedAtMs,now-d.market.observedAtMs):null;
  const fresh=age!==null&&age>=0&&age<=DECISION_FRESH_MS&&now-d.publishedAtMs>=0&&
    now-d.publishedAtMs<=DECISION_FRESH_MS&&d.readiness.components.fresh;
  const reason=d.persistence.status==="FAILED"?`Database write failed (${d.persistence.errorClass??"UNKNOWN"}); research choice not committed.`:
     d.persistence.status==="AWAITING_CHOICE"?
       d.persistence.errorClass==="CANONICAL_INPUT_REJECTED"?
         "Canonical checkpoint evidence rejected; awaiting valid exact-round input, not a database failure.":
         "Checkpoint write finished without a frozen canonical choice; capture needs investigation.":
    !d.market?"Waiting for a fresh WaterX observation.":!fresh?
    `Source stale (${Math.max(0,Math.floor((age??0)/1000))}s); last same-round record retained, live lean withheld.`:
    d.persistence.status==="WRITING"?"Database write pending; no committed choice is asserted.":
    d.persistence.status==="QUEUED"?"Checkpoint capture queued; waiting for database persistence.":d.readiness.reason;
  return {decision:d,fresh,sourceAgeMs:age,lean:fresh?d.readiness.side:null,
    stage:fresh?d.readiness.state:"WATCHING",score:fresh?Math.round(d.readiness.score):null,reason};
}
