import test from "node:test";
import assert from "node:assert/strict";
import {buildTimedDecision} from "../server/waterx/timed-decision-builder";
import {timedCompletionPolicy} from "../shared/timed-completion";
import {loadTimedDecision} from "../server/waterx/timed-decision-store";
const start=1700000000000;
test("captured production late ACK is reproduced without backdating or relabeling success",async()=>{
  // Timing-only sanitized fixture from the production API, 2026-10-05.
  // No synthetic probabilities, provider timestamps or actual fill are asserted.
  const captured={id:"4d1ba576-5216-42bc-8b63-19e231825ab0",
    roundId:"15789baa-b870-4067-ba10-5aea9aec98a1",intervalMinutes:5 as const,
    startMs:1791233100000,expiryMs:1791233400000,hardDeadlineAtMs:1791233250000,
    decisionAtMs:1791233250171,status:"LOCKED",committed_ack_at_ms:1791233250301};
  const saved=await loadTimedDecision(captured,{query:async()=>({rows:[{decision:captured,
    committed_ack_at_ms:captured.committed_ack_at_ms,worker_received_at_ms:null}]})});
  assert.equal(saved!.id,captured.id);assert.equal(saved!.onTime,false);
  assert.equal(saved!.operationalFailure,"COMMIT_AFTER_HARD_DEADLINE");
  assert.equal(saved!.committedAtMs! - captured.hardDeadlineAtMs,301);
  assert.equal(saved!.decisionAtMs,captured.decisionAtMs);
});
for(const interval of [5,15] as const){
  const hard=start+(interval===5?150000:450000);
  const allowance=timedCompletionPolicy(interval).allowanceMs;
  const r={intervalMinutes:interval,roundId:`buffer-${interval}`,startMs:start,expiryMs:start+interval*60000};
  const samples=(now:number,p=.56)=>[{atMs:now,receivedAtMs:now,providerSourceAtMs:null,
    probabilityUp:p,probabilityDown:1-p,sourceHealthy:true}];
  test(`${interval}m measured provisional fallback starts before durable deadline without backdating`,()=>{
    const at=hard-allowance;
    assert.equal(buildTimedDecision(r,samples(at-1),start,at-1,true,{},true),null);
    const d=buildTimedDecision(r,samples(at),start,at,true,{},true)!;
    assert.equal(d.status,"LOCKED");assert.equal(d.lockReason,"DEADLINE_BEST_SUPPORTED_CHOICE");
    assert.equal(d.decisionAtMs,at);assert.equal(d.hardDeadlineAtMs,hard);
    assert.equal(d.onTime,null);assert.equal(d.automaticExecutionAllowed,false);
    assert.equal(d.evidence.fallbackPreparation,true);
    assert.equal((d.evidence.completionPolicy as {verifiedSafeCutoff:boolean}).verifiedSafeCutoff,false);
  });
  test(`${interval}m missing evidence may recover until actual hard deadline`,()=>{
    assert.equal(buildTimedDecision(r,[],start,hard-allowance,false,{},true),null);
    assert.equal(buildTimedDecision(r,[],start,hard,false,{},true)!.status,"NO_VALID_INPUT");
  });
  test(`${interval}m buffered tie remains ambiguous and source timestamps remain real`,()=>{
    const at=hard-allowance,d=buildTimedDecision(r,samples(at,.5),start,at,true,{},true)!;
    assert.equal(d.ambiguous,true);assert.equal(d.receivedAtMs,at);assert.equal(d.side,"UP");
    assert.equal(buildTimedDecision(r,samples(hard+10),hard+1,hard+10,true,{},true)!.status,"MISSED_DEADLINE");
  });
}
