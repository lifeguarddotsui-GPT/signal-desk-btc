import { storage } from "./storage";
import { priceBus, getLastPrice, startPriceLoop, type PriceTick } from "./price-service";
import { ema, emaSeries, rsi, computeSignal, connorsRsi, dema, tema, rsiSeries as rsiSeriesFn, macd, type SignalResult } from "../shared/indicators";
import { executeSignalForAgent, checkAndClosePositions } from "./dex/execution-engine";
import { createBundle, type Action, type RiskParams } from "../shared/bundle";
import { VENUE_MAP } from "../shared/sui-constants";

let lastSignalResult: SignalResult | null = null;

export function getLastSignalResult(): SignalResult | null {
  return lastSignalResult;
}

let priceHistory: Array<{ time: string; price: number; volume: number }> = [];
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

function getCandleBucket(ts: number): number {
  return Math.floor(ts / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;
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

  initializeCandleHistory(p);
}

function initializeCandleHistory(currentPrice: number) {
  const now = Date.now();
  let p = currentPrice - 0.15 + Math.random() * 0.05;

  for (let i = 24; i >= 1; i--) {
    const bucket = getCandleBucket(now - i * CANDLE_INTERVAL_MS);
    const open = p;
    const volatility = 0.005 + Math.random() * 0.01;
    const direction = Math.random() - 0.48;
    const close = parseFloat((open + direction * volatility * 3).toFixed(4));
    const high = parseFloat((Math.max(open, close) + Math.random() * volatility * 2).toFixed(4));
    const low = parseFloat((Math.min(open, close) - Math.random() * volatility * 2).toFixed(4));
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
}

export async function tickMarket() {
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

  updateCandle(currentPrice, vol);

  const signalResult = computeSignal(closes, volumes);
  lastSignalResult = signalResult;
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

  const prices = priceHistory.map((p) => p.price);
  const high24h = Math.max(...prices);
  const low24h = Math.min(...prices);
  const firstPrice = prices[0] || currentPrice;
  const change24h = ((currentPrice - firstPrice) / firstPrice) * 100;

  try {
    await storage.createMarketData({
      symbol: "SUI-USDC",
      price: currentPrice,
      pythPrice: pythPrice ?? null,
      sudoPrice: null,
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

        if (agent.balance > 0) {
          try {
            await checkAndClosePositions(agent, currentPrice);
          } catch (err: any) {
            console.error(`[Execution] Position check error for ${agent.name}:`, err.message);
          }

          let tradeResult: any = null;
          try {
            tradeResult = await executeSignalForAgent(
              agent,
              signalResult.signal,
              signalResult.reason,
              currentPrice,
              saSignal.id
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
  const high24h = prices.length > 0 ? Math.max(...prices) : currentPrice;
  const low24h = prices.length > 0 ? Math.min(...prices) : currentPrice;
  const firstPrice = prices[0] || currentPrice;
  const change24h = firstPrice > 0 ? ((currentPrice - firstPrice) / firstPrice) * 100 : 0;

  const lastPriceTick = getLastPrice();

  return {
    price: currentPrice,
    pythPrice: lastPriceTick?.pyth?.price ?? null,
    sudoPrice: null,
    high24h,
    low24h,
    volume24h: Math.floor(80000000 + Math.random() * 20000000),
    change24h: parseFloat(change24h.toFixed(2)),
    priceSource: lastPriceTick?.pyth ? "pyth" : "simulated",
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

async function emitBundleForSignal(
  agent: any,
  signalResult: SignalResult,
  currentPrice: number,
  tradeResult: any
) {
  const signal = signalResult.signal.toLowerCase();
  const isStrong = signal.includes("strong") || signal.includes("weak");
  if (!isStrong) return;

  let side: "LONG" | "SHORT" | null = null;
  if (signal.includes("long")) side = "LONG";
  else if (signal.includes("short")) side = "SHORT";
  if (!side) return;

  const venue = "TYPUS_PERPS";
  const positionSizePct = 0.5;
  const notionalUsd = agent.balance * positionSizePct * currentPrice;

  const slMultiplier = agent.stopLossBps ? 1 - agent.stopLossBps / 10000 : 0.98;
  const tpMultiplier = agent.takeProfitBps ? 1 + agent.takeProfitBps / 10000 : undefined;

  const actions: Action[] = [
    {
      type: "OPEN",
      venue: venue as any,
      market: "SUI-USDC",
      side,
      leverage: agent.leverage,
      notionalUsd: Math.max(0.01, notionalUsd),
      sl: slMultiplier,
      tp: tpMultiplier,
    },
  ];

  const risk: RiskParams = {
    maxNotionalUsd: agent.balance * currentPrice * agent.leverage,
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

  const tradeSuccess = tradeResult?.success ?? false;
  const txDigest = tradeResult?.txDigest ?? null;
  const tradeError = tradeResult?.error ?? null;

  const isVerified = tradeSuccess && txDigest && !txDigest.startsWith("sim_");
  const bundleStatus = isVerified ? "recorded" : "rejected";

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
    txDigest: isVerified ? txDigest : null,
    venue: venue as string,
    actionsExecuted: isVerified ? actions.length : 0,
    actionsFailed: isVerified ? 0 : actions.length,
    error: tradeError,
  });
}

export function startMarketEngine() {
  initializeHistory();
  startPriceLoop();
  setInterval(() => {
    tickMarket();
  }, 5000);
}
