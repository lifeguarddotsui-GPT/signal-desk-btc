import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const cardSource = readFileSync(new URL("./AdvisoryCards.tsx", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("./index.css", import.meta.url), "utf8");

test("opportunity styling is driven by the validator's exact per-side state", () => {
  assert.match(cardSource, /assessment\.state/);
  assert.match(cardSource, /assessment\.qualified && state !== "OBSERVE"/);
  assert.match(cardSource, /"HIGH_LIKELIHOOD", "FAVORABLE_RISK_REWARD"/);
  assert.match(cardSource, /data-classification=\{presentedState\}/);
});

test("independent verified model and quote facts stay available when edge state is OBSERVE", () => {
  assert.match(cardSource, /const modelAvailable = ui\.modelAvailable === true/);
  assert.match(cardSource, /const quoteAvailable = ui\.quoteAvailable === true/);
  assert.match(cardSource, /const modelProbability = modelAvailable/);
  assert.match(cardSource, /const economicsAvailable = quoteAvailable && !!verifiedEconomics/);
  assert.match(cardSource, /dollars\(verifiedEconomics\.totalCostUsd\)/);
  assert.match(cardSource, /const isQualifiedState = assessment\.qualified && state !== "OBSERVE"/);
});

test("reduced motion leaves the risk/reward assessment as a static bordered state", () => {
  assert.match(styleSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.advisory-card\.favorable-risk-reward::after[\s\S]*?animation:\s*none/);
  assert.match(styleSource, /\.advisory-card\.favorable-risk-reward::after[\s\S]*?animation:\s*risk-reward-halo 4\.8s/);
});

test("development fixtures disable every live polling hook and the comparison stream", () => {
  assert.match(appSource, /useApi<LivePayload>\(liveUrl, 3000, !fixtureMode\)/);
  assert.match(appSource, /useApi<ChartPayload>\(chartUrl, 30000, !fixtureMode\)/);
  assert.match(appSource, /useApi<Record<string, unknown>>\(learningUrl, 60000, !fixtureMode\)/);
  assert.match(appSource, /useApi<WaterxHealth>\(healthUrl, 10000, !fixtureMode\)/);
  assert.match(appSource, /if \(fixtureMode\) \{ setStreamStatus\("FIXTURE"\); return; \}/);
});

test("learning evidence surfaces prospective-capture status, gates, and unknown history honestly", () => {
  assert.match(appSource, /candidate\?\.prospectiveCapture/);
  assert.match(appSource, /prospectiveCapture\?\.requiredGates/);
  assert.match(appSource, /Per-round historical skip reasons were not retained/);
  assert.match(appSource, /capture-warning/);
});