import test from "node:test";
import assert from "node:assert/strict";
import {evaluateTimedDecision,timedWindow,TIMED_STRATEGY} from "../shared/timed-decision";
import type {LockObservation} from "../shared/lock-readiness";
import {buildTimedDecision} from "../server/waterx/timed-decision-builder";
import {createRoundDecisionTracker} from "../server/waterx/round-decision";
const start=1700000000000;
function round(interval:5|15){return {intervalMinutes:interval,roundId:`timed-${interval}`,startMs:start,expiryMs:start+interval*60000};}
function samples(at:number,p=.8):LockObservation[]{
  return Array.from({length:13},(_,i)=>({atMs:at-60000+i*5000,receivedAtMs:at-60000+i*5000,
    providerSourceAtMs:null,probabilityUp:p,probabilityDown:1-p,sourceHealthy:true}));
}
for(const interval of [5,15] as const){
  const r=round(interval),w=timedWindow(interval),target=start+w.targetSeconds*1000,hard=start+w.hardSeconds*1000;
  test(`${interval}m official elapsed schedule is target ${w.targetSeconds} / hard ${w.hardSeconds}`,()=>{
    assert.equal(buildTimedDecision(r,samples(target-1),start,target-1,true),null);
    const atTarget=buildTimedDecision(r,samples(target),start,target,true)!;
    assert.equal(atTarget.status,"LOCKED");assert.equal(atTarget.lockReason,"STABILITY_POLICY_QUALIFIED");
    assert.equal(atTarget.elapsedMs,w.targetSeconds*1000);assert.equal(atTarget.hardDeadlineAtMs,hard);
    assert.equal(atTarget.strategyVersion,TIMED_STRATEGY);assert.equal(atTarget.automaticExecutionAllowed,false);
  });
  test(`${interval}m weak valid evidence waits until hard deadline then freezes honest research baseline`,()=>{
    const rows=samples(hard,.56);
    assert.equal(buildTimedDecision(r,samples(target,.56),start,target,true),null);
    const d=buildTimedDecision(r,rows,start,hard,true)!;
    assert.equal(d.status,"LOCKED");assert.equal(d.side,"UP");
    assert.equal(d.lockReason,"DEADLINE_FALLBACK");assert.equal(d.onTime,null);
    assert.equal(d.earlyBlocker,"DIRECTIONAL_SEPARATION_BELOW_POLICY");
  });
  test(`${interval}m tie is deterministic, marked ambiguous and never automatic`,()=>{
    const d=buildTimedDecision(r,samples(hard,.5),start,hard,true)!;
    assert.equal(d.side,"UP");assert.equal(d.ambiguous,true);assert.equal(d.automaticExecutionAllowed,false);
  });
  test(`${interval}m missing/stale/invalid input records no fabricated side`,()=>{
    for(const [rows,valid] of [[[],false],[samples(hard-20000),true],[samples(hard),false]] as const){
      const d=buildTimedDecision(r,[...rows],start,hard,valid)!;
      assert.equal(d.status,"NO_VALID_INPUT");assert.equal(d.side,null);assert.equal(d.probabilityUp,null);
    }
  });
  test(`${interval}m first discovery after hard deadline is missed even if current prices are strong`,()=>{
    const d=buildTimedDecision(r,samples(hard+1000),hard+500,hard+1000,true)!;
    assert.equal(d.status,"MISSED_DEADLINE");assert.equal(d.side,null);
    assert.equal(d.lockReason,"COLLECTOR_DISCOVERED_AFTER_HARD_DEADLINE");
  });
  test(`${interval}m advancing time does not inflate probability or accrue observation persistence`,()=>{
    const rows=samples(target,.8),a=evaluateTimedDecision(r,rows,target),b=evaluateTimedDecision(r,rows,target+1000);
    assert(b.timeProgress>a.timeProgress);assert.equal(b.liveProbabilityUp,a.liveProbabilityUp);
    assert.equal(b.readinessPercent,a.readinessPercent);
    assert.equal(evaluateTimedDecision(r,rows,target+11000).liveSide,null);
  });
}
test("a saved timed choice is not an adaptive checkpoint or canonical choice and cannot cross rollover",()=>{
  const r=round(5),target=start+120000,d=buildTimedDecision(r,samples(target),start,target,true)!;
  const t=createRoundDecisionTracker();t.discovered(r,target);t.timedSaved(r,d);
  assert.equal(t.read(r,target)!.timedDecision!.saved!.id,d.id);
  assert.equal(t.read(r,target)!.canonical,null);
  assert.equal(t.read(r,target)!.earlyDecision,null);
  const next={...r,roundId:"next",startMs:r.expiryMs,expiryMs:r.expiryMs+300000};
  t.discovered(next,next.startMs);assert.equal(t.read(next,next.startMs)!.timedDecision!.saved,null);
});
