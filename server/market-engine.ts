import { getLastPrice } from "./price-service";

export type Candle = {
  ts: number;
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const CANDLE_15M_MS = 15 * 60 * 1000;
const CANDLE_5M_MS = 5 * 60 * 1000;
const CANDLE_1H_MS = 60 * 60 * 1000;
const CANDLE_4H_MS = 4 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

let candleHistory15m: Candle[] = [];
let currentCandle15m: Candle | null = null;

let candleHistory5m: Candle[] = [];
let candleHistory1h: Candle[] = [];
let candleHistory4h: Candle[] = [];
let currentCandle5m: Candle | null = null;
let currentCandle1h: Candle | null = null;
let currentCandle4h: Candle | null = null;

let priceHistory: Array<{ time: string; price: number; volume: number }> = [];
let priceHistory24h: Array<{ timestamp: number; price: number }> = [];

let verified24hHigh: number | null = null;
let verified24hLow: number | null = null;
let verified24hVerifiedAt: number | null = null;
let verified24hVolumeUSD: number | null = null;
let verified24hOpen: number | null = null;

let tickCount = 0;
let initialized = false;

function getBucket(ts: number, intervalMs: number): number {
  return Math.floor(ts / intervalMs) * intervalMs;
}

function makeCandle(bucket: number, price: number, volume: number): Candle {
  return {
    ts: bucket,
    time: new Date(bucket).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    timestamp: bucket,
    open: price, high: price, low: price, close: price, volume,
  };
}

function updateCandleInPlace(
  history: Candle[],
  current: Candle | null,
  intervalMs: number,
  maxBars: number,
  price: number,
  volume: number,
): { history: Candle[]; current: Candle } {
  const bucket = getBucket(Date.now(), intervalMs);
  if (!current || current.timestamp !== bucket) {
    if (current) {
      history = [...history, { ...current }];
      if (history.length > maxBars) history = history.slice(-maxBars);
    }
    current = makeCandle(bucket, price, volume);
  } else {
    current = {
      ...current,
      high: Math.max(current.high, price),
      low: Math.min(current.low, price),
      close: price,
      volume: current.volume + volume,
    };
  }
  return { history, current };
}

async function fetchCoinGeckoVolume(): Promise<void> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd&include_24hr_vol=true",
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return;
    const data = await res.json();
    const volUSD = data?.sui?.usd_24h_vol;
    if (typeof volUSD === "number" && volUSD > 0) {
      verified24hVolumeUSD = volUSD;
    }
  } catch {}
}

async function fetchPyth24hOHLC(): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 24 * 60 * 60;
    const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.SUI%2FUSD&resolution=60&from=${from}&to=${now}&currency_code=USD`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.h || !Array.isArray(data.h) || data.h.length === 0) return;
    const validHighs = (data.h as number[]).filter((v: number) => v > 0);
    const validLows = (data.l as number[]).filter((v: number) => v > 0);
    if (!validHighs.length || !validLows.length) return;
    verified24hHigh = Math.max(...validHighs);
    verified24hLow = Math.min(...validLows);
    verified24hVerifiedAt = Date.now();
    const opens = (data.o as number[] | undefined)?.filter((v: number) => v > 0) ?? [];
    verified24hOpen = opens.length ? opens[0] : null;
    console.log(`[MarketEngine] Pyth 24h: high=$${verified24hHigh.toFixed(4)} low=$${verified24hLow.toFixed(4)}`);
  } catch (e: any) {
    console.log(`[MarketEngine] Pyth 24h fetch failed: ${e.message}`);
  }
  fetchCoinGeckoVolume().catch(() => {});
}

function seedCandleHistory(seedPrice: number) {
  const now = Date.now();
  const volatility = seedPrice * 0.003;
  let p = seedPrice * (0.97 + Math.random() * 0.02);

  for (let i = 30; i >= 1; i--) {
    const bucket = getBucket(now - i * CANDLE_15M_MS, CANDLE_15M_MS);
    const dir = Math.random() - 0.48;
    const close = parseFloat((p + dir * volatility * 3).toFixed(6));
    const high = parseFloat((Math.max(p, close) + Math.random() * volatility).toFixed(6));
    const low = parseFloat((Math.min(p, close) - Math.random() * volatility).toFixed(6));
    const vol = Math.floor(400000 + Math.random() * 800000);
    candleHistory15m.push({
      ts: bucket, timestamp: bucket,
      time: new Date(bucket).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      open: parseFloat(p.toFixed(6)), high, low, close, volume: vol,
    });
    p = close;
  }

  const seedTF = (intervalMs: number, count: number, maxBars: number): Candle[] => {
    const hist: Candle[] = [];
    let q = seedPrice * (0.97 + Math.random() * 0.02);
    const candleVol = seedPrice * (0.002 + Math.random() * 0.004);
    for (let i = count; i >= 1; i--) {
      const bucket = getBucket(now - i * intervalMs, intervalMs);
      const d = Math.random() - 0.48;
      const o = q;
      const c = parseFloat((o + d * candleVol * 3).toFixed(6));
      const h = parseFloat((Math.max(o, c) + Math.random() * candleVol).toFixed(6));
      const l = parseFloat((Math.min(o, c) - Math.random() * candleVol).toFixed(6));
      const v = Math.floor(500000 * (intervalMs / CANDLE_15M_MS) * (0.5 + Math.random()));
      hist.push({ ts: bucket, timestamp: bucket, time: new Date(bucket).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), open: parseFloat(o.toFixed(6)), high: h, low: l, close: c, volume: v });
      q = c;
    }
    return hist.slice(-maxBars);
  };

  candleHistory5m = seedTF(CANDLE_5M_MS, 200, 200);
  candleHistory1h = seedTF(CANDLE_1H_MS, 100, 100);
  candleHistory4h = seedTF(CANDLE_4H_MS, 50, 50);
}

async function initialize() {
  if (initialized) return;
  initialized = true;

  let seedPrice: number | null = null;
  const lastTick = getLastPrice();
  if (lastTick) seedPrice = lastTick.price ?? lastTick.blended ?? null;

  if (!seedPrice) {
    try {
      const res = await fetch(
        "https://hermes.pyth.network/v2/updates/price/latest?ids[]=0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744&parsed=true",
        { signal: AbortSignal.timeout(8000) },
      );
      if (res.ok) {
        const data = await res.json();
        const parsed = data?.parsed?.[0]?.price;
        if (parsed) seedPrice = Number(parsed.price) * Math.pow(10, Number(parsed.expo));
      }
    } catch {}
  }

  seedPrice = seedPrice && seedPrice > 0 ? seedPrice : 1.0;
  seedCandleHistory(seedPrice);
  fetchPyth24hOHLC().catch(() => {});
  setInterval(() => fetchPyth24hOHLC().catch(() => {}), 30 * 60 * 1000);
  console.log(`[MarketEngine] Initialized with seed price $${seedPrice.toFixed(4)} | 15m candles: ${candleHistory15m.length}`);
}

export async function tickMarket() {
  if (!initialized) {
    await initialize();
  }

  tickCount++;
  const lastPrice = getLastPrice();
  const currentPrice = lastPrice?.price ?? lastPrice?.blended ?? null;
  if (!currentPrice) return;

  const vol = Math.floor(50000 + Math.random() * 120000);

  const now = Date.now();
  const time = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  priceHistory.push({ time, price: parseFloat(currentPrice.toFixed(6)), volume: vol });
  if (priceHistory.length > 60) priceHistory = priceHistory.slice(-60);

  priceHistory24h.push({ timestamp: now, price: currentPrice });
  const cutoff = now - TWENTY_FOUR_HOURS_MS;
  priceHistory24h = priceHistory24h.filter(p => p.timestamp >= cutoff);

  const r15m = updateCandleInPlace(candleHistory15m, currentCandle15m, CANDLE_15M_MS, 96, currentPrice, vol);
  candleHistory15m = r15m.history;
  currentCandle15m = r15m.current;

  const r5m = updateCandleInPlace(candleHistory5m, currentCandle5m, CANDLE_5M_MS, 200, currentPrice, vol);
  candleHistory5m = r5m.history;
  currentCandle5m = r5m.current;

  const r1h = updateCandleInPlace(candleHistory1h, currentCandle1h, CANDLE_1H_MS, 100, currentPrice, vol);
  candleHistory1h = r1h.history;
  currentCandle1h = r1h.current;

  const r4h = updateCandleInPlace(candleHistory4h, currentCandle4h, CANDLE_4H_MS, 50, currentPrice, vol);
  candleHistory4h = r4h.history;
  currentCandle4h = r4h.current;
}

export function getCandleHistory(): Candle[] {
  const result = [...candleHistory15m];
  if (currentCandle15m) result.push({ ...currentCandle15m });
  return result;
}

export function getMarketState() {
  const prices = priceHistory.map(p => p.price);
  const currentPrice = prices.length > 0 ? prices[prices.length - 1] : 0;

  const prices24h = priceHistory24h.map(p => p.price);
  const localHigh24h = prices24h.length > 0 ? Math.max(...prices24h) : currentPrice;
  const localLow24h = prices24h.length > 0 ? Math.min(...prices24h) : currentPrice;
  const firstPrice24h = verified24hOpen ?? (prices24h.length > 0 ? prices24h[0] : currentPrice);
  const change24h = firstPrice24h > 0 ? ((currentPrice - firstPrice24h) / firstPrice24h) * 100 : 0;

  const lastPriceTick = getLastPrice();

  return {
    price: currentPrice,
    pythPrice: lastPriceTick?.pyth?.price ?? null,
    high24h: verified24hHigh ?? localHigh24h,
    low24h: verified24hLow ?? localLow24h,
    volume24h: verified24hVolumeUSD ?? 0,
    change24h: parseFloat(change24h.toFixed(2)),
    priceSource: lastPriceTick?.pyth ? "pyth" : "simulated",
    candles15m: candleHistory15m.length + (currentCandle15m ? 1 : 0),
  };
}
