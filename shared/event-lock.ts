import {evaluateTimedDecision, TIMED_STRATEGY, type TimedRound, type TimedDecision, type TimedState} from "./timed-decision";
import type {LockObservation} from "./lock-readiness";

/** Shadow-only: changing observation timing does not qualify a forecast or authorize an order. */
export const EVENT_LOCK_STRATEGY = "waterx-event-lock-v1";
export const EVENT_FEATURE_VERSION = "waterx-event-trajectory-v1";
export type EventObservation = LockObservation & {
  id:string; availableAtMs:number; databaseAcceptedAtMs:number|null;
  provenance:"PROSPECTIVE"|"SYNTHETIC";
  features:Record<string,unknown>;
};
export type EventLockProjection = TimedRound & {
  strategyVersion:typeof EVENT_LOCK_STRATEGY; benchmarkVersion:typeof TIMED_STRATEGY;
  shadowOnly:true; activePolicyChanged:false; automaticExecutionAllowed:false;
  state:"WATCHING"|"LEANING_UP"|"LEANING_DOWN"|"SAVING"|"LOCKED_UP"|"LOCKED_DOWN"|"ROUND_COMPLETE";
  qualification:TimedState; saved:TimedDecision|null; firstQualifiedAtMs:number|null;
  persistence:"OBSERVING"|"SAVING"|"COMMITTED"|"UNKNOWN"|"FAILED";
  blocker:string; acceptedObservations:number; duplicateDeliveries:number;
  outOfOrderInputs:number; droppedInputs:number; postLockObservations:number;
};
export function eventQualification(round:TimedRound,observations:readonly EventObservation[],now:number){
  const latest=observations.at(-1);
  // An outage is a veto/reset, not evidence that the last valid price remained available.
  let lastFailure=-1;
  observations.forEach((o,i)=>{if(!o.sourceHealthy||o.features.eventGapResetAtMs)lastFailure=i;});
  const eligible=observations.slice(lastFailure+1).filter(o=>o.availableAtMs<=now);
  const state=evaluateTimedDecision(round,eligible,now);
  state.strategyVersion=EVENT_LOCK_STRATEGY;
  if(!latest?.sourceHealthy){
    state.qualified=false;state.blocker="NO_VALID_PROBABILITY_INPUT";
    state.liveSide=null;state.liveProbabilityUp=null;state.requirementsMet=0;state.readinessPercent=0;
  }
  state.remainingRequirement=state.qualified?"Evidence qualifies; saving decision":
    state.components?.recentReversals?"Recent reversal—rebuilding persistence":state.remainingRequirement;
  return state;
}
