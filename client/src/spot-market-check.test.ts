import test from "node:test";
import assert from "node:assert/strict";
import {spotMarketCheck} from "./spot-market-check";
import {computeRecentAreaSummary} from "./round-area-metrics";
import {readFileSync} from "node:fs";

test("WaterX UP odds and red Coinbase history may both be true without price fabrication",()=>{
  const x=spotMarketCheck({spot:81219,reference:81224.97,
    upProbability:.655,downProbability:.345,oddsFresh:true,priceFresh:true});
  assert.equal(x.marketFavor,"UP");
  assert.equal(x.spotSide,"BELOW");
  assert.equal(x.differentIndicators,true);
  assert.equal(x.priceDifferenceUsd?.toFixed(2),"-5.97");
  assert.match(x.label,/Market pricing favors UP.*Coinbase below reference.*different indicators/);
  assert.equal(x.marketFavor==="UP",true);
  // Positive betting market odds do NOT alter the actual observed red spot tick.
  assert.equal(x.spotSide,"BELOW");
});

test("no price, stale source, or dubious probabilities fails closed",()=>{
  const args={spot:81219,reference:81224.97,upProbability:.65,downProbability:.35,
    oddsFresh:true,priceFresh:true};
  assert.equal(spotMarketCheck({...args,oddsFresh:false}).marketFavor,null);
  assert.equal(spotMarketCheck({...args,priceFresh:false}).spotSide,null);
  assert.equal(spotMarketCheck({...args,reference:null}).priceDifferenceUsd,null);
  assert.equal(spotMarketCheck({...args,upProbability:.95,downProbability:.95}).marketFavor,null);
  assert.equal(spotMarketCheck({...args,upProbability:.59,downProbability:.41}).marketFavor,"NEUTRAL");
});

test("last minute is distinct from whole round and respects exact 60s window",()=>{
  const samples=[{at:0,price:90},{at:45000,price:90},{at:55000,price:90},
    {at:65000,price:90},{at:75000,price:110},{at:85000,price:110},
    {at:95000,price:110},{at:105000,price:110}];
  const recent=computeRecentAreaSummary(samples,100,0,300000,105000,60000,14000);
  assert.ok(recent);
  assert.equal(recent?.elapsedMs,60000);
  assert.ok(recent!.aboveMs>0);
  assert.ok(recent!.belowMs>0);
  assert.equal(recent?.observedMs,60000);
  assert.equal(recent?.aboveTimePercent.toFixed(1),"58.3");
});
test("rolling recent window cannot interpolate a 60s outage into red or green",()=>{
  const samples=[{at:0,price:90},{at:10000,price:90},{at:65000,price:110},
    {at:75000,price:110}];
  const recent=computeRecentAreaSummary(samples,100,0,300000,75000,60000,14000);
  assert.ok(recent);
  assert.equal(recent?.observedMs,10000);
  assert.ok(recent!.coveragePercent<20);
});
test("Live Desk renders plot above summary and checks latest Coinbase source by timestamp",()=>{
 const src=readFileSync(new URL("./App.tsx",import.meta.url),"utf8");
 const css=readFileSync(new URL("./FocusDesk.css",import.meta.url),"utf8");
 assert.match(src,/preferStream = streamCoinbaseFresh/);
 assert.match(src,/comparisonFresh && comparison && Number.isFinite\(comparisonMs\)/);
 assert.match(src,/computeRecentAreaSummary\(/);
 assert.match(src,/bw-cross-source-context/);
 assert.match(src,/Last 60s/);
 assert.match(src,/ref=\{chartMeasureRef\}/);
 assert.match(css,/min-height:265px!important/);
 assert.match(css,/\.bw-recent-band/);
});
