import type {LockReadiness} from "./lock-readiness";
import type {EarlyDecision,OpportunityContext} from "./manual-opportunity";
import type {TimedState} from "./timed-decision";

/** Match the stored adaptive observation CHECK; never normalize an invalid pair into evidence. */
export function validWaterxProbabilityPair(up:unknown,down:unknown):boolean{
  return typeof up==="number"&&typeof down==="number"&&Number.isFinite(up)&&Number.isFinite(down)&&
    up>=0&&up<=1&&down>=0&&down<=1&&Math.abs(up+down-1)<0.000001;
}

export type RoundDecision = {
  format:"waterx-live-decision-v2"; streamId:string;
  network:"sui:mainnet"; intervalMinutes:5|15; roundId:string; startMs:number; expiryMs:number;
  policyVersion:string; stateVersion:number; updatedAtMs:number; publishedAtMs:number;
  projectionVersion?:"waterx-timed-projection-v1";strategyVersion?:string;snapshotVersion?:number;
   currentStrategy?:{
     strategyVersion:string;modelVersion:null;calibrationVersion:null;
     probabilitySource:"WaterX market";modelForecast:null;
     leanVersion:string;provisionalLean:"UP"|"DOWN"|null;
     state:"WATCHING"|"LEANING_UP"|"LEANING_DOWN"|"SAVING"|"LOCKED_UP"|"LOCKED_DOWN"|"ROUND_COMPLETE";
     result:null;
   };
  componentTimestamps?:{decisionSnapshotAtMs:number;probabilitiesReceivedAtMs:number|null;persistenceAtMs:number};
  readiness:LockReadiness;
  market:null|{probabilityUp:number;probabilityDown:number;observedAtMs:number;
    receivedAtMs:number;providerOddsAtMs:null};
  persistence:{status:"WAITING_CHECKPOINT"|"QUEUED"|"WRITING"|"FAILED"|"AWAITING_CHOICE"|"COMMITTED";
    updatedAtMs:number;errorClass:string|null};
  canonical:null|{side:"UP"|"DOWN";probabilityUp:number;decisionAtMs:number;committedAtMs:number|null};
  earlyDecision?:EarlyDecision|null;
  timedDecision?:TimedState|null;
  eventChallenger?:import("./event-lock").EventLockProjection|null;
  twoStage?:import("./two-stage").TwoStageProjection|null;
  earlyPersistence?:{status:"DEVELOPING"|"SAVING"|"FAILED"|"SAVED";errorClass:string|null};
  opportunity?:OpportunityContext|null;
  componentHealth?:{priceFeed:"AVAILABLE"|"UNAVAILABLE";decisionService:"AVAILABLE"|"STALE"|"UNAVAILABLE";
    storage:"UNKNOWN"|"FAILED"|"COMMITTED";orderAdapter:"UNVERIFIED"};
  dataHealth?:import("./waterx-data-health").WaterxDataHealth;
  latestSafeOrderAtMs:null; executionWindowRemainingMs:null;
  executionBlocker:string; tradeAllowed:false;
  timestampSemantics:"Application receipt/evaluation/publication clocks; provider odds time unknown; commit is application acknowledgement";
};