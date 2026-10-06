import type { BluewaterReport } from "../../shared/bluewater-research";
import type { LockReadinessReport } from "../../shared/lock-readiness";
import type { ResearchChoice, ResearchReport } from "../../shared/waterx-research";

type Interval = 5 | 15;
type RoundIdentity = { id: string; startMs: number; expiryMs: number };

export function reportIsFresh(asOf: string | number | null | undefined, nowMs: number, maxAgeMs = 15_000) {
  const at = typeof asOf === "number" ? asOf : typeof asOf === "string" ? Date.parse(asOf) : NaN;
  return Number.isFinite(at) && at <= nowMs + 1_000 && nowMs - at <= maxAgeMs;
}

export function sameRound(
  identity: { intervalMinutes?: number; roundId?: string; startMs?: number; expiryMs?: number } | null | undefined,
  interval: Interval,
  round: RoundIdentity,
) {
  return !!identity && identity.intervalMinutes === interval && identity.roundId === round.id &&
    identity.startMs === round.startMs && identity.expiryMs === round.expiryMs;
}

export function currentResearchRound(report: ResearchReport | null, interval: Interval, nowMs: number): RoundIdentity | null {
  const round = report?.currentRound;
  if (!report || report.intervalMinutes !== interval || !reportIsFresh(report.asOf, nowMs) || !round ||
    round.startMs > nowMs || round.expiryMs <= nowMs || round.expiryMs <= round.startMs) return null;
  return round;
}

export function currentBaselineChoice(report: ResearchReport | null, interval: Interval, round: RoundIdentity, nowMs: number): ResearchChoice | null {
  const choice = report?.currentChoice;
  if (!report || report.intervalMinutes !== interval || !reportIsFresh(report.asOf, nowMs) ||
    !choice || choice.state !== "FROZEN" || choice.choiceSource !== "market_baseline" || !choice.side ||
    choice.intervalMinutes !== interval || choice.roundId !== round.id ||
    choice.startMs !== round.startMs || choice.expiryMs !== round.expiryMs) return null;
  return choice;
}

export function currentChampionForecast(report: BluewaterReport | null, interval: Interval, round: RoundIdentity, nowMs: number) {
  const forecast = report?.currentForecast;
  if (!report || report.intervalMinutes !== interval || !reportIsFresh(report.asOf, nowMs) ||
    report.status !== "QUALIFIED" || !report.qualifiedCalibration || !report.champion ||
    !forecast || forecast.forecastStatus !== "CHAMPION" || report.champion.artifactId !== forecast.artifactId ||
    forecast.intervalMinutes !== interval || forecast.roundId !== round.id ||
    forecast.startMs !== round.startMs || forecast.expiryMs !== round.expiryMs ||
    !Number.isFinite(forecast.displayedProbabilityUp) || forecast.displayedProbabilityUp < 0 || forecast.displayedProbabilityUp > 1) return null;
  return forecast;
}

export function currentLockReadiness(report: LockReadinessReport | null, interval: Interval, round: RoundIdentity, nowMs: number) {
  const current = report?.current;
  if (!report || report.intervalMinutes !== interval || !reportIsFresh(report.asOfMs, nowMs) ||
    !current || current.roundId !== round.id || current.startMs !== round.startMs || current.expiryMs !== round.expiryMs ||
    !reportIsFresh(current.readiness.evaluatedAtMs, nowMs) || !current.readiness.components.fresh) return null;
  return current.readiness;
}