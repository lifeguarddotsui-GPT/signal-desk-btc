import {timedWindow,type TimedRound} from "../../shared/timed-decision";
import {captureTimedDecision,type TimedInput} from "./timed-decision-store";
import {roundDecisions} from "./round-decision";
import {createWaterxBackgroundQueue} from "./background-queue";
import {refreshErrorClass} from "./refresh-health";
const active=new Map<number,{input:TimedInput;timers:ReturnType<typeof setTimeout>[]}>();
const queue=createWaterxBackgroundQueue<TimedInput>(async input=>{
  const state=roundDecisions.read(input,Date.now())?.timedDecision;
  if(state&&!state.saved&&(state.phase==="DEADLINE"||state.phase==="EVALUATING"&&state.qualified))
    roundDecisions.timedSaving(input);
  try{roundDecisions.timedSaved(input,await captureTimedDecision(input));}
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
    for(const seconds of [window.targetSeconds,window.hardSeconds]){
      const at=input.startMs+seconds*1000;
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
