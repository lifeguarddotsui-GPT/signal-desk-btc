import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoundDecision } from "../../shared/round-decision";
import { lockPolicy } from "../../shared/lock-readiness";
import type { ResearchChoice, ResearchReport, ResearchSide } from "../../shared/waterx-research";
import { ResearchChoiceCard } from "./ResearchChoiceCard";
import { ResearchLearningPanel } from "./ResearchLearningPanel";
import { getAtomicDecisionView, type LiveSnapshotEnvelope } from "./live-decision-contract";

const identity = { id: "round-current-01", startMs: 1_700_000_000_000, expiryMs: 1_700_000_300_000 };
function makeChoice(side: ResearchSide = "UP", settlement: ResearchChoice["settlement"]["state"] = "pending"): ResearchChoice {
  return {
    intervalMinutes: 5, roundId: identity.id, startMs: identity.startMs, expiryMs: identity.expiryMs,
    checkpointAtMs: identity.expiryMs - 60_000, decisionAtMs: identity.expiryMs - 55_000,
    state: "FROZEN", side, probabilityUp: side === "UP" ? .68 : .32, probabilityDown: side === "DOWN" ? .68 : .32,
    choiceSource: "bluewaterai_model", modelVersion: "research-v0.4", calibrationVersion: null,
    policyVersion: "checkpoint-v1", noChoiceCode: null, noChoiceReason: null,
    evidence: {
      reference: { price: 83_000, quality: "confirmed", source: "WaterX", appObservedAtMs: identity.startMs },
      market: { probabilityUp: .62, probabilityDown: .38, appObservedAtMs: identity.expiryMs - 60_000, timestampKind: "app-observed" },
      comparison: { source: "Coinbase", price: 83_100, sourceAtMs: null, receivedAtMs: null, return1m: null, return3m: null, realizedVolatility: null, tickCount: 0, coverage: "unavailable", reason: null },
      qualityFlags: [], tieBreakApplied: false,
    },
    settlement: { state: settlement, outcome: settlement === "correct" ? side : settlement === "incorrect" ? side === "UP" ? "DOWN" : "UP" : null, brier: null, logLoss: null, referenceDiscrepancyUsd: null, labelAvailableAt: null },
  };
}
function makeReport(state: "WATCHING" | "LEANING" | "FINAL_CHOICE" | "RESULT" | "NO_VALID_DATA", options: { mismatch?: boolean; side?: ResearchSide; result?: "CORRECT" | "INCORRECT" | null } = {}): ResearchReport {
  const choice = state === "FINAL_CHOICE" || state === "RESULT" ? makeChoice(options.side, state === "RESULT" ? options.result === "CORRECT" ? "correct" : "incorrect" : "pending") : null;
  return {
    intervalMinutes: 5, asOf: new Date().toISOString(), schemaStatus: "available", reason: null,
    policy: { checkpointSecondsBeforeClose: { 5: 60, 15: 180 } } as ResearchReport["policy"],
    currentRound: { ...identity, id: options.mismatch ? "round-prior-00" : identity.id },
    currentChoice: choice, latestChoice: null,
    currentState: state === "NO_VALID_DATA" ? "NO_VALID_CHOICE" : choice ? "FROZEN" : "AWAITING_CHECKPOINT",
    currentReason: null,
    liveModelEstimate: { status: "unavailable", probabilityUp: null, probabilityDown: null, modelVersion: null, calibrationVersion: null, observedAtMs: null, reason: null },
    windows: [], noChoiceReasons: [], alert: { active: false, reason: null, delivery: "dashboard-and-server-log" },
    dailyJob: { configured: false, mode: "opportunistic-existing-process", guaranteesDailyExecution: false, scheduledDay: null, status: "not-configured", startedAt: null, finishedAt: null, datasetFingerprint: null, datasetCount: 0, error: null, reason: null, phases: [], missedDays: 0 },
    note: "Prospective choices only.",
    lifecycle: {
      state, side: state === "LEANING" ? "DOWN" : choice?.side ?? null,
      result: state === "RESULT" ? options.result ?? "CORRECT" : null,
      occurredAt: new Date(identity.expiryMs - 55_000).toISOString(), primaryLockSeconds: 60,
      outcome: state === "RESULT" ? choice?.settlement.outcome : null,
    },
    liveProbabilities: { probabilityUp: .57, probabilityDown: .43, observedAt: new Date().toISOString(), source: "WaterX live feed", fresh: true },
  } as ResearchReport;
}
function makeSnapshot(canonical: boolean): LiveSnapshotEnvelope {
  const decision: RoundDecision = {
    format: "waterx-live-decision-v2", streamId: "test-stream-01", network: "sui:mainnet",
    intervalMinutes: 5, roundId: identity.id, startMs: identity.startMs, expiryMs: identity.expiryMs,
    policyVersion: lockPolicy(5).version, stateVersion: 3, updatedAtMs: identity.startMs + 10_000,
    publishedAtMs: identity.startMs + 10_000,
    readiness: {
      state: "LEANING", score: 73, side: "UP", probability: .64,
      evaluatedAtMs: identity.startMs + 10_000, secondsRemaining: 290, sameSideMs: 20_000,
      earliestPossibleAtMs: identity.startMs + 10_000, reason: "Fresh atomic round evidence.",
      health: "WAITING FOR EVIDENCE",
      components: { strength: .67, requiredStrength: .65, persistenceMs: 20_000, requiredPersistenceMs: 12_000,
        range: .02, reversals: 0, observationCount: 8, ageMs: 100, gapReset: false,
        velocity: .001, acceleration: .001, sourceHealthy: true, withinWindow: true, fresh: true, stable: true },
    },
    market: { probabilityUp: .64, probabilityDown: .36, observedAtMs: identity.startMs + 10_000,
      receivedAtMs: identity.startMs + 9_900, providerOddsAtMs: null },
    persistence: { status: canonical ? "COMMITTED" : "WAITING_CHECKPOINT", updatedAtMs: identity.startMs + 10_000, errorClass: null },
    canonical: canonical ? { side: "UP", probabilityUp: .64, decisionAtMs: identity.startMs + 8_000, committedAtMs: null } : null,
    latestSafeOrderAtMs: null, executionWindowRemainingMs: null,
    executionBlocker: "No verified transaction route.", tradeAllowed: false,
    timestampSemantics: "Application receipt/evaluation/publication clocks; provider odds time unknown; commit is application acknowledgement",
  };
  return { serverTime: new Date(identity.startMs + 10_000).toISOString(), intervalMinutes: 5, round: identity, decision };
}
function makeView(canonical = true, now = identity.startMs + 10_000, round: typeof identity | null = identity) {
  return getAtomicDecisionView(makeSnapshot(canonical), 5, round, now);
}
function renderChoice(report: ResearchReport, round: typeof identity | null = identity, view = makeView(true, identity.startMs + 10_000, round)) {
  return renderToStaticMarkup(createElement(ResearchChoiceCard, {
    report, interval: 5, round, view, refresh: { pending: false, error: "", retryCount: 0, failureCount: 0 },
    retrySnapshot: () => undefined,
  }));
}

test("only the atomic exact-round view supplies current lean, odds, and canonical choice", () => {
  const report = makeReport("LEANING", { side: "DOWN" });
  const locked = renderChoice(report, identity, makeView(true));
  assert.match(locked, /CANONICAL CHOICE: UP/);
  assert.match(locked, /LEANING UP/);
  assert.match(locked, /UP 64\.0%/);
  assert.match(locked, /DOWN 36\.0%/);
  assert.doesNotMatch(locked, /LEANING DOWN|CANONICAL CHOICE: DOWN/);
  assert.doesNotMatch(locked, /WaterX live feed/);

  const uncommitted = renderChoice(makeReport("FINAL_CHOICE", { side: "DOWN" }), identity, makeView(false));
  assert.match(uncommitted, /LEANING UP/);
  assert.match(uncommitted, /NOT LOCKED/);
  assert.doesNotMatch(uncommitted, /CANONICAL CHOICE: DOWN/);
});

test("stale exact-round state preserves canonical evidence but withholds lean and market odds", () => {
  const now = identity.startMs + 25_000;
  const stale = renderChoice(makeReport("RESULT", { side: "DOWN", result: "INCORRECT" }), identity, makeView(true, now));
  assert.match(stale, /CANONICAL CHOICE: UP/);
  assert.match(stale, /LIVE LEAN · ATOMIC ROUND VIEW[\s\S]*?<strong>WITHHELD<\/strong>/);
  assert.match(stale, /Source stale/);
  assert.match(stale, /Withheld · current exact-round source is stale/);
  assert.doesNotMatch(stale, /LEANING UP/);
  assert.doesNotMatch(stale, /INCORRECT · VERIFIED OUTCOME/);
});

test("a mismatched round or rollover withholds old atomic canonical evidence", () => {
  const nextRound = { ...identity, id: "round-next-02", startMs: identity.startMs + 300_000, expiryMs: identity.expiryMs + 300_000 };
  const mismatchView = getAtomicDecisionView(makeSnapshot(true), 5, nextRound, identity.startMs + 10_000);
  const mismatch = renderChoice(makeReport("FINAL_CHOICE", { side: "DOWN" }), nextRound, mismatchView);
  assert.match(mismatch, /Round identity mismatch/i);
  assert.doesNotMatch(mismatch, /CANONICAL CHOICE: UP|LEANING UP/);
  const rolloverView = getAtomicDecisionView(makeSnapshot(true), 5, null, identity.expiryMs + 1000);
  const rollover = renderChoice(makeReport("FINAL_CHOICE", { side: "DOWN" }), null, rolloverView);
  assert.match(rollover, /Waiting for a valid active-round snapshot/);
  assert.doesNotMatch(rollover, /CANONICAL CHOICE: UP|CANONICAL CHOICE: DOWN/);
});

test("most recent verified historical result is labelled separately and cannot surface as current state", () => {
  const previous = {
    ...makeChoice("DOWN", "incorrect"),
    roundId: "round-previous-77",
    startMs: identity.startMs - 300_000,
    expiryMs: identity.expiryMs - 300_000,
    checkpointAtMs: identity.expiryMs - 360_000,
    decisionAtMs: identity.expiryMs - 355_000,
  };
  const report = {
    ...makeReport("WATCHING"),
    recentChoices: [previous],
  } as ResearchReport;
  const html = renderChoice(report);
  assert.match(html, /HISTORICAL VERIFIED ROUND · NOT CURRENT STATE/);
  assert.match(html, /INCORRECT · UP settled/);
  assert.match(html, /round-previous-77/);
  assert.match(html, /Frozen choice/);
  assert.match(html, /Verified outcome/);
  assert.match(html, /<strong>CANONICAL CHOICE: UP<\/strong>/);
  assert.doesNotMatch(html, /CANONICAL CHOICE: DOWN/);

  const sameRoundOnly = { ...report, recentChoices: [makeChoice("UP", "correct")] } as ResearchReport;
  assert.doesNotMatch(renderChoice(sameRoundOnly), /HISTORICAL VERIFIED ROUND/);
});

test("learning audit separates research-only horizons and reports unavailable entry results honestly", () => {
  const report = {
    ...makeReport("WATCHING"),
    horizonEvaluation: [{
      lockSeconds: 45, eligibleN: 14, recordedN: 12, scoredN: 9, matchedCohortN: 8, correctN: 5,
      brier: .241, logLoss: .68, actualTiming: { meanSecondsBeforeExpiry: 37.4, minSecondsBeforeExpiry: 21, maxSecondsBeforeExpiry: 58 },
      researchOnly: true,
    }],
    sideCalibration: [{ side: "UP", n: 8, correctN: 5, meanProbability: .61, observedWinRate: .625, brier: .22, logLoss: .61 }],
    featureMistakes: [{ feature: "thin_reference_coverage", n: 4, incorrectN: 3 }],
    diagnostics: [{ code: "CHECKPOINT_MISSED", roundId: "round-a", reason: "No eligible observation at lock.", count: 2 }],
    entryEvaluation: { status: "unavailable", reason: "No verified advisory outcomes reported.", rows: [] },
    previousCandidate: { status: "unavailable", reason: "No previous candidate comparison reported." },
    canonicalTraining: {
      status: "insufficient", datasetCount: 100, missingFeatureChoices: 27,
      featureCoverage: { richFeatureEligibleCount: 73, richFeatureCoverageRate: .73, missingFeatureChoices: 27 },
      split: { trainingCount: 55, calibrationCount: 18, testCount: 17, embargoExcludedCount: 10 },
      eligibility: { eligible: false, reasons: ["Minimum calibration cohort not met."] },
    },
  } as ResearchReport;
  const html = renderToStaticMarkup(createElement(ResearchLearningPanel, {
    report, interval: 5, loading: false, error: "", retry: () => undefined,
  }));
  assert.match(html, /Lock-horizon comparison/);
  assert.match(html, /RESEARCH ONLY/);
  assert.match(html, /45s/);
  assert.match(html, /Eligible/);
  assert.match(html, /Matched cohort/);
  assert.match(html, /37\.4s/);
  assert.match(html, /21\.0s/);
  assert.match(html, /58\.0s/);
  assert.match(html, /Eligible, recorded, scored, and matched-cohort denominators are separate/);
  assert.match(html, /Directional calibration/);
  assert.match(html, /Features present in mistakes/);
  assert.match(html, /CHECKPOINT_MISSED/);
  assert.match(html, /No verified advisory outcomes reported/);
  assert.match(html, /Market odds alone do not establish trading profitability/);
  assert.match(html, /No previous candidate comparison reported/);
  assert.match(html, /Canonical verified-choice training/);
  assert.match(html, /Missing-feature choices/);
  assert.match(html, /Rich-feature eligible/);
  assert.match(html, /100/);
  assert.match(html, /27/);
  assert.match(html, /73/);
  assert.match(html, /Missing features do not discard those choices/);
  assert.match(html, /INSUFFICIENT · NOT MODEL-READY/);
  assert.doesNotMatch(html, /Net profit|profitability claim/i);
});