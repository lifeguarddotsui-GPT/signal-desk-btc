import { z } from "zod";
import { randomUUID } from "node:crypto";
import { FEATURE_NAMES, digest, type ModelArtifact } from "./bluewater-fast";
import { bluewaterSchema, persistArtifact, wrapArtifact, json, type Db } from "./bluewater-store";
import { loadBluewaterCohort, loadNumericCohort } from "./bluewater-cohort";
import { trainCanonicalWaterxBaseline } from "./research-baseline-training";
import { trainWaterxResearchChoices, validResearchTrainingRound, RESEARCH_SHADOW_FEATURE_NAMES } from "./research-training-model";
import { trainNumericChallenger } from "./bluewater-training";
import { getBluewaterReport, activeForecastSql, allForecastReadSql, pointsFromForecastRows } from "./bluewater-report";
import { compareMatched, metrics } from "./bluewater-metrics";
import { structuredResearchReport } from "./bluewater-agent";
const interval=z.union([z.literal(5),z.literal(15)]),id=z.string().regex(/^[a-f0-9]{64}$/);
const features=z.array(z.enum(FEATURE_NAMES)).min(1).max(FEATURE_NAMES.length)
  .refine(a=>new Set(a).size===a.length,"Duplicate features");
export const experimentSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("TRAIN_CHALLENGER"),interval,family:z.enum(["platt_waterx","rich_logistic","rich_logistic_no_market"]),
    features:features.optional(),cohort:z.enum(["verified-frozen-14d","prospective-features-14d"]),
    calibrationProtocol:z.literal("chronological-60-20-20")}).strict(),
  z.object({kind:z.literal("ABLATION"),interval,artifactId:id,feature:z.enum(FEATURE_NAMES)}).strict(),
  z.object({kind:z.literal("COMPARE"),interval,artifactIds:z.array(id).length(2).refine(a=>a[0]!==a[1])}).strict(),
  z.object({kind:z.literal("HORIZON_ANALYSIS"),interval,horizons:z.array(z.union([
     z.literal(180),z.literal(90),z.literal(60),z.literal(45),z.literal(30),z.literal(15)])).min(1).max(6)
     .refine(a=>new Set(a).size===a.length,"Duplicate horizons")}).strict(),
  z.object({kind:z.literal("ERROR_ANALYSIS"),interval,confidence:z.enum(["ALL","HIGH","MID","LOW"]),
    side:z.enum(["ALL","UP","DOWN"]),volatility:z.enum(["ALL","LOW","MID","HIGH","UNAVAILABLE"]).optional(),
    timing:z.enum(["ALL","EARLY","LATE"]).optional()}).strict(),
]);
export type ExperimentRequest=z.infer<typeof experimentSchema>;
function development(){if(process.env.NODE_ENV!=="development")throw new Error("Research writes are development-only.");}
const range=(rows:{startMs:number;expiryMs:number}[])=>({
  fromMs:Math.min(...rows.map(r=>r.startMs)),throughMs:Math.max(...rows.map(r=>r.expiryMs))});
const hasMarket=(names:string[])=>names.some(n=>n==="marketProbabilityUp"||n.startsWith("waterx_")||n.startsWith("probability_")||n==="recent_side_changes");
export async function runExperiment(db:Db,untrusted:unknown,now=Date.now()){
  development();const request=experimentSchema.parse(untrusted);
  if(!await bluewaterSchema(db))throw new Error("Reviewed Bluewater schema not applied.");
  let fingerprint=digest(request),result:unknown,status:"INSUFFICIENT"|"EVALUATED"|"COMPLETED"="COMPLETED";
  const artifacts:ModelArtifact[]=[];
  try {
  const cohort=await loadBluewaterCohort(db,request.interval,now);fingerprint=digest(cohort.canonical);
  if(request.kind==="TRAIN_CHALLENGER"){
    if(request.family==="platt_waterx"){
      if(request.cohort!=="verified-frozen-14d"||request.features&&
        (request.features.length!==1||request.features[0]!=="waterx_probability_up"))throw new Error("Platt requires canonical market-probability cohort.");
      const report=trainCanonicalWaterxBaseline(request.interval,cohort.canonical,{asOfMs:now});
      result=report;fingerprint=report.datasetFingerprint;status=report.eligibility.eligible?"EVALUATED":"INSUFFICIENT";
      const a=wrapArtifact(request.interval,report,request.family,Date.now(),range(cohort.canonical));if(a)artifacts.push(a);
    }else if(request.cohort==="verified-frozen-14d"){
      const names=request.features??[...RESEARCH_SHADOW_FEATURE_NAMES];
      if(names.some(n=>!(RESEARCH_SHADOW_FEATURE_NAMES as readonly string[]).includes(n)))throw new Error("New features require prospective-features-14d; no historical reconstruction.");
      const permitted=request.family==="rich_logistic_no_market"?names.filter(n=>n!=="marketProbabilityUp"):names;
      const report=trainWaterxResearchChoices(request.interval,cohort.rich,undefined,permitted);
      result=report;fingerprint=report.datasetFingerprint;status=report.eligibility.eligible?"EVALUATED":"INSUFFICIENT";
      const a=wrapArtifact(request.interval,report,request.family,Date.now(),range(cohort.rich));if(a)artifacts.push(a);
    }else{
      const rows=await loadNumericCohort(db,request.interval,now),names=request.features??(request.family==="rich_logistic_no_market"?
        ["btc_return_60s","volatility_60s"]:["waterx_probability_up","btc_return_60s","volatility_60s"]);
      if(request.family==="rich_logistic_no_market"&&hasMarket(names))throw new Error("No-market family cannot retain derived market features.");
      const report=trainNumericChallenger(request.interval,rows,names,now,request.family);
      result=report;fingerprint=report.datasetFingerprint;status=report.status as "INSUFFICIENT"|"EVALUATED";
      if(report.artifact)artifacts.push(report.artifact);
    }
  }else if(request.kind==="ABLATION"){
    const selected=await db.query("SELECT * FROM waterx_research_artifacts WHERE interval_minutes=$1 AND artifact_id=$2",[request.interval,request.artifactId]);
    if(!selected.rows[0])throw new Error("Ablation source artifact not found.");
    const source=json<Omit<ModelArtifact,"id"|"artifactDigest">>(selected.rows[0].artifact);
    if(source.family!=="rich_logistic"||!source.featureNames.includes(request.feature))throw new Error("Ablation requires a rich source artifact containing the removed feature.");
    // Use the same complete eligible input cohort for WITH and WITHOUT fits.
    // A reduced feature list is not permitted to silently enlarge B's dataset.
    if(source.featureNames.every(n=>(RESEARCH_SHADOW_FEATURE_NAMES as readonly string[]).includes(n))){
      const canonicalIds=new Set(cohort.canonical.map(r=>r.roundId));
      const shared=cohort.rich.filter(r=>canonicalIds.has(r.roundId)&&validResearchTrainingRound(r,request.interval));
      const withReport=trainWaterxResearchChoices(request.interval,shared,undefined,source.featureNames);
      const withoutNames=source.featureNames.filter(n=>n!==request.feature);
      const withoutReport=trainWaterxResearchChoices(request.interval,shared,undefined,withoutNames);
      const sharedIds=new Set(shared.map(r=>r.roundId));
      const control=trainCanonicalWaterxBaseline(request.interval,cohort.canonical.filter(r=>sharedIds.has(r.roundId)),{asOfMs:now});
      fingerprint=withReport.datasetFingerprint;
      result={matchedInputCount:shared.length,withMarket:withReport,withoutFeature:withoutReport,control,
        rawWaterx:control.test.frozenProbability,calibratedWaterx:control.test.candidate,
        exactSameInputFingerprint:withReport.datasetFingerprint===withoutReport.datasetFingerprint,
        note:"Historical chronological ablation; not prospective superiority or causal independence."};
      status=withReport.eligibility.eligible&&withoutReport.eligibility.eligible&&control.eligibility.eligible?"EVALUATED":"INSUFFICIENT";
      for(const [r,family] of [[withReport,"rich_logistic"],[withoutReport,request.feature==="marketProbabilityUp"?"rich_logistic_no_market":"rich_logistic"]] as const){
        const a=wrapArtifact(request.interval,r,family,Date.now(),range(shared));if(a)artifacts.push(a);}
    }else{
      const input=await loadNumericCohort(db,request.interval,now);
      const matched=input.filter(r=>source.featureNames.every(n=>r.snapshot.values[n]!=null));
      const a=trainNumericChallenger(request.interval,matched,source.featureNames,now);
      const b=trainNumericChallenger(request.interval,matched,source.featureNames.filter(n=>n!==request.feature),now,
        hasMarket(source.featureNames.filter(n=>n!==request.feature))?"rich_logistic":"rich_logistic_no_market");
      // Same native probability and capture timestamp as A/B, not a different-time control.
      const control=trainCanonicalWaterxBaseline(request.interval,matched.map(r=>({
        intervalMinutes:r.snapshot.intervalMinutes,roundId:r.snapshot.roundId,startMs:r.snapshot.startMs,
        expiryMs:r.snapshot.expiryMs,decisionAtMs:r.snapshot.decisionAtMs,
        probabilityUp:r.snapshot.values.waterx_probability_up!,outcome:r.outcome,
        settledAtMs:r.settledAtMs,labelAvailableAtMs:r.labelAvailableAtMs})),{asOfMs:now});
      fingerprint=a.datasetFingerprint;result={withFeatures:a,withoutFeature:b,rawWaterx:control.test.frozenProbability,
        calibratedWaterx:control.test.candidate,exactSameInputFingerprint:a.datasetFingerprint===b.datasetFingerprint,
        matchedTestKeys:a.testKeys.filter(k=>b.testKeys.includes(k)),control,
        note:"Descriptive matched ablation, not causal. Controls use exactly the A/B snapshot's native probability and decision time."};
      status=a.status==="EVALUATED"&&b.status==="EVALUATED"&&control.eligibility.eligible?"EVALUATED":"INSUFFICIENT";
      for(const r of [a,b])if(r.artifact)artifacts.push(r.artifact);
    }
  }else if(request.kind==="COMPARE"){
    const f=await db.query(activeForecastSql,[request.interval,now,now-14*86400000]);
    if(f.rows.length>50000)throw new Error("Prospective comparison bound exceeded.");
    const points=pointsFromForecastRows(f.rows).filter(p=>request.artifactIds.includes(p.artifactId));
    fingerprint=digest(points);result=compareMatched(points,request.artifactIds);
    if((result as {matchedN:number}).matchedN<90)status="INSUFFICIENT";
  }else if(request.kind==="HORIZON_ANALYSIS"){
    const r=await db.query(`SELECT h.*,upper(l.outcome) AS outcome FROM waterx_research_horizon_snapshots h
      JOIN waterx_learning_rounds l USING(interval_minutes,round_id,start_ms,expiry_ms)
      WHERE h.interval_minutes=$1 AND h.lock_seconds=ANY($2::smallint[]) AND h.valid AND h.eligible
        AND h.actual_at_ms>=$3 AND h.expiry_ms<=$4 AND l.label_status='verified' AND NOT l.settlement_disputed
        AND l.first_verified_at<=to_timestamp($4::double precision/1000) AND l.settled_at>h.expiry_ms AND l.settled_at<=$4
        AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
      ORDER BY h.start_ms,h.lock_seconds LIMIT 30001`,[request.interval,request.horizons,now-14*86400000,now]);
    if(r.rows.length>30000)throw new Error("Matched horizon bound exceeded.");
    const grouped=new Map<string,Record<string,unknown>[]>();
    for(const row of r.rows){const key=`${row.round_id}:${row.start_ms}:${row.expiry_ms}`;
      grouped.set(key,[...(grouped.get(key)??[]),row]);}
    const common=Array.from(grouped.values()).filter(rows=>request.horizons.every(h=>rows.some(r=>Number(r.lock_seconds)===h))).flat();
    const horizons=request.horizons.map(h=>{const rows=common.filter(r=>Number(r.lock_seconds)===h);
      const values=rows.map(r=>(Number(r.expiry_ms)-Number(r.actual_at_ms))/1000);
      return {lockSeconds:h,...metrics(rows.map(r=>({probability:Number(r.probability_up),outcome:r.outcome as "UP"|"DOWN"}))),
        actualTiming:values.length?{min:Math.min(...values),max:Math.max(...values),mean:values.reduce((a,b)=>a+b,0)/values.length}:null};});
    result={horizons,matchedN:common.length/request.horizons.length,matchedOnly:true,optimalHorizon:null,
      note:"All requested horizons must exist on the exact same verified round identities. Reliability bins are descriptive unless n>=20."};
    if(common.length/request.horizons.length<90)status="INSUFFICIENT";
    fingerprint=digest(result);
  }else{
    const read=await db.query(`${allForecastReadSql} ORDER BY f.decision_at_ms DESC LIMIT 300001`,[request.interval,now,now-14*86400000]);
    if(read.rows.length>300000)throw new Error("Error analysis bound exceeded.");
    const all=read.rows.filter(r=>r.active_outcome&&r.chosen_side!==r.active_outcome).map(r=>{
      const features=json<Record<string,number|null>>(r.features),p=Number(r.displayed_probability_up);
      const confidence=r.chosen_side==="UP"?p:1-p,v=features.volatility_60s;
      return {artifactId:String(r.model_artifact_id),roundId:String(r.round_id),side:String(r.chosen_side),probability:confidence,
        lockSeconds:Number(r.lock_seconds),secondsBeforeExpiry:(Number(r.expiry_ms)-Number(r.decision_at_ms))/1000,
        features,confidenceBucket:confidence>=.9?"HIGH":confidence>=.7?"MID":"LOW",
        volatilityBucket:v==null?"UNAVAILABLE":v<5?"LOW":v<20?"MID":"HIGH"};});
    const mistakes=all.filter(m=>(request.side==="ALL"||m.side===request.side)&&
      (request.confidence==="ALL"||m.confidenceBucket===request.confidence)&&
      (!request.volatility||request.volatility==="ALL"||m.volatilityBucket===request.volatility)&&
      (!request.timing||request.timing==="ALL"||(request.timing==="LATE"?m.secondsBeforeExpiry<=30:m.secondsBeforeExpiry>30)));
    result={mistakes:mistakes.slice(0,100),matchedErrorCount:mistakes.length,scope:"All captured model horizons; 100 recent contexts displayed.",
      descriptiveOnly:true};fingerprint=digest(mistakes);
  }
  for(const a of artifacts)await persistArtifact(db,a);
  const experimentId=randomUUID();
  await db.query(`INSERT INTO waterx_research_experiments
    (experiment_id,interval_minutes,kind,request,dataset_fingerprint,parameters,artifact_ids,result,status)
    VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9)`,
  [experimentId,request.interval,request.kind,JSON.stringify(request),fingerprint,JSON.stringify({maxRows:5000,lookbackDays:14}),
    JSON.stringify(artifacts.map(a=>a.id)),JSON.stringify(result),status]);
  return {experimentId,status,datasetFingerprint:fingerprint,artifactIds:artifacts.map(a=>a.id),result};
  } catch(error) {
    await db.query(`INSERT INTO waterx_research_experiments
      (experiment_id,interval_minutes,kind,request,dataset_fingerprint,parameters,artifact_ids,result,status)
      VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7::jsonb,$8::jsonb,'FAILED')`,
    [randomUUID(),request.interval,request.kind,JSON.stringify(request),fingerprint,
      JSON.stringify({maxRows:5000,lookbackDays:14}),JSON.stringify(artifacts.map(a=>a.id)),
      JSON.stringify({failureCode:(error as {code?:string}).code??"EXPERIMENT_REJECTED",message:"Valid request failed; no promotion or execution performed."})]);
    throw error;
  }
}
export async function writeDailyResearchReport(db:Db,interval:5|15,now=Date.now()){
  if(!await bluewaterSchema(db))return;
  const day=new Date(now).toISOString().slice(0,10);
  const prior=await db.query("SELECT 1 FROM waterx_research_agent_reports WHERE interval_minutes=$1 AND scheduled_day=$2",[interval,day]);
  if(prior.rows.length)return;
  const report=await getBluewaterReport(interval,null,db,now);
  if(report.schemaStatus!=="available")throw new Error("Structured research input unavailable.");
  const {getResearchHorizonEvaluations}=await import("./research-lifecycle");
  const structured={...structuredResearchReport(report),horizons:await getResearchHorizonEvaluations(db,interval)};
  await db.query(`INSERT INTO waterx_research_agent_reports(interval_minutes,scheduled_day,report)
    VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`,[interval,day,JSON.stringify(structured)]);
}