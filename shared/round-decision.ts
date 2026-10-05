import type {LockReadiness} from "./lock-readiness";

export type RoundDecision = {
  network:"sui:mainnet"; intervalMinutes:5|15; roundId:string; startMs:number; expiryMs:number;
  policyVersion:string; stateVersion:number; updatedAtMs:number; publishedAtMs:number;
  readiness:LockReadiness;
  canonical:null|{side:"UP"|"DOWN";probabilityUp:number;decisionAtMs:number;committedAtMs:number|null};
  latestSafeOrderAtMs:null; executionWindowRemainingMs:null;
  executionBlocker:string; tradeAllowed:false;
  timestampSemantics:"Application receipt/evaluation/publication clocks; provider odds time unknown; commit is application acknowledgement";
};