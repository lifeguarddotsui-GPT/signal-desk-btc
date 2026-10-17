import test from "node:test";
import assert from "node:assert/strict";
import {computeAreaSummary,splitAtReference} from "./round-area-metrics";

test("red and green surface area exactly split at interpolated threshold crossings",()=>{
 const pieces=splitAtReference({at:0,price:90},{at:10000,price:110},100);
 assert.equal(pieces.length,2);
 assert.deepEqual(pieces.map(p=>p.side),["BELOW","ABOVE"]);
 assert.equal(pieces[0].endMs,5000);
 assert.equal(pieces[1].startMs,5000);
 const result=computeAreaSummary([
  {at:0,price:90},{at:10000,price:110},{at:20000,price:110},{at:30000,price:90},
 ],100,0,30000,30000);
 assert.ok(result);
 assert.equal(result?.aboveMs,20000);
 assert.equal(result?.belowMs,10000);
 assert.equal(result?.crossings,2);
 assert.equal(result?.aboveTimePercent.toFixed(1),"66.7");
 assert.equal(result?.belowTimePercent.toFixed(1),"33.3");
 assert.equal(result?.aboveAreaPercent?.toFixed(1),"75.0");
 assert.equal(result?.belowAreaPercent?.toFixed(1),"25.0");
 assert.equal(result?.netAreaBiasPercent?.toFixed(1),"50.0");
 assert.equal(result?.coveragePercent,100);
 assert.equal(result?.currentSide,"BELOW");
 assert.equal(result?.currentStreakMs,5000);
});

test("missing and stale samples never produce false continuous time or area",()=>{
 const result=computeAreaSummary([
   {at:0,price:105},{at:5000,price:105},
   {at:9000,price:null,gap:true},
   {at:30000,price:95},{at:35000,price:95},
 ],100,0,60000,60000);
 assert.ok(result);
 assert.equal(result?.observedMs,10000);
 assert.equal(result?.coveragePercent.toFixed(1),"16.7");
 assert.equal(result?.aboveMs,5000);
 assert.equal(result?.belowMs,5000);
 assert.equal(result?.crossings,0);
 assert.equal(result?.currentSide,null);
 assert.equal(result?.currentStreakMs,0);
});
test("no reference or no observed continuous samples yields unavailable measures",()=>{
 assert.equal(computeAreaSummary([{at:1000,price:99}],0,0,300000,3000),null);
 const empty=computeAreaSummary([{at:1000,price:99}],100,0,300000,3000);
 assert.ok(empty);
 assert.equal(empty?.observedMs,0);
 assert.equal(empty?.aboveAreaPercent,null);
 assert.equal(empty?.belowAreaPercent,null);
 const uncovered=computeAreaSummary([{at:0,price:95},{at:60000,price:105}],100,0,300000,60000);
 assert.equal(uncovered?.observedMs,0);
});
test("round samples do not leak across rollover or beyond current time",()=>{
 const data=computeAreaSummary([
  {at:-1000,price:50},{at:0,price:100},{at:5000,price:110},{at:10000,price:90},
  {at:15000,price:200},{at:300001,price:200}
 ],100,0,300000,10000);
 assert.ok(data);
 assert.equal(data?.elapsedMs,10000);
 assert.equal(data?.coveragePercent,100);
 assert.equal(data?.pieces.at(-1)?.endMs,10000);
});
