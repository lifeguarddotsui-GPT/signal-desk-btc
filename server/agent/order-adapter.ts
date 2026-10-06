import {Transaction} from "@mysten/sui/transactions";
import {placeOrder,getMarketById} from "@waterx/sdk/prediction";
import {protocolClient,rpc,address,assertAccountOwner} from "./protocol";
import {experimentalFinalSignal} from "./final-signal";
import type {TimedDecision} from "../../shared/timed-decision";

export type PredictionOrderIntent={
  owner:string;accountId:string;delegate:string;decision:TimedDecision;
  policyVersion:number;
  market:{marketId:string;roundId:string;intervalMinutes:5|15;startMs:number;expiryMs:number;
    upSelection:"YES"|"NO";downSelection:"YES"|"NO";provenance:"waterx.public.crypto.v1"};
  maxSpendAtomic:string;minSharesAtomic:string;priceCapBps:number;expiryAtMs:number;gasBudgetMist:number;
};
const u64=(s:string)=>/^[1-9]\d*$/.test(s)&&BigInt(s)<=BigInt("18446744073709551615");
export function assertOrderIntent(v:PredictionOrderIntent,now:number) {
  const s=experimentalFinalSignal(v.decision,now),m=v.market;
  if(!s)throw new Error("Committed unexpired qualification-gate decision required");
  if(!Number.isSafeInteger(v.policyVersion)||v.policyVersion<1)throw new Error("Invalid policy version");
  if(m.provenance!=="waterx.public.crypto.v1"||!/^0x[0-9a-f]{64}$/i.test(m.marketId)||
    m.roundId!==s.roundId||m.intervalMinutes!==s.interval||m.startMs!==s.startMs||m.expiryMs!==s.expiryMs||
    !["YES","NO"].includes(m.upSelection)||!["YES","NO"].includes(m.downSelection)||m.upSelection===m.downSelection)
    throw new Error("Exact-round official YES/NO market mapping required");
  if(!u64(v.maxSpendAtomic)||!u64(v.minSharesAtomic)||!Number.isSafeInteger(v.priceCapBps)||
    v.priceCapBps<1||v.priceCapBps>10000||!Number.isSafeInteger(v.expiryAtMs)||
    v.expiryAtMs<=now||v.expiryAtMs>s.expiryMs||!Number.isSafeInteger(v.gasBudgetMist)||v.gasBudgetMist<1)
    throw new Error("Invalid enforceable order or gas limits");
  address(v.owner);address(v.accountId);address(v.delegate);
  return s.side==="UP"?m.upSelection:m.downSelection;
}
/** Builds ONLY a self-receiving place_order. The private signing key never enters
 * this process. Max spend/min shares/price cap/expiry are on-chain constraints,
 * not an indicative quote and not proof of a fill. */
export async function preparePredictionOrder(v:PredictionOrderIntent) {
  const selection=assertOrderIntent(v,Date.now()),c=await protocolClient();
  await assertAccountOwner(address(v.owner),v.accountId);
  const market=await getMarketById(c,{marketId:v.market.marketId});
  if(market.marketIdHex.toLowerCase()!==v.market.marketId.toLowerCase()||market.resolved||market.paused)
    throw new Error("Prediction market is resolved, paused or does not match");
  const tx=new Transaction();tx.setSender(address(v.delegate));tx.setGasBudget(v.gasBudgetMist);
  placeOrder(c,tx,{accountId:address(v.accountId),receiverAccountId:address(v.accountId),
    marketId:v.market.marketId,selection,maxSpend:v.maxSpendAtomic,minShares:v.minSharesAtomic,
    priceCapBps:v.priceCapBps,expiryTs:v.expiryAtMs});
  // Building resolves the delegate's actual owned gas coins. Failure is explicit.
  const bytes=await tx.build({client:rpc});
  const simulation=await rpc.core.simulateTransaction({transaction:bytes,checksEnabled:true,
    include:{effects:true,events:true,balanceChanges:true}});
  if(simulation.$kind!=="Transaction"||!simulation.Transaction.status.success)
    throw new Error("Prediction placement simulation failed with validation enabled");
  // This gate is intentionally checked again after network reads and simulation.
  assertOrderIntent(v,Date.now());
  return {bytes,digest:await tx.getDigest({client:rpc}),selection,receiverAccountId:address(v.accountId),
    decisionId:v.decision.id,policyVersion:v.policyVersion,checksEnabled:true as const,
    stage:"SIMULATED_PLACEMENT_NOT_FILL" as const};
}
