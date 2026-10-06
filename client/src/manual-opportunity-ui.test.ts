import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoundDecision } from "../../shared/round-decision";
import { lockPolicy } from "../../shared/lock-readiness";
import type { WaterxDataHealth } from "../../shared/waterx-data-health";
import { ManualOpportunity } from "./ManualOpportunity";
import { getAtomicDecisionView, type LiveSnapshotEnvelope } from "./live-decision-contract";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./ManualOpportunity.css", import.meta.url), "utf8");
const source = readFileSync(new URL("./ManualOpportunity.tsx", import.meta.url), "utf8");
const now = 1_700_000_020_000;

function snapshot(interval: 5 | 15 = 5, overrides: Partial<RoundDecision> = {}, probability = .72) {
  const round = { id: `desk-${interval}`, startMs: now - 20_000, expiryMs: now + interval * 60_000 - 20_000 };
  const decision: RoundDecision = {
    format: "waterx-live-decision-v2", streamId: `stream-${interval}`, network: "sui:mainnet",
    intervalMinutes: interval, roundId: round.id, startMs: round.startMs, expiryMs: round.expiryMs,
    policyVersion: lockPolicy(interval).version, stateVersion: 4, updatedAtMs: now, publishedAtMs: now,
    readiness: {
      state: "LEANING", score: 61, side: "UP", probability, evaluatedAtMs: now,
      secondsRemaining: interval * 60 - 20, sameSideMs: 12_000, earliestPossibleAtMs: now,
      reason: "Same-round observations are developing.", health: "CURRENT",
      components: {
        strength: .7, requiredStrength: .6, persistenceMs: 12_000, requiredPersistenceMs: 10_000,
        range: .02, reversals: 0, observationCount: 6, ageMs: 0, gapReset: false,
        velocity: .001, acceleration: 0, sourceHealthy: true, withinWindow: true, fresh: true, stable: true,
      },
    },
    market: { probabilityUp: probability, probabilityDown: 1 - probability, observedAtMs: now, receivedAtMs: now, providerOddsAtMs: null },
    persistence: { status: "WAITING_CHECKPOINT", updatedAtMs: now, errorClass: null },
    canonical: null, latestSafeOrderAtMs: null, executionWindowRemainingMs: null,
    executionBlocker: "Research only.", tradeAllowed: false,
    timestampSemantics: "Application timestamps; provider odds timestamp unknown.",
    ...overrides,
  };
  const envelope: LiveSnapshotEnvelope = {
    serverTime: new Date(now).toISOString(), intervalMinutes: interval, round, decision,
  };
  return { round, envelope, decision };
}
function health(status: WaterxDataHealth["probabilities"]["status"], lastValid: WaterxDataHealth["probabilities"]["lastValid"] = null): WaterxDataHealth {
  const primaryReason = status === "CURRENT" ? "CURRENT" : status;
  return {
    transport: { status: "HEALTHY", lastReceivedAtMs: now, errorClass: null },
    round: { status: "KNOWN" }, reference: { status: "CONFIRMED" },
    probabilities: { status, lastValid }, storage: { status: "UNKNOWN", errorClass: null },
    execution: { eligible: false, reason: "Research only." }, primaryReason,
  };
}
function render(interval: 5 | 15, view: ReturnType<typeof getAtomicDecisionView>, options: {
  pending?: boolean; error?: string; round?: { id: string; startMs: number; expiryMs: number } | null;
  fixtureName?: string;
} = {}) {
  return renderToStaticMarkup(React.createElement(ManualOpportunity, {
    view, now, interval, round: options.round, refresh: { pending: !!options.pending, error: options.error ?? "" },
    onRetry: () => {}, fixtureName: options.fixtureName,
    marketReference: { price: 83_500, quality: "confirmed", source: "WaterX" },
    comparison: { price: 83_517.25, source: "Coinbase comparison", receivedAtMs: now - 500 },
  }));
}

test("normal 5m and 15m rounds share the compact exact-round decision projection", () => {
  for (const interval of [5, 15] as const) {
    const { round, envelope } = snapshot(interval);
    const view = getAtomicDecisionView(envelope, interval, round, now);
    const markup = render(interval, view);
    assert.match(markup, new RegExp(`· ${interval}m`));
    assert.match(markup, /LEANING UP/);
    assert.match(markup, /\$83,517\.25/);
    assert.match(markup, /\$83,500\.00/);
    assert.match(markup, /\+\$17\.25/);
    assert.match(markup, /WaterX market/);
    assert.equal(view.projectionVersion, "waterx-exact-round-client-v1");
    assert.equal(view.snapshotVersion, 4);
    assert.equal(view.roundIdentity?.id, round.id);
  }
});

test("missing odds have one calm notice while comparison and exact price difference remain independent", () => {
  const { round, envelope } = snapshot(5, { market: null });
  const outage = health("PROBABILITIES_MISSING");
  const withHealth = { ...envelope, dataHealth: outage, decision: { ...envelope.decision!, dataHealth: outage } };
  const view = getAtomicDecisionView(withHealth, 5, round, now);
  const markup = render(5, view);
  assert.match(markup, /WAITING FOR ODDS/);
  assert.equal(markup.match(/WaterX odds unavailable\. Live BTC chart remains available\./g)?.length, 1);
  assert.match(markup, /\$83,517\.25/);
  assert.match(markup, /\+\$17\.25/);
  assert.doesNotMatch(markup, /0% confidence|0\.0%/);
});

test("last same-round odds are stale only in Details and never produce a current lean", () => {
  const { round, envelope } = snapshot();
  const outage = health("PROBABILITIES_STALE", {
    up: .72, down: .28, receivedAtMs: now - 15_000, ageMs: 15_000,
  });
  const withHealth = { ...envelope, dataHealth: outage, decision: { ...envelope.decision!, dataHealth: outage } };
  const view = getAtomicDecisionView(withHealth, 5, round, now);
  const markup = render(5, view);
  assert.match(markup, /WATCHING/);
  assert.doesNotMatch(markup, /LEANING UP/);
  assert.match(markup, /<summary>Details<\/summary>[\s\S]*Stale · UP 72\.0% · DOWN 28\.0%/);
  assert.doesNotMatch(markup.slice(0, markup.indexOf("<details")), /72\.0%/);
});

test("a saved immutable choice remains prominent during a probability outage", () => {
  const { round, envelope } = snapshot(15, {
    market: null,
    canonical: { side: "DOWN", probabilityUp: .39, decisionAtMs: now - 2_000, committedAtMs: null },
    persistence: { status: "COMMITTED", updatedAtMs: now - 1_000, errorClass: null },
    readiness: {
      state: "WATCHING", score: 0, side: null, probability: null, evaluatedAtMs: now,
      secondsRemaining: 880, sameSideMs: 0, earliestPossibleAtMs: null,
      reason: "Waiting for current probability input.", health: "PROBABILITIES STALE",
      components: {
        strength: .7, requiredStrength: .6, persistenceMs: 0, requiredPersistenceMs: 10_000,
        range: .02, reversals: 0, observationCount: 0, ageMs: 15_000, gapReset: false,
        velocity: 0, acceleration: 0, sourceHealthy: false, withinWindow: true, fresh: false, stable: false,
      },
    },
  });
  const outage = health("PROBABILITIES_STALE", { up: .72, down: .28, receivedAtMs: now - 15_000, ageMs: 15_000 });
  const withHealth = { ...envelope, dataHealth: outage, decision: { ...envelope.decision!, dataHealth: outage } };
  const view = getAtomicDecisionView(withHealth, 15, round, now);
  const markup = render(15, view);
  assert.match(markup, /LOCKED DOWN/);
  assert.match(markup, /saved and remains unchanged/);
  assert.doesNotMatch(markup, /LOCKED UP/);
  assert.match(markup, /DOWN · immutable/);
});

test("initial loading is neutral; request failure gets one functional retry control", () => {
  const empty = { decision: null, fresh: false, sourceAgeMs: null, lean: null, stage: "WATCHING", score: null, reason: "Waiting for a valid active-round snapshot.", projectionVersion: "waterx-exact-round-client-v1", intervalMinutes: null, roundIdentity: null, strategyVersion: null, snapshotVersion: null, componentTimestamps: {}, provisionalLean: null, lastGate: null, nextGateAtMs: null, savedDecision: null, persistenceState: null } as const;
  const loading = render(5, empty, { pending: true });
  assert.match(loading, /desk-skeleton/);
  assert.doesNotMatch(loading, /role="status">WATCHING|DATA DELAYED|Legacy schedule/);
  const failed = render(5, empty, { error: "NETWORK_ERROR" });
  assert.match(failed, /Live snapshot could not refresh/);
  assert.match(failed, /Retry/);
});

test("rollover withholds old round state; visual lock fixture is marked development-only", () => {
  const { round, envelope } = snapshot();
  const view = getAtomicDecisionView(envelope, 5, round, now);
  const nextRound = { ...round, id: "new-round", startMs: now, expiryMs: now + 300_000 };
  const rollover = render(5, view, { round: nextRound });
  assert.doesNotMatch(rollover, /LEANING UP|LOCKED UP/);
  assert.match(rollover, /Waiting for an exact active-round snapshot/);
  const visualLock = render(5, getAtomicDecisionView(null, 5, null, now), { fixtureName: "locked" });
  assert.match(visualLock, /LOCKED UP/);
  assert.match(visualLock, /Synthetic visual state only/);
  assert.match(visualLock, /Development visual fixture/);
});

test("chart is the next live-desk area, archive coverage stays explicitly rolling, and layout is compact on mobile", () => {
  assert.ok(app.indexOf("<ManualOpportunity") < app.indexOf("<section className=\"chart-panel\">"));
  assert.match(app, /does not describe complete coverage of the current round/);
  assert.match(app, /active-round window; archive coverage is separate/);
  assert.match(css, /@media \(max-width: 600px\)/);
  assert.match(css, /@media \(max-width: 350px\)/);
  assert.match(source, /Qualification conditions/);
  assert.doesNotMatch(source, /economics|expected return|NO EXECUTION/);
  assert.match(app, /import\.meta\.env\.DEV && fixtureNames\.includes/);
});
