type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type SignalType = "PRIMARY LONG" | "SECONDARY LONG" | "PRIMARY SHORT" | "SECONDARY SHORT";
export type SignalStatus = "FORMING" | "WAITING" | "APPROACHING" | "ACTIVE" | "NO VALID SETUP";

export interface TradeSignal {
  id: string;
  asset: "SUI" | "DEEP";
  type: SignalType;
  direction: "LONG" | "SHORT";
  entryLow: number;
  entryHigh: number;
  preferredEntry: number;
  currentPrice: number;
  target1: number;
  target2: number;
  invalidation: number;
  probability: number | null;
  status: SignalStatus;
  rrToT1: number;
  convergence: number;
  convergenceDirection: "STRONG LONG" | "LONG" | "NEUTRAL" | "SHORT" | "STRONG SHORT";
  marketDirection: string;
  fundingContext: string;
  timeframe: { fourHour: string; oneHour: string; fifteenMinute: string };
  provisional: true;
  smsEligible: false;
  smsReason: string;
}

export interface AssetSignalSet {
  asset: "SUI" | "DEEP";
  name: string;
  price: number;
  change24h: number;
  marketDirection: string;
  convergence: number;
  convergenceDirection: string;
  fundingContext: string;
  updatedAt: string;
  dataHealth: "HEALTHY" | "DEGRADED";
  dataHealthReason: string;
  sourceHealth: {
    cexPrice: "LIVE" | "FAILED";
    cexDerivatives: "LIVE" | "MISSING" | "FAILED";
    suiNativeSpot: "LIVE" | "MISSING" | "FAILED";
  };
  nativeMarket: {
    venue: "DeepBook";
    pair: string;
    lastPrice: number | null;
    bid: number | null;
    ask: number | null;
    spreadBps: number | null;
    volume24h: number | null;
    updatedAt: string | null;
  };
  derivatives: {
    venue: "OKX";
    instrument: string | null;
    fundingRate: number | null;
    openInterestUsd: number | null;
    updatedAt: string | null;
  };
  signals: TradeSignal[];
}

const PRODUCTS = { SUI: "SUI-USD", DEEP: "DEEP-USD" } as const;
const GRANULARITY: Record<string, number> = { "15m": 900, "1h": 3600, "1d": 86400 };
const cache = new Map<string, { expires: number; value: AssetSignalSet }>();

type DeepBookSummary = {
  trading_pairs: string;
  last_price: number;
  highest_bid: number;
  lowest_ask: number;
  quote_volume: number;
};

type OkxDerivatives = {
  instrument: string;
  fundingRate: number;
  openInterestUsd: number;
  updatedAt: string;
};

async function fetchCandles(product: string, interval: string, limit = 240): Promise<Candle[]> {
  const granularity = GRANULARITY[interval];
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${granularity}`;
  const response = await fetch(url, {
    headers: { "user-agent": "sui-deep-signals/1.0", accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Market source returned ${response.status}`);
  const rows = await response.json() as number[][];
  return rows.slice(0, Math.min(limit, 300)).reverse().map(row => ({
    openTime: Number(row[0]) * 1000, low: Number(row[1]), high: Number(row[2]),
    open: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
  }));
}

function aggregateFourHour(hourly: Candle[]): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const candle of hourly) {
    const bucket = Math.floor(candle.openTime / 14_400_000) * 14_400_000;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), candle]);
  }
  return Array.from(buckets.entries()).sort(([a], [b]) => a - b).map(([openTime, candles]: [number, Candle[]]) => ({
    openTime,
    open: candles[0].open,
    high: Math.max(...candles.map((c: Candle) => c.high)),
    low: Math.min(...candles.map((c: Candle) => c.low)),
    close: candles.at(-1)!.close,
    volume: candles.reduce((sum: number, c: Candle) => sum + c.volume, 0),
  }));
}

async function fetchDeepBookMarket(asset: "SUI" | "DEEP"): Promise<AssetSignalSet["nativeMarket"]> {
  const response = await fetch("https://deepbook-indexer.mainnet.mystenlabs.com/summary", {
    headers: { accept: "application/json", "user-agent": "sui-deep-signals/1.0" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`DeepBook returned ${response.status}`);
  const rows = await response.json() as DeepBookSummary[];
  const pair = `${asset}_USDC`;
  const market = rows.find(row => row.trading_pairs === pair);
  if (!market || !market.last_price) {
    return { venue: "DeepBook", pair, lastPrice: null, bid: null, ask: null, spreadBps: null, volume24h: null, updatedAt: null };
  }
  const spreadBps = market.highest_bid > 0 && market.lowest_ask > 0
    ? ((market.lowest_ask - market.highest_bid) / ((market.lowest_ask + market.highest_bid) / 2)) * 10_000
    : null;
  return {
    venue: "DeepBook", pair, lastPrice: market.last_price, bid: market.highest_bid,
    ask: market.lowest_ask, spreadBps, volume24h: market.quote_volume, updatedAt: new Date().toISOString(),
  };
}

async function fetchOkxDerivatives(asset: "SUI" | "DEEP"): Promise<OkxDerivatives | null> {
  const instrumentsResponse = await fetch("https://www.okx.com/api/v5/public/instruments?instType=SWAP", {
    headers: { accept: "application/json", "user-agent": "sui-deep-signals/1.0" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!instrumentsResponse.ok) throw new Error(`OKX instruments returned ${instrumentsResponse.status}`);
  const instrumentsPayload = await instrumentsResponse.json() as { code: string; data: Array<{ instId: string; state: string }> };
  const instrument = instrumentsPayload.data.find(item =>
    item.state === "live" && item.instId.startsWith(`${asset}-`) && item.instId.endsWith("-SWAP") && item.instId.includes("USDT"));
  if (!instrument) return null;
  const [fundingResponse, oiResponse] = await Promise.all([
    fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${instrument.instId}`, {
      headers: { accept: "application/json", "user-agent": "sui-deep-signals/1.0" },
      signal: AbortSignal.timeout(8_000),
    }),
    fetch(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instrument.instId}`, {
      headers: { accept: "application/json", "user-agent": "sui-deep-signals/1.0" },
      signal: AbortSignal.timeout(8_000),
    }),
  ]);
  if (!fundingResponse.ok || !oiResponse.ok) throw new Error("OKX derivatives snapshot failed");
  const funding = await fundingResponse.json() as { data: Array<{ fundingRate: string; ts: string }> };
  const oi = await oiResponse.json() as { data: Array<{ oiUsd: string; ts: string }> };
  if (!funding.data[0] || !oi.data[0]) return null;
  return {
    instrument: instrument.instId,
    fundingRate: Number(funding.data[0].fundingRate),
    openInterestUsd: Number(oi.data[0].oiUsd),
    updatedAt: new Date(Math.max(Number(funding.data[0].ts), Number(oi.data[0].ts))).toISOString(),
  };
}

function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  return values.reduce((value, next, index) => index === 0 ? next : next * k + value * (1 - k), values[0]);
}

function atr(candles: Candle[], period = 14) {
  const recent = candles.slice(-(period + 1));
  const ranges = recent.slice(1).map((c, i) =>
    Math.max(c.high - c.low, Math.abs(c.high - recent[i].close), Math.abs(c.low - recent[i].close)));
  return ranges.reduce((a, b) => a + b, 0) / Math.max(1, ranges.length);
}

function rsi(values: number[], period = 14) {
  const changes = values.slice(-(period + 1)).slice(1).map((v, i) => v - values[values.length - period - 1 + i]);
  const gains = changes.reduce((sum, v) => sum + Math.max(0, v), 0) / period;
  const losses = changes.reduce((sum, v) => sum + Math.max(0, -v), 0) / period;
  return losses === 0 ? 70 : 100 - 100 / (1 + gains / losses);
}

function structure(candles: Candle[]) {
  const closes = candles.map(c => c.close);
  const last = closes.at(-1)!;
  const fast = ema(closes.slice(-80), 20);
  const slow = ema(closes.slice(-140), 50);
  if (last > fast && fast > slow) return "Bullish";
  if (last < fast && fast < slow) return "Bearish";
  return last >= slow ? "Bullish pullback" : "Bearish rebound";
}

function makeSignal(
  asset: "SUI" | "DEEP", type: SignalType, price: number, volatility: number,
  score: number, frames: TradeSignal["timeframe"], fundingContext: string, dataHealthy: boolean,
): TradeSignal {
  const long = type.includes("LONG");
  const secondary = type.includes("SECONDARY");
  const distance = volatility * (secondary ? 1.8 : 0.75);
  const width = Math.max(volatility * 0.35, price * 0.002);
  const preferred = long ? price - distance : price + distance;
  const entryLow = preferred - width;
  const entryHigh = preferred + width;
  const risk = Math.max(volatility * 1.15, price * 0.008);
  const invalidation = long ? entryLow - risk : entryHigh + risk;
  const target1 = long ? entryHigh + risk * 1.7 : entryLow - risk * 1.7;
  const target2 = long ? entryHigh + risk * 2.8 : entryLow - risk * 2.8;
  const proximity = Math.abs(price - preferred) / Math.max(volatility, price * 0.005);
  const status: SignalStatus = price >= entryLow && price <= entryHigh
    ? "ACTIVE" : proximity < 0.65 ? "APPROACHING" : secondary && proximity > 2.8 ? "FORMING" : "WAITING";
  const aligned = long ? score > 12 : score < -12;
  const probability = aligned ? Math.round(Math.min(78, 61 + Math.abs(score) * 0.16)) : null;
  const convergence = Math.round(Math.min(94, Math.max(6, 50 + score)));
  const convergenceDirection = convergence >= 75 ? "STRONG LONG" : convergence >= 58 ? "LONG"
    : convergence <= 25 ? "STRONG SHORT" : convergence <= 42 ? "SHORT" : "NEUTRAL";
  return {
    id: `${asset.toLowerCase()}-${type.toLowerCase().replaceAll(" ", "-")}`, asset, type,
    direction: long ? "LONG" : "SHORT", entryLow, entryHigh, preferredEntry: preferred,
    currentPrice: price, target1, target2, invalidation, probability,
    status: probability === null ? "NO VALID SETUP" : status,
    rrToT1: 1.7, convergence, convergenceDirection,
    marketDirection: frames.fourHour, fundingContext, timeframe: frames, provisional: true,
    smsEligible: false,
    smsReason: !dataHealthy ? "DATA COVERAGE BELOW MINIMUM"
      : probability === null ? "NO VALID SETUP"
      : status !== "APPROACHING" && status !== "ACTIVE" ? "NOT CLOSE ENOUGH TO ENTRY"
      : "SMS PIPELINE NOT CONFIGURED",
  };
}

async function computeAsset(asset: "SUI" | "DEEP"): Promise<AssetSignalSet> {
  const cached = cache.get(asset);
  if (cached && cached.expires > Date.now()) return cached.value;
  const product = PRODUCTS[asset];
  const [m15, h1, day, nativeResult, derivativesResult] = await Promise.all([
    fetchCandles(product, "15m"), fetchCandles(product, "1h"),
    fetchCandles(product, "1d", 3),
    fetchDeepBookMarket(asset).then(value => ({ value, error: null })).catch(error => ({ value: null, error })),
    fetchOkxDerivatives(asset).then(value => ({ value, error: null })).catch(error => ({ value: null, error })),
  ]);
  const h4 = aggregateFourHour(h1);
  const price = m15.at(-1)!.close;
  const frames = { fourHour: structure(h4), oneHour: structure(h1), fifteenMinute: structure(m15) };
  const frameScore = (label: string) => label.startsWith("Bullish") ? 1 : -1;
  const momentumScore = (rsi(m15.map(c => c.close)) - 50) * 0.45;
  const score = frameScore(frames.fourHour) * 18 + frameScore(frames.oneHour) * 13
    + frameScore(frames.fifteenMinute) * 7 + momentumScore;
  const volatility = Math.max(atr(h1), price * 0.006);
  const nativeMarket = nativeResult.value ?? {
    venue: "DeepBook" as const, pair: `${asset}_USDC`, lastPrice: null, bid: null,
    ask: null, spreadBps: null, volume24h: null, updatedAt: null,
  };
  const derivatives = derivativesResult.value
    ? { venue: "OKX" as const, ...derivativesResult.value }
    : { venue: "OKX" as const, instrument: null, fundingRate: null, openInterestUsd: null, updatedAt: null };
  const nativeLive = nativeMarket.lastPrice !== null && nativeMarket.updatedAt !== null;
  const derivativesLive = derivatives.fundingRate !== null && derivatives.openInterestUsd !== null;
  const dataHealthy = nativeLive && derivativesLive;
  const fundingContext = derivatives.fundingRate === null ? "Funding missing"
    : Math.abs(derivatives.fundingRate) < 0.00015 ? "Funding neutral"
    : derivatives.fundingRate > 0 ? "Longs paying" : "Shorts paying";
  const signals = (["PRIMARY LONG", "SECONDARY LONG", "PRIMARY SHORT", "SECONDARY SHORT"] as SignalType[])
    .map(type => makeSignal(asset, type, price, volatility, score, frames, fundingContext, dataHealthy));
  const result: AssetSignalSet = {
    asset, name: asset === "SUI" ? "Sui" : "DeepBook",
    price, change24h: ((price - day.at(-2)!.close) / day.at(-2)!.close) * 100,
    marketDirection: frames.fourHour, convergence: Math.round(Math.min(94, Math.max(6, 50 + score))),
    convergenceDirection: score > 25 ? "STRONG LONG" : score > 8 ? "LONG" : score < -25 ? "STRONG SHORT" : score < -8 ? "SHORT" : "NEUTRAL",
    fundingContext, updatedAt: new Date().toISOString(), dataHealth: dataHealthy ? "HEALTHY" : "DEGRADED",
    dataHealthReason: dataHealthy ? "CEX PRICE, CEX DERIVATIVES, AND DEEPBOOK SPOT LIVE"
      : !nativeLive ? "SUI-NATIVE SPOT MISSING" : "DERIVATIVES COVERAGE MISSING",
    sourceHealth: {
      cexPrice: "LIVE",
      cexDerivatives: derivativesLive ? "LIVE" : derivativesResult.error ? "FAILED" : "MISSING",
      suiNativeSpot: nativeLive ? "LIVE" : nativeResult.error ? "FAILED" : "MISSING",
    },
    nativeMarket, derivatives, signals,
  };
  cache.set(asset, { expires: Date.now() + 30_000, value: result });
  return result;
}

export async function getSuiDeepSignals() {
  const assets = await Promise.all([computeAsset("SUI"), computeAsset("DEEP")]);
  const actionable = assets.filter(a => a.dataHealth === "HEALTHY")
    .flatMap(a => a.signals).filter(s => s.probability !== null);
  const bestOpportunity = actionable.sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))[0] ?? null;
  return { assets, bestOpportunity, updatedAt: new Date().toISOString(), modelStatus: "PROVISIONAL" };
}
