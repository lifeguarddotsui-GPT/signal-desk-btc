import {randomUUID} from "node:crypto";
import {EVENT_LOCK_STRATEGY,EVENT_FEATURE_VERSION,eventQualification,type EventObservation} from "../../shared/event-lock";
import type {TimedRound} from "../../shared/timed-decision";
import {fitLogistic} from "./research-training-model";
import {sigmoid,logit} from "./bluewater-fast";
import {metrics as forecastMetrics} from "./bluewater-metrics";
import {digestEarlySnapshot} from "./early-horizons";
import {researchPool} from "./research-store";
import type {LockDb} from "./lock-store";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
import {economicTrainingReadiness} from "./event-value-evidence";

export const EVENT_TRAINING_PROTOCOL="event-whole-trajectory-4way-next-opportunity-v1";
export const EVENT_FEATURE_NAMES=["market_logit","elapsed_fraction","persistence_fraction","range_scaled",
  "reversals_scaled","forecast_change","spacing_gap","missing_reference","reference_distance","reference_provisional"] as const;
export type EventTrajectory=TimedRound&{
  observations:EventObservation[];outcome:"UP"|"DOWN";labelAvailableAtMs:number;verified:boolean;
};
type Partition="TRAIN"|"CALIBRATION"|"POLICY"|"TEST"|"EXCLUDED";
type NumericModel=ReturnType<typeof fitLogistic>;
type Point={at:number;probability:number;qualified:boolean;features:number[];outcome:"UP"|"DOWN"};
/** Absolute UTC boundaries shared by BOTH intervals. Boundary-crossing rounds
 * and delayed labels are excluded wholesale, not split into earlier features. */
export function eventPartition(r:EventTrajectory,now:number):Partition{
  const day=86400000,cutoff=Math.floor(now/day)*day;
  const stages:[Partition,number,number][]=[
    ["TRAIN",cutoff-14*day,cutoff-4*day],["CALIBRATION",cutoff-4*day,cutoff-3*day],
    ["POLICY",cutoff-3*day,cutoff-2*day],["TEST",cutoff-2*day,cutoff]];
  for(const [name,start,end] of stages)
    if(r.startMs>=start&&r.expiryMs<=end&&r.labelAvailableAtMs<=end)return name;
  return "EXCLUDED";
}
const clamp=(v:number,min=-1,max=1)=>Math.max(min,Math.min(max,v));
function points(r:EventTrajectory):Point[]{
  return r.observations.map((o,i)=>{
    const prefix=r.observations.slice(0,i+1),q=eventQualification(r,prefix,o.availableAtMs);
    const last=prefix.slice(Math.max(0,i-3)).find(p=>p.sourceHealthy&&Number.isFinite(p.probabilityUp))??o;
    const reference=typeof o.features.reference==="number"?o.features.reference:null;
    const comparison=o.features.comparison as {price?:number}|undefined;
    const sameSide=q.components?.sameSideMs??0,required=q.components?.requiredSameSideMs??1;
    return {at:o.availableAtMs,probability:o.sourceHealthy?o.probabilityUp:NaN,qualified:q.qualified,features:[
      clamp(logit(o.probabilityUp)/8),clamp((o.availableAtMs-r.startMs)/(r.expiryMs-r.startMs),0,1),
      clamp(sameSide/required,0,3),(q.components?.probabilityRange??1)/.1,
      clamp((q.components?.recentReversals??0)/4,0,1),clamp((o.probabilityUp-last.probabilityUp)/.1),
      i?clamp((o.receivedAtMs-prefix[i-1].receivedAtMs)/12000,0,3):1,
      reference===null?1:0,reference&&comparison?.price?clamp((comparison.price/reference-1)*100):0,
      o.features.referenceQuality==="confirmed"?0:1],outcome:r.outcome};
  });
}
const predict=(m:NumericModel,x:number[])=>sigmoid(m.intercept+x.reduce((s,v,i)=>s+v*m.coefficients[i],0));
const bothClasses=(rows:EventTrajectory[])=>new Set(rows.map(r=>r.outcome)).size===2;
const evenly=(s:Point[])=>s.length<=12?s:Array.from({length:12},(_,i)=>s[Math.floor(i*(s.length-1)/11)]);
export function selectFirstSequential(points:Point[],outcome:NumericModel,calibration:NumericModel,
  stopping:NumericModel){
  for(const p of points){
    if(!p.qualified)continue;
    const raw=predict(outcome,p.features),probability=predict(calibration,[logit(raw)]);
    if((probability>.5)!==(p.probability>.5))continue;
    if(predict(stopping,[...p.features,probability])>=.5)return {...p,probability};
  }
  return null; // Abstention, not a forced terminal choice.
}
/** TRAIN labels compare stop now with the NEXT eligible observation, not the
 * best future checkpoint. Only fitting may use later labels. Selection/evaluation
 * execute FIRST-stop sequentially and never inspect future outcomes. */
export function trainEventStopping(trajectories:EventTrajectory[],interval:5|15,now:number){
  const excluded:Record<string,number>={},seen=new Set<string>();
  const reject=(reason:string)=>{excluded[reason]=(excluded[reason]??0)+1;return false;};
  const unique=trajectories.filter(r=>{
    if(r.intervalMinutes!==interval)return false;
    const id=`${r.intervalMinutes}:${r.roundId}:${r.startMs}:${r.expiryMs}`;
    if(seen.has(id))return reject("duplicateRound");seen.add(id);
    if(!r.verified||!["UP","DOWN"].includes(r.outcome)||!Number.isSafeInteger(r.labelAvailableAtMs)||
      r.labelAvailableAtMs<=r.expiryMs||r.labelAvailableAtMs>now)return reject("unverifiedLabel");
    if(r.expiryMs-r.startMs!==interval*60000)return reject("invalidRound");
    if(!r.observations.length)return reject("noTrajectory");
    const ids=new Set<string>();
    for(let i=0;i<r.observations.length;i++){
      const o=r.observations[i];
      if(o.provenance!=="PROSPECTIVE")return reject("syntheticOrReconstructed");
      if(o.features.eventFeatureVersion!==EVENT_FEATURE_VERSION)return reject("incompatibleFeatureVersion");
      if(!Number.isSafeInteger(o.availableAtMs)||o.availableAtMs<o.receivedAtMs||
        o.availableAtMs>=r.expiryMs||o.receivedAtMs<r.startMs||
        ids.has(o.id)||(i>0&&o.receivedAtMs<=r.observations[i-1].receivedAtMs))return reject("unprovenTimingOrDuplicate");
      ids.add(o.id);
      // Retain missing observations for sequential gaps, but never fit a fabricated forecast.
      if(o.sourceHealthy&&!validWaterxProbabilityPair(o.probabilityUp,o.probabilityDown))
        return reject("invalidProbability");
    }
    return true;
  });
  const groups=Object.fromEntries(["TRAIN","CALIBRATION","POLICY","TEST"].map(stage=>
    [stage,unique.filter(r=>eventPartition(r,now)===stage)])) as Record<Exclude<Partition,"EXCLUDED">,EventTrajectory[]>;
  excluded.boundaryOrLabelEmbargo=unique.filter(r=>eventPartition(r,now)==="EXCLUDED").length;
  const counts=Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length]));
  const deficits=Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,{
    requiredRounds:60,missingRounds:Math.max(0,60-v.length),bothOutcomes:bothClasses(v)}]));
  const fingerprint=digestEarlySnapshot({protocol:EVENT_TRAINING_PROTOCOL,economicReadinessVersion:"event-value-whole-trajectory-readiness-v1",excluded,
    discoveredRounds:trajectories.filter(r=>r.intervalMinutes===interval).length,
    trajectories:unique.map(r=>({...r,partition:eventPartition(r,now)}))});
  const base={strategyVersion:EVENT_LOCK_STRATEGY,protocol:EVENT_TRAINING_PROTOCOL,featureVersion:EVENT_FEATURE_VERSION,
    interval,datasetFingerprint:fingerprint,counts,deficits,excluded,
    activePolicy:"RETAIN_30_SECOND_BENCHMARK",automaticPromotion:false,
    nextEligibilityCondition:"At least 60 verified prospective complete trajectories with both outcomes in EACH disjoint stage, with proven receipt availability and whole-round/overlap embargo.",
    compatibility:"30-second-only records cannot train intermediate-second stopping. Older trajectories require exact feature/timing provenance; no silent backfill."};
  if(Object.values(groups).some(g=>g.length<60||!bothClasses(g)))
    return {...base,status:"INSUFFICIENT",artifact:null};
  const sequences=(rows:EventTrajectory[])=>rows.map(r=>points(r));
  const fitPoints=sequences(groups.TRAIN).flatMap(evenly).filter(p=>Number.isFinite(p.probability)&&p.features.every(Number.isFinite));
  if(!fitPoints.length)return {...base,status:"INSUFFICIENT",artifact:null,reason:"No usable outcome-model features"};
  const outcome=fitLogistic(fitPoints.map(p=>p.features),fitPoints.map(p=>p.outcome==="UP"?1:0),.01,180);
  const calibrationPoints=sequences(groups.CALIBRATION).flatMap(evenly).filter(p=>Number.isFinite(p.probability)&&p.features.every(Number.isFinite));
  if(!calibrationPoints.length)return {...base,status:"INSUFFICIENT",artifact:null,reason:"No usable calibration features"};
  const calibration=fitLogistic(calibrationPoints.map(p=>[logit(predict(outcome,p.features))]),
    calibrationPoints.map(p=>p.outcome==="UP"?1:0),.01,180);
  const probability=(p:Point)=>predict(calibration,[logit(predict(outcome,p.features))]);
  const trainSequences=sequences(groups.TRAIN);
  const candidates=[0,.0001,.0005,.001].map(delayCost=>{
    const examples=trainSequences.flatMap(s=>s.filter(p=>p.qualified&&Number.isFinite(p.probability))).flatMap(p=>{
      const s=trainSequences.find(s=>s.includes(p))!;
      const next=s.find(n=>n.at>p.at&&n.qualified);
      if(!next)return []; // No training label that forces a final stop.
      const y=p.outcome==="UP"?1:0,error=(probability(p)-y)**2;
      const waitError=(probability(next)-y)**2+delayCost*(next.at-p.at)/1000;
      return [{x:[...p.features,probability(p)],y:Number(error<=waitError)}];
    });
    if(!examples.length)return null;
    const stopping=fitLogistic(examples.map(e=>e.x),examples.map(e=>e.y),.01,180);
    const evaluate=(rows:EventTrajectory[])=>{
      const seq=sequences(rows),picked=seq.map(s=>selectFirstSequential(s,outcome,calibration,stopping));
      const locked=picked.filter((p):p is NonNullable<typeof p>=>!!p);
      // Delay is an explicit validated cost; no target time enters eligibility.
      const losses=picked.map((p,i)=>p?(p.probability-(p.outcome==="UP"?1:0))**2+
        .0001*(p.at-rows[i].startMs)/1000:.25);
      return {discoveredRounds:rows.length,locks:locked.length,coverage:locked.length/rows.length,
        loss:losses.reduce((a,b)=>a+b,0)/losses.length,
        selected:forecastMetrics(locked),
        eligibleSnapshots:forecastMetrics(seq.flat().filter(p=>p.qualified&&Number.isFinite(p.probability))
          .map(p=>({...p,probability:probability(p)}))),
        allSnapshots:forecastMetrics(seq.flat().filter(p=>Number.isFinite(p.probability))
          .map(p=>({...p,probability:probability(p)})))};
    };
    return {delayCost,stopping,policy:evaluate(groups.POLICY),evaluate};
  }).filter((c):c is NonNullable<typeof c>=>!!c);
  const selected=candidates.slice().sort((a,b)=>a.policy.loss-b.policy.loss||a.delayCost-b.delayCost)[0];
  if(!selected)return {...base,status:"INSUFFICIENT",artifact:null,reason:"No paired next-eligible training opportunities"};
  const test=selected.evaluate(groups.TEST); // First and only use of final TEST labels.
  const body={outcome,calibration,stopping:selected.stopping,featureNames:EVENT_FEATURE_NAMES,
    delayCost:selected.delayCost,delayCostUnits:"expected squared prediction error per second",
    validationObjective:"Common to every candidate: first-stop squared error + 0.0001 per elapsed second; abstention 0.25. Candidate-specific costs train stopping but do not change selection scoring.",
    abstentionCost:.25,selectionStage:"POLICY",test,eligibleForProspectiveReview:test.locks>=60,
    finalTestUntouchedDuringSelection:true};
  return {...base,status:"EVALUATED",artifact:{...body,digest:digestEarlySnapshot(body)},
    candidates:candidates.map(c=>({delayCost:c.delayCost,policy:c.policy})),
    promotion:"RETAIN_BASELINE",note:"Offline research only. No active outcome/stopping policy is replaced, including when this challenger is worse."};
}

export async function loadEventTrajectories(db:LockDb=researchPool,now=Date.now()){
  const rows=await db.query(`SELECT r.interval_minutes,r.round_id,r.start_ms,r.expiry_ms,l.outcome,
    extract(epoch FROM l.first_verified_at)*1000 AS label_available_at_ms,
    coalesce(l.label_status='verified' AND NOT l.settlement_disputed
      AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
      AND l.settled_at>r.expiry_ms AND l.first_verified_at IS NOT NULL AND l.settle_price>0 AND l.settlement_anchor_price>0
      AND l.settle_price<'Infinity'::float8 AND l.settlement_anchor_price<'Infinity'::float8
      AND ((upper(l.outcome)='UP' AND l.settle_price>=l.settlement_anchor_price)
        OR(upper(l.outcome)='DOWN' AND l.settle_price<l.settlement_anchor_price)),false) AS verified,
    coalesce(x.observations,'[]'::jsonb) AS observations FROM waterx_timed_rounds r
    LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=r.interval_minutes AND l.round_id=r.round_id
      AND l.start_ms=r.start_ms AND l.expiry_ms=r.expiry_ms
    LEFT JOIN LATERAL(SELECT jsonb_agg(jsonb_build_object('input',o.input,'databaseAcceptedAtMs',o.accepted_at_ms)
      ORDER BY o.received_at_ms) AS observations FROM waterx_timed_observations o WHERE o.network=r.network
      AND o.strategy_version=r.strategy_version AND o.interval_minutes=r.interval_minutes AND o.round_id=r.round_id) x ON true
    WHERE r.strategy_version=$1 AND r.start_ms>=$2 AND r.expiry_ms<=$3
    ORDER BY r.start_ms DESC,r.interval_minutes LIMIT 5000`,[EVENT_LOCK_STRATEGY,now-14*86400000,now]);
  return rows.rows.map(row=>({
    intervalMinutes:Number(row.interval_minutes) as 5|15,roundId:String(row.round_id),
    startMs:Number(row.start_ms),expiryMs:Number(row.expiry_ms),outcome:String(row.outcome).toUpperCase() as "UP"|"DOWN",
    labelAvailableAtMs:row.label_available_at_ms==null?NaN:Math.ceil(Number(row.label_available_at_ms)),verified:row.verified===true,
    observations:(row.observations as {input:Record<string,unknown>;databaseAcceptedAtMs:number}[]).map(({input,databaseAcceptedAtMs})=>{
      const features=input.features as Record<string,unknown>;
      return {id:`${row.interval_minutes}:${row.round_id}:${input.receivedAtMs}`,atMs:Number(input.receivedAtMs),
        receivedAtMs:Number(input.receivedAtMs),availableAtMs:features.eventDurableAvailableAtMs==null?NaN:Number(features.eventDurableAvailableAtMs),
        databaseAcceptedAtMs:Number(databaseAcceptedAtMs),providerSourceAtMs:null,
        probabilityUp:input.probabilityUp==null?NaN:Number(input.probabilityUp),
        probabilityDown:input.probabilityDown==null?NaN:Number(input.probabilityDown),
        sourceHealthy:!features.sourceFailure&&input.probabilityUp!=null&&input.probabilityDown!=null,
        provenance:features.eventCaptureMode==="PROSPECTIVE"?"PROSPECTIVE" as const:"SYNTHETIC" as const,features};
    }),
  }));
}
/** Run only in the existing optional training subprocess, never inside locking. */
export async function runEventTrainingDay(interval:5|15,now=Date.now()){
  const day=new Date(now).toISOString().slice(0,10),c=await researchPool.connect();
  const identity=`${EVENT_LOCK_STRATEGY}:${interval}:${day}`;
  let jobId:string|null=null;
  try{
    const lock=await c.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",[identity]);
    if(!lock.rows[0]?.acquired)return {status:"BUSY"};
    const previous=await c.query(`SELECT id,status,report,attempt FROM waterx_early_training_jobs
      WHERE day=$1 AND interval_minutes=$2 AND strategy_version=$3 ORDER BY attempt DESC LIMIT 1`,
      [day,interval,EVENT_LOCK_STRATEGY]);
    const old=previous.rows[0];
    const trajectories=await loadEventTrajectories(c,now);
    const id=randomUUID(),attempt=Number(old?.attempt??0)+1;jobId=id;
    await c.query(`INSERT INTO waterx_early_training_jobs(id,day,interval_minutes,strategy_version,started_at_ms,
      dataset_cutoff_ms,status,attempt) VALUES($1,$2,$3,$4,$5,$5,'RUNNING',$6)`,
      [id,day,interval,EVENT_LOCK_STRATEGY,now,attempt]);
    const report={...trainEventStopping(trajectories,interval,now),economicReadiness:economicTrainingReadiness(trajectories,interval,now)};
    if(old?.report?.datasetFingerprint===report.datasetFingerprint&&old.status!=="FAILED"){
      await c.query("DELETE FROM waterx_early_training_jobs WHERE id=$1 AND status='RUNNING'",[id]);
      return old.report;
    }
    await c.query(`UPDATE waterx_early_training_jobs SET finished_at_ms=$2,status=$3,report=$4 WHERE id=$1`,
      [id,Date.now(),report.status,JSON.stringify({...report,jobId:id})]);
    return report;
  }catch(error){
    if(jobId)await c.query(`UPDATE waterx_early_training_jobs SET finished_at_ms=$2,status='FAILED',error_class=$3
      WHERE id=$1`,[jobId,Date.now(),error instanceof Error?error.name:"TRAINING_FAILURE"]).catch(()=>{});
    throw error;
  }finally{
    await c.query("SELECT pg_advisory_unlock(hashtext($1))",[identity]).catch(()=>{});c.release();
  }
}
