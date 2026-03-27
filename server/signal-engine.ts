import {
  emaSeries,
  adx as adxFn,
} from "../shared/indicators";

export type SignalSide = "LONG" | "SHORT" | "NONE";
export type Regime = "TREND" | "RANGE" | "TRANSITION";
export type SignalMode = "AGGRESSIVE" | "PRECISION" | "AUTO" | "NOW";

export interface ScoreBreakdown {
  ema: number;      // 0-25: EMA alignment + slope + EMA9/21 cross
  rsi: number;      // 0-20: RSI positioning and momentum
  macd: number;     // 0-25: MACD direction + momentum ticks
  volume: number;   // 0-15: Volume vs 20-period average
  htf: number;      // 0-15: Higher-timeframe bias alignment
  penalty: number;  // Penalties (TRANSITION, counter-trend, etc.)
  sentiment?: number;   // ±8: SentimentFlow crowd intelligence modifier
  btcOverlay?: number;  // ±10: BTC Correlation Overlay modifier
  total: number;    // Final clamped 0-100
}

/** Multi-timeframe BTC momentum context from BTC Correlation Overlay Engine. */
export interface BtcOverlayContext {
  btcPrice: number;
  change5m: number;         // % price change over last 5 min
  change15m: number;        // % price change over last 15 min
  change60m: number;        // % price change over last 60 min
  direction5m: "UP" | "DOWN" | "FLAT";
  direction15m: "UP" | "DOWN" | "FLAT";
  direction60m: "UP" | "DOWN" | "FLAT";
  bias: "bull" | "bear" | "neutral";
  strength: number;         // 0-100: magnitude + consistency of BTC momentum
  agreementScore: number;   // 0-100: % of timeframes agreeing with bias direction
  usable: boolean;
  dataAge: number;          // ms since last successful Pyth poll
  note: string;
}

/** Pure function: compute ±10pt BTC correlation adjustment for a given trade side. */
export function computeBtcOverlayAdjustment(
  side: "LONG" | "SHORT",
  ctx: BtcOverlayContext,
): number {
  if (!ctx.usable || ctx.bias === "neutral" || ctx.agreementScore < 33) return 0;
  if (ctx.dataAge > 3 * 60_000) return 0; // Stale — no influence

  const directionMatch = (side === "LONG" && ctx.bias === "bull") || (side === "SHORT" && ctx.bias === "bear");
  const s = ctx.strength;

  // All 3 timeframes aligned
  if (ctx.agreementScore >= 90) {
    return directionMatch
      ? Math.min(10, Math.round(2 + s / 10))    // Up to +10pt
      : -Math.min(8, Math.round(1 + s / 12));   // Down to -8pt
  }

  // 2/3 timeframes aligned
  if (ctx.agreementScore >= 60) {
    return directionMatch
      ? Math.min(6, Math.round(1 + s / 15))     // Up to +6pt
      : -Math.min(5, Math.round(s / 18));        // Down to -5pt
  }

  // 1/3 weak signal — minimal nudge
  return directionMatch ? 2 : -1;
}

/** Crowd-positioning context from SentimentFlowEngine — passed as optional signal modifier. */
export interface SentimentContext {
  tapeScore: number;           // -100 to +100 (positive = buy-heavy tape)
  crowdingScore: number;       // 0-100 (higher = more one-sided crowd)
  fundingPressureScore: number;// -100 to +100 (positive = longs pay)
  oiExpansionScore: number;    // -100 to +100 (positive = OI expanding with longs)
  confidence: number;          // 0-100 (reflects data freshness + completeness)
  regime: "momentum_continuation" | "exhaustion" | "contrarian_squeeze" | "neutral";
  dataAge: number;             // ms since last successful poll
  note: string;
}

/** Pure function: compute ±8pt score modifier for a given trade side based on crowd data. */
export function computeSentimentAdjustment(
  side: "LONG" | "SHORT",
  ctx: SentimentContext,
): number {
  if (ctx.confidence < 20) return 0;
  if (ctx.dataAge > 10 * 60_000) return 0; // Stale data — no influence

  const direction = side === "LONG" ? 1 : -1;
  let adj = 0;

  // Tape alignment: does recent order flow agree with trade direction?
  const tapeAlignment = ctx.tapeScore * direction;
  if (tapeAlignment > 30) adj += 5;
  else if (tapeAlignment > 15) adj += 3;
  else if (tapeAlignment > 5) adj += 1;
  else if (tapeAlignment < -30) adj -= 4;
  else if (tapeAlignment < -15) adj -= 2;

  // Crowding dynamics: joining an overcrowded side is risky; going contrarian gets a bonus
  if (ctx.crowdingScore > 75) {
    if (tapeAlignment > 0) adj -= 3;  // Overcrowded in our direction
    else adj += 3;                     // Contrarian vs overcrowded side
  } else if (ctx.crowdingScore > 60 && tapeAlignment > 0) {
    adj -= 1; // Moderately crowded — slight caution
  }

  // Funding pressure: being paid to hold our position is good, paying drains EV
  const fundingFavor = ctx.fundingPressureScore * direction;
  if (fundingFavor < -20) adj += 2;    // Funding pays us
  else if (fundingFavor > 35) adj -= 2; // Funding drains us

  // Regime modifiers
  if (ctx.regime === "exhaustion" && tapeAlignment > 0) adj -= 3;
  if (ctx.regime === "contrarian_squeeze" && tapeAlignment < 0) adj += 2;
  if (ctx.regime === "momentum_continuation" && tapeAlignment > 0) adj += 1;

  return Math.max(-8, Math.min(8, adj));
}

export interface TradeSignal {
  symbol: string;
  side: SignalSide;
  regime: Regime;
  activeMode: SignalMode;
  timeframe: string;
  htfBias: "BULL" | "BEAR" | "NEUTRAL";
  score: number;
  scoreBreakdown: ScoreBreakdown;
  threshold: number;
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
  threshold: number;
  label: string;
  description: string;
};

export const MODE_PROFILES: Record<SignalMode, ModeProfile> = {
  NOW: {
    threshold: 42,
    label: "NOW",
    description: "Immediate trading — fires at good-quality signal",
  },
  AGGRESSIVE: {
    threshold: 48,
    label: "AGGRESSIVE",
    description: "High-frequency — fires on moderate-quality signals",
  },
  AUTO: {
    threshold: 55,
    label: "AUTO",
    description: "Balanced — fires on good-quality signals",
  },
  PRECISION: {
    threshold: 70,
    label: "PRECISION",
    description: "High-quality only — fires on strong signals",
  },
};

// ── Helper: Simple Moving Average series ──────────────────────────────────────

function smaSeries(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out[i] = values[i]; continue; }
    let sum = 0;
    for (let k = i - period + 1; k <= i; k++) sum += values[k];
    out[i] = sum / period;
  }
  return out;
}

// ── Helper: Bollinger Bands ───────────────────────────────────────────────────

function bollingerBands(closes: number[], period = 20, mult = 2): { upper: number[]; lower: number[]; mid: number[] } {
  const mid = smaSeries(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { upper.push(closes[i]); lower.push(closes[i]); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    upper.push(mean + mult * std);
    lower.push(mean - mult * std);
  }
  return { upper, lower, mid };
}

// ── Helper: RSI series ────────────────────────────────────────────────────────

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

// ── Helper: MACD histogram series ────────────────────────────────────────────

function macdHistSeries(closes: number[], fast = 12, slow = 26, signal = 9): number[] {
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) => fastE[i] - slowE[i]);
  const sig = emaSeries(macdLine, signal);
  return macdLine.map((v, i) => v - sig[i]);
}

// ── Helper: ATR series ────────────────────────────────────────────────────────

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

// ── Helper: Volume spike ratio ────────────────────────────────────────────────

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

// ── Helper: MACD consecutive ticks in one direction ──────────────────────────

function macdConsecutiveTicks(hist: number[], direction: "up" | "down"): number {
  const i = hist.length - 1;
  let count = 0;
  for (let k = i; k >= 1; k--) {
    if (direction === "up" && hist[k] > hist[k - 1]) count++;
    else if (direction === "down" && hist[k] < hist[k - 1]) count++;
    else break;
  }
  return count;
}

// ── Helper: Did MACD histogram cross zero recently? ──────────────────────────

function macdRecentCross(hist: number[], direction: "up" | "down", lookback = 3): boolean {
  const i = hist.length - 1;
  for (let k = Math.max(1, i - lookback + 1); k <= i; k++) {
    if (direction === "up" && hist[k - 1] < 0 && hist[k] >= 0) return true;
    if (direction === "down" && hist[k - 1] > 0 && hist[k] <= 0) return true;
  }
  return false;
}

// ── Higher-timeframe bias (4-vote system) ─────────────────────────────────────

function htfBias(candles: MarketCandle[]): "BULL" | "BEAR" | "NEUTRAL" {
  if (candles.length < 51) return "NEUTRAL";
  const closes = candles.map(c => c.c);
  const ema50 = emaSeries(closes, 50);
  const rsiArr = rsiSeries(closes, 14);
  const hist = macdHistSeries(closes);
  const i = closes.length - 1;
  const ema50Slope = i >= 5 ? ema50[i] - ema50[i - 5] : 0;

  const bullVotes =
    (closes[i] > ema50[i] ? 1 : 0) +
    (ema50Slope > 0 ? 1 : 0) +
    (hist[i] > 0 ? 1 : 0) +
    (rsiArr[i] > 50 ? 1 : 0);
  const bearVotes =
    (closes[i] < ema50[i] ? 1 : 0) +
    (ema50Slope < 0 ? 1 : 0) +
    (hist[i] < 0 ? 1 : 0) +
    (rsiArr[i] < 50 ? 1 : 0);

  if (bullVotes >= 3) return "BULL";
  if (bearVotes >= 3) return "BEAR";
  return "NEUTRAL";
}

function combinedHTFBias(tf1h: MarketCandle[], tf4h: MarketCandle[]): "BULL" | "BEAR" | "NEUTRAL" {
  const b1 = htfBias(tf1h);
  const b4 = htfBias(tf4h);
  if (b1 === b4) return b1;
  if (b1 !== "NEUTRAL" && b4 === "NEUTRAL") return b1;
  if (b4 !== "NEUTRAL" && b1 === "NEUTRAL") return b4;
  return "NEUTRAL";
}

// ── Regime detection ──────────────────────────────────────────────────────────

function classifyRegime(adxValue: number): Regime {
  if (adxValue >= 25) return "TREND";
  if (adxValue < 20) return "RANGE";
  return "TRANSITION";
}

// ── Score: EMA alignment (0-25) ───────────────────────────────────────────────
// Measures how well price, EMA trend, and short-term cross support the trade side.

function scoreEMA(
  side: "LONG" | "SHORT",
  price: number,
  ema9: number,
  ema20: number,
  ema21: number,
  ema20Slope: number
): { score: number; reasons: string[] } {
  let s = 0;
  const reasons: string[] = [];

  if (side === "LONG") {
    if (price > ema20) { s += 12; reasons.push("Price above EMA20 (+12)"); }
    else reasons.push("Price below EMA20");
    if (ema20Slope > 0) { s += 8; reasons.push("EMA20 rising (+8)"); }
    else reasons.push("EMA20 flat/falling");
    if (ema9 > ema21) { s += 5; reasons.push("EMA9 > EMA21 bullish (+5)"); }
    else reasons.push("EMA9 < EMA21");
  } else {
    if (price < ema20) { s += 12; reasons.push("Price below EMA20 (+12)"); }
    else reasons.push("Price above EMA20");
    if (ema20Slope < 0) { s += 8; reasons.push("EMA20 falling (+8)"); }
    else reasons.push("EMA20 flat/rising");
    if (ema9 < ema21) { s += 5; reasons.push("EMA9 < EMA21 bearish (+5)"); }
    else reasons.push("EMA9 > EMA21");
  }

  return { score: Math.min(s, 25), reasons };
}

// ── Score: RSI quality (0-20) ─────────────────────────────────────────────────
// Measures RSI position, momentum direction, and absence of extremes.

function scoreRSI(
  side: "LONG" | "SHORT",
  rsi: number,
  rsiChange: number
): { score: number; reasons: string[] } {
  let s = 0;
  const reasons: string[] = [];

  if (side === "LONG") {
    if (rsi >= 35 && rsi <= 65) { s += 10; reasons.push(`RSI ${rsi.toFixed(0)} — ideal zone (+10)`); }
    else if (rsi >= 25 && rsi < 35) { s += 5; reasons.push(`RSI ${rsi.toFixed(0)} — oversold, bounce zone (+5)`); }
    else if (rsi > 65 && rsi <= 72) { s += 5; reasons.push(`RSI ${rsi.toFixed(0)} — bullish momentum (+5)`); }
    else { reasons.push(`RSI ${rsi.toFixed(0)} — extreme zone`); }
    if (rsiChange > 0) { s += 6; reasons.push("RSI rising — bullish momentum (+6)"); }
    if (rsi <= 70) { s += 4; reasons.push("RSI not overbought (+4)"); }
  } else {
    if (rsi >= 35 && rsi <= 65) { s += 10; reasons.push(`RSI ${rsi.toFixed(0)} — ideal zone (+10)`); }
    else if (rsi > 65 && rsi <= 75) { s += 5; reasons.push(`RSI ${rsi.toFixed(0)} — overbought, short zone (+5)`); }
    else if (rsi >= 28 && rsi < 35) { s += 5; reasons.push(`RSI ${rsi.toFixed(0)} — bearish momentum (+5)`); }
    else { reasons.push(`RSI ${rsi.toFixed(0)} — extreme zone`); }
    if (rsiChange < 0) { s += 6; reasons.push("RSI falling — bearish momentum (+6)"); }
    if (rsi >= 30) { s += 4; reasons.push("RSI not oversold (+4)"); }
  }

  return { score: Math.min(s, 20), reasons };
}

// ── Score: MACD momentum (0-25) ───────────────────────────────────────────────
// Measures MACD histogram direction, multi-tick momentum, and zero-line crossing.

function scoreMACDComponent(
  side: "LONG" | "SHORT",
  hist: number[],
): { score: number; reasons: string[] } {
  const i = hist.length - 1;
  let s = 0;
  const reasons: string[] = [];

  if (side === "LONG") {
    if (hist[i] > 0) { s += 12; reasons.push("MACD histogram positive (+12)"); }
    else reasons.push("MACD histogram negative");
    if (i >= 1 && hist[i] > hist[i - 1]) { s += 5; reasons.push("MACD rising this bar (+5)"); }
    const ticks = macdConsecutiveTicks(hist, "up");
    if (ticks >= 2) { s += 5; reasons.push(`MACD ${ticks} consecutive rising ticks (+5)`); }
    if (macdRecentCross(hist, "up")) { s += 3; reasons.push("MACD crossed above zero (+3)"); }
  } else {
    if (hist[i] < 0) { s += 12; reasons.push("MACD histogram negative (+12)"); }
    else reasons.push("MACD histogram positive");
    if (i >= 1 && hist[i] < hist[i - 1]) { s += 5; reasons.push("MACD falling this bar (+5)"); }
    const ticks = macdConsecutiveTicks(hist, "down");
    if (ticks >= 2) { s += 5; reasons.push(`MACD ${ticks} consecutive falling ticks (+5)`); }
    if (macdRecentCross(hist, "down")) { s += 3; reasons.push("MACD crossed below zero (+3)"); }
  }

  return { score: Math.min(s, 25), reasons };
}

// ── Score: Volume (0-15) ──────────────────────────────────────────────────────
// Measures volume confirmation vs 20-period average.

function scoreVolumeComponent(volRatio: number): { score: number; reasons: string[] } {
  let s = 0;
  const reasons: string[] = [];

  if (volRatio >= 0.8) { s += 7; reasons.push(`Volume ${volRatio.toFixed(2)}× avg (+7)`); }
  else reasons.push(`Volume ${volRatio.toFixed(2)}× avg — low`);
  if (volRatio >= 1.3) { s += 5; reasons.push("Volume spike (+5)"); }
  if (volRatio >= 1.8) { s += 3; reasons.push("Strong volume surge (+3)"); }

  return { score: Math.min(s, 15), reasons };
}

// ── Score: HTF alignment (0-15) ───────────────────────────────────────────────
// Measures how well the higher-timeframe trend aligns with the proposed trade.

function scoreHTFComponent(
  side: "LONG" | "SHORT",
  htf: "BULL" | "BEAR" | "NEUTRAL"
): { score: number; reasons: string[] } {
  if (side === "LONG") {
    if (htf === "BULL") return { score: 15, reasons: ["HTF BULL — 1h+4h bullish (+15)"] };
    if (htf === "NEUTRAL") return { score: 5, reasons: ["HTF neutral — no clear trend (+5)"] };
    return { score: 0, reasons: ["HTF BEAR — counter-trend long (0)"] };
  } else {
    if (htf === "BEAR") return { score: 15, reasons: ["HTF BEAR — 1h+4h bearish (+15)"] };
    if (htf === "NEUTRAL") return { score: 5, reasons: ["HTF neutral — no clear trend (+5)"] };
    return { score: 0, reasons: ["HTF BULL — counter-trend short (0)"] };
  }
}

// ── Score: Bollinger Band position (0-12, RANGE regime only) ─────────────────
// Measures how close price is to BB extremes — key for mean-reversion entries.

function scoreBBComponent(
  side: "LONG" | "SHORT",
  price: number,
  bbUpper: number,
  bbLower: number,
): { score: number; reasons: string[] } {
  const bbWidth = bbUpper - bbLower;
  if (bbWidth <= 0) return { score: 0, reasons: [] };

  const positionInBand = (price - bbLower) / bbWidth; // 0 = at lower BB, 1 = at upper BB

  if (side === "LONG") {
    if (positionInBand <= 0.05) return { score: 12, reasons: [`At/below lower BB — extreme oversold (+12)`] };
    if (positionInBand <= 0.20) return { score: 9, reasons: [`Near lower BB (${(positionInBand * 100).toFixed(0)}% into band) (+9)`] };
    if (positionInBand <= 0.35) return { score: 5, reasons: [`Below BB midpoint (+5)`] };
    if (positionInBand >= 0.85) return { score: 0, reasons: [`Near upper BB — adverse for LONG mean-reversion`] };
    return { score: 2, reasons: [] };
  } else {
    const fromTop = 1 - positionInBand;
    if (fromTop <= 0.05) return { score: 12, reasons: [`At/above upper BB — extreme overbought (+12)`] };
    if (fromTop <= 0.20) return { score: 9, reasons: [`Near upper BB (${(fromTop * 100).toFixed(0)}% from top) (+9)`] };
    if (fromTop <= 0.35) return { score: 5, reasons: [`Above BB midpoint (+5)`] };
    if (positionInBand <= 0.15) return { score: 0, reasons: [`Near lower BB — adverse for SHORT mean-reversion`] };
    return { score: 2, reasons: [] };
  }
}

// ── RANGE regime: mean-reversion side selection ───────────────────────────────
// In ranging markets (ADX < 20), look for oversold/overbought RSI + BB extremes
// as entry signals instead of requiring trend alignment.

function selectSideRangeMeanReversion(
  rsi: number,
  price: number,
  bbUpper: number,
  bbLower: number,
  htf: "BULL" | "BEAR" | "NEUTRAL",
): SignalSide {
  const bbWidth = bbUpper - bbLower;
  if (bbWidth <= 0) return "NONE";

  const posInBand = (price - bbLower) / bbWidth;
  const nearLowerBB = posInBand <= 0.25;
  const nearUpperBB = posInBand >= 0.75;
  const veryNearLowerBB = posInBand <= 0.10;
  const veryNearUpperBB = posInBand >= 0.90;
  const oversold = rsi < 37;
  const veryOversold = rsi < 30;
  const overbought = rsi > 63;
  const veryOverbought = rsi > 70;

  // Strong bear HTF: only allow very oversold extreme bounces
  if (htf === "BEAR") {
    if (veryOversold && veryNearLowerBB) return "LONG";
    return "NONE";
  }
  // Strong bull HTF: only allow very overbought extreme shorts
  if (htf === "BULL") {
    if (veryOverbought && veryNearUpperBB) return "SHORT";
    return "NONE";
  }

  // Neutral HTF: allow broader RSI + BB extreme signals
  if (oversold || nearLowerBB) return "LONG";
  if (overbought || nearUpperBB) return "SHORT";

  return "NONE";
}

// ── Side selection ────────────────────────────────────────────────────────────
// Uses HTF bias, MACD direction, and price vs EMA20 to pick trade side.
// Rules:
//   LONG: HTF BULL or NEUTRAL, and (MACD rising OR price > EMA20), prefer both
//   SHORT: HTF BEAR or NEUTRAL, and (MACD falling OR price < EMA20), prefer both
//   Counter-trend (LONG vs BEAR, SHORT vs BULL) → NONE

function selectSide(
  htf: "BULL" | "BEAR" | "NEUTRAL",
  macdHist: number[],
  price: number,
  ema20: number
): SignalSide {
  const i = macdHist.length - 1;
  const macdRising = i >= 1 && macdHist[i] > macdHist[i - 1];
  const macdFalling = i >= 1 && macdHist[i] < macdHist[i - 1];
  const macdPositive = macdHist[i] > 0;
  const macdNegative = macdHist[i] < 0;
  const priceAbove = price > ema20;
  const priceBelow = price < ema20;

  // Block counter-trend trades — both momentum and price must confirm
  if (htf === "BULL" && priceBelow && macdFalling) return "NONE";
  if (htf === "BEAR" && priceAbove && macdRising) return "NONE";

  // HTF strongly bullish: prefer LONG, require MACD histogram positive for confidence
  if (htf === "BULL") {
    if ((macdRising || priceAbove) && macdPositive) return "LONG";
    if (macdRising && priceAbove) return "LONG"; // both agree even if slightly negative
    return "NONE";
  }

  // HTF strongly bearish: prefer SHORT — require MACD histogram negative (zero-line filter)
  if (htf === "BEAR") {
    if ((macdFalling || priceBelow) && macdNegative) return "SHORT";
    return "NONE";
  }

  // HTF neutral: require BOTH MACD direction AND price AND histogram on correct side of zero
  if (htf === "NEUTRAL") {
    if (macdRising && priceAbove && macdPositive) return "LONG";
    if (macdFalling && priceBelow && macdNegative) return "SHORT";
    return "NONE";
  }

  return "NONE";
}

// ── Main signal generator ─────────────────────────────────────────────────────

export function generateSignal(md: MultiTFData, configMode: SignalMode = "AUTO", sentimentCtx?: SentimentContext, btcCtx?: BtcOverlayContext): TradeSignal {
  const symbol = "SUI-USDC";
  const tf = md.tf5m;
  const price = md.markPrice;
  const activeMode = configMode;
  const profile = MODE_PROFILES[activeMode];
  const threshold = profile.threshold;

  const emptyBreakdown: ScoreBreakdown = { ema: 0, rsi: 0, macd: 0, volume: 0, htf: 0, penalty: 0, total: 0 };

  if (tf.length < 50) {
    return {
      symbol, side: "NONE", regime: "TRANSITION", activeMode,
      timeframe: "5m", htfBias: "NEUTRAL",
      score: 0, scoreBreakdown: emptyBreakdown, threshold,
      reasons: ["Insufficient data — waiting for candles"],
      entry: price, stop: price, takeProfit: price,
      rr: 0, sizeMultiplier: 0, validUntilMs: Date.now() + 30_000,
    };
  }

  const closes = tf.map(c => c.c);
  const i = closes.length - 1;

  // Indicators
  const ema9Arr = emaSeries(closes, 9);
  const ema20Arr = emaSeries(closes, 20);
  const ema21Arr = emaSeries(closes, 21);
  const ema50Arr = emaSeries(closes, 50);
  const ema9 = ema9Arr[i];
  const ema20 = ema20Arr[i];
  const ema21 = ema21Arr[i];
  const ema20Slope = i >= 5 ? ema20Arr[i] - ema20Arr[i - 5] : 0;

  const rsiArr = rsiSeries(closes, 14);
  const rsi = rsiArr[i];
  const rsiChange = i >= 3 ? rsiArr[i] - rsiArr[i - 3] : 0;

  const histArr = macdHistSeries(closes);

  const volSpikes = volumeSpikeRatio(tf, 20);
  const volRatio = volSpikes[i];

  const atrArr = atrSeries(tf, 14);
  const atrVal = atrArr[i];

  const adxValue = tf.length >= 30
    ? adxFn(tf.map(c => c.h), tf.map(c => c.l), closes, 14)
    : 20;

  const regime = classifyRegime(adxValue);
  const htf = combinedHTFBias(md.tf1h, md.tf4h);

  // Bollinger Bands (20-period SMA, 2σ) for RANGE regime mean-reversion entries
  const bbData = bollingerBands(closes, 20, 2);
  const bbUpper = bbData.upper[i];
  const bbLower = bbData.lower[i];

  // ATR volatility gate: if market is too quiet relative to price, signals are noise
  // Minimum 0.08% of price in ATR to warrant a trade
  const atrPct = price > 0 ? atrVal / price : 0;
  if (atrPct > 0 && atrPct < 0.0008) {
    return {
      symbol, side: "NONE", regime, activeMode, timeframe: "5m", htfBias: htf,
      score: 0, scoreBreakdown: { ema: 0, rsi: 0, macd: 0, volume: 0, htf: 0, penalty: 0, total: 0 }, threshold,
      reasons: [`Market too quiet (ATR ${(atrPct * 100).toFixed(3)}% < 0.08%) — waiting for volatility`],
      entry: price, stop: price, takeProfit: price,
      rr: 0, sizeMultiplier: 0, validUntilMs: Date.now() + 30_000,
    };
  }

  // Determine trade side
  // RANGE regime: try mean-reversion (RSI extremes + BB position) in addition to trend
  const trendSide = selectSide(htf, histArr, price, ema20);
  let side: SignalSide = trendSide;
  let isRangeMeanReversion = false;

  if (regime === "RANGE" && trendSide === "NONE") {
    const rangeSide = selectSideRangeMeanReversion(rsi, price, bbUpper, bbLower, htf);
    if (rangeSide !== "NONE") {
      side = rangeSide;
      isRangeMeanReversion = true;
    }
  }

  // Build base reasons
  const bbWidth = bbUpper - bbLower;
  const bbPct = bbWidth > 0 ? ((price - bbLower) / bbWidth * 100).toFixed(0) : "N/A";
  const baseReasons: string[] = [
    `${regime} regime (ADX ${adxValue.toFixed(1)}) | HTF ${htf} | Mode: ${profile.label}`,
    `EMA20 $${ema20.toFixed(4)} | RSI ${rsi.toFixed(1)} | BB pos ${bbPct}% | Vol ${volRatio.toFixed(2)}×`,
  ];

  if (side === "NONE") {
    // Compute approximate score to show progress in UI
    const longEma = scoreEMA("LONG", price, ema9, ema20, ema21, ema20Slope).score;
    const shortEma = scoreEMA("SHORT", price, ema9, ema20, ema21, ema20Slope).score;
    const candidateSide: "LONG" | "SHORT" = longEma >= shortEma ? "LONG" : "SHORT";
    const emaSc = Math.max(longEma, shortEma);
    const rsiSc = scoreRSI(candidateSide, rsi, rsiChange).score;
    const macdSc = scoreMACDComponent(candidateSide, histArr).score;
    const volSc = scoreVolumeComponent(volRatio).score;
    const htfSc = scoreHTFComponent(candidateSide, htf).score;
    // In RANGE regime, add BB bonus to show potential score
    const rangeBbSc = regime === "RANGE" ? scoreBBComponent(candidateSide, price, bbUpper, bbLower).score : 0;
    const approxTotal = Math.min(100, emaSc + rsiSc + macdSc + volSc + htfSc + rangeBbSc);
    const bd: ScoreBreakdown = { ema: emaSc, rsi: rsiSc, macd: macdSc, volume: volSc, htf: htfSc, penalty: 0, total: approxTotal };

    const reasons = [...baseReasons];
    if (regime === "RANGE") reasons.push(`RANGE regime — need RSI<37 or BB extreme for mean-reversion entry (score ${approxTotal})`);
    else if (htf === "NEUTRAL") reasons.push("HTF neutral — 1h and 4h have no clear direction. Waiting for trend to develop.");
    else if (htf === "BULL" && price < ema20) reasons.push("HTF bullish but price below EMA20 and MACD falling — waiting for confirmation.");
    else if (htf === "BEAR" && price > ema20) reasons.push("HTF bearish but price above EMA20 and MACD rising — waiting for confirmation.");
    else reasons.push(`No clear directional signal — score ${approxTotal}, need ${threshold}+`);

    return {
      symbol, side: "NONE", regime, activeMode, timeframe: "5m", htfBias: htf,
      score: approxTotal, scoreBreakdown: bd, threshold,
      reasons, entry: price, stop: price, takeProfit: price,
      rr: 0, sizeMultiplier: 0, validUntilMs: Date.now() + 30_000,
    };
  }

  // Score each component for the chosen side
  const emaResult = scoreEMA(side, price, ema9, ema20, ema21, ema20Slope);
  const rsiResult = scoreRSI(side, rsi, rsiChange);
  const macdResult = scoreMACDComponent(side, histArr);
  const volResult = scoreVolumeComponent(volRatio);
  const htfResult = scoreHTFComponent(side, htf);

  const rawTotal = emaResult.score + rsiResult.score + macdResult.score + volResult.score + htfResult.score;

  // Regime-specific bonus adjustments
  let regimeBonus = 0;
  const regimeBonusReasons: string[] = [];

  if (regime === "RANGE") {
    // Bollinger Band position is the primary RANGE regime entry quality signal
    const bbResult = scoreBBComponent(side, price, bbUpper, bbLower);
    regimeBonus += bbResult.score;
    regimeBonusReasons.push(...bbResult.reasons);

    // RSI extremes are highly informative in range markets (mean-reversion)
    if (side === "LONG") {
      if (rsi < 30) { regimeBonus += 8; regimeBonusReasons.push(`RSI ${rsi.toFixed(0)} extreme oversold in RANGE (+8)`); }
      else if (rsi < 37) { regimeBonus += 4; regimeBonusReasons.push(`RSI ${rsi.toFixed(0)} oversold in RANGE (+4)`); }
    } else {
      if (rsi > 70) { regimeBonus += 8; regimeBonusReasons.push(`RSI ${rsi.toFixed(0)} extreme overbought in RANGE (+8)`); }
      else if (rsi > 63) { regimeBonus += 4; regimeBonusReasons.push(`RSI ${rsi.toFixed(0)} overbought in RANGE (+4)`); }
    }

    // In RANGE regime, NEUTRAL HTF penalty is waived — no trend needed for mean-reversion
    if (htf === "NEUTRAL") {
      regimeBonus += 4; // partially offset the neutral penalties applied below
      regimeBonusReasons.push("RANGE + NEUTRAL HTF: mean-reversion mode, trend not required (+4)");
    }

    if (isRangeMeanReversion) {
      regimeBonusReasons.push(`Mean-reversion entry in RANGE (RSI ${rsi.toFixed(0)}, BB ${bbPct}%)`);
    }
  }

  // Penalties
  let penalty = 0;
  const penaltyReasons: string[] = [];
  if (regime === "TRANSITION") {
    penalty += 8;
    penaltyReasons.push("TRANSITION regime — ADX ambiguous (-8)");
  }
  // Counter-trend penalty: SHORT in NEUTRAL HTF adds friction (requires stronger signal)
  // Reduced in RANGE regime where mean-reversion is valid
  const neutralPenaltyShort = regime === "RANGE" ? 2 : 5;
  const neutralPenaltyLong = regime === "RANGE" ? 1 : 3;
  if (side === "SHORT" && htf === "NEUTRAL") {
    penalty += neutralPenaltyShort;
    penaltyReasons.push(`SHORT in NEUTRAL HTF (-${neutralPenaltyShort})`);
  }
  if (side === "LONG" && htf === "NEUTRAL") {
    penalty += neutralPenaltyLong;
    penaltyReasons.push(`LONG in NEUTRAL HTF (-${neutralPenaltyLong})`);
  }

  // SentimentFlow modifier — ±8pt crowd intelligence adjustment
  let sentimentAdj = 0;
  if (sentimentCtx && side !== "NONE") {
    sentimentAdj = computeSentimentAdjustment(side as "LONG" | "SHORT", sentimentCtx);
  }

  // BTC Correlation Overlay modifier — ±10pt BTC momentum alignment
  let btcOverlayAdj = 0;
  if (btcCtx && side !== "NONE") {
    btcOverlayAdj = computeBtcOverlayAdjustment(side as "LONG" | "SHORT", btcCtx);
  }

  const finalScore = Math.max(0, Math.min(100, rawTotal + regimeBonus - penalty + sentimentAdj + btcOverlayAdj));

  // In RANGE regime, lower the effective threshold by 5 — mean-reversion signals
  // are structurally harder to score high because trend components are neutral/inverted.
  const effectiveThreshold = regime === "RANGE" ? Math.max(threshold - 5, 38) : threshold;
  const bd: ScoreBreakdown = {
    ema: emaResult.score,
    rsi: rsiResult.score,
    macd: macdResult.score,
    volume: volResult.score,
    htf: htfResult.score,
    penalty,
    sentiment: sentimentAdj,
    btcOverlay: btcOverlayAdj,
    total: finalScore,
  };

  // Build detailed reasons for UI display
  const sentimentNote = sentimentCtx && sentimentAdj !== 0
    ? `SentimentFlow: ${sentimentAdj > 0 ? "+" : ""}${sentimentAdj}pt (crowd=${sentimentCtx.crowdingScore} tape=${sentimentCtx.tapeScore.toFixed(0)} regime=${sentimentCtx.regime})`
    : null;
  const btcNote = btcCtx && btcOverlayAdj !== 0
    ? `BTC Overlay: ${btcOverlayAdj > 0 ? "+" : ""}${btcOverlayAdj}pt (bias=${btcCtx.bias} str=${btcCtx.strength} agree=${btcCtx.agreementScore.toFixed(0)}%)`
    : null;
  const reasons: string[] = [
    ...baseReasons,
    `Signal direction: ${side} | Score ${finalScore}/100 (need ${effectiveThreshold}+${regime === "RANGE" ? " [RANGE -5]" : ""})`,
    ...emaResult.reasons.slice(0, 2),
    ...rsiResult.reasons.slice(0, 1),
    ...macdResult.reasons.slice(0, 1),
    ...volResult.reasons.slice(0, 1),
    ...htfResult.reasons,
    ...regimeBonusReasons.slice(0, 2),
    ...penaltyReasons,
    ...(sentimentNote ? [sentimentNote] : []),
    ...(btcNote ? [btcNote] : []),
  ];

  // Check effective threshold (RANGE regime uses lower threshold for mean-reversion)
  if (finalScore < effectiveThreshold) {
    reasons.push(`Score ${finalScore} below ${effectiveThreshold} threshold for ${profile.label} mode${regime === "RANGE" ? " (RANGE adjusted)" : ""}`);
    return {
      symbol, side: "NONE", regime, activeMode, timeframe: "5m", htfBias: htf,
      score: finalScore, scoreBreakdown: bd, threshold: effectiveThreshold,
      reasons, entry: price, stop: price, takeProfit: price,
      rr: 0, sizeMultiplier: 0, validUntilMs: Date.now() + 30_000,
    };
  }

  // Entry/SL/TP using ATR-based calculation
  // In RANGE regime, use tighter stops/targets (1.2× instead of 1.5×/2.5×) for range-bound price action
  const atrStopMult = regime === "RANGE" ? 1.2 : 1.5;
  const atrTargetMult = regime === "RANGE" ? 1.8 : 2.5;
  const atrStop = Math.max(atrVal * atrStopMult, price * 0.002);
  const atrTarget = Math.max(atrVal * atrTargetMult, price * 0.004);
  const entry = price;
  let stop: number, takeProfit: number;
  if (side === "LONG") {
    stop = entry - atrStop;
    takeProfit = entry + atrTarget;
  } else {
    stop = entry + atrStop;
    takeProfit = entry - atrTarget;
  }
  const rr = atrTarget / atrStop;

  // Size multiplier based on score
  let sizeMultiplier = 0;
  if (finalScore >= 90) sizeMultiplier = 1.00;
  else if (finalScore >= 75) sizeMultiplier = 0.85;
  else if (finalScore >= 65) sizeMultiplier = 0.70;
  else if (finalScore >= 55) sizeMultiplier = 0.55;
  else if (finalScore >= 45) sizeMultiplier = 0.40;
  else if (finalScore >= 35) sizeMultiplier = 0.30;
  else sizeMultiplier = 0.25;

  reasons.push(`RR ${rr.toFixed(2)} | Size ${Math.round(sizeMultiplier * 100)}%`);

  return {
    symbol, side, regime, activeMode, timeframe: "5m", htfBias: htf,
    score: finalScore, scoreBreakdown: bd, threshold: effectiveThreshold,
    reasons, entry, stop, takeProfit, rr, sizeMultiplier,
    validUntilMs: Date.now() + 45_000,
  };
}
