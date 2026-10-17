import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const app=readFileSync(new URL("../client/src/App.tsx",import.meta.url),"utf8");
const desk=readFileSync(new URL("../client/src/ManualOpportunity.tsx",import.meta.url),"utf8");
const css=readFileSync(new URL("../client/src/ManualOpportunity.css",import.meta.url),"utf8");
test("opposite real screenshot prices may be correct for different feeds; render neutral, never a WaterX DOWN claim",()=>{
  const anchor=81224.97,waterxOraclePreview=81234.56,coinbaseSpot=81219.00;
  assert.ok(waterxOraclePreview-anchor>0);
  assert.ok(coinbaseSpot-anchor<0);
  assert.ok(Math.abs(waterxOraclePreview-coinbaseSpot-15.56)<1e-6);
  assert.match(app,/const tone = "neutral";/);
  assert.doesNotMatch(app,/const tone = anchor == null \|\| latest\?\.price == null \? "neutral"/);
  assert.match(app,/DO NOT TRADE FROM THIS CHART COLOR/);
  assert.match(app,/NO WaterX price-to-beat line/);
  assert.match(app,/anchor=\{null\} referenceConfirmed=\{false\}/);
  assert.match(app,/COINBASE SPOT ONLY .*historical\/stale/);
  assert.doesNotMatch(app,/className="reference-zone-above"/);
  assert.doesNotMatch(app,/className="reference-zone-below"/);
});
test("cross-source gap visible and never styled as WaterX trade direction",()=>{
  assert.match(desk,/Spot\/reference gap · NOT WaterX direction/);
  assert.match(desk,/is-cross-source/);
  assert.doesNotMatch(desk,/desk-price-difference\$\{priceDifference/);
  assert.match(css,/\.desk-price-difference\.is-cross-source strong/);
});
test("release preserves independent order and settlement, no new chart fetch or paid poll",()=>{
  assert.match(app,/sourceMismatch = !isCoinbaseSource/);
  assert.match(app,/selectWaterxReference\(/);
  assert.match(app,/waterxReferenceValid/);
  assert.match(app,/Live API/);
  assert.match(desk,/Automatic execution is disabled/);
});
