import { Transaction } from "@mysten/sui/transactions";
import type { WalletAccount } from "@mysten/wallet-standard";

export function dollarsToAtomicAmount(value: string, decimals = 6): string | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) return null;
  const atomic = BigInt(whole + fraction.padEnd(decimals, "0"));
  return atomic > BigInt(0) && atomic <= BigInt("18446744073709551615") ? atomic.toString() : null;
}
type SigningWallet = { features?: Record<string, unknown>; accounts?: readonly WalletAccount[] };
function notSubmitted(message:string):Error&{submissionState:"NOT_SUBMITTED"}{
  return Object.assign(new Error(message),{submissionState:"NOT_SUBMITTED" as const});
}
export async function signReviewedOwnerTransaction(input: {
  wallet: SigningWallet; account: WalletAccount; transaction: string;
  action: string; isCurrent: () => boolean;
}): Promise<{ digest: string }> {
  if (!["CREATE_ACCOUNT", "FUND", "FUND_USDC", "REDEEM_USDC", "WITHDRAW", "REVOKE"].includes(input.action))
    throw notSubmitted("This action has no released owner-signing flow.");
  if (!input.isCurrent() || !input.account.chains.includes("sui:mainnet") ||
    input.wallet.accounts && !input.wallet.accounts.some(a => a.address === input.account.address))
    throw notSubmitted("Reconnect the reviewed owner account on Sui mainnet before signing.");
  const feature = input.wallet.features?.["sui:signAndExecuteTransaction"] as {
    signAndExecuteTransaction?: (v: { transaction: Transaction; account: WalletAccount; chain: "sui:mainnet" }) => Promise<{ digest: string }>
  } | undefined;
  if (typeof feature?.signAndExecuteTransaction !== "function")
    throw notSubmitted("This wallet does not support Sui transaction signing. Open Slush with transaction support.");
  let tx:Transaction;
  try{tx=Transaction.from(input.transaction);}
  catch{throw notSubmitted("Prepared transaction is invalid; review this operation again.");}
  if (tx.getData().sender?.toLowerCase() !== input.account.address.toLowerCase())
    throw notSubmitted("Prepared transaction does not match the reviewed owner.");
  if (!input.isCurrent()) throw notSubmitted("Wallet identity changed; review this operation again.");
  // Invoked only by a separate explicit user approval. Do not retry submission:
  // the owner-confirm endpoint verifies successful effects and the exact intent.
  let result:{digest:string};
  try{result=await feature.signAndExecuteTransaction({ transaction: tx, account: input.account, chain: "sui:mainnet" });}
  catch(error){
    // A transport cancellation/timeout can follow accepted submission. Only the
    // standard explicit user-rejection code is treated as definitely unsubmitted.
    if((error as {code?:unknown})?.code===4001)throw notSubmitted("Owner declined wallet approval.");
    throw error;
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(result.digest))
    throw new Error("Wallet returned no usable transaction digest. Submission may be uncertain; check wallet activity before retrying.");
  return { digest: result.digest };
}
