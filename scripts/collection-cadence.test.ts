import test from "node:test";
import assert from "node:assert/strict";
import {healthyCollectionDelay,collectionTimerDelay,collectionCadence} from "../server/waterx/collection-cadence";
import {calculateWaterxRetryDelay} from "../server/waterx/service";
import {WaterxProviderError,parseWaterxRetryAfter,getCurrentWaterxRound,getWaterxRoundAtEpoch} from "../server/waterx/source";

for(const interval of [5,15] as const){
  test(`${interval}m missing fields retain budgeted qualification-compatible healthy cadence`,()=>{
    for(const jitter of [0,.5,1]){
      const delay=healthyCollectionDelay(5000,jitter);
      assert(delay>=5000&&delay<=5500);
      assert.equal(collectionCadence(interval,5000,100000+delay,100000).qualificationSamplingCompatible,true);
    }
    assert.equal(collectionCadence(interval,20000,120000,100000).qualificationSamplingCompatible,false);
  });
  test(`${interval}m long provider embargo is respected and explicitly incompatible with gates`,()=>{
    const retry=calculateWaterxRetryDelay(interval,new WaterxProviderError("rate limited",429,1800000),1,0);
    assert(retry>=1800000);
    const next=100000+retry;
    assert.equal(collectionTimerDelay(next,100000),60000);
    assert.equal(collectionTimerDelay(next,next-1),1);
    const cadence=collectionCadence(interval,5000,next,100000);
    assert.equal(cadence.qualificationSamplingCompatible,false);
    assert.match(cadence.limitation!,/cannot qualify/);
    assert.equal(cadence.browserRefreshIsProviderPoll,false);
  });
}
test("source Retry-After parsing preserves 30-minute seconds and HTTP-date instructions",()=>{
  const at=Date.UTC(2026,9,6,20);
  assert.equal(parseWaterxRetryAfter("1800",at),1800000);
  assert.equal(parseWaterxRetryAfter(new Date(at+1800000).toUTCString(),at),1800000);
  assert.equal(parseWaterxRetryAfter("nonsense",at),null);
  assert.equal(parseWaterxRetryAfter(null,at),null);
});
test("current and historical reads obey the same interval's long source embargo",async()=>{
  const fetchBefore=globalThis.fetch,clockBefore=Date.now;
  let now=Date.UTC(2026,9,7),requests=0;
  Date.now=()=>now;
  globalThis.fetch=async()=>{requests++;return new Response("unavailable",
    {status:requests<=2?429:503,headers:requests<=2?{"Retry-After":"1800"}:{}});};
  try{
    for(const interval of [5,15] as const){
      await assert.rejects(getCurrentWaterxRound(interval),e=>
        e instanceof WaterxProviderError&&e.retryAfterMs===1800000);
    }
    assert.equal(requests,2);
    now+=300001;
    for(const interval of [5,15] as const){
      await assert.rejects(getCurrentWaterxRound(interval),/embargo/);
      await assert.rejects(getWaterxRoundAtEpoch(interval,Math.floor(now/1000)-interval*60),/embargo/);
    }
    assert.equal(requests,2,"no current or archive retry after only five minutes");
    now+=1500000;
    await assert.rejects(getCurrentWaterxRound(5),e=>e instanceof WaterxProviderError&&e.status===503);
    assert.equal(requests,3);
  }finally{globalThis.fetch=fetchBefore;Date.now=clockBefore;}
});
