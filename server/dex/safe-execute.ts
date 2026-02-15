import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { getAllCoins, getGasPaymentRefs, getTotalBalance } from "./coin-manager";
import { computeSafeGasBudget, pickGasCoin, buildMergeAllSuiCoinsTx } from "./gas";

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
  const requestedBudget = opts.gasBudget ?? 50_000_000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let coins = await getAllCoins(client, owner);

    if (coins.length === 0) {
      throw new Error("NO_SUI_COINS: agent wallet has no SUI coins");
    }

    const totalMist = getTotalBalance(coins);

    const safeBudget = computeSafeGasBudget(totalMist, requestedBudget);

    if (safeBudget < 5_000_000) {
      const balSui = (Number(totalMist) / 1e9).toFixed(4);
      throw new Error(`INSUFFICIENT_GAS: wallet has ${balSui} SUI which is too low for any transaction. Add more SUI to the agent wallet.`);
    }

    const gasCoin = pickGasCoin(coins, BigInt(safeBudget));

    if (!gasCoin && coins.length > 1 && totalMist > BigInt("15000000")) {
      console.log(`[SafeExecute] No single coin covers budget ${safeBudget}. Merging ${coins.length} coins...`);
      try {
        const mergeTx = await buildMergeAllSuiCoinsTx(client, owner);
        if (mergeTx) {
          await client.signAndExecuteTransaction({
            signer,
            transaction: mergeTx,
            options: { showEffects: true },
          });
          await new Promise((r) => setTimeout(r, 1000));
          coins = await getAllCoins(client, owner);
        }
      } catch (mergeErr: any) {
        console.log(`[SafeExecute] Coin merge failed: ${mergeErr.message?.slice(0, 80)}`);
      }
    }

    const tx = new Transaction();
    tx.setGasPayment(getGasPaymentRefs(coins));
    tx.setGasBudget(safeBudget);

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
        msg.includes("equivocated") ||
        msg.includes("GasBalanceTooLow");

      if (!retryable || attempt === MAX_RETRIES - 1) throw e;

      console.log(`[SafeExecute] Retryable error (attempt ${attempt + 1}/${MAX_RETRIES}): ${msg.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  throw new Error("EXECUTE_FAILED: exhausted retries");
}
