import test from "node:test";
import assert from "node:assert/strict";
import { advisorForLive, NEUTRAL_BAND } from "../server/btc/advisor";

const now = 1_800_000_000_000;
const round = { now, roundStartMs: now - 20_000, expiryMs: now + 36_000 };
const market = (up: number, asOf = new Date(now - 1000).toISOString()) =>
  ({ up, down: 1 - up, asOf });

test("fresh DeepBook probabilities support an explicitly market-derived bias without a model", () => {
  const advice = advisorForLive({ ...round, indicative: market(.61) });
  assert.equal(advice.bias, "UP BIAS");
  assert.equal(advice.source, "Market-derived bias");
  assert.equal(advice.reliability, "Unrated");
  assert.equal(advice.tradeValue, "ECONOMICS UNAVAILABLE");
  assert.match(advice.explanation, /independent trade edge unverified/);
  assert.equal(advisorForLive({ ...round, indicative: market(.35) }).bias, "DOWN BIAS");
});

test("neutral band is only a presentation policy, never an edge threshold", () => {
  assert.deepEqual(NEUTRAL_BAND, { lower: .45, upper: .55 });
  for (const up of [.45, .5, .55]) {
    const advice = advisorForLive({ ...round, indicative: market(up) });
    assert.equal(advice.bias, "BALANCED");
    assert.equal(advice.tradeValue, "ECONOMICS UNAVAILABLE");
  }
});

test("stale, future, wrong-round, and malformed prices fail closed", () => {
  for (const q of [
    market(.6, new Date(now - 15_000).toISOString()),
    market(.6, new Date(now + 1).toISOString()),
    market(.6, new Date(round.roundStartMs - 1).toISOString()),
    { ...market(.6), down: .6 },
  ]) {
    const advice = advisorForLive({ ...round, indicative: q });
    assert.equal(advice.bias, "WAITING FOR DATA");
    assert.equal(advice.source, null);
  }
  assert.equal(advisorForLive({ ...round, expiryMs: now - 1, indicative: market(.8) }).bias, "WAITING FOR DATA");
});

test("a validated forecast is distinct from indicative market odds; economics remain unavailable", () => {
  const advice = advisorForLive({ ...round, indicative: market(.8),
    validatedForecast: { ...market(.42), reliability: "Limited" } });
  assert.equal(advice.bias, "DOWN BIAS");
  assert.equal(advice.source, "Model-derived bias");
  assert.equal(advice.reliability, "Limited");
  assert.equal(advice.tradeValue, "ECONOMICS UNAVAILABLE");
});

test("late manual timing disables trade assessment without erasing a fresh market bias", () => {
  const advice = advisorForLive({ ...round, expiryMs: now + 12_000, indicative: market(.65) });
  assert.equal(advice.bias, "UP BIAS");
  assert.equal(advice.tradeValue, "TOO LATE");
  assert.match(advice.tradeReason, /18 seconds/);
});