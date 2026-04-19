import { tradingConfig } from "./trading-config";
import type { RegimeState } from "./regime-filter";
import type { TradeSide } from "./types";

export type StrategyDecision =
  | { shouldTrade: false; reason: string }
  | {
      shouldTrade: true;
      side: TradeSide;
      entryReason: "breakout_long" | "breakout_short";
      breakoutLevel: number;
    };

export class BreakoutStrategy {
  decide(lastPrice: number, regime: RegimeState): StrategyDecision {
    const longAllowed =
      regime.isVolatileEnough &&
      regime.hasVolumeExpansion &&
      lastPrice > regime.recentHigh &&
      (!tradingConfig.useTrendBias || regime.trendBias !== "bearish");

    if (longAllowed) {
      return {
        shouldTrade: true,
        side: "long",
        entryReason: "breakout_long",
        breakoutLevel: regime.recentHigh,
      };
    }

    const shortAllowed =
      regime.isVolatileEnough &&
      regime.hasVolumeExpansion &&
      lastPrice < regime.recentLow &&
      (!tradingConfig.useTrendBias || regime.trendBias !== "bullish");

    if (shortAllowed) {
      return {
        shouldTrade: true,
        side: "short",
        entryReason: "breakout_short",
        breakoutLevel: regime.recentLow,
      };
    }

    const reasons: string[] = [];
    if (!regime.isVolatileEnough) reasons.push(`atr_ratio=${regime.atrRatio.toFixed(2)}<${tradingConfig.minAtrExpansionRatio}`);
    if (!regime.hasVolumeExpansion) reasons.push(`vol_ratio=${regime.volumeRatio.toFixed(2)}<${tradingConfig.minVolumeRatio}`);
    if (lastPrice <= regime.recentHigh && lastPrice >= regime.recentLow) reasons.push(`price_inside_range[${regime.recentLow.toFixed(4)},${regime.recentHigh.toFixed(4)}]`);

    return { shouldTrade: false, reason: reasons.join(", ") || "no_setup" };
  }
}
