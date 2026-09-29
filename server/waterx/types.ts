export type WaterxInterval = 5 | 15;

export type WaterxSide = {
  oddsCents: number | null;
  probabilityCents: number | null;
};

export type WaterxRound = {
  id: string;
  marketId: string;
  slug: string;
  startsAt: number;
  endsAt: number;
  phase: string;
  anchorPrice: number;
  anchorPriceConfirmed: boolean;
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