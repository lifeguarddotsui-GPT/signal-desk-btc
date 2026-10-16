import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const live = readFileSync(new URL("./ManualOpportunity.tsx", import.meta.url), "utf8");
const history = readFileSync(new URL("./CanonicalHistory.tsx", import.meta.url), "utf8");

test("active 30-second benchmark precedes optional shadow locks on live desk", () => {
  const benchmark = live.indexOf('className="desk-section-title">Bluewater decision');
  const stage = live.indexOf('<TwoStageDeskRows projection={twoStageProjection}');
  assert.ok(benchmark >= 0 && stage > benchmark);
  assert.match(live, /Only an acknowledged, frozen exact-round choice is scored/);
  assert.match(live, /OPTIONAL EARLY \/ CONFIRMATION EXPERIMENTS/);
});

test("confirmation state is explicit and never scores an unavailable model as incorrect", () => {
  assert.match(live, /CONFIRMATION_POLICY_NOT_QUALIFIED/);
  assert.match(live, /Confirmation disabled on this server/);
  assert.match(live, /No historical prediction is counted as incorrect/);
  assert.match(live, /!confirmation && candidate.confirmationMode === "UNAVAILABLE"/);
});

test("round history first shows active benchmark, with lazy independent cohorts", () => {
  const footer = history.slice(history.indexOf("export default function CanonicalHistory()"));
  assert.ok(footer.indexOf("<TimedStrategyHistory interval={5}") >= 0);
  assert.ok(footer.indexOf("<TimedStrategyHistory interval={15}") >= 0);
  assert.ok(footer.indexOf("<TwoStageHistory/>") > footer.indexOf("<TimedStrategyHistory interval={15}"));
  assert.match(footer, /stagesOpen&&/);
  assert.match(footer, /archiveOpen&&<LegacyCanonicalHistory\/>/);
  assert.match(footer, /Unobserved rounds during visitor-only idle periods must not be counted as losses/);
});
