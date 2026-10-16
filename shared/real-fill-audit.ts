/** Real, user-attested WaterX fills crosschecked against existing immutable history.
 * Pure and read-only: does not submit orders or create/alter database records.
 * Matching by a similar displayed local clock time is explicitly forbidden.
 */
export type Side="UP"|"DOWN";
export type FrozenSignal={side:Side|null;acknowledgedAtMs:number|null;score:string;policyVersion:string|null};
export type VerifiedHistoryRound={
  marketId:string|null;roundId:string;intervalMinutes:5|15;startMs:number;expiryMs:number;
  outcome:Side|null;settlementStatus:string;
  primary:FrozenSignal;early:FrozenSignal;confirmation:FrozenSignal;
};
export type FilledPosition={
  marketId:string;roundId:string;intervalMinutes:5|15;startMs:number;expiryMs:number;
  filledAtMs:number;side:Side;priceCents:number;stakeUsd:number;
  feesUsd:number|null;actualPayoutUsd:number|null;
};
export type SignalAtEntry={
  state:"FROZEN_BEFORE_FILL"|"FROZEN_AFTER_FILL"|"MISSING_ACKNOWLEDGED_SIGNAL";
  selectedSide:Side|null;agreedWithTrade:boolean|null;officialScore:string|null;
  acknowledgedAtMs:number|null;
};
export type RealFillAudit={
  status:"INVALID_ENTRY"|"ROUND_IDENTITY_MISMATCH"|"FILL_TIME_UNVERIFIED"|"MATCHED";
  reason:string;primary:SignalAtEntry|null;early:SignalAtEntry|null;confirmation:SignalAtEntry|null;
  breakEvenBeforeFees:number|null;estimatedGrossIfCorrect:number|null;
  officialOutcome:Side|null;tradeCorrect:boolean|null;
  actualNetPnlUsd:number|null;actualPnlStatus:"USER_REPORTED"|"UNAVAILABLE";
};
const noSignal=(s:FrozenSignal):SignalAtEntry=>({
  state:"MISSING_ACKNOWLEDGED_SIGNAL",selectedSide:null,
  agreedWithTrade:null,officialScore:null,acknowledgedAtMs:s.acknowledgedAtMs,
});
export function reconcileRealFill(round:VerifiedHistoryRound,p:FilledPosition):RealFillAudit{
  const blank=(status:RealFillAudit["status"],reason:string):RealFillAudit=>({
    status,reason,primary:null,early:null,confirmation:null,
    breakEvenBeforeFees:null,estimatedGrossIfCorrect:null,officialOutcome:null,
    tradeCorrect:null,actualNetPnlUsd:null,actualPnlStatus:"UNAVAILABLE",
  });
  if(!Number.isSafeInteger(p.filledAtMs)||!Number.isFinite(p.priceCents)||
     p.priceCents<=0||p.priceCents>100||!Number.isFinite(p.stakeUsd)||p.stakeUsd<=0||
     (p.feesUsd!=null&&(!Number.isFinite(p.feesUsd)||p.feesUsd<0))||
     (p.actualPayoutUsd!=null&&(!Number.isFinite(p.actualPayoutUsd)||p.actualPayoutUsd<0)))
    return blank("INVALID_ENTRY","A filled price, positive stake and valid fill timestamp are required.");
  if(!round.marketId||!p.marketId||p.marketId!==round.marketId||
     p.roundId!==round.roundId||p.intervalMinutes!==round.intervalMinutes||
     p.startMs!==round.startMs||p.expiryMs!==round.expiryMs)
    return blank("ROUND_IDENTITY_MISMATCH","WaterX market, exact round, interval and boundaries must all match.");
  if(p.filledAtMs<round.startMs||p.filledAtMs>=round.expiryMs)
    return blank("FILL_TIME_UNVERIFIED","Reported fill timestamp is outside this exact market round. Check the WaterX fill receipt.");
  const compare=(s:FrozenSignal):SignalAtEntry=>{
    if(!s.side||!Number.isFinite(s.acknowledgedAtMs)||
       s.acknowledgedAtMs!<round.startMs||s.acknowledgedAtMs!>=round.expiryMs)return noSignal(s);
    if(s.acknowledgedAtMs!>p.filledAtMs)return {
      state:"FROZEN_AFTER_FILL",selectedSide:s.side,agreedWithTrade:null,
      officialScore:s.score,acknowledgedAtMs:s.acknowledgedAtMs};
    return {state:"FROZEN_BEFORE_FILL",selectedSide:s.side,
      agreedWithTrade:s.side===p.side,officialScore:s.score,
      acknowledgedAtMs:s.acknowledgedAtMs};
  };
  const officialOutcome=round.settlementStatus==="VERIFIED"?round.outcome:null;
  const tradeCorrect=officialOutcome==null?null:p.side===officialOutcome;
  // User-typed received payout and fees are explicitly attributed; never invent fills.
  const actualNetPnlUsd=officialOutcome!=null&&p.actualPayoutUsd!=null&&p.feesUsd!=null?
    p.actualPayoutUsd-p.stakeUsd-p.feesUsd:null;
  return {
    status:"MATCHED",reason:officialOutcome==null?
      "Matched an exact round. The official outcome has not been verified; no P&L is inferred.":
      "Matched the exact market and round; compare each signal only if frozen before this actual fill.",
    primary:compare(round.primary),early:compare(round.early),confirmation:compare(round.confirmation),
    breakEvenBeforeFees:p.priceCents/100,
    estimatedGrossIfCorrect:p.stakeUsd/(p.priceCents/100),
    officialOutcome,tradeCorrect,actualNetPnlUsd,
    actualPnlStatus:actualNetPnlUsd==null?"UNAVAILABLE":"USER_REPORTED",
  };
}
