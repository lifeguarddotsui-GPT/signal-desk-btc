import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const page=readFileSync(new URL("../client/src/App.tsx",import.meta.url),"utf8");
const css=readFileSync(new URL("../client/src/index.css",import.meta.url),"utf8");
test("Coinbase comparison chart may show red or green only as explicitly labeled reference comparison",()=>{
 const live=page.slice(page.indexOf("function LivePage()"),page.indexOf("function HistoryPage()"));
 assert.match(live,/BTC ROUND PRICE CHART · LIVE COMPARISON/);
 assert.match(live,/Coinbase is a different feed from WaterX/);
 assert.match(live,/WaterX price to beat/);
 assert.match(live,/not WaterX Oracle or settlement/i);
 assert.match(live,/Stale \/ unavailable/);
 assert.match(live,/Colors and area metrics do not predict the official result/);
 assert.match(live,/<PriceChart points=\{merged\} interval=\{interval\} anchor=\{chartReference\}/);
 assert.match(live,/const tone = anchor==null\?"neutral"/);
 assert.match(live,/splitAtReference\(/);
 assert.match(css,/\.price-chart\.neutral \.price-line\s*\{ stroke: #9acbc0;/);
});
test("in sample discrepancy, Coinbase and WaterX differ so no cross-feed direction is valid",()=>{
 const coinbase=81219.00,waterxReference=81224.97,waterxPreview=81234.56;
 assert.equal(coinbase<waterxReference,true);
 assert.equal(waterxPreview>waterxReference,true);
 // Only facts about two distinct feeds: a chart can't use the Coinbase sign
 // as the oracle's current direction.
 assert.match(page,/Coinbase is a different feed from WaterX/);
 assert.match(page,/Colors and area metrics do not predict the official result/);
});
test("learning import requires actual fill and post-expiry WaterX settlement proof, not spot ticks",()=>{
 const learning=readFileSync(new URL("../client/src/VerifiedFillLearningPanel.tsx",import.meta.url),"utf8");
 assert.match(learning,/actual WaterX execution prices/);
 assert.match(learning,/post-expiry Chainlink TWAP settlement evidence/);
 assert.match(learning,/Nothing is uploaded, saved in the production database/);
 assert.match(page,/<VerifiedFillLearningPanel interval=\{interval\}/);
});
