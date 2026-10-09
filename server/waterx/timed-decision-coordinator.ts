import {timedWindow,type TimedRound} from "../../shared/timed-decision";
import {captureTimedDecision,loadTimedDecision,type TimedInput} from "./timed-decision-store";
import {roundDecisions} from "./round-decision";
import {createWaterxBackgroundQueue} from "./background-queue";
import {refreshErrorClass} from "./refresh-health";
import {TIMED_STRATEGY} from "../../shared/timed-decision";
import {timedPool} from "./timed-db";
import type {LockDb} from "./lock-store";
import {retryTimedAcknowledgements,timedAcknowledgementHealth} from "./timed-acknowledgement";
import {earlyHorizons} from "../../shared/timed-decision";
import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {recordEarlyDelivery,earlyDeliveryMetrics} from "./early-delivery-metrics";
import {crossIntervalContext,type IntervalObservation} from "../../shared/early-features";
import {refreshEarlyShadowModels,earlyShadowStatus} from "./early-shadow-runtime";
import {researchPool} from "./research-store";
import {gateResearchHealth,recoverGateResearch} from "./gate-research-queue";
import {eventLockRuntime} from "./event-lock-runtime";
import {twoStageRuntime} from "./two-stage-runtime";
import {decisionWriterAllowed} from "./decision-authority";
const enqueuedAt=new WeakMap<TimedInput,number>();
const persistenceFailures=new Map<string,number>();
export type GateScheduler={schedule:(callback:()=>void,delayMs:number)=>()=>void};
const realGateScheduler:GateScheduler={schedule(callback,delayMs){
  const timer=setTimeout(callback,delayMs);timer.unref?.();return ()=>clearTimeout(timer);
}};
const active=new Map<number,{input:TimedInput;timers:(()=>void)[]}>();
let recoveryTimer:ReturnType<typeof setInterval>|null=null,recovering=false;
let recovered=0,recoveryFailures=0,lastRecoveryAtMs:number|null=null;
let skippedRecoveryAtGate=0,lastRecoveryDurationMs:number|null=null,lastRecoveryRows=0;
let dailyDay="",dailyRunning=false;
let shadowRefreshAt=0;
const queue=createWaterxBackgroundQueue<TimedInput>(async input=>{
   recordEarlyDelivery(input.intervalMinutes,input.roundId,"QUEUE_DELAY",
     enqueuedAt.has(input)?performance.now()-enqueuedAt.get(input)!:null,"ok");
    try{roundDecisions.timedSaved(input,await captureTimedDecision(input,undefined,()=>roundDecisions.timedSaving(input),
      gate=>roundDecisions.timedGate(input,gate)));
      }
  catch(error){
    const key=`${input.intervalMinutes}:${input.roundId}:${input.startMs}`;
    persistenceFailures.set(key,(persistenceFailures.get(key)??0)+1);
    if(persistenceFailures.size>64)persistenceFailures.delete(persistenceFailures.keys().next().value!);
    roundDecisions.timedFailed(input,refreshErrorClass(error));throw error;
  }
},(interval,error)=>console.error(`[waterx-${interval}m] timed decision storage failure: ${refreshErrorClass(error)}`));
const enqueue=(input:TimedInput)=>{
  if(!decisionWriterAllowed())return;
  const n=persistenceFailures.get(`${input.intervalMinutes}:${input.roundId}:${input.startMs}`)??0;
  input={...input,features:{...input.features,persistenceFailureCount:Math.max(n,Number(input.features?.persistenceFailureCount??0))}};
  enqueuedAt.set(input,performance.now());queue.enqueue(input);
};
export function observeTimedStrategy(input:TimedInput,scheduler:GateScheduler=realGateScheduler){
   if(!decisionWriterAllowed())return;
   const acceptedAt=Date.now();
   const toObservation=(v:TimedInput):IntervalObservation=>{
     const cmp=v.features?.comparison as {price?:number;asOf?:string}|undefined;
     return {interval:v.intervalMinutes,roundId:v.roundId,startMs:v.startMs,expiryMs:v.expiryMs,
       probabilityUp:v.probabilityUp??NaN,receivedAtMs:v.receivedAtMs??acceptedAt,
       availableAtMs:Number(v.features?.contextAvailableAtMs??acceptedAt),providerSourceAtMs:null,
       reference:v.anchorPrice??null,referenceQuality:v.anchorPrice==null?"missing":v.anchorConfirmed?"confirmed":"provisional",
       comparison:cmp?.price??null,comparisonAtMs:cmp?.asOf?Date.parse(cmp.asOf):null};
   };
   const other=active.get(input.intervalMinutes===5?15:5)?.input;
   const projection=roundDecisions.read(input,acceptedAt)?.currentStrategy;
   input={...input,features:{...input.features,contextAvailableAtMs:acceptedAt,
     provisionalSide:projection?.provisionalLean??null,leanVersion:projection?.leanVersion??null,
     crossInterval:crossIntervalContext(toObservation(input),other?toObservation(other):undefined,acceptedAt)}};
  const previous=active.get(input.intervalMinutes);
  if(previous&&previous.input.startMs>input.startMs)return;
  if(previous?.input.roundId===input.roundId&&previous.input.startMs===input.startMs&&previous.input.expiryMs===input.expiryMs){
    if((input.receivedAtMs??0)>=(previous.input.receivedAtMs??0))
      previous.input={...input,discoveredAtMs:previous.input.discoveredAtMs};
  }else{
    previous?.timers.forEach(cancel=>cancel());
     recordEarlyDelivery(input.intervalMinutes,input.roundId,"ROUND_DISCOVERY_ELAPSED_UNQUALIFIED_CLOCK",
       Math.max(0,Date.now()-input.startMs),"ok");
     recordEarlyDelivery(input.intervalMinutes,input.roundId,"FIRST_PROVIDER_RECEIPT_ELAPSED_UNQUALIFIED_CLOCK",
       input.receivedAtMs==null?null:Math.max(0,input.receivedAtMs-input.startMs),"ok");
    const entry={input:{...input,discoveredAtMs:input.discoveredAtMs??Date.now()},timers:[] as (()=>void)[]};active.set(input.intervalMinutes,entry);
    const window=timedWindow(input.intervalMinutes);
    const hard=input.startMs+window.hardSeconds*1000;
    for(const at of Array.from(new Set([hard,
      ...earlyHorizons(input.intervalMinutes).map(h=>input.startMs+h*1000)]))){
      if(at>Date.now()){
         const delay=at-Date.now(),scheduled=performance.now();
         const cancel=scheduler.schedule(()=>{
           recordEarlyDelivery(input.intervalMinutes,input.roundId,"SCHEDULER_JITTER",Math.max(0,performance.now()-scheduled-delay),"ok");
           enqueue(entry.input);
         },delay);
         entry.timers.push(cancel);
      }
    }
  }
   enqueue(active.get(input.intervalMinutes)!.input);
}
/** This is an application-observed failure event, not a new provider quote.
 * It can only veto a gate; it carries no probabilities and never updates a
 * last-valid probability clock. Persistence records its explicit provenance. */
export function timedSourceUnavailable(interval:5|15,atMs:number,reason:string){
  if(decisionWriterAllowed())eventLockRuntime.unavailable(interval,atMs,reason);
  if(decisionWriterAllowed())twoStageRuntime.unavailable(interval,atMs,reason);
  const entry=active.get(interval);
  if(!entry||atMs<entry.input.startMs||atMs>=entry.input.expiryMs)return;
  entry.input={...entry.input,probabilityUp:null,probabilityDown:null,receivedAtMs:atMs,
    observedAt:new Date(atMs).toISOString(),features:{...entry.input.features,
      sourceFailure:{reason,failureObservedAtMs:atMs,providerQuoteReceivedAtMs:null}}};
  enqueue(entry.input);
}
/** Schedule identity/start/discovery and accepted evidence already live in
 * waterx_timed_rounds/observations. Deadlines derive from the pinned strategy.
 * Recovery cannot wake a sleeping Autoscale service; that still needs edge delivery. */
export async function recoverTimedSchedules(db=researchPool,now=Date.now()){
  const started=performance.now();
  const rows=await db.query(`SELECT r.discovered_at_ms,x.input FROM waterx_timed_rounds r
    LEFT JOIN waterx_timed_decisions d USING(network,strategy_version,interval_minutes,round_id)
    JOIN LATERAL (SELECT input FROM waterx_timed_observations o
      WHERE o.network=r.network AND o.strategy_version=r.strategy_version
        AND o.interval_minutes=r.interval_minutes AND o.round_id=r.round_id
      ORDER BY received_at_ms DESC LIMIT 1) x ON true
     WHERE r.strategy_version=$1 AND r.start_ms<=$2 AND (d.id IS NULL OR r.expiry_ms>$2)
    ORDER BY r.start_ms DESC LIMIT 3`,[TIMED_STRATEGY,now]);
  lastRecoveryRows=rows.rows.length;
  for(const row of rows.rows){
    const input={...(row.input as TimedInput),discoveredAtMs:Number(row.discovered_at_ms)};
    const previous=active.get(input.intervalMinutes);
     if(previous?.input.roundId===input.roundId&&input.expiryMs>now&&
       (previous.input.receivedAtMs??0)>=(input.receivedAtMs??0))continue;
    if(input.expiryMs<=now){
      await captureTimedDecision(input,db);
    }else if(previous&&previous.input.startMs>input.startMs){
      // Finalize a missed older persisted round without replacing the active interval.
      enqueue(input);
    }else {
      // Recover the committed choice even before upstream odds recover.
      // Historical observations must not be advertised as fresh live odds.
      roundDecisions.discovered(input,now);
      const saved=await loadTimedDecision(input,db);
      if(saved)roundDecisions.timedSaved(input,saved);
      observeTimedStrategy(input);
    }
    recovered++;
  }
  lastRecoveryAtMs=now;
  lastRecoveryDurationMs=performance.now()-started;
}
export function startTimedRecovery(){
  if(!decisionWriterAllowed())return;
  if(recoveryTimer)return;
  const tick=async()=>{
    if(recovering)return;recovering=true;
    try{
      const at=Date.now(),nearGate=Array.from(active.values()).some(({input})=>{
        if(at<input.startMs||at>=input.expiryMs)return false;
        const phase=(at-input.startMs)%30000;return phase<2500||phase>27500;
      });
      if(nearGate)skippedRecoveryAtGate++;
      else{await retryTimedAcknowledgements(researchPool);await recoverTimedSchedules();await recoverGateResearch();
        await eventLockRuntime.recover();}
    }
    catch(error){recoveryFailures++;console.error("[waterx-timed] durable schedule recovery failed",refreshErrorClass(error));}
    finally{recovering=false;}
    // Bounded retry slots, independent of daily-day identity; insufficient jobs
    // can retry on a changed dataset, and stale/failed attempts remain visible.
    const today=`${new Date().toISOString().slice(0,10)}:${Math.floor(Date.now()/21600000)}`;
    if(Date.now()-shadowRefreshAt>=300000){shadowRefreshAt=Date.now();void refreshEarlyShadowModels();}
    if(!dailyRunning&&dailyDay!==today){
      dailyDay=today;dailyRunning=true;
      // Training CPU and optional DB reads never run in the deadline process.
      const args=process.env.NODE_ENV==="production"&&existsSync("dist/early-training.mjs")?["dist/early-training.mjs"]:
        ["--import","tsx","scripts/train-early-horizons.ts"];
      args.push("--retry-failed");
      const child=spawn(process.execPath,args,{stdio:["ignore","inherit","inherit"]});
      const timeout=setTimeout(()=>child.kill("SIGTERM"),600000);timeout.unref?.();
      child.once("error",()=>{
        clearTimeout(timeout);dailyRunning=false;dailyDay="";
        console.error("[waterx-early] training subprocess failed to start");
      });
      child.once("exit",code=>{
        clearTimeout(timeout);dailyRunning=false;
        if(code!==0){dailyDay="";console.error("[waterx-early] training subprocess failed; inspect persisted jobs");}
      });
    }
  };
  void tick();recoveryTimer=setInterval(()=>void tick(),5000);recoveryTimer.unref?.();
}
export function stopTimedStrategy(){
  if(recoveryTimer)clearInterval(recoveryTimer);recoveryTimer=null;
  for(const entry of Array.from(active.values()))entry.timers.forEach(cancel=>cancel());
  active.clear();
}
export const timedStrategyQueueMetrics=(now=Date.now())=>({...queue.metrics(now),
   recovered,recoveryFailures,lastRecoveryAtMs,lastRecoveryDurationMs,lastRecoveryRows,
   skippedRecoveryAtGate,recoveryBatchLimit:3,recoveryGateBatchLimit:4,
   acknowledgements:timedAcknowledgementHealth(),
    shadowHorizonQueue:{mode:"IMMUTABLE_GATE_EVIDENCE_POSTCOMMIT",...gateResearchHealth()},
  delivery:earlyDeliveryMetrics(),
   shadowModels:earlyShadowStatus(),
  schedulePersistence:"Exact strategy/round and observations in PostgreSQL; startup and periodic recovery",
  autoscaleIndependent:false});
