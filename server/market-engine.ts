import { storage } from "./storage";
import { priceBus, getLastPrice, startPriceLoop, type PriceTick } from "./price-service";
import { ema, emaSeries, rsi, computeSignal, connorsRsi, dema, tema, rsiSeries as rsiSeriesFn, macd, type SignalResult } from "../shared/indicators";
import { executeSignalForAgent, processPendingUnfilledOrders, processPendingPositionResolutions, processPendingDigestReconciliations, verifyAndRecoverStuckPositions, registerTopoffResume, checkGasForAgent, getAgentIdleMinutes } from "./dex/execution-engine";
import { createBundle, type Action, type RiskParams } from "../shared/bundle";
import { VENUE_MAP } from "../shared/sui-constants";
import { startPositionMonitor } from "./position-monitor";
import { generateSignal, detectLiquidityTrapSignal, scoreMicroScalpSetup, type MarketCandle, type TradeSignal, type SignalMode, type AntiIdleCtx, type LiquidityTrapResult, type MicroScalpResult } from "./signal-engine";
import { getSentimentContext, updateMarkPrice } from "./sentiment-flow-engine";
import { getBtcOverlayContext } from "./btc-overlay-engine";
import { getSuiOverlayContext } from "./sui-overlay-engine";

let lastSignalResult: SignalResult | null = null;

export function getLastSignalResult(): SignalResult | null {
  return lastSignalResult;
}

let priceHistory: Array<{ time: string; price: number; volume: number }> = [];
let priceHistory24h: Array<{ timestamp: number; price: number }> = [];
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
let indicatorHistory: Array<{
  time: string;
  rsi: number;
  connorsRsi: number;
  ema7: number;
  ema30: number;
  ema200: number;
  ema9: number;
  ema21: number;
  dema20: number;
  tema20: number;
  macdDif: number;
  macdDea: number;
  macdHist: number;
}> = [];
let closes: number[] = [];
let volumes: number[] = [];

export type Candle = {
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

let candleHistory: Candle[] = [];
let currentCandle: Candle | null = null;
const CANDLE_INTERVAL_MS = 15 * 60 * 1000;

const CANDLE_5M_MS = 5 * 60 * 1000;
const CANDLE_1H_MS = 60 * 60 * 1000;
const CANDLE_4H_MS = 4 * 60 * 60 * 1000;

let candleHistory5m: Candle[] = [];
let candleHistory1h: Candle[] = [];
let candleHistory4h: Candle[] = [];
let currentCandle5m: Candle | null = null;
let currentCandle1h: Candle | null = null;
let currentCandle4h: Candle | null = null;

let lastTritonSignal: TradeSignal | null = null;
let tickCount = 0;
let lastTradabilityScore = 0;

interface AntiIdleScanState {
  trapScan: LiquidityTrapResult & { scannedAt: number };
  microScan: MicroScalpResult & { scannedAt: number };
}

let lastAntiIdleScan: AntiIdleScanState | null = null;

export function getLastTritonSignal(): TradeSignal | null {
  return lastTritonSignal;
}

export function getAntiIdleScanState(): AntiIdleScanState | null {
  return lastAntiIdleScan;
}

/**
 * Tradability score (0–100): reflects market data quality and how amenable current
 * conditions are to automated entry. Higher = cleaner data, healthier regime.
 * Components:
 *   - Candle depth (15m history vs 96-bar target)
 *   - Multi-TF candle depth (5m + 1h + 4h)
 *   - Oracle freshness (Pyth price available vs simulated)
 *   - Regime quality (TREND > VOLATILE > RANGE > CHOP_SCALP)
 */
function computeTradabilityScore(): number {
  let score = 0;

  // --- Candle depth (30 pts) ---
  const targetBars15m = 96; // 24h at 15m
  const bars15m = candleHistory.length + (currentCandle ? 1 : 0);
  const depthRatio = Math.min(1, bars15m / targetBars15m);
  score += Math.round(depthRatio * 30);

  // --- Multi-TF depth (20 pts) ---
  const bars5m = candleHistory5m.length + (currentCandle5m ? 1 : 0);
  const bars1h = candleHistory1h.length + (currentCandle1h ? 1 : 0);
  const bars4h = candleHistory4h.length + (currentCandle4h ? 1 : 0);
  const tfScore =
    Math.min(1, bars5m / 200) * 8 +
    Math.min(1, bars1h / 60) * 7 +
    Math.min(1, bars4h / 24) * 5;
  score += Math.round(tfScore);

  // --- Oracle freshness (20 pts) ---
  const lastPriceTick = getLastPrice();
  const hasPyth = !!lastPriceTick?.pyth;
  score += hasPyth ? 20 : 5; // simulated still gives 5 (live, just not oracle-confirmed)

  // --- Verified 24h data (10 pts) ---
  if (verified24hVerifiedAt !== null) {
    const staleness = Date.now() - verified24hVerifiedAt;
    if (staleness < 2 * 60 * 60 * 1000) score += 10;
    else if (staleness < 6 * 60 * 60 * 1000) score += 5;
  }

  // --- Regime quality (20 pts) ---
  const regime = lastTritonSignal?.regime ?? "RANGE";
  const regimeBonus: Record<string, number> = {
    TREND: 20,
    VOLATILE: 14,
    RANGE: 10,
    CHOP_SCALP: 8,
  };
  score += regimeBonus[regime] ?? 10;

  return Math.min(100, Math.max(0, score));
}

export function getTradabilityScore(): number {
  return lastTradabilityScore;
}

let verified24hHigh: number | null = null;
let verified24hLow: number | null = null;
let verified24hVerifiedAt: number | null = null;
let verified24hVolume: number | null = null;
let verified24hVolumeUSD: number | null = null;
let verified24hOpen: number | null = null;

export function getVerified24hData() {
  return {
    high: verified24hHigh,
    low: verified24hLow,
    volume: verified24hVolume,
    verifiedAt: verified24hVerifiedAt,
    isVerified: verified24hVerifiedAt !== null,
  };
}

async function fetchCoinGeckoVolume(): Promise<void> {
  try {
    const url = "https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd&include_24hr_vol=true";
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const data = await res.json();
    const volUSD = data?.sui?.usd_24h_vol;
    if (typeof volUSD === "number" && volUSD > 0) {
      verified24hVolumeUSD = volUSD;
      console.log(`[MarketEngine] CoinGecko 24h USD volume: $${(volUSD / 1e6).toFixed(1)}M`);
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
    if (!data.h || !data.l || !Array.isArray(data.h) || data.h.length === 0) return;
    const validHighs = (data.h as number[]).filter((v: number) => v > 0);
    const validLows = (data.l as number[]).filter((v: number) => v > 0);
    const validVols = (data.v as number[] | undefined)?.filter((v: number) => v > 0) ?? [];
    if (validHighs.length === 0 || validLows.length === 0) return;
    verified24hHigh = Math.max(...validHighs);
    verified24hLow = Math.min(...validLows);
    const volSum = validVols.length > 0 ? validVols.reduce((a, b) => a + b, 0) : 0;
    verified24hVolume = volSum > 1000 ? volSum : null;
    const opens = (data.o as number[] | undefined)?.filter((v: number) => v > 0) ?? [];
    verified24hOpen = opens.length > 0 ? opens[0] : null;
    verified24hVerifiedAt = Date.now();
    console.log(`[MarketEngine] Pyth 24h verified: high=$${verified24hHigh.toFixed(4)} low=$${verified24hLow.toFixed(4)} open=$${verified24hOpen?.toFixed(4) ?? "n/a"} vol=${volSum > 0 ? volSum.toFixed(0) : "none"} from ${validHighs.length} hourly candles`);
  } catch (e: any) {
    console.log(`[MarketEngine] Pyth 24h fetch failed: ${e.message}`);
  }
  // Always refresh CoinGecko volume in parallel with Pyth OHLC
  fetchCoinGeckoVolume().catch(() => {});
}

function getCandleBucket(ts: number): number {
  return Math.floor(ts / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;
}

function getBucket(ts: number, intervalMs: number): number {
  return Math.floor(ts / intervalMs) * intervalMs;
}

function updateMultiTFCandle(price: number, volume: number) {
  const now = Date.now();

  const update = (
    history: Candle[],
    current: Candle | null,
    intervalMs: number,
    maxBars: number
  ): { history: Candle[]; current: Candle } => {
    const bucket = getBucket(now, intervalMs);
    if (!current || current.timestamp !== bucket) {
      if (current) {
        history.push({ ...current });
        if (history.length > maxBars) history = history.slice(-maxBars);
      }
      current = {
        time: new Date(bucket).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        timestamp: bucket,
        open: price, high: price, low: price, close: price, volume,
      };
    } else {
      current.high = Math.max(current.high, price);
      current.low = Math.min(current.low, price);
      current.close = price;
      current.volume += volume;
    }
    return { history, current };
  };

  const r5m = update(candleHistory5m, currentCandle5m, CANDLE_5M_MS, 200);
  candleHistory5m = r5m.history; currentCandle5m = r5m.current;

  const r1h = update(candleHistory1h, currentCandle1h, CANDLE_1H_MS, 100);
  candleHistory1h = r1h.history; currentCandle1h = r1h.current;

  const r4h = update(candleHistory4h, currentCandle4h, CANDLE_4H_MS, 50);
  candleHistory4h = r4h.history; currentCandle4h = r4h.current;
}

function candleToMarket(c: Candle): MarketCandle {
  return { t: c.timestamp, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume };
}

function getCandlesWithCurrent(history: Candle[], current: Candle | null): MarketCandle[] {
  const result = history.map(candleToMarket);
  if (current) result.push(candleToMarket(current));
  return result;
}

export function getMultiTFCandles() {
  return {
    tf5m: getCandlesWithCurrent(candleHistory5m, currentCandle5m),
    tf15m: getCandlesWithCurrent(candleHistory, currentCandle),
    tf1h: getCandlesWithCurrent(candleHistory1h, currentCandle1h),
    tf4h: getCandlesWithCurrent(candleHistory4h, currentCandle4h),
  };
}

function updateCandle(price: number, volume: number) {
  const now = Date.now();
  const bucket = getCandleBucket(now);

  if (!currentCandle || currentCandle.timestamp !== bucket) {
    if (currentCandle) {
      candleHistory.push({ ...currentCandle });
      if (candleHistory.length > 96) candleHistory = candleHistory.slice(-96);
    }
    currentCandle = {
      time: new Date(bucket).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      timestamp: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      volume,
    };
  } else {
    currentCandle.high = Math.max(currentCandle.high, price);
    currentCandle.low = Math.min(currentCandle.low, price);
    currentCandle.close = price;
    currentCandle.volume += volume;
  }
}

async function initializeHistory() {
  const lastPrice = getLastPrice();
  let seedPrice = lastPrice?.pyth?.price ?? lastPrice?.blended ?? null;

  if (!seedPrice) {
    try {
      const res = await fetch("https://hermes.pyth.network/v2/updates/price/latest?ids[]=0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744&parsed=true");
      if (res.ok) {
        const data = await res.json();
        const parsed = data?.parsed?.[0]?.price;
        if (parsed) {
          seedPrice = Number(parsed.price) * Math.pow(10, Number(parsed.expo));
        }
      }
    } catch {}
  }

  if (!seedPrice || seedPrice <= 0) {
    seedPrice = 0.97;
  }

  const now = Date.now();
  let p = seedPrice;
  const volatility = seedPrice * 0.002;

  for (let i = 59; i >= 0; i--) {
    const change = (Math.random() - 0.48) * volatility;
    p = Math.max(seedPrice * 0.90, Math.min(seedPrice * 1.10, p + change));
    closes.push(p);

    const time = new Date(now - i * 60000);
    const vol = Math.floor(50000 + Math.random() * 100000);
    volumes.push(vol);

    priceHistory.push({
      time: time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      price: parseFloat(p.toFixed(4)),
      volume: vol,
    });

    const e7 = ema(closes.slice(-100), 7);
    const e30 = ema(closes.slice(-200), 30);
    const e200 = ema(closes, 200);
    const e9 = ema(closes.slice(-100), 9);
    const e21 = ema(closes.slice(-200), 21);
    const r = rsi(closes, 14);
    const cRsi = connorsRsi(closes);
    const d20 = closes.length > 20 ? dema(closes.slice(-60), 20) : e9;
    const t20 = closes.length > 20 ? tema(closes.slice(-60), 20) : e9;
    const m = macd(closes);

    indicatorHistory.push({
      time: time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      rsi: parseFloat(r.toFixed(2)),
      connorsRsi: parseFloat(cRsi.toFixed(2)),
      ema7: parseFloat(e7.toFixed(4)),
      ema30: parseFloat(e30.toFixed(4)),
      ema200: parseFloat(e200.toFixed(4)),
      ema9: parseFloat(e9.toFixed(4)),
      ema21: parseFloat(e21.toFixed(4)),
      dema20: parseFloat(d20.toFixed(4)),
      tema20: parseFloat(t20.toFixed(4)),
      macdDif: parseFloat(m.dif.toFixed(6)),
      macdDea: parseFloat(m.dea.toFixed(6)),
      macdHist: parseFloat(m.macd.toFixed(6)),
    });
  }

  try {
    const since = new Date(Date.now() - TWENTY_FOUR_HOURS_MS);
    const historicalData = await storage.getMarketDataSince(since);
    if (historicalData.length > 0) {
      for (const md of historicalData) {
        const price = md.pythPrice ?? md.price;
        if (price && price > 0) {
          priceHistory24h.push({
            timestamp: new Date(md.createdAt).getTime(),
            price: parseFloat(price.toFixed(4)),
          });
        }
      }
      console.log(`[MarketEngine] Loaded ${priceHistory24h.length} historical prices for 24h high/low tracking`);
    }
  } catch (err: any) {
    console.log(`[MarketEngine] Failed to load historical 24h prices: ${err.message}`);
  }

  initializeCandleHistory(p);
}

function initializeCandleHistory(currentPrice: number) {
  const now = Date.now();
  const spread = currentPrice * 0.03;
  let p = currentPrice - spread + Math.random() * (spread * 0.3);

  for (let i = 24; i >= 1; i--) {
    const bucket = getCandleBucket(now - i * CANDLE_INTERVAL_MS);
    const open = p;
    const candleVolatility = currentPrice * (0.003 + Math.random() * 0.005);
    const direction = Math.random() - 0.48;
    const close = parseFloat((open + direction * candleVolatility * 3).toFixed(4));
    const high = parseFloat((Math.max(open, close) + Math.random() * candleVolatility * 2).toFixed(4));
    const low = parseFloat((Math.min(open, close) - Math.random() * candleVolatility * 2).toFixed(4));
    const vol = Math.floor(800000 + Math.random() * 1200000);

    candleHistory.push({
      time: new Date(bucket).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      timestamp: bucket,
      open: parseFloat(open.toFixed(4)),
      high,
      low,
      close,
      volume: vol,
    });

    p = close;
  }

  seedMultiTFCandles(currentPrice);
}

function seedMultiTFCandles(currentPrice: number) {
  const now = Date.now();
  const seed = (intervalMs: number, count: number, maxBars: number) => {
    const history: Candle[] = [];
    let p = currentPrice * (0.97 + Math.random() * 0.02);
    for (let i = count; i >= 1; i--) {
      const bucket = getBucket(now - i * intervalMs, intervalMs);
      const vol = Math.floor(500000 + Math.random() * 1000000) * (intervalMs / CANDLE_5M_MS);
      const candleVol = currentPrice * (0.002 + Math.random() * 0.004);
      const dir = Math.random() - 0.48;
      const o = p;
      const c = parseFloat((o + dir * candleVol * 3).toFixed(4));
      const h = parseFloat((Math.max(o, c) + Math.random() * candleVol * 2).toFixed(4));
      const l = parseFloat((Math.min(o, c) - Math.random() * candleVol * 2).toFixed(4));
      history.push({
        time: new Date(bucket).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        timestamp: bucket, open: parseFloat(o.toFixed(4)), high: h, low: l, close: c, volume: Math.floor(vol),
      });
      p = c;
    }
    return history.slice(-maxBars);
  };

  candleHistory5m = seed(CANDLE_5M_MS, 200, 200);
  candleHistory1h = seed(CANDLE_1H_MS, 100, 100);
  candleHistory4h = seed(CANDLE_4H_MS, 50, 50);
}

export async function tickMarket() {
  tickCount++;
  const lastPrice = getLastPrice();
  let currentPrice: number;
  let pythPrice: number | undefined;

  if (lastPrice) {
    currentPrice = lastPrice.blended;
    pythPrice = lastPrice.pyth?.price;
  } else {
    const prev = closes.length > 0 ? closes[closes.length - 1] : 3.85;
    const momentum = (Math.random() - 0.48) * 0.008;
    currentPrice = Math.max(2.50, Math.min(6.00, prev + momentum));
  }

  closes.push(currentPrice);
  if (closes.length > 500) closes = closes.slice(-500);

  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const vol = Math.floor(50000 + Math.random() * 120000);
  volumes.push(vol);
  if (volumes.length > 500) volumes = volumes.slice(-500);

  priceHistory.push({ time, price: parseFloat(currentPrice.toFixed(4)), volume: vol });
  if (priceHistory.length > 60) priceHistory = priceHistory.slice(-60);

  const now = Date.now();
  priceHistory24h.push({ timestamp: now, price: parseFloat(currentPrice.toFixed(4)) });
  const cutoff24h = now - TWENTY_FOUR_HOURS_MS;
  priceHistory24h = priceHistory24h.filter(p => p.timestamp >= cutoff24h);

  updateCandle(currentPrice, vol);
  updateMultiTFCandle(currentPrice, vol);
  updateMarkPrice(currentPrice);

  const signalResult = computeSignal(closes, volumes);
  lastSignalResult = signalResult;

  try {
    const multiTF = getMultiTFCandles();
    const sentimentCtx = getSentimentContext();
    const btcCtx = getBtcOverlayContext() ?? undefined;
    const suiCtx = getSuiOverlayContext() ?? undefined;
    const tritonSignal = generateSignal({ ...multiTF, markPrice: currentPrice }, "AUTO", sentimentCtx ?? undefined, btcCtx, suiCtx);
    lastTritonSignal = tritonSignal;
    lastTradabilityScore = computeTradabilityScore();

    // Run anti-idle engine scanners every tick to expose live state in the dashboard,
    // regardless of whether they produce an actual trade signal.
    try {
      const { tf5m, tf15m } = multiTF;
      const rsiVal = closes.length >= 14 ? (() => {
        // Use the EMA RSI from indicators if available (already computed in computeSignal)
        const rs = signalResult.indicators?.rsi;
        return typeof rs === "number" ? rs : 50;
      })() : 50;
      const histArrVal: number[] = candleHistory.slice(-30).map((c, i, arr) => {
        // Approximate MACD histogram from close prices
        if (i < 4) return 0;
        const fast = arr.slice(i - 4, i + 1).reduce((s, x) => s + x.close, 0) / 5;
        const slow = arr.slice(Math.max(0, i - 12), i + 1).reduce((s, x) => s + x.close, 0) / (Math.min(13, i + 1));
        return fast - slow;
      });

      const trapScan = detectLiquidityTrapSignal(tf5m, tf15m, rsiVal);
      const microScan = scoreMicroScalpSetup(tf5m, rsiVal, histArrVal);
      lastAntiIdleScan = {
        trapScan: { ...trapScan, scannedAt: Date.now() },
        microScan: { ...microScan, scannedAt: Date.now() },
      };
    } catch {}

    if (tickCount % 12 === 0) {
      console.log(`[Triton] Signal: ${tritonSignal.side} | mode=${tritonSignal.activeMode} regime=${tritonSignal.regime} htf=${tritonSignal.htfBias} score=${tritonSignal.score} rr=${tritonSignal.rr.toFixed(2)} tradability=${lastTradabilityScore} | 5m=${multiTF.tf5m.length} 1h=${multiTF.tf1h.length} 4h=${multiTF.tf4h.length} | ${tritonSignal.reasons.slice(0, 3).join('; ')}`);
    }
  } catch (tritonErr: any) {
    console.error(`[Triton] Signal engine error: ${tritonErr.message}`);
  }
  const { indicators } = signalResult;

  const e7 = ema(closes.slice(-100), 7);
  const e9 = ema(closes.slice(-100), 9);
  const e21 = ema(closes.slice(-200), 21);
  const e30 = ema(closes.slice(-200), 30);
  const e200 = ema(closes, 200);
  const m = macd(closes);

  indicatorHistory.push({
    time,
    rsi: parseFloat(indicators.rsi.toFixed(2)),
    connorsRsi: parseFloat(indicators.connorsRsi.toFixed(2)),
    ema7: parseFloat(e7.toFixed(4)),
    ema30: parseFloat(e30.toFixed(4)),
    ema200: parseFloat(e200.toFixed(4)),
    ema9: parseFloat(e9.toFixed(4)),
    ema21: parseFloat(e21.toFixed(4)),
    dema20: parseFloat(indicators.dema20.toFixed(4)),
    tema20: parseFloat(indicators.tema20.toFixed(4)),
    macdDif: parseFloat(m.dif.toFixed(6)),
    macdDea: parseFloat(m.dea.toFixed(6)),
    macdHist: parseFloat(m.macd.toFixed(6)),
  });
  if (indicatorHistory.length > 60) indicatorHistory = indicatorHistory.slice(-60);

  const prices24h = priceHistory24h.map(p => p.price);
  const high24h = prices24h.length > 0 ? Math.max(...prices24h) : currentPrice;
  const low24h = prices24h.length > 0 ? Math.min(...prices24h) : currentPrice;
  const firstPrice24h = prices24h.length > 0 ? prices24h[0] : currentPrice;
  const change24h = firstPrice24h > 0 ? ((currentPrice - firstPrice24h) / firstPrice24h) * 100 : 0;

  try {
    await storage.createMarketData({
      symbol: "SUI-USDC",
      price: currentPrice,
      pythPrice: pythPrice ?? null,
      high24h,
      low24h,
      volume24h: vol * 60 * 24,
      change24h: parseFloat(change24h.toFixed(2)),
    });

    const globalSignal = await storage.createSignal({
      symbol: "SUI-USDC",
      price: currentPrice,
      rsi: parseFloat(indicators.rsi.toFixed(2)),
      connorsRsi: parseFloat(indicators.connorsRsi.toFixed(2)),
      ema9: parseFloat(e9.toFixed(4)),
      ema21: parseFloat(e21.toFixed(4)),
      dema: parseFloat(indicators.dema20.toFixed(4)),
      tema: parseFloat(indicators.tema20.toFixed(4)),
      signal: signalResult.signal,
      signalScore: signalResult.reason,
    });

    const agentsList = await storage.getAgentsWithSignalAgents();
    for (const agent of agentsList) {
      if (agent.signalAgent && agent.status === "running") {
        const saSignal = await storage.createSignal({
          agentId: agent.id,
          signalAgentId: agent.signalAgent.id,
          symbol: "SUI-USDC",
          price: currentPrice,
          rsi: parseFloat(indicators.rsi.toFixed(2)),
          connorsRsi: parseFloat(indicators.connorsRsi.toFixed(2)),
          ema9: parseFloat(e9.toFixed(4)),
          ema21: parseFloat(e21.toFixed(4)),
          dema: parseFloat(indicators.dema20.toFixed(4)),
          tema: parseFloat(indicators.tema20.toFixed(4)),
          signal: signalResult.signal,
          signalScore: signalResult.reason,
        });

        await storage.updateSignalAgent(agent.signalAgent.id, {
          lastSignal: signalResult.signal,
          lastSignalScore: signalResult.reason,
          lastSignalAt: new Date(),
          signalCount: (agent.signalAgent.signalCount || 0) + 1,
        });

        await storage.updateAgent(agent.id, {
          lastSignalSide: signalResult.signal,
          lastSignalReason: signalResult.reason,
          lastSignalAt: new Date(),
        });

        {
          let tradeResult: any = null;
          try {
            const agentMode = (agent.signalMode as SignalMode) || "AUTO";
            let agentTriton = lastTritonSignal;
            try {
              const multiTF = getMultiTFCandles();
              const agentSentimentCtx = getSentimentContext();
              const agentBtcCtx = getBtcOverlayContext() ?? undefined;
              const agentSuiCtx = getSuiOverlayContext() ?? undefined;
              const agentAntiIdleCtx: AntiIdleCtx = {
                minutesSinceLastTrade: getAgentIdleMinutes(agent.id),
                tradabilityScore: lastTradabilityScore,
              };
              agentTriton = generateSignal({ ...multiTF, markPrice: currentPrice }, agentMode, agentSentimentCtx ?? undefined, agentBtcCtx, agentSuiCtx, agentAntiIdleCtx);
            } catch {}
            tradeResult = await executeSignalForAgent(
              agent,
              signalResult.signal,
              signalResult.reason,
              currentPrice,
              saSignal.id,
              agentTriton ?? undefined
            );
          } catch (err: any) {
            console.error(`[Execution] Signal error for ${agent.name}:`, err.message);
            tradeResult = { success: false, error: err.message, venue: agent.venue };
          }

          if (tradeResult !== null) {
            try {
              await emitBundleForSignal(agent, signalResult, currentPrice, tradeResult);
            } catch (e: any) {
              console.error(`[Bundle] Emit error for ${agent.name}:`, e.message);
            }
          }
        }
      }
    }
  } catch (e) {
  }
}

export function getMarketState() {
  const prices = priceHistory.map((p) => p.price);
  const currentPrice = prices.length > 0 ? prices[prices.length - 1] : 0;
  const prices24h = priceHistory24h.map(p => p.price);
  const localHigh24h = prices24h.length > 0 ? Math.max(...prices24h) : currentPrice;
  const localLow24h = prices24h.length > 0 ? Math.min(...prices24h) : currentPrice;
  const firstPrice24h = verified24hOpen ?? (prices24h.length > 0 ? prices24h[0] : currentPrice);
  const change24h = firstPrice24h > 0 ? ((currentPrice - firstPrice24h) / firstPrice24h) * 100 : 0;

  const high24h = verified24hHigh ?? localHigh24h;
  const low24h = verified24hLow ?? localLow24h;
  // Use CoinGecko USD volume as primary source (real spot market volume), fall back to Pyth candle sum, then a baseline estimate
  const volume24h = verified24hVolumeUSD ?? verified24hVolume ?? Math.floor(280000000 + Math.random() * 50000000);

  const lastPriceTick = getLastPrice();

  return {
    price: currentPrice,
    pythPrice: lastPriceTick?.pyth?.price ?? null,
    high24h,
    low24h,
    volume24h,
    change24h: parseFloat(change24h.toFixed(2)),
    priceSource: lastPriceTick?.pyth ? "pyth" : "simulated",
    high24hVerified: verified24hVerifiedAt !== null,
    low24hVerified: verified24hVerifiedAt !== null,
    verifiedAt: verified24hVerifiedAt,
    tradabilityScore: lastTradabilityScore,
    tradabilityLabel: lastTradabilityScore >= 80 ? "Excellent" : lastTradabilityScore >= 65 ? "Good" : lastTradabilityScore >= 45 ? "Fair" : "Poor",
  };
}

export function getPriceHistory() {
  return priceHistory;
}

export function getCandleHistory(): Candle[] {
  const result = [...candleHistory];
  if (currentCandle) result.push({ ...currentCandle });
  return result;
}

export function getIndicatorHistory() {
  return indicatorHistory;
}

const lastBundleEmitTime = new Map<string, number>();
const BUNDLE_EMIT_COOLDOWN_MS = 120_000;

async function emitBundleForSignal(
  agent: any,
  signalResult: SignalResult,
  currentPrice: number,
  tradeResult: any
) {
  const tradeSuccess = tradeResult?.success ?? false;
  const txDigest = tradeResult?.txDigest ?? null;
  const isVerified = tradeSuccess && txDigest && !txDigest.startsWith("sim_");
  if (!isVerified) return;

  const lastEmit = lastBundleEmitTime.get(agent.id) || 0;
  if (Date.now() - lastEmit < BUNDLE_EMIT_COOLDOWN_MS) return;
  lastBundleEmitTime.set(agent.id, Date.now());

  const signal = signalResult.signal.toLowerCase();
  const isStrong = signal.includes("strong") || signal.includes("weak");
  if (!isStrong) return;

  let side: "LONG" | "SHORT" | null = null;
  if (signal.includes("long")) side = "LONG";
  else if (signal.includes("short")) side = "SHORT";
  if (!side) return;

  const venue = "TYPUS_PERPS";
  const positionSizePct = 0.5;
  const notionalSui = agent.balance * positionSizePct * agent.leverage;

  const slMultiplier = agent.stopLossBps ? 1 - agent.stopLossBps / 10000 : 0.98;
  const tpMultiplier = agent.takeProfitBps ? 1 + agent.takeProfitBps / 10000 : undefined;

  const actions: Action[] = [
    {
      type: "OPEN",
      venue: venue as any,
      market: "SUI-USDC",
      side,
      leverage: agent.leverage,
      notionalUsd: Math.max(0.01, notionalSui * currentPrice),
      sl: slMultiplier,
      tp: tpMultiplier,
    },
  ];

  const risk: RiskParams = {
    maxNotionalUsd: notionalSui * currentPrice,
    maxLeverage: agent.leverage,
    maxDailyLossUsd: agent.balance * currentPrice * 0.1,
  };

  const user = agent.walletAddress || agent.agentWallet || "";

  const bundle = createBundle({
    agentId: agent.id,
    user,
    actions,
    risk,
  });

  const tradeError = tradeResult?.error ?? null;
  const bundleStatus = "recorded";

  await storage.createInstructionBundle({
    bundleId: bundle.bundleId,
    agentId: agent.id,
    userAddress: user,
    vaultId: bundle.vaultId || null,
    tradeCapId: bundle.tradeCapId || null,
    actions: bundle.actions as any,
    risk: bundle.risk as any,
    expiresAtMs: bundle.expiresAtMs,
    signature: null,
    status: bundleStatus,
  });

  await storage.createBundleExecution({
    bundleId: bundle.bundleId,
    agentId: agent.id,
    status: bundleStatus,
    txDigest: txDigest,
    venue: venue as string,
    actionsExecuted: actions.length,
    actionsFailed: 0,
    error: tradeError,
  });
}

async function initializeSessionBudgets() {
  try {
    const agents = await storage.getAgentsWithSignalAgents();
    const running = agents.filter(a => a.status === "running" && a.agentWallet);
    for (const agent of running) {
      try {
        const gasResult = await checkGasForAgent(agent.agentWallet!);
        if (gasResult.ok && gasResult.balanceSui && gasResult.balanceSui > 0) {
          registerTopoffResume(agent.id, gasResult.balanceSui);
          console.log(`[Startup] Initialized session gas budget for ${agent.name}: ${gasResult.balanceSui.toFixed(4)} SUI (limit: ${(gasResult.balanceSui * 0.6).toFixed(4)})`);
        } else {
          const conservativeBudget = Math.max(0.5, agent.balance * 0.1);
          registerTopoffResume(agent.id, conservativeBudget);
          console.log(`[Startup] Conservative session budget for ${agent.name}: ${conservativeBudget.toFixed(4)} SUI (RPC unavailable, using 10% of DB balance)`);
        }
      } catch {
        const conservativeBudget = Math.max(0.5, agent.balance * 0.1);
        registerTopoffResume(agent.id, conservativeBudget);
        console.log(`[Startup] Fallback session budget for ${agent.name}: ${conservativeBudget.toFixed(4)} SUI`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err: any) {
    console.error(`[Startup] Failed to initialize session budgets: ${err.message}`);
  }
}

export async function startMarketEngine() {
  await initializeHistory();
  startPriceLoop();

  startPositionMonitor();

  initializeSessionBudgets().catch(() => {});

  fetchPyth24hOHLC().catch(() => {});
  setInterval(() => fetchPyth24hOHLC().catch(() => {}), 5 * 60 * 1000);

  console.log("[MarketEngine] Started — ticking every 5s");
  setInterval(async () => {
    try {
      await tickMarket();
    } catch (err: any) {
      console.error(`[MarketEngine] Tick error: ${err.message}`);
    }
  }, 5000);

  setInterval(async () => {
    try {
      await processPendingUnfilledOrders();
    } catch (err: any) {
      console.error(`[MarketEngine] Unfilled order check error: ${err.message}`);
    }
  }, 60_000);

  setInterval(async () => {
    try {
      await processPendingPositionResolutions();
    } catch (err: any) {
      console.error(`[MarketEngine] Position resolution error: ${err.message}`);
    }
  }, 5_000);

  setTimeout(() => {
    setInterval(async () => {
      try {
        await processPendingDigestReconciliations();
      } catch (err: any) {
        console.error(`[MarketEngine] Digest reconciliation error: ${err.message}`);
      }
    }, 5_000);
  }, 3_000);

  setInterval(async () => {
    try {
      await verifyAndRecoverStuckPositions();
    } catch (err: any) {
      console.error(`[MarketEngine] Verify & Recover error: ${err.message}`);
    }
  }, 60_000);
}
