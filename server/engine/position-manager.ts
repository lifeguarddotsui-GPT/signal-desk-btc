import { tradingConfig } from "./trading-config";
import type { TradeRecord, ExitReason } from "./types";

export class PositionManager {
  shouldCloseForPrice(position: TradeRecord, lastPrice: number): ExitReason | null {
    if (position.side === "long") {
      if (lastPrice >= position.takeProfitPrice) return "take_profit";
      if (lastPrice <= position.stopLossPrice) return "stop_loss";
      return null;
    }
    if (lastPrice <= position.takeProfitPrice) return "take_profit";
    if (lastPrice >= position.stopLossPrice) return "stop_loss";
    return null;
  }

  shouldCloseForTime(position: TradeRecord, nowTs: number): ExitReason | null {
    const maxAgeMs = tradingConfig.maxHoldSeconds * 1000;
    if (nowTs - position.entryTs >= maxAgeMs) {
      return "time_stop";
    }
    return null;
  }
}
