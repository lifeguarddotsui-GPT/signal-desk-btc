const MAINNET_RPC = "https://fullnode.mainnet.sui.io:443";

export interface TxVerification {
  digest: string;
  status: "success" | "failure" | "pending" | "timeout";
  sender?: string;
  checkpoint?: string;
  balanceChanges?: Array<{
    owner: string;
    coinType: string;
    amount: string;
    direction: "SENT" | "RECEIVED";
  }>;
  error?: string;
}

export async function waitForFinalized(
  digest: string,
  maxRetries = 20,
  delayMs = 1500
): Promise<TxVerification> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(MAINNET_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sui_getTransactionBlock",
          params: [
            digest,
            {
              showEffects: true,
              showInput: true,
              showBalanceChanges: true,
            },
          ],
        }),
      });

      const data = await res.json();

      if (data.error) {
        if (i < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        return {
          digest,
          status: "pending",
          error: data.error.message || "Transaction not found yet",
        };
      }

      const tx = data.result;
      const status = tx?.effects?.status?.status;

      if (status === "success") {
        const bc = (tx.balanceChanges || []).map((b: any) => ({
          owner: b.owner?.AddressOwner || b.owner?.ObjectOwner || "unknown",
          coinType: b.coinType,
          amount: b.amount,
          direction: Number(b.amount) < 0 ? "SENT" as const : "RECEIVED" as const,
        }));

        return {
          digest,
          status: "success",
          sender: tx.transaction?.data?.sender,
          checkpoint: tx.checkpoint,
          balanceChanges: bc,
        };
      }

      if (status === "failure") {
        return {
          digest,
          status: "failure",
          error: tx.effects?.status?.error || "Transaction failed on-chain",
        };
      }
    } catch {
      // network error, retry
    }

    if (i < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return {
    digest,
    status: "timeout",
    error: "Timed out waiting for transaction finality",
  };
}

export function formatSuiAmount(mistStr: string): string {
  const mist = BigInt(mistStr);
  const sui = Number(mist) / 1e9;
  return sui.toFixed(4);
}

export function shortAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}
