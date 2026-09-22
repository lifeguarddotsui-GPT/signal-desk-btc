import { createHash, randomUUID } from "node:crypto";
import { Turnkey, defaultSuiAccountAtIndex } from "@turnkey/sdk-server";
import { db, pool } from "../db";
import { custodyAuditEvents } from "../../shared/schema";

const SUI_ADDRESS = /^0x[0-9a-f]{64}$/;

export class CustodyUnavailableError extends Error {
  code = "TURNKEY_CUSTODY_UNAVAILABLE" as const;
}

function credentials() {
  const organizationId = process.env.TURNKEY_ORGANIZATION_ID;
  const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;
  const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
  const tradePolicyId = process.env.TURNKEY_TRADE_POLICY_ID;
  const withdrawalPolicyId = process.env.TURNKEY_WITHDRAWAL_POLICY_ID;
  if (!organizationId || !apiPublicKey || !apiPrivateKey || !tradePolicyId || !withdrawalPolicyId) {
    throw new CustodyUnavailableError("Turnkey credentials and separate trade/withdrawal policy IDs are not configured.");
  }
  if (tradePolicyId === withdrawalPolicyId) {
    throw new CustodyUnavailableError("Trade and withdrawal authority must use separate Turnkey policies.");
  }
  return { organizationId, apiPublicKey, apiPrivateKey, tradePolicyId, withdrawalPolicyId };
}

function client() {
  const config = credentials();
  return {
    organizationId: config.organizationId,
    api: new Turnkey({
      apiBaseUrl: "https://api.turnkey.com",
      defaultOrganizationId: config.organizationId,
      apiPublicKey: config.apiPublicKey,
      apiPrivateKey: config.apiPrivateKey,
    }).apiClient(),
  };
}

export function turnkeyConfigured() {
  // Turnkey's Sui integration signs opaque raw payloads. Until Blue Water has
  // a verified PTB validator and separate scoped API principals, credential
  // presence alone must never make Mainnet custody available.
  return false;
}

export async function provisionIsolatedSuiWallet(input: {
  agentId: string;
  ownerAddress: string;
  policyVersion: string;
}) {
  const { api, organizationId } = client();
  const requestHash = createHash("sha256")
    .update(`${input.agentId}:${input.ownerAddress}:${input.policyVersion}`)
    .digest("hex");
  const walletName = `blue-water-${requestHash.slice(0, 16)}`;
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [input.agentId]);
    const existing = (await api.getWallets({ organizationId })).wallets.filter(
      (wallet) => wallet.walletName === walletName,
    );
    if (existing.length > 1) throw new Error("Multiple Turnkey wallets match this agent provisioning identity.");
    const walletId = existing[0]?.walletId;
    const created = walletId
      ? null
      : await api.createWallet({
          organizationId,
          walletName,
          accounts: [defaultSuiAccountAtIndex(0)],
        });
    const resolvedWalletId = walletId ?? created!.walletId;
    const createdAddress = created?.addresses[0]?.toLowerCase();
    const accounts = createdAddress
      ? null
      : await api.getWalletAccounts({ organizationId, walletId: resolvedWalletId });
    const address = createdAddress ?? accounts?.accounts.find(
      (account) => account.addressFormat === "ADDRESS_FORMAT_SUI",
    )?.address.toLowerCase();
    if (!address || !SUI_ADDRESS.test(address)) throw new Error("Turnkey did not return a valid Sui address.");
    const { account } = await api.getWalletAccount({
      organizationId,
      walletId: resolvedWalletId,
      address,
    });
    if (account.walletId !== resolvedWalletId || account.address.toLowerCase() !== address) {
      throw new Error("Turnkey wallet account identity did not reconcile.");
    }
    if (!account.publicKey) throw new Error("Turnkey did not return the Sui public key.");
    return {
      walletId: resolvedWalletId,
      address,
      publicKey: account.publicKey,
      requestHash,
      recovered: Boolean(existing.length),
      addressFormat: account.addressFormat,
      curve: account.curve,
    };
  } catch (error) {
    await db.insert(custodyAuditEvents).values({
      id: randomUUID(),
      agentId: input.agentId,
      ownerAddress: input.ownerAddress,
      eventType: "TURNKEY_SUI_WALLET_PROVISION_FAILED",
      policyVersion: input.policyVersion,
      requestHash,
      outcome: "FAILED",
      evidence: { provider: "TURNKEY", code: error instanceof Error ? error.name : "UNKNOWN" },
    });
    throw error;
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [input.agentId]);
    } finally {
      lockClient.release();
    }
  }
}