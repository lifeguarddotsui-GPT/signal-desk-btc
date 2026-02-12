import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { SUI_COIN_TYPE } from "@shared/schema";

export const suiClient = new SuiJsonRpcClient({
  url: "https://fullnode.mainnet.sui.io:443",
  network: "mainnet",
});

export async function verifyTxDigest(txDigest: string) {
  const tx = await suiClient.getTransactionBlock({
    digest: txDigest,
    options: {
      showEffects: true,
      showEvents: true,
      showInput: true,
      showBalanceChanges: true,
    },
  });

  const status = tx.effects?.status?.status;
  if (status !== "success") {
    throw new Error(`Transaction not successful: ${status}`);
  }

  const checkpoint = tx.checkpoint ? Number(tx.checkpoint) : undefined;
  const sender = tx.transaction?.data?.sender;
  const balanceChanges = tx.balanceChanges || [];

  return { tx, checkpoint, sender, balanceChanges };
}

export interface DepositVerification {
  agentWalletAddress: string;
  protocolFeeAddress: string;
  expectedAgentMist: bigint;
  expectedFeeMist: bigint;
  sender: string;
}

export function verifyDepositTransfers(
  balanceChanges: any[],
  verification: DepositVerification
): { valid: boolean; reason?: string } {
  if (!verification.sender) {
    return { valid: false, reason: "Transaction sender address is required" };
  }

  const normalizeAddr = (a: string) => a.toLowerCase();
  const isSuiCoin = (coinType: string) =>
    coinType === "0x2::sui::SUI" || coinType === SUI_COIN_TYPE;

  const agentChange = balanceChanges.find(
    (bc: any) =>
      bc.owner?.AddressOwner &&
      normalizeAddr(bc.owner.AddressOwner) === normalizeAddr(verification.agentWalletAddress) &&
      isSuiCoin(bc.coinType)
  );

  if (!agentChange) {
    return { valid: false, reason: "No SUI transfer found to agent wallet address" };
  }

  const agentReceived = BigInt(agentChange.amount);
  const tolerance = BigInt(1000);
  if (agentReceived < verification.expectedAgentMist - tolerance ||
      agentReceived > verification.expectedAgentMist + tolerance) {
    return {
      valid: false,
      reason: `Agent wallet received ${agentReceived} MIST but expected ~${verification.expectedAgentMist} MIST`,
    };
  }

  const feeChange = balanceChanges.find(
    (bc: any) =>
      bc.owner?.AddressOwner &&
      normalizeAddr(bc.owner.AddressOwner) === normalizeAddr(verification.protocolFeeAddress) &&
      isSuiCoin(bc.coinType)
  );

  if (!feeChange) {
    return { valid: false, reason: "No SUI transfer found to protocol fee address" };
  }

  const feeReceived = BigInt(feeChange.amount);
  if (feeReceived < verification.expectedFeeMist - tolerance ||
      feeReceived > verification.expectedFeeMist + tolerance) {
    return {
      valid: false,
      reason: `Protocol fee address received ${feeReceived} MIST but expected ~${verification.expectedFeeMist} MIST`,
    };
  }

  const senderChange = balanceChanges.find(
    (bc: any) =>
      bc.owner?.AddressOwner &&
      normalizeAddr(bc.owner.AddressOwner) === normalizeAddr(verification.sender) &&
      isSuiCoin(bc.coinType) &&
      BigInt(bc.amount) < BigInt(0)
  );

  if (!senderChange) {
    return { valid: false, reason: "No debit found from sender address" };
  }

  const senderDebit = BigInt(senderChange.amount) * BigInt(-1);
  const expectedGross = verification.expectedAgentMist + verification.expectedFeeMist;
  if (senderDebit < expectedGross - tolerance) {
    return {
      valid: false,
      reason: `Sender debit ${senderDebit} MIST is less than expected gross ${expectedGross} MIST`,
    };
  }

  return { valid: true };
}

export async function getOnChainBalance(address: string) {
  const bal = await suiClient.getBalance({
    owner: address,
    coinType: SUI_COIN_TYPE,
  });

  const mist = BigInt(bal.totalBalance);
  const sui = Number(mist) / 1e9;

  return { coinType: SUI_COIN_TYPE, mist: bal.totalBalance, sui };
}
