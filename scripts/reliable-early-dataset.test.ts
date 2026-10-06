import test from "node:test";
import assert from "node:assert/strict";
import {auditEarlyDataset} from "../server/waterx/early-dataset";
import {freezeEarlyHorizon,digestEarlySnapshot} from "../server/waterx/early-horizons";
import {TIMED_STRATEGY} from "../shared/timed-decision";
import {crossIntervalContext,earlyFeatureVector,inferEarlyModel,type IntervalObservation} from "../shared/early-features";
import {partitionEarlyRow,compareEarlyModels} from "../server/waterx/early-model-comparison";
import {trainEarlyHorizon,type EarlyTrainingRow} from "../server/waterx/early-training";
const start=Date.UTC(2026,9,5),now=start+86400000,expiry=start+300000;
function record(){
  const input={intervalMinutes:5 as const,roundId:"known-round",startMs:start,expiryMs:expiry,
    receivedAtMs:start+59000,observedAt:new Date(start+59000).toISOString(),probabilityUp:.8,probabilityDown:.2,
    features:{contextAvailableAtMs:start+59001}};
  const freeze=freezeEarlyHorizon(input,60,[input],start+60020,false);
  return {network:"sui:mainnet",strategy_version:TIMED_STRATEGY,interval_minutes:5,round_id:input.roundId,
    start_ms:start,expiry_ms:expiry,horizon_seconds:60,scheduled_at_ms:start+60000,frozen_at_ms:start+60020,
    status:"FROZEN",snapshot:freeze.snapshot,snapshot_sha256:freeze.digest,outcome:"UP",label_status:"verified",
    label_available_at_ms:expiry+2000,settled_at:expiry+1000,settle_price:101,settlement_anchor_price:100,
    settlement_disputed:false,settlement_quarantine:[]};
}
test("eligibility funnel reconciles every row and does not require every horizon of its round",()=>{
  const r=record(),bad={...r,round_id:"missing-label",snapshot:{...r.snapshot,roundId:"missing-label"},label_status:null};
  bad.snapshot_sha256=digestEarlySnapshot(bad.snapshot);
  const result=auditEarlyDataset([r,bad],5,now);
  assert.equal(result.funnel.captured,2);assert.equal(result.rows.length,1);
  assert.equal(result.funnel.excluded,1);assert.equal(result.funnel.byReason.SETTLEMENT_JOIN_MISSING,1);
  assert.equal(result.funnel.rows.filter(r=>r.primaryReason).length+result.rows.length,2);
  assert.equal(result.rows[0].horizon,60);
  assert.equal(trainEarlyHorizon(result.rows,5,60,now).counts.eligible,1);
});
test("row exclusions distinguish missing label availability, disputed labels, digest changes and missed capture",()=>{
  const cases=[{label_available_at_ms:null},{settlement_disputed:true},{snapshot_sha256:"bad"},{status:"MISSED_HORIZON"}];
  const reasons=["LABEL_AVAILABILITY_MISSING","DISPUTED_OR_QUARANTINED_LABEL","SNAPSHOT_DIGEST_REJECTED","MISSED_HORIZON"];
  cases.forEach((change,i)=>assert.equal(auditEarlyDataset([{...record(),...change}],5,now).funnel.rows[0].primaryReason,reasons[i]));
  assert.equal(auditEarlyDataset([record(),record()],5,now).funnel.byReason.DUPLICATE_EXACT_HORIZON,1);
});
test("availability and future cross context are rejected even when event timestamps look timely",()=>{
  const r=record(),snapshot={...r.snapshot,features:{...r.snapshot.features,crossInterval:{
    available:true,receivedAtMs:start+59000,availableAtMs:start+60001,providerSourceAtMs:null}}};
  const result=auditEarlyDataset([{...r,snapshot,snapshot_sha256:digestEarlySnapshot(snapshot)}],5,now);
  assert.equal(result.funnel.rows[0].primaryReason,"FUTURE_CROSS_INTERVAL_FEATURE");
});
const own:IntervalObservation={interval:5,roundId:"5",startMs:start,expiryMs:expiry,probabilityUp:.8,
  receivedAtMs:start+59000,availableAtMs:start+59001,providerSourceAtMs:null,reference:100,referenceQuality:"confirmed",
  comparison:101,comparisonAtMs:start+59000};
const other:IntervalObservation={...own,interval:15,roundId:"15",expiryMs:start+900000,probabilityUp:.2,reference:102};
test("opposite cross-interval directions remain separate; future, expired, stale and same-interval inputs are unavailable",()=>{
  const context=crossIntervalContext(own,other,start+60000);
  assert.equal(context.available,true);assert.equal("probabilityUp" in context?context.probabilityUp:null,.2);
  for(const bad of [{...other,availableAtMs:start+60001},{...other,providerSourceAtMs:start+60001},
    {...other,receivedAtMs:start+1000},{...other,expiryMs:start+60000},{...other,interval:5 as const}]){
    assert.equal(crossIntervalContext(own,bad,start+60000).available,false);
  }
});
test("UTC 15m blocks and actual labels enforce train/calibration/policy/test embargo",()=>{
  const r:EarlyTrainingRow={interval:5,roundId:"boundary",startMs:now-4*86400000-300000,
    expiryMs:now-4*86400000,horizon:60,probability:.8,outcome:"UP",labelAvailableAtMs:now-4*86400000+1000,snapshotDigest:"x"};
  assert.equal(partitionEarlyRow(r,now),"EXCLUDED");
  const late={...r,startMs:now-3*86400000,expiryMs:now-3*86400000+300000,labelAvailableAtMs:now+1};
  assert.equal(partitionEarlyRow(late,now),"EXCLUDED");
  assert.equal(compareEarlyModels([r],5,now).status,"INSUFFICIENT");
});
test("offline/runtime features and inference are identical and deterministic; feature mismatch fails",()=>{
  const features={sameSideMs:30000,referenceDistance:.01,crossInterval:crossIntervalContext(own,other,start+60000)};
  const a=earlyFeatureVector(.8,60,5,features,true),b=earlyFeatureVector(.8,60,5,JSON.parse(JSON.stringify(features)),true);
  assert.deepEqual(a,b);
  const model={means:a.map(()=>0),scales:a.map(()=>1),intercept:0,coefficients:a.map(()=>.01)};
  assert.equal(inferEarlyModel(model,a),inferEarlyModel(model,b));
  assert.throws(()=>inferEarlyModel(model,a.slice(1)),/mismatch/);
});
