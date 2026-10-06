import {TIMED_STRATEGY,type TimedDecision} from "../../shared/timed-decision";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
import type {ExecutionEvidence} from "./risk";

/** A committed gate decision is eligible without champion/model qualification.
 * Neither a provisional lean nor an abstention can be upgraded into authority. */
export function experimentalFinalSignal(d:TimedDecision,nowMs:number):ExecutionEvidence["signal"] {
  if(d.strategyVersion!==TIMED_STRATEGY||d.network!=="sui:mainnet"||d.status!=="LOCKED"||
    !["UP","DOWN"].includes(d.side??"")||d.onTime!==true||d.acknowledgementStatus!=="JOURNALED"||
    d.committedAtMs===null||d.committedAtMs>d.hardDeadlineAtMs||d.committedAtMs>nowMs||
    !Number.isSafeInteger(d.gateIndex)||d.gateIndex!<1||
    d.gateScheduledAtMs!==d.startMs+d.gateIndex!*30000||
    d.decisionAtMs<d.gateScheduledAtMs!||d.decisionAtMs>d.hardDeadlineAtMs||
    d.decisionAtMs>=d.expiryMs||nowMs<d.startMs||nowMs>=d.expiryMs||
    d.expiryMs-d.startMs!==d.intervalMinutes*60000||
    !validWaterxProbabilityPair(d.probabilityUp,d.probabilityDown)||
    d.probabilityUp===d.probabilityDown)return null;
  if(d.side==="UP"?d.probabilityUp!<d.probabilityDown!:d.probabilityDown!<d.probabilityUp!)return null;
  return {source:"EXPERIMENTAL_QUALIFICATION_GATES",qualified:true,frozen:true,
    atMs:d.committedAtMs,roundId:d.roundId,interval:d.intervalMinutes,startMs:d.startMs,
    expiryMs:d.expiryMs,side:d.side!,probability:d.side==="UP"?d.probabilityUp!:d.probabilityDown!};
}
