import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("./index.css", import.meta.url), "utf8");
const manual = readFileSync(new URL("./ManualOpportunity.tsx", import.meta.url), "utf8");
const liveDesk = appSource.slice(appSource.indexOf("function LivePage()"), appSource.indexOf("function PriceChart"));

test("the live desk has one compact exact-round decision card before the chart", () => {
  assert.ok(appSource.indexOf("<ManualOpportunity") < appSource.indexOf("<section className=\"chart-panel\">"));
  assert.doesNotMatch(liveDesk, /<RoundDecisionPanel|<AdvisoryCards|<ResearchChoiceCard|<BluewaterResearchPanel/);
  assert.match(manual, /identityMatches\(decision, exactRound\)/);
  assert.match(manual, /const exactFresh = !!exactDecision && view\.fresh/);
  assert.match(manual, /exactFresh \? exactDecision\.market : fixtureOdds/);
  assert.match(manual, /exactDecision\?\.canonical/);
});

test("the top decision shows source facts without economic or execution claims", () => {
  assert.match(manual, /BTC comparison/);
  assert.match(manual, /WaterX price to beat/);
  assert.match(manual, /WaterX market/);
  assert.doesNotMatch(manual, /economics|expected return|payout|execution window/i);
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