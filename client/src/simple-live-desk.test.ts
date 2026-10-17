import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {SimpleLiveDesk,simpleWaterxPosition} from "./SimpleLiveDesk";
import {selectWaterxOddsDisplay} from "./waterx-ui-contract";

const now=1_760_000_000_000;
const round={id:"test-round",startMs:now-105000,expiryMs:now+195000};
const base={interval:5 as const,now,round,referencePrice:81224.97,referenceConfirmed:false,
  quoteFresh:true,quoteAtMs:now-2000,upAsk:70,downAsk:30};

test("quoted side economics are automatically derived from WaterX ask, not market probabilities",()=>{
  const result=simpleWaterxPosition(70,true);
  assert.ok(result);
  assert.equal(result?.winningProfitBeforeFees.toFixed(2),"2.14");
  assert.equal(result?.breakEvenPercentBeforeFees,70);
  assert.equal(result?.maximumLossBeforeFees,5);
  assert.equal(simpleWaterxPosition(null,true),null);
  assert.equal(simpleWaterxPosition(0,true),null);
  assert.equal(simpleWaterxPosition(70,false),null);
  assert.equal(simpleWaterxPosition(101,true),null);
});

test("main card is automatic, visibly provisional, and cannot falsely claim an oracle or profit edge",()=>{
  const html=renderToStaticMarkup(React.createElement(SimpleLiveDesk,base));
  assert.match(html,/BTC 5m · \$5 positions/);
  assert.match(html,/3:15/);
  assert.match(html,/\$81,224\.97/);
  assert.match(html,/Provisional · not confirmed/);
  assert.match(html,/70\.0¢/);
  assert.match(html,/\+\$2\.14/);
  assert.match(html,/70\.0%/);
  assert.match(html,/Verified prediction edge/);
  assert.match(html,/Not established/);
  assert.match(html,/before trading fees/);
  assert.match(html,/not executable \$5 fills/);
  assert.doesNotMatch(html,/type="number"|input|8\/10|CHAINLINK CURRENT/i);
});

test("expired round and quotes older than 14s withhold all ask-derived financial metrics",()=>{
  for(const props of [{...base,now:now+196000},{...base,quoteAtMs:now-15000},{...base,quoteFresh:false}]){
    const html=renderToStaticMarkup(React.createElement(SimpleLiveDesk,props));
    assert.doesNotMatch(html,/\+\$2\.14|70\.0¢|30\.0¢/);
    assert.match(html,/Quotes unavailable|Awaiting round/);
  }
});

test("provider quote timestamps can be fresh while probabilities are missing; never invent probabilities",()=>{
  const response=selectWaterxOddsDisplay({
    snapshotCurrent:true,roundCurrent:true,requestedInterval:5,responseInterval:5,
    roundId:"test-round",roundStartMs:round.startMs,serverNowMs:now,
    odds:{up:null,down:null,upPriceCents:70,downPriceCents:30,asOf:null,
      priceAsOf:new Date(now-2000).toISOString(),source:"WaterX public market probabilities and odds"},
    availability:{status:"unavailable",up:{probability:"unavailable",price:"reported"},
      down:{probability:"unavailable",price:"reported"}},
  });
  assert.equal(response.fresh,true);
  assert.equal(response.up.grossAvailable,true);
  assert.equal(response.up.priceCents,70);
  assert.equal(response.up.probability,null);
  assert.equal(response.down.probability,null);
  assert.equal(selectWaterxOddsDisplay({
    snapshotCurrent:true,roundCurrent:true,requestedInterval:5,responseInterval:5,
    roundId:"test-round",roundStartMs:round.startMs,serverNowMs:now,
    odds:{up:null,down:null,upPriceCents:70,downPriceCents:30,asOf:null,
      priceAsOf:new Date(now-2000).toISOString(),source:"Coinbase"},
    availability:{status:"unavailable",up:{price:"reported"},down:{price:"reported"}},
  }).fresh,false);
});
