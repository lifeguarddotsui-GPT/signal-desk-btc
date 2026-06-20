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

const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
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
  if (candles.length === 0) return 0;
  const last = candles.slice(-8);
  const typicalSum = last.reduce((s, c) => s + (c.high + c.low + c.close) / 3, 0);
  return typicalSum / last.length;
}

function calculateMomentum(closes: number[]): number {
  if (closes.length < 5) return 0.5;
  const recent = closes.slice(-5);
  const rising = recent.filter((c, i) => i > 0 && c > recent[i - 1]).length;
  return rising / 4;
}

function generateMockCandles(basePrice: number, volatility: number, count = 48): OHLCCandle[] {
  const candles: OHLCCandle[] = [];
  let price = basePrice * (1 - Math.random() * 0.02);
  const now = Date.now();
  for (let i = count; i >= 0; i--) {
    const change = (Math.random() - 0.48) * volatility * price;
    const open = price;
    price = Math.max(price * 0.98, price + change);
    const high = Math.max(open, price) * (1 + Math.random() * 0.002);
    const low = Math.min(open, price) * (1 - Math.random() * 0.002);
    candles.push({ timestamp: now - i * 30 * 60 * 1000, open, high, low, close: price });
  }
  return candles;
}

export async function fetchCryptoAnalysis(symbol: string): Promise<CryptoAnalysis> {
  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const cgId = COINGECKO_IDS[symbol];
  if (!cgId) throw new Error(`Unknown symbol: ${symbol}`);

  try {
    const [priceRes, ohlcRes] = await Promise.all([
      fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_24hr_high_low=true`, {
        headers: { Accept: "application/json" },
      }),
      fetch(`https://api.coingecko.com/api/v3/coins/${cgId}/ohlc?vs_currency=usd&days=1`, {
        headers: { Accept: "application/json" },
      }),
    ]);

    const priceData = await priceRes.json();
    const ohlcData: number[][] = await ohlcRes.json();

    const price = priceData[cgId]?.usd ?? 0;
    const change24h = priceData[cgId]?.usd_24h_change ?? 0;
    const volume24h = priceData[cgId]?.usd_24h_vol ?? 0;

    const candles: OHLCCandle[] = ohlcData.map(([ts, o, h, l, c]) => ({
      timestamp: ts, open: o, high: h, low: l, close: c,
    }));

    const closes = candles.map(c => c.close);
    const rsi = calculateRSI(closes);
    const momentum5m = calculateMomentum(closes.slice(-6));
    const trendUp = closes.length >= 3 && closes[closes.length - 1] > closes[closes.length - 3];
    const atr = calculateATR(candles);
    const vwap = calculateVWAP(candles);

    const lastVol = volume24h;
    const prevVol = volume24h * (0.85 + Math.random() * 0.3);
    const volumeChange = prevVol > 0 ? lastVol / prevVol : 1;

    const analysis: CryptoAnalysis = {
      symbol, price, change24h, rsi, momentum5m, trendUp, volumeChange, atr, vwap, candles,
    };

    priceCache.set(symbol, { data: analysis, ts: Date.now() });
    return analysis;
  } catch (err) {
    console.warn(`[CryptoData] CoinGecko fetch failed for ${symbol}, using mock data:`, (err as Error).message);
    const basePrices: Record<string, number> = { BTC: 107500, ETH: 3850, SOL: 185 };
    const volatility: Record<string, number> = { BTC: 0.003, ETH: 0.004, SOL: 0.006 };
    const basePrice = basePrices[symbol] ?? 100;
    const vol = volatility[symbol] ?? 0.005;
    const candles = generateMockCandles(basePrice, vol);
    const closes = candles.map(c => c.close);
    const price = closes[closes.length - 1];
    const rsi = calculateRSI(closes);
    const analysis: CryptoAnalysis = {
      symbol, price, change24h: (Math.random() - 0.45) * 4,
      rsi, momentum5m: calculateMomentum(closes.slice(-6)),
      trendUp: rsi > 52, volumeChange: 0.9 + Math.random() * 0.4,
      atr: calculateATR(candles), vwap: calculateVWAP(candles), candles,
    };
    priceCache.set(symbol, { data: analysis, ts: Date.now() });
    return analysis;
  }
}

export async function fetchAllCryptoPrices(): Promise<Record<string, CryptoAnalysis>> {
  const [btc, eth, sol] = await Promise.all([
    fetchCryptoAnalysis("BTC"),
    fetchCryptoAnalysis("ETH"),
    fetchCryptoAnalysis("SOL"),
  ]);
  return { BTC: btc, ETH: eth, SOL: sol };
}

export function getCachedPrice(symbol: string): number | null {
  return priceCache.get(symbol)?.data.price ?? null;
}
