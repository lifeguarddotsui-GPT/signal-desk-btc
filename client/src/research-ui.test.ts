import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const choice = readFileSync(new URL("./ResearchChoiceCard.tsx", import.meta.url), "utf8");
const learning = readFileSync(new URL("./ResearchLearningPanel.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

test("research report is interval-polled and never fetched during existing live fixtures", () => {
  assert.match(app, /`\/api\/waterx\/research\?interval=\$\{interval\}`/);
  assert.match(app, /useApi<ResearchReport>\(researchUrl, 60000, !fixtureMode\)/,
    "Historical context must not add a high-frequency database poll to live readiness.");
  assert.match(app, /research\.loadedUrl === researchUrl && research\.data\?\.intervalMinutes === interval/);
  assert.match(app, /fixtureMode \? "DEVELOPMENT-ONLY FIXTURES" : "DEVELOPMENT PREVIEW"/);
  assert.match(app, /<details className="fixture-banner fixture-picker"/);
  assert.match(app, /window\.innerWidth > 760 \|\| !!fixtureMode/);
  assert.match(app, /onToggle=\{event => setFixtureControlsOpen\(event\.currentTarget\.open\)\}/);
  assert.match(app, /"Live API observations · no fixture active"/);
  assert.match(app, /"synthetic test data · live polling disabled"/);
});

test("current round choice and odds use one exact atomic decision projection", () => {
  assert.match(app, /getAtomicDecisionView\(atomicEnvelope, interval, decisionRound, serverNow\)/);
  assert.equal((app.match(/view=\{atomicDecisionView\}/g) ?? []).length, 3);
  assert.match(choice, /const decision = view\.decision/);
  assert.match(choice, /view\.fresh \? view\.lean : null/);
  assert.match(choice, /view\.fresh \? decision\?\.market/);
  assert.match(choice, /canonical = decision\?\.canonical/);
  assert.doesNotMatch(choice, /currentChoice|liveModelEstimate|liveProbabilities|report\?\.lifecycle/);
});

test("current state cannot be sourced from database reports; historical results are isolated", () => {
  assert.match(choice, /LIVE WATERX MARKET · SAME ATOMIC SNAPSHOT/);
  assert.match(choice, /HISTORICAL VERIFIED ROUND · NOT CURRENT STATE/);
  assert.match(choice, /recentChoices/);
  assert.match(choice, /item\.roundId !== round\?\.id/);
  assert.match(choice, /research-snapshot-version/);
  assert.match(choice, /no wallet, transaction, order or execution status/i);
  assert.doesNotMatch(choice, /report\.currentChoice|report\.liveProbabilities|report\.liveModelEstimate|report\?\.lifecycle/);
});

test("learning shows only returned scoring and truthful daily-job state", () => {
  assert.match(learning, /window\.brier/);
  assert.match(learning, /window\.logLoss/);
  assert.match(learning, /accuracyPercent/);
  assert.match(learning, /window\.scoredChoices/);
  assert.match(learning, /window\.verifiedSettlements/);
  assert.match(learning, /noChoiceReasons/);
  assert.match(learning, /dailyJob/);
  assert.match(learning, /guaranteesDailyExecution/);
  assert.match(learning, /featureCoverageFailures/);
  assert.match(learning, /referenceDiscrepancies/);
  assert.match(learning, /Research evidence unavailable/);
  assert.match(learning, /scheduledCheckpoints/);
  assert.match(learning, /unobservedCheckpoints/);
  assert.match(learning, /Recent round ledger · historical exact-round records/);
  assert.match(learning, /settlement\.state === "disputed"/);
  assert.match(learning, /settlement\.state === "withheld"/);
  assert.match(learning, /No valid choice/);
  assert.match(learning, /\.slice\(0, 20\)/);
  assert.match(learning, /FORWARD SHADOW EVALUATION/);
  assert.match(learning, /No forward shadow forecasts yet \(recorded N = 0\)/);
  assert.match(learning, /Candidate training readiness is reported separately/);
  assert.match(learning, /marketBaseline/);
  assert.match(learning, /shadowOnly === true/);
  assert.match(learning, /Reference discrepancy cohorts/i);
  assert.match(learning, /"changed", "unchanged", "unavailable"/);
  assert.match(learning, /AFTER-LABEL AUDIT · NOT A PREDICTOR FEATURE/);
  assert.match(learning, /Lock-horizon comparison/i);
  assert.match(learning, /Directional calibration/);
  assert.match(learning, /Features present in mistakes/);
  assert.match(learning, /Market odds alone do not establish trading profitability/);
  assert.match(app, /LEGACY FITTED-BASELINE AUDIT/);
  assert.match(app, /LEGACY CONFIRMED-ONLY CANDIDATE AUDIT/);
});

test("phone layout is single column and respects reduced motion", () => {
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.research-support-grid, \.research-breakdown-grid \{ grid-template-columns: 1fr/);
  assert.match(css, /\.research-report \{ min-width: 0; grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /\.research-report > \* \{ min-width: 0; max-width: 100%; \}/);
  assert.match(css, /\.research-choice-audit \{ display: none; \}/);
  assert.match(css, /\.research-choice-side \{ display: contents; \}/);
  assert.match(css, /\.research-checkpoint-snapshot \{ display: none; \}/);
  assert.match(css, /\.research-live-estimate\.is-unavailable, \.research-live-estimate\.is-available \{ display: flex/);
  assert.match(css, /\.research-live-market/);
  assert.match(css, /\.research-choice-card\.is-final/);
  assert.match(css, /\.live-page \.chart-distance-readout \{ display: none; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.research-choice-card, \.research-report, \.research-skeleton \{ animation: none/);
});