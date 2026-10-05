import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LockReadinessReport } from "../../shared/lock-readiness";
import { LockReadinessPanel, RoundDecisionPanel, type RoundDecisionEvidence } from "./LockReadinessPanel";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("./LockReadinessPanel.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("./ResearchChoiceCard.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

test("live decision readiness is production-loaded, interval polled, fixture-suppressed, and mounted above the chart", () => {
  assert.match(app, /`\/api\/waterx\/lock-readiness\?interval=\$\{interval\}`/);
  assert.match(app, /useApi<LockReadinessReport>\(lockReadinessUrl, 60000, !fixtureMode\)/);
  assert.match(app, /<RoundDecisionPanel/);
  assert.ok(app.indexOf("<RoundDecisionPanel") < app.indexOf("<section className=\"chart-panel\">"), "decision card must appear above the chart");
  assert.match(app, /decision=\{!fixtureMode && live\.loadedUrl === liveUrl/);
  assert.match(panel, /decision\.roundId === round\.id/);
  assert.match(panel, /decision\.startMs === round\.startMs/);
  assert.match(panel, /decision\.expiryMs === round\.expiryMs/);
  assert.match(panel, /latestSafeOrderAtMs === null/);
});

test("candidate status can never overwrite the immutable canonical lifecycle", () => {
  assert.match(card, /FINAL CHOICE: \$\{finalSide\}/);
  assert.match(card, /research-lifecycle/);
  assert.doesNotMatch(card, /LockReadinessPanel/);
  assert.match(panel, /Historical readiness comparison · separate research feed/);
  assert.match(panel, /SHADOW EARLY CANDIDATE/);
  assert.match(panel, /canonical FINAL CHOICE remains governed by the existing lifecycle/);
  assert.match(panel, /Lock readiness is not win probability/);
});

test("readiness panel shows evidence, exact reasons, current timers, actual scoring and latency", () => {
  for (const required of [
    "LOCK READINESS", "DIRECTION STRENGTH", "STABILITY", "FRESHNESS", "RECENT REVERSALS",
    "PREFERRED SIDE · CURRENT WATERX PROBABILITY", "SAME-SIDE DURATION", "TIME REMAINING",
    "EARLIEST POSSIBLE CONDITIONAL LOCK", "READINESS REASON", "BUILDING LOCK",
    "WAITING FOR EVIDENCE", "readiness.health", "accuracyDifference", "brierDifference",
    "logLossDifference", "averageSecondsGained", "report.checkpoints", "report.latency",
    "report.missedWindows", "Market movement since first lean", "maxAgeMs", "now <",
  ]) assert.ok(panel.includes(required), `missing readiness evidence: ${required}`);
  assert.doesNotMatch(panel, /profit|dollars|\\\$/i);
});

test("server render distinguishes research readiness from stale reports and official choice", () => {
  const now = 1_700_000_000_000;
  const base: LockReadinessReport = {
    intervalMinutes: 5, asOfMs: now, schemaStatus: "available", reason: null, researchOnly: true,
    source: "WaterX Market Baseline",
    current: {
      roundId: "round-a", startMs: now - 1000, expiryMs: now + 240_000,
      policy: { version: "test", intervalMinutes: 5, windows: [120], fallbackSeconds: 60, maxAgeMs: 10_000, maxGapMs: 12_000, earlyStrength: .72, lateStrength: .65, earlyPersistenceMs: 24_000, latePersistenceMs: 12_000, stabilityWindowMs: 15_000, maxRange: .045, reversalWindowMs: 30_000, maxReversals: 1, minObservations: 3, maxVelocity: .012, maxAcceleration: .008, captureGraceMs: 5000 },
      readiness: { state: "READY", score: 83, side: "UP", probability: .71, evaluatedAtMs: now, secondsRemaining: 240, sameSideMs: 25_000, earliestPossibleAtMs: now, reason: "All observed gates pass.", health: "WAITING FOR EVIDENCE", components: { strength: .71, requiredStrength: .65, persistenceMs: 25_000, requiredPersistenceMs: 12_000, range: .02, reversals: 0, observationCount: 8, ageMs: 900, gapReset: false, velocity: .001, acceleration: .001, sourceHealthy: true, withinWindow: true, fresh: true, stable: true } },
      candidate: { side: "UP", probability: .71, decisionAtMs: now - 1000 }, speed: null,
    },
    counts: { rounds: 1, observations: 8, candidates: 1, matched: 0 },
    comparison: { state: "INSUFFICIENT", early: { n: 0, accuracy: null, brier: null, logLoss: null }, canonical: { n: 0, accuracy: null, brier: null, logLoss: null }, averageSecondsGained: null, accuracyDifference: null, brierDifference: null, logLossDifference: null },
    checkpoints: [], latency: {}, missedWindows: [], recentSpeeds: [],
  };
  const props = { interval: 5 as const, round: { id: "round-a", startMs: now - 1000, expiryMs: now + 240_000 }, now };
  const readyMarkup = renderToStaticMarkup(React.createElement(LockReadinessPanel, { ...props, report: base }));
  assert.match(readyMarkup, /83%/);
  assert.match(readyMarkup, /SHADOW EARLY CANDIDATE/);
  assert.match(readyMarkup, /Lock readiness is not win probability/);
  const staleMarkup = renderToStaticMarkup(React.createElement(LockReadinessPanel, { ...props, now: now + 20_000, report: base }));
  assert.doesNotMatch(staleMarkup, /aria-label="Lock readiness 83 percent"/);
  assert.match(staleMarkup, /Report stale, expired, or does not match this round/);
});

test("small-phone layouts constrain readiness details without hiding evidence", () => {
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.lock-readiness-grid \{ grid-template-columns: repeat\(2/);
  assert.match(css, /@media \(max-width: 380px\)[\s\S]*?\.lock-comparison, \.lock-checkpoints \{ grid-template-columns: minmax\(0,1fr\)/);
  assert.match(css, /\.lock-current \{ display: grid; grid-template-columns: 1\.4fr/);
  assert.match(css, /\.round-decision-facts \{ grid-template-columns: repeat\(2/);
  assert.match(css, /@media \(max-width: 390px\)[\s\S]*?\.round-decision-detail/);
});

test("primary progress uses only exact fresh server evidence and never invents execution timing", () => {
  const now = 1_700_000_000_000;
  const round = { id: "round-live", startMs: now - 10_000, expiryMs: now + 240_000 };
  const decision: RoundDecisionEvidence = {
    network: "sui:mainnet", intervalMinutes: 5, roundId: round.id, ...round,
    policyVersion: "policy-v1", stateVersion: 4, updatedAtMs: now, publishedAtMs: now,
    readiness: {
      state: "READY", score: 83, side: "UP", probability: .71, evaluatedAtMs: now,
      secondsRemaining: 240, sameSideMs: 25_000, earliestPossibleAtMs: now,
      reason: "Source gap exceeds the allowed observation interval.", health: "WAITING FOR EVIDENCE",
      components: { strength: .71, requiredStrength: .65, persistenceMs: 25_000, requiredPersistenceMs: 12_000, range: .02, reversals: 0, observationCount: 8, ageMs: 900, gapReset: false, velocity: .001, acceleration: .001, sourceHealthy: true, withinWindow: true, fresh: true, stable: true },
    },
    canonical: null, latestSafeOrderAtMs: null, executionWindowRemainingMs: null,
    executionBlocker: "No verified order path.", tradeAllowed: false,
  };
  const markup = renderToStaticMarkup(React.createElement(RoundDecisionPanel, {
    decision, interval: 5, round, now, browserReceivedAtMs: now, historicalReport: null,
  }));
  assert.match(markup, /83/);
  assert.match(markup, /DIRECTION STRENGTH/);
  assert.match(markup, /Source gap exceeds the allowed observation interval/);
  assert.match(markup, /LATEST SAFE ORDER TIME<\/span><strong>Unknown/);
  assert.match(markup, /EXECUTION WINDOW<\/span><strong>Unknown/);
  assert.match(markup, /Browser receipt · local clock/);
  assert.match(markup, /Signal strength · not win probability/);
  assert.doesNotMatch(markup, /0\.71/);

  const otherRound = renderToStaticMarkup(React.createElement(RoundDecisionPanel, {
    decision, interval: 5, round: { ...round, id: "next-round" }, now, browserReceivedAtMs: now,
  }));
  assert.doesNotMatch(otherRound, /83/);
  assert.match(otherRound, /aria-valuenow="0"/);
  assert.doesNotMatch(otherRound, /LEANING UP/);
  assert.match(otherRound, /Waiting for fresh advisory evidence matching the active round/);
});