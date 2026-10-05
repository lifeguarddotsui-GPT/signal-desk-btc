export type PurchaseEvidence = {
  status:"reported"|"locked"|"unavailable"; askCents:number|null;
  marketObjectId:string|null; selection:"YES"|"NO"|null;
};
export type EarlyDecision = {
  side:"UP"|"DOWN";probabilityUp:number;decisionAtMs:number;committedAtMs:number|null;
  policyVersion:string;observationId:string;eventId:string;workerReceivedAtMs:number|null;
};
export type OpportunityContext = {
  sourceId:"waterx.public.crypto.v1";observationId:string;receivedAtMs:number;
  providerEventAtMs:null;priceLastChangedAtMs:number|null;
  reference:{price:number|null;status:"confirmed"|"provisional"|"unavailable"};
  marketId:string;url:string;orderCutoffAtMs:null;
  probabilityEvidence:"available"|"invalid"|"unavailable";
  purchase:{up:PurchaseEvidence;down:PurchaseEvidence};
};
/** Indicative asks are NOT a verified full-size fill, and unknown fees/gas remain unknown. */
export function indicativeFiveDollar(askCents:number|null,minimumWinningProfit:1|2){
  const gross=askCents!==null&&Number.isFinite(askCents)&&askCents>0&&askCents<=100?5/(askCents/100):null;
  return {collateralAtomic:"5000000",settlementDecimals:6,collateralUsd:5,
    kind:"INDICATIVE_NOT_EXECUTABLE" as const,grossReceiptIfCorrect:gross,
    netReceiptIfCorrect:null,netProfitIfCorrect:null,expectedNet:null,breakEvenProbability:null,
    collateralLossIfIncorrect:5,feesUsd:null,gasSui:null,gasUsd:null,gasConversionBasis:null,
    minimumWinningProfit,winningProfitFilter:"UNQUALIFIED" as const,
    reason:"Full $5 fill, settlement-token USD basis, fees and gas are unverified. Ask-based gross illustration only."};
}
export function verifiedEconomics(totalCost:number,netReceiptIfWin:number,calibratedProbability:number|null){
  if(!Number.isFinite(totalCost)||!Number.isFinite(netReceiptIfWin)||totalCost<=0||netReceiptIfWin<=0)
    throw new Error("Invalid verified purchase economics");
  if(calibratedProbability!==null&&(!Number.isFinite(calibratedProbability)||calibratedProbability<0||calibratedProbability>1))
    throw new Error("Invalid qualified probability");
  return {netProfitIfWin:netReceiptIfWin-totalCost,
    expectedNet:calibratedProbability===null?null:calibratedProbability*netReceiptIfWin-totalCost,
    breakEvenProbability:totalCost/netReceiptIfWin,lossIfIncorrect:totalCost};
}
