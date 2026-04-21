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
    const confirmFactor = 1 + tradingConfig.breakoutConfirmationBps / 10000;
    const confirmedHigh = regime.recentHigh * confirmFactor;
    const confirmedLow  = regime.recentLow  / confirmFactor;

    const longAllowed =
      regime.isVolatileEnough &&
      regime.hasVolumeExpansion &&
      lastPrice > confirmedHigh &&
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
      lastPrice < confirmedLow &&
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
    if (lastPrice <= confirmedHigh && lastPrice >= confirmedLow) {
      reasons.push(`price_inside_range(hi=${confirmedHigh.toFixed(4)},lo=${confirmedLow.toFixed(4)})`);
    }

    return { shouldTrade: false, reason: reasons.join(", ") || "no_setup" };
  }
}
