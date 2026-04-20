export type TradeSide = "long" | "short";
export type TradeStatus = "pending" | "open" | "closed" | "failed";
export type EntryReason = "breakout_long" | "breakout_short";
export type ExitReason = "take_profit" | "stop_loss" | "time_stop" | "manual_fail_safe" | "manual_close";

export type TradeRecord = {
  id: string;
  symbol: string;
  side: TradeSide;
  status: TradeStatus;
  entryReason: EntryReason;
  exitReason?: ExitReason;
  entryTs: number;
  exitTs?: number;
  entryPrice: number;
  exitPrice?: number;
  leverage: number;
  collateralSui: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  pnlSui?: number;
  pnlBps?: number;
  win?: boolean;
  atrRatioAtEntry: number;
  volumeRatioAtEntry: number;
  trendBiasAtEntry: "bullish" | "bearish" | "neutral";
  breakoutLevel: number;
};

export type EngineState = {
  isEnabled: boolean;
  lastScanTs: number | null;
  cooldownUntilTs: number | null;
  currentTradeId: string | null;
  consecutiveLosses: number;
  dailyRealizedPnlSui: number;
  dailyResetTs: number | null;
  lastError?: string;
};
