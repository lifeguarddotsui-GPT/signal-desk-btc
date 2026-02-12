import { storage } from "./storage";
import { priceBus, getLastPrice, startPriceLoop, type PriceTick } from "./price-service";
import { ema, rsi, computeSignal, connorsRsi, dema, tema, rsiSeries as rsiSeriesFn } from "../shared/indicators";

let priceHistory: Array<{ time: string; price: number; volume: number }> = [];
let indicatorHistory: Array<{
  time: string;
  rsi: number;
  connorsRsi: number;
  ema9: number;
  ema21: number;
  dema20: number;
  tema20: number;
}> = [];
let closes: number[] = [];
let volumes: number[] = [];

function initializeHistory() {
  const now = Date.now();
  let p = 3.80 + Math.random() * 0.10;

  for (let i = 59; i >= 0; i--) {
    const change = (Math.random() - 0.48) * 0.015;
    p = Math.max(2.50, Math.min(6.00, p + change));
    closes.push(p);

    const time = new Date(now - i * 60000);
    const vol = Math.floor(50000 + Math.random() * 100000);
    volumes.push(vol);

    priceHistory.push({
      time: time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      price: parseFloat(p.toFixed(4)),
      volume: vol,
    });

    const e9 = ema(closes.slice(-100), 9);
    const e21 = ema(closes.slice(-200), 21);
    const r = rsi(closes, 14);
    const cRsi = connorsRsi(closes);
    const d20 = closes.length > 20 ? dema(closes.slice(-60), 20) : e9;
    const t20 = closes.length > 20 ? tema(closes.slice(-60), 20) : e9;

    indicatorHistory.push({
      time: time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      rsi: parseFloat(r.toFixed(2)),
      connorsRsi: parseFloat(cRsi.toFixed(2)),
      ema9: parseFloat(e9.toFixed(4)),
      ema21: parseFloat(e21.toFixed(4)),
      dema20: parseFloat(d20.toFixed(4)),
      tema20: parseFloat(t20.toFixed(4)),
    });
  }
}

export async function tickMarket() {
  const lastPrice = getLastPrice();
  let currentPrice: number;
  let pythPrice: number | undefined;
  let sudoPrice: number | undefined;

  if (lastPrice) {
    currentPrice = lastPrice.blended;
    pythPrice = lastPrice.pyth?.price;
    sudoPrice = lastPrice.sudo?.price;
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

  const signalResult = computeSignal(closes, volumes);
  const { indicators } = signalResult;

  const e9 = ema(closes.slice(-100), 9);
  const e21 = ema(closes.slice(-200), 21);

  indicatorHistory.push({
    time,
    rsi: parseFloat(indicators.rsi.toFixed(2)),
    connorsRsi: parseFloat(indicators.connorsRsi.toFixed(2)),
    ema9: parseFloat(e9.toFixed(4)),
    ema21: parseFloat(e21.toFixed(4)),
    dema20: parseFloat(indicators.dema20.toFixed(4)),
    tema20: parseFloat(indicators.tema20.toFixed(4)),
  });
  if (indicatorHistory.length > 60) indicatorHistory = indicatorHistory.slice(-60);

  const prices = priceHistory.map((p) => p.price);
  const high24h = Math.max(...prices);
  const low24h = Math.min(...prices);
  const firstPrice = prices[0] || currentPrice;
  const change24h = ((currentPrice - firstPrice) / firstPrice) * 100;

  try {
    await storage.createMarketData({
      symbol: "SUI-PERP",
      price: currentPrice,
      pythPrice: pythPrice ?? null,
      sudoPrice: sudoPrice ?? null,
      high24h,
      low24h,
      volume24h: vol * 60 * 24,
      change24h: parseFloat(change24h.toFixed(2)),
    });

    const globalSignal = await storage.createSignal({
      symbol: "SUI-PERP",
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
          symbol: "SUI-PERP",
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
      }
    }
  } catch (e) {
  }
}

export function getMarketState() {
  const prices = priceHistory.map((p) => p.price);
  const currentPrice = prices.length > 0 ? prices[prices.length - 1] : 0;
  const high24h = prices.length > 0 ? Math.max(...prices) : currentPrice;
  const low24h = prices.length > 0 ? Math.min(...prices) : currentPrice;
  const firstPrice = prices[0] || currentPrice;
  const change24h = firstPrice > 0 ? ((currentPrice - firstPrice) / firstPrice) * 100 : 0;

  const lastPriceTick = getLastPrice();

  return {
    price: currentPrice,
    pythPrice: lastPriceTick?.pyth?.price ?? null,
    sudoPrice: lastPriceTick?.sudo?.price ?? null,
    high24h,
    low24h,
    volume24h: Math.floor(80000000 + Math.random() * 20000000),
    change24h: parseFloat(change24h.toFixed(2)),
    priceSource: lastPriceTick?.pyth ? "pyth" : lastPriceTick?.sudo ? "sudo" : "simulated",
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
  startPriceLoop();
  setInterval(() => {
    tickMarket();
  }, 5000);
}
