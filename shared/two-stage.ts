import type {EventObservation} from "./event-lock";
import type {TimedRound} from "./timed-decision";
import type {EntryEconomics} from "./lock-economics";
export const PREVIOUS_TWO_STAGE_STRATEGY="waterx-two-stage-shadow-v1";
export const TWO_STAGE_STRATEGY="waterx-two-stage-shadow-v2";
export const TWO_STAGE_FEATURES="price-area-proxy-v1";
export type LockStage="EARLY"|"CONFIRMATION";
export type ResearchPreference={mode:"PREFERRED"|"REQUIRED";collateralUsd:number;minimumReturnUsd:number;preferredReturnUsd:number};
export type StageDiagnostics={message:string;measurements:Record<string,unknown>;thresholds:Record<string,unknown>};
export type StageTiming={receivedAtMs:number;acceptedAtMs:number;qualifiedAtMs:number|null;
  acquisitionStartedAtMs:number|null;acquiredAtMs:number|null;commitAcknowledgedAtMs:number|null;projectionAtMs:number|null};
export type StageLock=TimedRound&{
  id:string;network:"sui:mainnet";marketId:string;strategyVersion:string;stage:LockStage;side:"UP"|"DOWN";
  evidenceCutoffMs:number;qualifiedAtMs:number;committedAtMs:number|null;commitVerified?:true;
  elapsedMs:number;remainingMs:number;probabilityUp:number;probabilitySource:string;
  calibrationStatus:"UNQUALIFIED"|"QUALIFIED";modelVersion:string|null;
  policyVersion:string;featureVersion:string;observationIds:string[];
  economics:EntryEconomics;reference:unknown;coverage:unknown;features:unknown;
  captureMode:"PROSPECTIVE"|"SYNTHETIC";automaticExecutionAllowed:false;shadowOnly:true;
  researchPreference?:ResearchPreference;valueStatus?:"MET"|"BELOW_PREFERRED"|"UNAVAILABLE";
  diagnostics?:StageDiagnostics;timing?:StageTiming;
};
export type StageState={lock:StageLock|null;persistence:"OBSERVING"|"SAVING"|"COMMITTED"|"UNKNOWN"|"FAILED";reason:string;
  diagnostics?:StageDiagnostics;timing?:StageTiming};
export type TwoStageProjection=TimedRound&{
  strategyVersion:typeof TWO_STAGE_STRATEGY;marketId:string;shadowOnly:true;automaticExecutionAllowed:false;
  early:StageState;confirmation:StageState;
  relationship:"Agrees with Early Lock"|"Changed direction"|"No confirmation"|"No early decision";
  priceFeatures:unknown;settlementRule:unknown;
  researchPreference?:ResearchPreference;policyRegistry?:unknown;researchActivated?:false;
};
export type TwoStageRoundRow=TimedRound&{
  marketId:string;early:StageLock|null;confirmation:StageLock|null;
  relationship:TwoStageProjection["relationship"];outcome:"UP"|"DOWN"|null;
  disputed:boolean;dataFailure:boolean;earlyReason:string;confirmationReason:string;
  strategyVersion?:string;
  captureBuildId?:string;
  settlementStatus?:import("./waterx-round-identity").SettlementStatus;
  settlementReason?:string|null;
  settlementEvidence?:{
    source:"OFFICIAL_WATERX_PROVIDER_ADAPTER";
    roundId:string;intervalMinutes:5|15;startMs:number;expiryMs:number;
    verifiedAtMs:number|null;settledAtMs:number|null;anchorPrice:number|null;settlePrice:number|null;
    providerResolutionStatus?:string|null;provisionalOutcome?:string|null;unverifiedPriceDirection?:string|null;
    unassociatedDisplay?:unknown;
    latestProviderEvidence?:unknown;
    retry?:{attempts?:number;nextAttemptAtMs?:number;lastError?:string|null}|null;
    note:string;
  };
  earlyScore?:import("./waterx-round-identity").StageScore;
  confirmationScore?:import("./waterx-round-identity").StageScore;
  earlyCaptureCause?:import("./stage-capture-status").StageCaptureCause;
  confirmationCaptureCause?:import("./stage-capture-status").StageCaptureCause;
  sourceIncident?:boolean;
};
export type StageStats={
  correct:number;incorrect:number;pending:number;disputed:number;scoredN:number;accuracy:number|null;
  locks:number;cohortN:number;coverage:number|null;medianElapsedMs:number|null;p90ElapsedMs:number|null;
  brier:number|null;calibration:unknown;indicativeN:number;verifiedQuoteN:number;
  actualTradingPnl:null;
  earlyWindows?:{seconds:number;locks:number;rate:number|null}[];
  timingN?:number;timingUnknownN?:number;timingBasis?:string;
  noLockN?:number;abstainedN?:number;dataFailureN?:number;withheldN?:number;
  unclassifiedN?:number;observingN?:number;
};
export type TwoStageHistory={
  settlementHealth?:{
    cohortN:number;verified:number;pending:number;disputed:number;missing:number;unverified:number;
    identityMismatch:number;coverage:number|null;
    unresolved:{roundId:string;intervalMinutes:5|15;status:string;reason:string}[];
  };
  strategyVersion:string;asOfMs:number;shadowOnly:true;activeStrategy:string;
  cohort:{interval:string;window:string;timezoneOffsetMinutes:number;denominator:string;cohortN:number};
  early:StageStats;confirmation:StageStats;
  paired:Record<"BOTH_CORRECT"|"EARLY_WRONG_CONFIRMATION_CORRECT"|"EARLY_CORRECT_CONFIRMATION_WRONG"|"BOTH_WRONG"|"BOTH_PENDING_OR_DISPUTED"|"EARLY_ONLY"|"CONFIRMATION_ONLY"|"NEITHER",number>;
  dataFailureRate:number|null;missingRecordRate:number|null;expectedCohortN:number|null;
  missingRecordDenominator?:string;
  rows:TwoStageRoundRow[];rowsTruncated:boolean;learning:unknown;comparison:unknown;
  breakdown?:unknown;
  pairedRates?:{scoredN:number;earlyAccuracy:number|null;confirmationAccuracy:number|null;agreementN:number;disagreementN:number};
};
export function stageRelationship(early:StageLock|null,confirmation:StageLock|null):TwoStageProjection["relationship"]{
  if(!early)return "No early decision";
  if(!confirmation)return "No confirmation";
  return early.side===confirmation.side?"Agrees with Early Lock":"Changed direction";
}
export type StageInput=TimedRound&{marketId:string;observations:readonly EventObservation[];nowMs:number;
  researchPreference?:ResearchPreference;priceObservations?:readonly import("./price-area").PricePoint[];
  earlyPolicyVersion?:string};
