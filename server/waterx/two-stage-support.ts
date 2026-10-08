import {subscribeChartEvents,type ChartSample} from "../btc/chart";
import {twoStageRuntime} from "./two-stage-runtime";
import {stagePolicyRegistry} from "./two-stage-registry";
import {researchPool} from "./research-store";
import {recoverMissingStageAssessments,recoverStageSettlementQueue,recoverMissingStageRounds,recoverSavedPredictionSettlementQueue} from "./two-stage-recovery";
import {recentRoundsCollector} from "./recent-rounds";
import {decisionWriterAllowed} from "./decision-authority";
import {createStageLearningWake} from "./two-stage-schedule";
let stop:(()=>void)|null=null;
export const stageLearningWake=createStageLearningWake({
  connect:()=>researchPool.connect(),allowed:decisionWriterAllowed,
  refresh:()=>stagePolicyRegistry.refresh(researchPool,Date.now(),true),
});
/** Reuse the already-running Coinbase capture. No second provider/paid worker. */
export function startTwoStageSupport(){
  if(stop)return stop;
  const unsubscribe=subscribeChartEvents(event=>{
    if(event.type!=="tick")return;
    const p=event.data as ChartSample,atMs=p.sourceAt?Date.parse(p.sourceAt):NaN;
    twoStageRuntime.observePrice({id:`coinbase:${p.eventId??`${atMs}:${p.at}`}`,
      atMs,receivedAtMs:p.at,availableAtMs:Date.parse(p.serverEventAt),price:p.price,
      source:p.source,reference:null});
  });
  void stagePolicyRegistry.refresh(researchPool);
   const recover=()=>{if(decisionWriterAllowed())void recoverMissingStageRounds(researchPool)
     .then(()=>recoverMissingStageAssessments(researchPool))
     .then(()=>recoverStageSettlementQueue(researchPool))
      .then(()=>recoverSavedPredictionSettlementQueue(researchPool))
    .catch(()=>console.warn("Two-stage recovery diagnostics unavailable; no retrospective locks created."));};
  recover();
   void stageLearningWake.wake();
   const timer=setInterval(()=>{void stagePolicyRegistry.refresh(researchPool);recover();
     void stageLearningWake.wake();},300000);timer.unref();
   const deadlineTimer=setInterval(()=>{twoStageRuntime.tick();void recentRoundsCollector.tick();},5000);deadlineTimer.unref();
  stop=()=>{unsubscribe();clearInterval(timer);clearInterval(deadlineTimer);stop=null;};
  return stop;
}
