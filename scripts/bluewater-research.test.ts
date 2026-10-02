import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { experimentSchema, runExperiment } from "../server/waterx/bluewater-experiments";
import { trainCanonicalWaterxBaseline } from "../server/waterx/research-baseline-training";
import { buildFeatureSnapshot, digest, validateFeatureSnapshot, validateArtifact } from "../server/waterx/bluewater-fast";
import { trainNumericChallenger, type NumericTrainingRow } from "../server/waterx/bluewater-training";
import { metrics, paired, compareMatched, promotionGate, type MatchedPoint } from "../server/waterx/bluewater-metrics";
import { buildFunnel, pointsFromForecastRows } from "../server/waterx/bluewater-report";
import { researchHypotheses } from "../server/waterx/bluewater-agent";
import { inspectCanonicalCohort } from "../server/waterx/bluewater-cohort";
import { researchPool } from "../server/waterx/research-store";
const now=Date.now();
function rows():NumericTrainingRow[]{
  return Array.from({length:120},(_,i)=>{const start=now-4*86400000+i*1800000,at=start+240000;
    const outcome=i%2?"UP" as const:"DOWN" as const;
    return {snapshot:buildFeatureSnapshot({intervalMinutes:5,roundId:`synthetic-unit-${i}`,startMs:start,
      expiryMs:start+300000,decisionAtMs:at,market:[{sourceAtMs:at,receivedAtMs:at,probabilityUp:.5,probabilityDown:.5}],
      ticks:[{price:i%2?101:99,sourceAtMs:at-1,receivedAtMs:at}],reference:null}),
      outcome,settledAtMs:start+300001,labelAvailableAtMs:start+300002};});
}
test("strict experiment interface rejects SQL, executable code, deployment, promotion and unknown fields",()=>{
  for(const kind of ["SQL","DEPLOY","PROMOTE","SIGN","EXECUTE"])assert.equal(experimentSchema.safeParse({kind,interval:5}).success,false);
  const valid={kind:"TRAIN_CHALLENGER",interval:5,family:"platt_waterx",cohort:"verified-frozen-14d",calibrationProtocol:"chronological-60-20-20"};
  assert.equal(experimentSchema.safeParse(valid).success,true);
  for(const key of ["sql","code","wallet","promotion"])assert.equal(experimentSchema.safeParse({...valid,[key]:"forbidden"}).success,false);
});
test("snapshot derived values cannot be forged even with a newly recomputed digest",()=>{
  const f=rows()[0].snapshot;const {digest:old,...body}=f;body.values={...body.values,btc_price:999};
  assert.throws(()=>validateFeatureSnapshot({...body,digest:digest(body)}),/reproduc/);
});
test("no nonlinear dependencies or natural-language prompts sit in the numerical inference module",()=>{
  const fast=readFileSync("server/waterx/bluewater-fast.ts","utf8");
  assert.doesNotMatch(fast,/fetch\(|query\(|openai|anthropic|researchHypotheses|structuredResearchReport/);
});
test("slow planner has no store, query, signing, execution or promotion capability",()=>{
  const source=readFileSync("server/waterx/bluewater-agent.ts","utf8");
  assert.doesNotMatch(source,/from ["'][^"']*(?:store|wallet|deploy|executor)|\.query\(|fetch\(|runExperiment\(/);
});
test("research hypotheses are valid allowlisted specifications",()=>{
  const report={intervalMinutes:5,funnels:[],mistakes:[],training:{canonical:120},challengers:[]} as never;
  for(const h of researchHypotheses(report))assert.equal(experimentSchema.safeParse(h.experiment).success,true);
});
test("new numeric training preserves chronological minimums and embargo",()=>{
  const input=rows(),a=trainNumericChallenger(5,input,["waterx_probability_up","btc_price"],now);
  assert.equal(a.status,"EVALUATED");assert.ok(a.split.training>=40&&a.split.calibration>=20&&a.split.test>=20);
  assert.ok(a.split.trainThroughMs!<a.split.calibrationFromMs!);assert.ok(a.split.calibrationFromMs!<a.split.testFromMs!);
  validateArtifact(a.artifact!,Date.now());
  const small=trainNumericChallenger(5,input.slice(0,26),["waterx_probability_up"],now);
  assert.equal(small.status,"INSUFFICIENT");assert.equal(small.artifact,null);
});
test("market-dependence A/B uses exactly the same eligible input fingerprint and later test identities",()=>{
  const input=rows(),a=trainNumericChallenger(5,input,["waterx_probability_up","btc_price"],now),
    b=trainNumericChallenger(5,input,["btc_price"],now,"rich_logistic_no_market");
  assert.equal(a.datasetFingerprint,b.datasetFingerprint);assert.deepEqual(a.split,b.split);assert.deepEqual(a.testKeys,b.testKeys);
  assert.notEqual(a.artifact?.id,b.artifact?.id);assert.deepEqual(b.artifact?.featureNames,["btc_price"]);
  const control=trainCanonicalWaterxBaseline(5,input.map(r=>({intervalMinutes:5 as const,roundId:r.snapshot.roundId,
    startMs:r.snapshot.startMs,expiryMs:r.snapshot.expiryMs,decisionAtMs:r.snapshot.decisionAtMs,
    probabilityUp:r.snapshot.values.waterx_probability_up!,outcome:r.outcome,
    settledAtMs:r.settledAtMs,labelAvailableAtMs:r.labelAvailableAtMs})),{asOfMs:now});
  assert.equal(control.split.trainingCount,a.split.training);assert.equal(control.split.calibrationCount,a.split.calibration);
  assert.equal(control.split.testCount,a.split.test);assert.equal(control.test.frozenProbability?.count,a.testMetrics?.n);
});
test("duplicate horizons are rejected before an experiment can overcount its matched denominator",()=>{
  assert.equal(experimentSchema.safeParse({kind:"HORIZON_ANALYSIS",interval:5,horizons:[60,60]}).success,false);
});
test("valid but unexecutable owner experiment is recorded as FAILED without artifact or promotion writes",async()=>{
  const previous=process.env.NODE_ENV;process.env.NODE_ENV="development";
  const inserts:string[]=[];
  const db={async query(sql:string){if(sql.includes("INSERT INTO"))inserts.push(sql);
    return {rows:sql.includes("to_regclass")?[{available:true}]:[]};}};
  try{
    await assert.rejects(runExperiment(db,{kind:"ABLATION",interval:5,artifactId:"a".repeat(64),feature:"btc_price"}),/not found/);
    assert.equal(inserts.length,1);assert.match(inserts[0],/waterx_research_experiments/);assert.match(inserts[0],/'FAILED'/);
  }finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
});
test("missing rich features cannot remove canonical probability-only records",()=>{
  const input=rows(),rich=trainNumericChallenger(5,input,["btc_return_1s"],now);
  assert.equal(rich.eligibleCount,0);
  const canonical=input.map(r=>({intervalMinutes:5 as const,roundId:r.snapshot.roundId,startMs:r.snapshot.startMs,
    expiryMs:r.snapshot.expiryMs,decisionAtMs:r.snapshot.decisionAtMs,probabilityUp:.9,outcome:r.outcome,
    settledAtMs:r.settledAtMs,labelAvailableAtMs:r.labelAvailableAtMs}));
  assert.equal(inspectCanonicalCohort(canonical,5).records,120);
});
test("future feature receipts and source timestamps are excluded from training, not silently repaired",()=>{
  for(const key of ["sourceAtMs","receivedAtMs"] as const){
    const input=rows();input[0].snapshot.provenance.market[0][key]=input[0].snapshot.decisionAtMs+1;
    const report=trainNumericChallenger(5,input,["waterx_probability_up"],now);
    assert.equal(report.eligibleCount,119);
  }
});
test("incorrect and high-confidence mistakes remain in denominator and proper scores; ties select UP",()=>{
  const result=metrics([{probability:.9,outcome:"DOWN"},{probability:.5,outcome:"UP"}]);
  assert.equal(result.n,2);assert.equal(result.highConfidenceErrors,1);assert.equal(result.accuracy,.5);
  assert.ok(result.brier!>.5);
});
test("funnel reports missing choices, late timing, known discovery and theoretical counts separately",()=>{
  const f=buildFunnel([{round_id:"a",canonical:true,on_time:true,verified:true,scored:true,valid_observation:true},
    {round_id:"b",canonical:true,late:true,valid_observation:true},{round_id:"c",canonical:false}],
    5,now,now-86400000,new Set(["a"]),new Set(),{rounds:0,forecasts:0},"24h");
  assert.equal(f.missingChoices,1);assert.equal(f.onTimeChoices,1);assert.equal(f.lateChoices,1);
  assert.equal(f.expectedExactRounds,null);assert.equal(f.knownPublishedRounds,3);assert.ok(f.theoreticalTimeSlots>200);
});
test("paired prospective comparisons reject different snapshots or horizons",()=>{
  const p:MatchedPoint[]=[{key:"r:60:x",artifactId:"a",modelFamily:"rich_logistic",probability:.8,baseline:.6,outcome:"UP",decisionAtMs:1},
    {key:"r:60:y",artifactId:"b",modelFamily:"rich_logistic",probability:.8,baseline:.6,outcome:"UP",decisionAtMs:1}];
  assert.equal(compareMatched(p,["a","b"]).matchedN,0);
  p[1].key=p[0].key;assert.equal(compareMatched(p,["a","b"]).matchedN,1);
});
test("disputed or unresolved outcomes disappear from active model scores without changing predictions",()=>{
  const raw={round_id:"r",lock_seconds:60,feature_snapshot_digest:"x",model_artifact_id:"a",model_family:"platt_waterx",
    features:{waterx_probability_up:.5},displayed_probability_up:.8,active_outcome:"UP",decision_at_ms:1};
  assert.equal(pointsFromForecastRows([raw]).length,1);
  assert.equal(pointsFromForecastRows([{...raw,active_outcome:null}]).length,0);assert.equal(raw.displayed_probability_up,.8);
});
test("promotion remains manual and refuses tiny, short, uncalibrated or disputed prospective evidence",()=>{
  const comparison=paired([], "a"),gate=promotionGate({interval:5,comparison,spanMs:0,chronologicalEligible:true,
    calibrated:false,integrityIssues:["disputed"],hasChampion:false});
  assert.equal(gate.automatic,false);assert.equal(gate.manualApprovalRequired,true);assert.equal(gate.eligible,false);
  assert.ok(gate.reasons.some(r=>r.includes("90")));assert.ok(gate.reasons.includes("disputed"));
});
test("qualified descriptive promotion report still has no automatic activation",()=>{
  const input:MatchedPoint[]=Array.from({length:100},(_,i)=>({key:String(i),artifactId:"a",modelFamily:"rich_logistic",
    probability:i%2?.9:.1,baseline:.5,outcome:i%2?"UP":"DOWN",decisionAtMs:now-i*3600000}));
  const gate=promotionGate({interval:5,comparison:paired(input,"a"),spanMs:99*3600000,
    chronologicalEligible:true,calibrated:true,integrityIssues:[],hasChampion:false});
  assert.equal(gate.eligible,true);assert.equal(gate.automatic,false);
});
test("future risk and paper interfaces do not implement signing or live execution",()=>{
  const source=readFileSync("shared/bluewater-paper-boundary.ts","utf8");
  assert.doesNotMatch(source,/export (?:async )?function|privateKey|submitOrder|signTransaction/);
  assert.match(source,/killSwitch/);assert.match(source,/maximumSpend/);
});
test.after(()=>researchPool.end());