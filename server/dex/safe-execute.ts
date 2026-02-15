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
  dryRun?: boolean;
  allowedTargets?: Set<string>;
}

export async function signAndExecuteSafe(opts: SafeExecuteOpts) {
  const { client, signer, owner, buildTx, dryRun = false } = opts;
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

    if (opts.allowedTargets) {
      const PYTH_PACKAGE = "0x04e20ddf36af412a4096f9014f4a565af9e812db9a05cc40254846cf6ed0ad91";
      const WORMHOLE_PACKAGE = "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a";
      const ORACLE_ALLOWED_PACKAGES = new Set([PYTH_PACKAGE, WORMHOLE_PACKAGE]);

      const txData = tx.getData();
      if (txData && txData.commands) {
        for (const cmd of txData.commands) {
          if (cmd.$kind === "MoveCall" && cmd.MoveCall) {
            const target = `${cmd.MoveCall.package}::${cmd.MoveCall.module}::${cmd.MoveCall.function}`;
            const isAllowed =
              opts.allowedTargets.has(target) ||
              target.startsWith("0x2::") ||
              ORACLE_ALLOWED_PACKAGES.has(cmd.MoveCall.package);
            if (!isAllowed) {
              throw new Error(`BLOCKED: unauthorized Move call target "${target}". Only calls to approved contracts are allowed.`);
            }
          }
        }
      }
    }

    if (dryRun) {
      try {
        const txBytes = await tx.build({ client: client as any });
        const dryRunResult = await (client as any).dryRunTransactionBlock({
          transactionBlock: Buffer.from(txBytes).toString("base64"),
        });

        if (dryRunResult?.effects?.status?.status === "failure") {
          const dryRunError = dryRunResult.effects.status.error || "Dry-run failed";
          throw new Error(`DRY_RUN_FAILED: ${dryRunError}`);
        }
        console.log(`[SafeExecute] Dry-run passed for ${owner.slice(0, 10)}...`);
      } catch (dryErr: any) {
        if (dryErr.message?.startsWith("DRY_RUN_FAILED:")) {
          throw dryErr;
        }
        console.log(`[SafeExecute] Dry-run check unavailable: ${dryErr.message?.slice(0, 80)} — proceeding to submit`);
      }
    }

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
