import {randomUUID} from "node:crypto";
import {lockPolicy,type LockObservation} from "../../shared/lock-readiness";
import type {RoundDecision} from "../../shared/round-decision";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
import {WATERX_RESEARCH_CONFIG} from "../../shared/waterx-research";
import type {EarlyDecision,OpportunityContext} from "../../shared/manual-opportunity";
import {evaluateLockReadiness} from "./lock-readiness";
import {evaluateTimedDecision,type TimedDecision,type GateJournal} from "../../shared/timed-decision";

type Identity={intervalMinutes:5|15;roundId:string;startMs:number;expiryMs:number};
type Entry={identity:Identity;observations:LockObservation[];updatedAtMs:number;
  canonical:RoundDecision["canonical"];persistence:RoundDecision["persistence"];
  early:EarlyDecision|null;earlyError:string|null;opportunity:OpportunityContext|null};
type TimedResult={saved:TimedDecision|null;error:string|null;saving:boolean;lastGate?:GateJournal|null};
const key=(r:Identity)=>`${r.intervalMinutes}:${r.roundId}:${r.startMs}:${r.expiryMs}`;
const validIdentity=(r:Identity)=>!!r.roundId&&(r.intervalMinutes===5||r.intervalMinutes===15)&&
  Number.isSafeInteger(r.startMs)&&Number.isSafeInteger(r.expiryMs)&&
  r.expiryMs-r.startMs===r.intervalMinutes*60000;

/** One disposable atomic publication. Never execution authority or durable choice storage. */
export function createRoundDecisionTracker(streamId=randomUUID()){
  const entries=new Map<number,Entry>();
  let version=0;
  const timed=new Map<string,TimedResult>();
  function discover(identity:Identity,now:number):Entry|null {
    if(!validIdentity(identity)||!Number.isSafeInteger(now)||now<identity.startMs||now>=identity.expiryMs)return null;
    let entry=entries.get(identity.intervalMinutes);
    if(entry&&identity.startMs<entry.identity.startMs)return null;
    if(entry&&identity.startMs===entry.identity.startMs&&key(entry.identity)!==key(identity))return null;
    if(!entry||key(entry.identity)!==key(identity)){
      entry={identity:{...identity},observations:[],updatedAtMs:now,canonical:null,
        early:null,earlyError:null,opportunity:null,
        persistence:{status:"WAITING_CHECKPOINT",updatedAtMs:now,errorClass:null}};
      entries.set(identity.intervalMinutes,entry);
    }
    return entry;
  }
  function persistence(identity:Identity,status:"QUEUED"|"WRITING"|"FAILED",now:number,errorClass:string|null=null){
    const entry=entries.get(identity.intervalMinutes);
    const target=identity.expiryMs-WATERX_RESEARCH_CONFIG.primaryLockSeconds[identity.intervalMinutes]*1000;
    if(!entry||key(entry.identity)!==key(identity)||entry.canonical||now<target||now>=identity.expiryMs)return;
    if(status==="QUEUED"&&entry.persistence.status==="WRITING")return;
    entry.persistence={status,updatedAtMs:now,errorClass};
  }
  return {
    timedGate(identity:Identity,gate:GateJournal){
      const old=timed.get(key(identity));if(old?.lastGate&&old.lastGate.gateIndex>gate.gateIndex)return;
      // Full immutable evidence is available from gate history, not every live poll.
      const {evidenceSnapshot:_evidence,...summary}=gate;
      timed.set(key(identity),{saved:old?.saved??null,error:old?.error??null,saving:old?.saving??false,lastGate:summary});
    },
    timedSaving(identity:Identity){timed.set(key(identity),{...timed.get(key(identity)),saved:timed.get(key(identity))?.saved??null,error:null,saving:true});},
    timedFailed(identity:Identity,error:string){
      timed.set(key(identity),{...timed.get(key(identity)),saved:timed.get(key(identity))?.saved??null,error,saving:false});
    },
    timedSaved(identity:Identity,saved:TimedDecision|null){
      if(saved&&(saved.roundId!==identity.roundId||saved.startMs!==identity.startMs||
        saved.expiryMs!==identity.expiryMs||saved.intervalMinutes!==identity.intervalMinutes))return;
      const old=timed.get(key(identity))?.saved;
      if(old&&saved&&old.id!==saved.id)return;
      timed.set(key(identity),{...timed.get(key(identity)),saved:saved??old??null,error:null,saving:false});
      for(const k of Array.from(timed.keys()))if(!Array.from(entries.values()).some(e=>key(e.identity)===k))timed.delete(k);
    },
    context(identity:Identity,context:OpportunityContext){
      const entry=entries.get(identity.intervalMinutes);
      if(entry&&key(entry.identity)===key(identity)&&
        (!entry.opportunity||context.receivedAtMs>=entry.opportunity.receivedAtMs)){
        const previous=entry.opportunity;
        context.priceLastChangedAtMs=previous&&
          (previous.purchase.up.askCents!==context.purchase.up.askCents||
           previous.purchase.down.askCents!==context.purchase.down.askCents)?
          context.receivedAtMs:previous?.priceLastChangedAtMs??null;
        entry.opportunity=context;
      }
    },
    earlyFailed(identity:Identity,errorClass:string){
      const entry=entries.get(identity.intervalMinutes);
      if(entry&&key(entry.identity)===key(identity)&&!entry.early)entry.earlyError=errorClass;
    },
    earlySaved(identity:Identity,early:EarlyDecision){
      const entry=entries.get(identity.intervalMinutes);
      if(!entry||key(entry.identity)!==key(identity)||early.decisionAtMs<identity.startMs||
        early.decisionAtMs>=identity.expiryMs||!Number.isFinite(early.probabilityUp)||
        !/^\d+$/.test(early.eventId)||early.policyVersion!==lockPolicy(identity.intervalMinutes).version)return;
      if(entry.early&&(entry.early.eventId!==early.eventId||entry.early.side!==early.side))return;
      entry.early={...early,committedAtMs:entry.early?.committedAtMs??early.committedAtMs};
      entry.earlyError=null;
    },
    discovered(identity:Identity,now:number){discover(identity,now);},
    observe(identity:Identity,observation:LockObservation){
      if(!Number.isSafeInteger(observation.atMs)||!Number.isSafeInteger(observation.receivedAtMs)||
        observation.receivedAtMs<identity.startMs||observation.receivedAtMs>observation.atMs||
        !observation.sourceHealthy||!validWaterxProbabilityPair(observation.probabilityUp,observation.probabilityDown))return;
      const entry=discover(identity,observation.atMs);
      if(!entry)return;
      const last=entry.observations.at(-1);
      if(last&&(last.atMs>=observation.atMs||last.receivedAtMs>=observation.receivedAtMs))return;
      entry.observations.push({...observation});
      entry.observations=entry.observations.filter(o=>o.atMs>=observation.atMs-120000).slice(-180);
      entry.updatedAtMs=observation.atMs;
    },
    queued(identity:Identity,now:number){persistence(identity,"QUEUED",now);},
    writing(identity:Identity,now:number){persistence(identity,"WRITING",now);},
    failed(identity:Identity,errorClass:string,now:number){persistence(identity,"FAILED",now,errorClass);},
    writeFinished(identity:Identity,now:number,result?:string):boolean|null{
      const entry=entries.get(identity.intervalMinutes);
      const target=identity.expiryMs-WATERX_RESEARCH_CONFIG.primaryLockSeconds[identity.intervalMinutes]*1000;
      if(!entry||key(entry.identity)!==key(identity)||now<target||now>=identity.expiryMs)return null;
      if(entry.canonical)return true;
      entry.persistence={status:"AWAITING_CHOICE",updatedAtMs:now,errorClass:
        result?.startsWith("Research evidence rejected:")?"CANONICAL_INPUT_REJECTED":"NO_CANONICAL_CHOICE"};
      return false;
    },
    committed(identity:Identity,canonical:NonNullable<RoundDecision["canonical"]>){
      const entry=entries.get(identity.intervalMinutes);
      if(!entry||key(entry.identity)!==key(identity)||entry.canonical||
        (canonical.side!=="UP"&&canonical.side!=="DOWN")||
        !Number.isSafeInteger(canonical.decisionAtMs)||
        canonical.decisionAtMs<identity.startMs||canonical.decisionAtMs>=identity.expiryMs||
        (canonical.committedAtMs!==null&&(!Number.isSafeInteger(canonical.committedAtMs)||
          canonical.committedAtMs<canonical.decisionAtMs))||
        !Number.isFinite(canonical.probabilityUp)||canonical.probabilityUp<0||canonical.probabilityUp>1)return;
      entry.canonical={...canonical};
      entry.persistence={status:"COMMITTED",updatedAtMs:canonical.committedAtMs??canonical.decisionAtMs,errorClass:null};
    },
    read(identity:Identity,now:number):RoundDecision|null{
      const entry=entries.get(identity.intervalMinutes);
      if(!entry||key(entry.identity)!==key(identity)||now<identity.startMs||now>=identity.expiryMs)return null;
      const policy=lockPolicy(identity.intervalMinutes);
      // Age is based on actual HTTP receipt, not replay of a cached response.
      const observations=entry.observations.map(o=>({...o,atMs:o.receivedAtMs}));
      const last=entry.observations.at(-1);
      const readiness=evaluateLockReadiness(policy,identity.startMs,identity.expiryMs,observations,now);
      const timing=evaluateTimedDecision(identity,observations,now),saved=timed.get(key(identity));
      timing.lastGate=saved?.lastGate??null;
      if(entry.opportunity&&entry.opportunity.probabilityEvidence!=="available"&&
        entry.opportunity.receivedAtMs>=(last?.receivedAtMs??0)){
        timing.qualified=false;timing.readinessPercent=0;timing.liveSide=null;timing.liveProbabilityUp=null;
        timing.requirementsMet=0;
        timing.blocker=entry.opportunity.probabilityEvidence==="invalid"?"INVALID_PROBABILITY_PAIR":"NO_VALID_PROBABILITY_INPUT";
        timing.lifecycle="OBSERVING";timing.remainingRequirement="Needs valid current WaterX probabilities";
      }
      timing.saved=saved?.saved??null;timing.errorClass=saved?.error??null;
      timing.persistence=saved?.saved?"COMMITTED":saved?.error?"FAILED":saved?.saving?"SAVING":"WAITING";
      if(timing.saved?.side&&timing.saved.status==="LOCKED")
        timing.lifecycle=timing.saved.side==="UP"?"LOCKED_UP":"LOCKED_DOWN";
      else if(timing.persistence==="SAVING")timing.lifecycle="SAVING";
      return {...identity,format:"waterx-live-decision-v2",streamId,network:"sui:mainnet",
        policyVersion:policy.version,stateVersion:++version,updatedAtMs:entry.updatedAtMs,publishedAtMs:now,
        readiness,market:last?{probabilityUp:last.probabilityUp,probabilityDown:last.probabilityDown,
          observedAtMs:last.atMs,receivedAtMs:last.receivedAtMs,providerOddsAtMs:null}:null,
        persistence:{...entry.persistence},canonical:entry.canonical?{...entry.canonical}:null,
        earlyDecision:entry.early?{...entry.early}:null,
        timedDecision:timing,
        earlyPersistence:{status:entry.early?"SAVED":entry.earlyError?"FAILED":
          readiness.state==="READY"?"SAVING":"DEVELOPING",errorClass:entry.earlyError},
        opportunity:entry.opportunity,
        componentHealth:{priceFeed:"UNAVAILABLE",decisionService:last?
          readiness.components.fresh?"AVAILABLE":"STALE":"UNAVAILABLE",
           storage:timing.saved||entry.early||entry.canonical?"COMMITTED":timing.errorClass||entry.earlyError||entry.persistence.status==="FAILED"?"FAILED":"UNKNOWN",
          orderAdapter:"UNVERIFIED"},
        latestSafeOrderAtMs:null,executionWindowRemainingMs:null,tradeAllowed:false,
        executionBlocker:"HOLD: no verified executable quote, qualified signal or measured lock-to-accepted latency. Research readiness is not trade authority.",
        timestampSemantics:"Application receipt/evaluation/publication clocks; provider odds time unknown; commit is application acknowledgement"};
    },
  };
}
export const roundDecisions=createRoundDecisionTracker();
