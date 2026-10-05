import test from "node:test";
import assert from "node:assert/strict";
import {createRoundDecisionTracker} from "../server/waterx/round-decision";
import {getAtomicDecisionView,projectServerClock,validateDecisionSnapshot,validateLiveEnvelope,type LiveSnapshotEnvelope} from "../client/src/live-decision-contract";
import {snapshotRetryDelay,transientSnapshotFailure} from "../client/src/useLiveSnapshot";

function fixture(interval:5|15=5){
  const identity={intervalMinutes:interval,roundId:`round-${interval}`,startMs:1_000_000,expiryMs:1_000_000+interval*60000};
  const now=identity.expiryMs-(interval===5?90_000:240_000),tracker=createRoundDecisionTracker();
  for(let at=now-60_000;at<=now;at+=2000)tracker.observe(identity,{atMs:at,receivedAtMs:at,
    probabilityUp:.8,probabilityDown:.2,providerSourceAtMs:null,sourceHealthy:true});
  const read=(at=now):LiveSnapshotEnvelope=>({serverTime:new Date(at).toISOString(),intervalMinutes:interval,status:"LIVE",
    round:{id:identity.roundId,startMs:identity.startMs,expiryMs:identity.expiryMs},decision:tracker.read(identity,at)});
  return {identity,now,tracker,read};
}
test("both intervals have one valid deterministic atomic contract",()=>{
  for(const interval of [5,15] as const){
    const f=fixture(interval),p=f.read();
    assert.equal(validateDecisionSnapshot(p,interval),null);
    const v=getAtomicDecisionView(p,interval,p.round,f.now);
    assert.equal(v.fresh,true);assert.equal(v.lean,"UP");assert.equal(v.stage,"READY");assert.equal(v.score,100);
    assert.equal(p.decision!.tradeAllowed,false);assert.equal(p.decision!.latestSafeOrderAtMs,null);
  }
});
test("a response received between display ticks cannot become falsely stale at age zero",()=>{
  const f=fixture(),p=f.read();
  const clock=projectServerClock(f.now,10_900,10_000);
  assert.equal(clock,f.now);
  assert.equal(getAtomicDecisionView(p,5,p.round,clock).fresh,true);
  assert.equal(projectServerClock(f.now,10_900,12_900),f.now+2000);
});
test("transient refresh retains exactly the last same-round source, then withholds at the real TTL",()=>{
  const f=fixture(),p=f.read(),original=structuredClone(p);
  const pending=getAtomicDecisionView(p,5,p.round,f.now+5000);
  assert.equal(pending.fresh,true);assert.equal(pending.sourceAgeMs,5000);assert.equal(pending.lean,"UP");
  const stale=getAtomicDecisionView(p,5,p.round,f.now+10_001);
  assert.equal(stale.fresh,false);assert.equal(stale.lean,null);assert.equal(stale.score,null);
  assert.match(stale.reason,/Source stale/);assert.deepEqual(p,original);
  assert.equal(getAtomicDecisionView(p,5,p.round,f.identity.expiryMs).decision,null);
});
test("cached receipt cannot create freshness or another observation",()=>{
  const f=fixture(),before=f.read();
  f.tracker.observe(f.identity,{atMs:f.now+5000,receivedAtMs:f.now,probabilityUp:.9,probabilityDown:.1,
    providerSourceAtMs:null,sourceHealthy:true});
  const after=f.read(f.now+10_001);
  assert.equal(after.decision!.market!.receivedAtMs,f.now);
  assert.equal(after.decision!.market!.probabilityUp,.8);
  assert.equal(f.read().decision!.readiness.components.observationCount,before.decision!.readiness.components.observationCount);
  assert.equal(validateDecisionSnapshot(after,5),null);
  assert.equal(getAtomicDecisionView(after,5,after.round,f.now+10_001).fresh,false);
});
test("malformed, wrong interval, wrong round, future/expired and backwards envelopes are rejected",()=>{
  const f=fixture(),p=f.read();
  assert.equal(validateLiveEnvelope({...p,intervalMinutes:15},5),"INTERVAL_OR_SERVER_TIME_INVALID");
  assert.equal(validateLiveEnvelope({...p,serverTime:new Date(f.now-1).toISOString()},5,p),"SERVER_TIME_REGRESSION");
  assert.equal(validateLiveEnvelope({...p,round:{...p.round!,id:"other"}},5,p),"ROUND_IDENTITY_REGRESSION");
  assert.equal(validateLiveEnvelope({...p,serverTime:new Date(f.identity.expiryMs).toISOString()},5),"ROUND_EXPIRED_OR_NOT_STARTED");
  assert.equal(validateLiveEnvelope({...p,round:false} as unknown as LiveSnapshotEnvelope,5),"ROUND_IDENTITY_INVALID");
  assert.equal(getAtomicDecisionView(p,5,{...p.round!,id:"other"},f.now).decision,null);
  assert.equal(getAtomicDecisionView(p,5,p.round,NaN).decision,null);
  const wrongPolicy=structuredClone(p);wrongPolicy.decision!.policyVersion="unverified";
  assert.equal(validateDecisionSnapshot(wrongPolicy,5),"ROUND_IDENTITY_OR_CONTRACT_MISMATCH");
  const wrongSide=structuredClone(p);wrongSide.decision!.readiness.side="DOWN";
  assert.equal(validateDecisionSnapshot(wrongSide,5),"READINESS_SOURCE_MISMATCH");
  const unsafe=structuredClone(p);(unsafe.decision as unknown as {tradeAllowed:boolean}).tradeAllowed=true;
  assert.equal(validateDecisionSnapshot(unsafe,5),"PUBLICATION_OR_AUTHORITY_INVALID");
});
test("versions cannot regress, but verified new streams can restart their counter",()=>{
  const f=fixture(),old=f.read(),newer=f.read(f.now+1);
  assert.equal(validateDecisionSnapshot(old,5,newer),"SERVER_TIME_REGRESSION");
  const backwards=structuredClone(newer);backwards.decision!.stateVersion=old.decision!.stateVersion;
  assert.equal(validateDecisionSnapshot(backwards,5,old),"STATE_VERSION_REGRESSION");
  const restart=createRoundDecisionTracker();
  restart.observe(f.identity,{atMs:f.now+2,receivedAtMs:f.now+2,probabilityUp:.8,probabilityDown:.2,
    providerSourceAtMs:null,sourceHealthy:true});
  const p={...old,serverTime:new Date(f.now+2).toISOString(),decision:restart.read(f.identity,f.now+2)};
  assert.notEqual(p.decision!.streamId,old.decision!.streamId);
  assert.equal(validateDecisionSnapshot(p,5,newer),null);
});
test("known frozen choice survives stale data and cannot disappear or mutate across a restart",()=>{
  const f=fixture();
  f.tracker.committed(f.identity,{side:"UP",probabilityUp:.8,decisionAtMs:f.now,committedAtMs:f.now+10});
  const old=f.read(f.now+10),stale=getAtomicDecisionView(old,5,old.round,f.now+20_000);
  assert.equal(stale.lean,null);assert.equal(stale.decision!.canonical!.side,"UP");
  const changed=structuredClone(f.read(f.now+20));
  changed.decision!.canonical!.side="DOWN";
  assert.equal(validateDecisionSnapshot(changed,5,old),"IMMUTABLE_CHOICE_REGRESSION");
  const lost=structuredClone(f.read(f.now+30));lost.decision!.canonical=null;lost.decision!.persistence.status="QUEUED";
  assert.equal(validateDecisionSnapshot(lost,5,old),"IMMUTABLE_CHOICE_REGRESSION");
  const restored=structuredClone(f.read(f.now+40));restored.decision!.streamId="restored";
  restored.decision!.stateVersion=1;restored.decision!.canonical!.committedAtMs=null;
  assert.equal(validateDecisionSnapshot(restored,5,old),null,"Restoration must not invent a new commit acknowledgement.");
  assert.equal(validateDecisionSnapshot({...old,serverTime:new Date(f.now+50).toISOString(),round:null,decision:null},5,old),
    "WAITING_FOR_ACTIVE_ROUND","A transient unavailable response cannot replace the accepted frozen snapshot.");
});
test("cold source, queued, writing, failed and successful write without choice have honest states",()=>{
  const f=fixture(),cold=createRoundDecisionTracker();
  cold.discovered(f.identity,f.now);
  const p={...f.read(),decision:cold.read(f.identity,f.now)};
  assert.equal(validateDecisionSnapshot(p,5),null);assert.equal(getAtomicDecisionView(p,5,p.round,f.now).lean,null);
  const due=f.identity.expiryMs-60_000;
  cold.queued(f.identity,due);assert.equal(cold.read(f.identity,due)!.persistence.status,"QUEUED");
  cold.writing(f.identity,due+1);assert.equal(cold.read(f.identity,due+1)!.persistence.status,"WRITING");
  cold.queued(f.identity,due+2);assert.equal(cold.read(f.identity,due+2)!.persistence.status,"WRITING");
  cold.failed(f.identity,"57014",due+3);assert.equal(cold.read(f.identity,due+3)!.persistence.status,"FAILED");
  assert.equal(cold.writeFinished(f.identity,due+4),false);
  assert.equal(cold.read(f.identity,due+4)!.persistence.status,"AWAITING_CHOICE");
  cold.committed(f.identity,{side:"UP",probabilityUp:.8,decisionAtMs:due,committedAtMs:due+5});
  assert.equal(cold.writeFinished(f.identity,due+6),true);
  cold.failed(f.identity,"TIMEOUT",due+7);assert.equal(cold.read(f.identity,due+7)!.persistence.status,"COMMITTED");
});
test("browser retries have bounded exponential backoff/jitter and exclude contract/auth errors",()=>{
  assert.equal(snapshotRetryDelay(0,()=>0),300);assert.equal(snapshotRetryDelay(1,()=>.5),700);
  assert.ok(snapshotRetryDelay(9,()=>.99)<2700);
  for(const code of ["NETWORK_ERROR","REQUEST_TIMEOUT","HTTP_429","HTTP_503"])assert.equal(transientSnapshotFailure(code),true);
  for(const code of ["HTTP_401","HTTP_403","IMMUTABLE_CHOICE_REGRESSION","ROUND_IDENTITY_INVALID","RESPONSE_PARSE_ERROR"])
    assert.equal(transientSnapshotFailure(code),false);
});
