import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const MAX_CONCURRENT = 3;
const QUEUE_TIMEOUT_MS = 60_000;
const GLOBAL_COOLDOWN_MS = 10_000;

let activeRequests = 0;

interface QueueEntry {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const waitQueue: QueueEntry[] = [];

let globalCooldownUntil = 0;

const BALANCE_CACHE_TTL_MS = 20_000;
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

function trigger429Backoff() {
  const newCooldown = Date.now() + GLOBAL_COOLDOWN_MS;
  if (newCooldown > globalCooldownUntil) {
    globalCooldownUntil = newCooldown;
    console.log(`[RPC] 429 detected — global cooldown for ${GLOBAL_COOLDOWN_MS / 1000}s`);
  }
}

function acquireSlot(): boolean {
  if (activeRequests < MAX_CONCURRENT) {
    activeRequests++;
    return true;
  }
  return false;
}

function releaseSlot(): void {
  activeRequests = Math.max(0, activeRequests - 1);
  drainQueue();
}

function drainQueue(): void {
  while (waitQueue.length > 0 && activeRequests < MAX_CONCURRENT) {
    const next = waitQueue.shift();
    if (!next) continue;
    clearTimeout(next.timer);
    activeRequests++;
    next.resolve();
  }
}

async function waitForSlot(): Promise<void> {
  const cooldownRemaining = globalCooldownUntil - Date.now();
  if (cooldownRemaining > 0) {
    await new Promise(r => setTimeout(r, cooldownRemaining));
  }

  if (acquireSlot()) return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waitQueue.findIndex(w => w.resolve === resolve);
      if (idx >= 0) waitQueue.splice(idx, 1);
      reject(new Error(`RPC throttle queue timeout (${waitQueue.length} queued, ${activeRequests} active)`));
    }, QUEUE_TIMEOUT_MS);
    waitQueue.push({ resolve, reject, timer });
  });
  // Slot was already acquired by drainQueue — do not acquire again
}

export async function withRpcThrottle<T>(fn: () => Promise<T>): Promise<T> {
  await waitForSlot();
  try {
    const result = await fn();
    return result;
  } catch (err: any) {
    if (is429Error(err)) {
      trigger429Backoff();
    }
    throw err;
  } finally {
    releaseSlot();
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
        const jitter = Math.random() * 500;
        const delayMs = Math.min(2000 * Math.pow(2, attempt) + jitter, 15_000);
        console.log(`[RPC] 429 — retry ${attempt + 1}/${maxRetries} in ${Math.round(delayMs)}ms`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

export function getRpcStats() {
  return {
    active: activeRequests,
    queued: waitQueue.length,
    cooldownRemaining: Math.max(0, globalCooldownUntil - Date.now()),
  };
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
