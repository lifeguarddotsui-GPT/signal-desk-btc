import * as React from "react";
import type {EntryWindowResult,Direction} from "../../shared/entry-window";
import "./TradeReadinessPanel.css";

/** Read-only trade research. Never issues a buy signal, signs, or sends a quote. */
export function TradeReadinessPanel({entry,alignment,upAsk,downAsk}:{
  entry:EntryWindowResult;
  alignment:{display:string;state:string;direction:Direction|null};
  upAsk:number|null;downAsk:number|null;
}) {
  const [manualSide,setManualSide]=React.useState<Direction>("UP");
  const [manualAsk,setManualAsk]=React.useState("");
  const [manualCost,setManualCost]=React.useState("0");
  const ask=manualAsk.trim()?Number(manualAsk):null;
  const cost=Number(manualCost);
  const isValid=ask!=null&&Number.isFinite(ask)&&ask>0&&ask<=100&&
    manualCost.trim()!==""&&Number.isFinite(cost)&&cost>=0&&cost<=5;
  const gross=isValid?5/(ask!/100):null;
  const breakeven=gross!=null?(5+cost)/gross:null;
  const money=(v:number|null)=>v==null?"Unavailable":`$${v.toFixed(2)}`;
  const fmtPct=(v:number|null)=>v==null?"Unavailable":`${(v*100).toFixed(1)}%`;
  const state=entry.state;
  const isWatch=state==="EDGE_UNVERIFIED";
  const title=isWatch?"BASIC CHECKS PASS · NO VERIFIED EDGE":
    state==="ROUND_CLOSED"?"ROUND CLOSED / NOT OPEN":
    state==="WAITING_FOR_SOURCE"?"WAIT · WATERX FEED STALE":
    state==="REFERENCE_UNCONFIRMED"?"WAIT · PRICE TO BEAT UNCONFIRMED":
    state==="SIGNAL_CONFLICT"?"WAIT · SIGNALS DISAGREE":
    state==="NO_FROZEN_SIGNAL"?"WAIT · NO SAVED SIGNAL":
    state==="LATE_TO_ENTER"?"WAIT · TOO LATE FOR RELIABLE ENTRY":
    state==="ASK_UNAVAILABLE"?"WAIT · PURCHASE PRICE MISSING":
    "WAIT · TOO LITTLE GROSS RETURN";
  const instruction=isWatch?"The market passed basic availability screens, but no qualified win probability proves this price is favorable. Compare against actual WaterX before deciding.":
    state==="WAITING_FOR_SOURCE"?"Wait for the official WaterX market feed to update. A stale quote is not a trade opportunity.":
    state==="REFERENCE_UNCONFIRMED"?"The current BTC comparison chart is NOT WaterX's official price to beat. Do not substitute it for the settlement reference.":
    state==="NO_FROZEN_SIGNAL"?"Blue Water has no acknowledged exact-round prediction. Provisional leans can change and are not a trading signal.":
    state==="SIGNAL_CONFLICT"?"Early, Confirmation and Primary disagree. Their directions must remain separate until this round resolves.":
    state==="LATE_TO_ENTER"?"The execution window is too short to trust a displayed quote or assume it will fill.":
    state==="ASK_UNAVAILABLE"?"A side-specific WaterX purchase quote has not been received; market percentages alone are not an executable price.":
    state==="RETURN_BELOW_PREFERENCE"?"Even a winning $5 position would return less than the basic $6 gross payout preference, before costs.":
    "This exact market window is not currently open.";
  return <section className="trade-readiness" aria-label="Trade decision support" data-state={state}>
    <div className="trade-readiness-top">
      <span className="trade-readiness-eyebrow">BTC {entry.remainingSeconds>0?"LIVE ROUND":"ROUND"} · $5 EVALUATION</span>
      <strong role="status" className="trade-readiness-status">{title}</strong>
    </div>
    <div className="trade-readiness-clock">
      <b>{Math.floor(entry.remainingSeconds/60)}:{String(entry.remainingSeconds%60).padStart(2,"0")}</b>
      <span>remaining</span>
      <span>{entry.signal? `Saved direction ${entry.signal}`:"No saved direction"}</span>
    </div>
    <div className="trade-readiness-track" role="progressbar" aria-label="Round elapsed"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(entry.roundProgressPercent)}>
      <i style={{width:`${entry.roundProgressPercent}%`}}/>
    </div>
    <p className="trade-readiness-guidance">{instruction}</p>
    <div className="trade-readiness-metrics">
      <div><span>Side ask</span><b>{entry.askCents==null?"No live quote":`${entry.askCents.toFixed(1)}¢`}</b></div>
      <div><span>$5 gross if correct</span><b>{money(entry.grossIfWinUsd)}</b></div>
      <div><span>Needed win rate</span><b>{fmtPct(entry.breakEvenWinProbability)}</b></div>
    </div>
    <p className="trade-readiness-lineage"><b>Prediction agreement:</b> {alignment.display}</p>
    <details className="trade-readiness-calculator">
      <summary>Compare an actual WaterX ask · $5 calculator</summary>
      <p>Use the purchase price visible in WaterX. This calculation is local, not a market-data feed or an order. It cannot tell you whether UP or DOWN will win.</p>
      <div className="trade-readiness-inputs">
        <label>Side <select value={manualSide} onChange={event=>setManualSide(event.target.value as Direction)}>
          <option value="UP">UP / YES</option><option value="DOWN">DOWN / NO</option>
        </select></label>
        <label>WaterX ask (¢) <input inputMode="decimal" type="number" min="0.01" max="100" step=".1"
          value={manualAsk} onChange={event=>setManualAsk(event.target.value)} placeholder="e.g. 67.6"/></label>
        <label>Total estimated cost ($) <input inputMode="decimal" type="number" min="0" max="5" step=".01"
          value={manualCost} onChange={event=>setManualCost(event.target.value)}/></label>
      </div>
      <p>Live displayed asks: YES {upAsk==null?"unavailable":`${upAsk.toFixed(1)}¢`} · NO {downAsk==null?"unavailable":`${downAsk.toFixed(1)}¢`}</p>
      {isValid ? <div className="trade-readiness-results">
        <span>Winning gross <b>{money(gross)}</b></span>
        <span>Net if win (est.) <b>{money(gross!-5-cost)}</b></span>
        <span>Loss if wrong (est.) <b>{money(5+cost)}</b></span>
        <span>Win rate needed (incl. input cost) <b>{fmtPct(breakeven)}</b></span>
      </div>:<p>Enter a valid ask from 0–100¢ and estimated total cost to compare the $5 outcome.</p>}
      <p className="trade-readiness-caution">Illustrative economics assume a full $5 fill, $1 redemption per winning share and stated costs. Fee, slippage and fill availability are not verified. Break-even rate is not Blue Water's prediction accuracy.</p>
    </details>
    <details className="trade-readiness-technical">
      <summary>Why is the entry blocked?</summary>
      <p>{entry.reason}</p>
      <p>Official settlement uses the WaterX market reference rather than Coinbase spot. No independent calibrated profitable edge has been established.</p>
    </details>
  </section>;
}
