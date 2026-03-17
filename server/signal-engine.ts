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
  activeMode: SignalMode;
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

export const MODE_PROFILES: Record<SignalMode, ModeProfile> = {
  AGGRESSIVE: {
    // T2-A: Raised thresholds — previous 45/58 allowed too many weak signals
    // leading to 26% win rate and systematic losses at 32x leverage.
    // htfNeutralPoints reduced 8→3: no information should not reward a trade.
    // minRrTrend raised 1.5→1.8: at 40% win rate, RR<1.8 is negative EV.
    strongScore: 65,
    weakScore: 55,
    emaDistMax: 2.00,
    emaDistIdeal: 0.70,
    rsiMin: 25,
    rsiMax: 75,
    rsiExtremeHigh: 82,
    rsiExtremeLow: 18,
    volMin: 0.50,
    volStrong: 0.90,
    adxTrendMin: 18,
    adxStrong: 25,
    htfAlignedPoints: 22,
    htfNeutralPoints: 3,
    htfOppositePoints: -20,
    allowMomentumContinuation: true,
    requireMacdTurnForWeak: false,
    minRrTrend: 1.80,
    minRrRange: 2.00,
    minAtrPct: 0.07,
  },
  AUTO: {
    // Calibrated for dual-position model: looser thresholds so the agent can
    // fire both positions when conditions align, without being as permissive
    // as AGGRESSIVE mode.
    // htfNeutralPoints reduced 6→3: same rationale as AGGRESSIVE.
    // minRrTrend raised 1.4→1.6 for better EV floor.
    strongScore: 62,
    weakScore: 52,
    emaDistMax: 1.60,
    emaDistIdeal: 0.55,
    rsiMin: 28,
    rsiMax: 72,
    rsiExtremeHigh: 78,
    rsiExtremeLow: 22,
    volMin: 0.45,
    volStrong: 0.95,
    adxTrendMin: 20,
    adxStrong: 28,
    htfAlignedPoints: 20,
    htfNeutralPoints: 3,
    htfOppositePoints: -18,
    allowMomentumContinuation: true,
    requireMacdTurnForWeak: false,
    minRrTrend: 1.60,
    minRrRange: 1.80,
    minAtrPct: 0.05,
  },
  PRECISION: {
    // htfNeutralPoints reduced 4→2: PRECISION mode demands confirmed HTF direction.
    strongScore: 72,
    weakScore: 62,
    emaDistMax: 0.80,
    emaDistIdeal: 0.30,
    rsiMin: 32,
    rsiMax: 68,
    rsiExtremeHigh: 76,
    rsiExtremeLow: 24,
    volMin: 0.70,
    volStrong: 1.30,
    adxTrendMin: 22,
    adxStrong: 30,
    htfAlignedPoints: 16,
    htfNeutralPoints: 2,
    htfOppositePoints: -20,
    allowMomentumContinuation: false,
    requireMacdTurnForWeak: true,
    minRrTrend: 2.0,
    minRrRange: 1.5,
    minAtrPct: 0.06,
  },
};

export const SIGNAL_CONFIG = {
  decisionTF: "5m",
  signalTtlMs: 45_000,
  adxRange: 20,
  vwapDistMinPct: 0.5,
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

function classifyRegime(adxValue: number, ema20: number[]): Regime {
  const emaSlope = slope(ema20, 10);
  const trending = adxValue >= 25 && Math.abs(emaSlope) > 0;
  const ranging = adxValue <= SIGNAL_CONFIG.adxRange;
  if (trending) return "TREND";
  if (ranging) return "RANGE";
  return "TRANSITION";
}

/**
 * Returns how many consecutive ticks the MACD histogram has moved in the
 * same direction (positive = rising, negative = falling).
 * e.g. returns 3 if hist[i] > hist[i-1] > hist[i-2] > hist[i-3]
 */
function macdMomentumTicks(hist: number[]): { longTicks: number; shortTicks: number } {
  const i = hist.length - 1;
  let longTicks = 0;
  let shortTicks = 0;
  for (let k = i; k >= 1; k--) {
    if (hist[k] > hist[k - 1]) longTicks++;
    else break;
  }
  for (let k = i; k >= 1; k--) {
    if (hist[k] < hist[k - 1]) shortTicks++;
    else break;
  }
  return { longTicks, shortTicks };
}

/**
 * Regime boundary confidence: returns a penalty (0-10) when ADX is near
 * the trend/range boundary (15-22), indicating uncertain regime.
 */
function regimeBoundaryPenalty(adxValue: number): number {
  if (adxValue >= 22) return 0;    // clearly trending
  if (adxValue <= 14) return 0;    // clearly ranging
  return Math.round((22 - adxValue) / (22 - 14) * 10);  // 0-10 penalty
}

/**
 * Counter-trend score penalty: trades against HTF bias are penalised
 * more harshly when the HTF bias is "strong" (price well outside EMA).
 */
function counterTrendPenalty(side: SignalSide, htf: "BULL" | "BEAR" | "NEUTRAL"): number {
  const isCounterTrend =
    (side === "SHORT" && htf === "BULL") ||
    (side === "LONG" && htf === "BEAR");
  return isCounterTrend ? 15 : 0; // -15 pts for counter-trend
}

function htfBias(candles: MarketCandle[]): "BULL" | "BEAR" | "NEUTRAL" {
  if (candles.length < 51) return "NEUTRAL";
  const closes = candles.map(c => c.c);
  const ema50 = emaSeries(closes, 50);
  const r = rsiSeries(closes, 14);
  const hist = macdHistSeries(closes);
  const i = closes.length - 1;

  // Four independent votes instead of strict 3-of-3 AND.
  // The previous AND logic caused genuine uptrends to collapse to NEUTRAL
  // whenever one indicator briefly dipped (e.g. RSI pulls back to 48 mid-trend).
  // Now we require 3-of-4 agreement, which is robust to single-indicator noise.
  const priceAboveEma = closes[i] > ema50[i];
  const priceBelowEma = closes[i] < ema50[i];

  // EMA50 slope: compare current EMA to 5 bars ago — more reliable than 1-bar diff.
  const ema50Slope = i >= 5 ? ema50[i] - ema50[i - 5] : 0;
  const risingEma = ema50Slope > 0;
  const fallingEma = ema50Slope < 0;

  const macdBull = hist[i] > 0;
  const macdBear = hist[i] < 0;

  const rsiBull = r[i] > 50;
  const rsiBear = r[i] < 50;

  const bullVotes = (priceAboveEma ? 1 : 0) + (risingEma ? 1 : 0) + (macdBull ? 1 : 0) + (rsiBull ? 1 : 0);
  const bearVotes = (priceBelowEma ? 1 : 0) + (fallingEma ? 1 : 0) + (macdBear ? 1 : 0) + (rsiBear ? 1 : 0);

  if (bullVotes >= 3) return "BULL";
  if (bearVotes >= 3) return "BEAR";
  return "NEUTRAL";
}

function combinedHTFBias(tf1h: MarketCandle[], tf4h: MarketCandle[]): "BULL" | "BEAR" | "NEUTRAL" {
  const b1 = htfBias(tf1h); // 1h leads — reacts faster to emerging trends
  const b4 = htfBias(tf4h); // 4h confirms — but no longer vetoes directional calls

  // Both agree → clear signal
  if (b1 === b4) return b1;

  // 1h directional + 4h neutral → use 1h direction.
  // 4h lags by definition; a neutral 4h during an emerging 1h trend should NOT
  // collapse the bias to NEUTRAL. Previously this was the main cause of all agents
  // shorting into a bull move (SUI +5% in 24h with combinedHTF showing NEUTRAL).
  if (b1 !== "NEUTRAL" && b4 === "NEUTRAL") return b1;

  // 4h directional + 1h neutral → use 4h direction (longer-term context is clear).
  if (b4 !== "NEUTRAL" && b1 === "NEUTRAL") return b4;

  // Direct conflict (BULL vs BEAR) → NEUTRAL — genuinely ambiguous, stay cautious.
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
  macdAccelerating?: boolean;
  rsiDiverging?: boolean;
  sweepOk: boolean;
  rr: number;
  vwapDistPct?: number;
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
  if (isExtreme && profile.allowMomentumContinuation) score -= 10;

  if (data.volMult >= profile.volMin) score += 10;
  if (data.volMult >= profile.volStrong) score += 6;

  if (data.macdTurn) {
    score += 10;
    if (data.macdAccelerating) score += 6;
  } else if (profile.requireMacdTurnForWeak) score -= 10;

  if (data.sweepOk) score += 8;

  if (data.rsiDiverging) score -= 10;

  if (data.vwapDistPct !== undefined) {
    const vwapAligned = (data.proposedSide === "LONG" && data.vwapDistPct < 0) ||
                        (data.proposedSide === "SHORT" && data.vwapDistPct > 0);
    if (vwapAligned) score += 4;
    const vwapOpposing = (data.proposedSide === "LONG" && data.vwapDistPct > 0.5) ||
                         (data.proposedSide === "SHORT" && data.vwapDistPct < -0.5);
    if (vwapOpposing) score -= 3;
  }

  const minRR = profile.minRrTrend;
  score += clamp((data.rr - minRR) * 10, -5, 10);

  return { score: Math.round(clamp(score, 0, 100)), isExtreme };
}

function classifySignal(score: number, profile: ModeProfile): "STRONG_TRADE" | "WEAK_TRADE" | "NO_TRADE" {
  if (score >= profile.strongScore) return "STRONG_TRADE";
  if (score >= profile.weakScore) return "WEAK_TRADE";
  return "NO_TRADE";
}

function scoreSizeMultiplier(score: number, mode: SignalMode): number {
  if (mode === "AGGRESSIVE") {
    if (score >= 70) return 1.0;
    if (score >= 60) return 0.80;
    if (score >= 52) return 0.60;
    if (score >= 45) return 0.45;
    if (score >= 38) return 0.35;
    return 0;
  }
  if (mode === "AUTO") {
    if (score >= 68) return 1.0;
    if (score >= 58) return 0.75;
    if (score >= 50) return 0.55;
    if (score >= 44) return 0.40;
    if (score >= 40) return 0.30;
    return 0;
  }
  if (score >= 82) return 1.0;
  if (score >= 74) return 0.75;
  if (score >= 66) return 0.55;
  if (score >= 60) return 0.45;
  if (score >= 48) return 0.3;
  return 0;
}

function findTradeSide(
  tf: MarketCandle[],
  htf: "BULL" | "BEAR" | "NEUTRAL",
  regime: Regime,
  profile: ModeProfile,
  adx: number
): {
  side: SignalSide;
  distToEma: number;
  rsi: number;
  volMult: number;
  macdTurn: boolean;
  macdAccelerating: boolean;
  rsiDiverging: boolean;
  sweepOk: boolean;
  vwapDistPct: number;
  details: string[];
  isStrongTrendExtension: boolean;
  isMeanReversion: boolean;
  isRangeTrend: boolean;
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
  const macdAccel = i >= 2 ? Math.abs(hist[i] - hist[i - 1]) > Math.abs(hist[i - 1] - hist[i - 2]) : false;
  const vwapDistPct = (price - vwap[i]) / vwap[i] * 100;
  const nearLower = price <= bb.lower * 1.002;
  const nearUpper = price >= bb.upper * 0.998;

  let rsiDivergence = false;
  if (i >= 10) {
    const recentLow = Math.min(...closes.slice(i - 5, i + 1));
    const prevLow = Math.min(...closes.slice(i - 10, i - 4));
    const recentRsiLow = Math.min(...r.slice(i - 5, i + 1));
    const prevRsiLow = Math.min(...r.slice(i - 10, i - 4));
    if (recentLow < prevLow && recentRsiLow > prevRsiLow) rsiDivergence = true;
    const recentHigh = Math.max(...closes.slice(i - 5, i + 1));
    const prevHigh = Math.max(...closes.slice(i - 10, i - 4));
    const recentRsiHigh = Math.max(...r.slice(i - 5, i + 1));
    const prevRsiHigh = Math.max(...r.slice(i - 10, i - 4));
    if (recentHigh > prevHigh && recentRsiHigh < prevRsiHigh) rsiDivergence = true;
  }
  const details: string[] = [];

  let side: SignalSide = "NONE";
  let isStrongTrendExtension = false;
  let isMeanReversion = false;
  let isRangeTrend = false;
  const volOk = vspike[i] >= profile.volMin;

  if (regime === "TREND" || regime === "TRANSITION") {
    const emaInRange = distToEma <= profile.emaDistMax;
    const rsiOk = r[i] >= profile.rsiMin && r[i] <= profile.rsiMax;
    const isExtremeRsi = r[i] >= profile.rsiExtremeHigh || r[i] <= profile.rsiExtremeLow;

    const canLong = emaInRange && (rsiOk || (isExtremeRsi && profile.allowMomentumContinuation)) && volOk;
    const canShort = emaInRange && (rsiOk || (isExtremeRsi && profile.allowMomentumContinuation)) && volOk;

    // In TRANSITION + NEUTRAL HTF, use 5m price vs EMA20 as a direction tiebreaker.
    // If price is above EMA20, only allow LONG (not SHORT). If below, only SHORT.
    // This prevents generating SHORT signals when the local 5m trend is up —
    // the core cause of shorting into rising prices when the combined HTF is NEUTRAL.
    const transitionNeutral = regime === "TRANSITION" && htf === "NEUTRAL";
    const aboveLocalEma = price > ema20[i];
    const belowLocalEma = price < ema20[i];

    if (canLong && macdTurningUp && (htf === "BULL" || htf === "NEUTRAL") && (!transitionNeutral || aboveLocalEma)) {
      side = "LONG";
      details.push("Trend pullback LONG");
    } else if (canShort && macdTurningDown && (htf === "BEAR" || htf === "NEUTRAL") && (!transitionNeutral || belowLocalEma)) {
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

    if (side === "NONE" && profile.allowMomentumContinuation && i >= 22) {
      const ema9 = emaSeries(closes, 9);
      const ema21 = emaSeries(closes, 21);
      const crossUp = ema9[i] > ema21[i] && ema9[i - 1] <= ema21[i - 1];
      const crossDown = ema9[i] < ema21[i] && ema9[i - 1] >= ema21[i - 1];
      if (crossUp && volOk && (htf === "BULL" || htf === "NEUTRAL")) {
        side = "LONG";
        details.push("EMA cross LONG (EMA9 × EMA21 + vol)");
      } else if (crossDown && volOk && (htf === "BEAR" || htf === "NEUTRAL")) {
        side = "SHORT";
        details.push("EMA cross SHORT (EMA9 × EMA21 + vol)");
      }
    }

    if (side === "NONE" && profile.allowMomentumContinuation && adx > 25 && volOk) {
      const extremeOversold = r[i] < 22;
      const extremeOverbought = r[i] > 78;
      const priceConfirmsDown = price < ema20[i] && distToEma > profile.emaDistMax;
      const priceConfirmsUp = price > ema20[i] && distToEma > profile.emaDistMax;
      if (extremeOversold && priceConfirmsDown && (htf === "BEAR" || htf === "NEUTRAL")) {
        side = "SHORT";
        isStrongTrendExtension = true;
        details.push(`Strong trend extension SHORT (ADX ${adx.toFixed(0)} + RSI ${r[i].toFixed(0)} + ${distToEma.toFixed(1)}% from EMA)`);
      } else if (extremeOverbought && priceConfirmsUp && (htf === "BULL" || htf === "NEUTRAL")) {
        side = "LONG";
        isStrongTrendExtension = true;
        details.push(`Strong trend extension LONG (ADX ${adx.toFixed(0)} + RSI ${r[i].toFixed(0)} + ${distToEma.toFixed(1)}% from EMA)`);
      }
    }
  }

  if (side === "NONE" && (regime === "RANGE" || regime === "TRANSITION")) {
    const nearLowerWide = price <= bb.lower * 1.008;
    const nearUpperWide = price >= bb.upper * 0.992;
    const rsiLow = r[i] <= profile.rsiMin + 14;
    const rsiHigh = r[i] >= profile.rsiMax - 14;
    const sweepLong = sweep.bullishSweep || lowerWick(tf[i]) > 2 * candleBody(tf[i]);
    const sweepShort = sweep.bearishSweep || upperWick(tf[i]) > 2 * candleBody(tf[i]);
    const vwapMinPct = profile.allowMomentumContinuation ? SIGNAL_CONFIG.vwapDistMinPct * 0.5 : SIGNAL_CONFIG.vwapDistMinPct;

    if (nearLowerWide && rsiLow && (sweepLong || vwapDistPct <= -vwapMinPct)) {
      side = "LONG";
      isMeanReversion = true;
      details.push("Range mean-reversion LONG (BB lower + sweep)");
    } else if (nearUpperWide && rsiHigh && (sweepShort || vwapDistPct >= vwapMinPct)) {
      side = "SHORT";
      isMeanReversion = true;
      details.push("Range mean-reversion SHORT (BB upper + sweep)");
    }

    if (side === "NONE" && profile.allowMomentumContinuation) {
      const bbMid = (bb.upper + bb.lower) / 2;
      const nearBBLow = price < bbMid;
      const nearBBHigh = price > bbMid;
      if (nearBBLow && macdTurningUp && r[i] < 50) {
        side = "LONG";
        details.push("Range bounce LONG (below BB mid + MACD turn)");
      } else if (nearBBHigh && macdTurningDown && r[i] > 50) {
        side = "SHORT";
        details.push("Range fade SHORT (above BB mid + MACD turn)");
      }
    }

    if (side === "NONE" && profile.allowMomentumContinuation && volOk) {
      const emaOk = distToEma >= 0.2 && distToEma <= profile.emaDistMax;
      const htfAligned = htf === "BEAR" || htf === "BULL";
      const htfNeutral = htf === "NEUTRAL";
      if (emaOk) {
        const rsiShortHTF = r[i] >= profile.rsiMin && r[i] <= 46;
        const rsiLongHTF = r[i] >= 54 && r[i] <= profile.rsiMax;
        const rsiShortNeutral = r[i] >= profile.rsiMin && r[i] <= 38;
        const rsiLongNeutral = r[i] >= 62 && r[i] <= profile.rsiMax;
        const trendDown = price < ema20[i] && macdTurningDown &&
          ((htfAligned && htf === "BEAR" && rsiShortHTF) ||
           (htfNeutral && macdAccel && rsiShortNeutral && vspike[i] >= 0.8));
        const trendUp = price > ema20[i] && macdTurningUp &&
          ((htfAligned && htf === "BULL" && rsiLongHTF) ||
           (htfNeutral && macdAccel && rsiLongNeutral && vspike[i] >= 0.8));
        if (trendDown) {
          side = "SHORT";
          isRangeTrend = true;
          details.push(`Range trend SHORT (${htfNeutral ? "RSI extreme+vol+accel" : "HTF BEAR"} + EMA + MACD aligned)`);
        } else if (trendUp) {
          side = "LONG";
          isRangeTrend = true;
          details.push(`Range trend LONG (${htfNeutral ? "RSI extreme+vol+accel" : "HTF BULL"} + EMA + MACD aligned)`);
        }
      }
    }

    if (side === "NONE" && profile.allowMomentumContinuation && volOk && i >= 2) {
      const vwapArr = vwapRolling(tf, Math.min(288, tf.length));
      if (vwapArr[i] > 0 && vwapArr[i - 1] > 0) {
        const crossAboveVwap = price > vwapArr[i] && closes[i - 1] <= vwapArr[i - 1];
        const crossBelowVwap = price < vwapArr[i] && closes[i - 1] >= vwapArr[i - 1];
        if (crossAboveVwap && r[i] < 60 && (htf === "BULL" || htf === "NEUTRAL")) {
          side = "LONG";
          details.push("VWAP reversion LONG (cross above + vol)");
        } else if (crossBelowVwap && r[i] > 40 && (htf === "BEAR" || htf === "NEUTRAL")) {
          side = "SHORT";
          details.push("VWAP reversion SHORT (cross below + vol)");
        }
      }
    }

    if (side === "NONE" && profile.allowMomentumContinuation) {
      const rsiOversold = r[i] <= 35;
      const rsiOverbought = r[i] >= 65;
      // Extreme oversold dip in a BULL TREND: RSI has fallen below rsiMin while the
      // 1h/4h bias remains bullish.  MACD is not required to have ticked up yet —
      // a mean-reversion entry fires when the decline is at least not accelerating
      // (!macdTurningDown).  Tagged as isMeanReversion so (a) ATR-based stop/TP is
      // used and (b) the MACD-tick penalty is skipped (we intentionally enter before
      // MACD turns; the score floor then ensures quality gating).
      const extremeDipBull = r[i] <= profile.rsiMin && htf === "BULL" &&
        regime === "TREND" && !macdTurningDown && volOk;
      if (rsiOversold && (macdTurningUp || extremeDipBull) && (htf === "BULL" || htf === "NEUTRAL")) {
        side = "LONG";
        if (extremeDipBull && !macdTurningUp) {
          isMeanReversion = true;
          details.push(`RSI extreme dip LONG (RSI ${r[i].toFixed(0)}≤${profile.rsiMin} in BULL trend, MACD flat — mean-reversion)`);
        } else {
          details.push("RSI recovery LONG (oversold + MACD turn)");
        }
      } else if (rsiOverbought && macdTurningDown && (htf === "BEAR" || htf === "NEUTRAL")) {
        side = "SHORT";
        details.push("RSI reversal SHORT (overbought + MACD turn)");
      }
    }

    if (side === "NONE" && profile.allowMomentumContinuation && volOk && distToEma <= profile.emaDistMax) {
      const rsiFadeShort = r[i] >= 55 && r[i] <= profile.rsiMax && htf === "BEAR";
      const rsiFadeLong = r[i] <= 45 && r[i] >= profile.rsiMin && htf === "BULL";
      if (rsiFadeShort) {
        side = "SHORT";
        details.push(`Range HTF fade SHORT (RSI ${r[i].toFixed(0)} bounce in BEAR market)`);
      } else if (rsiFadeLong) {
        side = "LONG";
        details.push(`Range HTF fade LONG (RSI ${r[i].toFixed(0)} dip in BULL market)`);
      }
    }

    if (side === "NONE" && profile.allowMomentumContinuation && volOk && distToEma > profile.emaDistMax * 1.5) {
      const rsiOversoldDir = r[i] <= profile.rsiMin + 5;
      const rsiOverboughtDir = r[i] >= profile.rsiMax - 5;
      if (rsiOversoldDir && price < ema20[i] && (htf === "BEAR" || htf === "NEUTRAL")) {
        side = "SHORT";
        isStrongTrendExtension = true;
        details.push(`Range breakdown SHORT (RSI ${r[i].toFixed(0)} + ${distToEma.toFixed(1)}% below EMA — directional pressure)`);
      } else if (rsiOverboughtDir && price > ema20[i] && (htf === "BULL" || htf === "NEUTRAL")) {
        side = "LONG";
        isStrongTrendExtension = true;
        details.push(`Range breakout LONG (RSI ${r[i].toFixed(0)} + ${distToEma.toFixed(1)}% above EMA — directional pressure)`);
      }
    }
  }

  const macdTurn = side === "LONG" ? macdTurningUp : side === "SHORT" ? macdTurningDown : false;
  const macdAccelerating = macdTurn && macdAccel;
  const sweepOk = side === "LONG" ? sweep.bullishSweep : side === "SHORT" ? sweep.bearishSweep : false;

  return {
    side, distToEma, rsi: r[i], volMult: vspike[i],
    macdTurn, macdAccelerating, rsiDiverging: rsiDivergence, sweepOk, vwapDistPct, details,
    isStrongTrendExtension, isMeanReversion, isRangeTrend,
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

  const activeMode = configMode;
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

  const setup = findTradeSide(tf, htf, regime, profile, adxValue);
  let { side } = setup;
  const { distToEma, rsi, volMult, macdTurn, macdAccelerating, rsiDiverging, sweepOk, vwapDistPct, details, isStrongTrendExtension, isMeanReversion, isRangeTrend } = setup;
  reasons.push(`EMA dist ${distToEma.toFixed(2)}%, RSI ${rsi.toFixed(1)}, VWAP dist ${vwapDistPct.toFixed(2)}%`);
  reasons.push(...details);

  const highs = swingHighs(tf, 2, 2);
  const lows = swingLows(tf, 2, 2);

  let entry = price;
  let stop = price;
  let takeProfit = price;
  let rr = 0;

  if (side !== "NONE") {
    if (isStrongTrendExtension || isMeanReversion || isRangeTrend) {
      const atrVal = atr14[atr14.length - 1];
      const tpMult = isRangeTrend ? 2.5 : 3.0;
      if (side === "LONG") {
        stop = price - atrVal * 1.5;
        takeProfit = price + atrVal * tpMult;
      } else {
        stop = price + atrVal * 1.5;
        takeProfit = price - atrVal * tpMult;
      }
      entry = price;
      rr = computeRR(side, entry, stop, takeProfit);
    } else {
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
  }

  let { score, isExtreme } = calculateWeightedScore({
    adx: adxValue, htfBias: htf, proposedSide: side,
    emaDistance: distToEma, rsi, volMult,
    macdTurn, macdAccelerating, rsiDiverging, sweepOk, rr,
    vwapDistPct,
  }, profile);

  // ── NEW: Multi-tick MACD momentum confirmation ──
  // Single-tick MACD turns are noisy. Require 2+ consecutive ticks for
  // trend entries; single-tick entries get a -10 score penalty.
  // Exception: mean-reversion entries intentionally enter before MACD turns,
  // so the tick penalty is skipped — the score floor provides quality gating instead.
  if (side !== "NONE" && !isMeanReversion) {
    const hist = macdHistSeries(tf.map(c => c.c));
    const { longTicks, shortTicks } = macdMomentumTicks(hist);
    const requiredTicks = regime === "TREND" ? 2 : 1;
    const actualTicks = side === "LONG" ? longTicks : shortTicks;
    if (actualTicks < requiredTicks) {
      const penalty = regime === "TREND" ? 10 : 5;
      reasons.push(`MACD only ${actualTicks} tick(s) — weak momentum (-${penalty}pts)`);
      score = Math.max(0, score - penalty);
    } else if (actualTicks >= 3) {
      const bonus = Math.min(6, actualTicks - 1);
      reasons.push(`Strong MACD momentum: ${actualTicks} ticks (+${bonus}pts)`);
      score = Math.min(100, score + bonus);
    }
  }

  // ── NEW: Counter-trend penalty ──
  // Shorts in BULL HTF and Longs in BEAR HTF have historically lost most.
  if (side !== "NONE") {
    const ctPenalty = counterTrendPenalty(side, htf);
    if (ctPenalty > 0) {
      reasons.push(`Counter-trend ${side} vs HTF ${htf} (-${ctPenalty}pts)`);
      score = Math.max(0, score - ctPenalty);
    }
  }

  // ── Regime boundary uncertainty penalty ──
  // ADX near the trend/range boundary (15-22) — regime is uncertain.
  {
    const boundaryPenalty = regimeBoundaryPenalty(adxValue);
    if (boundaryPenalty > 0 && side !== "NONE") {
      reasons.push(`ADX ${adxValue.toFixed(1)} near regime boundary (-${boundaryPenalty}pts)`);
      score = Math.max(0, score - boundaryPenalty);
    }
  }

  // ── TRANSITION regime uncertainty penalty ──
  // TRANSITION (ADX 20-25) is the most ambiguous regime — not clearly trending,
  // not clearly ranging. Historically lower win rates here justify a -8pt penalty
  // on all entries to push TRANSITION signals toward strong signals only.
  if (regime === "TRANSITION" && side !== "NONE") {
    const transitionPenalty = 8;
    reasons.push(`TRANSITION regime — directional uncertainty (-${transitionPenalty}pts)`);
    score = Math.max(0, score - transitionPenalty);
  }

  // ── Score floor for structural setups ──
  // Only apply the floor if the setup is genuinely strong AND HTF-aligned.
  // Previously applied to any setup, which propped up low-quality entries.
  // Now: require HTF alignment OR score within 3pts of the floor to qualify.
  if ((isStrongTrendExtension || isMeanReversion || isRangeTrend) && rr >= 0.5 && volMult >= profile.volStrong) {
    const floor = profile.weakScore + 3;
    const htfAlignedForFloor = (side === "LONG" && htf === "BULL") || (side === "SHORT" && htf === "BEAR");
    if (score < floor && (htfAlignedForFloor || score >= floor - 3)) {
      const label = isMeanReversion ? "mean-reversion" : isRangeTrend ? "range trend HTF" : "strong trend ext";
      reasons.push(`Score floored ${score}→${floor} (${label}: HTF-aligned, RR ${rr.toFixed(2)}, strong vol ${volMult.toFixed(1)}x)`);
      score = floor;
    }
  }

  const classification = classifySignal(score, profile);
  const sizeMult = scoreSizeMultiplier(score, activeMode);

  if (side !== "NONE") {
    const isAtrBased = isStrongTrendExtension || isMeanReversion || isRangeTrend;
    const minRR = isStrongTrendExtension ? 0.3 : isAtrBased ? profile.minRrRange * 0.9 : (regime === "RANGE" ? profile.minRrRange : profile.minRrTrend);
    if (rr < minRR) {
      reasons.push(`RR ${rr.toFixed(2)} < ${minRR}${isStrongTrendExtension ? " (trend ext)" : ""} — rejected`);
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
