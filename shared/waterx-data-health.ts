import {validWaterxProbabilityPair} from "./round-decision";
export type ProbabilityState="CURRENT"|"PROBABILITIES_MISSING"|"PROBABILITY_PAIR_INVALID"|"PROBABILITIES_STALE";
export type WaterxDataHealth={
  transport:{status:"HEALTHY"|"PROVIDER_TIMEOUT"|"REQUEST_FAILURE";lastReceivedAtMs:number|null;errorClass:string|null};
  round:{status:"KNOWN"|"ROUND_UNAVAILABLE"};
  reference:{status:"CONFIRMED"|"PROVISIONAL"|"UNAVAILABLE"};
  probabilities:{status:ProbabilityState;lastValid:null|{up:number;down:number;receivedAtMs:number;ageMs:number}};
  storage:{status:"FAILED"|"COMMITTED"|"UNKNOWN";errorClass:string|null};
  execution:{eligible:false;reason:string};
  primaryReason:"CURRENT"|"PROVIDER_TIMEOUT"|"REQUEST_FAILURE"|"ROUND_UNAVAILABLE"|
    ProbabilityState|"STORAGE_FAILURE";
};
/** Receipt of metadata is never receipt of probabilities. No inference from asks. */
export function probabilityState(up:unknown,down:unknown,receivedAtMs:number|null,now:number):ProbabilityState{
  if(up==null||down==null)return "PROBABILITIES_MISSING";
  if(!validWaterxProbabilityPair(up,down))return "PROBABILITY_PAIR_INVALID";
  if(receivedAtMs===null||!Number.isFinite(receivedAtMs)||receivedAtMs>now||now-receivedAtMs>10000)
    return "PROBABILITIES_STALE";
  return "CURRENT";
}
export function dataHealthReason(health:WaterxDataHealth):string{
  return ({
    CURRENT:"Current valid WaterX probability pair.",
    PROVIDER_TIMEOUT:"WaterX provider request timed out; current probabilities unavailable.",
    REQUEST_FAILURE:"WaterX provider request failed; current probabilities unavailable.",
    ROUND_UNAVAILABLE:"No verified active WaterX round is available.",
    PROBABILITIES_MISSING:"WaterX probabilities missing; active round metadata is available.",
    PROBABILITY_PAIR_INVALID:"WaterX probability pair invalid; not usable as live evidence.",
    PROBABILITIES_STALE:"WaterX probabilities stale; last observation is not current.",
    STORAGE_FAILURE:"Decision storage failed; no new saved choice is asserted.",
  })[health.primaryReason];
}
