import {timedWindow,type TimedRound} from "../../shared/timed-decision";
import {captureTimedDecision,type TimedInput} from "./timed-decision-store";
import {roundDecisions} from "./round-decision";
import {createWaterxBackgroundQueue} from "./background-queue";
import {refreshErrorClass} from "./refresh-health";
import {timedCompletionPolicy} from "../../shared/timed-completion";
const active=new Map<number,{input:TimedInput;timers:ReturnType<typeof setTimeout>[]}>();
const queue=createWaterxBackgroundQueue<TimedInput>(async input=>{
   try{roundDecisions.timedSaved(input,await captureTimedDecision(input,undefined,()=>roundDecisions.timedSaving(input)));}
  catch(error){roundDecisions.timedFailed(input,refreshErrorClass(error));throw error;}
},(interval,error)=>console.error(`[waterx-${interval}m] timed decision storage failure: ${refreshErrorClass(error)}`));
export function observeTimedStrategy(input:TimedInput){
  const previous=active.get(input.intervalMinutes);
  if(previous&&previous.input.startMs>input.startMs)return;
  if(previous?.input.roundId===input.roundId&&previous.input.startMs===input.startMs&&previous.input.expiryMs===input.expiryMs){
    if((input.receivedAtMs??0)>=(previous.input.receivedAtMs??0))
      previous.input={...input,discoveredAtMs:previous.input.discoveredAtMs};
  }else{
    previous?.timers.forEach(clearTimeout);
    const entry={input:{...input,discoveredAtMs:Date.now()},timers:[] as ReturnType<typeof setTimeout>[]};active.set(input.intervalMinutes,entry);
    const window=timedWindow(input.intervalMinutes);
    const hard=input.startMs+window.hardSeconds*1000;
    for(const at of [input.startMs+window.targetSeconds*1000,
      hard-timedCompletionPolicy(input.intervalMinutes).allowanceMs,hard]){
      if(at>Date.now()){
        const timer=setTimeout(()=>queue.enqueue(entry.input),at-Date.now());
        timer.unref?.();entry.timers.push(timer);
      }
    }
  }
  queue.enqueue(active.get(input.intervalMinutes)!.input);
}
export function stopTimedStrategy(){
  for(const entry of Array.from(active.values()))entry.timers.forEach(clearTimeout);
  active.clear();
}
export const timedStrategyQueueMetrics=(now=Date.now())=>queue.metrics(now);
