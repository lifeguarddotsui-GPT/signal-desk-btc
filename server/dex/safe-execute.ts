import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { getAllCoins, assertGasReserve, getGasPaymentRefs } from "./coin-manager";

const DEFAULT_GAS_BUDGET = 50_000_000;
const MAX_RETRIES = 3;

interface SafeExecuteOpts {
  client: SuiJsonRpcClient;
  signer: any;
  owner: string;
  buildTx: (tx: Transaction) => Promise<void> | void;
  gasBudget?: number;
}

export async function signAndExecuteSafe(opts: SafeExecuteOpts) {
  const { client, signer, owner, buildTx } = opts;
  const gasBudget = opts.gasBudget ?? DEFAULT_GAS_BUDGET;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const coins = await getAllCoins(client, owner);

    if (coins.length === 0) {
      throw new Error("NO_SUI_COINS: agent wallet has no SUI coins");
    }

    assertGasReserve(coins);

    const tx = new Transaction();
    tx.setGasPayment(getGasPaymentRefs(coins));
    tx.setGasBudget(gasBudget);

    await buildTx(tx);

    try {
      const res = await client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        options: { showEffects: true, showEvents: true },
      });
      return res;
    } catch (e: any) {
      const msg = String(e?.message ?? e);

      const retryable =
        msg.includes("Balance of gas") ||
        msg.includes("ObjectNotFound") ||
        msg.includes("Object version") ||
        msg.includes("is not available") ||
        msg.includes("TransactionExpired") ||
        msg.includes("equivocated");

      if (!retryable || attempt === MAX_RETRIES - 1) throw e;

      console.log(`[SafeExecute] Retryable error (attempt ${attempt + 1}/${MAX_RETRIES}): ${msg.slice(0, 100)}`);
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  throw new Error("EXECUTE_FAILED: exhausted retries");
}
