import { generateAgentWallet, decryptKeypair } from "./dex/wallet-manager";
import { suiClient } from "./sui-verify";
import { getOnChainBalance } from "./sui-verify";
import { db } from "./db";
import { systemConfig, userRewardWallets } from "@shared/schema";
import { eq } from "drizzle-orm";
import { Transaction } from "@mysten/sui/transactions";
import { suiToMist } from "./dex/gas";

let rewardWalletAddress: string | null = null;
let rewardWalletEncryptedKey: string | null = null;

// In-memory cache for per-user reward wallets (avoids DB round-trip on every escrow)
const _userRewardWalletCache = new Map<string, { address: string; encryptedKey: string }>();

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

// ── Per-user reward wallet management ────────────────────────────────────────

/**
 * Get or create a personal reward wallet for a user (identified by their connected SUI address).
 * Each user gets one isolated wallet — rewards accumulate privately and are always claimable.
 */
export async function getOrCreateUserRewardWallet(ownerWallet: string): Promise<{ address: string; encryptedKey: string }> {
  // In-memory cache hit
  const cached = _userRewardWalletCache.get(ownerWallet);
  if (cached) return cached;

  // DB lookup
  const existing = await db.select().from(userRewardWallets).where(eq(userRewardWallets.ownerWallet, ownerWallet)).limit(1);
  if (existing.length > 0) {
    const result = { address: existing[0].address, encryptedKey: existing[0].encryptedKey };
    _userRewardWalletCache.set(ownerWallet, result);
    return result;
  }

  // Create new
  const wallet = generateAgentWallet();
  await db.insert(userRewardWallets).values({
    ownerWallet,
    address: wallet.address,
    encryptedKey: wallet.encryptedPrivateKey,
  });

  const result = { address: wallet.address, encryptedKey: wallet.encryptedPrivateKey };
  _userRewardWalletCache.set(ownerWallet, result);
  console.log(`[UserRewardWallet] Created personal reward wallet for ${ownerWallet.slice(0, 10)}...: ${wallet.address}`);
  return result;
}

export async function getUserRewardWalletBalance(ownerWallet: string): Promise<{ sui: number; mist: string; address: string }> {
  const uw = await getOrCreateUserRewardWallet(ownerWallet);
  const bal = await getOnChainBalance(uw.address);
  return { ...bal, address: uw.address };
}

/**
 * Transfer funds from the user's personal reward wallet to their connected SUI address.
 * This is the claim function for the new per-user wallet system.
 */
export async function transferFromUserRewardWallet(
  ownerWallet: string,
  recipientAddress: string,
  amountSui: number,
): Promise<{ txDigest: string; amountTransferred: number }> {
  const uw = await getOrCreateUserRewardWallet(ownerWallet);
  const amountMist = suiToMist(amountSui);
  if (amountMist <= BigInt(0)) throw new Error("Claim amount must be positive");

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const walletBalance = await getOnChainBalance(uw.address);
      const gasBudget = BigInt(10_000_000);
      const availableMist = BigInt(walletBalance.mist) - gasBudget;

      if (availableMist < amountMist) {
        throw new Error(`User reward wallet has insufficient balance. Needs ${amountSui.toFixed(4)} SUI but only ${(Number(availableMist) / 1e9).toFixed(4)} SUI available.`);
      }

      const keypair = decryptKeypair(uw.encryptedKey);
      const tx = new Transaction();
      tx.setSender(uw.address);
      tx.setGasBudget(gasBudget);
      const [coin] = tx.splitCoins(tx.gas, [amountMist]);
      tx.transferObjects([coin], recipientAddress);

      const result = await suiClient.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true },
      });

      if (result.effects?.status?.status !== "success") {
        throw new Error("User reward wallet transfer failed on-chain");
      }

      console.log(`[UserRewardWallet] Claimed ${amountSui.toFixed(4)} SUI from ${uw.address.slice(0, 10)}... → ${recipientAddress.slice(0, 10)}... (tx: ${result.digest})`);
      return { txDigest: result.digest, amountTransferred: amountSui };
    } catch (err: any) {
      const errMsg = String(err?.message ?? err);
      if (isRateLimitError(errMsg) && attempt < MAX_RETRIES - 1) {
        const delay = (attempt + 1) * 3000;
        console.log(`[UserRewardWallet] RPC rate limited (attempt ${attempt + 1}/${MAX_RETRIES}) — retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }

  throw new Error("User reward wallet transfer exhausted retries");
}

// ── Agent → User reward wallet escrow ────────────────────────────────────────

/**
 * Transfer reward funds from an agent's funding wallet to the target address.
 * If recipientAddress is provided, uses it directly (per-user wallet path).
 * Falls back to the global reward wallet if no recipient is given.
 */
export async function escrowRewardFromAgent(
  agentWalletEncryptedKey: string,
  agentWalletAddress: string,
  amountSui: number,
  recipientAddress?: string,
): Promise<{ txDigest: string; amountTransferred: number }> {
  const target = recipientAddress ?? rewardWalletAddress;
  if (!target) throw new Error("Reward wallet not initialized");

  const amountMist = suiToMist(amountSui);
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
  tx.transferObjects([coin], target);

  const result = await suiClient.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true },
  });

  if (result.effects?.status?.status !== "success") {
    throw new Error("Escrow transfer failed on-chain");
  }

  console.log(`[RewardWallet] Escrowed ${amountSui.toFixed(4)} SUI from ${agentWalletAddress.slice(0, 10)}... -> ${target.slice(0, 10)}... (tx: ${result.digest})`);
  return { txDigest: result.digest, amountTransferred: amountSui };
}

export async function transferToSavingsWallet(
  agentWalletEncryptedKey: string,
  agentWalletAddress: string,
  savingsWalletAddress: string,
  amountSui: number
): Promise<{ txDigest: string; amountTransferred: number }> {
  const amountMist = suiToMist(amountSui);
  if (amountMist <= BigInt(0)) throw new Error("Savings transfer amount must be positive");

  const agentBalance = await getOnChainBalance(agentWalletAddress);
  const gasBudget = BigInt(10_000_000);
  const availableMist = BigInt(agentBalance.mist) - gasBudget;

  if (availableMist < amountMist) {
    throw new Error(`Funding wallet has insufficient balance for savings transfer. Needs ${amountSui.toFixed(4)} SUI but only ${(Number(availableMist) / 1e9).toFixed(4)} SUI available.`);
  }

  const keypair = decryptKeypair(agentWalletEncryptedKey);
  const tx = new Transaction();
  tx.setSender(agentWalletAddress);
  tx.setGasBudget(gasBudget);
  const [coin] = tx.splitCoins(tx.gas, [amountMist]);
  tx.transferObjects([coin], savingsWalletAddress);

  const result = await suiClient.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true },
  });

  if (result.effects?.status?.status !== "success") {
    throw new Error("Savings transfer failed on-chain");
  }

  console.log(`[Savings] Transferred ${amountSui.toFixed(4)} SUI from funding ${agentWalletAddress.slice(0, 10)}... → savings ${savingsWalletAddress.slice(0, 10)}... (tx: ${result.digest})`);
  return { txDigest: result.digest, amountTransferred: amountSui };
}

export async function transferFromAgentWallet(
  agentWalletEncryptedKey: string,
  agentWalletAddress: string,
  recipientAddress: string,
  amountSui: number
): Promise<{ txDigest: string; amountTransferred: number }> {
  const amountMist = suiToMist(amountSui);
  if (amountMist <= BigInt(0)) throw new Error("Transfer amount must be positive");

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const agentBalance = await getOnChainBalance(agentWalletAddress);
      const gasBudget = BigInt(10_000_000);
      const availableMist = BigInt(agentBalance.mist) - gasBudget;

      if (availableMist < amountMist) {
        throw new Error(`Agent wallet has insufficient balance. Needs ${amountSui.toFixed(4)} SUI but only ${(Number(availableMist) / 1e9).toFixed(4)} SUI available.`);
      }

      const keypair = decryptKeypair(agentWalletEncryptedKey);
      const tx = new Transaction();
      tx.setSender(agentWalletAddress);
      tx.setGasBudget(gasBudget);
      const [coin] = tx.splitCoins(tx.gas, [amountMist]);
      tx.transferObjects([coin], recipientAddress);

      const result = await suiClient.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true },
      });

      if (result.effects?.status?.status !== "success") {
        throw new Error("Agent wallet transfer failed on-chain");
      }

      console.log(`[RewardWallet] Transferred ${amountSui.toFixed(4)} SUI from agent ${agentWalletAddress.slice(0, 10)}... to ${recipientAddress.slice(0, 10)}... (tx: ${result.digest})`);
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

  throw new Error("Agent wallet transfer exhausted retries");
}

function isRateLimitError(msg: string): boolean {
  return msg.includes("429") || msg.includes("rate limit") || msg.includes("Too Many Requests") || msg.includes("Unexpected status code: 429");
}

export async function transferRewardToUser(
  userWalletAddress: string,
  amountSui: number
): Promise<{ txDigest: string; amountTransferred: number }> {
  if (!rewardWalletAddress || !rewardWalletEncryptedKey) throw new Error("Reward wallet not initialized");

  const amountMist = suiToMist(amountSui);
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
