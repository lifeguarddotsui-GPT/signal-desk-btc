import test from "node:test";
import assert from "node:assert/strict";
import { buildFeatureSnapshot, digest, FEATURE_SCHEMA, infer, type ModelArtifact } from "../server/waterx/bluewater-fast";

const now=Date.now(), start=now-240000, end=start+300000;
const input=()=>({intervalMinutes:5 as const,roundId:"test",startMs:start,expiryMs:end,decisionAtMs:now,
  market:[{probabilityUp:0.6,probabilityDown:0.4,sourceAtMs:now-100,receivedAtMs:now-50}],
  ticks:[],reference:null});
function model():ModelArtifact {const payload={formatVersion:"bluewater-numeric-v1" as const,intervalMinutes:5 as const,
  family:"platt_waterx" as const,version:"fixture",featureSchema:FEATURE_SCHEMA,featureNames:["waterx_probability_up"],
  fittedAtMs:now-1000,evidenceThroughMs:now-2000,datasetFingerprint:"a".repeat(64),calibration:{slope:1,intercept:0},
  parameters:{},protocol:{eligible:true,records:120,spanMs:48*3600000,training:70,calibration:24,test:24},
  dateRange:{fromMs:now-172800000,throughMs:now-2000},partitions:{},hyperparameters:{},metrics:{}};
  return {...payload,id:digest(payload),artifactDigest:digest(payload)};}
test("feature snapshot and numerical inference are reproducible; raw/calibrated remain distinct",()=>{
  const f=buildFeatureSnapshot(input()), a=model();const one=infer(a,f),two=infer(a,f);
  assert.deepEqual(one,two);assert.equal(one.rawProbabilityUp,0.6);assert.ok(Math.abs(one.calibratedProbabilityUp!-0.6)<1e-10);
  assert.equal(f.values.btc_return_1s,null);assert.equal(f.digest,buildFeatureSnapshot(input()).digest);
});
test("future source and receipt timestamps rejected independently",()=>{
  for(const key of ["sourceAtMs","receivedAtMs"] as const){const v=input();v.market[0][key]=now+1;
    assert.throws(()=>buildFeatureSnapshot(v),/future|timely/);
    const t=input();t.ticks=[{price:100,sourceAtMs:now-1,receivedAtMs:now-1,[key]:now+1}] as never;
    assert.throws(()=>buildFeatureSnapshot(t),/future/);}
});
test("missing features never fabricated; model requiring them withheld",()=>{
  const f=buildFeatureSnapshot(input()), a=model();
  const {id,artifactDigest,...p}=a;const body={...p,family:"rich_logistic" as const,featureNames:["btc_return_1s"],
    parameters:{means:[0],scales:[1],coefficients:[1],intercept:0}};
  assert.throws(()=>infer({...body,id:digest(body),artifactDigest:digest(body)},f),/unavailable/);
});
test("artifacts must predate feature decision and retain authenticated digest",()=>{
  const f=buildFeatureSnapshot(input()),a=model();assert.throws(()=>infer({...a,fittedAtMs:now+1},f),/artifact/);
  assert.throws(()=>infer({...a,calibration:{slope:2,intercept:0}},f),/digest/);
});
test("JSON object order cannot change reproducibility digest",()=>{
  assert.equal(digest({b:2,a:1}),digest({a:1,b:2}));assert.notEqual(digest([1,2]),digest([2,1]));
});