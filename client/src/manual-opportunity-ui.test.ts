import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoundDecision } from "../../shared/round-decision";
import { lockPolicy } from "../../shared/lock-readiness";
import { ManualOpportunity } from "./ManualOpportunity";
import type { AtomicDecisionView } from "./live-decision-contract";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./ManualOpportunity.css", import.meta.url), "utf8");
const now = 1_700_000_020_000;
const round = { id: "manual-round-a", startMs: now - 20_000, expiryMs: now + 280_000 };

function decision(overrides: Partial<RoundDecision> = {}): RoundDecision {
  return {
    format: "waterx-live-decision-v2",
    streamId: "manual-stream-a",
    network: "sui:mainnet",
    intervalMinutes: 5,
    roundId: round.id,
    startMs: round.startMs,
    expiryMs: round.expiryMs,
    policyVersion: lockPolicy(5).version,
    stateVersion: 4,
    updatedAtMs: now,
    publishedAtMs: now,
    readiness: {
      state: "READY", score: 100, side: "UP", probability: .72, evaluatedAtMs: now,
      secondsRemaining: 280, sameSideMs: 30_000, earliestPossibleAtMs: now,
      reason: "Exact-round evidence remains fresh.", health: "WAITING FOR EVIDENCE",
      components: {
        strength: .8, requiredStrength: .65, persistenceMs: 30_000, requiredPersistenceMs: 12_000,
        range: .02, reversals: 0, observationCount: 12, ageMs: 0, gapReset: false,
        velocity: .001, acceleration: .001, sourceHealthy: true, withinWindow: true,
        fresh: true, stable: true,
      },
    },
    market: { probabilityUp: .72, probabilityDown: .28, observedAtMs: now, receivedAtMs: now, providerOddsAtMs: null },
    persistence: { status: "COMMITTED", updatedAtMs: now, errorClass: null },
    canonical: null,
    earlyDecision: {
      side: "DOWN", probabilityUp: .39, decisionAtMs: now - 1000, committedAtMs: now - 700,
      policyVersion: lockPolicy(5).version, observationId: "obs-4", eventId: "42", workerReceivedAtMs: now - 650,
    },
    earlyPersistence: { status: "SAVED", errorClass: null },
    opportunity: {
      sourceId: "waterx.public.crypto.v1", observationId: "quote-4", receivedAtMs: now - 500,
      providerEventAtMs: null, priceLastChangedAtMs: now - 15_000,
      reference: { price: 83_500, status: "confirmed" },
      marketId: "waterx-market-a", url: `https://waterx.app/en/predict/market/crypto/crypto-btc-updown-5m/${round.expiryMs/1000}`,
      orderCutoffAtMs: null, probabilityEvidence: "available",
      purchase: {
        up: { status: "reported", askCents: 40, marketObjectId: "yes-object", selection: "YES" },
        down: { status: "reported", askCents: 62, marketObjectId: "no-object", selection: "NO" },
      },
    },
    componentHealth: {
      priceFeed: "AVAILABLE", decisionService: "AVAILABLE", storage: "COMMITTED", orderAdapter: "UNVERIFIED",
    },
    latestSafeOrderAtMs: null,
    executionWindowRemainingMs: null,
    executionBlocker: "No measured safe execution time.",
    tradeAllowed: false,
    timestampSemantics: "Application receipt/evaluation/publication clocks; provider odds time unknown; commit is application acknowledgement",
    ...overrides,
  };
}

function render(view: AtomicDecisionView, receipt = now, pending = false) {
  return renderToStaticMarkup(React.createElement(ManualOpportunity, {
    view, now, browserReceivedAtMs: receipt, refresh: { pending, error: "" },
  }));
}

test("initial snapshot loading uses a quiet skeleton instead of an invented quote or spinner", () => {
  const markup = render({
    decision: null, fresh: false, sourceAgeMs: null, lean: null, stage: "WATCHING",
    score: null, reason: "Waiting for a valid active-round snapshot.",
  }, now, true);
  assert.match(markup, /Loading exact-round snapshot/);
  assert.match(markup, /mo-skeleton-lines/);
  assert.doesNotMatch(markup, /Data delayed · no exact-round decision snapshot|spinner/);
});

test("missing exact-round snapshot renders a composed delayed state and withholds purchase details", () => {
  const markup = render({
    decision: null, fresh: false, sourceAgeMs: null, lean: null, stage: "WATCHING",
    score: null, reason: "Waiting for a valid active-round snapshot.",
  });
  assert.match(markup, /Data delayed · no exact-round decision snapshot/);
  assert.match(markup, /No verified exact-round link/);
  assert.match(markup, /Readiness is decision progress, not win probability/);
  assert.doesNotMatch(markup, /UP · YES|DOWN · NO|40¢ \/ share/);
});

test("stale odds do not replace a saved early DOWN choice or switch to an available UP ask", () => {
  const savedDown = decision({
    opportunity: {
      ...decision().opportunity!,
      receivedAtMs: now - 15_000,
      purchase: {
        up: { status: "reported", askCents: 40, marketObjectId: "yes-object", selection: "YES" },
        down: { status: "unavailable", askCents: null, marketObjectId: null, selection: null },
      },
    },
  });
  const markup = render({
    decision: savedDown, fresh: false, sourceAgeMs: 15_000, lean: null,
    stage: "WATCHING", score: null, reason: "Source stale; saved record retained.",
  });
  assert.match(markup, /DOWN/);
  assert.match(markup, /Adaptive benchmark saved/);
  assert.match(markup, /DOWN purchase unavailable/);
  assert.match(markup, /Stale source receipt/);
  assert.match(markup, /Age is measured from app receipt, not last price change/);
  assert.doesNotMatch(markup, /40¢ \/ share/);
  assert.match(markup, /commit → browser Unknown/);
});

test("a locked side stays explicitly unavailable and keeps its verified provider route separate from ordering", () => {
  const locked = decision({
    opportunity: {
      ...decision().opportunity!,
      purchase: {
        up: { status: "reported", askCents: 41, marketObjectId: "yes-object", selection: "YES" },
        down: { status: "locked", askCents: null, marketObjectId: "no-object", selection: "NO" },
      },
    },
  });
  const markup = render({
    decision: locked, fresh: true, sourceAgeMs: 500, lean: "UP",
    stage: "READY", score: 100, reason: "Ready.",
  });
  assert.match(markup, /DOWN/);
  assert.match(markup, /DOWN purchase locked/);
  assert.match(markup, /View verified provider round/);
  assert.match(markup, /no in-app order submission/);
  assert.match(markup, /Net profit if correct<\/span><b>Unknown/);
  assert.match(markup, /ORDER ADAPTER<\/span><b>UNVERIFIED/);
});

test("one unavailable selected side preserves round data without substituting the available opposite purchase", () => {
  const singleSide = decision({
    earlyDecision: null,
    earlyPersistence: { status: "DEVELOPING", errorClass: null },
    opportunity: {
      ...decision().opportunity!,
      purchase: {
        up: { status: "reported", askCents: 41, marketObjectId: "yes-object", selection: "YES" },
        down: { status: "unavailable", askCents: null, marketObjectId: null, selection: null },
      },
    },
  });
  const markup = render({
    decision: singleSide, fresh: true, sourceAgeMs: 500, lean: "DOWN",
    stage: "LEANING", score: 61, reason: "Current lean is DOWN.",
  });
  assert.match(markup, /DOWN purchase unavailable/);
  assert.doesNotMatch(markup, /41¢ \/ share/);
  assert.match(markup, /28\.0%/);
  assert.match(markup, /Round reference \$83,500\.00 · confirmed/);
});

test("manual card is above the chart; audit readiness is collapsed and mobile layout has dedicated breakpoints", () => {
  assert.ok(app.indexOf("<ManualOpportunity") < app.indexOf("<section className=\"chart-panel\">"));
  assert.doesNotMatch(app, /className="metric-ribbon"|className="distance-line"/);
  assert.ok(app.indexOf("<details className=\"mo-readiness-audit\">") < app.indexOf("<RoundDecisionPanel"));
  assert.match(app, /browserReceivedAtMs=\{live\.atomicUpdated\}/);
  assert.match(app, /refresh=\{\{ pending: snapshotRefreshState\.pending, error: snapshotRefreshState\.error \}\}/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /@media \(max-width: 440px\)/);
});

test("primary card consolidates source prices, gate timing and an explicit qualification checklist", () => {
  const source = readFileSync(new URL("./ManualOpportunity.tsx", import.meta.url), "utf8");
  const markup = renderToStaticMarkup(React.createElement(ManualOpportunity, {
    view: { decision: decision({ timedDecision: null }), fresh: true, sourceAgeMs: 900, lean: "UP", stage: "LEANING", score: 60, reason: "Evidence is building." },
    now, marketReference: { price: 83_500, quality: "confirmed", source: "WaterX" },
    comparison: { price: 83_517.25, source: "Coinbase SSE", receivedAtMs: now - 900 },
  }));
  assert.match(markup, /Authoritative round research state/);
  assert.match(markup, /PRICE TO BEAT · CONFIRMED/);
  assert.match(markup, /\$83,500\.00/);
  assert.match(markup, /BTC COMPARISON · Coinbase SSE/);
  assert.match(markup, /\$83,517\.25/);
  assert.match(markup, /MARKET ODDS · CURRENT ONLY/);
  assert.match(markup, /CURRENT CONDITIONS CHECKLIST/);
  assert.match(app, /comparisonFresh \? comparison\?\.source/);
  assert.match(app, /source: coinbaseDisplaySource \|\| "Not reported"/);
  assert.doesNotMatch(app, /HTTP comparison|streamCoinbaseFresh \? "Coinbase SSE"/);
  assert.match(source, /CURRENT CONDITIONS · ROUND ELAPSED/);
  assert.doesNotMatch(source, /EVIDENCE READINESS/);
  assert.doesNotMatch(source, /readinessPercent/);
  assert.match(markup, /market probability · uncalibrated/i);
  assert.match(markup, /CURRENT CONDITIONS · ROUND ELAPSED/);
  assert.match(markup, /BENCHMARK DISCLOSURE · legacy canonical readiness/);
  assert.match(markup, /CURRENT WATERX PUBLIC MARKET PROBABILITY/);
  assert.match(source, /LAST GATE · SERVER-RECORDED/);
  assert.match(source, /NEXT SERVER-SCHEDULED GATE/);
});

test("unknown comparison provenance is withheld rather than defaulted to Coinbase", () => {
  const markup = renderToStaticMarkup(React.createElement(ManualOpportunity, {
    view: { decision: decision({ timedDecision: null }), fresh: true, sourceAgeMs: 900, lean: "UP", stage: "LEANING", score: 60, reason: "Evidence is building." },
    now,
  }));
  assert.match(markup, /BTC COMPARISON · Not reported/);
  assert.doesNotMatch(markup, /BTC COMPARISON · Coinbase/);
});
