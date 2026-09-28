import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import {
  expiryMarketMoveCalls, getConfig, getDeployment, predict, rawToPrice, toGeneratedConfig,
  type ActiveMarket,
} from "@mysten/deepbook-v3/predict";

const NODE = "https://fullnode.mainnet.sui.io:443";
const config = getConfig("mainnet");
if (getDeployment("mainnet").deployment !== "deepbook-predict-mainnet") {
  throw new Error("Unexpected DeepBook Predict deployment");
}
const client = new SuiGrpcClient({ network: "mainnet", baseUrl: NODE }).$extend(predict({ network: "mainnet" }));
// Shared, read-only SDK context for public devInspect adapters. This exposes no
// signer, owner account, or transaction-submission capability.
export const readContext = { client, config: toGeneratedConfig(config), predictConfig: config };
const identity = /^0x[0-9a-f]{64}$/i;

export type Market = {
  id: string; expiryMs: number; startMs: number; referencePrice: number | null;
  mintPaused: boolean; cadenceEvidence: string;
};

// The SDK active-market response has no cadence field. A neighboring 60-second
// expiry is evidence for the rolling 1m series, not a universal cadence proof.
export function oneMinuteMarket(markets: ActiveMarket[], now: number): Market | null {
  const sorted = [...markets].sort((a, b) => Number(a.expiryMs - b.expiryMs));
  const oneMinute = sorted.filter((market) =>
    sorted.filter((other) => other.expiryMs === market.expiryMs).length === 1 &&
    sorted.filter((next) => Number(next.expiryMs - market.expiryMs) === 60_000).length === 1);
  const active = oneMinute.find((m) => Number(m.expiryMs) > now && Number(m.expiryMs) - now <= 60_000);
  return active ? {
    id: active.id, expiryMs: Number(active.expiryMs), startMs: Number(active.expiryMs) - 60_000,
    referencePrice: active.referencePrice, mintPaused: active.mintPaused,
    cadenceEvidence: "Consecutive on-chain active-market expiries separated by 60 seconds; SDK does not expose cadence",
  } : null;
}

export async function discover(): Promise<{ market: Market | null; all: ActiveMarket[] }> {
  const all = await client.predict.read.markets();
  if (!Array.isArray(all) || all.some(m =>
    !identity.test(m.id) || !Number.isSafeInteger(Number(m.expiryMs)) ||
    (m.referencePrice !== null && (!Number.isFinite(m.referencePrice) || m.referencePrice <= 0)) ||
    typeof m.mintPaused !== "boolean")) throw new Error("Malformed SDK market response");
  return { market: oneMinuteMarket(all, Date.now()), all };
}

export async function indicative(market: Market) {
  if (!market.referencePrice || market.expiryMs <= Date.now() || market.mintPaused) return null;
  const price = await client.predict.read.price({
    underlying: "BTC", expiryMs: BigInt(market.expiryMs), strike: "reference",
  });
  if (!Number.isFinite(price.up) || !Number.isFinite(price.down) || price.up < 0 || price.up > 1 ||
      price.down < 0 || price.down > 1 || Math.abs(price.up + price.down - 1) > .002) {
    throw new Error("Invalid on-chain price read");
  }
  // read.price provides no oracle/provider observation timestamp. asOf is
  // when this application completed the SDK read, not the pricer source age.
  return { up: price.up, down: price.down, asOf: new Date().toISOString(),
    source: "DeepBook Predict read.price (app read completion; provider source time unavailable; indicative, not executable)" };
}

export async function comparisonBtc() {
  const response = await fetch("https://api.exchange.coinbase.com/products/BTC-USD/ticker", {
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`Coinbase comparison feed HTTP ${response.status}`);
  const data = await response.json() as { price?: unknown; time?: unknown };
  const price = Number(data.price);
  const asOf = typeof data.time === "string" ? new Date(data.time).toISOString() : null;
  if (!Number.isFinite(price) || price <= 0 || !asOf || Date.now() - Date.parse(asOf) > 20_000) {
    throw new Error("Coinbase comparison tick missing or stale");
  }
  return { price, asOf, source: "Coinbase Exchange BTC-USD (comparison only; not settlement oracle)" };
}

// Official generated read-only Move call. A non-success response is not a
// settlement; never derive an outcome from an indicative quote or comparison.
export async function readSettlement(id: string): Promise<number | null> {
  if (!identity.test(id)) throw new Error("Invalid market ID");
  const tx = new Transaction();
  tx.add(expiryMarketMoveCalls.settlementPrice({
    config: { predictPackageId: config.packages.predict },
    arguments: { market: id },
  }));
  tx.setSender("0x0");
  const result = await client.core.simulateTransaction({
    transaction: tx, checksEnabled: false, include: { commandResults: true },
  });
  if (result.$kind === "FailedTransaction") {
    const message = JSON.stringify(result.FailedTransaction?.status?.error ?? "");
    if (/option|EMarketNotSettled|settlement_price/i.test(message)) return null;
    throw new Error(`Settlement read failed: ${message.slice(0, 200)}`);
  }
  const bytes = result.commandResults?.[0]?.returnValues?.[0]?.bcs;
  if (!bytes || bytes.length !== 8) throw new Error("Settlement read missing u64 return");
  const raw = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
  const price = rawToPrice(raw);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid settlement price");
  return price;
}

export const sources = {
  sdk: "https://docs.sui.io/onchain-finance/deepbook/deepbook-predict-sdk/markets",
  chain: NODE,
  comparison: "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
};