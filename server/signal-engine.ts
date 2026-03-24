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
  total: number;    // Final clamped 0-100
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

export function generateSignal(md: MultiTFData, configMode: SignalMode = "AUTO"): TradeSignal {
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

  // Determine trade side
  const side = selectSide(htf, histArr, price, ema20);

  // Build base reasons
  const baseReasons: string[] = [
    `${regime} regime (ADX ${adxValue.toFixed(1)}) | HTF ${htf} | Mode: ${profile.label}`,
    `EMA20 $${ema20.toFixed(4)} | RSI ${rsi.toFixed(1)} | Vol ${volRatio.toFixed(2)}×`,
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
    const approxTotal = Math.min(100, emaSc + rsiSc + macdSc + volSc + htfSc);
    const bd: ScoreBreakdown = { ema: emaSc, rsi: rsiSc, macd: macdSc, volume: volSc, htf: htfSc, penalty: 0, total: approxTotal };

    const reasons = [...baseReasons];
    if (htf === "NEUTRAL") reasons.push("HTF neutral — 1h and 4h have no clear direction. Waiting for trend to develop.");
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

  // Penalties
  let penalty = 0;
  const penaltyReasons: string[] = [];
  if (regime === "TRANSITION") {
    penalty += 8;
    penaltyReasons.push("TRANSITION regime — ADX ambiguous (-8)");
  }
  // Counter-trend penalty: SHORT in NEUTRAL HTF adds friction (requires stronger signal)
  if (side === "SHORT" && htf === "NEUTRAL") {
    penalty += 5;
    penaltyReasons.push("SHORT in NEUTRAL HTF — counter-trend risk (-5)");
  }
  if (side === "LONG" && htf === "NEUTRAL") {
    penalty += 3;
    penaltyReasons.push("LONG in NEUTRAL HTF — no trend confirmation (-3)");
  }

  const finalScore = Math.max(0, Math.min(100, rawTotal - penalty));
  const bd: ScoreBreakdown = {
    ema: emaResult.score,
    rsi: rsiResult.score,
    macd: macdResult.score,
    volume: volResult.score,
    htf: htfResult.score,
    penalty,
    total: finalScore,
  };

  // Build detailed reasons for UI display
  const reasons: string[] = [
    ...baseReasons,
    `Signal direction: ${side} | Score ${finalScore}/100 (need ${threshold}+)`,
    ...emaResult.reasons.slice(0, 2),
    ...rsiResult.reasons.slice(0, 1),
    ...macdResult.reasons.slice(0, 1),
    ...volResult.reasons.slice(0, 1),
    ...htfResult.reasons,
    ...penaltyReasons,
  ];

  // Check threshold
  if (finalScore < threshold) {
    reasons.push(`Score ${finalScore} below ${threshold} threshold for ${profile.label} mode`);
    return {
      symbol, side: "NONE", regime, activeMode, timeframe: "5m", htfBias: htf,
      score: finalScore, scoreBreakdown: bd, threshold,
      reasons, entry: price, stop: price, takeProfit: price,
      rr: 0, sizeMultiplier: 0, validUntilMs: Date.now() + 30_000,
    };
  }

  // Entry/SL/TP using ATR-based calculation
  const atrStop = Math.max(atrVal * 1.5, price * 0.003); // min 0.3% stop
  const atrTarget = Math.max(atrVal * 2.5, price * 0.005); // RR ~1.67
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
    score: finalScore, scoreBreakdown: bd, threshold,
    reasons, entry, stop, takeProfit, rr, sizeMultiplier,
    validUntilMs: Date.now() + 45_000,
  };
}
