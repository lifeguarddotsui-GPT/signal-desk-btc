import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const SUI_RPC = "https://fullnode.mainnet.sui.io:443";

let _client: SuiJsonRpcClient | null = null;

export function getThrottledSuiClient(): SuiJsonRpcClient {
  if (!_client) {
    _client = new SuiJsonRpcClient(SUI_RPC);
  }
  return _client;
}

const balanceCache = new Map<string, { value: number; ts: number }>();
const BALANCE_TTL_MS = 15_000;

export function getCachedWalletBalance(address: string): number | null {
  const entry = balanceCache.get(address);
  if (!entry) return null;
  if (Date.now() - entry.ts > BALANCE_TTL_MS) {
    balanceCache.delete(address);
    return null;
  }
  return entry.value;
}

export function setCachedWalletBalance(address: string, value: number): void {
  balanceCache.set(address, { value, ts: Date.now() });
}
