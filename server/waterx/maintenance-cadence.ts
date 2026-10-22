/**
 * Retrospective research maintenance reconciles completed data; it is not an
 * input to the live provider capture, freeze/acknowledgment or 30-second gates.
 *
 * One synchronous kickoff occurs on visitor wake. Historical scoring may lag
 * by up to one minute while visitors remain active. A later visit can catch up.
 * Keep this separate from time-critical stage and settlement schedulers.
 */
export const RESEARCH_MAINTENANCE_PERIOD_MS = 60_000;
export const PREVIOUS_RESEARCH_MAINTENANCE_PERIOD_MS = 15_000;

export function scheduledMaintenanceRunsForOneHour(periodMs: number): number {
  if(!Number.isSafeInteger(periodMs)||periodMs<=0)throw new Error("invalid period");
  return Math.floor(3_600_000 / periodMs);
}

/**
 * Historic 15-minute research reconciliation is retrospective only.
 * When no 15m market is live, four passes per hour are enough to catch up
 * old results while leaving 5m market research and all live sampling alone.
 * A live 15m market retains the full one-minute cadence automatically.
 *
 * This throttles SQL work; it does not guarantee database autosuspend if
 * another collector or visitor is still issuing database queries.
 */
export const INACTIVE_15M_MAINTENANCE_PERIOD_MS = 15 * 60_000;

export function researchMaintenanceCadenceMs(interval: 5 | 15, isLive: boolean): number {
  return interval === 15 && !isLive
    ? INACTIVE_15M_MAINTENANCE_PERIOD_MS
    : RESEARCH_MAINTENANCE_PERIOD_MS;
}

export function maintenanceDue(
  lastRunAtMs: number | undefined,
  nowMs: number,
  cadenceMs: number,
): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(cadenceMs) || cadenceMs <= 0) {
    throw new Error("invalid maintenance cadence");
  }
  return lastRunAtMs === undefined ||
    nowMs < lastRunAtMs ||
    nowMs - lastRunAtMs >= cadenceMs;
}
