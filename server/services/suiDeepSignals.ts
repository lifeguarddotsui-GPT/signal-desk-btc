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
  signals: TradeSignal[];
}

const PRODUCTS = { SUI: "SUI-USD", DEEP: "DEEP-USD" } as const;
const GRANULARITY: Record<string, number> = { "15m": 900, "1h": 3600, "1d": 86400 };
const cache = new Map<string, { expires: number; value: AssetSignalSet }>();

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
  score: number, frames: TradeSignal["timeframe"], fundingContext: string,
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
  };
}

async function computeAsset(asset: "SUI" | "DEEP"): Promise<AssetSignalSet> {
  const cached = cache.get(asset);
  if (cached && cached.expires > Date.now()) return cached.value;
  const product = PRODUCTS[asset];
  const [m15, h1, day] = await Promise.all([
    fetchCandles(product, "15m"), fetchCandles(product, "1h"),
    fetchCandles(product, "1d", 3),
  ]);
  const h4 = aggregateFourHour(h1);
  const price = m15.at(-1)!.close;
  const frames = { fourHour: structure(h4), oneHour: structure(h1), fifteenMinute: structure(m15) };
  const frameScore = (label: string) => label.startsWith("Bullish") ? 1 : -1;
  const momentumScore = (rsi(m15.map(c => c.close)) - 50) * 0.45;
  const score = frameScore(frames.fourHour) * 18 + frameScore(frames.oneHour) * 13
    + frameScore(frames.fifteenMinute) * 7 + momentumScore;
  const volatility = Math.max(atr(h1), price * 0.006);
  const fundingContext = "Funding unavailable";
  const signals = (["PRIMARY LONG", "SECONDARY LONG", "PRIMARY SHORT", "SECONDARY SHORT"] as SignalType[])
    .map(type => makeSignal(asset, type, price, volatility, score, frames, fundingContext));
  const result: AssetSignalSet = {
    asset, name: asset === "SUI" ? "Sui" : "DeepBook",
    price, change24h: ((price - day.at(-2)!.close) / day.at(-2)!.close) * 100,
    marketDirection: frames.fourHour, convergence: Math.round(Math.min(94, Math.max(6, 50 + score))),
    convergenceDirection: score > 25 ? "STRONG LONG" : score > 8 ? "LONG" : score < -25 ? "STRONG SHORT" : score < -8 ? "SHORT" : "NEUTRAL",
    fundingContext, updatedAt: new Date().toISOString(), dataHealth: "DEGRADED", signals,
  };
  cache.set(asset, { expires: Date.now() + 30_000, value: result });
  return result;
}

export async function getSuiDeepSignals() {
  const assets = await Promise.all([computeAsset("SUI"), computeAsset("DEEP")]);
  const actionable = assets.flatMap(a => a.signals).filter(s => s.probability !== null);
  const bestOpportunity = actionable.sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))[0] ?? null;
  return { assets, bestOpportunity, updatedAt: new Date().toISOString(), modelStatus: "PROVISIONAL" };
}
