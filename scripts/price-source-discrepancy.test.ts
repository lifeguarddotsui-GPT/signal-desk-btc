import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const page=readFileSync(new URL("../client/src/App.tsx",import.meta.url),"utf8");
const css=readFileSync(new URL("../client/src/index.css",import.meta.url),"utf8");
test("a Coinbase spot chart cannot imply WaterX UP/DOWN via chart fill or reference line",()=>{
 const live=page.slice(page.indexOf("function LivePage()"),page.indexOf("function HistoryPage()"));
 assert.match(live,/COINBASE COMPARISON DATA/);
 assert.match(live,/COINBASE SPOT · COMPARISON ONLY/);
 assert.match(live,/WATERX STARTING REFERENCE/);
 assert.match(live,/WATERX LIVE ORACLE PREVIEW/);
 assert.match(live,/Not supplied here/);
 assert.match(live,/chart is deliberately neutral/);
 assert.match(live,/<PriceChart points=\{merged\} interval=\{interval\} anchor=\{null\} referenceConfirmed=\{false\}/);
 assert.match(live,/const tone = "neutral"/);
 assert.doesNotMatch(live,/const tone\s*=\s*latest[^;]+anchor/);
 assert.match(css,/\.price-chart\.neutral \.price-line\s*\{ stroke: #9acbc0;/);
});
test("in sample discrepancy, Coinbase and WaterX differ so no cross-feed direction is valid",()=>{
 const coinbase=81219.00,waterxReference=81224.97,waterxPreview=81234.56;
 assert.equal(coinbase<waterxReference,true);
 assert.equal(waterxPreview>waterxReference,true);
 // Only facts about two distinct feeds: a chart can't use the Coinbase sign
 // as the oracle's current direction.
 assert.match(page,/Coinbase spot and the WaterX Oracle preview are separate feeds/);
 assert.match(page,/NO WaterX price-to-beat line/);
});
test("learning import requires actual fill and post-expiry WaterX settlement proof, not spot ticks",()=>{
 const learning=readFileSync(new URL("../client/src/VerifiedFillLearningPanel.tsx",import.meta.url),"utf8");
 assert.match(learning,/actual WaterX execution prices/);
 assert.match(learning,/post-expiry Chainlink TWAP settlement evidence/);
 assert.match(learning,/Nothing is uploaded, saved in the production database/);
 assert.match(page,/<VerifiedFillLearningPanel interval=\{interval\}/);
});
