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

function atr(candles: Candle[], lookback: number): number {
  if (candles.length < lookback + 1) return 0;
  const trs: number[] = [];
  for (let i = candles.length - lookback; i < candles.length; i++) {
    trs.push(trueRange(candles[i], candles[i - 1]));
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
    const latest = candles[candles.length - 1];

    const atrValue = atr(candles, tradingConfig.atrLookbackBars);

    const prevBars = candles.slice(
      Math.max(0, candles.length - tradingConfig.atrLookbackBars - 1),
      candles.length - 1,
    );
    const avgTr =
      mean(prevBars.slice(1).map((c, i) => trueRange(c, prevBars[i]))) || 0;
    const atrRatio = avgTr > 0 ? atrValue / avgTr : 0;

    const volumeWindow = candles.slice(-tradingConfig.volumeLookbackBars);
    const avgVolume = mean(volumeWindow.map(c => c.volume));
    const volumeRatio = avgVolume > 0 ? latest.volume / avgVolume : 0;

    // Exclude the current (forming) candle from breakout high/low reference
    const breakoutWindow = candles.slice(
      -tradingConfig.breakoutLookbackBars - 1,
      -1,
    );
    const recentHigh = highestHigh(breakoutWindow);
    const recentLow = lowestLow(breakoutWindow);

    const trendWindow = candles.slice(-tradingConfig.trendBiasLookbackBars);
    const trendStart = trendWindow[0]?.close ?? lastPrice;
    const trendEnd = trendWindow[trendWindow.length - 1]?.close ?? lastPrice;
    let trendBias: "bullish" | "bearish" | "neutral" = "neutral";
    if (trendEnd > trendStart * 1.002) trendBias = "bullish";
    if (trendEnd < trendStart * 0.998) trendBias = "bearish";

    return {
      atr: atrValue,
      atrRatio,
      avgVolume,
      volumeRatio,
      recentHigh,
      recentLow,
      trendBias,
      isVolatileEnough: atrRatio >= tradingConfig.minAtrExpansionRatio,
      hasVolumeExpansion: volumeRatio >= tradingConfig.minVolumeRatio,
    };
  }
}
