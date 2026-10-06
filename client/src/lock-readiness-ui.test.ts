import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoundDecision } from "../../shared/round-decision";
import { lockPolicy } from "../../shared/lock-readiness";
import { RoundDecisionPanel } from "./LockReadinessPanel";
import { ResearchChoiceCard } from "./ResearchChoiceCard";
import { getAtomicDecisionView, type LiveSnapshotEnvelope } from "./live-decision-contract";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("./LockReadinessPanel.tsx", import.meta.url), "utf8");
const choiceSource = readFileSync(new URL("./ResearchChoiceCard.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

const startMs = 1_700_000_000_000;
const now = startMs + 10_000;
const round = { id: "round-exact-01", startMs, expiryMs: startMs + 300_000 };

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

test("live desk uses the atomic snapshot hook and passes one view to both current-state components", () => {
  assert.match(app, /useLiveSnapshot<LivePayload>\(liveUrl, interval, !fixtureMode\)/);
  assert.doesNotMatch(app.slice(0, app.indexOf("function HealthPage")), /const live = useApi<LivePayload>/);
  assert.match(app, /live\.atomicLoadedUrl === liveUrl/);
  assert.match(app, /validatedAtomicSnapshot\.current/);
  assert.match(app, /serverNow < cachedRound\.expiryMs/);
  assert.match(app, /!verifiedDifferentRound/);
  assert.match(app, /getAtomicDecisionView\(atomicEnvelope, interval, decisionRound, serverNow\)/);
  assert.match(app, /atomicOddsAsOfMs === decisionMarket\.observedAtMs/);
  assert.match(app, /atomicOdds\.up === decisionMarket\.probabilityUp && atomicOdds\.down === decisionMarket\.probabilityDown/);
  assert.match(app, /atomicDecisionView\.fresh && atomicQuoteMatchesDecision/);
  assert.equal((app.match(/view=\{atomicDecisionView\}/g) ?? []).length, 3);
  assert.equal((app.match(/round=\{decisionRound\}/g) ?? []).length, 2);
  assert.match(app, /browserReceivedAtMs=\{live\.atomicUpdated\}/);
  assert.doesNotMatch(app, /live\.error && live\.errorUrl === liveUrl && payload == null \? <ErrorBox/);
  assert.doesNotMatch(choiceSource, /currentChoice|liveProbabilities|liveModelEstimate/);
  assert.match(panelSource, /export type RoundDecisionEvidence = RoundDecision/);
  assert.match(app, /`\/api\/waterx\/refresh-health\?interval=\$\{interval\}`/);
  assert.match(app, /PROCESS-LOCAL · NO DATABASE READ/);
  assert.match(app, /comparisonFresh \? comparison\?\.source/);
  assert.match(app, /streamCoinbaseFresh \? latestStreamPoint\?\.source/);
  assert.match(app, /typeof body\.source === "string" \? body\.source : "Not reported"/);
  assert.match(app, /not durable coverage, proof of a persisted round, or trade evidence/);
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
});

test("compact readiness and blocker remain placed above the chart on narrow screens and desktop", () => {
  assert.ok(app.indexOf("<RoundDecisionPanel") < app.indexOf("<section className=\"chart-panel\">"));
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.round-decision-facts \{ grid-template-columns: repeat\(2/);
  assert.match(css, /@media \(max-width: 390px\)[\s\S]*?\.round-decision-detail/);
  assert.match(panelSource, /LATEST SAFE ORDER TIME<\/span><strong>Unknown/);
  assert.match(panelSource, /EXECUTION WINDOW<\/span><strong>Unknown/);
});
