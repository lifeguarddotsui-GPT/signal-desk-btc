import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResearchChoice, ResearchReport, ResearchSide } from "../../shared/waterx-research";
import { ResearchChoiceCard } from "./ResearchChoiceCard";
import { ResearchLearningPanel } from "./ResearchLearningPanel";

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
function renderChoice(report: ResearchReport, round: typeof identity | null = identity) {
  return renderToStaticMarkup(createElement(ResearchChoiceCard, {
    report, interval: 5, round, marketOdds: { up: "56.0%", down: "44.0%", current: true, source: "WaterX", asOf: new Date().toISOString() },
  }));
}

test("current-round lifecycle renders watching, a changeable lean, and an immutable final choice", () => {
  const watching = renderChoice(makeReport("WATCHING"));
  assert.match(watching, /WATCHING/);
  assert.match(watching, /Live probabilities move throughout this round/);
  assert.match(watching, /LIVE WATERX MARKET · NOT THE FROZEN CHOICE/);
  assert.match(watching, /WaterX live feed/);

  const leaning = renderChoice(makeReport("LEANING"));
  assert.match(leaning, /LEANING DOWN/);
  assert.match(leaning, /Current lean only · may change before the lock point/);

  const final = renderChoice(makeReport("FINAL_CHOICE", { side: "UP" }));
  assert.match(final, /FINAL CHOICE: UP/);
  assert.match(final, /68\.0% · frozen prediction; cannot change/);
  assert.match(final, /Frozen before settlement · this prediction cannot change/);
  assert.match(final, /LOCKED/);
  assert.match(final, /CHECKPOINT MARKET SNAPSHOT/);
});

test("verified results expose correctness and settled outcome; absent data never fabricates a side", () => {
  const result = renderChoice(makeReport("RESULT", { side: "DOWN", result: "INCORRECT" }));
  assert.match(result, /INCORRECT · VERIFIED OUTCOME: UP/);
  assert.match(result, /Verified outcome: UP/);
  const unavailable = renderChoice(makeReport("NO_VALID_DATA"));
  assert.match(unavailable, /NO VALID DATA/);
  assert.match(unavailable, /No timely evidence qualified/);
  assert.doesNotMatch(unavailable, /FINAL CHOICE: (UP|DOWN)/);
});

test("old-round locked choices are withheld after an identity mismatch or rollover", () => {
  assert.match(renderChoice(makeReport("FINAL_CHOICE", { mismatch: true, side: "DOWN" })), /WATCHING/);
  const rollover = renderChoice(makeReport("FINAL_CHOICE", { side: "DOWN" }), null);
  assert.match(rollover, /WATCHING/);
  assert.doesNotMatch(rollover, /FINAL CHOICE: DOWN/);
});

test("most recent verified historical result is labelled separately and cannot surface as the current choice", () => {
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
  assert.match(html, /MOST RECENT VERIFIED ROUND RESULT · HISTORICAL/);
  assert.match(html, /INCORRECT · UP settled/);
  assert.match(html, /round-previous-77/);
  assert.match(html, /Frozen choice/);
  assert.match(html, /Verified outcome/);
  assert.match(html, /Prior round record only · not the current round choice/);
  assert.match(html, /<strong>WATCHING<\/strong>/);
  assert.doesNotMatch(html, /FINAL CHOICE: DOWN/);

  const sameRoundOnly = { ...report, recentChoices: [makeChoice("UP", "correct")] } as ResearchReport;
  assert.doesNotMatch(renderChoice(sameRoundOnly), /MOST RECENT VERIFIED ROUND RESULT/);
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