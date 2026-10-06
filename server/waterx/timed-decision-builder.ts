import {randomUUID} from "node:crypto";
import {evaluateTimedDecision,TIMED_STRATEGY,timedPolicy,GATE_MS,GATE_GRACE_MS,
 type TimedRound,type TimedDecision,type GateJournal} from "../../shared/timed-decision";
import type {LockObservation} from "../../shared/lock-readiness";
import {observationId} from "./observation-provenance";
import {digestEarlySnapshot} from "./early-horizons";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
const gateObservations=(round:TimedRound,observations:LockObservation[],at:number)=>observations.filter(o=>
 Number.isSafeInteger(o.receivedAtMs)&&o.receivedAtMs>=Math.max(round.startMs,at-75000)&&
 o.receivedAtMs<=at&&o.receivedAtMs<round.expiryMs&&o.sourceHealthy&&
 validWaterxProbabilityPair(o.probabilityUp,o.probabilityDown)).sort((a,b)=>a.receivedAtMs-b.receivedAtMs);

/** Actual evaluation must fall inside grace; evidence always ends AT the gate. */
export function evaluateQualificationGate(round:TimedRound,observations:LockObservation[],gateIndex:number,
 now:number,latestInputValid=true):GateJournal{
 const at=round.startMs+gateIndex*GATE_MS;
 const base={gateIndex,scheduledAtMs:at,evaluatedAtMs:now,evidenceCutoffMs:at,decisionId:null,
    network:"sui:mainnet" as const,intervalMinutes:round.intervalMinutes,roundId:round.roundId,startMs:round.startMs,expiryMs:round.expiryMs,
   requirementsMet:0,requirementsTotal:4,probabilityUp:null,components:undefined,
   policyVersion:TIMED_STRATEGY,source:"experimental market-based policy",calibrationStatus:"UNQUALIFIED" as const,
   observationIds:[],providerSourceAtMs:null,receivedAtMs:null,modelVersion:null,featureVersion:"gate-evidence-v1"};
 if(!Number.isSafeInteger(gateIndex)||gateIndex<1||at>=round.expiryMs||
   round.expiryMs-round.startMs!==round.intervalMinutes*60000||!Number.isSafeInteger(now))
   return {...base,result:"INVALID_ROUND",reason:"Invalid exact round or gate"};
 if(now<at)throw new Error("Gate not reached");
 if(now>at+GATE_GRACE_MS)return {...base,result:"MISSED_GATE",reason:"Actual evaluation exceeded scheduling grace; no retrospective reconstruction"};
  const prior=gateObservations(round,observations,at);
 const state=evaluateTimedDecision(round,prior,at);
 const result=!latestInputValid||state.sourceAgeMs===null||state.sourceAgeMs>10000?"WAIT_FRESH_DATA":
   state.qualified?"QUALIFIED":state.blocker==="DIRECTIONAL_SEPARATION_BELOW_POLICY"||state.blocker==="AMBIGUOUS_TIE"?
     "WAIT_WEAK_EVIDENCE":"WAIT_UNSTABLE";
 const journal:GateJournal={...base,result,reason:latestInputValid?state.remainingRequirement??state.blocker:"Latest pre-gate input invalid",
   probabilityUp:prior.at(-1)?.probabilityUp??null,receivedAtMs:prior.at(-1)?.receivedAtMs??null,
   requirementsMet:Math.max(0,(state.requirementsMet??0)-Number(!latestInputValid&&state.sourceAgeMs!==null&&state.sourceAgeMs<=10000)),components:state.components,
   observationIds:prior.map(o=>observationId(round.intervalMinutes,round.roundId,o.receivedAtMs))};
 return {...journal,snapshotDigest:digestEarlySnapshot(journal)};
}

export function buildTimedDecision(round:TimedRound,observations:LockObservation[],_discoveredAtMs:number,
 now:number,latestInputValid:boolean,evidence:Record<string,unknown>={},_unusedFallback=false):TimedDecision|null{
 const index=Math.floor((now-round.startMs)/GATE_MS);
 if(index<1||now>=round.expiryMs)return null;
 const gate=evaluateQualificationGate(round,observations,index,now,latestInputValid);
 if(gate.result!=="QUALIFIED")return null;
  const prior=gateObservations(round,observations,gate.scheduledAtMs),latest=prior.at(-1)!;
 const maxGap=prior.length>1?Math.max(...prior.slice(1).map((o,i)=>o.receivedAtMs-prior[i].receivedAtMs)):null;
 return {id:randomUUID(),strategyVersion:TIMED_STRATEGY,network:"sui:mainnet",...round,status:"LOCKED",
   side:latest.probabilityUp>latest.probabilityDown?"UP":"DOWN",probabilityUp:latest.probabilityUp,probabilityDown:latest.probabilityDown,
   observationId:observationId(round.intervalMinutes,round.roundId,latest.receivedAtMs),receivedAtMs:latest.receivedAtMs,
   decisionAtMs:now,elapsedMs:now-round.startMs,targetAtMs:gate.scheduledAtMs,
   hardDeadlineAtMs:gate.scheduledAtMs+GATE_GRACE_MS,gateIndex:index,gateScheduledAtMs:gate.scheduledAtMs,
   lockReason:"QUALIFIED_SCHEDULED_GATE",earlyBlocker:"CONDITIONS_SATISFIED",ambiguous:false,
   coverage:{n:prior.length,firstAtMs:prior[0]?.receivedAtMs??null,lastAtMs:latest.receivedAtMs,maxGapMs:maxGap},
   committedAtMs:null,workerReceivedAtMs:null,onTime:null,operationalFailure:null,automaticExecutionAllowed:false,
   evidence:{...evidence,gate,policy:timedPolicy(round.intervalMinutes),sourceId:"waterx.public.crypto.v1",
     calibrationStatus:"UNQUALIFIED",probabilitySemantics:"experimental market-based policy; not a calibrated forecast",
     tieBreak:"NONE",sameTimeWaterxBaseline:{probabilityUp:latest.probabilityUp,probabilityDown:latest.probabilityDown}}};
}
