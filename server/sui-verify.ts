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

  return { tx, checkpoint, sender };
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
