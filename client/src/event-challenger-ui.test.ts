import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventLockProjection } from "../../shared/event-lock";
import type { TimedDecision, TimedState } from "../../shared/timed-decision";
import { EventChallengerPanel } from "./EventChallengerPanel";
import { ManualOpportunity } from "./ManualOpportunity";
import type { AtomicDecisionView } from "./live-decision-contract";

const now = 1_700_000_050_000;
const round = { id: "research-round", startMs: now - 50_000, expiryMs: now + 250_000 };
const timed: TimedState = {
  strategyVersion: "waterx-event-lock-v1", targetAtMs: round.startMs + 60_000,
  hardDeadlineAtMs: round.expiryMs, elapsedMs: 50_000, timeProgress: .2,
  phase: "EVALUATING", readinessPercent: 50, qualified: false, blocker: "SAME_SIDE_PERSISTENCE_INCOMPLETE",
  liveSide: "UP", liveProbabilityUp: .73, sourceAgeMs: 2_000, persistence: "WAITING",
  errorClass: null, saved: null, requirementsMet: 2, requirementsTotal: 4,
  components: { sameSideMs: 12_000, requiredSameSideMs: 24_000, validCount: 4, requiredCount: 3,
    probabilityRange: .02, maximumRange: .045, strength: .73, requiredStrength: .72,
    recentReversals: 0, trendKind: "FLAT_STABLE" },
};
const locked: TimedDecision = {
  id: "event-lock-1", strategyVersion: "waterx-event-lock-v1", network: "sui:mainnet",
  intervalMinutes: 5, roundId: round.id, startMs: round.startMs, expiryMs: round.expiryMs,
  status: "LOCKED", side: "UP", probabilityUp: .74, probabilityDown: .26,
  observationId: "accepted-observation-9", receivedAtMs: now - 8_000, decisionAtMs: now - 7_000,
  elapsedMs: 43_000, targetAtMs: round.startMs + 60_000, hardDeadlineAtMs: round.expiryMs,
  lockReason: "QUALIFIED_ON_NEW_OBSERVATION", earlyBlocker: "CONDITIONS_SATISFIED",
  ambiguous: false, coverage: { n: 9, firstAtMs: round.startMs + 2_000, lastAtMs: now - 8_000, maxGapMs: 7_000 },
  committedAtMs: now - 6_000, workerReceivedAtMs: now - 6_500, onTime: true,
  operationalFailure: null, automaticExecutionAllowed: false,
  evidence: { probabilitySemantics: "WaterX market input; uncalibrated" },
};

function projection(overrides: Partial<EventLockProjection> = {}): EventLockProjection {
  return {
    intervalMinutes: 5, roundId: round.id, startMs: round.startMs, expiryMs: round.expiryMs,
    strategyVersion: "waterx-event-lock-v1", benchmarkVersion: "waterx-qualification-gates-v3",
    shadowOnly: true, activePolicyChanged: false, automaticExecutionAllowed: false,
    state: "WATCHING", qualification: timed, saved: null, firstQualifiedAtMs: null,
    persistence: "OBSERVING", blocker: "NO_VALID_PROBABILITY_INPUT", acceptedObservations: 4,
    duplicateDeliveries: 1, outOfOrderInputs: 0, droppedInputs: 0, postLockObservations: 0,
    ...overrides,
  };
}
function renderEvent(value: EventLockProjection | null, identity = round, at = now) {
  return renderToStaticMarkup(React.createElement(EventChallengerPanel, { projection: value, round: identity, now: at }));
}

test("challenger UI renders WATCHING, LEANING, SAVING, LOCKED and ROUND COMPLETE as separate states", () => {
  assert.match(renderEvent(projection()), />WATCHING</);
  assert.match(renderEvent(projection({ state: "LEANING_UP", qualification: { ...timed, liveSide: "UP" } })), />LEANING UP</);
  assert.match(renderEvent(projection({ state: "SAVING", persistence: "SAVING" })), />SAVING</);
  assert.match(renderEvent(projection({ state: "LOCKED_UP", persistence: "COMMITTED", saved: locked })), />LOCKED UP</);
  const completeWithLock = renderEvent(projection({ state: "ROUND_COMPLETE", persistence: "COMMITTED", saved: locked }), round, round.expiryMs);
  assert.match(completeWithLock, />ROUND COMPLETE</);
  assert.match(completeWithLock, /FROZEN SHADOW LOCK · UP/);
  const missing = renderEvent(null);
  assert.match(missing, />PROJECTION UNAVAILABLE</);
  assert.match(missing, /Event challenger projection is missing from this snapshot/);
});

test("a quote outage does not erase an immutable event-side lock or its saved probabilities", () => {
  const outageQualification = { ...timed, liveSide: null, liveProbabilityUp: null, sourceAgeMs: null,
    blocker: "NO_VALID_PROBABILITY_INPUT", requirementsMet: 0 };
  const html = renderEvent(projection({ state: "LOCKED_UP", qualification: outageQualification,
    saved: locked, persistence: "COMMITTED", blocker: "NO_VALID_PROBABILITY_INPUT" }));
  assert.match(html, /FROZEN SHADOW LOCK · UP/);
  assert.match(html, /UP 74\.0%/);
  assert.match(html, /DOWN 26\.0%/);
  assert.match(html, /No current event probability input/);
  assert.match(html, /Saved side and probabilities remain unchanged/);
  assert.match(html, /live market odds above remain a separate feed/);
});

test("projection must match exact round identity and explicit shadow-only invariants", () => {
  const mismatchedRound = { ...round, id: "another-round" };
  const mismatch = renderEvent(projection({ saved: locked, state: "LOCKED_UP" }), mismatchedRound);
  assert.match(mismatch, /Projection does not match this exact round/);
  assert.doesNotMatch(mismatch, /FROZEN SHADOW LOCK/);
  const invalidPolicy = renderEvent(projection({ activePolicyChanged: true, saved: locked, state: "LOCKED_UP" }));
  assert.match(invalidPolicy, /Projection does not match this exact round/);
  assert.doesNotMatch(invalidPolicy, /FROZEN SHADOW LOCK/);
});

test("display choice leaves the 30-second benchmark active and never routes challenger into policy authority", () => {
  const view: AtomicDecisionView = {
    decision: null, fresh: false, sourceAgeMs: null, lean: null, stage: "WATCHING", score: null,
    reason: "Waiting for a valid active-round snapshot.", projectionVersion: "waterx-exact-round-client-v1",
    sourceProjectionVersion: null, intervalMinutes: 5, roundIdentity: round, strategyVersion: null,
    snapshotVersion: null, componentTimestamps: {}, provisionalLean: null, lastGate: null, nextGateAtMs: null,
    savedDecision: null, persistenceState: null,
  };
  const html = renderToStaticMarkup(React.createElement(ManualOpportunity, { view, now, interval: 5, round }));
  assert.match(html, /30-second benchmark · active/);
  assert.match(html, /Event challenger · shadow/);
  assert.match(html, /aria-pressed="true">30-second benchmark · active/);
  assert.doesNotMatch(html, /Event-driven challenger/);
  const source = readFileSync(new URL("./ManualOpportunity.tsx", import.meta.url), "utf8");
  assert.match(source, /projection=\{exactDecision\?\.eventChallenger\}/);
  assert.match(source, /30-second benchmark countdown/);
  assert.match(source, /not a challenger lock deadline/);
  const agent = readFileSync(new URL("./AgentCurrentRound.tsx", import.meta.url), "utf8");
  assert.match(agent, /projection=\{timedEnvelope\?\.decision\?\.eventChallenger \?\? null\}/);
  assert.match(agent, /useLiveSnapshot<LiveSnapshotEnvelope>/);
  const history = readFileSync(new URL("./TimedDecisionHistory.tsx", import.meta.url), "utf8");
  assert.match(history, /waterx-event-lock-v1">waterx-event-lock-v1 · shadow challenger/);
  assert.match(history, /new URLSearchParams\(\{ interval: String\(interval\), strategy, window, deployment, limit: String\(limit\), timezoneOffsetMinutes:/);
});
