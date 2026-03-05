import { generateAgentWallet, decryptKeypair } from "./dex/wallet-manager";
import { suiClient } from "./sui-verify";
import { getOnChainBalance } from "./sui-verify";
import { db } from "./db";
import { systemConfig } from "@shared/schema";
import { eq } from "drizzle-orm";
import { Transaction } from "@mysten/sui/transactions";

let rewardWalletAddress: string | null = null;
let rewardWalletEncryptedKey: string | null = null;

export async function initRewardWallet(): Promise<{ address: string }> {
  const existing = await db.select().from(systemConfig).where(eq(systemConfig.key, "reward_wallet_address"));
  const existingKey = await db.select().from(systemConfig).where(eq(systemConfig.key, "reward_wallet_key"));

  if (existing.length > 0 && existingKey.length > 0) {
    rewardWalletAddress = existing[0].value;
    rewardWalletEncryptedKey = existingKey[0].value;
    console.log(`[RewardWallet] Loaded reward wallet: ${rewardWalletAddress}`);
    return { address: rewardWalletAddress };
  }

  const wallet = generateAgentWallet();
  rewardWalletAddress = wallet.address;
  rewardWalletEncryptedKey = wallet.encryptedPrivateKey;

  await db.insert(systemConfig).values({ key: "reward_wallet_address", value: wallet.address }).onConflictDoUpdate({ target: systemConfig.key, set: { value: wallet.address } });
  await db.insert(systemConfig).values({ key: "reward_wallet_key", value: wallet.encryptedPrivateKey }).onConflictDoUpdate({ target: systemConfig.key, set: { value: wallet.encryptedPrivateKey } });

  console.log(`[RewardWallet] Created new reward wallet: ${wallet.address}`);
  return { address: wallet.address };
}

export function getRewardWalletAddress(): string {
  if (!rewardWalletAddress) throw new Error("Reward wallet not initialized");
  return rewardWalletAddress;
}

export async function getRewardWalletBalance(): Promise<{ sui: number; mist: string }> {
  if (!rewardWalletAddress) throw new Error("Reward wallet not initialized");
  return getOnChainBalance(rewardWalletAddress);
}

export async function escrowRewardFromAgent(
  agentWalletEncryptedKey: string,
  agentWalletAddress: string,
  amountSui: number
): Promise<{ txDigest: string; amountTransferred: number }> {
  if (!rewardWalletAddress) throw new Error("Reward wallet not initialized");

  const amountMist = BigInt(Math.floor(amountSui * 1e9));
  if (amountMist <= BigInt(0)) throw new Error("Reward amount must be positive");

  const agentBalance = await getOnChainBalance(agentWalletAddress);
  const gasBudget = BigInt(10_000_000);
  const balanceMist = BigInt(agentBalance.mist);
  const availableMist = balanceMist - gasBudget;

  if (availableMist < amountMist) {
    throw new Error(`Agent wallet has insufficient balance for escrow. Needs ${amountSui.toFixed(4)} SUI but only ${(Number(availableMist) / 1e9).toFixed(4)} SUI available.`);
  }

  const keypair = decryptKeypair(agentWalletEncryptedKey);
  const tx = new Transaction();
  tx.setSender(agentWalletAddress);
  tx.setGasBudget(gasBudget);
  const [coin] = tx.splitCoins(tx.gas, [amountMist]);
  tx.transferObjects([coin], rewardWalletAddress);

  const result = await suiClient.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true },
  });

  if (result.effects?.status?.status !== "success") {
    throw new Error("Escrow transfer failed on-chain");
  }

  console.log(`[RewardWallet] Escrowed ${amountSui.toFixed(4)} SUI from ${agentWalletAddress.slice(0, 10)}... -> reward wallet (tx: ${result.digest})`);
  return { txDigest: result.digest, amountTransferred: amountSui };
}

function isRateLimitError(msg: string): boolean {
  return msg.includes("429") || msg.includes("rate limit") || msg.includes("Too Many Requests") || msg.includes("Unexpected status code: 429");
}

export async function transferRewardToUser(
  userWalletAddress: string,
  amountSui: number
): Promise<{ txDigest: string; amountTransferred: number }> {
  if (!rewardWalletAddress || !rewardWalletEncryptedKey) throw new Error("Reward wallet not initialized");

  const amountMist = BigInt(Math.floor(amountSui * 1e9));
  if (amountMist <= BigInt(0)) throw new Error("Claim amount must be positive");

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const walletBalance = await getOnChainBalance(rewardWalletAddress);
      const gasBudget = BigInt(10_000_000);
      const availableMist = BigInt(walletBalance.mist) - gasBudget;

      if (availableMist < amountMist) {
        throw new Error(`Reward wallet has insufficient balance. Needs ${amountSui.toFixed(4)} SUI but only ${(Number(availableMist) / 1e9).toFixed(4)} SUI available.`);
      }

      const keypair = decryptKeypair(rewardWalletEncryptedKey);
      const tx = new Transaction();
      tx.setSender(rewardWalletAddress);
      tx.setGasBudget(gasBudget);
      const [coin] = tx.splitCoins(tx.gas, [amountMist]);
      tx.transferObjects([coin], userWalletAddress);

      const result = await suiClient.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true },
      });

      if (result.effects?.status?.status !== "success") {
        throw new Error("Reward transfer to user failed on-chain");
      }

      console.log(`[RewardWallet] Transferred ${amountSui.toFixed(4)} SUI to ${userWalletAddress.slice(0, 10)}... (tx: ${result.digest})`);
      return { txDigest: result.digest, amountTransferred: amountSui };
    } catch (err: any) {
      const errMsg = String(err?.message ?? err);
      if (isRateLimitError(errMsg) && attempt < MAX_RETRIES - 1) {
        const delay = (attempt + 1) * 3000;
        console.log(`[RewardWallet] RPC rate limited (attempt ${attempt + 1}/${MAX_RETRIES}) — retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }

  throw new Error("Reward transfer exhausted retries");
}
