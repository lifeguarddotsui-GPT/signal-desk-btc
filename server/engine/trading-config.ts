export type BreakoutScalperConfig = {
  marketSymbol: string;
  maxOnePositionPerAgent: boolean;
  breakoutLookbackBars: number;
  volumeLookbackBars: number;
  atrLookbackBars: number;
  minAtrExpansionRatio: number;
  minVolumeRatio: number;
  useTrendBias: boolean;
  trendBiasLookbackBars: number;
  leverage: number;
  minCollateralSui: number;
  maxCollateralSui: number;
  takeProfitBps: number;
  stopLossBps: number;
  maxHoldSeconds: number;
  cooldownSeconds: number;
  maxDailyLossSui: number;
  maxConsecutiveLosses: number;
  enabled: boolean;
  /** Price must be this many bps ABOVE the breakout level to confirm entry (avoids false breakouts) */
  breakoutConfirmationBps: number;
};

export const tradingConfig: BreakoutScalperConfig = {
  marketSymbol: "SUI-PERP",
  maxOnePositionPerAgent: true,
  breakoutLookbackBars: 20,
  volumeLookbackBars: 20,
  atrLookbackBars: 14,
  minAtrExpansionRatio: 0.8,
  minVolumeRatio: 0.7,
  useTrendBias: true,
  trendBiasLookbackBars: 50,
  leverage: 30,
  minCollateralSui: 3,
  maxCollateralSui: 4,
  takeProfitBps: 50,
  stopLossBps: 35,
  maxHoldSeconds: 900,
  cooldownSeconds: 300,
  maxDailyLossSui: 2.5,
  maxConsecutiveLosses: 4,
  enabled: true,
  breakoutConfirmationBps: 8,
};
