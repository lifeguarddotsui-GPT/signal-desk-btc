export function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  let e = values[0];
  const out = [e];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

export function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const series = emaSeries(values, period);
  return series[series.length - 1];
}

export function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const rs = losses === 0 ? 100 : gains / losses;
  return 100 - 100 / (1 + rs);
}

export function rsiSeries(values: number[], period = 14): number[] {
  return values.map((_, i) => rsi(values.slice(0, i + 1), period));
}

export function connorsRsi(values: number[], rsiPeriod = 3, streakPeriod = 2, pctRankPeriod = 100): number {
  if (values.length < Math.max(rsiPeriod + 1, pctRankPeriod)) return 50;

  const priceRsi = rsi(values, rsiPeriod);

  const streaks: number[] = [];
  let streak = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1]) streak = streak > 0 ? streak + 1 : 1;
    else if (values[i] < values[i - 1]) streak = streak < 0 ? streak - 1 : -1;
    else streak = 0;
    streaks.push(streak);
  }
  const streakRsi = streaks.length >= streakPeriod + 1 ? rsi(streaks, streakPeriod) : 50;

  const pctChanges: number[] = [];
  for (let i = 1; i < values.length; i++) {
    pctChanges.push((values[i] - values[i - 1]) / values[i - 1] * 100);
  }
  const recentPctChanges = pctChanges.slice(-pctRankPeriod);
  const lastChange = recentPctChanges[recentPctChanges.length - 1];
  const below = recentPctChanges.filter(c => c < lastChange).length;
  const pctRank = (below / recentPctChanges.length) * 100;

  return (priceRsi + streakRsi + pctRank) / 3;
}

export function dema(values: number[], period: number): number {
  const ema1 = emaSeries(values, period);
  const ema2 = emaSeries(ema1, period);
  return 2 * ema1[ema1.length - 1] - ema2[ema2.length - 1];
}

export function tema(values: number[], period: number): number {
  const ema1 = emaSeries(values, period);
  const ema2 = emaSeries(ema1, period);
  const ema3 = emaSeries(ema2, period);
  return (
    3 * ema1[ema1.length - 1] -
    3 * ema2[ema2.length - 1] +
    ema3[ema3.length - 1]
  );
}

export function macd(values: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): { dif: number; dea: number; macd: number } {
  if (values.length < slowPeriod) return { dif: 0, dea: 0, macd: 0 };
  const fastEma = emaSeries(values, fastPeriod);
  const slowEma = emaSeries(values, slowPeriod);
  const difSeries = fastEma.map((f, i) => f - slowEma[i]);
  const deaSeries = emaSeries(difSeries, signalPeriod);
  const dif = difSeries[difSeries.length - 1];
  const dea = deaSeries[deaSeries.length - 1];
  return { dif, dea, macd: (dif - dea) * 2 };
}

export function macdSeries(values: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): Array<{ dif: number; dea: number; macd: number }> {
  if (values.length < slowPeriod) return values.map(() => ({ dif: 0, dea: 0, macd: 0 }));
  const fastEma = emaSeries(values, fastPeriod);
  const slowEma = emaSeries(values, slowPeriod);
  const difSeries = fastEma.map((f, i) => f - slowEma[i]);
  const deaSeries = emaSeries(difSeries, signalPeriod);
  return difSeries.map((d, i) => ({
    dif: d,
    dea: deaSeries[i],
    macd: (d - deaSeries[i]) * 2,
  }));
}

export function rsiDivergence(prices: number[], rsiValues: number[]): { bullish: boolean; bearish: boolean } {
  if (prices.length < 10 || rsiValues.length < 10) return { bullish: false, bearish: false };

  const p1 = prices[prices.length - 10];
  const p2 = prices[prices.length - 1];
  const r1 = rsiValues[rsiValues.length - 10];
  const r2 = rsiValues[rsiValues.length - 1];

  const bullish = p2 < p1 && r2 > r1;
  const bearish = p2 > p1 && r2 < r1;
  return { bullish, bearish };
}

export type SignalCondition = {
  name: string;
  description: string;
  value: string;
  threshold: string;
  direction: "long" | "short" | "neutral";
  met: boolean;
};

export type SignalResult = {
  side: "long" | "short" | "flat";
  signal: string;
  reason: string;
  longScore: number;
  shortScore: number;
  conditions: SignalCondition[];
  indicators: {
    rsi: number;
    connorsRsi: number;
    ema20: number;
    dema20: number;
    tema20: number;
    rsiDivergence: { bullish: boolean; bearish: boolean };
    vol24h: number;
  };
};

export function computeSignal(closes: number[], volumes: number[]): SignalResult {
  const r = rsi(closes, 14);
  const rValues = rsiSeries(closes, 14);
  const cRsi = connorsRsi(closes);
  const e20 = ema(closes.slice(-60), 20);
  const d20 = dema(closes.slice(-60), 20);
  const t20 = tema(closes.slice(-60), 20);
  const m = macd(closes);
  const div = rsiDivergence(closes, rValues);
  const price = closes[closes.length - 1];
  const vol24h = volumes.slice(-1440).reduce((a, b) => a + b, 0);

  let longScore = 0;
  let shortScore = 0;
  const conditions: SignalCondition[] = [];

  const rsiLong = r < 40;
  const rsiShort = r > 60;
  if (rsiLong) longScore++; else if (rsiShort) shortScore++;
  conditions.push({
    name: "RSI Zone",
    description: rsiLong ? "RSI below 40 — oversold zone favors long" : rsiShort ? "RSI above 60 — overbought zone favors short" : "RSI in neutral zone (40-60)",
    value: r.toFixed(2),
    threshold: rsiLong ? "< 40" : rsiShort ? "> 60" : "40-60",
    direction: rsiLong ? "long" : rsiShort ? "short" : "neutral",
    met: rsiLong || rsiShort,
  });

  const crsiLong = cRsi < 25;
  const crsiShort = cRsi > 75;
  if (crsiLong) longScore++; else if (crsiShort) shortScore++;
  conditions.push({
    name: "Connors RSI",
    description: crsiLong ? "Connors RSI deeply oversold — reversal likely" : crsiShort ? "Connors RSI deeply overbought — pullback likely" : "Connors RSI in neutral zone",
    value: cRsi.toFixed(2),
    threshold: crsiLong ? "< 25" : crsiShort ? "> 75" : "25-75",
    direction: crsiLong ? "long" : crsiShort ? "short" : "neutral",
    met: crsiLong || crsiShort,
  });

  conditions.push({
    name: "RSI Divergence",
    description: div.bullish ? "Bullish divergence detected — price falling but RSI rising" : div.bearish ? "Bearish divergence — price rising but RSI falling" : "No divergence detected",
    value: div.bullish ? "Bullish" : div.bearish ? "Bearish" : "None",
    threshold: "Price/RSI divergence",
    direction: div.bullish ? "long" : div.bearish ? "short" : "neutral",
    met: div.bullish || div.bearish,
  });
  if (div.bullish) longScore++;
  if (div.bearish) shortScore++;

  const priceAboveEma = price > e20;
  if (priceAboveEma) longScore++; else shortScore++;
  conditions.push({
    name: "Price vs EMA(20)",
    description: priceAboveEma ? "Price trading above EMA(20) — bullish trend" : "Price trading below EMA(20) — bearish trend",
    value: `$${price.toFixed(4)}`,
    threshold: `$${e20.toFixed(4)}`,
    direction: priceAboveEma ? "long" : "short",
    met: true,
  });

  const trendAccel = t20 > d20 && d20 > e20;
  const trendDecel = t20 < d20 && d20 < e20;
  if (trendAccel) longScore++; else if (trendDecel) shortScore++;
  conditions.push({
    name: "Trend Alignment",
    description: trendAccel ? "TEMA > DEMA > EMA — strong uptrend alignment" : trendDecel ? "TEMA < DEMA < EMA — strong downtrend alignment" : "Moving averages not aligned — trend unclear",
    value: `T:$${t20.toFixed(4)} D:$${d20.toFixed(4)}`,
    threshold: `EMA:$${e20.toFixed(4)}`,
    direction: trendAccel ? "long" : trendDecel ? "short" : "neutral",
    met: trendAccel || trendDecel,
  });

  const macdBullish = m.macd > 0 && m.dif > m.dea;
  const macdBearish = m.macd < 0 && m.dif < m.dea;
  if (macdBullish) longScore++; else if (macdBearish) shortScore++;
  conditions.push({
    name: "MACD Momentum",
    description: macdBullish ? "MACD histogram positive with bullish crossover" : macdBearish ? "MACD histogram negative with bearish crossover" : "MACD in transition — no clear momentum",
    value: `H:${m.macd.toFixed(6)}`,
    threshold: `DIF:${m.dif.toFixed(6)} DEA:${m.dea.toFixed(6)}`,
    direction: macdBullish ? "long" : macdBearish ? "short" : "neutral",
    met: macdBullish || macdBearish,
  });

  const prevPrice = closes.length >= 6 ? closes[closes.length - 6] : price;
  const momentum5 = ((price - prevPrice) / prevPrice) * 100;
  const momLong = momentum5 < -0.3;
  const momShort = momentum5 > 0.3;
  if (momLong) longScore++; else if (momShort) shortScore++;
  conditions.push({
    name: "5-Bar Reversal",
    description: momLong ? `Price dropped ${Math.abs(momentum5).toFixed(2)}% over 5 bars — mean-reversion long` : momShort ? `Price rose ${momentum5.toFixed(2)}% over 5 bars — mean-reversion short` : "Price flat over 5 bars — no reversal signal",
    value: `${momentum5.toFixed(2)}%`,
    threshold: "|0.30%|",
    direction: momLong ? "long" : momShort ? "short" : "neutral",
    met: momLong || momShort,
  });

  const volGate = vol24h > 0;
  if (!volGate) {
    return {
      side: "flat",
      signal: "no_trade",
      reason: "low volume gate",
      longScore: 0,
      shortScore: 0,
      conditions,
      indicators: { rsi: r, connorsRsi: cRsi, ema20: e20, dema20: d20, tema20: t20, rsiDivergence: div, vol24h },
    };
  }

  const totalConditions = 7;
  const margin = Math.abs(longScore - shortScore);

  let side: "long" | "short" | "flat" = "flat";
  let signal = "no_trade";
  if (longScore >= 4 && longScore > shortScore && margin >= 2) {
    side = "long";
    signal = longScore >= 6 ? "strong_long" : "weak_long";
  } else if (shortScore >= 4 && shortScore > longScore && margin >= 2) {
    side = "short";
    signal = shortScore >= 6 ? "strong_short" : "weak_short";
  }

  return {
    side,
    signal,
    reason: `L${longScore}/S${shortScore} (${totalConditions}c)`,
    longScore,
    shortScore,
    conditions,
    indicators: { rsi: r, connorsRsi: cRsi, ema20: e20, dema20: d20, tema20: t20, rsiDivergence: div, vol24h },
  };
}
