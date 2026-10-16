import test from "node:test";
import assert from "node:assert/strict";
import {comparePlacementCandidate} from "../shared/placement-candidate";
const start=1_792_000_000_000,expiry=start+300000;
const base={startMs:start,expiryMs:expiry,placedAtMs:start+152000,side:"DOWN" as const,
  stages:{
    primary:{side:"DOWN" as const,acknowledgedAtMs:start+158000},
    early:{side:"DOWN" as const,acknowledgedAtMs:start+38000},
    confirmation:{side:"UP" as const,acknowledgedAtMs:start+100000},
  }};
test("without exact WaterX market identity, placement can only be a tentative timing candidate",()=>{
  const r=comparePlacementCandidate(base);
  assert.equal(r.state,"TIME_ONLY_CANDIDATE");
  assert.equal(r.marketIdentityVerified,false);
  assert.equal(r.canAttributeLoss,false);
  assert.equal(r.stages.find(s=>s.name==="Primary")?.status,"SAVED_AFTER_PLACEMENT");
  assert.equal(r.stages.find(s=>s.name==="Early")?.status,"AVAILABLE_BEFORE_PLACEMENT");
  assert.equal(r.stages.find(s=>s.name==="Confirmation")?.supportsSelection,false);
});
test("placement outside this round yields no supposed pre-entry prediction",()=>{
  for(const placedAtMs of [start-1,expiry,NaN]){
    const x=comparePlacementCandidate({...base,placedAtMs});
    assert.equal(x.state,"OUTSIDE_DISPLAYED_ROUND");
    assert.ok(x.stages.every(s=>s.supportsSelection===null));
  }
});
