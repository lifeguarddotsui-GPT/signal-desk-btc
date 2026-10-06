import {validWaterxProbabilityPair} from "./round-decision";
import type {LockObservation} from "./lock-readiness";
export const LEGACY_TIMED_STRATEGY="waterx-timed-baseline-v1";
export const PREVIOUS_TIMED_STRATEGY="waterx-early-baseline-v2";
export const TIMED_STRATEGY="waterx-qualification-gates-v3";
export const isTimedStrategy=(value:string)=>[TIMED_STRATEGY,PREVIOUS_TIMED_STRATEGY,LEGACY_TIMED_STRATEGY].includes(value);
export const GATE_MS=30000,GATE_GRACE_MS=2000;
export type GateResult="QUALIFIED"|"WAIT_WEAK_EVIDENCE"|"WAIT_UNSTABLE"|"WAIT_FRESH_DATA"|"INVALID_ROUND"|"MISSED_GATE"|"EXECUTION_WINDOW_CLOSED";
export type GateJournal={gateIndex:number;scheduledAtMs:number;evaluatedAtMs:number;evidenceCutoffMs:number;
  network?:"sui:mainnet";intervalMinutes?:5|15;roundId?:string;startMs?:number;expiryMs?:number;
  result:GateResult;reason:string;decisionId:string|null;requirementsMet:number;requirementsTotal:number;
  probabilityUp:number|null;components:TimedState["components"];policyVersion:string;source:string;
  calibrationStatus:"UNQUALIFIED";observationIds:string[];snapshotDigest?:string;
  receivedAtMs?:number|null;providerSourceAtMs?:number|null;modelVersion?:string|null;featureVersion?:string;
  evidenceSnapshot?:Record<string,unknown>};
export type PredictionLifecycle="OBSERVING"|"LEANING_UP"|"LEANING_DOWN"|"QUALIFIED"|"SAVING"|
  "LOCKED_UP"|"LOCKED_DOWN"|"RESULT_PENDING"|"CORRECT"|"INCORRECT"|"DISPUTED";
export type TimedRound={intervalMinutes:5|15;roundId:string;startMs:number;expiryMs:number};
export type TimedDecision={
  id:string;strategyVersion:string;network:"sui:mainnet";intervalMinutes:5|15;roundId:string;
  startMs:number;expiryMs:number;status:"LOCKED"|"NO_VALID_INPUT"|"MISSED_DEADLINE"|"ABSTAINED_NO_QUALIFIED_SIGNAL"|"DATA_FAILURE";
  side:"UP"|"DOWN"|null;probabilityUp:number|null;probabilityDown:number|null;
  observationId:string|null;receivedAtMs:number|null;decisionAtMs:number;elapsedMs:number;
  targetAtMs:number;hardDeadlineAtMs:number;lockReason:string;earlyBlocker:string;
  ambiguous:boolean;coverage:{n:number;firstAtMs:number|null;lastAtMs:number|null;maxGapMs:number|null};
  committedAtMs:number|null;workerReceivedAtMs:number|null;onTime:boolean|null;
  operationalFailure:string|null;automaticExecutionAllowed:false;
  acknowledgementStatus?:"JOURNALED"|"UNJOURNALED"|"UNKNOWN";
  evidence:Record<string,unknown>;
  gateIndex?:number;gateScheduledAtMs?:number;
};
export type TimedState={
  strategyVersion:string;targetAtMs:number;hardDeadlineAtMs:number;elapsedMs:number;
  timeProgress:number;phase:"OBSERVING"|"EVALUATING"|"DEADLINE"|"EXPIRED";
  readinessPercent:number;qualified:boolean;blocker:string;liveSide:"UP"|"DOWN"|null;
  liveProbabilityUp:number|null;sourceAgeMs:number|null;
  persistence:"WAITING"|"SAVING"|"FAILED"|"COMMITTED";errorClass:string|null;saved:TimedDecision|null;
  components?:{sameSideMs:number;requiredSameSideMs:number;validCount:number;requiredCount:number;
    probabilityRange:number|null;maximumRange:number;strength:number;requiredStrength:number;
    trendKind?:"STRENGTHENING"|"FLAT_STABLE"|"OSCILLATING"|"RECENT_REVERSAL"|"MISSING";
    recentReversals?:number};
  lifecycle?:PredictionLifecycle;remainingRequirement?:string;
  nextGateAtMs?:number|null;lastGate?:GateJournal|null;requirementsMet?:number;requirementsTotal?:number;
  policySource?:string;executionCutoffAtMs?:number|null;
};
export function timedWindow(interval:5|15,strategyVersion=TIMED_STRATEGY){
  if(!isTimedStrategy(strategyVersion))throw new Error("Unknown timed policy version");
  if(strategyVersion===LEGACY_TIMED_STRATEGY)
    return interval===5?{targetSeconds:120,hardSeconds:150}:{targetSeconds:300,hardSeconds:450};
  if(strategyVersion===PREVIOUS_TIMED_STRATEGY)
    return interval===5?{targetSeconds:60,hardSeconds:90}:{targetSeconds:180,hardSeconds:300};
  return {targetSeconds:interval===5?60:180,hardSeconds:interval*60};
}
export const earlyHorizons=(interval:5|15)=>Array.from({length:interval*2-1},(_,i)=>(i+1)*30);
/** Pinned independently of the legacy canonical/adaptive policy. This is not calibration. */
export function timedPolicy(interval:5|15){
  return {version:TIMED_STRATEGY,maxAgeMs:10000,maxGapMs:12000,earlyStrength:.72,
    earlyPersistenceMs:interval===5?24000:45000,stabilityWindowMs:15000,maxRange:.045,minObservations:3};
}
export function evaluateTimedDecision(round:TimedRound,observations:readonly LockObservation[],now:number):TimedState{
  if(!Number.isSafeInteger(now)||round.expiryMs-round.startMs!==round.intervalMinutes*60000)
    throw new Error("Invalid timed strategy identity/clock");
  const w=timedWindow(round.intervalMinutes),p=timedPolicy(round.intervalMinutes);
  const targetAtMs=round.startMs+w.targetSeconds*1000,hardDeadlineAtMs=round.startMs+w.hardSeconds*1000;
  const rows=observations.filter(o=>Number.isSafeInteger(o.receivedAtMs)&&o.receivedAtMs>=round.startMs&&
    o.receivedAtMs<=now&&o.receivedAtMs<round.expiryMs&&o.sourceHealthy&&
    validWaterxProbabilityPair(o.probabilityUp,o.probabilityDown)).slice().sort((a,b)=>a.receivedAtMs-b.receivedAtMs);
  const sideOf=(o:LockObservation)=>o.probabilityUp===o.probabilityDown?null:o.probabilityUp>o.probabilityDown?"UP":"DOWN";
  const latest=rows.at(-1),side=latest?sideOf(latest):null;
  const age=latest?now-latest.receivedAtMs:null,fresh=age!==null&&age<=p.maxAgeMs;
  let since=latest?.receivedAtMs??now;
  for(let i=rows.length-2;i>=0;i--){
    if(rows[i+1].receivedAtMs-rows[i].receivedAtMs>p.maxGapMs||
      sideOf(rows[i])!==side)break;
    since=rows[i].receivedAtMs;
  }
  const recent=rows.filter(o=>o.receivedAtMs>=now-p.stabilityWindowMs);
  const range=recent.length?Math.max(...recent.map(o=>o.probabilityUp))-Math.min(...recent.map(o=>o.probabilityUp)):null;
  const strength=latest?Math.max(latest.probabilityUp,latest.probabilityDown):0;
   const persistent=side!==null&&!!latest&&latest.receivedAtMs-since>=p.earlyPersistenceMs;
  const strengthening=side!==null&&recent.length>=p.minObservations&&recent.every((o,i)=>
    sideOf(o)===side&&(i===0||(side==="UP"?o.probabilityUp>=recent[i-1].probabilityUp:o.probabilityUp<=recent[i-1].probabilityUp)));
  const recentReversal=recent.some(o=>sideOf(o)!==side);
  const recentReversals=recent.slice(1).filter((o,i)=>sideOf(o)!==sideOf(recent[i])).length;
   const stable=side!==null&&!recentReversal&&recent.length>=p.minObservations&&range!==null&&(range<=p.maxRange||strengthening);
  const blocker=!latest?"NO_VALID_PROBABILITY_INPUT":!fresh?"SOURCE_STALE":side===null?"AMBIGUOUS_TIE":
    strength<p.earlyStrength?"DIRECTIONAL_SEPARATION_BELOW_POLICY":!persistent?
    "SAME_SIDE_PERSISTENCE_INCOMPLETE":!stable?"STABILITY_WINDOW_INCOMPLETE":"CONDITIONS_SATISFIED";
  const qualified=now<round.expiryMs&&side!==null&&fresh&&strength>=p.earlyStrength&&persistent&&stable;
   const remainingRequirement=!latest?"Needs valid WaterX probabilities":!fresh?"Needs a fresh observation":
     side===null?"Exact tie remains ambiguous":
    strength<p.earlyStrength?`Needs directional strength ${p.earlyStrength.toFixed(2)}; currently ${strength.toFixed(2)}`:
    !persistent?`Needs ${Math.ceil((p.earlyPersistenceMs-(latest.receivedAtMs-since))/1000)} seconds more same-side evidence`:
    !stable?recent.length<p.minObservations?`Needs ${p.minObservations-recent.length} more valid observations`:
      recentReversal?"Waiting after a recent direction reversal":`Waiting for stable or same-side strengthening evidence`:
      side===null?"Exact tie remains ambiguous":"Evidence qualifies; evaluated only at a scheduled gate";
  return {strategyVersion:TIMED_STRATEGY,targetAtMs,hardDeadlineAtMs,elapsedMs:Math.max(0,now-round.startMs),
    timeProgress:Math.max(0,Math.min(1,(now-round.startMs)/(hardDeadlineAtMs-round.startMs))),
    phase:now>=round.expiryMs?"EXPIRED":now>=targetAtMs?"EVALUATING":"OBSERVING",
    readinessPercent:Math.round(25*Number(fresh)+25*Number(strength>=p.earlyStrength)+25*Number(persistent)+25*Number(stable)),
    qualified,blocker,liveSide:fresh?side:null,liveProbabilityUp:fresh&&side!==null?latest!.probabilityUp:null,sourceAgeMs:age,
    lifecycle:qualified?"QUALIFIED":fresh&&side!==null?side==="UP"?"LEANING_UP":"LEANING_DOWN":"OBSERVING",remainingRequirement,
    nextGateAtMs:(Math.floor((now-round.startMs)/GATE_MS)+1)*GATE_MS+round.startMs<round.expiryMs?
      (Math.floor((now-round.startMs)/GATE_MS)+1)*GATE_MS+round.startMs:null,
    lastGate:null,requirementsMet:Math.round(4*(Number(fresh)+Number(strength>=p.earlyStrength)+Number(persistent)+Number(stable))/4),
    requirementsTotal:4,policySource:"experimental market-based policy",executionCutoffAtMs:null,
    components:{sameSideMs:latest?latest.receivedAtMs-since:0,requiredSameSideMs:p.earlyPersistenceMs,
      validCount:recent.length,requiredCount:p.minObservations,probabilityRange:range,maximumRange:p.maxRange,
      strength,requiredStrength:p.earlyStrength,recentReversals,
      trendKind:recent.length<p.minObservations?"MISSING":recentReversal?"RECENT_REVERSAL":
        strengthening&&range!==null&&range>p.maxRange?"STRENGTHENING":
        range!==null&&range<=p.maxRange?"FLAT_STABLE":"OSCILLATING"},
    persistence:"WAITING",errorClass:null,saved:null};
}
