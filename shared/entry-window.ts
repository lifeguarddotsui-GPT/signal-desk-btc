/** Read-only market entry window research. No execution, backtesting claim or ML forecast. */
export type Direction="UP"|"DOWN";
export type EntryWindowState="ROUND_CLOSED"|"WAITING_FOR_SOURCE"|"NO_FROZEN_SIGNAL"|
  "SIGNAL_CONFLICT"|"LATE_TO_ENTER"|"ASK_UNAVAILABLE"|"RETURN_BELOW_PREFERENCE"|"EDGE_UNVERIFIED"|"REFERENCE_UNCONFIRMED";
export type EntryWindowInput={
  nowMs:number;startMs:number;expiryMs:number;
  sourceFresh:boolean;referenceConfirmed:boolean;
  signal:Direction|null;signalConflict:boolean;
  askCents:number|null;collateralUsd?:number;minimumGrossReturnUsd?:number;
  latestProviderAsOfMs?:number|null;
};
export type EntryWindowResult={
  state:EntryWindowState;label:string;reason:string;roundProgressPercent:number;
  remainingSeconds:number;signal:Direction|null;
  askCents:number|null;grossIfWinUsd:number|null;profitIfWinBeforeCostsUsd:number|null;
  breakEvenWinProbability:number|null;illustrativeBreakEvenWith10CentCost:number|null;
  qualifiedForecastProbability:null;
  executable:false;estimatedOnly:true;
};
export function evaluateEntryWindow(i:EntryWindowInput):EntryWindowResult{
  if(![i.nowMs,i.startMs,i.expiryMs].every(Number.isFinite)||i.expiryMs<=i.startMs)
    throw new Error("Invalid round window");
  const collateral=i.collateralUsd??5,minimumGross=i.minimumGrossReturnUsd??6;
  if(!Number.isFinite(collateral)||collateral<=0||!Number.isFinite(minimumGross)||minimumGross<=0)
    throw new Error("Invalid research preference");
  const active=i.nowMs>=i.startMs&&i.nowMs<i.expiryMs;
  const remainingSeconds=Math.max(0,Math.ceil((i.expiryMs-i.nowMs)/1000));
  const roundProgressPercent=Math.max(0,Math.min(100,100*(i.nowMs-i.startMs)/(i.expiryMs-i.startMs)));
  const ask=i.askCents!=null&&Number.isFinite(i.askCents)&&i.askCents>0&&i.askCents<=100?
    i.askCents:null;
  const grossIfWinUsd=ask==null?null:collateral/(ask/100);
  // Strictly BEFORE fees/gas/slippage, conditional on actual full size fill and $1 redemption.
  const breakEvenWinProbability=ask==null?null:ask/100;
  const profitIfWinBeforeCostsUsd=grossIfWinUsd==null?null:grossIfWinUsd-collateral;
  // Explicit $0.10 COST SCENARIO, not a claim about actual network fees.
  const illustrativeBreakEvenWith10CentCost=grossIfWinUsd==null?null:(collateral+.10)/grossIfWinUsd;
  const isFresh=i.sourceFresh&&i.latestProviderAsOfMs!=null&&
    i.latestProviderAsOfMs<=i.nowMs&&i.nowMs-i.latestProviderAsOfMs<=10_000;
  let state:EntryWindowState,label:string,reason:string;
  if(!active){state="ROUND_CLOSED";label="ROUND NOT OPEN";reason="The exact WaterX round is not currently accepting a new research evaluation.";}
  else if(!isFresh){state="WAITING_FOR_SOURCE";label="WAIT FOR LIVE DATA";reason="WaterX market quote is missing or stale; no entry timing assessment.";}
  else if(!i.referenceConfirmed){state="REFERENCE_UNCONFIRMED";label="PRICE-TO-BEAT UNCONFIRMED";reason="WaterX reference price is not confirmed. Coinbase spot is not the official Chainlink TWAP settlement source.";} 
  else if(i.signalConflict){state="SIGNAL_CONFLICT";label="CONFLICTING SIGNALS";reason="Saved research strategies disagree. No qualified edge established.";}
  else if(!i.signal){state="NO_FROZEN_SIGNAL";label="WAIT FOR SAVED SIGNAL";reason="A live lean is not an acknowledged frozen prediction.";}
  else if(remainingSeconds<=45){state="LATE_TO_ENTER";label="LATE / EXECUTION RISK";reason="Too little time remains to rely on an indicative ask; fill and settlement risks are elevated.";}
  else if(ask==null){state="ASK_UNAVAILABLE";label="ENTRY PRICE UNKNOWN";reason="No current side-specific ask or verified full-size executable quote.";}
  else if(grossIfWinUsd!<minimumGross){state="RETURN_BELOW_PREFERENCE";label="PAYOUT TOO SMALL";reason="Illustrative gross payout falls below the selected $6 minimum, before fees; this does not prove expected value.";}
  else{state="EDGE_UNVERIFIED";label="TIMING OPEN · EDGE UNVERIFIED";reason=
    "Time and indicative payout pass basic screens, but no independently calibrated win probability or executable quote establishes positive expected value.";}
  return{state,label,reason,roundProgressPercent,remainingSeconds,signal:i.signal,
    askCents:ask,grossIfWinUsd,profitIfWinBeforeCostsUsd,breakEvenWinProbability,
    illustrativeBreakEvenWith10CentCost,qualifiedForecastProbability:null,executable:false,estimatedOnly:true};
}
