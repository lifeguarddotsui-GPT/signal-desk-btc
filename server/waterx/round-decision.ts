import {lockPolicy,type LockObservation} from "../../shared/lock-readiness";
import type {RoundDecision} from "../../shared/round-decision";
import {evaluateLockReadiness} from "./lock-readiness";

type Identity={intervalMinutes:5|15;roundId:string;startMs:number;expiryMs:number};
type Entry={identity:Identity;observations:LockObservation[];version:number;updatedAtMs:number;
  canonical:RoundDecision["canonical"]};
const key=(r:Identity)=>`${r.intervalMinutes}:${r.roundId}:${r.startMs}:${r.expiryMs}`;

/** Source-driven progress must not wait for pooled database reporting queries.
 * This is disposable display evidence, NEVER execution authority or durable choice storage. */
export function createRoundDecisionTracker(){
  const entries=new Map<number,Entry>();
  let version=0;
  return {
    observe(identity:Identity,observation:LockObservation){
      if(!identity.roundId||identity.expiryMs-identity.startMs!==identity.intervalMinutes*60000||
        !Number.isSafeInteger(observation.atMs)||observation.atMs<identity.startMs||
        observation.atMs>=identity.expiryMs)return;
      let entry=entries.get(identity.intervalMinutes);
      if(entry&&identity.startMs<entry.identity.startMs)return; // delayed old-round response
      if(!entry||key(entry.identity)!==key(identity)){
        entry={identity:{...identity},observations:[],version:++version,updatedAtMs:observation.atMs,canonical:null};
        entries.set(identity.intervalMinutes,entry);
      }
      const last=entry.observations.at(-1);
      if(last&&(last.atMs>=observation.atMs||last.receivedAtMs>=observation.receivedAtMs))return;
      entry.observations.push({...observation});
      entry.observations=entry.observations.filter(o=>o.atMs>=observation.atMs-120000).slice(-180);
      entry.updatedAtMs=observation.atMs;entry.version=++version;
    },
    committed(identity:Identity,canonical:NonNullable<RoundDecision["canonical"]>){
      const entry=entries.get(identity.intervalMinutes);
      if(!entry||key(entry.identity)!==key(identity)||entry.canonical||
        canonical.decisionAtMs<identity.startMs||canonical.decisionAtMs>=identity.expiryMs||
        (canonical.committedAtMs!==null&&canonical.committedAtMs<canonical.decisionAtMs)||
        !Number.isFinite(canonical.probabilityUp)||canonical.probabilityUp<0||canonical.probabilityUp>1)return;
      entry.canonical={...canonical};entry.version=++version;
    },
    read(identity:Identity,now:number):RoundDecision|null{
      const entry=entries.get(identity.intervalMinutes);
      if(!entry||key(entry.identity)!==key(identity)||now<identity.startMs||now>=identity.expiryMs)return null;
      const policy=lockPolicy(identity.intervalMinutes);
      return {...identity,network:"sui:mainnet",policyVersion:policy.version,stateVersion:entry.version,
        updatedAtMs:entry.updatedAtMs,publishedAtMs:now,
        readiness:evaluateLockReadiness(policy,identity.startMs,identity.expiryMs,entry.observations,now),
        canonical:entry.canonical?{...entry.canonical}:null,
        latestSafeOrderAtMs:null,executionWindowRemainingMs:null,tradeAllowed:false,
        executionBlocker:"HOLD: no verified executable quote, qualified signal or measured lock-to-accepted latency. Research readiness is not trade authority.",
        timestampSemantics:"Application receipt/evaluation/publication clocks; provider odds time unknown; commit is application acknowledgement"};
    },
  };
}
export const roundDecisions=createRoundDecisionTracker();