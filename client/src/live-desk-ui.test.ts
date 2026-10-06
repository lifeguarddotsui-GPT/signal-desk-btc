import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ManualOpportunity } from "./ManualOpportunity";
import type { AtomicDecisionView } from "./live-decision-contract";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("./index.css", import.meta.url), "utf8");
const manual = readFileSync(new URL("./ManualOpportunity.tsx", import.meta.url), "utf8");
const liveDesk = appSource.slice(appSource.indexOf("function LivePage()"), appSource.indexOf("function PriceChart"));

test("the live desk places one shared live decision before the existing chart without canonical fallbacks", () => {
  assert.ok(appSource.indexOf("<ManualOpportunity") < appSource.indexOf("<section className=\"chart-panel\">"));
  assert.doesNotMatch(liveDesk, /<RoundDecisionPanel|<AdvisoryCards|<ResearchChoiceCard|<BluewaterResearchPanel/);
  assert.match(manual, /identityMatches\(decision, exactRound\)/);
  assert.match(manual, /const savedProjection = exactDecision \? view\.savedDecision : null/);
  assert.match(manual, /view\.provisionalLean/);
  assert.doesNotMatch(manual, /exactDecision\?\.canonical|exactDecision\.canonical/);
});

test("the top decision shows source facts without economic or execution claims", () => {
  assert.match(manual, /BTC comparison/);
  assert.match(manual, /WaterX price to beat/);
  assert.match(manual, /WaterX market/);
  assert.match(manual, /WaterX market/);
  assert.match(manual, /Automatic execution is disabled/);
  assert.doesNotMatch(manual, /expected return|expected net|place order|buy now/i);
});

test("empty live data renders permanent WaterX percentage positions instead of hiding the market row", () => {
  const view: AtomicDecisionView = {
    decision: null, fresh: false, sourceAgeMs: null, lean: null, stage: "WATCHING", score: null,
    reason: "Waiting for exact-round evidence.", projectionVersion: "waterx-exact-round-client-v1",
    sourceProjectionVersion: null, intervalMinutes: null, roundIdentity: null, strategyVersion: null,
    snapshotVersion: null, componentTimestamps: {}, provisionalLean: null, lastGate: null,
    nextGateAtMs: null, savedDecision: null, persistenceState: null,
  };
  const markup = renderToStaticMarkup(React.createElement(ManualOpportunity, { view, now: 1_700_000_020_000, interval: 5 }));
  assert.match(markup, /probability-up"><span>UP<\/span><strong>—<\/strong>/);
  assert.match(markup, /probability-down"><span>DOWN<\/span><strong>—<\/strong>/);
  assert.match(markup, /WaterX market/);
  assert.match(markup, /no trained-model fallback/);
  assert.match(markup, /read-only market research/);
});

test("compact live-desk styles support mobile widths and reduced motion", () => {
  assert.match(styleSource, /@media \(max-width: 700px\)/);
  assert.match(styleSource, /prefers-reduced-motion: reduce/);
});

test("development fixtures disable every live polling hook and the comparison stream", () => {
  assert.match(appSource, /useLiveSnapshot<LivePayload>\(liveUrl, interval, !fixtureMode\)/);
  assert.match(appSource, /useApi<ChartPayload>\(chartUrl, 30000, !fixtureMode\)/);
  assert.match(appSource, /useApi<Record<string, unknown>>\(learningUrl, 60000, !fixtureMode\)/);
  assert.match(appSource, /useApi<WaterxHealth>\(healthUrl, 10000, !fixtureMode\)/);
  assert.match(appSource, /useApi<RefreshHealthReport>\(refreshHealthUrl, 5000\)/);
  assert.match(appSource, /if \(fixtureMode\) \{ setStreamStatus\("FIXTURE"\); return; \}/);
  assert.match(appSource, /"normal".*"loading".*"request-failure".*"rollover".*"locked"/);
  assert.match(appSource, /fixtureMode === "loading" \|\| fixtureMode === "request-failure"/);
});

test("learning evidence surfaces prospective-capture status, gates, and unknown history honestly", () => {
  assert.match(appSource, /candidate\?\.prospectiveCapture/);
  assert.match(appSource, /prospectiveCapture\?\.requiredGates/);
  assert.match(appSource, /Per-round historical skip reasons were not retained/);
  assert.match(appSource, /capture-warning/);
});