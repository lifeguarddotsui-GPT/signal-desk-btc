import {eventQualification, type EventObservation} from "./event-lock";
import type {TimedRound} from "./timed-decision";

/** New *prospective* challenger policy, not a rewrite of v3 gate decisions. */
export const V4_CONFIRMATION_STRATEGY = "waterx-event-confirmation-v4";
export const V4_CONFIRMATION_POLICY = "unchanged-v3-strength-persistence-stability-v4-event-clock";
export const V4_MIN_RESEARCH_LEAD_MS = 30_000;
export const V4_MAX_RECEIPT_AGE_MS = 10_000;
export const V4_MAX_OBSERVATIONS = 64;
export type V4Result = {
  eligible: boolean;
  blocker: string;
  side: "UP"|"DOWN"|null;
  probabilityUp: number|null;
  evaluatedAtMs: number;
  remainingMs: number;
  observations: number;
  evidenceCutoffMs: number|null;
  readinessPercent: number;
  timingBasis: "ACTUAL_APPLICATION_RECEIPT_AND_AVAILABILITY";
  automaticExecutionAllowed: false;
  shadowOnly: true;
};

/** No callbacks, provider requests, timeouts, retrospective snapshots or DB access.
 * Evaluate only data available to the application at this real clock instant.
 * This is a market-evidence policy, not a calibrated win probability. */
export function assessV4Confirmation(round:TimedRound, inputs:readonly EventObservation[], now:number):V4Result{
  const validIdentity=(round.intervalMinutes===5||round.intervalMinutes===15)&&!!round.roundId&&
    Number.isSafeInteger(round.startMs)&&Number.isSafeInteger(round.expiryMs)&&
    round.expiryMs-round.startMs===round.intervalMinutes*60_000;
  const base=(blocker:string,readinessPercent=0):V4Result=>({
    eligible:false,blocker,side:null,probabilityUp:null,evaluatedAtMs:now,
    remainingMs:Number.isFinite(round.expiryMs-now)?Math.max(0,round.expiryMs-now):0,
    observations:inputs.length,evidenceCutoffMs:null,readinessPercent,
    timingBasis:"ACTUAL_APPLICATION_RECEIPT_AND_AVAILABILITY",
    automaticExecutionAllowed:false,shadowOnly:true
  });
  if(!validIdentity||!Number.isSafeInteger(now)||now<round.startMs)return base("INVALID_ROUND_CLOCK");
  if(now>=round.expiryMs)return base("ROUND_EXPIRED");
  if(round.expiryMs-now<V4_MIN_RESEARCH_LEAD_MS)return base("RESEARCH_ENTRY_WINDOW_CLOSED");
  if(inputs.length>V4_MAX_OBSERVATIONS)return base("OBSERVATION_LIMIT_EXCEEDED");
  if(!inputs.length)return base("NO_PROSPECTIVE_OBSERVATIONS");
  let previous=-Infinity;
  for(const input of inputs){
    if(input.provenance!=="PROSPECTIVE"||!Number.isSafeInteger(input.receivedAtMs)||
      !Number.isSafeInteger(input.availableAtMs)||input.receivedAtMs<round.startMs||
      input.receivedAtMs>=round.expiryMs||input.receivedAtMs>now||input.availableAtMs>now||
      input.availableAtMs<input.receivedAtMs||input.receivedAtMs<=previous)
      return base("UNVERIFIABLE_RECEIPT_ORDER_OR_AVAILABILITY");
    previous=input.receivedAtMs;
  }
  const latest=inputs.at(-1)!;
  if(!latest.sourceHealthy||latest.features.sourceFailure||latest.features.eventGapResetAtMs)
    return base("SOURCE_FAILURE_RESETS_PERSISTENCE");
  if(now-latest.receivedAtMs>V4_MAX_RECEIPT_AGE_MS||now-latest.availableAtMs>V4_MAX_RECEIPT_AGE_MS)
    return base("LATEST_ODDS_STALE");
  const result=eventQualification(round,inputs,now);
  if(!result.qualified||!result.liveSide)return base(result.blocker,result.readinessPercent);
  return {...base("QUALIFIED",result.readinessPercent),eligible:true,blocker:"QUALIFIED",
    side:result.liveSide,probabilityUp:result.liveProbabilityUp,
    evidenceCutoffMs:now};
}
