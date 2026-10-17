import * as React from "react";
import {simpleWaterxPosition} from "./SimpleLiveDesk";
import type {TwoStageProjection,LockStage,StageLock} from "../../shared/two-stage";
import {TWO_STAGE_STRATEGY} from "../../shared/two-stage";
import {operationalTimingWindow} from "../../shared/operational-timing";

type Round={id:string;startMs:number;expiryMs:number};
type Side="UP"|"DOWN";
type Props={
 interval:5|15;now:number;round:Round|null;
 probabilityUp:number|null;probabilityDown:number|null;probabilityReceivedAtMs:number|null;
 lean:Side|null;lockedSide:Side|null;decisionState:string;decisionReason:string;
 nextGateAtMs:number|null;verifiedModelEdge:boolean;
 stages:TwoStageProjection|null|undefined;
 asks:{up:number|null;down:number|null};quoteFresh:boolean;quoteAtMs:number|null;
 onRetry?:()=>void;failed?:boolean;
};
const pct=(v:number|null)=>v!=null&&Number.isFinite(v)?`${(100*v).toFixed(1)}%`:"—";
const clock=(s:number)=>`${Math.floor(Math.max(0,s)/60)}:${String(Math.floor(Math.max(0,s)%60)).padStart(2,"0")}`;
const amount=(n:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n);

function stageLock(projection:TwoStageProjection|null|undefined,round:Round|null,interval:5|15,stage:LockStage):StageLock|null{
 if(!projection||!round||projection.roundId!==round.id||projection.startMs!==round.startMs||
    projection.expiryMs!==round.expiryMs||projection.intervalMinutes!==interval||
    projection.strategyVersion!==TWO_STAGE_STRATEGY||projection.shadowOnly!==true||
    projection.automaticExecutionAllowed!==false)return null;
 const record=stage==="EARLY"?projection.early:projection.confirmation;
 const lock=record?.lock;
 if(record?.persistence!=="COMMITTED"||!lock||lock.stage!==stage||
    lock.network!=="sui:mainnet"||lock.roundId!==round.id||
    lock.startMs!==round.startMs||lock.expiryMs!==round.expiryMs||
    lock.intervalMinutes!==interval||lock.strategyVersion!==TWO_STAGE_STRATEGY||
    lock.marketId!==projection.marketId||lock.shadowOnly!==true||
    lock.automaticExecutionAllowed!==false||
    (lock.commitVerified!==true&&lock.committedAtMs==null))return null;
 return lock;
}

/** Condensed market-first read-only rail. Does not estimate oracle or execute trades. */
export function FocusRail({interval,now,round,probabilityUp,probabilityDown,probabilityReceivedAtMs,
 lean,lockedSide,decisionState,decisionReason,nextGateAtMs,verifiedModelEdge,stages,
 asks,quoteFresh,quoteAtMs,onRetry,failed}:Props){
 const active=!!round&&now>=round.startMs&&now<round.expiryMs;
 const remaining=active&&round?Math.ceil((round.expiryMs-now)/1000):0;
 const receivedAge=probabilityReceivedAtMs==null?Infinity:now-probabilityReceivedAtMs;
 const freshOdds=active&&receivedAge>=-1000&&receivedAge<=14000&&
   probabilityUp!=null&&probabilityDown!=null&&Number.isFinite(probabilityUp)&&Number.isFinite(probabilityDown)&&
   probabilityUp>=0&&probabilityUp<=1&&probabilityDown>=0&&probabilityDown<=1&&
   Math.abs(probabilityUp+probabilityDown-1)<.02;
 const age=quoteAtMs==null?Infinity:now-quoteAtMs;
 const freshQuote=active&&quoteFresh&&age>=-1000&&age<=14000;
 const up=simpleWaterxPosition(asks.up,freshQuote),down=simpleWaterxPosition(asks.down,freshQuote);
 const early=stageLock(stages,round,interval,"EARLY"),confirmation=stageLock(stages,round,interval,"CONFIRMATION");
 const timing=round?operationalTimingWindow({startMs:round.startMs,expiryMs:round.expiryMs,nowMs:now}):null;
 const decision=lockedSide?`LOCKED ${lockedSide}`:lean?`LEANING ${lean}`:decisionState;
 const stageLine=(lock:StageLock|null,stage:"Early"|"Confirmation")=>{
   const pending=stages&&(stage==="Early"?stages.early:stages.confirmation);
   const reason=stage==="Early"?"Awaiting qualified evidence":"Not confirmed";
   const text=lock?`${lock.side} · ${lock.committedAtMs!=null&&round?clock((round.expiryMs-lock.committedAtMs)/1000)+" left":"acknowledged"}`:pending?.reason==="ROUND_EXPIRED"?"No lock":reason;
   return <div className="bw-focus-lock" key={stage}>
     <span>{stage} lock <small>experimental</small></span>
     <b className={lock?`is-${lock.side.toLowerCase()}`:""}>{text}</b>
   </div>;
 };
 return <aside className="bw-focus-rail" aria-label="Live desk decision essentials">
   <section className="bw-focus-odds" aria-label="WaterX UP DOWN percentages">
     <div className="bw-focus-label"><span>WaterX market ratios</span><small>{freshOdds?`${Math.floor(receivedAge/1000)}s old`:"Odds unavailable"}</small></div>
     <div className="bw-focus-odds-pair">
       <div className="bw-focus-up"><small>UP</small><strong>{freshOdds?pct(probabilityUp):"—"}</strong></div>
       <div className="bw-focus-down"><small>DOWN</small><strong>{freshOdds?pct(probabilityDown):"—"}</strong></div>
     </div>
     <div className="bw-focus-disclaimer">Market-implied odds, not BlueWater predictions</div>
   </section>
   <section className="bw-focus-decision" aria-label="BlueWater lean lock and decision">
     <div className="bw-focus-label"><span>BlueWater decision</span><small>Read-only</small></div>
     <div className="bw-focus-decision-main">
       <strong className={lockedSide?`is-${lockedSide.toLowerCase()}`:lean?`is-${lean.toLowerCase()}`:""}>{decision}</strong>
       <small>{lockedSide?"Exact-round choice saved":lean?"Provisional · not a qualified trade":decisionReason}</small>
     </div>
     <div className="bw-focus-locks">{stageLine(early,"Early")}{stageLine(confirmation,"Confirmation")}</div>
   </section>
   <section className="bw-focus-timing" aria-label="Timing window">
     <div><span className="bw-focus-label">Timing window</span><strong>{active?clock(remaining):"—"}</strong></div>
     <div><b>{timing?.label??"Awaiting round"}</b><small>{nextGateAtMs!=null&&nextGateAtMs>now?`Next review in ${clock((nextGateAtMs-now)/1000)}`:"Timing is not a prediction"}</small></div>
   </section>
   <section className="bw-focus-payout" aria-label="WaterX indicative 5 dollar position economics">
     <div className="bw-focus-label"><span>$5 position · indicative payout</span><small>{freshQuote?`Quotes ${Math.floor(age/1000)}s old`:"No fresh ask"}</small></div>
     <div className="bw-focus-payout-pair">
      <div><small>UP ask</small><strong>{up?`${up.askCents.toFixed(1)}¢`:"—"}</strong><span>{up?`+${amount(up.winningProfitBeforeFees)}`:"—"} <small>if correct</small></span></div>
      <div><small>DOWN ask</small><strong>{down?`${down.askCents.toFixed(1)}¢`:"—"}</strong><span>{down?`+${amount(down.winningProfitBeforeFees)}`:"—"} <small>if correct</small></span></div>
     </div>
     <div className="bw-focus-disclaimer">Before fees and price impact · full $5 stake at risk · {verifiedModelEdge?"Qualified model evidence":"No verified trading edge"}.</div>
     {failed&&onRetry&&<button type="button" onClick={onRetry}>Retry market data</button>}
   </section>
 </aside>;
}
