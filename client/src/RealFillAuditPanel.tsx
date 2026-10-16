import React,{useState} from "react";
import {reconcileRealFill,type FilledPosition,type RealFillAudit, type Side, type VerifiedHistoryRound} from "../../shared/real-fill-audit";
import {comparePlacementCandidate,type CandidateResult} from "../../shared/placement-candidate";

/** Manual entry of REAL WaterX fills. Only compares with exact already-saved history;
 * local component state only: no wallet access, persistence or trade submission.
 */
export function RealFillAuditPanel({round}:{round:VerifiedHistoryRound}){
  const [marketId,setMarketId]=useState("");
  const [side,setSide]=useState<Side>("UP");
  const [price,setPrice]=useState("");
  const [stake,setStake]=useState("5");
  const [filledAt,setFilledAt]=useState("");
  const [placedAt,setPlacedAt]=useState("");
  const [candidate,setCandidate]=useState<CandidateResult|null>(null);
  const [payout,setPayout]=useState("");
  const [fee,setFee]=useState("");
  const [result,setResult]=useState<RealFillAudit|null>(null);
  const analyze=()=>{
    const fillMs=filledAt?new Date(filledAt).getTime():NaN;
    const x:FilledPosition={
      marketId:marketId.trim(),roundId:round.roundId,intervalMinutes:round.intervalMinutes,
      startMs:round.startMs,expiryMs:round.expiryMs,
      filledAtMs:fillMs,side,priceCents:price===""?NaN:Number(price),
      stakeUsd:stake===""?NaN:Number(stake),
      actualPayoutUsd:payout===""?null:Number(payout),
      feesUsd:fee===""?null:Number(fee),
    };
    setResult(reconcileRealFill(round,x));
  };
  const inspectPlacement=()=>{
    const when=placedAt?new Date(placedAt).getTime():NaN;
    setCandidate(comparePlacementCandidate({
      startMs:round.startMs,expiryMs:round.expiryMs,placedAtMs:when,side,
      stages:{
        primary:round.primary,early:round.early,confirmation:round.confirmation,
      },
    }));
  };
  const names=[["Blue Water primary",result?.primary],["Early Lock",result?.early],
    ["Confirmation Lock",result?.confirmation]] as const;
  return <details className="real-trade-audit">
    <summary>Compare a real filled WaterX position with frozen signals</summary>
    <p>Enter a real fill from WaterX order details for <strong>this exact round</strong>.
      Clock time or a screenshot of Activity alone is insufficient to prove round identity.
      This is an on-page audit only. Nothing is saved or sent to WaterX.</p>
    <p><strong>WaterX receipt without a market ID:</strong> you can check the placement
      time as a tentative candidate. No trade is matched, scored or attributed to
      Blue Water without the exact WaterX market/fill identity.</p>
    <div className="real-trade-fields">
      <label>WaterX "Placed at" (device local time)
        <input type="datetime-local" step="1" value={placedAt}
          onChange={e=>{setPlacedAt(e.target.value);setCandidate(null);}}/>
      </label>
      <label>WaterX market ID, from fill details <input value={marketId}
        onChange={e=>{setMarketId(e.target.value);setResult(null);}} placeholder="Exact market identifier"
        autoComplete="off"/></label>
      <label>Filled selection <select value={side} onChange={e=>{setSide(e.target.value as Side);setResult(null);}}>
        <option value="UP">YES / UP</option><option value="DOWN">NO / DOWN</option>
      </select></label>
      <label>Filled share price in cents <input inputMode="decimal" type="number" min="0.01" max="100" step="0.01"
        value={price} onChange={e=>{setPrice(e.target.value);setResult(null);}} placeholder="e.g. 67.6"/></label>
      <label>Actual USD spent <input inputMode="decimal" type="number" min="0.01" step="0.01" value={stake}
        onChange={e=>{setStake(e.target.value);setResult(null);}} /></label>
      <label>Fill time (your device local time) <input type="datetime-local" step="1" value={filledAt}
        onChange={e=>{setFilledAt(e.target.value);setResult(null);}} /></label>
      <label>Actual payout received USD (optional) <input type="number" min="0" step="0.01" value={payout}
        onChange={e=>{setPayout(e.target.value);setResult(null);}} /></label>
      <label>Actual total fees USD (optional) <input type="number" min="0" step="0.01" value={fee}
        onChange={e=>{setFee(e.target.value);setResult(null);}} /></label>
    </div>
    <p>Saved round: {round.roundId} · market: {round.marketId??"unknown"}. Exact round starts
      {new Date(round.startMs).toLocaleString()} and ends {new Date(round.expiryMs).toLocaleString()} (device time).</p>
    <button type="button" onClick={inspectPlacement}>Review placement-time candidate only</button>
    {candidate&&<section className="real-trade-result" role="status">
      <strong>UNVERIFIED MARKET ID · {candidate.state.replaceAll("_"," ")}</strong>
      <p>{candidate.reason}</p>
      {candidate.stages.map(st=><p key={st.name}><b>{st.name}:</b> {st.status==="AVAILABLE_BEFORE_PLACEMENT"?
        `${st.savedSide} saved before placement · ${st.supportsSelection?"agreed":"opposed"} your selection`:
        st.status==="SAVED_AFTER_PLACEMENT"?"Saved after placement (cannot justify this order)":
        "No recorded pre-placement signal"}</p>)}
      <p>This is NOT a verified WaterX market match and is excluded from model accuracy and P&L.</p>
    </section>}
    <button type="button" onClick={analyze}>Compare verified market and actual fill</button>
    {result&&<section className="real-trade-result" role="status">
      <strong>{result.status==="MATCHED"?"Exact round matched":"Not yet reconciled"}</strong>
      <p>{result.reason}</p>
      {result.status==="MATCHED"&&<>
        <p>Market purchase price requires at least {((result.breakEvenBeforeFees??0)*100).toFixed(1)}%
          true wins to break even before transaction costs.
          Counterfactual gross payout if correct: {result.estimatedGrossIfCorrect==null?"Unknown":
          `$${result.estimatedGrossIfCorrect.toFixed(2)}`}. This is not an executed quote.</p>
        {names.map(([label,s])=><p key={label}><b>{label}:</b> {s?.state==="FROZEN_BEFORE_FILL"?
          `${s.selectedSide} · ${s.agreedWithTrade?"agreed":"opposed"} the actual selection before fill`:
          s?.state==="FROZEN_AFTER_FILL"?"Prediction came after fill — cannot credit or blame it":
          "No verified frozen prediction before entry"}</p>)}
        <p>Official WaterX outcome: {result.officialOutcome??"Not verified"}. 
          {result.tradeCorrect==null?" No trade correctness inferred.":result.tradeCorrect?" Your side was correct.":" Your side was incorrect."}</p>
        <p>Actual net P&L: {result.actualNetPnlUsd==null?"Not computed; provide actual payout and fees":
          `$${result.actualNetPnlUsd.toFixed(2)} from YOUR supplied amounts (not independently verified).`}</p>
      </>}
    </section>}
  </details>;
}
