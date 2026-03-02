import {
  emaSeries, rsi as rsiLast, macd as macdLast, adx as adxLast,
  atr as atrLast, bollingerBands
} from "../shared/indicators";

export type SignalSide = "LONG" | "SHORT" | "NONE";
export type Regime = "TREND" | "RANGE" | "TRANSITION";
export type SignalMode = "AGGRESSIVE" | "PRECISION" | "AUTO";

export interface TradeSignal {
  symbol: string;
  side: SignalSide;
  regime: Regime;
  activeMode: Exclude<SignalMode, "AUTO">;
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

export type ModeProfile = {
  strongScore: number;
  weakScore: number;
  emaDistMax: number;
  emaDistIdeal: number;
  rsiMin: number;
  rsiMax: number;
  rsiExtremeHigh: number;
  rsiExtremeLow: number;
  volMin: number;
  volStrong: number;
  adxTrendMin: number;
  adxStrong: number;
  htfAlignedPoints: number;
  htfNeutralPoints: number;
  htfOppositePoints: number;
  allowMomentumContinuation: boolean;
  requireMacdTurnForWeak: boolean;
  minRrTrend: number;
  minRrRange: number;
  minAtrPct: number;
};

export const MODE_PROFILES: Record<Exclude<SignalMode, "AUTO">, ModeProfile> = {
  AGGRESSIVE: {
    strongScore: 55,
    weakScore: 40,
    emaDistMax: 2.50,
    emaDistIdeal: 1.00,
    rsiMin: 22,
    rsiMax: 82,
    rsiExtremeHigh: 85,
    rsiExtremeLow: 15,
    volMin: 0.45,
    volStrong: 1.10,
    adxTrendMin: 18,
    adxStrong: 25,
    htfAlignedPoints: 16,
    htfNeutralPoints: 10,
    htfOppositePoints: -4,
    allowMomentumContinuation: true,
    requireMacdTurnForWeak: false,
    minRrTrend: 0.7,
    minRrRange: 0.5,
    minAtrPct: 0.02,
  },
  PRECISION: {
    strongScore: 72,
    weakScore: 62,
    emaDistMax: 0.55,
    emaDistIdeal: 0.30,
    rsiMin: 38,
    rsiMax: 68,
    rsiExtremeHigh: 80,
    rsiExtremeLow: 20,
    volMin: 0.95,
    volStrong: 1.60,
    adxTrendMin: 24,
    adxStrong: 32,
    htfAlignedPoints: 18,
    htfNeutralPoints: 2,
    htfOppositePoints: -14,
    allowMomentumContinuation: false,
    requireMacdTurnForWeak: true,
    minRrTrend: 1.5,
    minRrRange: 1.2,
    minAtrPct: 0.10,
  },
};

export const SIGNAL_CONFIG = {
  decisionTF: "5m",
  signalTtlMs: 45_000,
  adxRange: 20,
  vwapDistMinPct: 0.5,
};

function selectAutoMode(adx: number, atrPct: number, volMult: number): Exclude<SignalMode, "AUTO"> {
  const highVol = volMult >= 1.0 || atrPct >= 0.40;
  const strongTrend = adx >= 22;
  if (highVol || strongTrend) return "AGGRESSIVE";
  return "PRECISION";
}

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

function classifyRegime(adxValue: number, ema20: number[]): Regime {
  const emaSlope = slope(ema20, 10);
  const trending = adxValue >= 25 && Math.abs(emaSlope) > 0;
  const ranging = adxValue <= SIGNAL_CONFIG.adxRange;
  if (trending) return "TREND";
  if (ranging) return "RANGE";
  return "TRANSITION";
}

function htfBias(candles: MarketCandle[]): "BULL" | "BEAR" | "NEUTRAL" {
  if (candles.length < 51) return "NEUTRAL";
  const closes = candles.map(c => c.c);
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

function getAdxFromCandles(candles: MarketCandle[]): number {
  if (candles.length < 30) return 25;
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const closes = candles.map(c => c.c);
  return adxLast(highs, lows, closes, 14);
}

function calculateWeightedScore(data: {
  adx: number;
  htfBias: "BULL" | "BEAR" | "NEUTRAL";
  proposedSide: SignalSide;
  emaDistance: number;
  rsi: number;
  volMult: number;
  macdTurn: boolean;
  sweepOk: boolean;
  rr: number;
}, profile: ModeProfile): { score: number; isExtreme: boolean } {
  let score = 0;

  if (data.adx >= profile.adxTrendMin) score += 20;
  if (data.adx >= profile.adxStrong) score += 10;

  const htfAligned = (data.proposedSide === "LONG" && data.htfBias === "BULL") ||
                     (data.proposedSide === "SHORT" && data.htfBias === "BEAR");
  const htfOpposite = (data.proposedSide === "LONG" && data.htfBias === "BEAR") ||
                      (data.proposedSide === "SHORT" && data.htfBias === "BULL");
  if (htfAligned) score += profile.htfAlignedPoints;
  else if (htfOpposite) score += profile.htfOppositePoints;
  else score += profile.htfNeutralPoints;

  if (data.emaDistance <= profile.emaDistMax) score += 10;
  if (data.emaDistance <= profile.emaDistIdeal) score += 6;

  if (data.rsi >= profile.rsiMin && data.rsi <= profile.rsiMax) score += 10;

  const isExtreme = data.rsi >= profile.rsiExtremeHigh || data.rsi <= profile.rsiExtremeLow;
  if (isExtreme && profile.allowMomentumContinuation) score += 6;

  if (data.volMult >= profile.volMin) score += 10;
  if (data.volMult >= profile.volStrong) score += 6;

  if (data.macdTurn) score += 10;
  else if (profile.requireMacdTurnForWeak) score -= 8;

  if (data.sweepOk) score += 8;

  const minRR = profile.minRrTrend;
  score += clamp((data.rr - minRR) * 10, -5, 10);

  return { score: clamp(score, 0, 100), isExtreme };
}

function classifySignal(score: number, profile: ModeProfile): "STRONG_TRADE" | "WEAK_TRADE" | "NO_TRADE" {
  if (score >= profile.strongScore) return "STRONG_TRADE";
  if (score >= profile.weakScore) return "WEAK_TRADE";
  return "NO_TRADE";
}

function scoreSizeMultiplier(score: number, mode: Exclude<SignalMode, "AUTO">): number {
  if (mode === "AGGRESSIVE") {
    if (score >= 70) return 1.0;
    if (score >= 60) return 0.85;
    if (score >= 50) return 0.7;
    if (score >= 45) return 0.55;
    if (score >= 40) return 0.4;
    return 0;
  }
  if (score >= 82) return 1.0;
  if (score >= 74) return 0.75;
  if (score >= 66) return 0.55;
  if (score >= 62) return 0.4;
  return 0;
}

function findTradeSide(
  tf: MarketCandle[],
  htf: "BULL" | "BEAR" | "NEUTRAL",
  regime: Regime,
  profile: ModeProfile
): {
  side: SignalSide;
  distToEma: number;
  rsi: number;
  volMult: number;
  macdTurn: boolean;
  sweepOk: boolean;
  vwapDistPct: number;
  details: string[];
} {
  const closes = tf.map(c => c.c);
  const ema20 = emaSeries(closes, 20);
  const r = rsiSeries(closes, 14);
  const hist = macdHistSeries(closes);
  const vspike = volumeSpikeRatio(tf, 20);
  const bb = bollingerBands(closes, 20, 2);
  const vwap = vwapRolling(tf, 288);
  const sweep = liquiditySweep(tf, 20);
  const i = closes.length - 1;
  const price = closes[i];
  const distToEma = Math.abs(price - ema20[i]) / ema20[i] * 100;
  const macdTurningUp = hist[i] > hist[i - 1];
  const macdTurningDown = hist[i] < hist[i - 1];
  const vwapDistPct = (price - vwap[i]) / vwap[i] * 100;
  const nearLower = price <= bb.lower * 1.002;
  const nearUpper = price >= bb.upper * 0.998;
  const details: string[] = [];

  let side: SignalSide = "NONE";

  if (regime === "TREND" || regime === "TRANSITION") {
    const emaInRange = distToEma <= profile.emaDistMax;
    const rsiOk = r[i] >= profile.rsiMin && r[i] <= profile.rsiMax;
    const isExtremeRsi = r[i] >= profile.rsiExtremeHigh || r[i] <= profile.rsiExtremeLow;
    const volOk = vspike[i] >= profile.volMin;

    const canLong = emaInRange && (rsiOk || (isExtremeRsi && profile.allowMomentumContinuation)) && volOk;
    const canShort = emaInRange && (rsiOk || (isExtremeRsi && profile.allowMomentumContinuation)) && volOk;

    if (canLong && macdTurningUp && (htf === "BULL" || htf === "NEUTRAL")) {
      side = "LONG";
      details.push("Trend pullback LONG");
    } else if (canShort && macdTurningDown && (htf === "BEAR" || htf === "NEUTRAL")) {
      side = "SHORT";
      details.push("Trend pullback SHORT");
    }

    if (side === "NONE" && profile.allowMomentumContinuation) {
      if (r[i] >= profile.rsiExtremeHigh && macdTurningDown && price > ema20[i]) {
        side = "SHORT";
        details.push("Momentum continuation SHORT (RSI extreme)");
      } else if (r[i] <= profile.rsiExtremeLow && macdTurningUp && price < ema20[i]) {
        side = "LONG";
        details.push("Momentum continuation LONG (RSI extreme)");
      }
    }

    if (side === "NONE" && profile.allowMomentumContinuation && volOk) {
      const trendUp = price > ema20[i] && macdTurningUp && r[i] < profile.rsiMax;
      const trendDown = price < ema20[i] && macdTurningDown && r[i] > profile.rsiMin;
      if (trendUp && (htf === "BULL" || htf === "NEUTRAL")) {
        side = "LONG";
        details.push("Trend momentum LONG (above EMA + MACD + vol)");
      } else if (trendDown && (htf === "BEAR" || htf === "NEUTRAL")) {
        side = "SHORT";
        details.push("Trend momentum SHORT (below EMA + MACD + vol)");
      }
    }
  }

  if (side === "NONE" && (regime === "RANGE" || regime === "TRANSITION")) {
    const rsiLow = r[i] <= profile.rsiMin + 5;
    const rsiHigh = r[i] >= profile.rsiMax - 5;
    const sweepLong = sweep.bullishSweep || lowerWick(tf[i]) > 2 * candleBody(tf[i]);
    const sweepShort = sweep.bearishSweep || upperWick(tf[i]) > 2 * candleBody(tf[i]);

    if (nearLower && rsiLow && sweepLong && vwapDistPct <= -SIGNAL_CONFIG.vwapDistMinPct) {
      side = "LONG";
      details.push("Range mean-reversion LONG (BB lower + sweep)");
    } else if (nearUpper && rsiHigh && sweepShort && vwapDistPct >= SIGNAL_CONFIG.vwapDistMinPct) {
      side = "SHORT";
      details.push("Range mean-reversion SHORT (BB upper + sweep)");
    }

    if (side === "NONE" && profile.allowMomentumContinuation) {
      const bbMid = (bb.upper + bb.lower) / 2;
      const nearBBLow = price < bbMid && rsiLow;
      const nearBBHigh = price > bbMid && rsiHigh;
      if (nearBBLow && macdTurningUp) {
        side = "LONG";
        details.push("Range bounce LONG (below BB mid + RSI low + MACD turn)");
      } else if (nearBBHigh && macdTurningDown) {
        side = "SHORT";
        details.push("Range fade SHORT (above BB mid + RSI high + MACD turn)");
      }
    }
  }

  const macdTurn = side === "LONG" ? macdTurningUp : side === "SHORT" ? macdTurningDown : false;
  const sweepOk = side === "LONG" ? sweep.bullishSweep : side === "SHORT" ? sweep.bearishSweep : false;

  return {
    side, distToEma, rsi: r[i], volMult: vspike[i],
    macdTurn, sweepOk, vwapDistPct, details,
  };
}

export function generateSignal(md: MultiTFData, configMode: SignalMode = "AUTO"): TradeSignal {
  const symbol = "SUI-USDC";
  const tf = md.tf5m;
  const price = md.markPrice;

  if (tf.length < 50) {
    return {
      symbol, side: "NONE", regime: "TRANSITION", activeMode: "PRECISION",
      timeframe: SIGNAL_CONFIG.decisionTF, htfBias: "NEUTRAL",
      score: 0, reasons: ["Insufficient 5m candle data"],
      entry: price, stop: price, takeProfit: price,
      rr: 0, sizeMultiplier: 0, validUntilMs: Date.now() + 30_000,
    };
  }

  const closes = tf.map(c => c.c);
  const ema20 = emaSeries(closes, 20);
  const atr14 = atrSeries(tf, 14);
  const atrPctLast = atrPercent(atr14[atr14.length - 1], price);

  const adxValue = getAdxFromCandles(tf);
  const regime = classifyRegime(adxValue, ema20);
  const htf = combinedHTFBias(md.tf1h, md.tf4h);

  const volSpikes = volumeSpikeRatio(tf, 20);
  const lastVol = volSpikes[volSpikes.length - 1];

  const activeMode = configMode === "AUTO"
    ? selectAutoMode(adxValue, atrPctLast, lastVol)
    : configMode;
  const profile = MODE_PROFILES[activeMode];

  const reasons: string[] = [];
  reasons.push(`${regime} regime (ADX ${adxValue.toFixed(1)}) | Mode: ${activeMode}`);
  reasons.push(`HTF ${htf}, ATR% ${atrPctLast.toFixed(3)}%, vol ${lastVol.toFixed(2)}x`);

  if (atrPctLast < profile.minAtrPct && regime !== "RANGE") {
    const rArr = rsiSeries(closes, 14);
    const distToEma = Math.abs(closes[closes.length - 1] - ema20[ema20.length - 1]) / ema20[ema20.length - 1] * 100;
    const { score } = calculateWeightedScore({
      adx: adxValue, htfBias: htf, proposedSide: "NONE",
      emaDistance: distToEma, rsi: rArr[rArr.length - 1], volMult: lastVol,
      macdTurn: false, sweepOk: false, rr: 0,
    }, profile);
    reasons.push(`Low ATR: ${atrPctLast.toFixed(3)}% < ${profile.minAtrPct}% — dead zone`);
    reasons.push(`EMA dist ${distToEma.toFixed(2)}%, RSI ${rArr[rArr.length - 1].toFixed(1)}`);
    return {
      symbol, side: "NONE", regime, activeMode, timeframe: SIGNAL_CONFIG.decisionTF, htfBias: htf,
      score, reasons, entry: price, stop: price, takeProfit: price,
      rr: 0, sizeMultiplier: 0, validUntilMs: Date.now() + 30_000,
    };
  }

  const setup = findTradeSide(tf, htf, regime, profile);
  let { side } = setup;
  const { distToEma, rsi, volMult, macdTurn, sweepOk, vwapDistPct, details } = setup;
  reasons.push(`EMA dist ${distToEma.toFixed(2)}%, RSI ${rsi.toFixed(1)}, VWAP dist ${vwapDistPct.toFixed(2)}%`);
  reasons.push(...details);

  const highs = swingHighs(tf, 2, 2);
  const lows = swingLows(tf, 2, 2);

  let entry = price;
  let stop = price;
  let takeProfit = price;
  let rr = 0;

  if (side !== "NONE") {
    const target = side === "LONG"
      ? (nearestAbove(highs, price) ?? price * 1.003)
      : (nearestBelow(lows, price) ?? price * 0.997);
    const oppLevel = side === "LONG"
      ? (nearestBelow(lows, price) ?? price * 0.997)
      : (nearestAbove(highs, price) ?? price * 1.003);

    entry = price;
    stop = oppLevel;
    takeProfit = target;
    rr = computeRR(side, entry, stop, takeProfit);
  }

  const { score, isExtreme } = calculateWeightedScore({
    adx: adxValue, htfBias: htf, proposedSide: side,
    emaDistance: distToEma, rsi, volMult,
    macdTurn, sweepOk, rr,
  }, profile);

  const classification = classifySignal(score, profile);
  const sizeMult = scoreSizeMultiplier(score, activeMode);

  if (side !== "NONE") {
    const minRR = regime === "RANGE" ? profile.minRrRange : profile.minRrTrend;
    if (rr < minRR) {
      reasons.push(`RR ${rr.toFixed(2)} < ${minRR} — rejected`);
      side = "NONE";
    }
  }

  if (classification === "NO_TRADE" && side !== "NONE") {
    reasons.push(`Score ${score} < ${profile.weakScore} (${activeMode}) — rejected`);
    side = "NONE";
  }

  if (side !== "NONE") {
    reasons.push(`${classification}: score ${score}, RR ${rr.toFixed(2)}, size ${sizeMult.toFixed(0)}%`);
    if (isExtreme) reasons.push("RSI extreme — continuation entry");
  } else {
    if (details.length === 0) {
      reasons.push(`No setup found (need pullback ≤${profile.emaDistMax}%, RSI ${profile.rsiMin}-${profile.rsiMax}, vol ≥${profile.volMin}x)`);
    }
    reasons.push(`Score: ${score}, threshold: ${profile.weakScore} (${activeMode})`);
  }

  return {
    symbol, side, regime, activeMode,
    timeframe: SIGNAL_CONFIG.decisionTF, htfBias: htf,
    score, reasons, entry, stop, takeProfit,
    rr, sizeMultiplier: sizeMult,
    validUntilMs: side !== "NONE" ? Date.now() + SIGNAL_CONFIG.signalTtlMs : Date.now() + 30_000,
  };
}
