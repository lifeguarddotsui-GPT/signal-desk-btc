import test from "node:test";
import assert from "node:assert/strict";
import {buildTimedDecision} from "../server/waterx/timed-decision-builder";
import {loadTimedDecision} from "../server/waterx/timed-decision-store";
test("historical late ACK retains its real timing and original failure classification",async()=>{
 const captured={id:"old",roundId:"old",intervalMinutes:5 as const,startMs:1000,expiryMs:301000,
 strategyVersion:"waterx-timed-baseline-v1",hardDeadlineAtMs:151000,decisionAtMs:151171,status:"LOCKED"};
 const saved=await loadTimedDecision(captured,{query:async()=>({rows:[{decision:captured,committed_ack_at_ms:151301,worker_received_at_ms:null}]})});
 assert.equal(saved!.onTime,false);assert.equal(saved!.operationalFailure,"COMMIT_AFTER_HARD_DEADLINE");
 assert.equal(saved!.decisionAtMs,151171);assert.equal(saved!.committedAtMs,151301);
});
test("fallback-preparation flag cannot bypass qualification in the new strategy",()=>{
 const r={intervalMinutes:5 as const,roundId:"gate",startMs:1700000000000,expiryMs:1700000300000};
 const at=r.startMs+90000,obs={atMs:at,receivedAtMs:at,providerSourceAtMs:null,probabilityUp:.525,probabilityDown:.475,sourceHealthy:true};
 assert.equal(buildTimedDecision(r,[obs],r.startMs,at,true,{},true),null);
});
