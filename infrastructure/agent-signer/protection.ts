// This module belongs in the isolated signer runtime, NOT public web handlers.
// Only encrypted envelopes leave it; wrapping keys belong to that runtime's secrets.
import {Ed25519Keypair} from "@mysten/sui/keypairs/ed25519";
import {verifyPersonalMessageSignature} from "@mysten/sui/verify";
import {normalizeSuiAddress,isValidSuiAddress} from "@mysten/sui/utils";
import {Transaction} from "@mysten/sui/transactions";
import {placeOrder,type PredictClient} from "@waterx/sdk/prediction";
import {z} from "zod";
import {agentPolicySchema} from "../../shared/agent-policy";
import {matchesOwnerIntent} from "../../server/agent/intent";

export const signerPermitSchema=z.object({
  domain:z.literal("bluewater-mainnet-session-v1"),
  network:z.literal("sui:mainnet"),
  owner:z.string(),accountId:z.string(),delegateAddress:z.string(),
  nonce:z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion:z.number().int().positive(),policy:agentPolicySchema,
  issuedAtMs:z.number().int().nonnegative(),expiresAtMs:z.number().int().positive(),
  experimentalConfirmed:z.boolean(),compoundingConfirmed:z.boolean(),pilotOneOrder:z.boolean(),
}).strict();
export type SignerPermit=z.infer<typeof signerPermitSchema>;
export async function verifySignerPermit(message:Uint8Array,signature:string,now:number) {
  if(message.length>16384||signature.length>8192||!Number.isSafeInteger(now))throw new Error("Invalid session permit envelope");
  const p=signerPermitSchema.parse(JSON.parse(new TextDecoder().decode(message)));
  for(const a of [p.owner,p.accountId,p.delegateAddress])if(!isValidSuiAddress(a))throw new Error("Invalid permit address");
  if(p.policy.network!=="mainnet"||p.policy.signalSource!=="EXPERIMENTAL_QUALIFICATION_GATES"||
    !p.experimentalConfirmed||p.policy.compound&&!p.compoundingConfirmed||
    p.issuedAtMs>now||p.expiresAtMs<=now||p.expiresAtMs-p.issuedAtMs>p.policy.sessionDurationMs||
    p.policy.sessionGasBudgetMist<1)throw new Error("Unapproved or expired mainnet session permit");
  const key=await verifyPersonalMessageSignature(message,signature);
  if(key.toSuiAddress()!==normalizeSuiAddress(p.owner))throw new Error("Session permit is not signed by the owner");
  return {...p,owner:normalizeSuiAddress(p.owner),accountId:normalizeSuiAddress(p.accountId),
    delegateAddress:normalizeSuiAddress(p.delegateAddress)};
}
type KeyEnvelope={version:1;owner:string;delegateAddress:string;nonce:number[];ciphertext:number[]};
const aad=(owner:string,delegate:string)=>new TextEncoder().encode(JSON.stringify({
  version:1,network:"sui:mainnet",owner:normalizeSuiAddress(owner),delegate:normalizeSuiAddress(delegate)}));
export async function createProtectedDelegate(owner:string,wrappingKey:CryptoKey):Promise<KeyEnvelope> {
  if(!isValidSuiAddress(owner))throw new Error("Invalid owner");
  const key=Ed25519Keypair.generate(),delegate=key.toSuiAddress(),nonce=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce,additionalData:aad(owner,delegate)},
    wrappingKey,new TextEncoder().encode(key.getSecretKey()));
  return {version:1,owner:normalizeSuiAddress(owner),delegateAddress:delegate,
    nonce:Array.from(nonce),ciphertext:Array.from(new Uint8Array(ciphertext))};
}
export async function recoverProtectedDelegate(e:KeyEnvelope,wrappingKey:CryptoKey) {
  if(e.version!==1||e.nonce.length!==12)throw new Error("Unsupported protected key envelope");
  const plaintext=await crypto.subtle.decrypt({name:"AES-GCM",iv:new Uint8Array(e.nonce),
    additionalData:aad(e.owner,e.delegateAddress)},wrappingKey,new Uint8Array(e.ciphertext));
  const key=Ed25519Keypair.fromSecretKey(new TextDecoder().decode(plaintext));
  if(key.toSuiAddress()!==e.delegateAddress)throw new Error("Protected key identity mismatch");
  return key;
}
export type RestrictedOrder={marketId:string;selection:"YES"|"NO";maxSpendAtomic:string;
  minSharesAtomic:string;priceCapBps:number;expiryAtMs:number;gasBudgetMist:number};
/** Reconstruct the only permitted SDK transaction rather than accepting arbitrary
 * caller-selected Move targets, recipients, management commands or withdrawals.
 * The service must additionally verify current on-chain delegation, source
 * decision and atomic wallet/session reservations before calling this guard. */
export function assertRestrictedTransaction(c:PredictClient,p:SignerPermit,order:RestrictedOrder,
  actual:ReturnType<Transaction["getData"]>,now:number) {
  if(p.expiresAtMs<=now||p.delegateAddress!==actual.sender||
    order.expiryAtMs<=now||order.expiryAtMs>p.expiresAtMs||
    !/^[1-9]\d*$/.test(order.maxSpendAtomic)||! /^[1-9]\d*$/.test(order.minSharesAtomic)||
    BigInt(order.maxSpendAtomic)>BigInt(Math.min(p.policy.roundCollateralCents,
      p.policy.maxOrderCents??p.policy.roundCollateralCents))*BigInt(10000)||
    !Number.isSafeInteger(order.gasBudgetMist)||order.gasBudgetMist<1||
    order.gasBudgetMist>p.policy.sessionGasBudgetMist||
    actual.gasData.owner!==p.delegateAddress||actual.gasData.budget===null||
    BigInt(actual.gasData.budget)<BigInt(1)||BigInt(actual.gasData.budget)>BigInt(order.gasBudgetMist)||
    !Number.isSafeInteger(order.priceCapBps)||order.priceCapBps<1||order.priceCapBps>10000||
    BigInt(order.minSharesAtomic)>BigInt("18446744073709551615"))
    throw new Error("Transaction exceeds owner session authority");
  const expected=new Transaction();expected.setSender(p.delegateAddress);
  placeOrder(c,expected,{accountId:p.accountId,receiverAccountId:p.accountId,
    marketId:order.marketId,selection:order.selection,maxSpend:order.maxSpendAtomic,
    minShares:order.minSharesAtomic,priceCapBps:order.priceCapBps,expiryTs:order.expiryAtMs});
  if(!matchesOwnerIntent(expected.getData(),actual))
    throw new Error("Signer permits only the exact self-receiving prediction order");
}
