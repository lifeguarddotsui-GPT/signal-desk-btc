import test from "node:test";
import assert from "node:assert/strict";
import {createRefreshHealth,refreshErrorClass} from "../server/waterx/refresh-health";
import {boundedDatabaseRetry,transientDatabaseError} from "../server/waterx/bounded-retry";
import {validWaterxProbabilityPair} from "../shared/round-decision";
test("invalid provider pairs are rejected, not normalized into fabricated adaptive evidence",()=>{
  assert.equal(validWaterxProbabilityPair(.485,.515),true);
  for(const [up,down] of [[.49,.49],[.51,.51],[NaN,.5],[1.1,-.1],[null,1]])
    assert.equal(validWaterxProbabilityPair(up,down),false);
  assert.equal(validWaterxProbabilityPair(.5,.500002),false);
});
test("stage health isolates database errors from source success and only that stage's recovery clears it",()=>{
  const health=createRefreshHealth(()=>1000);
  const error={interval:5 as const,stage:"DATABASE_WRITE" as const,outcome:"error" as const,errorClass:"57014"};
  health.record(error);health.record(error);
  health.record({interval:5,stage:"PROVIDER_RESPONSE",outcome:"ok",elapsedMs:18});
  assert.equal(health.read(5).alerts.length,1);assert.equal(health.read(15).alerts.length,0);
  health.record({interval:5,stage:"DATABASE_WRITE",outcome:"started"});
  assert.equal(health.read(5).alerts.length,1,"Starting a retry is not recovery.");
  health.record({interval:5,stage:"DATABASE_WRITE",outcome:"ok"});
  assert.equal(health.read(5).alerts.length,0);
});
test("diagnostics are bounded, redact extra fields and browser events cannot affect server health",()=>{
  const health=createRefreshHealth(()=>1000);
  for(let i=0;i<200;i++)health.record({interval:5,stage:"PUBLICATION",outcome:"ok",
    roundId:"public-market",privateKey:"do-not-keep",wallet:"do-not-keep"} as never);
  health.record({interval:5,stage:"BROWSER_RENDER",outcome:"error",errorClass:"FORGED",clock:"browser-untrusted"});
  assert.equal(health.read(5).events.length,128);
  assert.equal(health.read(5).errors.length,0);
  assert.ok(!JSON.stringify(health.read(5)).includes("do-not-keep"));
  assert.equal(refreshErrorClass(Object.assign(new Error("private query text"),{code:"57014"})),"57014");
  assert.equal(refreshErrorClass(new Error("arbitrary private text")),"OPERATION_FAILED");
});
test("idempotent database retries recover with bounded jitter without retrying permanent errors",async()=>{
  let calls=0;const delays:number[]=[];
  const result=await boundedDatabaseRetry(async()=>{if(++calls<3)throw Object.assign(new Error("timeout"),{code:"57014"});return "committed";},
    {canRetry:()=>true,sleep:async ms=>{delays.push(ms);},random:()=>.5});
  assert.equal(result,"committed");assert.equal(calls,3);assert.deepEqual(delays,[400,700]);
  calls=0;
  await assert.rejects(boundedDatabaseRetry(async()=>{calls++;throw Object.assign(new Error("missing schema"),{code:"42P01"});},
    {canRetry:()=>true,sleep:async()=>assert.fail("Permanent failures are not retried.")}));
  assert.equal(calls,1);
});
test("retries stop at three attempts and cannot retry an input that expired during backoff",async()=>{
  let calls=0;
  const operation=async()=>{calls++;throw Object.assign(new Error("query timeout"),{code:"57014"});};
  await assert.rejects(boundedDatabaseRetry(operation,{canRetry:()=>true,sleep:async()=>{},random:()=>0}));
  assert.equal(calls,3);
  calls=0;let fresh=true;
  await assert.rejects(boundedDatabaseRetry(operation,{canRetry:()=>fresh,sleep:async()=>{fresh=false;}}));
  assert.equal(calls,1);
  assert.equal(transientDatabaseError(new Error("Query read timeout")),true);
  assert.equal(transientDatabaseError(Object.assign(new Error("bad SQL"),{code:"42601"})),false);
});
