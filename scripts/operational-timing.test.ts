import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {operationalTimingWindow} from "../shared/operational-timing";
const start=1_000_000,expiry=start+300_000;
const check=(remaining:number)=>operationalTimingWindow({startMs:start,expiryMs:expiry,nowMs:expiry-remaining*1000});
test("operational 1–10 clock grade always available, even when oracle reference and ask are absent",()=>{
  const early=check(295),middle=check(150),late=check(20);
  assert.equal(early.phase,"TOO_EARLY");
  assert.equal(middle.phase,"REVIEW_WINDOW");
  assert.equal(middle.score,8);
  assert.equal(late.score,1);
  assert.equal(middle.quality,"OPERATIONAL_HEURISTIC_ONLY");
  assert.equal(check(300).elapsedPercent,0);
  assert.equal(check(0).phase,"CLOSED");
});
test("15 minute market uses round fractions, not hard-coded 5m time assumptions",()=>{
  const r=operationalTimingWindow({startMs:start,expiryMs:start+900_000,nowMs:start+450_000});
  assert.equal(r.score,8);
  assert.equal(r.remainingSeconds,450);
  assert.equal(r.phase,"REVIEW_WINDOW");
});
test("diagnostics never substitute oracle, claim profitable timing or submit orders",()=>{
  const panel=readFileSync(new URL("../client/src/TradeReadinessPanel.tsx",import.meta.url),"utf8");
  assert.match(panel,/Operational timing/);
  assert.match(panel,/NOT an accuracy score or a buy recommendation/);
  assert.match(panel,/Win rate to break even/);
  assert.match(panel,/Official settlement uses the WaterX market reference rather than Coinbase spot/);
  assert.doesNotMatch(panel,/>BUY NOW</i);
  const app=readFileSync(new URL("../client/src/App.tsx",import.meta.url),"utf8");
  const desk=readFileSync(new URL("../client/src/ManualOpportunity.tsx",import.meta.url),"utf8");
  assert.match(app,/oddsDisplay\.up\.grossAvailable\?oddsDisplay\.up\.priceCents/);
  assert.match(app,/marketProbabilities=\{\{up:oddsDisplay\.up\.probability/);
  assert.match(desk,/marketAsks\?\.up/);
  assert.match(panel,/WaterX market-implied odds/);
  assert.match(panel,/Target: \+\$1 to \+\$2 on a winning \$5 position/);
  assert.doesNotMatch(panel,/signAndExecuteTransaction|placeOrder\(/);
});
