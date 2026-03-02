import {
  emaSeries, rsi as rsiLast, macd as macdLast, adx as adxLast,
  atr as atrLast, bollingerBands
} from "../shared/indicators";

export type SignalSide = "LONG" | "SHORT" | "NONE";
export type Regime = "TREND" | "RANGE" | "TRANSITION";

export interface TradeSignal {
  symbol: string;
  side: SignalSide;
  regime: Regime;
  timeframe: string;
  htfBias: "BULL" | "BEAR" | "NEUTRAL";
  score: number;
  reasons: string[];
  entry: number;
  stop: number;
  takeProfit: number;
  rr: number;
  sizeMultiplier: number;
  validUntilMs: number;
}

export interface MarketCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface MultiTFData {
  tf5m: MarketCandle[];
  tf1h: MarketCandle[];
  tf4h: MarketCandle[];
  markPrice: number;
}

export const SIGNAL_CONFIG = {
  decisionTF: "5m",
  minScore: 65,
  minRrTrend: 1.5,
  minRrRange: 1.2,
  requireHtfAlignment: true,
  volumeSpikeMin: 1.0,
  emaPullbackDistPct: 0.25,
  rangeRsiLow: 35,
  rangeRsiHigh: 65,
  vwapDistMinPct: 0.5,
  adxTrend: 25,
  adxRange: 20,
  signalTtlMs: 45_000,
  minAtrPct: 0.10,
};

function rsiSeries(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - (100 / (1 + gain / loss));
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - (100 / (1 + gain / loss));
  }
  return out;
}

function atrSeries(candles: MarketCandle[], period = 14): number[] {
  const out: number[] = new Array(candles.length).fill(0);
  if (candles.length < 2) return out;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    ));
  }
  if (trs.length < period) return out;
  let v = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = v;
  for (let i = period; i < trs.length; i++) {
    v = (v * (period - 1) + trs[i]) / period;
    out[i + 1] = v;
  }
  return out;
}

function macdHistSeries(closes: number[], fast = 12, slow = 26, signal = 9): number[] {
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) => fastE[i] - slowE[i]);
  const sig = emaSeries(macdLine, signal);
  return macdLine.map((v, i) => v - sig[i]);
}

function vwapRolling(candles: MarketCandle[], lookback = 288): number[] {
  const out: number[] = new Array(candles.length).fill(0);
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - lookback + 1);
    let pv = 0, vol = 0;
    for (let j = start; j <= i; j++) {
      const tp = (candles[j].h + candles[j].l + candles[j].c) / 3;
      pv += tp * candles[j].v;
      vol += candles[j].v;
    }
    out[i] = vol === 0 ? candles[i].c : pv / vol;
  }
  return out;
}

function volumeSpikeRatio(candles: MarketCandle[], period = 20): number[] {
  const out: number[] = new Array(candles.length).fill(1);
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - period + 1);
    const window = candles.slice(start, i + 1);
    const avg = window.reduce((a, c) => a + c.v, 0) / window.length;
    out[i] = avg === 0 ? 1 : candles[i].v / avg;
  }
  return out;
}

function slope(values: number[], lookback = 10): number {
  const n = values.length;
  if (n < lookback + 1) return 0;
  return (values[n - 1] - values[n - 1 - lookback]) / lookback;
}

function classifyRegime(params: { adxValue: number; ema20: number[]; atrPct: number }): Regime {
  const emaSlope = slope(params.ema20, 10);
  const trending = params.adxValue >= SIGNAL_CONFIG.adxTrend && Math.abs(emaSlope) > 0;
  const ranging = params.adxValue <= SIGNAL_CONFIG.adxRange;
  if (trending) return "TREND";
  if (ranging) return "RANGE";
  return "TRANSITION";
}

function htfBias(candles: MarketCandle[]): "BULL" | "BEAR" | "NEUTRAL" {
  if (candles.length < 51) return "NEUTRAL";
  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const ema50 = emaSeries(closes, 50);
  const r = rsiSeries(closes, 14);
  const hist = macdHistSeries(closes);
  const i = closes.length - 1;
  const above = closes[i] > ema50[i];
  const below = closes[i] < ema50[i];
  if (above && hist[i] >= 0 && r[i] >= 50) return "BULL";
  if (below && hist[i] <= 0 && r[i] <= 50) return "BEAR";
  return "NEUTRAL";
}

function combinedHTFBias(tf1h: MarketCandle[], tf4h: MarketCandle[]): "BULL" | "BEAR" | "NEUTRAL" {
  const b1 = htfBias(tf1h);
  const b4 = htfBias(tf4h);
  if (b1 === b4) return b1;
  return "NEUTRAL";
}

function candleBody(c: MarketCandle) { return Math.abs(c.c - c.o); }
function upperWick(c: MarketCandle) { return c.h - Math.max(c.o, c.c); }
function lowerWick(c: MarketCandle) { return Math.min(c.o, c.c) - c.l; }

function liquiditySweep(candles: MarketCandle[], lookback = 20) {
  if (candles.length < lookback + 1) return { bullishSweep: false, bearishSweep: false, prevHigh: 0, prevLow: 0 };
  const last = candles[candles.length - 1];
  const prevSlice = candles.slice(-lookback - 1, -1);
  const prevHigh = Math.max(...prevSlice.map(c => c.h));
  const prevLow = Math.min(...prevSlice.map(c => c.l));
  const body = candleBody(last);
  const uw = upperWick(last);
  const lw = lowerWick(last);
  const wickFactor = 2;
  const bearishSweep = last.h > prevHigh && last.c < prevHigh && uw > wickFactor * Math.max(body, 1e-9);
  const bullishSweep = last.l < prevLow && last.c > prevLow && lw > wickFactor * Math.max(body, 1e-9);
  return { bullishSweep, bearishSweep, prevHigh, prevLow };
}

function atrPercent(atrValue: number, price: number): number {
  return price > 0 ? (atrValue / price) * 100 : 0;
}

function swingHighs(candles: MarketCandle[], left = 2, right = 2): number[] {
  const highs: number[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const h = candles[i].h;
    let ok = true;
    for (let j = 1; j <= left; j++) if (candles[i - j].h >= h) ok = false;
    for (let j = 1; j <= right; j++) if (candles[i + j].h > h) ok = false;
    if (ok) highs.push(h);
  }
  return highs;
}

function swingLows(candles: MarketCandle[], left = 2, right = 2): number[] {
  const lows: number[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const l = candles[i].l;
    let ok = true;
    for (let j = 1; j <= left; j++) if (candles[i - j].l <= l) ok = false;
    for (let j = 1; j <= right; j++) if (candles[i + j].l < l) ok = false;
    if (ok) lows.push(l);
  }
  return lows;
}

function nearestAbove(levels: number[], price: number): number | null {
  const above = levels.filter(x => x > price).sort((a, b) => a - b);
  return above.length ? above[0] : null;
}

function nearestBelow(levels: number[], price: number): number | null {
  const below = levels.filter(x => x < price).sort((a, b) => b - a);
  return below.length ? below[0] : null;
}

function computeRR(side: "LONG" | "SHORT", entry: number, stop: number, target: number): number {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (risk <= 0) return 0;
  return reward / risk;
}

function clamp(x: number, a: number, b: number) { return Math.max(a, Math.min(b, x)); }

function scoreSignal(params: {
  regime: Regime;
  htfAligned: boolean;
  volumeOk: boolean;
  sweepOk: boolean;
  rr: number;
  rrMin: number;
}) {
  let score = 0;
  score += params.htfAligned ? 35 : 0;
  score += params.volumeOk ? 15 : 0;
  score += (params.regime === "TREND" ? 20 : params.regime === "RANGE" ? 20 : 10);
  score += params.sweepOk ? 20 : 0;
  score += clamp((params.rr - params.rrMin) * 20, 0, 10);
  score = clamp(score, 0, 100);

  let size = 1.0;
  if (!params.htfAligned) size *= 0.3;
  if (params.regime === "TRANSITION") size *= 0.5;
  if (!params.volumeOk) size *= 0.6;
  size = clamp(size, 0, 1);

  return { score, sizeMultiplier: size };
}

function trendSetup(candles: MarketCandle[], htf: "BULL" | "BEAR" | "NEUTRAL") {
  const closes = candles.map(c => c.c);
  const ema20 = emaSeries(closes, 20);
  const r = rsiSeries(closes, 14);
  const hist = macdHistSeries(closes);
  const vspike = volumeSpikeRatio(candles, 20);
  const i = closes.length - 1;
  const price = closes[i];
  const distToEma = Math.abs(price - ema20[i]) / ema20[i] * 100;
  const macdTurningUp = hist[i] > hist[i - 1];
  const macdTurningDown = hist[i] < hist[i - 1];

  const longOk =
    htf === "BULL" &&
    distToEma <= SIGNAL_CONFIG.emaPullbackDistPct &&
    r[i] >= 40 && r[i] <= 60 &&
    macdTurningUp &&
    vspike[i] >= SIGNAL_CONFIG.volumeSpikeMin;

  const shortOk =
    htf === "BEAR" &&
    distToEma <= SIGNAL_CONFIG.emaPullbackDistPct &&
    r[i] <= 60 && r[i] >= 40 &&
    macdTurningDown &&
    vspike[i] >= SIGNAL_CONFIG.volumeSpikeMin;

  return { longOk, shortOk, distToEma, rsi: r[i], vspike: vspike[i], hist: hist[i] };
}

function rangeSetup(candles: MarketCandle[]) {
  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const bb = bollingerBands(closes, 20, 2);
  const r = rsiSeries(closes, 14);
  const vwap = vwapRolling(candles, 288);
  const vspike = volumeSpikeRatio(candles, 20);
  const sweep = liquiditySweep(candles, 20);
  const i = closes.length - 1;
  const price = closes[i];
  const vwapDistPct = (price - vwap[i]) / vwap[i] * 100;
  const nearLower = price <= bb.lower * 1.002;
  const nearUpper = price >= bb.upper * 0.998;

  const longOk =
    nearLower &&
    r[i] <= SIGNAL_CONFIG.rangeRsiLow &&
    (sweep.bullishSweep || lowerWick(candles[i]) > 2 * candleBody(candles[i])) &&
    vwapDistPct <= -SIGNAL_CONFIG.vwapDistMinPct &&
    vspike[i] <= 2.5;

  const shortOk =
    nearUpper &&
    r[i] >= SIGNAL_CONFIG.rangeRsiHigh &&
    (sweep.bearishSweep || upperWick(candles[i]) > 2 * candleBody(candles[i])) &&
    vwapDistPct >= SIGNAL_CONFIG.vwapDistMinPct &&
    vspike[i] <= 2.5;

  return { longOk, shortOk, vwapDistPct, rsi: r[i], sweep, vspike: vspike[i] };
}

function getAdxFromCandles(candles: MarketCandle[]): number {
  if (candles.length < 30) return 25;
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const closes = candles.map(c => c.c);
  return adxLast(highs, lows, closes, 14);
}

function makeNoneSignal(symbol: string, regime: Regime, htf: "BULL" | "BEAR" | "NEUTRAL", price: number, reasons: string[]): TradeSignal {
  return {
    symbol, side: "NONE", regime, timeframe: SIGNAL_CONFIG.decisionTF, htfBias: htf,
    score: 0, reasons, entry: price, stop: price, takeProfit: price,
    rr: 0, sizeMultiplier: 0, validUntilMs: Date.now() + 30_000
  };
}

export function generateSignal(md: MultiTFData): TradeSignal {
  const symbol = "SUI-USDC";
  const tf = md.tf5m;
  const price = md.markPrice;

  if (tf.length < 50) {
    return makeNoneSignal(symbol, "TRANSITION", "NEUTRAL", price, ["Insufficient 5m candle data"]);
  }

  const closes = tf.map(c => c.c);
  const ema20 = emaSeries(closes, 20);
  const atr14 = atrSeries(tf, 14);
  const atrPctLast = atrPercent(atr14[atr14.length - 1], price);

  const adxValue = getAdxFromCandles(tf);
  const regime = classifyRegime({ adxValue, ema20, atrPct: atrPctLast });
  const htf = combinedHTFBias(md.tf1h, md.tf4h);

  if (atrPctLast < SIGNAL_CONFIG.minAtrPct && regime !== "RANGE") {
    const t = trendSetup(tf, htf);
    const indicativeRR = 0;
    const vsp = volumeSpikeRatio(tf, 20);
    const volumeOk = vsp[vsp.length - 1] >= SIGNAL_CONFIG.volumeSpikeMin;
    const { score: indicativeScore } = scoreSignal({
      regime, htfAligned: false, volumeOk, sweepOk: false, rr: 0, rrMin: SIGNAL_CONFIG.minRrTrend,
    });
    return {
      symbol, side: "NONE" as SignalSide, regime, timeframe: SIGNAL_CONFIG.decisionTF, htfBias: htf,
      score: indicativeScore, reasons: [
        `No-trade zone: ATR% ${atrPctLast.toFixed(3)}% below ${SIGNAL_CONFIG.minAtrPct}% threshold in ${regime} regime`,
        `EMA dist ${t.distToEma.toFixed(2)}%, RSI ${t.rsi.toFixed(1)}, vol ${t.vspike.toFixed(2)}x`
      ],
      entry: price, stop: price, takeProfit: price,
      rr: indicativeRR, sizeMultiplier: 0, validUntilMs: Date.now() + 30_000
    };
  }

  let side: SignalSide = "NONE";
  let reasons: string[] = [];
  let entry = price;
  let stop = price;
  let takeProfit = price;
  let rr = 0;

  const highs = swingHighs(tf, 2, 2);
  const lows = swingLows(tf, 2, 2);
  const MIN_RR = regime === "RANGE" ? SIGNAL_CONFIG.minRrRange : SIGNAL_CONFIG.minRrTrend;

  if (regime === "TREND") {
    const t = trendSetup(tf, htf);
    if (t.longOk) side = "LONG";
    if (t.shortOk) side = "SHORT";

    reasons.push(`TREND regime (ADX ${adxValue.toFixed(1)})`);
    reasons.push(`HTF bias ${htf}, EMA dist ${t.distToEma.toFixed(2)}%, RSI ${t.rsi.toFixed(1)}, vol ${t.vspike.toFixed(2)}x`);

    if (side !== "NONE") {
      const target = side === "LONG"
        ? (nearestAbove(highs, price) ?? price * 1.003)
        : (nearestBelow(lows, price) ?? price * 0.997);
      const opp = side === "LONG"
        ? (nearestBelow(lows, price) ?? price * 0.997)
        : (nearestAbove(highs, price) ?? price * 1.003);

      entry = price;
      stop = opp;
      takeProfit = target;
      rr = computeRR(side, entry, stop, takeProfit);

      reasons.push(`Pullback near EMA20 (dist ${t.distToEma.toFixed(2)}%)`);
      reasons.push(`MACD turning ${side === "LONG" ? "up" : "down"}`);
    } else {
      reasons.push(`No trend setup: need HTF=${htf === "BULL" ? "✓" : "✗"}, EMA pullback ≤${SIGNAL_CONFIG.emaPullbackDistPct}%, RSI 40-60, MACD turn, vol ≥${SIGNAL_CONFIG.volumeSpikeMin}x`);
    }
  } else if (regime === "RANGE") {
    const r = rangeSetup(tf);
    if (r.longOk) side = "LONG";
    if (r.shortOk) side = "SHORT";

    reasons.push(`RANGE regime (ADX ${adxValue.toFixed(1)})`);
    reasons.push(`RSI ${r.rsi.toFixed(1)}, VWAP dist ${r.vwapDistPct.toFixed(2)}%, vol ${r.vspike.toFixed(2)}x`);

    if (side !== "NONE") {
      const target = side === "LONG"
        ? (nearestAbove(highs, price) ?? price * 1.0025)
        : (nearestBelow(lows, price) ?? price * 0.9975);
      const sweep = r.sweep;
      const stopRef = side === "LONG"
        ? (sweep.prevLow ? sweep.prevLow * 0.999 : price * 0.997)
        : (sweep.prevHigh ? sweep.prevHigh * 1.001 : price * 1.003);

      entry = price;
      stop = stopRef;
      takeProfit = target;
      rr = computeRR(side, entry, stop, takeProfit);

      reasons.push(`BB touch + sweep: ${side === "LONG" ? r.sweep.bullishSweep : r.sweep.bearishSweep}`);
    } else {
      reasons.push(`No range setup: need BB touch, RSI ≤${SIGNAL_CONFIG.rangeRsiLow}/≥${SIGNAL_CONFIG.rangeRsiHigh}, sweep/wick, VWAP ≥${SIGNAL_CONFIG.vwapDistMinPct}%`);
    }
  } else {
    const t = trendSetup(tf, htf);
    const r = rangeSetup(tf);

    const bestSide: SignalSide = t.longOk ? "LONG" : t.shortOk ? "SHORT"
      : r.longOk ? "LONG" : r.shortOk ? "SHORT" : "NONE";
    const indicativeTarget = bestSide === "LONG"
      ? (nearestAbove(highs, price) ?? price * 1.003)
      : bestSide === "SHORT"
        ? (nearestBelow(lows, price) ?? price * 0.997)
        : price;
    const indicativeStop = bestSide === "LONG"
      ? (nearestBelow(lows, price) ?? price * 0.997)
      : bestSide === "SHORT"
        ? (nearestAbove(highs, price) ?? price * 1.003)
        : price;
    const indicativeRR = bestSide !== "NONE"
      ? computeRR(bestSide, price, indicativeStop, indicativeTarget)
      : 0;

    const vsp = volumeSpikeRatio(tf, 20);
    const volumeOk = vsp[vsp.length - 1] >= SIGNAL_CONFIG.volumeSpikeMin;
    const sweep = liquiditySweep(tf, 20);
    const sweepOk = bestSide === "LONG" ? sweep.bullishSweep : bestSide === "SHORT" ? sweep.bearishSweep : false;
    const htfAligned = (bestSide === "LONG" && htf === "BULL") || (bestSide === "SHORT" && htf === "BEAR");
    const { score: indicativeScore, sizeMultiplier: indicativeSizeMult } = scoreSignal({
      regime, htfAligned, volumeOk, sweepOk, rr: indicativeRR, rrMin: MIN_RR,
    });

    reasons.push(`TRANSITION regime (ADX ${adxValue.toFixed(1)}): no trade`);
    reasons.push(`Indicative: ${bestSide !== "NONE" ? bestSide : "no setup"}, score ${indicativeScore}, RR ${indicativeRR.toFixed(2)}`);
    reasons.push(`EMA dist ${t.distToEma.toFixed(2)}%, RSI ${t.rsi.toFixed(1)}, vol ${t.vspike.toFixed(2)}x`);

    return {
      symbol, side: "NONE", regime, timeframe: SIGNAL_CONFIG.decisionTF, htfBias: htf,
      score: indicativeScore, reasons, entry: price, stop: indicativeStop, takeProfit: indicativeTarget,
      rr: indicativeRR, sizeMultiplier: indicativeSizeMult, validUntilMs: Date.now() + 30_000
    };
  }

  if (side !== "NONE" && SIGNAL_CONFIG.requireHtfAlignment) {
    const htfAligned = (side === "LONG" && htf === "BULL") || (side === "SHORT" && htf === "BEAR");
    if (!htfAligned) {
      reasons.push(`Rejected: HTF bias ${htf} not aligned with ${side}`);
      side = "NONE";
    }
  }

  if (side !== "NONE" && rr < MIN_RR) {
    reasons.push(`Rejected: RR ${rr.toFixed(2)} < ${MIN_RR}`);
    side = "NONE";
  }

  const vsp = volumeSpikeRatio(tf, 20);
  const volumeOk = vsp[vsp.length - 1] >= SIGNAL_CONFIG.volumeSpikeMin;
  const sweep = liquiditySweep(tf, 20);

  if (side === "NONE") {
    const htfAligned = (htf === "BULL" || htf === "BEAR");
    const { score: indicativeScore, sizeMultiplier: indicativeSizeMult } = scoreSignal({
      regime, htfAligned, volumeOk, sweepOk: false, rr, rrMin: MIN_RR,
    });
    return {
      symbol, side: "NONE", regime, timeframe: SIGNAL_CONFIG.decisionTF, htfBias: htf,
      score: indicativeScore, reasons, entry, stop, takeProfit,
      rr, sizeMultiplier: indicativeSizeMult, validUntilMs: Date.now() + 30_000
    };
  }

  const sweepOk = regime === "RANGE" ? (side === "LONG" ? sweep.bullishSweep : sweep.bearishSweep) : false;

  const { score, sizeMultiplier } = scoreSignal({
    regime,
    htfAligned: true,
    volumeOk,
    sweepOk,
    rr,
    rrMin: MIN_RR,
  });

  if (score < SIGNAL_CONFIG.minScore) {
    reasons.push(`Rejected: score ${score} < ${SIGNAL_CONFIG.minScore}`);
    return {
      symbol, side: "NONE" as SignalSide, regime, timeframe: SIGNAL_CONFIG.decisionTF, htfBias: htf,
      score, reasons, entry, stop, takeProfit,
      rr, sizeMultiplier, validUntilMs: Date.now() + 30_000
    };
  }

  reasons.push(`Approved: score ${score}, RR ${rr.toFixed(2)}`);

  return {
    symbol,
    side,
    regime,
    timeframe: SIGNAL_CONFIG.decisionTF,
    htfBias: htf,
    score,
    reasons,
    entry,
    stop,
    takeProfit,
    rr,
    sizeMultiplier,
    validUntilMs: Date.now() + SIGNAL_CONFIG.signalTtlMs,
  };
}
