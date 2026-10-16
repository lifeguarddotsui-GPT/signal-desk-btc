import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {evaluateEntryWindow} from "../shared/entry-window";
const round={startMs:1_000_000,expiryMs:1_300_000,nowMs:1_120_000,
  sourceFresh:true,referenceConfirmed:true,signal:"DOWN" as const,
  signalConflict:false,askCents:70,latestProviderAsOfMs:1_119_000};

test("entry scale treats market purchase price as break-even, never model confidence",()=>{
  const x=evaluateEntryWindow(round);
  assert.equal(x.state,"EDGE_UNVERIFIED");
  assert.equal(x.executable,false);
  assert.equal(x.qualifiedForecastProbability,null);
  assert.ok(Math.abs(x.breakEvenWinProbability!-.7)<1e-9);
  assert.ok(Math.abs(x.grossIfWinUsd!-5/.7)<1e-9);
  assert.equal(x.roundProgressPercent,40);
  assert.equal(x.remainingSeconds,180);
  assert.ok(Math.abs(x.illustrativeBreakEvenWith10CentCost!-.714)<1e-9);
});
test("high ask fails minimum gross preference without disguising expected value",()=>{
  const x=evaluateEntryWindow({...round,askCents:95});
  assert.equal(x.state,"RETURN_BELOW_PREFERENCE");
  assert.ok(x.grossIfWinUsd!<6);
});
test("round, source, signal, timing and conflict gate fail closed",()=>{
  assert.equal(evaluateEntryWindow({...round,nowMs:round.expiryMs}).state,"ROUND_CLOSED");
  assert.equal(evaluateEntryWindow({...round,latestProviderAsOfMs:round.nowMs-11_000}).state,"WAITING_FOR_SOURCE");
  assert.equal(evaluateEntryWindow({...round,signal:null}).state,"NO_FROZEN_SIGNAL");
  assert.equal(evaluateEntryWindow({...round,signalConflict:true}).state,"SIGNAL_CONFLICT");
  assert.equal(evaluateEntryWindow({...round,nowMs:round.expiryMs-39_000,
    latestProviderAsOfMs:round.expiryMs-40_000}).state,"LATE_TO_ENTER");
  assert.equal(evaluateEntryWindow({...round,askCents:null}).state,"ASK_UNAVAILABLE");
  assert.equal(evaluateEntryWindow({...round,sourceFresh:false}).executable,false);
  assert.equal(evaluateEntryWindow({...round,referenceConfirmed:false}).state,"REFERENCE_UNCONFIRMED");
  assert.equal(evaluateEntryWindow({...round,referenceConfirmed:false}).reason.includes("Chainlink TWAP"),true);
});
test("entry UI has descriptive slider, no live buy button or confidence spoofing",()=>{
 const ui=readFileSync(new URL("../client/src/ManualOpportunity.tsx",import.meta.url),"utf8");
 assert.match(ui,/aria-label="Entry timing and economic research"/);
 assert.match(ui,/role="progressbar"/);
 assert.match(ui,/WaterX BTC settles against Chainlink TWAP/);
 assert.doesNotMatch(ui,/\>BUY NOW\</i);
 assert.match(ui,/Confirmation mode:/);
 assert.match(ui,/confirmationMode === "UNAVAILABLE"/);
});
