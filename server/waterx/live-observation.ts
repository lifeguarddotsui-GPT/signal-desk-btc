import {roundDecisions} from "./round-decision";
import {observationId} from "./observation-provenance";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
import {observeTimedStrategy,type GateScheduler} from "./timed-decision-coordinator";
import type {TimedInput} from "./timed-decision-store";
import type {WaterxRound} from "./types";
import {eventLockRuntime} from "./event-lock-runtime";
import {decisionWriterAllowed,decisionClockDomain,decisionDeploymentId} from "./decision-authority";
import {entryEconomics} from "../../shared/lock-economics";
import {twoStageRuntime} from "./two-stage-runtime";
import {v4ConfirmationShadow} from "./confirmation-v4-shadow";

/** The production ingestion boundary, also used by isolated provider replays.
 * Publishes continuous market evidence before optional storage/research work.
 * Only the existing timed transaction can turn this evidence into a lock. */
export function acceptLiveTimedObservation(input:TimedInput,round:WaterxRound,
  comparison:{price:number;source:string;asOf:string}|null,scheduler?:GateScheduler){
  const receivedAtMs=input.receivedAtMs!;
  roundDecisions.discovered(input,Date.parse(input.observedAt));
  const purchase=(side:WaterxRound["sides"]["up"])=>({
    status:side.availability,askCents:side.oddsCents,
    marketObjectId:side.trade?.marketId??null,selection:side.trade?.selection??null});
  roundDecisions.context(input,{sourceId:"waterx.public.crypto.v1",
    observationId:observationId(input.intervalMinutes,round.id,receivedAtMs),receivedAtMs,
    providerEventAtMs:null,priceLastChangedAtMs:null,
    reference:{price:round.anchorPrice,status:round.anchorPrice===null?"unavailable":
      round.anchorPriceConfirmed?"confirmed":"provisional"},
    marketId:round.marketId,url:`https://waterx.app/en/predict/market/crypto/${round.slug}/${round.endsAt}`,
    orderCutoffAtMs:null,probabilityEvidence:input.probabilityUp===null||input.probabilityDown===null?
      "unavailable":validWaterxProbabilityPair(input.probabilityUp,input.probabilityDown)?"available":"invalid",
    purchase:{up:purchase(round.sides.up),down:purchase(round.sides.down)}});
  if(input.probabilityUp!==null&&input.probabilityDown!==null)roundDecisions.observe(input,{
    atMs:Date.parse(input.observedAt),receivedAtMs,providerSourceAtMs:null,
    probabilityUp:input.probabilityUp,probabilityDown:input.probabilityDown,sourceHealthy:true});
  const valueEconomics={
    UP:entryEconomics({roundId:round.id,marketId:round.marketId,side:"UP",nowMs:receivedAtMs,
      askCents:round.sides.up.availability==="reported"?round.sides.up.oddsCents:null}),
    DOWN:entryEconomics({roundId:round.id,marketId:round.marketId,side:"DOWN",nowMs:receivedAtMs,
      askCents:round.sides.down.availability==="reported"?round.sides.down.oddsCents:null}),
  };
  const accepted={...input,features:{...input.features,decisionClockDomain,deploymentId:decisionDeploymentId,valueEconomics,
    reference:round.anchorPrice,
    referenceQuality:round.anchorPriceConfirmed?"confirmed":"provisional",
    purchaseUp:{status:round.sides.up.availability,askCents:round.sides.up.oddsCents},
    purchaseDown:{status:round.sides.down.availability,askCents:round.sides.down.oddsCents},
    comparison,executableQuote:null,settlementRule:"UNVERIFIED_COMPARISON_IS_NOT_SETTLEMENT",
    marketId:round.marketId,providerUrl:`https://waterx.app/en/predict/market/crypto/${round.slug}/${round.endsAt}`}};
  if(decisionWriterAllowed()){
    // Same accepted HTTP receipt, separately versioned research choices. The
    // challenger never replaces the benchmark/active strategy or funds orders.
    void eventLockRuntime.observe(accepted);
    void twoStageRuntime.observe(accepted);
    // Opt-in, event-driven V4 shadow uses the same receipt; zero new provider polls.
    void v4ConfirmationShadow.observe(accepted);
    observeTimedStrategy(accepted,scheduler);
  }
}
