import test from "node:test";
import assert from "node:assert/strict";
import type { ResearchChoice, ResearchReport } from "../../shared/waterx-research";
import type { BluewaterReport } from "../../shared/bluewater-research";
import type { LockReadinessReport } from "../../shared/lock-readiness";
import { currentBaselineChoice, currentChampionForecast, currentLockReadiness, currentResearchRound, reportIsFresh } from "./agent-round-contract";

const now = 1_700_000_000_000;
const round = { id: "round-current", startMs: now - 60_000, expiryMs: now + 120_000 };
const choice = {
  intervalMinutes: 5, roundId: round.id, startMs: round.startMs, expiryMs: round.expiryMs,
  state: "FROZEN", choiceSource: "market_baseline", side: "UP", decisionAtMs: now - 40_000,
} as ResearchChoice;

test("current choice requires fresh exact current identity and never falls back to latestChoice", () => {
  const report = {
    intervalMinutes: 5, asOf: new Date(now).toISOString(), currentRound: round,
    currentChoice: choice, latestChoice: { ...choice, roundId: "old-round" },
  } as unknown as ResearchReport;
  const active = currentResearchRound(report, 5, now);
  assert.deepEqual(active, round);
  assert.equal(currentBaselineChoice(report, 5, round, now), choice);
  assert.equal(currentBaselineChoice({ ...report, currentChoice: null }, 5, round, now), null);
  assert.equal(currentBaselineChoice(report, 15, round, now), null);
  assert.equal(currentResearchRound({ ...report, asOf: new Date(now - 20_000).toISOString() }, 5, now), null);
});

test("champion probability is withheld unless current qualified artifact and round all match", () => {
  const forecast = {
    intervalMinutes: 5, roundId: round.id, startMs: round.startMs, expiryMs: round.expiryMs,
    artifactId: "champion-a", forecastStatus: "CHAMPION", displayedProbabilityUp: .613,
    decisionAtMs: now - 2_000, modelVersion: "test",
  };
  const report = {
    intervalMinutes: 5, asOf: new Date(now).toISOString(), status: "QUALIFIED",
    qualifiedCalibration: true, champion: { artifactId: "champion-a" }, currentForecast: forecast,
  } as unknown as BluewaterReport;
  assert.equal(currentChampionForecast(report, 5, round, now), forecast);
  assert.equal(currentChampionForecast({ ...report, champion: { artifactId: "different" } }, 5, round, now), null);
  assert.equal(currentChampionForecast({ ...report, status: "SHADOW" }, 5, round, now), null);
  assert.equal(reportIsFresh(now + 2_000, now), false);
});

test("mechanical readiness requires same-round current reporting and never supplies a win probability", () => {
  const readiness = {
    state: "READY", score: .92, probability: .99, evaluatedAtMs: now - 1_000,
    components: { fresh: true }, reason: "Mechanical conditions hold.",
  };
  const report = {
    intervalMinutes: 5, asOfMs: now,
    current: { roundId: round.id, startMs: round.startMs, expiryMs: round.expiryMs, readiness },
  } as unknown as LockReadinessReport;
  assert.equal(currentLockReadiness(report, 5, round, now), readiness);
  assert.equal(currentLockReadiness({ ...report, current: { ...report.current!, roundId: "another" } }, 5, round, now), null);
  assert.equal(currentLockReadiness({ ...report, current: { ...report.current!, readiness: { ...readiness, components: { fresh: false } } } }, 5, round, now), null);
});