import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoundDecision } from "../../shared/round-decision";
import type { ProbabilityState, WaterxDataHealth } from "../../shared/waterx-data-health";
import { lockPolicy } from "../../shared/lock-readiness";
import { RoundDecisionPanel } from "./LockReadinessPanel";
import { ResearchChoiceCard } from "./ResearchChoiceCard";
import { AdvisoryCards } from "./AdvisoryCards";
import { ManualOpportunity } from "./ManualOpportunity";
import { getAtomicDecisionView, type LiveSnapshotEnvelope } from "./live-decision-contract";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("./LockReadinessPanel.tsx", import.meta.url), "utf8");
const choiceSource = readFileSync(new URL("./ResearchChoiceCard.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

const startMs = 1_700_000_000_000;
const now = startMs + 10_000;
const round = { id: "round-exact-01", startMs, expiryMs: startMs + 300_000 };
function dataHealth(probabilityStatus: ProbabilityState, primaryReason: WaterxDataHealth["primaryReason"],
  transportStatus: WaterxDataHealth["transport"]["status"] = "HEALTHY",
  lastValid: WaterxDataHealth["probabilities"]["lastValid"] = null): WaterxDataHealth {
  return {
    transport: { status: transportStatus, lastReceivedAtMs: now, errorClass: transportStatus === "HEALTHY" ? null : "PROVIDER_TIMEOUT" },
    round: { status: "KNOWN" }, reference: { status: "CONFIRMED" },
    probabilities: { status: probabilityStatus, lastValid },
    storage: { status: "COMMITTED", errorClass: null },
    execution: { eligible: false, reason: "Research only." }, primaryReason,
  };
}

function envelope(): LiveSnapshotEnvelope {
  const decision: RoundDecision = {
    format: "waterx-live-decision-v2",
    streamId: "stream-exact-01",
    network: "sui:mainnet",
    intervalMinutes: 5,
    roundId: round.id,
    startMs: round.startMs,
    expiryMs: round.expiryMs,
    policyVersion: lockPolicy(5).version,
    stateVersion: 7,
    updatedAtMs: now,
    publishedAtMs: now,
    readiness: {
      state: "LEANING",
      score: 82,
      side: "UP",
      probability: .61,
      evaluatedAtMs: now,
      secondsRemaining: 290,
      sameSideMs: 24_000,
      earliestPossibleAtMs: now,
      reason: "Fresh exact-round evidence; database commit acknowledged.",
      health: "WAITING FOR EVIDENCE",
      components: {
        strength: .68,
        requiredStrength: .65,
        persistenceMs: 24_000,
        requiredPersistenceMs: 12_000,
        range: .02,
        reversals: 0,
        observationCount: 9,
        ageMs: 100,
        gapReset: false,
        velocity: .001,
        acceleration: .001,
        sourceHealthy: true,
        withinWindow: true,
        fresh: true,
        stable: true,
      },
    },
    market: {
      probabilityUp: .61,
      probabilityDown: .39,
      observedAtMs: now,
      receivedAtMs: now - 100,
      providerOddsAtMs: null,
    },
    persistence: { status: "COMMITTED", updatedAtMs: now, errorClass: null },
    canonical: { side: "UP", probabilityUp: .61, decisionAtMs: now - 1000, committedAtMs: null },
    latestSafeOrderAtMs: null,
    executionWindowRemainingMs: null,
    executionBlocker: "No verified transaction route or order deadline.",
    tradeAllowed: false,
    timestampSemantics: "Application receipt/evaluation/publication clocks; provider odds time unknown; commit is application acknowledgement",
  };
  return { serverTime: new Date(now).toISOString(), intervalMinutes: 5, round, decision };
}

function renderBoth(view: ReturnType<typeof getAtomicDecisionView>, options?: {
  pending?: boolean; error?: string; failureCount?: number; retryCount?: number;
  round?: typeof round | null; now?: number;
}) {
  const activeRound = options?.round === undefined ? round : options.round;
  const renderNow = options?.now ?? now;
  const refresh = {
    pending: options?.pending ?? false,
    error: options?.error ?? "",
    retryCount: options?.retryCount ?? 0,
    failureCount: options?.failureCount ?? 0,
  };
  const panel = renderToStaticMarkup(React.createElement(RoundDecisionPanel, {
    view, interval: 5, round: activeRound, now: renderNow,
    browserReceivedAtMs: now - 400, refresh,
  }));
  const card = renderToStaticMarkup(React.createElement(ResearchChoiceCard, {
    report: null, interval: 5, round: activeRound, view, refresh, retrySnapshot: () => {},
  }));
  return { panel, card };
}

test("live desk uses one atomic snapshot projection for the compact current-state card", () => {
  assert.match(app, /useLiveSnapshot<LivePayload>\(liveUrl, interval, !fixtureMode\)/);
  assert.doesNotMatch(app.slice(0, app.indexOf("function HealthPage")), /const live = useApi<LivePayload>/);
  assert.match(app, /live\.atomicLoadedUrl === liveUrl/);
  assert.match(app, /validatedAtomicSnapshot\.current/);
  assert.match(app, /serverNow < cachedRound\.expiryMs/);
  assert.match(app, /!verifiedDifferentRound/);
  assert.match(app, /projectExactRoundDecision\(projectionEnvelope, interval, decisionRound, serverNow\)/);
  assert.match(app, /atomicOddsAsOfMs === decisionMarket\.observedAtMs/);
  assert.match(app, /atomicOdds\.up === decisionMarket\.probabilityUp && atomicOdds\.down === decisionMarket\.probabilityDown/);
  assert.match(app, /!fixtureMode && atomicDecisionView\.fresh/);
  assert.match(app, /<ManualOpportunity/);
  assert.equal((app.match(/view=\{atomicDecisionView\}/g) ?? []).length, 1);
  assert.doesNotMatch(app, /live\.error && live\.errorUrl === liveUrl && payload == null \? <ErrorBox/);
  assert.doesNotMatch(choiceSource, /currentChoice|liveProbabilities|liveModelEstimate/);
  assert.match(panelSource, /export type RoundDecisionEvidence = RoundDecision/);
});

test("a coherent fresh snapshot produces the same lean, canonical record and version in both components", () => {
  const snapshot = envelope();
  const view = getAtomicDecisionView(snapshot, 5, round, now);
  assert.equal(view.fresh, true);
  const { panel, card } = renderBoth(view);
  for (const markup of [panel, card]) {
    assert.match(markup, /LEANING UP/);
    assert.match(markup, /CANONICAL/);
    assert.match(markup, /state v?7/);
    assert.match(markup, /stream-exact-01/);
  }
  assert.match(panel, /No verified transaction route or order deadline/);
});

test("transient refresh pending and error preserve the same fresh lean and canonical record", () => {
  const view = getAtomicDecisionView(envelope(), 5, round, now);
  const { panel, card } = renderBoth(view, {
    pending: true, error: "NETWORK_ERROR", failureCount: 1, retryCount: 1,
  });
  for (const markup of [panel, card]) {
    assert.match(markup, /LEANING UP/);
    assert.match(markup, /CANONICAL/);
    assert.match(markup, /state v?7/);
    assert.match(markup, /NETWORK_ERROR/);
  }
  assert.match(panel, /retained same-round source age/);
  assert.match(card, /retaining the last valid record/);
});

test("awaiting-choice persistence is explicit backlog state, not a fabricated canonical lock", () => {
  const source = envelope();
  const decision = source.decision!;
  const awaitingChoice: LiveSnapshotEnvelope = {
    ...source,
    decision: {
      ...decision,
      stateVersion: decision.stateVersion + 1,
      canonical: null,
      persistence: { status: "AWAITING_CHOICE", updatedAtMs: now, errorClass: "WRITE_ACK_MISSING" },
    },
  };
  const view = getAtomicDecisionView(awaitingChoice, 5, round, now);
  const { panel, card } = renderBoth(view);
  for (const markup of [panel, card]) {
    assert.match(markup, /AWAITING_CHOICE/);
    assert.match(markup, /Checkpoint write finished without a frozen canonical choice/);
    assert.match(markup, /LEANING UP/);
  }
  assert.doesNotMatch(card, /CANONICAL CHOICE: UP/);
});

test("stale same-round evidence withholds live lean while preserving its immutable canonical record", () => {
  const staleNow = now + 15_000;
  const view = getAtomicDecisionView(envelope(), 5, round, staleNow);
  assert.equal(view.fresh, false);
  assert.equal(view.decision?.canonical?.side, "UP");
  const { panel, card } = renderBoth(view, { now: staleNow });
  for (const markup of [panel, card]) {
    assert.match(markup, /WITHHELD/);
    assert.match(markup, /CANONICAL/);
    assert.match(markup, /Source stale/);
    assert.doesNotMatch(markup, /LEANING UP/);
    assert.match(markup, /state v?7/);
  }
});

test("fresh metadata with both or one probability side missing reports probability absence, not round absence", () => {
  const snapshot = envelope();
  for (const lastValid of [null, { up: .61, down: .39, receivedAtMs: now - 5_000, ageMs: 5_000 }] as const) {
    const health = dataHealth("PROBABILITIES_MISSING", "PROBABILITIES_MISSING", "HEALTHY", lastValid);
    const current = { ...snapshot, dataHealth: health, decision: { ...snapshot.decision!, dataHealth: health } };
    const view = getAtomicDecisionView(current, 5, round, now);
    assert.equal(view.fresh, false);
    assert.equal(view.lean, null);
    assert.equal(view.dataHealth?.primaryReason, "PROBABILITIES_MISSING");
    assert.match(view.reason, /probabilities missing/i);
    assert.doesNotMatch(view.reason, /No verified active round/i);
    const manual = renderToStaticMarkup(React.createElement(ManualOpportunity, { view, now }));
    const cards = renderToStaticMarkup(React.createElement(AdvisoryCards, {
      advisory: {
        state: "OBSERVE", reason: "No qualified evidence.",
        identity: { marketId: "market-01", roundId: round.id, intervalMinutes: 5, startMs: round.startMs, expiryMs: round.expiryMs },
        sides: { up: { state: "OBSERVE", quote: {} }, down: { state: "OBSERVE", quote: {} } },
      },
      expectedIdentity: { marketId: "market-01", roundId: round.id, intervalMinutes: 5, startMs: round.startMs, expiryMs: round.expiryMs },
      roundCurrent: true, quoteCurrent: false, locked: { up: false, down: false }, nowMs: now,
      dataHealth: view.dataHealth,
      marketOdds: { up: "Unavailable", down: "Unavailable", current: false, source: "WaterX" },
    }));
    // Older adaptive locks are not current-strategy saved decisions.
    assert.match(manual, /WATCHING/);
    assert.doesNotMatch(manual, /LOCKED UP/);
    assert.match(manual, /PROBABILITIES MISSING/);
    assert.match(cards, /WaterX probabilities missing; active round metadata is available/);
  }
});

test("invalid probability pair, provider timeout and locally aged current pair all suppress fresh projection", () => {
  const base = envelope();
  const invalid = dataHealth("PROBABILITY_PAIR_INVALID", "PROBABILITY_PAIR_INVALID");
  const invalidView = getAtomicDecisionView({ ...base, dataHealth: invalid }, 5, round, now);
  assert.equal(invalidView.fresh, false);
  assert.equal(invalidView.reason, "WaterX probability pair invalid; not usable as live evidence.");

  const timeout = dataHealth("PROBABILITIES_STALE", "PROVIDER_TIMEOUT", "PROVIDER_TIMEOUT");
  const timeoutView = getAtomicDecisionView({ ...base, dataHealth: timeout }, 5, round, now);
  assert.equal(timeoutView.fresh, false);
  assert.match(timeoutView.reason, /request timed out/i);

  const recovered = dataHealth("CURRENT", "CURRENT", "HEALTHY", {
    up: .61, down: .39, receivedAtMs: now - 100, ageMs: 100,
  });
  const recoveredView = getAtomicDecisionView({ ...base, dataHealth: recovered }, 5, round, now);
  assert.equal(recoveredView.fresh, true);
  assert.equal(recoveredView.reason, base.decision!.readiness.reason);

  const current = dataHealth("CURRENT", "CURRENT", "HEALTHY", {
    up: .61, down: .39, receivedAtMs: now - 1_000, ageMs: 1_000,
  });
  const agedView = getAtomicDecisionView({ ...base, dataHealth: current }, 5, round, now + 11_001);
  assert.equal(agedView.fresh, false);
  assert.equal(agedView.dataHealth?.probabilities.status, "PROBABILITIES_STALE");
  assert.equal(agedView.dataHealth?.probabilities.lastValid?.ageMs, 12_001);
  assert.match(agedView.reason, /last observation is not current/i);
});

test("round mismatch and rollover withhold previous canonical state in both components", () => {
  const snapshot = envelope();
  const nextRound = { ...round, id: "round-next-02", startMs: round.startMs + 300_000, expiryMs: round.expiryMs + 300_000 };
  const mismatched = getAtomicDecisionView(snapshot, 5, nextRound, now);
  const mismatchMarkup = renderBoth(mismatched, { round: nextRound });
  for (const markup of [mismatchMarkup.panel, mismatchMarkup.card]) {
    assert.match(markup, /identity mismatch/i);
    assert.doesNotMatch(markup, /CANONICAL CHOICE: UP/);
    assert.doesNotMatch(markup, /LEANING UP/);
  }
  assert.match(mismatchMarkup.panel, /aria-valuetext="Unavailable"/);
  assert.doesNotMatch(mismatchMarkup.panel, /aria-valuenow=/);
  assert.match(mismatchMarkup.card, /No exact snapshot/);

  const rollover = getAtomicDecisionView(snapshot, 5, null, now + 300_000);
  const rolloverMarkup = renderBoth(rollover, { round: null, now: now + 300_000 });
  for (const markup of [rolloverMarkup.panel, rolloverMarkup.card]) {
    assert.match(markup, /Waiting for a valid active-round snapshot/);
    assert.doesNotMatch(markup, /CANONICAL CHOICE: UP/);
    assert.doesNotMatch(markup, /LEANING UP/);
  }
  const outage = dataHealth("PROBABILITIES_STALE", "PROVIDER_TIMEOUT", "PROVIDER_TIMEOUT");
  const outageSnapshot = { ...snapshot, dataHealth: outage, decision: { ...snapshot.decision!, dataHealth: outage } };
  const outageRollover = getAtomicDecisionView(outageSnapshot, 5, null, now + 300_000);
  assert.equal(outageRollover.decision, null);
  assert.equal(outageRollover.dataHealth, undefined);
});

test("compact decision stays immediately above the chart and retains explicit agent details", () => {
  assert.ok(app.indexOf("<ManualOpportunity") < app.indexOf("<section className=\"chart-panel\">"));
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(readFileSync(new URL("./AgentCurrentRound.tsx", import.meta.url), "utf8"), /<details className="agent-benchmarks">/);
  assert.match(panelSource, /LATEST SAFE ORDER TIME<\/span><strong>Unknown/);
  assert.match(panelSource, /EXECUTION WINDOW<\/span><strong>Unknown/);
});
