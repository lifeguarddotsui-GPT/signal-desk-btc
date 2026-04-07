export const PROBABILITY_MODEL_VERSION = "wpm-v2-calibrated";

export const MIN_EXPECTED_EDGE_BPS = 12;
export const SAFETY_BUFFER_BPS = 4;

export const MIN_PROBABILITY_BY_REGIME: Record<string, number> = {
  TREND_UP: 0.58,
  TREND_DOWN: 0.58,
  CHOP_LOW_VOL: 0.64,
  CHOP_HIGH_VOL: 0.66,
  BREAKOUT_EXPANSION: 0.60,
  MEAN_REVERSION: 0.59,
  // Legacy regime names from signal engine
  TREND: 0.58,
  RANGE: 0.62,
  VOLATILE: 0.63,
  CHOP_SCALP: 0.60,
};

export const MIN_CONFIDENCE_BY_REGIME: Record<string, number> = {
  TREND_UP: 0.52,
  TREND_DOWN: 0.52,
  CHOP_LOW_VOL: 0.60,
  CHOP_HIGH_VOL: 0.62,
  BREAKOUT_EXPANSION: 0.56,
  MEAN_REVERSION: 0.55,
  TREND: 0.52,
  RANGE: 0.56,
  VOLATILE: 0.58,
  CHOP_SCALP: 0.54,
};

export const MAX_DRAWDOWN_FOR_PRESS = 6;
export const MAX_LOSS_STREAK_FOR_STANDARD = 2;
export const MAX_LOSS_STREAK_FOR_PRESS = 1;
export const PRESS_MIN_PROBABILITY = 0.67;
export const PRESS_MIN_CONFIDENCE = 0.64;
export const PRESS_MIN_EDGE_BPS = 24;
