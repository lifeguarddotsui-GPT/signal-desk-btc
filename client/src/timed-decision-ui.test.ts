import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoundDecision } from "../../shared/round-decision";
import type { TimedDecision, TimedState } from "../../shared/timed-decision";
import { lockPolicy } from "../../shared/lock-readiness";
import { ManualOpportunity } from "./ManualOpportunity";
import { TimedDecisionHistoryRecords, type TimedHistoryResponse } from "./TimedDecisionHistory";
import type { AtomicDecisionView } from "./live-decision-contract";
import { validateDecisionSnapshot, type LiveSnapshotEnvelope } from "./live-decision-contract";

const now = 1_720_000_000_000;
const strategyVersion = "waterx-timed-baseline-v1";
const gateStrategyVersion = "waterx-qualification-gates-v3";

function savedRecord(interval: 5 | 15, status: TimedDecision["status"] = "LOCKED"): TimedDecision {
  const elapsedMs = status === "NO_VALID_INPUT" ? (interval === 5 ? 150_000 : 450_000)
    : status === "MISSED_DEADLINE" ? (interval === 5 ? 160_000 : 460_000)
      : interval === 5 ? 140_000 : 320_000;
  const startMs = now - elapsedMs;
  const side = status === "LOCKED" ? "DOWN" : null;
  return {
    id: `timed-decision-${interval}-shared`,
    strategyVersion,
    network: "sui:mainnet",
    intervalMinutes: interval,
    roundId: `round-${interval}-shared`,
    startMs,
    expiryMs: startMs + interval * 60_000,
    status,
    side,
    probabilityUp: status === "LOCKED" ? .38 : null,
    probabilityDown: status === "LOCKED" ? .62 : null,
    observationId: status === "LOCKED" ? "observation-immutable-7" : null,
    receivedAtMs: status === "LOCKED" ? startMs + 139_000 : null,
    decisionAtMs: startMs + elapsedMs,
    elapsedMs,
    targetAtMs: startMs + (interval === 5 ? 120_000 : 300_000),
    hardDeadlineAtMs: startMs + (interval === 5 ? 150_000 : 450_000),
    lockReason: status === "LOCKED" ? "HARD_DEADLINE_CHOICE" : "NO_QUALIFIED_INPUT",
    earlyBlocker: status === "NO_VALID_INPUT" ? "NO_VALID_PROBABILITY_INPUT" : "SAME_SIDE_PERSISTENCE_INCOMPLETE",
    ambiguous: false,
    coverage: { n: 12, firstAtMs: startMs + 10_000, lastAtMs: startMs + 139_000, maxGapMs: 11_000 },
    committedAtMs: status === "MISSED_DEADLINE" ? null : now,
    workerReceivedAtMs: null,
    onTime: status === "LOCKED" ? null : false,
    operationalFailure: status === "NO_VALID_INPUT" ? "NO_ACCEPTED_OBSERVATION" : null,
    automaticExecutionAllowed: false,
    evidence: { sourceId: "waterx.public.crypto.v1", decisionId: `timed-decision-${interval}-shared` },
  };
}

function timed(interval: 5 | 15, elapsed: number, phase: TimedState["phase"]): TimedState {
  const start = now - elapsed;
  const targetAtMs = start + (interval === 5 ? 120_000 : 300_000);
  const hardDeadlineAtMs = start + (interval === 5 ? 150_000 : 450_000);
  return {
    strategyVersion, targetAtMs, hardDeadlineAtMs, elapsedMs: elapsed,
    timeProgress: Math.max(0, Math.min(1, (now - start) / (hardDeadlineAtMs - start))),
    phase, readinessPercent: 50, qualified: false, blocker: "SAME_SIDE_PERSISTENCE_INCOMPLETE",
    liveSide: "UP", liveProbabilityUp: .64, sourceAgeMs: 1200,
    persistence: "WAITING", errorClass: null, saved: null,
  };
}

function gateTimed(interval: 5 | 15, elapsed: number): TimedState {
  const state = timed(interval, elapsed, elapsed >= (interval === 5 ? 60_000 : 180_000) ? "EVALUATING" : "OBSERVING");
  const start = now - elapsed;
  const expiry = start + interval * 60_000;
  const next = start + (Math.floor(elapsed / 30_000) + 1) * 30_000;
  return {
    ...state,
    strategyVersion: gateStrategyVersion,
    targetAtMs: start + (interval === 5 ? 60_000 : 180_000),
    hardDeadlineAtMs: expiry,
    timeProgress: elapsed / (interval * 60_000),
    nextGateAtMs: next < expiry ? next : null,
    lastGate: null,
    requirementsMet: 3,
    requirementsTotal: 4,
    policySource: "experimental market-based policy",
    executionCutoffAtMs: null,
    remainingRequirement: "Needs more same-side evidence",
    components: {
      sameSideMs: 15_000, requiredSameSideMs: 24_000, validCount: 4, requiredCount: 3,
      probabilityRange: .02, maximumRange: .045, strength: .72, requiredStrength: .72,
      recentReversals: 0, trendKind: "FLAT_STABLE",
    },
  };
}

function roundDecision(interval: 5 | 15, state: TimedState): RoundDecision {
  const startMs = now - state.elapsedMs;
  return {
    format: "waterx-live-decision-v2", streamId: `timed-stream-${interval}`, network: "sui:mainnet",
    intervalMinutes: interval, roundId: `round-${interval}-shared`, startMs, expiryMs: startMs + interval * 60_000,
    policyVersion: lockPolicy(interval).version, stateVersion: 8, updatedAtMs: now, publishedAtMs: now,
    readiness: {
      state: "LEANING", score: 50, side: "UP", probability: .64, evaluatedAtMs: now,
      secondsRemaining: 100, sameSideMs: 2000, earliestPossibleAtMs: now + 1000,
      reason: "Conditions are still building.", health: "WAITING FOR EVIDENCE",
      components: { strength: .64, requiredStrength: .7, persistenceMs: 2000, requiredPersistenceMs: 12000,
        range: .03, reversals: 0, observationCount: 4, ageMs: 1200, gapReset: false, velocity: 0,
        acceleration: 0, sourceHealthy: true, withinWindow: true, fresh: true, stable: false },
    },
    market: { probabilityUp: .64, probabilityDown: .36, observedAtMs: now, receivedAtMs: now - 1200, providerOddsAtMs: null },
    persistence: { status: "WAITING_CHECKPOINT", updatedAtMs: now, errorClass: null },
    canonical: null, timedDecision: state,
    componentHealth: { priceFeed: "AVAILABLE", decisionService: "AVAILABLE", storage: "UNKNOWN", orderAdapter: "UNVERIFIED" },
    latestSafeOrderAtMs: null, executionWindowRemainingMs: null, executionBlocker: "UNVERIFIED_ORDER_ADAPTER",
    tradeAllowed: false,
    timestampSemantics: "Application receipt/evaluation/publication clocks; provider odds time unknown; commit is application acknowledgement",
  };
}

function renderDesk(decision: RoundDecision | null, fresh = true, options: {
  interval?: 5 | 15;
  round?: { id: string; startMs: number; expiryMs: number } | null;
  savedDecision?: AtomicDecisionView["savedDecision"];
  overrideSavedDecision?: boolean;
  provisionalLean?: "UP" | "DOWN" | null;
} = {}) {
  const state = decision?.timedDecision ?? null;
  const interval = options.interval ?? decision?.intervalMinutes ?? 5;
  const exactRound = decision ? { id: decision.roundId, startMs: decision.startMs, expiryMs: decision.expiryMs } : null;
  const view: AtomicDecisionView = {
    decision, fresh, sourceAgeMs: fresh ? 1_200 : 25_000,
    lean: fresh ? state?.liveSide ?? null : null, stage: "LEANING", score: fresh ? 50 : null,
    reason: fresh ? "Current same-round observation." : "Current round evidence is not fresh enough.",
    projectionVersion: "waterx-exact-round-client-v1", sourceProjectionVersion: "test-v3",
    intervalMinutes: decision?.intervalMinutes ?? null, roundIdentity: exactRound,
    strategyVersion: state?.strategyVersion ?? null, snapshotVersion: decision?.stateVersion ?? null,
    componentTimestamps: {}, provisionalLean: options.provisionalLean === undefined
      ? fresh ? state?.liveSide ?? null : null
      : options.provisionalLean,
    lastGate: state?.lastGate ?? null, nextGateAtMs: state?.nextGateAtMs ?? null,
    savedDecision: options.overrideSavedDecision ? options.savedDecision ?? null : state?.saved ?? null,
    persistenceState: decision?.persistence.status ?? null,
  };
  return renderToStaticMarkup(React.createElement(ManualOpportunity, {
    view, now, interval, round: options.round === undefined ? exactRound : options.round,
  }));
}

function history(interval: 5 | 15, record: TimedDecision): TimedHistoryResponse {
  return { strategyVersion, entries: [record], metrics: { n: 1, onTimeLocks: 0, deadlineLocks: 1, missed: 0, noValidInput: 0, settledN: 0 } };
}

test("a fresh lean updates continuously while the next qualification gate remains separately scheduled", () => {
  for (const interval of [5, 15] as const) {
    const state = gateTimed(interval, 45_000);
    const html = renderDesk(roundDecision(interval, state));
    assert.match(html, /Next gate<\/span><strong>00:15/);
    assert.match(html, /LEANING UP/);
    assert.match(html, /WaterX market/);
    assert.doesNotMatch(html, /MANDATORY DECISION|HARD DEADLINE|readinessPercent|02:20 \/ 05:00/);
  }
});

test("the four visible indicators represent timed qualification conditions, not win probability", () => {
  const markup = renderDesk(roundDecision(5, gateTimed(5, 48_000)));
  assert.match(markup, /Qualification progress: 3 of 4 conditions met/);
  for (const label of ["Fresh input", "Directional strength", "Same-side persistence", "Stable evidence"]) assert.match(markup, new RegExp(`title="${label}"`));
  assert.match(markup, /WaterX market/);
  assert.doesNotMatch(markup, /50% confidence|readinessPercent|win probability/i);
});

test("saved DOWN remains frozen in compact primary state without legacy evidence diagnostics", () => {
  const state = timed(5, 140_000, "EVALUATING");
  state.saved = savedRecord(5);
  state.persistence = "COMMITTED";
  const markup = renderDesk(roundDecision(5, state), false);
  assert.match(markup, /LOCKED DOWN/);
  assert.match(markup, /Saved decision is frozen/);
  assert.match(markup, /Saved round choice/);
  assert.match(markup, /WaterX market/);
  assert.match(markup, /Frozen WaterX market probability/);
  assert.doesNotMatch(markup, /LOCKED UP/);
  assert.doesNotMatch(markup, /observation-immutable-7|timed-decision-5-shared/);
});

test("saved late choice is immutable and does not imply a current opposite lean",()=>{
  const state=timed(5,151000,"DEADLINE");
  state.saved={...savedRecord(5),onTime:false,operationalFailure:"COMMIT_AFTER_HARD_DEADLINE"};
  state.persistence="COMMITTED";
  const markup=renderDesk(roundDecision(5,state));
  assert.match(markup,/LOCKED DOWN/);
  assert.match(markup,/Saved decision is frozen/);
  assert.doesNotMatch(markup,/LOCKED UP/);
});

test("non-choice timed outcomes remain watching and do not fabricate a lock side", () => {
  const noInput = timed(15, 450_000, "DEADLINE");
  noInput.persistence = "COMMITTED";
  noInput.saved = savedRecord(15, "NO_VALID_INPUT");
  const missed = timed(5, 160_000, "DEADLINE");
  missed.persistence = "COMMITTED";
  missed.saved = savedRecord(5, "MISSED_DEADLINE");
  const noInputMarkup = renderDesk(roundDecision(15, noInput), false);
  const missedMarkup = renderDesk(roundDecision(5, missed), false);
  assert.match(noInputMarkup, /WATCHING/);
  assert.match(noInputMarkup, /SAME SIDE PERSISTENCE INCOMPLETE/);
  assert.doesNotMatch(noInputMarkup, /LOCKED (?:UP|DOWN)|Saved lock/);
  assert.match(missedMarkup, /WATCHING/);
  assert.doesNotMatch(missedMarkup, /LOCKED (?:UP|DOWN)|Saved lock/);
});

test("a legacy canonical choice cannot override the current strategy's timed saved lock", () => {
  const state = gateTimed(5, 121_000);
  const currentSaved = {
    ...savedRecord(5),
    strategyVersion: gateStrategyVersion,
    side: "DOWN" as const,
    probabilityUp: .38,
    probabilityDown: .62,
    startMs: now - state.elapsedMs,
    expiryMs: now - state.elapsedMs + 5 * 60_000,
    decisionAtMs: now - 1_000,
    elapsedMs: state.elapsedMs - 1_000,
    committedAtMs: now - 500,
    targetAtMs: now - 1_000,
    hardDeadlineAtMs: now + 1_000,
    gateIndex: 4,
    gateScheduledAtMs: now - 1_000,
  };
  state.saved = currentSaved;
  state.persistence = "COMMITTED";
  const current = roundDecision(5, state);
  current.canonical = { side: "UP", probabilityUp: .81, decisionAtMs: now - 3_000, committedAtMs: now - 2_000 };
  const markup = renderDesk(current, true, {
    overrideSavedDecision: true,
    savedDecision: currentSaved,
    provisionalLean: "UP",
  });
  assert.match(markup, /LOCKED DOWN/);
  assert.match(markup, /Saved lock · DOWN/);
  assert.match(markup, /UP 38\.0%/);
  assert.match(markup, /DOWN 62\.0%/);
  assert.match(markup, /WaterX market/);
  assert.doesNotMatch(markup, /LOCKED UP/);
});

test("stale provisional lean is withheld while current odds retain permanent placeholder positions", () => {
  const state = gateTimed(5, 80_000);
  const html = renderDesk(roundDecision(5, state), false, { provisionalLean: null });
  assert.match(html, /WATCHING/);
  assert.doesNotMatch(html, /LEANING UP/);
  assert.match(html, /WaterX market/);
  assert.match(html, /probability-up"><span>UP<\/span><strong>—<\/strong>/);
  assert.match(html, /probability-down"><span>DOWN<\/span><strong>—<\/strong>/);
  assert.match(html, /MARKET DATA/);
});

test("exact round and selected interval are required to show a current lean", () => {
  const current = roundDecision(5, gateTimed(5, 45_000));
  const mismatchRound = renderDesk(current, true, {
    round: { id: "different-round", startMs: current.startMs, expiryMs: current.expiryMs },
  });
  const mismatchInterval = renderDesk(current, true, { interval: 15 });
  for (const html of [mismatchRound, mismatchInterval]) {
    assert.doesNotMatch(html, /LEANING UP|LOCKED UP/);
    assert.match(html, /Waiting for an exact active-round snapshot/);
  }
});

test("history renders both intervals and repeats the exact authoritative desk decision ID", () => {
  for (const interval of [5, 15] as const) {
    const record = savedRecord(interval);
    const state = timed(interval, interval === 5 ? 140_000 : 320_000, "EVALUATING");
    state.saved = record;
    state.persistence = "COMMITTED";
    const desk = renderDesk(roundDecision(interval, state));
    const rows = renderToStaticMarkup(React.createElement(TimedDecisionHistoryRecords, { interval, data: history(interval, record) }));
    assert.doesNotMatch(desk, new RegExp(record.id));
    assert.match(rows, new RegExp(record.id));
    assert.match(rows, /Early strategy records/);
    assert.match(rows, /DOWN locked/);
    assert.match(rows, /Correctness is not trading P\/L/);
  }
});

test("history scorecard distinguishes correctness from delivery and uses cohort aggregates", () => {
  const record = { ...savedRecord(5), onTime: false, result: "CORRECT" as const, verifiedOutcome: "DOWN" as const };
  const data: TimedHistoryResponse = {
    strategyVersion: "waterx-early-baseline-v2",
    entries: [record],
    metrics: {
      n: 42, onTimeLocks: 31, deadlineLocks: 8, missed: 3, noValidInput: 1, settledN: 28,
      correct: 17, incorrect: 11, pending: 9, disputed: 2, hitRate: 17 / 28,
      ratio: "17:11", choiceCoverage: 39 / 42, onTimeCoverage: 31 / 42, medianElapsedMs: 58_000,
      deadlineMisses: 4, operationalFailures: 6, operationalCoverage: .86,
    },
  };
  const markup = renderToStaticMarkup(React.createElement(TimedDecisionHistoryRecords, { interval: 5, data }));
  assert.match(markup, /Correct prediction · late operational miss/);
  assert.match(markup, /verified outcome/i);
  assert.match(markup, /CORRECT/);
  assert.match(markup, /60\.7%/);
  assert.match(markup, /17:11/);
  assert.match(markup, /42/);
  assert.match(markup, /Correctness is not trading P\/L/);
  assert.match(markup, /Missed deadlines \/ late locks/);
  assert.match(markup, /Operational failures<\/span><b>6/);
  assert.match(markup, /Operational coverage<\/span><b>86\.0%/);
  assert.match(markup, /DATA_FAILURE is an operational failure, not a missed deadline/);
});

test("older history reports label legacy missed as operational failures, not guessed deadline misses", () => {
  const data = history(5, savedRecord(5));
  const markup = renderToStaticMarkup(React.createElement(TimedDecisionHistoryRecords, { interval: 5, data }));
  assert.match(markup, /Deadline misses · not reported/);
  assert.match(markup, /Operational failures · legacy missed<\/span><b>0/);
  assert.match(markup, /shown here as operational failures rather than inferred deadline misses/);
  const source = readFileSync(new URL("./TimedDecisionHistory.tsx", import.meta.url), "utf8");
  assert.match(source, /useState<Strategy>\("waterx-qualification-gates-v3"\)/);
});

test("history separates source, qualification, scheduler and persistence operational outcomes", () => {
  const record = {
    ...savedRecord(5),
    operationalReasons: ["source-unavailable", "persistence-failure"],
  };
  const markup = renderToStaticMarkup(React.createElement(TimedDecisionHistoryRecords, {
    interval: 5,
    data: {
      strategyVersion: gateStrategyVersion, entries: [record],
      metrics: {
        n: 1, onTimeLocks: 0, deadlineLocks: 0, missed: 1, noValidInput: 0, settledN: 0,
        operationalBreakdown: {
          sourceUnavailable: 1, noQualifiedSignal: 2, schedulerMissedGate: 3, persistenceFailure: 4,
          gates: { sourceUnavailable: 5, noQualifiedSignal: 6, schedulerMissedGate: 7 },
        },
      },
    },
  }));
  for (const reason of ["Source unavailable", "No qualified signal", "Scheduler missed gate", "Persistence failure",
    "Gate source unavailable", "Gate no qualified signal", "Gate scheduler missed"]) assert.match(markup, new RegExp(reason));
  assert.match(markup, /Operational reasons<\/span><b>source-unavailable · persistence-failure/);
  assert.match(markup, /<span>Persistence failure<\/span><b>4/);
});

test("Agent uses the same ManualOpportunity and corrected server clock; history endpoint is interval scoped", () => {
  const agent = readFileSync(new URL("./AgentCurrentRound.tsx", import.meta.url), "utf8");
  const historyPage = readFileSync(new URL("./CanonicalHistory.tsx", import.meta.url), "utf8");
  const historyComponent = readFileSync(new URL("./TimedDecisionHistory.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(agent, /<ManualOpportunity view=\{timedView\}/);
  assert.match(agent, /projectServerClock\(timedServerTime, timedLive\.atomicUpdated, now\)/);
  assert.match(agent, /<details className="agent-benchmarks">/);
  assert.match(historyPage, /<TimedDecisionHistory \/>/);
  assert.match(historyPage, /<TimedStrategyHistory interval=/);
  assert.match(historyPage, /Full gate audit and historical strategy filters/);
  assert.match(historyComponent, /timed-history\?\$\{query\}/);
  assert.match(historyComponent, /new URLSearchParams\(\{ interval: String\(interval\), strategy, window, limit: String\(limit\) \}\)/);
  assert.match(historyComponent, /correct\?: number/);
  assert.match(historyComponent, /CORRECT.*INCORRECT.*PENDING.*DISPUTED/s);
  assert.match(historyComponent, /credentials: "include"/);
  assert.match(app, /<Route path="\/" component=\{LivePage\} \/>/);
  assert.match(app, /<Route path="\/agent" component=\{AgentPage\} \/>/);
  assert.match(app, /<Route path="\/history" component=\{CanonicalHistory\} \/>/);
});

test("timed snapshots require exact absolute windows and saved records cannot regress across stream swaps", () => {
  const state = timed(5, 140_000, "EVALUATING");
  const record = savedRecord(5);
  state.saved = record;
  state.persistence = "COMMITTED";
  const payload: LiveSnapshotEnvelope = {
    serverTime: new Date(now).toISOString(),
    intervalMinutes: 5,
    round: { id: record.roundId, startMs: record.startMs, expiryMs: record.expiryMs },
    decision: roundDecision(5, state),
  };
  assert.equal(validateDecisionSnapshot(payload, 5), null);

  const wrongWindow = structuredClone(payload);
  wrongWindow.decision!.timedDecision!.targetAtMs += 1000;
  assert.equal(validateDecisionSnapshot(wrongWindow, 5), "TIMED_STATE_INVALID");

  const swapped = structuredClone(payload);
  swapped.decision!.streamId = "replacement-stream";
  swapped.decision!.stateVersion = 1;
  swapped.decision!.timedDecision!.saved!.id = "replacement-decision-id";
  assert.equal(validateDecisionSnapshot(swapped, 5, payload), "IMMUTABLE_TIMED_DECISION_REGRESSION");
});

test("v3 snapshot validation binds expiry, qualification gates, and the saved gate acknowledgement grace", () => {
  const elapsed = 121_000;
  const state = gateTimed(5, elapsed);
  const startMs = now - elapsed;
  const scheduledAt = startMs + 120_000;
  const saved: TimedDecision = {
    ...savedRecord(5),
    strategyVersion: gateStrategyVersion,
    startMs,
    expiryMs: startMs + 5 * 60_000,
    elapsedMs: elapsed,
    targetAtMs: scheduledAt,
    hardDeadlineAtMs: scheduledAt + 2_000,
    decisionAtMs: now,
    committedAtMs: now,
    onTime: true,
    receivedAtMs: scheduledAt,
    coverage: { n: 3, firstAtMs: scheduledAt - 20_000, lastAtMs: scheduledAt, maxGapMs: 10_000 },
    gateIndex: 4,
    gateScheduledAtMs: scheduledAt,
  };
  state.saved = saved;
  state.persistence = "COMMITTED";
  const payload: LiveSnapshotEnvelope = {
    serverTime: new Date(now).toISOString(), intervalMinutes: 5,
    round: { id: saved.roundId, startMs, expiryMs: saved.expiryMs },
    decision: roundDecision(5, state),
  };
  assert.equal(validateDecisionSnapshot(payload, 5), null);
  const wrongAckWindow = structuredClone(payload);
  wrongAckWindow.decision!.timedDecision!.saved!.hardDeadlineAtMs = scheduledAt + 3_000;
  assert.equal(validateDecisionSnapshot(wrongAckWindow, 5), "TIMED_LOCKED_CHOICE_INVALID");
  const legacyMutation = structuredClone(payload);
  legacyMutation.decision!.timedDecision!.strategyVersion = "waterx-early-baseline-v2";
  assert.equal(validateDecisionSnapshot(legacyMutation, 5), "TIMED_STATE_INVALID");
});

test("gate history displays intentional abstention and keeps gate journals separate from lock scoring", () => {
  const record = {
    ...savedRecord(5, "ABSTAINED_NO_QUALIFIED_SIGNAL"),
    strategyVersion: gateStrategyVersion,
    result: "ABSTENTION" as const,
  };
  const markup = renderToStaticMarkup(React.createElement(TimedDecisionHistoryRecords, {
    interval: 5,
    data: {
      strategyVersion: gateStrategyVersion, entries: [record],
      metrics: { n: 1, onTimeLocks: 0, deadlineLocks: 0, missed: 0, noValidInput: 0, settledN: 0,
        abstentionRate: 1, operationalFailureRate: 0 },
    },
  }));
  assert.match(markup, /Abstained · no qualified signal/);
  assert.match(markup, /Abstention rate/);
  assert.match(markup, /Operational failure rate/);
  assert.match(markup, /Scored sample count<\/span><b>0/);
  assert.match(markup, /Intentional abstention · excluded from prediction scoring/);
  assert.doesNotMatch(markup, /Operationally late/);
});
