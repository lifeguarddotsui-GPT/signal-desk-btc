export type WaterxInterval = 5 | 15;

export type WaterxSide = {
  oddsCents: number | null;
  probabilityCents: number | null;
  availability: "reported" | "locked" | "unavailable";
  reason: string | null;
};

export type WaterxRound = {
  id: string;
  marketId: string;
  slug: string;
  startsAt: number;
  endsAt: number;
  phase: string;
  anchorPrice: number | null;
  anchorPriceConfirmed: boolean;
  referenceUnavailableReason: string | null;
  sides: { up: WaterxSide; down: WaterxSide };
  settlement: { outcome: string | null; settledAt: number | null } | null;
  settlePrice: number | null;
  resolutionStatus: string | null;
};

export type WaterxDetail = {
  market: { slug: string; marketId: string };
  round: WaterxRound;
  neighbors: { past: unknown[]; upcoming: unknown[] };
};

export type WaterxStatus = "LIVE" | "STALE" | "UNAVAILABLE" | "HOLD";

export type WaterxHealthDiagnostics = {
  intervalMinutes: WaterxInterval;
  collectorStatus: "WAITING" | "LIVE" | "STALE" | "DISCONNECTED" | "NO_ACTIVE_MARKET" | "INVALID_RESPONSE" | "SETTLEMENT_PENDING";
  observationFreshness: "WAITING" | "FRESH" | "OVERDUE" | "STALLED";
  lastObservationAgeMs: number | null;
  freshnessThresholdMs: number;
  lastFetchAttemptAt: string | null;
  lastFetchSuccessAt: string | null;
  lastValidObservationAt: string | null;
  lastError: string | null;
  roundId: string | null;
  roundStartsAt: number | null;
  retryAt: string | null;
  retryDelayMs: number | null;
  consecutiveFailures: number;
  fetchInFlight: boolean;
  missedRoundCount: number;
  lastMissedRoundAt: string | null;
};