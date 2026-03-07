import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { getAllCoins, getTotalBalance, type GasCoinRef } from "./coin-manager";

export const MIST_PER_SUI = BigInt("1000000000");

export const COLLATERAL_GAS_RESERVE_SUI = 1.0;

export const GAS_PER_CLOSE_SUI = 0.15;

export const MIN_EXECUTABLE_GAS_SUI = 0.05;
export const MIN_EXECUTABLE_GAS_MIST = BigInt("50000000");
export const GAS_BUFFER_PCT = 25;
export const GAS_BUDGET_FLOOR = BigInt("10000000");
export const GAS_BUDGET_CEIL = BigInt("200000000");

export function suiToMist(sui: number): bigint {
  return BigInt(Math.floor(sui * 1e9));
}

export async function getSuiBalanceMist(client: SuiJsonRpcClient, owner: string): Promise<bigint> {
  const bal = await client.getBalance({ owner, coinType: "0x2::sui::SUI" });
  return BigInt(bal.totalBalance);
}

export function pickGasCoin(
  coins: GasCoinRef[],
  needMist: bigint,
): GasCoinRef | null {
  for (const c of coins) {
    if (c.balance >= needMist) return c;
  }
  return null;
}

export async function buildMergeAllSuiCoinsTx(
  client: SuiJsonRpcClient,
  owner: string,
): Promise<Transaction | null> {
  const coins = await getAllCoins(client, owner);
  if (coins.length <= 1) return null;

  const primary = coins[0];
  const rest = coins.slice(1);

  const tx = new Transaction();
  tx.setGasPayment([{
    objectId: primary.objectId,
    version: primary.version,
    digest: primary.digest,
  }]);
  tx.setGasBudget(Number(GAS_BUDGET_FLOOR));

  const mergeCoins = rest.map((c) => tx.object(c.objectId));
  tx.mergeCoins(tx.gas, mergeCoins);

  return tx;
}

export function computeSafeGasBudget(totalMist: bigint, requestedBudget: number): number {
  const available = Number(totalMist);
  const safeMax = Math.floor(available * 0.95);

  let budget = Math.min(requestedBudget, safeMax);

  if (budget > Number(GAS_BUDGET_CEIL)) {
    budget = Number(GAS_BUDGET_CEIL);
  }

  if (budget < 1_000_000) {
    budget = Math.min(1_000_000, safeMax);
  }

  if (budget > safeMax) {
    budget = safeMax;
  }

  return Math.max(budget, 0);
}

export async function estimateGasBudget(
  client: SuiJsonRpcClient,
  tx: Transaction,
  signerAddress: string,
): Promise<number> {
  try {
    const bytes = await tx.build({ client: client as any });
    const bytesBase64 = Buffer.from(bytes).toString("base64");
    const dry = await (client as any).dryRunTransactionBlock({ transactionBlock: bytesBase64 });

    if (dry?.effects?.gasUsed) {
      const comp = BigInt(dry.effects.gasUsed.computationCost);
      const stor = BigInt(dry.effects.gasUsed.storageCost);
      const rebate = BigInt(dry.effects.gasUsed.storageRebate);

      let net = comp + stor - rebate;
      if (net < BigInt(0)) net = comp + stor;

      const buffered = net + (net * BigInt(GAS_BUFFER_PCT)) / BigInt(100);
      let budget = buffered < GAS_BUDGET_FLOOR ? GAS_BUDGET_FLOOR : buffered;
      if (budget > GAS_BUDGET_CEIL) budget = GAS_BUDGET_CEIL;

      return Number(budget);
    }
  } catch (e: any) {
    console.log(`[Gas] Dry-run estimation failed: ${e.message?.slice(0, 80)} — using fallback`);
  }

  return 50_000_000;
}

export function isRateLimitError(msg: string): boolean {
  return msg.includes("429") || msg.includes("rate limit") || msg.includes("Too Many Requests") || msg.includes("Unexpected status code: 429");
}

export async function ensureMinGasReserve(
  client: SuiJsonRpcClient,
  owner: string,
): Promise<{ ok: true; balanceSui: number } | { ok: false; reason: string; balanceSui: number; isRateLimit?: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const balMist = await getSuiBalanceMist(client, owner);
      const balSui = Number(balMist) / 1e9;

      if (balSui < MIN_EXECUTABLE_GAS_SUI) {
        return {
          ok: false,
          reason: `Wallet has ${balSui.toFixed(4)} SUI — too low for any transaction (need at least ${MIN_EXECUTABLE_GAS_SUI} SUI). Add more SUI to the agent wallet.`,
          balanceSui: balSui,
        };
      }
      return { ok: true, balanceSui: balSui };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (isRateLimitError(msg) && attempt < 2) {
        console.log(`[Gas] RPC rate limited during gas check (attempt ${attempt + 1}/3) — retrying in ${(attempt + 1) * 2}s...`);
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      if (isRateLimitError(msg)) {
        return { ok: false, reason: `RPC rate limited (429) — temporarily unable to check gas balance. Will retry next tick.`, balanceSui: -1, isRateLimit: true };
      }
      throw err;
    }
  }
  return { ok: true, balanceSui: 0 };
}
