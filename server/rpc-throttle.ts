import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const MAX_CONCURRENT = 3;
const QUEUE_TIMEOUT_MS = 15000;

let activeRequests = 0;
const waitQueue: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

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
