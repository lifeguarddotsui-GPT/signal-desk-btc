import { tradingConfig } from "./trading-config";

export type Candle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type RegimeState = {
  atr: number;
  atrRatio: number;
  avgVolume: number;
  volumeRatio: number;
  recentHigh: number;
  recentLow: number;
  trendBias: "bullish" | "bearish" | "neutral";
  isVolatileEnough: boolean;
  hasVolumeExpansion: boolean;
};

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function trueRange(current: Candle, prev?: Candle): number {
  if (!prev) return current.high - current.low;
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - prev.close),
    Math.abs(current.low - prev.close),
  );
}

function atrOfBars(bars: Candle[]): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    trs.push(trueRange(bars[i], bars[i - 1]));
  }
  return mean(trs);
}

function highestHigh(candles: Candle[]): number {
  return Math.max(...candles.map(c => c.high));
}

function lowestLow(candles: Candle[]): number {
  return Math.min(...candles.map(c => c.low));
}

export class RegimeFilter {
  evaluate(candles: Candle[], lastPrice: number): RegimeState {
    const N = tradingConfig.atrLookbackBars;

    // ── ATR ratio: current N-bar ATR vs prior N-bar ATR ──────────────────────
    // Use all available candles; if <2N available fall back gracefully
    const recentBars = candles.slice(-N - 1);            // last N+1 for N TRs
    const priorBars  = candles.slice(-N * 2 - 1, -N);   // prior window

    const currentAtr    = atrOfBars(recentBars);
    const historicalAtr = atrOfBars(priorBars);
    const atrRatio      = historicalAtr > 0 ? currentAtr / historicalAtr : 0;

    // ── Volume ratio: rolling 5-bar average vs rolling 15-bar average ────────
    // Compares recent average volume rate to longer-term average.
    // Using averages (not single bars) makes this robust against the forming-bar
    // scale issue since all seeded bars and closed live bars are in the same scale.
    const V = tradingConfig.volumeLookbackBars;           // 20
    const volBars    = candles.slice(-V);                 // last 20 candles
    const shortWindow = Math.min(5, Math.floor(V / 4));   // 5
    const recentVols  = volBars.slice(-shortWindow).map(c => c.volume);
    const priorVols   = volBars.slice(0, -shortWindow).map(c => c.volume);

    const avgVolumeRecent = mean(recentVols);
    const avgVolume       = mean(priorVols);
    const volumeRatio     = avgVolume > 0 ? avgVolumeRecent / avgVolume : 0;

    // ── Breakout high/low from the last N closed candles ─────────────────────
    const breakoutWindow = candles.slice(-tradingConfig.breakoutLookbackBars - 1, -1);
    const recentHigh = breakoutWindow.length ? highestHigh(breakoutWindow) : lastPrice;
    const recentLow  = breakoutWindow.length ? lowestLow(breakoutWindow)  : lastPrice;

    // ── Trend bias from EMA slope ─────────────────────────────────────────────
    const trendWindow = candles.slice(-tradingConfig.trendBiasLookbackBars);
    const trendStart  = trendWindow[0]?.close ?? lastPrice;
    const trendEnd    = trendWindow[trendWindow.length - 1]?.close ?? lastPrice;
    let trendBias: "bullish" | "bearish" | "neutral" = "neutral";
    if (trendEnd > trendStart * 1.002) trendBias = "bullish";
    if (trendEnd < trendStart * 0.998) trendBias = "bearish";

    return {
      atr: currentAtr,
      atrRatio,
      avgVolume,
      volumeRatio,
      recentHigh,
      recentLow,
      trendBias,
      isVolatileEnough:   atrRatio    >= tradingConfig.minAtrExpansionRatio,
      hasVolumeExpansion: volumeRatio >= tradingConfig.minVolumeRatio,
    };
  }
}
