import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("./BluewaterResearchPanel.tsx", import.meta.url), "utf8");
const choice = readFileSync(new URL("./ResearchChoiceCard.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

test("Bluewater and database research reports remain separate from the atomic live choice", () => {
  assert.match(app, /`\/api\/waterx\/bluewater\?interval=\$\{interval\}`/);
  assert.match(app, /`\/api\/waterx\/research\?interval=\$\{interval\}`/);
  assert.match(app, /useApi<BluewaterReport>\(bluewaterUrl,/);
  assert.match(app, /bluewater\.loadedUrl === bluewaterUrl && bluewater\.data\?\.intervalMinutes === interval/);
  assert.match(panel, /WaterX Market Baseline is a separate market observation, not an independent AI model/);
  assert.match(choice, /LIVE WATERX MARKET · SAME ATOMIC SNAPSHOT/);
  assert.match(choice, /recentChoices/);
  assert.doesNotMatch(choice, /WaterX Market Baseline|currentChoice|liveProbabilities/);
});

test("absent champion and shadow-only forecasts never produce a qualified Bluewater probability", () => {
  assert.match(panel, /!hasChampion \? "NOT YET QUALIFIED"/);
  assert.match(panel, /No qualified Bluewater probability is available/);
  assert.match(panel, /forecastStatus !== "CHAMPION"/);
  assert.match(panel, /forecastStatus === "SHADOW"/);
  assert.match(panel, /SHADOW FORECAST · RESEARCH ONLY · not a qualified Bluewater probability/);
  assert.match(panel, /!round \|\| forecast\.roundId !== round\.id/);
});

test("raw and calibrated probabilities are provenance-labeled and require a matching champion forecast", () => {
  assert.match(panel, /FROZEN RAW PROBABILITY · UP/);
  assert.match(panel, /FROZEN CALIBRATED PROBABILITY · UP/);
  assert.match(panel, /forecast\.artifactId !== champion\.artifactId/);
  assert.match(panel, /forecast\.modelFamily !== champion\.modelFamily/);
  assert.match(panel, /forecast\.modelVersion !== champion\.modelVersion/);
  assert.match(panel, /report\.status !== "QUALIFIED" \|\| report\.qualifiedCalibration !== true/);
  assert.match(panel, /forecast\.startMs !== round\.startMs \|\| forecast\.expiryMs !== round\.expiryMs/);
});

test("compact Bluewater report keeps all layouts within the phone viewport", () => {
  assert.match(css, /\.bluewater-report, \.bluewater-report > \*, \.bluewater-report \* \{ min-width: 0; \}/);
  assert.match(css, /\.bluewater-count-grid \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.bluewater-count-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 380px\)[\s\S]*?\.bluewater-training, \.bluewater-probability, \.bluewater-comparison \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.bluewater-mistake-list article \{ display: grid; gap: 4px; min-width: 0;/);
  assert.match(app, /<BluewaterResearchPanel/);
});