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
