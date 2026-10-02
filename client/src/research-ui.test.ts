import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const choice = readFileSync(new URL("./ResearchChoiceCard.tsx", import.meta.url), "utf8");
const learning = readFileSync(new URL("./ResearchLearningPanel.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

test("research report is interval-polled and never fetched during existing live fixtures", () => {
  assert.match(app, /`\/api\/waterx\/research\?interval=\$\{interval\}`/);
  assert.match(app, /useApi<ResearchReport>\(researchUrl, 3000, !fixtureMode\)/);
  assert.match(app, /research\.loadedUrl === researchUrl && research\.data\?\.intervalMinutes === interval/);
  assert.match(app, /fixtureMode \? "DEVELOPMENT-ONLY FIXTURES" : "DEVELOPMENT PREVIEW"/);
  assert.match(app, /<details className="fixture-banner fixture-picker"/);
  assert.match(app, /window\.innerWidth > 760 \|\| !!fixtureMode/);
  assert.match(app, /onToggle=\{event => setFixtureControlsOpen\(event\.currentTarget\.open\)\}/);
  assert.match(app, /"Live API observations · no fixture active"/);
  assert.match(app, /"synthetic test data · live polling disabled"/);
});

test("a locked choice is isolated to the exact report interval, round ID, start, and expiry", () => {
  assert.match(choice, /report\.intervalMinutes !== interval/);
  assert.match(choice, /report\.currentRound\?\.id !== round\.id/);
  assert.match(choice, /choice\.roundId !== round\.id/);
  assert.match(choice, /choice\.startMs !== round\.startMs \|\| choice\.expiryMs !== round\.expiryMs/);
  assert.match(choice, /currentChoice/);
  assert.match(choice, /NO_VALID_CHOICE/);
  assert.match(choice, /Awaiting checkpoint/);
});

test("choice, live market baseline, settlement, and entry disclaimer stay explicitly distinct", () => {
  assert.match(choice, /Market baseline/);
  assert.match(choice, /BluewaterAI model/);
  assert.match(choice, /"Market baseline"/);
  assert.match(choice, /CHECKPOINT MARKET SNAPSHOT/);
  assert.match(choice, /Not captured until the choice checkpoint/);
  assert.match(choice, /not the live WaterX odds/);
  assert.match(choice, /className="research-choice-audit"/);
  assert.match(choice, /No model · market baseline/);
  assert.match(choice, /Reason in round details/);
  assert.match(choice, /No-choice reason/);
  assert.match(choice, /Live WaterX odds update independently/);
  assert.match(choice, /estimate\.roundId === round\.id/);
  assert.match(choice, /estimate\.intervalMinutes === interval/);
  assert.match(choice, /estimateFresh/);
  assert.match(choice, /Date\.now\(\) - estimateAt <= 10_000/);
  assert.match(choice, /not the locked choice/);
  assert.match(choice, /Research prediction · not an entry recommendation/);
  assert.match(choice, /Settlement pending/);
  assert.match(choice, /Correct/);
  assert.match(choice, /Incorrect/);
  assert.doesNotMatch(choice, /HIGH_LIKELIHOOD|FAVORABLE_RISK_REWARD|advisory/);
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
  assert.match(css, /\.research-live-estimate\.is-unavailable \{ display: none; \}/);
  assert.match(css, /\.research-choice-result-full \{ display: none; \}/);
  assert.match(css, /\.live-page \.chart-distance-readout \{ display: none; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.research-choice-card, \.research-report, \.research-skeleton \{ animation: none/);
});