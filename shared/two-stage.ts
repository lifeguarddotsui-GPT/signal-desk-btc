import type {EventObservation} from "./event-lock";
import type {TimedRound} from "./timed-decision";
import type {EntryEconomics} from "./lock-economics";
export const TWO_STAGE_STRATEGY="waterx-two-stage-shadow-v1";
export const TWO_STAGE_FEATURES="price-area-proxy-v1";
export type LockStage="EARLY"|"CONFIRMATION";
export type StageLock=TimedRound&{
  id:string;network:"sui:mainnet";marketId:string;strategyVersion:string;stage:LockStage;side:"UP"|"DOWN";
  evidenceCutoffMs:number;qualifiedAtMs:number;committedAtMs:number|null;commitVerified?:true;
  elapsedMs:number;remainingMs:number;probabilityUp:number;probabilitySource:string;
  calibrationStatus:"UNQUALIFIED"|"QUALIFIED";modelVersion:string|null;
  policyVersion:string;featureVersion:string;observationIds:string[];
  economics:EntryEconomics;reference:unknown;coverage:unknown;features:unknown;
  captureMode:"PROSPECTIVE"|"SYNTHETIC";automaticExecutionAllowed:false;shadowOnly:true;
};
export type StageState={lock:StageLock|null;persistence:"OBSERVING"|"SAVING"|"COMMITTED"|"UNKNOWN"|"FAILED";reason:string};
export type TwoStageProjection=TimedRound&{
  strategyVersion:typeof TWO_STAGE_STRATEGY;marketId:string;shadowOnly:true;automaticExecutionAllowed:false;
  early:StageState;confirmation:StageState;
  relationship:"Agrees with Early Lock"|"Changed direction"|"No confirmation"|"No early decision";
  priceFeatures:unknown;settlementRule:unknown;
};
export type TwoStageRoundRow=TimedRound&{
  marketId:string;early:StageLock|null;confirmation:StageLock|null;
  relationship:TwoStageProjection["relationship"];outcome:"UP"|"DOWN"|null;
  disputed:boolean;dataFailure:boolean;earlyReason:string;confirmationReason:string;
};
export type StageStats={
  correct:number;incorrect:number;pending:number;disputed:number;scoredN:number;accuracy:number|null;
  locks:number;cohortN:number;coverage:number|null;medianElapsedMs:number|null;p90ElapsedMs:number|null;
  brier:number|null;calibration:unknown;indicativeN:number;verifiedQuoteN:number;
  actualTradingPnl:null;
};
export type TwoStageHistory={
  strategyVersion:string;asOfMs:number;shadowOnly:true;activeStrategy:string;
  cohort:{interval:string;window:string;timezoneOffsetMinutes:number;denominator:string;cohortN:number};
  early:StageStats;confirmation:StageStats;
  paired:Record<"BOTH_CORRECT"|"EARLY_WRONG_CONFIRMATION_CORRECT"|"EARLY_CORRECT_CONFIRMATION_WRONG"|"BOTH_WRONG"|"BOTH_PENDING_OR_DISPUTED"|"EARLY_ONLY"|"CONFIRMATION_ONLY"|"NEITHER",number>;
  dataFailureRate:number|null;missingRecordRate:number|null;expectedCohortN:number|null;
  missingRecordDenominator?:string;
  rows:TwoStageRoundRow[];rowsTruncated:boolean;learning:unknown;comparison:unknown;
};
export function stageRelationship(early:StageLock|null,confirmation:StageLock|null):TwoStageProjection["relationship"]{
  if(!early)return "No early decision";
  if(!confirmation)return "No confirmation";
  return early.side===confirmation.side?"Agrees with Early Lock":"Changed direction";
}
export type StageInput=TimedRound&{marketId:string;observations:readonly EventObservation[];nowMs:number};
