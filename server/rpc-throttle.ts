import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const MAX_CONCURRENT = 3;
const QUEUE_TIMEOUT_MS = 15000;

let activeRequests = 0;
const waitQueue: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

const BALANCE_CACHE_TTL_MS = 10_000;
const balanceCache = new Map<string, { balance: number; fetchedAt: number }>();

export function getCachedWalletBalance(walletAddr: string): number | null {
  const entry = balanceCache.get(walletAddr);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > BALANCE_CACHE_TTL_MS) {
    balanceCache.delete(walletAddr);
    return null;
  }
  return entry.balance;
}

export function setCachedWalletBalance(walletAddr: string, balance: number): void {
  balanceCache.set(walletAddr, { balance, fetchedAt: Date.now() });
}

export function invalidateCachedWalletBalance(walletAddr: string): void {
  balanceCache.delete(walletAddr);
}

function is429Error(err: any): boolean {
  const msg = String(err?.message || err || "");
  return msg.includes("429") || msg.includes("rate limit") || msg.includes("Too Many Requests") || msg.includes("Unexpected status code: 429");
}

export async function withRpcThrottle<T>(fn: () => Promise<T>): Promise<T> {
  if (activeRequests < MAX_CONCURRENT) {
    activeRequests++;
    try {
      return await fn();
    } finally {
      activeRequests--;
      drainQueue();
    }
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waitQueue.findIndex(w => w.resolve === resolve);
      if (idx >= 0) waitQueue.splice(idx, 1);
      reject(new Error("RPC throttle queue timeout"));
    }, QUEUE_TIMEOUT_MS);
    waitQueue.push({ resolve, timer });
  });

  try {
    return await fn();
  } finally {
    activeRequests--;
    drainQueue();
  }
}

export async function withRpcThrottleAndRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await withRpcThrottle(fn);
    } catch (err: any) {
      lastErr = err;
      if (is429Error(err)) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.log(`[RPC] 429 rate-limited — retry ${attempt + 1}/${maxRetries} in ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

function drainQueue() {
  while (waitQueue.length > 0 && activeRequests < MAX_CONCURRENT) {
    const next = waitQueue.shift();
    if (next) {
      clearTimeout(next.timer);
      activeRequests++;
      next.resolve();
    }
  }
}

export function getRpcStats() {
  return { active: activeRequests, queued: waitQueue.length };
}

const SUI_RPC = "https://fullnode.mainnet.sui.io:443";

const RPC_METHODS = [
  "getBalance", "getCoins", "getOwnedObjects",
  "queryEvents", "queryTransactionBlocks", "getTransactionBlock",
  "signAndExecuteTransaction", "executeTransactionBlock",
  "multiGetTransactionBlocks", "dryRunTransactionBlock",
  "getObject", "multiGetObjects",
];

let sharedClient: SuiJsonRpcClient | null = null;

export function getThrottledSuiClient(): SuiJsonRpcClient {
  if (sharedClient) return sharedClient;

  const raw = new SuiJsonRpcClient({ url: SUI_RPC, network: "mainnet" });

  sharedClient = new Proxy(raw, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && RPC_METHODS.includes(prop) && typeof val === "function") {
        return (...args: any[]) => withRpcThrottle(() => val.apply(target, args));
      }
      return val;
    },
  });

  return sharedClient;
}
