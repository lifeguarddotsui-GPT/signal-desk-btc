import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceContext } from "../server/btc/evidence";

test("evidence quality cannot be presented as model confidence", () => {
  const now = 100_000;
  const result = evidenceContext({
    now, hasRound: true, referencePrice: 80_000, indicativeUp: .61,
    comparisonPrice: 80_010, points: [
      { at: now - 30_000, price: 80_000 },
      { at: now - 15_000, price: 80_005 },
      { at: now - 1_000, price: 80_010 },
    ], promotedModel: false,
  });
  assert.equal(result.evidence.score, 75);
  assert.equal(result.evidence.checksPassed, 4);
  assert.equal(result.evidence.checksTotal, 5);
  assert.equal(result.decisionSupport.marketTilt, "UP");
  assert.equal(result.decisionSupport.comparisonDistance, 10);
  assert.equal(result.decisionSupport.comparisonChange, 10);
  assert.equal(result.decisionSupport.comparisonWindowSeconds, 29);
  assert.equal(result.decisionSupport.comparisonSampleCount, 3);
  assert.equal(result.decisionSupport.comparisonHasGaps, false);
  assert.match(result.evidence.meaning, /not a calibrated prediction/);
});

test("missing inputs and a gap suppress evidence and indicative tilt", () => {
  const result = evidenceContext({
    now: 200_000, hasRound: false, referencePrice: null, indicativeUp: null,
    comparisonPrice: null, points: [
      { at: 100_000, price: 10 }, { at: 160_000, price: 11 },
      { at: 199_000, price: 12 },
    ], promotedModel: false,
  });
  assert.equal(result.evidence.score, 0);
  assert.equal(result.decisionSupport.marketTilt, "UNAVAILABLE");
  assert.equal(result.decisionSupport.comparisonDistance, null);
  assert.equal(result.decisionSupport.comparisonHasGaps, true);
});

test("an almost balanced indicative board does not create a directional tilt", () => {
  const result = evidenceContext({
    now: 200_000, hasRound: true, referencePrice: 80_000, indicativeUp: .51,
    comparisonPrice: null, points: [], promotedModel: false,
  });
  assert.equal(result.decisionSupport.marketTilt, "BALANCED");
  assert.equal(result.evidence.score, 50);
});