import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoundDecision } from "../../shared/round-decision";
import type { StageLock, StageStats, StageState, TwoStageProjection } from "../../shared/two-stage";
import { TWO_STAGE_STRATEGY } from "../../shared/two-stage";
import { ManualOpportunity } from "./ManualOpportunity";
import { RoundRow, StageStatsBlock } from "./TwoStageHistory";
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

function state(value: StageLock | null, persistence: StageState["persistence"], reason = "Building evidence",
  diagnostics?: StageState["diagnostics"]): StageState {
  return { lock: value, persistence, reason, diagnostics } as StageState;
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
  assert.match(earlyOnly, /Locked at 00:22 · 04:38 remaining/);
  assert.match(earlyOnly, /No confirmation/);
  assert.match(earlyOnly, /Frozen WaterX market observation/);
  assert.match(earlyOnly, /Calibration unqualified · no qualified model/);
  assert.match(earlyOnly, /73\.0%/); // Market odds remain prominent and current.

  const confirmationOnly = render(projection(state(null, "OBSERVING", "No qualifying early opportunity"),
    state(lock("CONFIRMATION", "DOWN"), "COMMITTED")));
  assert.match(confirmationOnly, /CONFIRMATION LOCK/);
  assert.match(confirmationOnly, /Locked at 00:22 · 04:38 remaining/);
  assert.match(confirmationOnly, /No early decision/);
});

test("neither committed stage reports building evidence, never a synthetic lock", () => {
  const html = render(projection(state(null, "OBSERVING", "Building evidence"), state(null, "UNKNOWN", "Waiting for fresh data")));
  assert.match(html, /Building evidence/);
  assert.match(html, /Commit state unknown · reconciling/);
  assert.doesNotMatch(html, /FROZEN SHADOW LOCK/);
  assert.match(html, /Relationship unavailable|Commit state unknown/);
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
  assert.match(changed, /Locked at 00:22 · 04:38 remaining/g);
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
  assert.match(saving, /Saving decision/);
});

test("early lock is rendered as a prominent separate primary with honest value status and frozen timing", () => {
  const early = lock("EARLY", "DOWN", {
    elapsedMs: 62_000, remainingMs: 238_000, committedAtMs:startMs+62_060,valueStatus: "BELOW_PREFERRED",
    researchPreference: { mode: "PREFERRED", collateralUsd: 5, minimumReturnUsd: 6.5, preferredReturnUsd: 7 },
    timing: { receivedAtMs: startMs + 62_000, acceptedAtMs: startMs + 62_010, qualifiedAtMs: startMs + 62_020,
      acquisitionStartedAtMs: startMs + 62_030, acquiredAtMs: startMs + 62_050,
      commitAcknowledgedAtMs: startMs + 62_060, projectionAtMs: startMs + 62_070 },
  });
  const html = render(projection(state(early, "COMMITTED"), state(null, "OBSERVING", "CONFIRMATION_POLICY_NOT_QUALIFIED")));
  assert.match(html, /data-stage="early"/);
  assert.match(html, /DOWN/);
  assert.match(html, /Locked at 01:02 · 03:58 remaining/);
  assert.match(html, /Indicative \$5\.00 collateral · \$6\.40 total return if correct/);
  assert.match(html, /Below preferred return/);
  assert.match(html, /market-derived evidence · uncalibrated/i);
  assert.match(html, /Confirmation model not available/);
  assert.match(html, /EXPERIMENTAL · SHADOW RESEARCH/);
  assert.match(html, /ACTIVE · 30-SECOND BENCHMARK/);
  assert.match(html, /Frozen research preference · preferred/);
});

test("saving and unknown persistence take precedence over generic diagnostics", () => {
  const saving = render(projection(state(null, "SAVING", "DIRECTIONAL_SEPARATION_BELOW_POLICY",
    { message: "Directional strength below policy", measurements: {}, thresholds: {} }), state(null, "OBSERVING")));
  assert.match(saving, /Saving decision/);
  const unknown = render(projection(state(null, "UNKNOWN", "DIRECTIONAL_SEPARATION_BELOW_POLICY",
    { message: "Directional strength below policy", measurements: {}, thresholds: {} }), state(null, "OBSERVING")));
  assert.match(unknown, /Commit state unknown · reconciling/);
});

test("history SSR accepts a v1 lock only when it matches the historical row version", () => {
  const historical = lock("EARLY", "UP", { strategyVersion: "waterx-two-stage-shadow-v1" });
  const row = {
    intervalMinutes: 5, roundId: round.id, startMs, expiryMs, marketId: "market-btc-a",
    strategyVersion: "waterx-two-stage-shadow-v1", early: historical, confirmation: null,
    relationship: "No confirmation", outcome: "UP", disputed: false, dataFailure: false,
    earlyReason: "", confirmationReason: "",
  };
  const html = renderToStaticMarkup(React.createElement(RoundRow, { row: row as never }));
  assert.match(html, /elapsed 22\.0s/);
  assert.match(html, /waterx-two-stage-shadow-v1/);
  const mismatched = renderToStaticMarkup(React.createElement(RoundRow, {
    row: { ...row, strategyVersion: TWO_STAGE_STRATEGY } as never,
  }));
  assert.match(mismatched, /No lock/);
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
  assert.match(early, /CORRECT<\/span><\/div><i aria-hidden="true">:<\/i><div><b>2<\/b><span>INCORRECT/);
  assert.match(early, /UNRECORDED/);
  assert.match(early, /66\.7%/);
  assert.match(early, /Calibration<\/span><b>Not reported/);
  assert.match(confirmation, /<b>3<\/b><span>CORRECT/);
  assert.match(confirmation, /<b>1<\/b><span>INCORRECT/);
  assert.match(confirmation, /75\.0%/);
  assert.match(confirmation, /Actual trading P\/L<\/span><b>Unavailable · no fills inferred/);
});

test("history round cards keep stage records separate and suppress non-verified outcomes", () => {
  const row = {
    intervalMinutes: 5, roundId: round.id, startMs, expiryMs, marketId: "market-btc-a",
    strategyVersion: TWO_STAGE_STRATEGY,
    early: lock("EARLY", "UP"), confirmation: lock("CONFIRMATION", "DOWN"),
    relationship: "Changed direction", outcome: "UP", settlementStatus: "PENDING",
    disputed: false, dataFailure: false, earlyReason: "", confirmationReason: "",
  };
  const html = renderToStaticMarkup(React.createElement(RoundRow, { row: row as never }));
  assert.match(html, /EARLY LOCK/);
  assert.match(html, /CONFIRMATION/);
  assert.match(html, /DISAGREE/);
  assert.match(html, /Not scored as final/);
  assert.doesNotMatch(html, /WATERX FINAL<\/small><b>UP/);
  const provisional=renderToStaticMarkup(React.createElement(RoundRow,{row:{...row,settlementStatus:"WITHHELD",
    settlementEvidence:{source:"OFFICIAL_WATERX_PROVIDER_ADAPTER",roundId:row.roundId,intervalMinutes:5,
      startMs,expiryMs,verifiedAtMs:null,settledAtMs:null,anchorPrice:null,settlePrice:null,
      provisionalOutcome:"UP",note:"Provider-reported direction lacks post-expiry timestamp."}} as never}));
  assert.match(provisional,/PROVISIONAL \/ UNVERIFIED/);
  assert.doesNotMatch(provisional,/WATERX FINAL<\/small><b>UP/);
  assert.match(html, /Early committed/);
  assert.match(html, /Confirmation committed/);

  const legacyWithoutStatus = renderToStaticMarkup(React.createElement(RoundRow, {
    row: { ...row, settlementStatus: undefined } as never,
  }));
  assert.match(legacyWithoutStatus, /Settlement record missing/);
  assert.doesNotMatch(legacyWithoutStatus, /WATERX FINAL<\/small><b>UP/);
});
