import test from "node:test";
import assert from "node:assert/strict";
import {createRoundDecisionTracker} from "../server/waterx/round-decision";

test("live readiness is exact-round, immutable on commit, bounded and never execution permission",()=>{
  const tracker=createRoundDecisionTracker();
  const first={intervalMinutes:5 as const,roundId:"first",startMs:1000000,expiryMs:1300000};
  for(let i=0;i<40;i++)tracker.observe(first,{atMs:1170000+i*1000,receivedAtMs:1170000+i*1000,
    providerSourceAtMs:null,probabilityUp:.8,probabilityDown:.2,sourceHealthy:true});
  const live=tracker.read(first,1209000)!;
  tracker.observe(first,{atMs:1209500,receivedAtMs:1209000,providerSourceAtMs:null,
    probabilityUp:.8,probabilityDown:.2,sourceHealthy:true});
  const reread=tracker.read(first,1209500)!;
  assert.ok(reread.stateVersion>live.stateVersion,"Each publication is versioned.");
  assert.equal(tracker.read(first,1209000)!.readiness.components.observationCount,live.readiness.components.observationCount,
    "Reusing a cached HTTP response cannot manufacture another readiness observation");
  assert.equal(reread.market!.receivedAtMs,live.market!.receivedAtMs);
  assert.equal(live.network,"sui:mainnet");assert.equal(live.tradeAllowed,false);
  assert.equal(live.latestSafeOrderAtMs,null);assert.equal(live.executionWindowRemainingMs,null);
  assert.ok(live.readiness.score>=0&&live.readiness.score<=100);
  tracker.committed(first,{side:"UP",probabilityUp:.8,decisionAtMs:1240000,committedAtMs:1240010});
  tracker.committed(first,{side:"DOWN",probabilityUp:.2,decisionAtMs:1240100,committedAtMs:1240200});
  assert.equal(tracker.read(first,1240300)!.canonical!.side,"UP");
  assert.equal(tracker.read(first,1300000),null);
  const next={...first,roundId:"next",startMs:1300000,expiryMs:1600000};
  tracker.observe(next,{atMs:1301000,receivedAtMs:1301000,providerSourceAtMs:null,
    probabilityUp:.5,probabilityDown:.5,sourceHealthy:true});
  tracker.observe(first,{atMs:1250000,receivedAtMs:1250000,providerSourceAtMs:null,
    probabilityUp:.9,probabilityDown:.1,sourceHealthy:true});
  assert.equal(tracker.read(first,1301000),null);
  const rolled=tracker.read(next,1301000)!;
  assert.equal(rolled.canonical,null);assert.equal(rolled.readiness.probability,.5);
  assert.equal(rolled.readiness.components.observationCount,1);
  assert.ok(rolled.stateVersion>live.stateVersion);
});