import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

export const SUI_COIN_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

const MIN_GAS_RESERVE_MIST = BigInt("5000000");

export interface GasCoinRef {
  objectId: string;
  version: string;
  digest: string;
  balance: bigint;
}

export async function getAllCoins(client: SuiJsonRpcClient, owner: string): Promise<GasCoinRef[]> {
  const result = await client.getCoins({ owner, coinType: SUI_COIN_TYPE });
  const coins = (result.data || []).map((c: any) => ({
    objectId: c.coinObjectId,
    version: c.version,
    digest: c.digest,
    balance: BigInt(c.balance),
  }));
  coins.sort((a: GasCoinRef, b: GasCoinRef) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
  return coins;
}

export function getTotalBalance(coins: GasCoinRef[]): bigint {
  return coins.reduce((sum, c) => sum + c.balance, BigInt(0));
}

export function assertGasReserve(coins: GasCoinRef[], minReserveMist: bigint = MIN_GAS_RESERVE_MIST) {
  const total = getTotalBalance(coins);
  if (total < minReserveMist) {
    throw new Error(`INSUFFICIENT_GAS: wallet has ${total.toString()} MIST but needs at least ${minReserveMist.toString()} MIST (${Number(minReserveMist) / 1e9} SUI) for gas`);
  }
}

export function getGasPaymentRefs(coins: GasCoinRef[]) {
  return coins.map(c => ({
    objectId: c.objectId,
    version: c.version,
    digest: c.digest,
  }));
}
