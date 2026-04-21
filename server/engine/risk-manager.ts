import { tradingConfig } from "./trading-config";
import type { TradeSide } from "./types";
import type { EngineState } from "./types";

export type AgentSettings = {
  leverage: number;
  minCollateral: number;
  maxCollateral: number;
  takeProfitBps: number;
  stopLossBps: number;
};

export type RiskDecision =
  | { allowed: false; reason: string }
  | {
      allowed: true;
      leverage: number;
      collateralSui: number;
      takeProfitBps: number;
      stopLossBps: number;
    };

export class RiskManager {
  canOpenNewTrade(state: EngineState, nowTs: number, agentSettings?: AgentSettings): RiskDecision {
    if (!tradingConfig.enabled) {
      return { allowed: false, reason: "engine_disabled" };
    }
    if (state.currentTradeId !== null) {
      return { allowed: false, reason: "position_already_open" };
    }
    if (state.cooldownUntilTs && nowTs < state.cooldownUntilTs) {
      const remainSec = Math.round((state.cooldownUntilTs - nowTs) / 1000);
      return { allowed: false, reason: `cooldown_active(${remainSec}s)` };
    }
    if (state.dailyRealizedPnlSui <= -tradingConfig.maxDailyLossSui) {
      return { allowed: false, reason: `daily_loss_limit_hit(${state.dailyRealizedPnlSui.toFixed(3)} SUI)` };
    }
    if (state.consecutiveLosses >= tradingConfig.maxConsecutiveLosses) {
      return { allowed: false, reason: `consecutive_loss_limit(${state.consecutiveLosses})` };
    }

    const leverage = agentSettings?.leverage ?? tradingConfig.leverage;
    const minCol = agentSettings?.minCollateral ?? tradingConfig.minCollateralSui;
    const maxCol = agentSettings?.maxCollateral ?? tradingConfig.maxCollateralSui;
    const tpBps = agentSettings?.takeProfitBps ?? tradingConfig.takeProfitBps;
    const slBps = agentSettings?.stopLossBps ?? tradingConfig.stopLossBps;

    const collateralRange = Math.max(0, maxCol - minCol);
    const collateralSui = minCol + Math.random() * collateralRange;

    return {
      allowed: true,
      leverage,
      collateralSui: Math.round(collateralSui * 100) / 100,
      takeProfitBps: tpBps,
      stopLossBps: slBps,
    };
  }

  computeExitPrices(
    entryPrice: number,
    side: TradeSide,
    tpBps: number,
    slBps: number,
  ): { takeProfitPrice: number; stopLossPrice: number } {
    const tpFactor = tpBps / 10000;
    const slFactor = slBps / 10000;
    if (side === "long") {
      return {
        takeProfitPrice: entryPrice * (1 + tpFactor),
        stopLossPrice: entryPrice * (1 - slFactor),
      };
    }
    return {
      takeProfitPrice: entryPrice * (1 - tpFactor),
      stopLossPrice: entryPrice * (1 + slFactor),
    };
  }
}
