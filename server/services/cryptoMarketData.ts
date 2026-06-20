export interface CryptoPriceData {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
}

export interface OHLCCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface CryptoAnalysis {
  symbol: string;
  price: number;
  change24h: number;
  rsi: number;
  momentum5m: number;
  trendUp: boolean;
  volumeChange: number;
  atr: number;
  vwap: number;
  candles: OHLCCandle[];
}

const priceCache: Map<string, { data: CryptoAnalysis; ts: number }> = new Map();
const CACHE_TTL = 60_000;

// Coinbase Exchange product IDs
const CB_PAIRS: Record<string, string> = {
  BTC: "BTC-USD",
  ETH: "ETH-USD",
  SOL: "SOL-USD",
};

function calculateRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateATR(candles: OHLCCandle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs = candles.slice(-period).map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[candles.length - period + i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function calculateVWAP(candles: OHLCCandle[]): number {
  const recent = candles.slice(-20);
  let totalPV = 0, totalV = 0;
  for (const c of recent) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    totalPV += typicalPrice;
    totalV += 1;
  }
  return totalV > 0 ? totalPV / totalV : recent[recent.length - 1]?.close ?? 0;
}

function calculateEMA(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

// Fetch 5-minute candles from Coinbase Exchange (no auth required)
// Format returned: [timestamp, low, high, open, close, volume]
async function fetchCoinbaseCandles(pair: string): Promise<OHLCCandle[]> {
  const url = `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=300`;
  const res = await fetch(url, { headers: { "User-Agent": "BlueWaterPredictions/1.0" } });
  if (!res.ok) throw new Error(`Coinbase candles ${res.status}`);
  const raw: [number, number, number, number, number, number][] = await res.json();
  // raw: [time, low, high, open, close, volume] — sorted newest first
  return raw.slice(0, 60).reverse().map(r => ({
    timestamp: r[0] * 1000,
    low: r[1],
    high: r[2],
    open: r[3],
    close: r[4],
    volume: r[5],
  }));
}

// Fetch current ticker from Coinbase Exchange (no auth required)
async function fetchCoinbaseTicker(pair: string): Promise<{ price: number; volume: number }> {
  const url = `https://api.exchange.coinbase.com/products/${pair}/ticker`;
  const res = await fetch(url, { headers: { "User-Agent": "BlueWaterPredictions/1.0" } });
  if (!res.ok) throw new Error(`Coinbase ticker ${res.status}`);
  const data = await res.json();
  return { price: parseFloat(data.price), volume: parseFloat(data.volume) };
}

function buildMockCandles(price: number, count = 60): OHLCCandle[] {
  const candles: OHLCCandle[] = [];
  let p = price * (0.97 + Math.random() * 0.06);
  const now = Date.now();
  for (let i = count; i >= 0; i--) {
    const vol = (Math.random() - 0.5) * 0.003;
    const open = p;
    const close = p * (1 + vol);
    const high = Math.max(open, close) * (1 + Math.random() * 0.001);
    const low = Math.min(open, close) * (1 - Math.random() * 0.001);
    candles.push({ timestamp: now - i * 300_000, open, high, low, close });
    p = close;
  }
  return candles;
}

export async function fetchCryptoAnalysis(symbol: string): Promise<CryptoAnalysis> {
  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const pair = CB_PAIRS[symbol];
  if (!pair) throw new Error(`Unknown symbol: ${symbol}`);

  try {
    const [candles, ticker] = await Promise.all([
      fetchCoinbaseCandles(pair),
      fetchCoinbaseTicker(pair),
    ]);

    const closes = candles.map(c => c.close);
    const rsi = calculateRSI(closes);
    const atr = calculateATR(candles);
    const vwap = calculateVWAP(candles);

    const recentCloses = closes.slice(-6);
    const momentum5m = recentCloses.length >= 2
      ? (recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0]
      : 0;

    const ema20 = calculateEMA(closes.slice(-20), 20);
    const ema5 = calculateEMA(closes.slice(-5), 5);
    const trendUp = ema5 > ema20;

    // Volume ratio: avg of recent 5 candles vs avg of prior 20 candles
    const recentCandles = candles.slice(-5);
    const priorCandles = candles.slice(-25, -5);
    const avgRecentVol = recentCandles.reduce((s, c) => s + (c.volume ?? 0), 0) / Math.max(1, recentCandles.length);
    const avgPriorVol = priorCandles.reduce((s, c) => s + (c.volume ?? 0), 0) / Math.max(1, priorCandles.length);
    const volumeChange = avgPriorVol > 0 ? avgRecentVol / avgPriorVol : 1;

    const data: CryptoAnalysis = {
      symbol, price: ticker.price,
      change24h: 0,
      rsi, momentum5m, trendUp, volumeChange, atr, vwap, candles,
    };
    priceCache.set(symbol, { data, ts: Date.now() });
    return data;
  } catch (err) {
    console.warn(`[CryptoData] Coinbase fetch failed for ${symbol}, using mock data:`, (err as Error).message);
    const mockPrice = symbol === "BTC" ? 63800 : symbol === "ETH" ? 1726 : 71.7;
    const candles = buildMockCandles(mockPrice);
    const closes = candles.map(c => c.close);
    const data: CryptoAnalysis = {
      symbol, price: mockPrice, change24h: 0,
      rsi: 45 + Math.random() * 20,
      momentum5m: (Math.random() - 0.48) * 0.01,
      trendUp: Math.random() > 0.5,
      volumeChange: 0.85 + Math.random() * 0.4,
      atr: calculateATR(candles),
      vwap: calculateVWAP(candles),
      candles,
    };
    priceCache.set(symbol, { data, ts: Date.now() });
    return data;
  }
}

export function getCachedPrice(symbol: string): number | null {
  return priceCache.get(symbol)?.data.price ?? null;
}

// Compatibility export used by routes.ts /api/crypto/prices
export async function fetchAllCryptoPrices(): Promise<CryptoPriceData[]> {
  const symbols = ["BTC", "ETH", "SOL"];
  const results: CryptoPriceData[] = [];
  for (const s of symbols) {
    try {
      const a = await fetchCryptoAnalysis(s);
      results.push({ symbol: s, price: a.price, change24h: a.change24h, volume24h: 0, high24h: 0, low24h: 0 });
    } catch {}
  }
  return results;
}
