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

export type SignalResult = {
  side: "long" | "short" | "flat";
  signal: string;
  reason: string;
  longScore: number;
  shortScore: number;
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
  const div = rsiDivergence(closes, rValues);
  const price = closes[closes.length - 1];
  const vol24h = volumes.slice(-1440).reduce((a, b) => a + b, 0);

  let longScore = 0;
  let shortScore = 0;

  if (r > 50) longScore++; else shortScore++;
  if (cRsi < 30) longScore++; else if (cRsi > 70) shortScore++;
  if (div.bullish) longScore++;
  if (div.bearish) shortScore++;
  if (price > e20) longScore++; else shortScore++;
  if (d20 > e20) longScore++; else shortScore++;
  if (t20 > d20) longScore++; else shortScore++;

  const volGate = vol24h > 0;
  if (!volGate) {
    return {
      side: "flat",
      signal: "no_trade",
      reason: "low volume gate",
      longScore: 0,
      shortScore: 0,
      indicators: { rsi: r, connorsRsi: cRsi, ema20: e20, dema20: d20, tema20: t20, rsiDivergence: div, vol24h },
    };
  }

  let side: "long" | "short" | "flat" = "flat";
  let signal = "no_trade";
  if (longScore >= 4) {
    side = "long";
    signal = longScore >= 5 ? "strong_long" : "weak_long";
  } else if (shortScore >= 4) {
    side = "short";
    signal = shortScore >= 5 ? "strong_short" : "weak_short";
  }

  return {
    side,
    signal,
    reason: `L${longScore}/S${shortScore}`,
    longScore,
    shortScore,
    indicators: { rsi: r, connorsRsi: cRsi, ema20: e20, dema20: d20, tema20: t20, rsiDivergence: div, vol24h },
  };
}
