import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { computeSafeGasBudget, buildMergeAllSuiCoinsTx } from "./gas";
import { getAllCoins, getTotalBalance, getGasPaymentRefs } from "./coin-manager";

/**
 * Simulate a transaction block without submitting it.
 * Returns the dry-run result (effects + events) or null if simulation fails.
 * Never submits the real TX. Use this to preflight a TX before committing gas.
 */
export async function dryRunTxBlock(opts: {
  client: any;
  owner: string;
  buildTx: (tx: Transaction) => Promise<void> | void;
  gasBudget?: number;
}): Promise<{ effects: any; events: any[]; status: "success" | "failure"; error?: string } | null> {
  try {
    const { client, owner, buildTx } = opts;
    const coins = await getAllCoins(client, owner);
    if (coins.length === 0) return null;

    const gasCoin = coins[0];
    const tx = new Transaction();
    tx.setGasBudget(opts.gasBudget ?? 50_000_000);
    tx.setGasPayment([{ objectId: gasCoin.objectId, version: gasCoin.version, digest: gasCoin.digest }]);

    await buildTx(tx);

    const txBytes = await tx.build({ client });
    const result = await client.dryRunTransactionBlock({
      transactionBlock: Buffer.from(txBytes).toString("base64"),
    });

    const status = result?.effects?.status?.status === "success" ? "success" : "failure";
    const error = status === "failure" ? (result?.effects?.status?.error || "unknown error") : undefined;
    return { effects: result?.effects, events: result?.events || [], status, error };
  } catch (err: any) {
    console.log(`[dryRunTxBlock] Simulation error: ${err.message?.slice(0, 120)}`);
    return null;
  }
}

const MAX_RETRIES = 3;
const LOCKED_OBJECT_DELAY_MS = 12_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const MERGE_FINALITY_WAIT_MS = 3_000;

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

    if (coins.length > 1) {
      console.log(`[SafeExecute] Wallet has ${coins.length} coins (largest: ${(Number(coins[0].balance) / 1e9).toFixed(4)} SUI, total: ${(Number(totalMist) / 1e9).toFixed(4)} SUI). Merging into single coin...`);
      try {
        const mergeTx = await buildMergeAllSuiCoinsTx(client, owner);
        if (mergeTx) {
          const mergeResult = await client.signAndExecuteTransaction({
            signer,
            transaction: mergeTx,
            options: { showEffects: true },
          });
          if (mergeResult.effects?.status?.status === "success") {
            await new Promise((r) => setTimeout(r, MERGE_FINALITY_WAIT_MS));
            coins = await getAllCoins(client, owner);
            console.log(`[SafeExecute] Merge complete. Now ${coins.length} coin(s), balance: ${(Number(coins[0]?.balance ?? 0) / 1e9).toFixed(4)} SUI`);
          } else {
            console.log(`[SafeExecute] Merge TX failed: ${mergeResult.effects?.status?.error ?? "unknown"} — proceeding with largest coin`);
          }
        }
      } catch (mergeErr: any) {
        console.log(`[SafeExecute] Coin merge failed: ${mergeErr.message?.slice(0, 100)} — proceeding with largest coin`);
      }
    }

    const tx = new Transaction();
    tx.setGasBudget(safeBudget);

    const gasCoin = coins[0];
    tx.setGasPayment([{
      objectId: gasCoin.objectId,
      version: gasCoin.version,
      digest: gasCoin.digest,
    }]);

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

      const isLockedError =
        msg.includes("already locked") ||
        msg.includes("ObjectLocked") ||
        msg.includes("object locked");

      const isRateLimited =
        msg.includes("429") ||
        msg.includes("rate limit") ||
        msg.includes("Too Many Requests") ||
        msg.includes("Unexpected status code: 429");

      const retryable =
        isLockedError ||
        isRateLimited ||
        msg.includes("Balance of gas") ||
        msg.includes("ObjectNotFound") ||
        msg.includes("Object version") ||
        msg.includes("is not available") ||
        msg.includes("TransactionExpired") ||
        msg.includes("equivocated") ||
        msg.includes("GasBalanceTooLow") ||
        msg.includes("ObjectVersionUnavailableForConsumption") ||
        msg.includes("OBJECT_NOT_FOUND") ||
        msg.includes("Error checking transaction input objects") ||
        msg.includes("rejected as invalid");

      if (!retryable || attempt === MAX_RETRIES - 1) throw e;

      const delay = isLockedError
        ? LOCKED_OBJECT_DELAY_MS
        : isRateLimited
        ? 3_000 * (attempt + 1)
        : DEFAULT_RETRY_DELAY_MS * (attempt + 1);

      console.log(`[SafeExecute] ${isLockedError ? "Object locked" : "Retryable"} error (attempt ${attempt + 1}/${MAX_RETRIES}), waiting ${delay}ms: ${msg.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new Error("EXECUTE_FAILED: exhausted retries");
}
