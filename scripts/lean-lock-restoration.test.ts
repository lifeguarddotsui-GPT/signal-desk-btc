import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRoundDecisionTracker} from "../server/waterx/round-decision";
import {provisionalLean} from "../shared/provisional-lean";
import {evaluateQualificationGate} from "../server/waterx/timed-decision-builder";
import {freezeEarlyHorizon} from "../server/waterx/early-horizons";
import {evaluateEarlyStopping} from "../server/waterx/early-stopping";
import {earlyHorizons} from "../shared/timed-decision";
import {parseWaterxResponse} from "../server/waterx/source";
import type {EarlyTrainingRow} from "../server/waterx/early-training";

const start=1700000000000;
const observation=(at:number,p:number)=>({atMs:at,receivedAtMs:at,probabilityUp:p,probabilityDown:1-p,sourceHealthy:true,providerSourceAtMs:null});
for(const intervalMinutes of [5,15] as const){
  const round={intervalMinutes,roundId:`lean-${intervalMinutes}`,startMs:start,expiryMs:start+intervalMinutes*60000};
  test(`${intervalMinutes}m lean updates between gates, hysteresis suppresses noise and genuine reversal resets qualification`,()=>{
    const tracker=createRoundDecisionTracker();
    tracker.observe(round,observation(start+5000,.6));
    assert.equal(tracker.read(round,start+5000)?.currentStrategy?.provisionalLean,"UP");
    tracker.observe(round,observation(start+10000,.499));
    assert.equal(tracker.read(round,start+10000)?.currentStrategy?.provisionalLean,"UP");
    tracker.observe(round,observation(start+15000,.4));
    assert.equal(tracker.read(round,start+15000)?.currentStrategy?.provisionalLean,"DOWN");
    // Raw .499 reversed at 10s even while display hysteresis retained UP.
    assert.equal(tracker.read(round,start+15000)?.timedDecision?.components?.sameSideMs,5000);
    assert.equal(tracker.read(round,start+26000)?.currentStrategy?.provisionalLean,null);
    tracker.observe(round,observation(start+27000,.8));
    assert.equal(tracker.read(round,start+27000)?.currentStrategy?.provisionalLean,"UP");
    assert.equal(evaluateQualificationGate(round,[observation(start+27000,.8)],1,start+30000).result,"WAIT_UNSTABLE");
  });
  test(`${intervalMinutes}m missing odds still freeze independent features without a forecast`,()=>{
    const at=start+30000;
    const input={...round,receivedAtMs:at,observedAt:new Date(at).toISOString(),
      probabilityUp:null,probabilityDown:null,anchorPrice:80000,anchorConfirmed:true,
      features:{contextAvailableAtMs:at,comparison:{price:80020,asOf:new Date(at).toISOString(),source:"Coinbase"}}};
    const frozen=freezeEarlyHorizon(input,30,[input],at+5,false);
    assert.equal(frozen.status,"DATA_FAILURE");
    assert.equal(frozen.snapshot.probabilityUp,null);
    assert.equal(frozen.snapshot.features?.comparisonPrice,80020);
    assert.equal(frozen.snapshot.features?.missingProbabilities,true);
    assert.equal(frozen.snapshot.modelProbabilityUp,null);
    const later={...input,receivedAtMs:at+1,features:{comparison:{price:90000,asOf:new Date(at+1).toISOString()}}};
    assert.equal(freezeEarlyHorizon(input,30,[input,later],at+5,true).snapshot.features?.comparisonPrice,80020);
    assert.equal(freezeEarlyHorizon(input,30,[later],at+3000,false).snapshot.features,null);
  });
}
test("hysteresis retains its state beyond the bounded observation window and never uses future rows",()=>{
  const first=provisionalLean([observation(start,.8)],start,start);
  const retained=provisionalLean([observation(start+5000,.499),observation(start+20000,.1)],start+5000,start,first);
  assert.equal(retained.side,"UP");assert.equal(retained.receivedAtMs,start+5000);
});
test("captured live provider responses have no probabilities; parser does not convert purchase prices",()=>{
  // Recorded round fields; descriptions and neighbors omitted. Keep these
  // fixtures in tracked source, not ignored local evidence reports.
  const cases=JSON.parse(readFileSync(new URL("./fixtures/waterx-probability-outage-2026-10-06.json",import.meta.url),"utf8"));
  for(const interval of [5,15] as const){
    const raw=cases.find((c:{interval:number})=>c.interval===interval).response;
    const parsed=parseWaterxResponse(raw,interval);
    assert.equal(parsed.round.sides.up.probabilityCents,null);
    const priced=structuredClone(raw);
    priced.data.detail.round.sides=[{key:"up",oddsCents:80},{key:"down",oddsCents:30}];
    const priceOnly=parseWaterxResponse(priced,interval);
    assert.equal(priceOnly.round.sides.up.probabilityCents,null);
    assert.equal(priceOnly.round.sides.down.probabilityCents,null);
    priced.data.detail.round.sides=[{key:"up",probabilityCents:80},{key:"down",probabilityCents:20}];
    assert.equal(parseWaterxResponse(priced,interval).round.sides.up.probabilityCents,80);
  }
});
test("complete sequential replay selects first eligible gate, never hindsight best, with held-out policy isolation",()=>{
  const now=Date.UTC(2026,9,6),day=86400000;
  const rows:EarlyTrainingRow[]=Array.from({length:140},(_,i)=>earlyHorizons(5).map(horizon=>({
    interval:5 as const,roundId:`sequence-${i}`,startMs:now-(i<70?3:1)*day+(i%70)*300000,
    expiryMs:now-(i<70?3:1)*day+(i%70)*300000+300000,horizon,
    probability:i%2?.2:.8,outcome:i%2?"DOWN" as const:"UP" as const,
    labelAvailableAtMs:now-(i<70?3:1)*day+(i%70)*300000+301000,snapshotDigest:"controlled",
    features:{sameSideMs:horizon===30?0:30000,sourceAgeMs:0,validObservationCount:4,
      recentReversals:0,probabilityRange:0,missingProbabilities:false},
  }))).flat();
  const models=earlyHorizons(5).map(horizon=>({horizon,artifact:{
    parameters:{intercept:0,coefficients:[1]},calibration:{intercept:0,coefficients:[1]}}}));
  const report=evaluateEarlyStopping(rows,5,models,now);
  assert.equal(report.status,"EVALUATED");
  if(!("test" in report))throw new Error("Missing full sequential report");
  assert(report.test.decisions.every(r=>r.horizon===60));
  assert.equal(report.test.medianTimeToLockSeconds,60);
  assert.equal(report.test.withinTargetWindowRate,1);
  const changed=rows.map(r=>r.startMs>=now-2*day?{...r,outcome:r.outcome==="UP"?"DOWN" as const:"UP" as const}:r);
  const rerun=evaluateEarlyStopping(changed,5,models,now);
  assert("threshold" in rerun);
  assert.equal(rerun.threshold,report.threshold);
  assert.equal(rerun.promotion,"RETAIN_BASELINE");
  const lateGaps=evaluateEarlyStopping(rows.filter(r=>r.horizon<=60),5,models,now);
  assert("test" in lateGaps);
  assert(lateGaps.test.decisions.every(r=>r.horizon===60));
  assert.equal(lateGaps.test.decisionN,report.test.decisionN);
  assert(lateGaps.test.incompletePaths>0);
  const earlyGaps=evaluateEarlyStopping(rows.filter(r=>r.horizon!==30),5,models,now);
  assert.equal(earlyGaps.status,"INSUFFICIENT");
});
