import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { getAllCoins, getTotalBalance, type GasCoinRef } from "./coin-manager";

export const MIST_PER_SUI = BigInt("1000000000");

export const COLLATERAL_GAS_RESERVE_SUI = 0.10;

export const GAS_PER_CLOSE_SUI = 0.05;

export const MIN_EXECUTABLE_GAS_SUI = 0.005;
export const MIN_EXECUTABLE_GAS_MIST = BigInt("5000000");
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
  const primaryCoin = tx.object(primary.objectId);
  const mergeCoins = rest.map((c) => tx.object(c.objectId));
  tx.mergeCoins(primaryCoin, mergeCoins);
  tx.setGasBudget(Number(GAS_BUDGET_FLOOR));

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

export async function ensureMinGasReserve(
  client: SuiJsonRpcClient,
  owner: string,
): Promise<{ ok: true } | { ok: false; reason: string; balanceSui: number }> {
  const balMist = await getSuiBalanceMist(client, owner);
  const balSui = Number(balMist) / 1e9;

  if (balSui < MIN_EXECUTABLE_GAS_SUI) {
    return {
      ok: false,
      reason: `Wallet has ${balSui.toFixed(4)} SUI — too low for any transaction (need at least ${MIN_EXECUTABLE_GAS_SUI} SUI). Add more SUI to the agent wallet.`,
      balanceSui: balSui,
    };
  }
  return { ok: true };
}
