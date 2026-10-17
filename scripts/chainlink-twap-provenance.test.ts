import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {CHAINLINK_BTC_TWAP60_REFERENCE,verifiedWaterxTwapSettlement} from "../shared/chainlink-twap-provenance";
const valid={labelStatus:"verified",disputed:false,anchorConfirmed:true,
  anchorPrice:81224.97,settlePrice:81234.56,outcome:"UP",expiryMs:1793000300000,
  settledAtMs:1793000310000};
test("WaterX verified post-expiry Chainlink market settlement is distinct from Coinbase",()=>{
 const p=verifiedWaterxTwapSettlement(valid);
 assert.equal(p?.outcome,"UP");
 assert.equal(p?.source,"WATERX_REPORTED_VERIFIED_SETTLEMENT");
 assert.match(CHAINLINK_BTC_TWAP60_REFERENCE,/data.chain.link\/streams\/btc-usd-twap-60s-streams/);
});
test("no final or live TWAP is invented from tentative reference, missing settlement or wrong outcome",()=>{
 for(const value of [
  {...valid,anchorConfirmed:false},
  {...valid,labelStatus:"withheld"},
  {...valid,settledAtMs:valid.expiryMs},
  {...valid,disputed:true},
  {...valid,settlePrice:81210,outcome:"UP"},
  {...valid,settlePrice:null},
  {...valid,outcome:"NO"},
 ]){
  assert.equal(verifiedWaterxTwapSettlement(value),null);
 }
});
test("chart shows authoritative TWAP source but never assumes authenticated Chainlink live streaming",()=>{
 const src=readFileSync(new URL("../client/src/App.tsx",import.meta.url),"utf8");
 assert.match(src,/Coinbase is a different feed from WaterX\x27s Chainlink TWAP60 settlement/);
 assert.match(src,/Colors and area metrics do not predict the official result/);
 assert.match(src,/verifiedWaterxTwapSettlement/);
 assert.match(src,/anchor=\{chartReference\}/);
 assert.match(src,/const tone = anchor==null\?"neutral"/);
 assert.match(src,/splitAtReference\(/);
});
