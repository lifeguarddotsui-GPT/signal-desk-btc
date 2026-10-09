import type { WaterxInterval } from "./types";

/**
 * Outside decision formation, provider reads only discover new round identities.
 * Lock-policy deadlines are protected by an additional lead-in for consecutive
 * fresh observations. Coinbase chart streaming is independent of this cadence.
 */
export const WATERX_IDLE_POLL_MS: Readonly<Record<WaterxInterval, number>> = {
  5: 15_000,
  15: 30_000,
};
export const WATERX_DECISION_POLL_MS = 3_000;
export const WATERX_DECISION_LEAD_MS: Readonly<Record<WaterxInterval, number>> = {
  // 120s first checkpoint + 45s to establish stable observations.
  5: 165_000,
  // 360s first checkpoint + 60s for the longer 15m stability requirement.
  15: 420_000,
};

export function adaptiveWaterxPollIntervalMs(
  interval: WaterxInterval,
  expiryMs: number | null,
  nowMs: number,
): number {
  const idle = WATERX_IDLE_POLL_MS[interval];
  if (expiryMs === null || !Number.isFinite(expiryMs) || !Number.isFinite(nowMs))
    return idle;
  const remainingMs = expiryMs - nowMs;
  // A brief expiry grace period discovers rollover without waiting for idle
  // cadence; old rounds never count as fresh observations of the new round.
  if (remainingMs <= WATERX_DECISION_LEAD_MS[interval] &&
      remainingMs >= -10_000)
    return WATERX_DECISION_POLL_MS;
  return idle;
}
