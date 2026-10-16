import * as React from "react";
import type {EntryWindowResult,Direction} from "../../shared/entry-window";
import type {TimingWindow} from "../../shared/operational-timing";

/** Timing is an OPERATIONAL heuristic, not empirical expected value or a buy recommendation. */
export function TradeReadinessPanel({entry,timing,alignment,upAsk,downAsk}:{
  entry:EntryWindowResult;timing:TimingWindow;
  alignment:{display:string;state:string;direction:Direction|null};
  upAsk:number|null;downAsk:number|null;
}) {
  const [selectedSide,setSelectedSide]=React.useState<Direction>("UP");
  const [typedAsk,setTypedAsk]=React.useState("");
  const [typedCosts,setTypedCosts]=React.useState("0");
  const [showBreakdown,setShowBreakdown]=React.useState(false);
  const providerAsk=selectedSide==="UP"?upAsk:downAsk;
  const manual=typedAsk.trim()!==""?Number(typedAsk):null;
  const effectiveAsk=manual??providerAsk;
  const costs=Number(typedCosts);
  const priceValid=effectiveAsk!=null&&Number.isFinite(effectiveAsk)&&effectiveAsk>0&&effectiveAsk<=100;
  const costsValid=typedCosts.trim()!==""&&Number.isFinite(costs)&&costs>=0&&costs<=5;
  const valid=priceValid&&costsValid;
  const gross=valid?5/(effectiveAsk!/100):null;
  const winNet=gross==null?null:gross-5-costs;
  const breakeven=gross==null?null:(5+costs)/gross;
  const money=(x:number|null)=>x==null?"—":`$${x.toFixed(2)}`;
  const fmtPct=(x:number|null)=>x==null?"—":`${(x*100).toFixed(1)}%`;
  const severity=timing.score>=7?"review":timing.score>=4?"watch":"avoid";
  const signalReady=!!entry.signal&&entry.state!=="WAITING_FOR_SOURCE"&&
    entry.state!=="REFERENCE_UNCONFIRMED"&&entry.state!=="SIGNAL_CONFLICT";
  const quoteSource=manual!=null?"Manually entered WaterX price":
    providerAsk!=null?"WaterX public indicative side ask":"No verified ask available";
  return <section className="trade-readiness" aria-label="Trade decision support" data-state={entry.state}>
    <div className="trade-readiness-top">
      <span className="trade-readiness-eyebrow">BTC · $5 ENTRY MONITOR</span>
      <strong className="trade-readiness-status">TIMING WINDOW</strong>
    </div>
    <div className="trade-timing-summary">
      <div className={`trade-timing-score ${severity}`} role="img"
        aria-label={`Operational timing ${timing.score} out of 10, not a probability of profit`}>
        <b>{timing.score}<small>/10</small></b>
        <span>TIME ONLY</span>
      </div>
      <div className="trade-timing-message">
        <strong>{timing.label}</strong>
        <span>{timing.description}</span>
        <small>Heuristic timing grade only — NOT an accuracy score or a buy recommendation.</small>
      </div>
    </div>
    <div className="trade-readiness-track" role="progressbar" aria-label="Round elapsed"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(timing.elapsedPercent)}>
      <i style={{width:`${timing.elapsedPercent}%`}}/>
    </div>
    <div className="trade-readiness-clock">
      <b>{Math.floor(timing.remainingSeconds/60)}:{String(timing.remainingSeconds%60).padStart(2,"0")}</b>
      <span>remaining</span>
      <span>{entry.signal?`Saved ${entry.signal}`:"No frozen direction"}</span>
    </div>
    <div className="trade-decision-gates">
      <div><span>Official reference</span><b>{entry.state==="REFERENCE_UNCONFIRMED"?"Unconfirmed":"See details"}</b></div>
      <div><span>Prediction</span><b>{alignment.state==="CONFLICT"?"Conflict":signalReady?"Saved":"Not qualified"}</b></div>
      <div><span>Trade edge</span><b>Not validated</b></div>
    </div>
    <p className="trade-readiness-lineage"><b>Early / Confirmation / Primary:</b> {alignment.display}</p>
    <div className="trade-pricing" aria-label="WaterX buy-in value comparison">
      <strong>Compare actual WaterX purchase price</strong>
      <p>Use the YES or NO price WaterX shows when you place a $5 position.</p>
      <div className="trade-readiness-inputs">
        <label>Side<select aria-label="Position side" value={selectedSide}
          onChange={e=>{setSelectedSide(e.target.value as Direction);setTypedAsk("");}}>
          <option value="UP">YES / UP</option><option value="DOWN">NO / DOWN</option>
        </select></label>
        <label>Ask price (¢)<input aria-label="WaterX ask cents" type="number" inputMode="decimal"
          step=".1" min=".01" max="100" value={typedAsk} placeholder={providerAsk==null?"e.g. 67.6":providerAsk.toFixed(1)}
          onChange={e=>setTypedAsk(e.target.value)}/></label>
        <label>Costs ($)<input aria-label="Extra order costs" inputMode="decimal" type="number"
          min="0" max="5" step=".01" value={typedCosts} onChange={e=>setTypedCosts(e.target.value)}/></label>
      </div>
      <small>{quoteSource}. YES: {upAsk==null?"not reported":`${upAsk.toFixed(1)}¢`} · NO: {downAsk==null?"not reported":`${downAsk.toFixed(1)}¢`}</small>
      <div className="trade-readiness-results">
        <span>Gross if right <b>{money(gross)}</b></span>
        <span>Net if right <b>{money(winNet)}</b></span>
        <span>Loss if wrong <b>{valid?money(5+costs):"—"}</b></span>
        <span>Win rate to break even <b>{fmtPct(breakeven)}</b></span>
      </div>
      <p className="trade-readiness-caution">A profitable entry requires a validated independent forecast above this break-even threshold, after uncertainty, fees and slippage. Blue Water has not established one. Price and time alone cannot show a positive expected return.</p>
    </div>
    <button type="button" className="trade-details-toggle" onClick={()=>setShowBreakdown(v=>!v)}>
      {showBreakdown?"Hide data diagnostics":"Show missing data and lock diagnostics"}
    </button>
    {showBreakdown&&<div className="trade-diagnostics" role="status">
      <p>{entry.reason}</p>
      <p>Official settlement uses the WaterX market reference rather than Coinbase spot. An absent provider-confirmed reference or verified full-size quote is never silently substituted.</p>
    </div>}
  </section>;
}
