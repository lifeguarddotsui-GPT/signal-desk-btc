import type {RoundDecision} from "../../shared/round-decision";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
import {dataHealthReason, type WaterxDataHealth} from "../../shared/waterx-data-health";
import {lockPolicy} from "../../shared/lock-readiness";
import {GATE_GRACE_MS,GATE_MS,isTimedStrategy,TIMED_STRATEGY,timedWindow,type GateJournal,type TimedDecision,type TimedState} from "../../shared/timed-decision";

type ProjectedRoundDecision = RoundDecision & {
  snapshotVersion?: number;
};
export type LiveSnapshotEnvelope={
  serverTime?:string;intervalMinutes?:number;status?:string;reason?:string;
  round?:{id:string;startMs:number;expiryMs:number}|null;
  decision?:ProjectedRoundDecision|null;
  dataHealth?:WaterxDataHealth;
  /** Optional metadata supplied by newer server projections; v2 fields remain authoritative fallback. */
  projectionVersion?:string;
  snapshotVersion?:number;
  componentTimestamps?:Record<string,number|null>;
};
export const DECISION_FRESH_MS=10_000;
/** React's one-second display tick can precede a newly received response. */
export const projectServerClock=(serverAtMs:number,browserReceivedAtMs:number,browserNow:number)=>
  serverAtMs+Math.max(0,browserNow-browserReceivedAtMs);
const integer=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n);
const bounded=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=1;
const serverTime=(p:LiveSnapshotEnvelope)=>Date.parse(p.serverTime??"");
const probabilityOrNull=(n:unknown):n is number|null=>n===null||bounded(n);

function validateTimedDecisionState(timed:TimedState,d:RoundDecision,now:number):string|null{
  if(!timed||!isTimedStrategy(timed.strategyVersion))return "TIMED_STATE_INVALID";
  const round=d,window=timedWindow(d.intervalMinutes,timed.strategyVersion),target=round.startMs+window.targetSeconds*1000;
  const gateStrategy=timed.strategyVersion===TIMED_STRATEGY;
  const hard=gateStrategy?round.expiryMs:round.startMs+window.hardSeconds*1000,elapsed=Math.max(0,now-round.startMs);
  if(timed.targetAtMs!==target||
    timed.hardDeadlineAtMs!==hard||!integer(timed.elapsedMs)||timed.elapsedMs!==elapsed||
    !Number.isFinite(timed.timeProgress)||timed.timeProgress<0||timed.timeProgress>1||
     Math.abs(timed.timeProgress-Math.min(1,elapsed/(hard-round.startMs)))>0.001||
    !["OBSERVING","EVALUATING","DEADLINE","EXPIRED"].includes(timed.phase)||
    !integer(timed.readinessPercent)||timed.readinessPercent<0||timed.readinessPercent>100||
    typeof timed.qualified!=="boolean"||typeof timed.blocker!=="string"||!timed.blocker||
    (timed.liveSide!==null&&timed.liveSide!=="UP"&&timed.liveSide!=="DOWN")||
    !probabilityOrNull(timed.liveProbabilityUp)||
    (timed.liveProbabilityUp!==null&&!timed.liveSide)||
    (timed.liveSide!==null&&timed.liveProbabilityUp===null)||
    (timed.sourceAgeMs!==null&&(!integer(timed.sourceAgeMs)||timed.sourceAgeMs<0))||
    !["WAITING","SAVING","FAILED","COMMITTED"].includes(timed.persistence)||
    (timed.errorClass!==null&&typeof timed.errorClass!=="string"))
    return "TIMED_STATE_INVALID";
  const expectedPhase=now>=round.expiryMs?"EXPIRED":!gateStrategy&&now>=hard?"DEADLINE":now>=target?"EVALUATING":"OBSERVING";
  if(timed.phase!==expectedPhase)return "TIMED_PHASE_MISMATCH";
  if(gateStrategy){
    const expectedNext=round.startMs+(Math.floor(elapsed/GATE_MS)+1)*GATE_MS;
    if(timed.nextGateAtMs!==(expectedNext<round.expiryMs?expectedNext:null)||
      !Number.isSafeInteger(timed.requirementsMet)||timed.requirementsMet!<0||timed.requirementsMet!>4||
      timed.requirementsTotal!==4||timed.policySource!=="experimental market-based policy"||
      timed.executionCutoffAtMs!==null||
      (timed.lastGate!==null&&(!timed.lastGate||!validGateJournal(timed.lastGate,round.startMs,now))))
      return "TIMED_GATE_STATE_INVALID";
  }

  const saved=timed.saved;
  if((timed.persistence==="COMMITTED")!==!!saved)return "TIMED_PERSISTENCE_STATE_MISMATCH";
  if(!saved)return null;
  if(saved.strategyVersion!==timed.strategyVersion||saved.network!=="sui:mainnet"||
    saved.intervalMinutes!==round.intervalMinutes||saved.roundId!==round.roundId||
    saved.startMs!==round.startMs||saved.expiryMs!==round.expiryMs||
    typeof saved.id!=="string"||!saved.id||
     !["LOCKED","NO_VALID_INPUT","MISSED_DEADLINE","ABSTAINED_NO_QUALIFIED_SIGNAL","DATA_FAILURE"].includes(saved.status)||
    (saved.side!==null&&saved.side!=="UP"&&saved.side!=="DOWN")||
    !probabilityOrNull(saved.probabilityUp)||!probabilityOrNull(saved.probabilityDown)||
    !integer(saved.decisionAtMs)||saved.decisionAtMs<round.startMs||saved.decisionAtMs>now||
    !integer(saved.elapsedMs)||saved.elapsedMs!==saved.decisionAtMs-round.startMs||
     !integer(saved.targetAtMs)||!integer(saved.hardDeadlineAtMs)||
    (saved.committedAtMs!==null&&(!integer(saved.committedAtMs)||saved.committedAtMs<saved.decisionAtMs||saved.committedAtMs>now))||
    // PostgreSQL notification delivery may precede the app observing its COMMIT response.
    // These are distinct clocks/stages, not a guaranteed ack -> receipt ordering.
    (saved.workerReceivedAtMs!==null&&(!integer(saved.workerReceivedAtMs)||
      saved.workerReceivedAtMs<round.startMs||saved.workerReceivedAtMs>now+1000))||
    (saved.onTime!==null&&typeof saved.onTime!=="boolean")||
    (saved.onTime===true&&(saved.committedAtMs===null||saved.committedAtMs>saved.hardDeadlineAtMs))||
    typeof saved.lockReason!=="string"||!saved.lockReason||
    typeof saved.earlyBlocker!=="string"||!saved.earlyBlocker||
    typeof saved.ambiguous!=="boolean"||
    !saved.coverage||!integer(saved.coverage.n)||saved.coverage.n<0||
    ![saved.coverage.firstAtMs,saved.coverage.lastAtMs,saved.coverage.maxGapMs]
      .every(value=>value===null||integer(value)&&value>=0)||
    (saved.observationId!==null&&typeof saved.observationId!=="string")||
    (saved.receivedAtMs!==null&&(!integer(saved.receivedAtMs)||saved.receivedAtMs<round.startMs||saved.receivedAtMs>now))||
    (saved.operationalFailure!==null&&typeof saved.operationalFailure!=="string")||
    saved.automaticExecutionAllowed!==false||
    !saved.evidence||typeof saved.evidence!=="object"||Array.isArray(saved.evidence))
    return "TIMED_SAVED_IDENTITY_OR_FIELDS_INVALID";
  if(!gateStrategy&&(saved.targetAtMs!==target||saved.hardDeadlineAtMs!==hard))
    return "TIMED_SAVED_WINDOW_INVALID";
  if(gateStrategy&&(saved.targetAtMs<round.startMs||saved.targetAtMs>round.expiryMs||
    saved.hardDeadlineAtMs<saved.targetAtMs||saved.hardDeadlineAtMs>round.expiryMs+GATE_GRACE_MS))
    return "TIMED_SAVED_GATE_WINDOW_INVALID";

  if(saved.status==="LOCKED"){
    const savedWindowValid=gateStrategy
      ? Number.isSafeInteger(saved.gateIndex)&&saved.gateIndex!>0&&saved.gateScheduledAtMs===round.startMs+saved.gateIndex!*GATE_MS&&
        saved.targetAtMs===saved.gateScheduledAtMs&&saved.hardDeadlineAtMs===saved.gateScheduledAtMs+GATE_GRACE_MS&&
        saved.decisionAtMs>=saved.gateScheduledAtMs&&saved.decisionAtMs<=saved.hardDeadlineAtMs
      : saved.targetAtMs===target&&saved.hardDeadlineAtMs===hard;
    if((saved.side!=="UP"&&saved.side!=="DOWN")||
      !savedWindowValid||
      !validWaterxProbabilityPair(saved.probabilityUp,saved.probabilityDown)||
      !saved.observationId||saved.receivedAtMs===null||saved.coverage.n<1||
      saved.decisionAtMs>=round.expiryMs||
      (saved.receivedAtMs!==null&&saved.receivedAtMs>saved.decisionAtMs)||
      (saved.side==="UP"&&saved.probabilityUp!==null&&saved.probabilityUp<saved.probabilityDown!)||
      (saved.side==="DOWN"&&saved.probabilityDown!==null&&saved.probabilityDown<saved.probabilityUp!))
      return "TIMED_LOCKED_CHOICE_INVALID";
  }else if(saved.side!==null||saved.probabilityUp!==null||saved.probabilityDown!==null||
    (gateStrategy&&(saved.status==="ABSTAINED_NO_QUALIFIED_SIGNAL"||saved.status==="DATA_FAILURE")&&
      (saved.targetAtMs<round.startMs||saved.targetAtMs>round.expiryMs||saved.hardDeadlineAtMs<saved.targetAtMs))){
    return "TIMED_FAILURE_RECORD_HAS_CHOICE";
  }
  return null;
}

function validGateJournal(gate:GateJournal,startMs:number,now:number):boolean{
  const c=gate.components;
  const noEvidence=["MISSED_GATE","INVALID_ROUND","EXECUTION_WINDOW_CLOSED"].includes(gate.result)&&
    c===undefined&&gate.probabilityUp===null&&gate.requirementsMet===0;
  const validComponents=!!c&&typeof c==="object"&&
    [c.sameSideMs,c.requiredSameSideMs,c.validCount,c.requiredCount].every(value=>Number.isSafeInteger(value)&&value>=0)&&
    (c.probabilityRange===null||bounded(c.probabilityRange))&&bounded(c.maximumRange)&&bounded(c.strength)&&bounded(c.requiredStrength);
  return Number.isSafeInteger(gate.gateIndex)&&gate.gateIndex>0&&
    gate.scheduledAtMs===startMs+gate.gateIndex*GATE_MS&&
    Number.isSafeInteger(gate.evaluatedAtMs)&&gate.evaluatedAtMs>=gate.scheduledAtMs&&gate.evaluatedAtMs<=now&&
    gate.evidenceCutoffMs===gate.scheduledAtMs&&
    (gate.result!=="QUALIFIED"||(gate.evaluatedAtMs<=gate.scheduledAtMs+GATE_GRACE_MS&&
      gate.requirementsMet===4&&gate.probabilityUp!==null&&gate.probabilityUp!==.5))&&
    ["QUALIFIED","WAIT_WEAK_EVIDENCE","WAIT_UNSTABLE","WAIT_FRESH_DATA","INVALID_ROUND","MISSED_GATE","EXECUTION_WINDOW_CLOSED"].includes(gate.result)&&
    typeof gate.reason==="string"&&gate.reason.length>0&&
    (gate.decisionId===null||typeof gate.decisionId==="string")&&
    Number.isSafeInteger(gate.requirementsMet)&&gate.requirementsMet>=0&&Number.isSafeInteger(gate.requirementsTotal)&&
    gate.requirementsTotal===4&&gate.requirementsMet<=gate.requirementsTotal&&
    (gate.probabilityUp===null||bounded(gate.probabilityUp))&&(noEvidence||validComponents)&&
    gate.policyVersion===TIMED_STRATEGY&&typeof gate.source==="string"&&gate.calibrationStatus==="UNQUALIFIED"&&
    Array.isArray(gate.observationIds)&&gate.observationIds.length<=10_000&&gate.observationIds.every(id=>typeof id==="string")&&
    (gate.snapshotDigest===undefined||typeof gate.snapshotDigest==="string");
}
export function validateLiveEnvelope(p:LiveSnapshotEnvelope,interval:5|15,previous:LiveSnapshotEnvelope|null=null):string|null{
  const now=serverTime(p),prior=previous?serverTime(previous):NaN;
  if(!Number.isFinite(now)||p.intervalMinutes!==interval)return "INTERVAL_OR_SERVER_TIME_INVALID";
  if(Number.isFinite(prior)&&now<prior)return "SERVER_TIME_REGRESSION";
  const snapshotVersion=p.snapshotVersion??p.decision?.snapshotVersion;
  const previousSnapshotVersion=previous?.snapshotVersion??previous?.decision?.snapshotVersion;
  if(snapshotVersion!==undefined&&(!integer(snapshotVersion)||snapshotVersion<1))return "SNAPSHOT_VERSION_INVALID";
  if(previous&&previousSnapshotVersion!==undefined&&snapshotVersion!==undefined&&previous.round?.id===p.round?.id&&
    previous.round?.startMs===p.round?.startMs&&previous.decision?.streamId===p.decision?.streamId&&
    snapshotVersion<=previousSnapshotVersion)return "SNAPSHOT_VERSION_REGRESSION";
  const projectionVersion=p.projectionVersion??p.decision?.projectionVersion;
  const strategyVersion=p.decision?.strategyVersion;
  if(projectionVersion!==undefined&&(typeof projectionVersion!=="string"||!projectionVersion.trim())||
    strategyVersion!==undefined&&(typeof strategyVersion!=="string"||!strategyVersion.trim()))return "PROJECTION_METADATA_INVALID";
  const timestamps=[p.componentTimestamps,p.decision?.componentTimestamps].filter(Boolean);
  if(timestamps.some(values=>Object.values(values!).some(value=>value!==null&&(!Number.isSafeInteger(value)||value<0))))
    return "PROJECTION_METADATA_INVALID";
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
  const timed=d.timedDecision??null;
  if(timed){
    const timedError=validateTimedDecisionState(timed,d,now);
    if(timedError)return timedError;
  }
  const previousTimed=old?.timedDecision??null;
  if(previousTimed?.saved&&previousTimed.strategyVersion===timed?.strategyVersion&&old?.roundId===d.roundId&&old.startMs===d.startMs&&old.expiryMs===d.expiryMs){
    const priorSaved=previousTimed.saved,currentSaved=timed?.saved;
    if(!currentSaved||currentSaved.id!==priorSaved.id||currentSaved.status!==priorSaved.status||
      currentSaved.side!==priorSaved.side||currentSaved.decisionAtMs!==priorSaved.decisionAtMs||
      currentSaved.probabilityUp!==priorSaved.probabilityUp||
     currentSaved.probabilityDown!==priorSaved.probabilityDown||
     currentSaved.gateIndex!==priorSaved.gateIndex||currentSaved.gateScheduledAtMs!==priorSaved.gateScheduledAtMs||
     currentSaved.targetAtMs!==priorSaved.targetAtMs||currentSaved.hardDeadlineAtMs!==priorSaved.hardDeadlineAtMs)
      return "IMMUTABLE_TIMED_DECISION_REGRESSION";
  }
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
  dataHealth?:WaterxDataHealth;
  projectionVersion:"waterx-exact-round-client-v1";
  sourceProjectionVersion?:string|null;
  intervalMinutes:5|15|null;
  roundIdentity:{id:string;startMs:number;expiryMs:number}|null;
  strategyVersion:string|null;
  snapshotVersion:number|null;
  componentTimestamps:Record<string,number|null>;
  provisionalLean:"UP"|"DOWN"|null;
  lastGate:TimedState["lastGate"]|null;
  nextGateAtMs:number|null;
  savedDecision:RoundDecision["canonical"]|NonNullable<TimedState["saved"]>|null;
  persistenceState:RoundDecision["persistence"]["status"]|null;
};
/** Both current-round cards consume this projection; database reports cannot supply a live lean. */
export function getAtomicDecisionView(p:LiveSnapshotEnvelope|null,interval:5|15,activeRound:LiveSnapshotEnvelope["round"],now:number):AtomicDecisionView{
  const empty=(reason:string,dataHealth?:WaterxDataHealth):AtomicDecisionView=>({
    decision:null,fresh:false,sourceAgeMs:null,lean:null,stage:"WATCHING",score:null,reason,dataHealth,
     projectionVersion:"waterx-exact-round-client-v1",sourceProjectionVersion:null,intervalMinutes:null,roundIdentity:null,strategyVersion:null,
    snapshotVersion:null,componentTimestamps:{},provisionalLean:null,lastGate:null,nextGateAtMs:null,
    savedDecision:null,persistenceState:null,
  });
  if(!Number.isFinite(now))return empty("Current clock unavailable; live state withheld.");
  if(!p)return empty("Waiting for a valid active-round snapshot.");
  if(!activeRound){
    const health=p.dataHealth?.round.status==="ROUND_UNAVAILABLE"?p.dataHealth:undefined;
    return empty(health?dataHealthReason(health):"Waiting for a valid active-round snapshot.",health);
  }
  if(p.round?.id!==activeRound.id||p.round.startMs!==activeRound.startMs||p.round.expiryMs!==activeRound.expiryMs)
    return p.dataHealth?.round.status==="ROUND_UNAVAILABLE"
      ?empty(dataHealthReason(p.dataHealth),p.dataHealth)
      :empty("Round identity mismatch: old-round state withheld.");
  const error=validateDecisionSnapshot(p,interval);
  const exactEnvelopeHealth=p.intervalMinutes===interval&&p.round?.id===activeRound.id&&
    p.round.startMs===activeRound.startMs&&p.round.expiryMs===activeRound.expiryMs?p.dataHealth:undefined;
  if(error)return empty(error.replaceAll("_"," ").toLowerCase(),exactEnvelopeHealth);
  const d=p.decision!,r=p.round!;
  if(now>=d.expiryMs||now<d.startMs)return empty("Round expired or not started; previous state withheld.");
  const receivedHealth=p.dataHealth??d.dataHealth;
  const dataHealth:WaterxDataHealth|undefined=receivedHealth?{
    ...receivedHealth,
    probabilities:{
      ...receivedHealth.probabilities,
      lastValid:receivedHealth.probabilities.lastValid?{
        ...receivedHealth.probabilities.lastValid,
        ageMs:Math.max(0,now-receivedHealth.probabilities.lastValid.receivedAtMs),
      }:null,
    },
  }:undefined;
  if(dataHealth?.probabilities.status==="CURRENT"&&dataHealth.probabilities.lastValid&&
    dataHealth.probabilities.lastValid.ageMs>DECISION_FRESH_MS){
    dataHealth.probabilities.status="PROBABILITIES_STALE";
    if(dataHealth.primaryReason==="CURRENT")dataHealth.primaryReason="PROBABILITIES_STALE";
  }
  const age=d.market?Math.max(now-d.market.receivedAtMs,now-d.market.observedAtMs):null;
  const timed=d.timedDecision??null;
  const healthAllowsFresh=!dataHealth||(dataHealth.transport.status==="HEALTHY"&&dataHealth.probabilities.status==="CURRENT");
  const fresh=healthAllowsFresh&&age!==null&&age>=0&&age<=DECISION_FRESH_MS&&now-d.publishedAtMs>=0&&
    now-d.publishedAtMs<=DECISION_FRESH_MS&&
      (timed?.strategyVersion===TIMED_STRATEGY?timed.sourceAgeMs!==null&&timed.sourceAgeMs<=DECISION_FRESH_MS:d.readiness.components.fresh);
  const reason=dataHealth&&dataHealth.primaryReason!=="CURRENT"?dataHealthReason(dataHealth):
    d.persistence.status==="FAILED"?`Database write failed (${d.persistence.errorClass??"UNKNOWN"}); research choice not committed.`:
     d.persistence.status==="AWAITING_CHOICE"?
       d.persistence.errorClass==="CANONICAL_INPUT_REJECTED"?
         "Canonical checkpoint evidence rejected; awaiting valid exact-round input, not a database failure.":
         "Checkpoint write finished without a frozen canonical choice; capture needs investigation.":
    !d.market?"Waiting for a fresh WaterX observation.":!fresh?
    `Source stale (${Math.max(0,Math.floor((age??0)/1000))}s); last same-round record retained, live lean withheld.`:
    d.persistence.status==="WRITING"?"Database write pending; no committed choice is asserted.":
    d.persistence.status==="QUEUED"?"Checkpoint capture queued; waiting for database persistence.":d.readiness.reason;
  const componentTimestamps:Record<string,number|null>={
    roundStartMs:r.startMs,
    snapshotPublishedAtMs:d.publishedAtMs,
    readinessEvaluatedAtMs:d.readiness.evaluatedAtMs,
    marketObservedAtMs:d.market?.observedAtMs??null,
    marketReceivedAtMs:d.market?.receivedAtMs??null,
    persistenceUpdatedAtMs:d.persistence.updatedAtMs,
    lastGateScheduledAtMs:timed?.lastGate?.scheduledAtMs??null,
    nextGateAtMs:timed?.nextGateAtMs??null,
    ...(d.componentTimestamps??{}),
    ...(p.componentTimestamps??{}),
  };
   const current=timed?.strategyVersion===TIMED_STRATEGY;
   const lean=fresh?(current?timed.liveSide:d.readiness.side):null;
   return {decision:d,fresh,sourceAgeMs:age,lean,
     stage:fresh?(current?(timed.qualified?"READY":lean?"DEVELOPING":"WATCHING"):d.readiness.state):"WATCHING",
     score:fresh?(current?timed.readinessPercent:Math.round(d.readiness.score)):null,
     reason:current?(!fresh?reason:dataHealth&&dataHealth.primaryReason!=="CURRENT"?dataHealthReason(dataHealth):
       timed.persistence==="FAILED"?`Lock write failed (${timed.errorClass??"UNKNOWN"}); no new saved lock.`:
       timed.remainingRequirement??timed.blocker):reason,dataHealth,
     projectionVersion:"waterx-exact-round-client-v1",sourceProjectionVersion:p.projectionVersion??d.projectionVersion??null,
     intervalMinutes:d.intervalMinutes,
    roundIdentity:{id:r.id,startMs:r.startMs,expiryMs:r.expiryMs},
     strategyVersion:d.strategyVersion??timed?.strategyVersion??d.policyVersion,
     snapshotVersion:p.snapshotVersion??d.snapshotVersion??d.stateVersion,componentTimestamps,
     provisionalLean:lean,lastGate:timed?.lastGate??null,nextGateAtMs:timed?.nextGateAtMs??null,
     savedDecision:current?timed.saved:timed?.saved??d.canonical??null,
     persistenceState:current?(timed.persistence==="COMMITTED"?"COMMITTED":
       timed.persistence==="SAVING"?"WRITING":timed.persistence==="FAILED"?"FAILED":"WAITING_CHECKPOINT"):d.persistence.status};
}

/**
 * Shared client projection for the Live Desk and Agent. Identity is always exact-round;
 * optional server projection metadata is retained on the envelope but never weakens v2 guards.
 */
export function projectExactRoundDecision(
  p:LiveSnapshotEnvelope|null, interval:5|15, activeRound:LiveSnapshotEnvelope["round"], now:number,
):AtomicDecisionView {
  return getAtomicDecisionView(p,interval,activeRound,now);
}
