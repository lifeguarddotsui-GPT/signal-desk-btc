import { storage } from "./storage";

let currentPrice = 3.85;
let priceHistory: Array<{ time: string; price: number; volume: number }> = [];
let indicatorHistory: Array<{ time: string; rsi: number; ema9: number; ema21: number }> = [];
let closes: number[] = [];

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function rsi(closesArr: number[], period = 14): number {
  if (closesArr.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closesArr.length - period; i < closesArr.length; i++) {
    const diff = closesArr[i] - closesArr[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const rs = gains / Math.max(1e-9, losses);
  return 100 - 100 / (1 + rs);
}

function generateSignal(r: number, e9: number, e21: number): string {
  const trendUp = e9 > e21;
  const trendDown = e9 < e21;

  if (trendUp && r < 45) return "strong_long";
  if (trendUp && r < 55) return "weak_long";
  if (trendDown && r > 55) return "strong_short";
  if (trendDown && r > 45) return "weak_short";
  return "no_trade";
}

function initializeHistory() {
  const now = Date.now();
  let p = 3.80 + Math.random() * 0.10;

  for (let i = 59; i >= 0; i--) {
    const change = (Math.random() - 0.48) * 0.015;
    p = Math.max(3.50, Math.min(4.20, p + change));
    closes.push(p);

    const time = new Date(now - i * 60000);
    const vol = Math.floor(50000 + Math.random() * 100000);

    priceHistory.push({
      time: time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      price: parseFloat(p.toFixed(4)),
      volume: vol,
    });

    const e9 = ema(closes.slice(-100), 9);
    const e21 = ema(closes.slice(-200), 21);
    const r = rsi(closes, 14);

    indicatorHistory.push({
      time: time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      rsi: parseFloat(r.toFixed(2)),
      ema9: parseFloat(e9.toFixed(4)),
      ema21: parseFloat(e21.toFixed(4)),
    });
  }

  currentPrice = p;
}

export async function tickMarket() {
  const volatility = 0.008;
  const momentum = (Math.random() - 0.48) * volatility;
  currentPrice = Math.max(3.40, Math.min(4.30, currentPrice + momentum));
  closes.push(currentPrice);

  if (closes.length > 500) closes = closes.slice(-500);

  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const vol = Math.floor(50000 + Math.random() * 120000);

  priceHistory.push({ time, price: parseFloat(currentPrice.toFixed(4)), volume: vol });
  if (priceHistory.length > 60) priceHistory = priceHistory.slice(-60);

  const e9 = ema(closes.slice(-100), 9);
  const e21 = ema(closes.slice(-200), 21);
  const r = rsi(closes, 14);

  indicatorHistory.push({
    time,
    rsi: parseFloat(r.toFixed(2)),
    ema9: parseFloat(e9.toFixed(4)),
    ema21: parseFloat(e21.toFixed(4)),
  });
  if (indicatorHistory.length > 60) indicatorHistory = indicatorHistory.slice(-60);

  const signal = generateSignal(r, e9, e21);

  const prices = priceHistory.map((p) => p.price);
  const high24h = Math.max(...prices);
  const low24h = Math.min(...prices);
  const firstPrice = prices[0] || currentPrice;
  const change24h = ((currentPrice - firstPrice) / firstPrice) * 100;

  try {
    await storage.createMarketData({
      symbol: "SUI-PERP",
      price: currentPrice,
      high24h,
      low24h,
      volume24h: vol * 60 * 24,
      change24h: parseFloat(change24h.toFixed(2)),
    });

    await storage.createSignal({
      symbol: "SUI-PERP",
      price: currentPrice,
      rsi: parseFloat(r.toFixed(2)),
      ema9: parseFloat(e9.toFixed(4)),
      ema21: parseFloat(e21.toFixed(4)),
      signal,
    });
  } catch (e) {
    // ignore db errors during tick
  }
}

export function getMarketState() {
  const prices = priceHistory.map((p) => p.price);
  const high24h = prices.length > 0 ? Math.max(...prices) : currentPrice;
  const low24h = prices.length > 0 ? Math.min(...prices) : currentPrice;
  const firstPrice = prices[0] || currentPrice;
  const change24h = ((currentPrice - firstPrice) / firstPrice) * 100;

  return {
    price: currentPrice,
    high24h,
    low24h,
    volume24h: Math.floor(80000000 + Math.random() * 20000000),
    change24h: parseFloat(change24h.toFixed(2)),
  };
}

export function getPriceHistory() {
  return priceHistory;
}

export function getIndicatorHistory() {
  return indicatorHistory;
}

export function startMarketEngine() {
  initializeHistory();
  setInterval(() => {
    tickMarket();
  }, 5000);
}
