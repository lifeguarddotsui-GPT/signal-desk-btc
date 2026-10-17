/** Distinct, explicit sources. Never derive live WaterX outcome from Coinbase.
 * Chainlink BTC/USD TWAP60 is the MARKET'S SETTLEMENT PRODUCT, NOT the Coinbase
 * spot series or the WaterX website's visual Oracle preview.
 */
export const CHAINLINK_BTC_TWAP60_REFERENCE =
  "https://data.chain.link/streams/btc-usd-twap-60s-streams" as const;
export type VerifiedSettlementPreview = {
  source:"WATERX_REPORTED_VERIFIED_SETTLEMENT";
  anchorPrice:number; settlePrice:number;
  outcome:"UP"|"DOWN";settledAtMs:number;
  /** This guarantees WaterX's validation path, not independently replayed Chainlink proofs. */
  proofScope:"WATERX_PROVIDER_VALIDATED" ;
};
export function verifiedWaterxTwapSettlement(input:{
  labelStatus:unknown;disputed?:unknown;anchorConfirmed:unknown;anchorPrice:unknown;
  settlePrice:unknown;outcome:unknown;expiryMs:unknown;settledAtMs:unknown;
}):VerifiedSettlementPreview|null {
  const {labelStatus,disputed,anchorConfirmed,anchorPrice,settlePrice,outcome,expiryMs,settledAtMs}=input;
  if(labelStatus!=="verified"||disputed===true||anchorConfirmed!==true||
    typeof anchorPrice!=="number"||!Number.isFinite(anchorPrice)||anchorPrice<=0||
    typeof settlePrice!=="number"||!Number.isFinite(settlePrice)||settlePrice<=0||
    !Number.isSafeInteger(expiryMs)||!Number.isSafeInteger(settledAtMs)||
    (settledAtMs as number)<=(expiryMs as number))return null;
  const resolved=(settlePrice>=anchorPrice?"UP":"DOWN");
  if(typeof outcome!=="string"||outcome.toUpperCase()!==resolved)return null;
  return {source:"WATERX_REPORTED_VERIFIED_SETTLEMENT",anchorPrice,settlePrice,
    outcome:resolved,settledAtMs:settledAtMs as number,
    proofScope:"WATERX_PROVIDER_VALIDATED"};
}
