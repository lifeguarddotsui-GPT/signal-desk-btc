import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoundDecision } from "../../shared/round-decision";
import type { StageLock, StageStats, StageState, TwoStageProjection } from "../../shared/two-stage";
import { TWO_STAGE_STRATEGY } from "../../shared/two-stage";
import { ManualOpportunity } from "./ManualOpportunity";
import { StageStatsBlock } from "./TwoStageHistory";
import type { AtomicDecisionView } from "./live-decision-contract";

const startMs = 1_740_000_000_000;
const expiryMs = startMs + 5 * 60_000;
const now = startMs + 50_000;
const round = { id: "btc-round-a", startMs, expiryMs };

function lock(stage: "EARLY" | "CONFIRMATION", side: "UP" | "DOWN", override: Record<string, unknown> = {}) {
  return {
    id: `${stage}-immutable-id`, network: "sui:mainnet", intervalMinutes: 5,
    roundId: round.id, startMs, expiryMs, marketId: "market-btc-a",
    strategyVersion: TWO_STAGE_STRATEGY, stage, side,
    evidenceCutoffMs: startMs + 20_000, qualifiedAtMs: startMs + 21_000,
    committedAtMs: startMs + 22_000, elapsedMs: 22_000, remainingMs: expiryMs - startMs - 22_000,
    probabilityUp: side === "UP" ? .64 : .36, probabilitySource: "Frozen WaterX market observation",
    calibrationStatus: "UNQUALIFIED", modelVersion: null, policyVersion: `${stage.toLowerCase()}-policy-v1`,
    featureVersion: "price-area-proxy-v1", observationIds: ["obs-frozen-17"],
    economics: { kind: "INDICATIVE", collateralUsd: 5, totalReturnedIfCorrectUsd: 6.4, reason: "Indicative only" },
    reference: { source: "WaterX reference" }, coverage: { count: 4 }, features: { area: 0 },
    captureMode: "PROSPECTIVE", automaticExecutionAllowed: false, shadowOnly: true,
    ...override,
  } as unknown as StageLock;
}

function state(value: StageLock | null, persistence: StageState["persistence"], reason = "Building evidence"): StageState {
  return { lock: value, persistence, reason } as StageState;
}

function projection(early: StageState, confirmation: StageState, overrides: Record<string, unknown> = {}) {
  return {
    intervalMinutes: 5, roundId: round.id, startMs, expiryMs, marketId: "market-btc-a",
    strategyVersion: TWO_STAGE_STRATEGY, shadowOnly: true, automaticExecutionAllowed: false,
    early, confirmation, relationship: "No confirmation", priceFeatures: { recentArea: 2 },
    settlementRule: { source: "not verified" }, ...overrides,
  } as unknown as TwoStageProjection;
}

function render(twoStage?: TwoStageProjection | null) {
  const decision = {
    intervalMinutes: 5, roundId: round.id, startMs, expiryMs, twoStage,
    market: { probabilityUp: .73, probabilityDown: .27, receivedAtMs: now },
  } as unknown as RoundDecision;
  const view = {
    decision, fresh: true, provisionalLean: "UP", nextGateAtMs: null,
    reason: "Current snapshot", persistenceState: "WAITING_CHECKPOINT",
    componentTimestamps: {}, savedDecision: null, strategyVersion: "waterx-qualification-gates-v3",
  } as unknown as AtomicDecisionView;
  return renderToStaticMarkup(React.createElement(ManualOpportunity, { view, now, interval: 5, round }));
}

test("early-only and confirmation-only locks render independently with accurate relationship", () => {
  const earlyOnly = render(projection(state(lock("EARLY", "UP"), "COMMITTED"), state(null, "OBSERVING", "Waiting for additional evidence")));
  assert.match(earlyOnly, /EARLY LOCK/);
  assert.match(earlyOnly, /UP · 22s elapsed/);
  assert.match(earlyOnly, /No confirmation/);
  assert.match(earlyOnly, /Frozen WaterX market observation/);
  assert.match(earlyOnly, /Calibration unqualified · no qualified model/);
  assert.match(earlyOnly, /73\.0%/); // Market odds remain prominent and current.

  const confirmationOnly = render(projection(state(null, "OBSERVING", "No qualifying early opportunity"),
    state(lock("CONFIRMATION", "DOWN"), "COMMITTED")));
  assert.match(confirmationOnly, /CONFIRMATION LOCK/);
  assert.match(confirmationOnly, /DOWN · 22s elapsed/);
  assert.match(confirmationOnly, /No early decision/);
});

test("neither committed stage reports building evidence, never a synthetic lock", () => {
  const html = render(projection(state(null, "OBSERVING", "Building evidence"), state(null, "UNKNOWN", "Waiting for fresh data")));
  assert.match(html, /Building evidence/);
  assert.match(html, /Waiting for fresh data/);
  assert.doesNotMatch(html, /FROZEN SHADOW LOCK/);
  assert.match(html, /Relationship unavailable|Waiting for fresh data/);
  const absent = render(undefined);
  assert.match(absent, /two-stage projection unavailable/);
  assert.doesNotMatch(absent, /EARLY LOCK<\/span><strong>UP ·/);
});

test("both committed locks remain immutable and relationship reflects agreement or changed direction", () => {
  const agreeing = render(projection(state(lock("EARLY", "UP"), "COMMITTED"),
    state(lock("CONFIRMATION", "UP", { probabilityUp: .81, observationIds: ["later-observation"] }), "COMMITTED")));
  assert.match(agreeing, /Agrees with Early Lock/);
  assert.match(agreeing, /obs-frozen-17/);
  assert.match(agreeing, /later-observation/);
  assert.match(agreeing, /Frozen WaterX market observation/);

  const changed = render(projection(state(lock("EARLY", "UP"), "COMMITTED"),
    state(lock("CONFIRMATION", "DOWN"), "COMMITTED")));
  assert.match(changed, /Changed direction/);
  assert.match(changed, /UP · 22s elapsed/);
  assert.match(changed, /DOWN · 22s elapsed/);
});

test("wrong round, interval, non-shadow policy, or uncommitted state cannot surface as a lock", () => {
  const mismatch = projection(state(lock("EARLY", "UP"), "COMMITTED"), state(null, "OBSERVING"));
  const badRound = render(projection(mismatch.early, mismatch.confirmation, { startMs: startMs + 1 }));
  assert.match(badRound, /does not match this round and interval/);
  const wrongInterval = render(projection(mismatch.early, mismatch.confirmation, { intervalMinutes: 15 }));
  assert.match(wrongInterval, /does not match this round and interval/);
  const nonShadow = render(projection(mismatch.early, mismatch.confirmation, { automaticExecutionAllowed: true }));
  assert.match(nonShadow, /does not match this round and interval/);
  const saving = render(projection(state(lock("EARLY", "UP"), "SAVING"), state(null, "OBSERVING")));
  assert.doesNotMatch(saving, /UP · 22s elapsed/);
  assert.match(saving, /Saving; not committed/);
});

test("Early and Confirmation statistics render separate service-provided scores and unknown calibration honestly", () => {
  const stats = (correct: number, incorrect: number, accuracy: number): StageStats => ({
    correct, incorrect, pending: 2, disputed: 1, scoredN: correct + incorrect, accuracy,
    locks: correct + incorrect + 3, cohortN: 12, coverage: .5, medianElapsedMs: 25_000,
    p90ElapsedMs: 51_000, brier: null, calibration: null, indicativeN: 0, verifiedQuoteN: 0,
    actualTradingPnl: null,
  });
  const early = renderToStaticMarkup(React.createElement(StageStatsBlock, { title: "Early Lock", stats: stats(4, 2, 4 / 6) }));
  const confirmation = renderToStaticMarkup(React.createElement(StageStatsBlock, { title: "Confirmation Lock", stats: stats(3, 1, .75) }));
  assert.match(early, /4 : 2/);
  assert.match(early, /66\.7%/);
  assert.match(early, /Calibration<\/span><b>Not reported/);
  assert.match(confirmation, /3 : 1/);
  assert.match(confirmation, /75\.0%/);
  assert.match(confirmation, /Actual trading P\/L<\/span><b>Unavailable · no fills inferred/);
});
