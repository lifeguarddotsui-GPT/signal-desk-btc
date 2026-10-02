/** Architecture only. No executor, wallet client, signing or order submission exists. */
export type PaperRiskLimits={maxPositionSpend:number;maxDailyLoss:number;maxDrawdown:number;
  maxSlippageBps:number;maxFeedAgeMs:number;minimumEdge:number;minimumLiquidity:number;maxGas:number;killSwitch:boolean};
export type FutureConstrainedIntent={roundId:string;intervalMinutes:5|15;side:"UP"|"DOWN";
  maximumSpend:number;maximumPrice:number;expiryMs:number;approvedModelArtifact:string};
export type FutureExecutableQuote={roundId:string;side:"UP"|"DOWN";quotedAtMs:number;expiresAtMs:number;
  executableCost:number;fees:number;gas:number;slippageBps:number;payoutIfCorrect:number;liquidity:number;verified:boolean};
export type FuturePaperDecision={action:"HOLD";reasons:string[]}|
  {action:"TRADE";intent:FutureConstrainedIntent;deterministicRiskApproval:string};
export interface FuturePaperEconomics {
  assess(modelProbability:number,quote:FutureExecutableQuote,limits:Readonly<PaperRiskLimits>):FuturePaperDecision;
}
// A prediction is always UP/DOWN when eligible. HOLD exists only in the future economics layer.
// Risk approval is separate from the model and cannot be overridden by a planner.