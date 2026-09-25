import test from "node:test";
import assert from "node:assert/strict";
import { evaluateBaseline, recommendation, strictWalkForward } from "../server/btc/engine";
import { oneMinuteMarket } from "../server/btc/source";

test("identifies a neighboring one-minute expiry; never assumes any lone market is one minute", () => {
  const mk = (id: string, expiry: number) => ({
    id, expiryMs: BigInt(expiry), tickSize: .01, admissionTickSize: 1,
    mintPaused: false, referencePrice: 80_000,
  });
  const now = 1790302750000;
  assert.equal(oneMinuteMarket([mk("one",1790302800000)],now), null);
  assert.equal(oneMinuteMarket([mk("one",1790302800000),mk("two",1790302860000)],now)?.id,"one");
  assert.equal(oneMinuteMarket([mk("one",1790302800000),mk("duplicate",1790302800000),mk("two",1790302860000)],now),null);
  assert.equal(oneMinuteMarket([mk("one",1790302800000),mk("two",1790302860000)],1790302860000),null);
});
test("fails closed for missing calibration, executable price, or time", () => {
  const base = { hasRound:true, expiryMs:100_000, now:50_000, referencePrice:80_000,
    estimatedUp:.7, executableUp:.5, executableDown:.5, payoutAfterFees:1,
    calibratedSamples:200, edgeThreshold:.05 };
  assert.equal(recommendation({ ...base, executableUp:null }).action,"HOLD");
  assert.equal(recommendation({ ...base, calibratedSamples:0 }).action,"HOLD");
  assert.equal(recommendation({ ...base, now:95_000 }).action,"HOLD");
  assert.equal(recommendation(base).action,"UP");
});
test("Brier/log loss and strict chronological split exclude overlap", () => {
  const rows = Array.from({length:200},(_,i)=>({id:`id-${i}`,expiryMs:i*60_000,
    outcome:(i%2 ? "UP":"DOWN") as "UP"|"DOWN",up:.5}));
  assert.equal(evaluateBaseline(rows,()=>.5)?.brier,.25);
  const split = strictWalkForward(rows);
  assert.equal(split?.test.length,50);
  assert.ok(split!.train.at(-1)!.expiryMs < split!.calibrate[0].expiryMs);
  assert.ok(split!.calibrate.at(-1)!.expiryMs < split!.test[0].expiryMs);
  assert.equal(strictWalkForward(rows.slice(0,199)),null);
});