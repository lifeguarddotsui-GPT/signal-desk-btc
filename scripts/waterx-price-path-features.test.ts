import assert from "node:assert/strict";
import test from "node:test";
import { measureWaterxPricePath, type PointInTimePrice } from "../server/waterx/price-path-features";

const end = Date.UTC(2026, 9, 25, 12, 3, 0);
const at = end + 1_000;
const samples = (prices: number[]): PointInTimePrice[] =>
  prices.map((price,i)=>({ price,sourceAtMs:end-60_000+i*10_000,
    receivedAtMs:end-60_000+i*10_000+250 }));

test("60-second green/red durations use time, not number of ticks", () => {
  const r = measureWaterxPricePath({
    decisionAtMs:at, anchorPrice:100, anchorConfirmed:true,
    ticks:samples([90,100,110,110,110,110,110]),
  });
  assert.equal(r.reason,null);
  assert.equal(r.features!.source,"COINBASE_PROXY_VS_WATERX_ANCHOR");
  assert.ok(Math.abs(r.features!.redSeconds - 10) < 1e-9);
  assert.ok(Math.abs(r.features!.greenSeconds - 50) < 1e-9);
  assert.ok(Math.abs(r.features!.greenAreaBpsSeconds - 45_000) < 1e-7);
  assert.ok(Math.abs(r.features!.redAreaBpsSeconds - 5_000) < 1e-7);
  assert.ok(Math.abs(r.features!.signedAreaBpsSeconds - 40_000) < 1e-7);
  assert.ok(Math.abs(r.features!.averageSignedDistanceBps - 40_000/60) < 1e-9);
  assert.equal(r.features!.sourceAgeMs,1_000);
  assert.equal(r.features!.windowEndAtMs,end);
});

test("two crossings split each trapezoid at the exact reference-crossing time", () => {
  const r = measureWaterxPricePath({ decisionAtMs:at,anchorPrice:100,anchorConfirmed:true,
    ticks:samples([90,110,90,110,90,110,90]) });
  assert.ok(Math.abs(r.features!.greenSeconds - 30) < 1e-9);
  assert.ok(Math.abs(r.features!.redSeconds - 30) < 1e-9);
  assert.ok(Math.abs(r.features!.signedAreaBpsSeconds) < 1e-9);
});

test("exact reference flatline counts neither red nor green",()=>{
  const r=measureWaterxPricePath({decisionAtMs:at,anchorPrice:100,anchorConfirmed:true,
    ticks:samples([100,100,100,100,100,100,100])});
  assert.equal(r.features?.greenSeconds,0);
  assert.equal(r.features?.redSeconds,0);
  assert.equal(r.features?.signedAreaBpsSeconds,0);
});

test("no confirmed reference, stale endpoints and missing gaps fail closed",()=>{
  const ticks=samples([90,100,110,110,110,110,110]);
  assert.equal(measureWaterxPricePath({decisionAtMs:at,anchorPrice:100,
    anchorConfirmed:false,ticks}).features,null);
  assert.equal(measureWaterxPricePath({decisionAtMs:end+20_000,anchorPrice:100,
    anchorConfirmed:true,ticks}).features,null);
  assert.equal(measureWaterxPricePath({decisionAtMs:at,anchorPrice:100,
    anchorConfirmed:true,ticks:ticks.filter((_,i)=>i!==3)}).features,null);
});

test("a late-received tick is never slipped retrospectively into a shadow feature",()=>{
  const ticks=samples([90,100,110,110,110,110,110]);
  ticks[2]={...ticks[2],receivedAtMs:at+1};
  const r=measureWaterxPricePath({decisionAtMs:at,anchorPrice:100,anchorConfirmed:true,ticks});
  assert.equal(r.features,null);
  assert.match(r.reason!,/post-decision/);
});

test("full-round/canonical settlement results are not inferred from this Coinbase proxy",()=>{
  const result=measureWaterxPricePath({decisionAtMs:at,anchorPrice:100,anchorConfirmed:true,
    ticks:samples([101,102,103,104,105,106,107])});
  assert.ok(result.features);
  assert.ok(!("outcome" in result.features!));
  assert.ok(!("settlement" in result.features!));
});
