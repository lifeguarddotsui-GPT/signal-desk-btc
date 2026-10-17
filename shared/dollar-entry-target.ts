/** $5 gross/winning-profit arithmetic only. No probability or execution authority.
 * Prices are cents per $1 payout share. Fees are additional to the $5 stake.
 */
export type DollarOutcome = {
  askCents:number; stakeUsd:number; extraCostsUsd:number;
  grossIfCorrectUsd:number; netIfCorrectUsd:number;
  netIfIncorrectUsd:number; breakevenProbability:number;
  maxAskForOneDollarProfitCents:number;
  maxAskForTwoDollarProfitCents:number;
  target:"BELOW_ONE_DOLLAR"|"ONE_TO_TWO_DOLLARS"|"ABOVE_TWO_DOLLARS";
};
export function dollarOutcome(askCents:number,stakeUsd=5,extraCostsUsd=0):DollarOutcome|null{
  if(![askCents,stakeUsd,extraCostsUsd].every(Number.isFinite)||
    askCents<=0||askCents>100||stakeUsd<=0||extraCostsUsd<0)return null;
  const gross=stakeUsd/(askCents/100),net=gross-stakeUsd-extraCostsUsd;
  return {askCents,stakeUsd,extraCostsUsd,grossIfCorrectUsd:gross,
    netIfCorrectUsd:net,netIfIncorrectUsd:-stakeUsd-extraCostsUsd,
    breakevenProbability:(stakeUsd+extraCostsUsd)/gross,
    maxAskForOneDollarProfitCents:100*stakeUsd/(stakeUsd+extraCostsUsd+1),
    maxAskForTwoDollarProfitCents:100*stakeUsd/(stakeUsd+extraCostsUsd+2),
    target:net<1?"BELOW_ONE_DOLLAR":net<=2?"ONE_TO_TWO_DOLLARS":"ABOVE_TWO_DOLLARS"};
}
