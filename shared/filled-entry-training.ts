import {dollarOutcome} from "./dollar-entry-target";

/** A fill is not a quoted ask. A provider settlement badge is not independently verified
 * TWAP evidence. The importer must reconcile all proof IDs externally before marking
 * data as verified. This research module NEVER authorizes trading or model promotion.
 */
export type EntryFillEvidence={
  intervalMinutes:5|15;roundId:string;marketId:string;startMs:number;expiryMs:number;
  side:"UP"|"DOWN";filledAtMs:number;fillId:string;fillPriceCents:number;
  stakeUsd:number;entryFeesUsd:number;gasUsd:number;
  fillProof:{source:"WATERX_EXECUTION_RECEIPT";receiptId:string;marketId:string;verified:boolean};
  settlement:{source:"WATERX_VERIFIED_CHAINLINK_TWAP60";roundId:string;marketId:string;
    verified:boolean;disputed:boolean;anchorPrice:number;settlementPrice:number;
    settledAtMs:number;labelAvailableAtMs:number;proofId:string};
  forecast?:{source:"INDEPENDENT_MODEL";version:string;probabilityForSelection:number;
    createdAtMs:number;qualifiedAtMs:number;calibrationQualified:boolean};
};
export type EntryClockBand="FIRST_20_PERCENT"|"EARLY_20_TO_40"|"MIDDLE_40_TO_70"|"FINAL_30_PERCENT";
export function clockBand(entry:EntryFillEvidence):EntryClockBand{
  const ratio=(entry.filledAtMs-entry.startMs)/(entry.expiryMs-entry.startMs);
  return ratio<.2?"FIRST_20_PERCENT":ratio<.4?"EARLY_20_TO_40":
    ratio<.7?"MIDDLE_40_TO_70":"FINAL_30_PERCENT";
}
export function checkEntryProof(row:EntryFillEvidence,asOfMs:number):string|null{
  const s=row.settlement,f=row.fillProof;
  if(![5,15].includes(row.intervalMinutes)||!row.roundId||!row.marketId||
     !Number.isSafeInteger(row.startMs)||!Number.isSafeInteger(row.expiryMs)||
     row.expiryMs-row.startMs!==row.intervalMinutes*60000)return "INVALID_ROUND";
  if(!["UP","DOWN"].includes(row.side)||!row.fillId||!Number.isSafeInteger(row.filledAtMs)||
     row.filledAtMs<row.startMs||row.filledAtMs>=row.expiryMs)return "INVALID_OR_LATE_FILL";
  if(!f||f.source!=="WATERX_EXECUTION_RECEIPT"||f.verified!==true||
     f.marketId!==row.marketId||f.receiptId!==row.fillId)return "FILL_PROOF_UNVERIFIED";
  if(!s||s.source!=="WATERX_VERIFIED_CHAINLINK_TWAP60"||s.verified!==true||
     s.disputed!==false||s.marketId!==row.marketId||s.roundId!==row.roundId||
     !s.proofId)return "SETTLEMENT_PROOF_UNVERIFIED";
  if(![s.anchorPrice,s.settlementPrice].every(n=>Number.isFinite(n)&&n>0)||
     ![s.settledAtMs,s.labelAvailableAtMs,asOfMs].every(Number.isSafeInteger)||
     s.settledAtMs<row.expiryMs||s.labelAvailableAtMs<s.settledAtMs||
     s.labelAvailableAtMs>asOfMs)return "SETTLEMENT_TIMING_OR_PRICE_INVALID";
  if(!Number.isFinite(row.fillPriceCents)||row.fillPriceCents<=0||row.fillPriceCents>100||
    !Number.isFinite(row.stakeUsd)||row.stakeUsd<=0||
    ![row.entryFeesUsd,row.gasUsd].every(n=>Number.isFinite(n)&&n>=0&&n<=row.stakeUsd))
    return "INVALID_FILLED_ECONOMICS";
  if(row.forecast){
    const p=row.forecast;
    if(p.source!=="INDEPENDENT_MODEL"||p.calibrationQualified!==true||
       !p.version||!Number.isFinite(p.probabilityForSelection)||
       p.probabilityForSelection<=0||p.probabilityForSelection>=1||
       !Number.isSafeInteger(p.createdAtMs)||!Number.isSafeInteger(p.qualifiedAtMs)||
       p.qualifiedAtMs>p.createdAtMs||p.createdAtMs>row.filledAtMs)
      return "FORECAST_NOT_INDEPENDENT_OR_PRE_ENTRY";
  }
  return null;
}
export type FilledEntryResult={row:EntryFillEvidence;band:EntryClockBand;correct:boolean;
  netUsd:number;netWinningUsd:number;breakevenProbability:number;
  modelEdgePp:number|null;meetsOneToTwoDollarWinningTarget:boolean};
export function outcomeOfEntry(row:EntryFillEvidence):FilledEntryResult{
  const outcome=row.settlement.settlementPrice>=row.settlement.anchorPrice?"UP":"DOWN";
  const value=dollarOutcome(row.fillPriceCents,row.stakeUsd,row.entryFeesUsd+row.gasUsd);
  if(!value)throw new Error("Invalid filled economics");
  return {row,band:clockBand(row),correct:outcome===row.side,
    netUsd:outcome===row.side?value.netIfCorrectUsd:value.netIfIncorrectUsd,
    netWinningUsd:value.netIfCorrectUsd,breakevenProbability:value.breakevenProbability,
    modelEdgePp:row.forecast?(row.forecast.probabilityForSelection-value.breakevenProbability)*100:null,
    meetsOneToTwoDollarWinningTarget:value.netIfCorrectUsd>=1&&value.netIfCorrectUsd<=2};
}
const bands:EntryClockBand[]=["FIRST_20_PERCENT","EARLY_20_TO_40","MIDDLE_40_TO_70","FINAL_30_PERCENT"];
export type CohortSummary={band:EntryClockBand;side:"UP"|"DOWN";count:number;
  correct:number;accuracy:number|null;observedNetUsd:number;meanNetUsd:number|null;
  meanAskCents:number|null;targetPriceN:number;
  meanModelEdgePp:number|null; /** NOT actionable selection */
  qualifiedForecastN:number};
export function cohortSummary(rows:FilledEntryResult[]):CohortSummary[]{
  return bands.flatMap(band=>(["UP","DOWN"] as const).map(side=>{
    const group=rows.filter(r=>r.band===band&&r.row.side===side),n=group.length;
    const mean=(f:(r:FilledEntryResult)=>number)=>
      n?group.reduce((v,r)=>v+f(r),0)/n:null;
    const predicted=group.filter(r=>r.modelEdgePp!==null);
    return {band,side,count:n,correct:group.filter(r=>r.correct).length,
      accuracy:n?group.filter(r=>r.correct).length/n:null,
      observedNetUsd:group.reduce((v,r)=>v+r.netUsd,0),
      meanNetUsd:mean(r=>r.netUsd),meanAskCents:mean(r=>r.row.fillPriceCents),
      targetPriceN:group.filter(r=>r.meetsOneToTwoDollarWinningTarget).length,
      meanModelEdgePp:predicted.length?predicted.reduce((v,r)=>v+r.modelEdgePp!,0)/predicted.length:null,
      qualifiedForecastN:predicted.length};
  }));
}
/** Splits by unique round before considering results; final TEST is untouched and
 * cannot tune the proposed time window. This is retrospective, selection-biased,
 * actual-filled-position research, not a substitute for all-round prospective labels.
 */
export function researchVerifiedFills(rows:EntryFillEvidence[],interval:5|15,asOfMs:number){
  const excluded:Record<string,number>={},accepted:EntryFillEvidence[]=[],seen=new Set<string>();
  for(const row of rows){
    if(row.intervalMinutes!==interval)continue;
    const reason=checkEntryProof(row,asOfMs);
    const roundKey=`${row.marketId}:${row.roundId}:${row.startMs}:${row.expiryMs}`;
    if(reason){excluded[reason]=(excluded[reason]??0)+1;continue;}
    if(seen.has(roundKey)){excluded.MULTIPLE_FILLS_SAME_ROUND=(excluded.MULTIPLE_FILLS_SAME_ROUND??0)+1;continue;}
    seen.add(roundKey);accepted.push(row);
  }
  accepted.sort((a,b)=>a.startMs-b.startMs||a.marketId.localeCompare(b.marketId));
  const n=accepted.length,calStart=accepted[Math.floor(n*.60)]?.startMs??Infinity,
    testStart=accepted[Math.floor(n*.80)]?.startMs??Infinity,
    embargoMs=interval*60000;
  const training=accepted.filter(r=>r.startMs<calStart&&r.settlement.labelAvailableAtMs+embargoMs<calStart),
    calibration=accepted.filter(r=>r.startMs>=calStart&&r.startMs<testStart&&r.settlement.labelAvailableAtMs+embargoMs<testStart),
    test=accepted.filter(r=>r.startMs>=testStart);
  const reasons:string[]=[];
  if(training.length<60||calibration.length<24||test.length<30)
    reasons.push("Requires >=60 train, >=24 calibration, >=30 untouched test verified whole-round fills after label embargo");
  if([training,calibration,test].some(part=>new Set(part.map(r=>r.settlement.settlementPrice>=r.settlement.anchorPrice?"UP":"DOWN")).size<2))
    reasons.push("Both WaterX official settlement outcomes must exist in each chronological partition");
  const results=test.map(outcomeOfEntry),report={interval,status:reasons.length?"INSUFFICIENT_VERIFIED_FILLS":"OBSERVATIONAL_TEST_AVAILABLE",
    generatedAtMs:asOfMs,totalInput:rows.filter(r=>r.intervalMinutes===interval).length,
    acceptedUniqueRounds:n,excluded,
    partitionCounts:{training:training.length,calibration:calibration.length,test:test.length},
    testCohorts:cohortSummary(results),testNetUsd:results.reduce((v,r)=>v+r.netUsd,0),
    testCorrect:results.filter(r=>r.correct).length,
    testN:results.length,reasons,
    limitation:"Filled orders are selection-biased. Outcomes use externally reconciled WaterX Chainlink TWAP60 labels; proof booleans alone are NOT cryptographic validation. Never infer all-market opportunity or causality from observed fill cohorts.",
    automaticPromotion:false,tradeAuthority:false,qualifiedEdge:false,
    nextStep:"Independent fill/settlement proof ingestion, larger prospective coverage, independent calibrated forecast and held-out after-cost EV required."};
  return report;
}
