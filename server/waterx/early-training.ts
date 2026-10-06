import {randomUUID} from "node:crypto";
import {researchPool} from "./research-store";
import type {LockDb} from "./lock-store";
import {fitLogistic} from "./research-training-model";
import {sigmoid,logit} from "./bluewater-fast";
import {metrics} from "./bluewater-metrics";
import {TIMED_STRATEGY,earlyHorizons} from "../../shared/timed-decision";
import {digestEarlySnapshot} from "./early-horizons";
import {evaluateEarlyStopping} from "./early-stopping";
import {trainPooledGates} from "./pooled-early-training";
import {auditEarlyDataset} from "./early-dataset";
import {compareEarlyModels} from "./early-model-comparison";
export type EarlyTrainingRow={
  interval:5|15;roundId:string;startMs:number;expiryMs:number;horizon:number;probability:number;
   outcome:"UP"|"DOWN";labelAvailableAtMs:number;snapshotDigest:string;features?:Record<string,unknown>;
};
/** Predeclared chronological UTC boundaries are shared across both intervals.
 * Whole overlapping 15m blocks remain in one partition; labels must be known
 * before the next partition. Each horizon has one outcome per unique round. */
export function trainEarlyHorizon(rows:EarlyTrainingRow[],interval:5|15,horizon:number,now:number){
   const day=86400000,cutoff=Math.floor(now/day)*day,trainEnd=cutoff-4*day,calEnd=cutoff-3*day;
   const policyEnd=cutoff-2*day;
  const selected=rows.filter(r=>r.interval===interval&&r.horizon===horizon&&r.startMs>=cutoff-14*day&&
    r.expiryMs<=cutoff&&r.labelAvailableAtMs<=now&&Number.isFinite(r.probability)&&r.probability>=0&&r.probability<=1);
  const keys=new Set<string>(),unique=selected.filter(r=>{const key=r.roundId+":"+r.startMs+":"+r.expiryMs;
    if(keys.has(key))return false;keys.add(key);return true;});
  const training=unique.filter(r=>r.expiryMs<=trainEnd&&r.labelAvailableAtMs<=trainEnd);
  const calibration=unique.filter(r=>r.startMs>=trainEnd&&r.expiryMs<=calEnd&&r.labelAvailableAtMs<=calEnd);
   const test=unique.filter(r=>r.startMs>=policyEnd&&r.expiryMs<=cutoff);
  const rejected={duplicates:selected.length-unique.length,partitionBoundaryOrLabelEmbargo:unique.length-training.length-calibration.length-test.length};
   const base={interval,horizon,protocol:"early-chronological-10d-1d-1d-2d-label-embargo-v2",
     datasetCutoffMs:now,partitions:{trainEndMs:trainEnd,calibrationEndMs:calEnd,policyEndMs:policyEnd,testEndMs:cutoff},
    counts:{eligible:unique.length,training:training.length,calibration:calibration.length,test:test.length},rejected,
    fingerprint:digestEarlySnapshot(unique.map(r=>[r.roundId,r.startMs,r.horizon,r.snapshotDigest,r.outcome]))};
  if(training.length<200||calibration.length<60||test.length<60||
    [training,calibration,test].some(part=>new Set(part.map(r=>r.outcome)).size<2))
    return {...base,status:"INSUFFICIENT",reason:"Requires 200 training, 60 calibration, 60 untouched test rounds and both classes per partition.",artifact:null};
  const y=(r:EarlyTrainingRow)=>r.outcome==="UP"?1:0;
  // Small ridge-regularized market calibration challenger, not a claim of
  // incremental non-market information. Features remain available for later ablation.
  const fit=fitLogistic(training.map(r=>[logit(r.probability)]),training.map(y),.1,600);
  const raw=(r:EarlyTrainingRow)=>sigmoid(fit.intercept+fit.coefficients[0]*logit(r.probability));
  const cal=fitLogistic(calibration.map(r=>[logit(raw(r))]),calibration.map(y),.1,400);
  const p=(r:EarlyTrainingRow)=>sigmoid(cal.intercept+cal.coefficients[0]*logit(raw(r)));
  const baseline=metrics(test.map(r=>({probability:r.probability,outcome:r.outcome})));
  const challenger=metrics(test.map(r=>({probability:p(r),outcome:r.outcome})));
  const body={format:"early-market-calibration-v1",interval,horizon,fittedAtMs:now,
    evidenceThroughMs:cutoff,fingerprint:base.fingerprint,parameters:fit,calibration:cal,
    baseline,challenger,partitions:base.partitions,counts:base.counts};
  const digest=digestEarlySnapshot(body);
  return {...base,status:"EVALUATED",artifact:{...body,digest},baseline,challenger,
    promotion:"RETAIN_BASELINE",reason:"Shadow challenger only. Independent prospective qualification and full sequential stopping-policy evaluation are still required; no automatic earlier deadline promotion."};
}
export async function runEarlyDailyTraining(now=Date.now(),db:LockDb=researchPool,retryFailed=false){
  const day=new Date(now).toISOString().slice(0,10);
  for(const interval of [5,15] as const){
     const previous=(await db.query(`SELECT id,status,attempt,started_at_ms,dataset_cutoff_ms,
       report->'references' AS references,report->>'datasetDigest' AS dataset_digest FROM waterx_early_training_jobs
      WHERE day=$1 AND interval_minutes=$2 AND strategy_version=$3 ORDER BY attempt DESC LIMIT 1`,
      [day,interval,TIMED_STRATEGY])).rows[0];
     if(previous?.status==="EVALUATED"||previous?.status==="FAILED"&&!retryFailed||
       previous?.status==="RUNNING"&&now-Number(previous.started_at_ms)<600000)continue;
     if(previous?.status==="RUNNING"){
       await db.query(`UPDATE waterx_early_training_jobs SET status='FAILED',finished_at_ms=$2,error_class='STALE_RUNNING'
         WHERE id=$1 AND status='RUNNING'`,[previous.id,now]);
     }
     // Count all captured rows, including missing/disputed labels. SQL filtering
     // must not hide the cause of a zero-selected cohort.
     const selected=await db.query(`SELECT h.*,upper(l.outcome) AS outcome,l.label_status,
       l.settlement_disputed,l.settlement_quarantine,l.settled_at,l.settle_price,l.settlement_anchor_price,
       extract(epoch FROM l.first_verified_at)*1000 AS label_available_at_ms
       FROM waterx_early_horizons h LEFT JOIN waterx_learning_rounds l
         ON l.interval_minutes=h.interval_minutes AND l.round_id=h.round_id
         AND l.start_ms=h.start_ms AND l.expiry_ms=h.expiry_ms
       WHERE h.interval_minutes=$1 AND h.start_ms >= $2::bigint-14::bigint*86400000
         AND h.start_ms<=$2 ORDER BY h.start_ms,h.round_id,h.horizon_seconds LIMIT 40001`,[interval,now]);
      // Fourteen days contain at most 38,976 scheduled 15m gates (36,288 5m).
      // A smaller cap would permanently prevent a mature all-gate cohort fitting.
      if(selected.rows.length>40000)throw new Error("Early training explicit cohort bound exceeded");
     const dataset=auditEarlyDataset(selected.rows,interval,now);
     if(previous?.status==="INSUFFICIENT"&&previous.dataset_digest===dataset.datasetDigest)continue;
    const attempt=previous?Number(previous.attempt)+1:1;
    const id=randomUUID();
    const created=await db.query(`INSERT INTO waterx_early_training_jobs(id,day,interval_minutes,strategy_version,
      started_at_ms,dataset_cutoff_ms,status,attempt) VALUES($1,$2,$3,$4,$5,$5,'RUNNING',$6)
      ON CONFLICT(day,interval_minutes,strategy_version,attempt) DO NOTHING RETURNING id`,[id,day,interval,TIMED_STRATEGY,now,attempt]);
    if(!created.rows.length)continue;
    try{
       const rows=dataset.rows,digestRejected=dataset.funnel.byReason.SNAPSHOT_DIGEST_REJECTED??0;
        const referenceKey=(r:{roundId:unknown;startMs:unknown;horizon:unknown;snapshotDigest:unknown;outcome:unknown})=>
          `${r.roundId}:${Number(r.startMs)}:${Number(r.horizon)}:${r.snapshotDigest}:${r.outcome}`;
        const priorReferences=new Set(((previous?.references??[]) as Parameters<typeof referenceKey>[0][]).map(referenceKey));
      const reports=earlyHorizons(interval).map(h=>trainEarlyHorizon(rows,interval,h,now));
      const pooled=trainPooledGates(rows,interval,now);
      const forecasts=reports.map(r=>({horizon:r.horizon,artifact:r.artifact??
        (pooled.status==="EVALUATED"?pooled.artifact:null)}));
      const stopping=evaluateEarlyStopping(rows,interval,forecasts,now);
      await db.query(`UPDATE waterx_early_training_jobs SET finished_at_ms=$2,status=$3,report=$4 WHERE id=$1`,
        [id,Date.now(),reports.some(r=>r.status==="EVALUATED")||pooled.status==="EVALUATED"?"EVALUATED":"INSUFFICIENT",
           JSON.stringify({reports,pooled,stopping,digestRejected,selected:rows.length,
             funnel:dataset.funnel,datasetDigest:dataset.datasetDigest,
             modelComparison:compareEarlyModels(rows,interval,now),
             retainedBaselineStatus:"CANDIDATE_ONLY_BASELINE_RETAINED",
             newEligibleSincePreviousAttempt:rows.filter(r=>!priorReferences.has(referenceKey(r))).length,
            promotion:"RETAIN_BASELINE",
            stoppingPolicy:"SHADOW_FULL_SEQUENCE_EVALUATION",
            references:rows.map(r=>({roundId:r.roundId,startMs:r.startMs,expiryMs:r.expiryMs,
              horizon:r.horizon,outcome:r.outcome,snapshotDigest:r.snapshotDigest})),
            withdrawalPolicy:"No candidate is active. Requery verified labels on every run; retained artifact references enable outcome-withdrawal review."})]);
    }catch(error){
      await db.query(`UPDATE waterx_early_training_jobs SET finished_at_ms=$2,status='FAILED',error_class=$3 WHERE id=$1`,
        [id,Date.now(),(error as {code?:string}).code??(error as Error).message.slice(0,150)]);
      throw error;
    }
  }
}
export async function earlyLearningReport(db:LockDb=researchPool){
  const jobs=await db.query(`SELECT id,day,attempt,interval_minutes,strategy_version,started_at_ms,finished_at_ms,
    dataset_cutoff_ms,status,error_class,report-'references' AS report FROM waterx_early_training_jobs WHERE strategy_version=$1
    ORDER BY started_at_ms DESC LIMIT 20`,[TIMED_STRATEGY]);
  const affected=await db.query(`WITH recent AS(SELECT id,report FROM waterx_early_training_jobs
    WHERE strategy_version=$1 AND report @? '$.reports[*].artifact.digest'
    ORDER BY started_at_ms DESC LIMIT 20)
    SELECT r.id,count(*)::int AS affected_references FROM recent r
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.report->'references','[]'::jsonb)) ref
    LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=(r.report->'reports'->0->>'interval')::int
      AND l.round_id=ref->>'roundId' AND l.start_ms=(ref->>'startMs')::bigint AND l.expiry_ms=(ref->>'expiryMs')::bigint
    WHERE l.label_status IS DISTINCT FROM 'verified' OR l.settlement_disputed
      OR (l.settlement_quarantine IS NOT NULL AND l.settlement_quarantine<>'[]'::jsonb)
      OR upper(l.outcome) IS DISTINCT FROM ref->>'outcome'
    GROUP BY r.id`,[TIMED_STRATEGY]);
  const horizon=await db.query(`SELECT interval_minutes,horizon_seconds,status,count(*)::int AS n
    FROM waterx_early_horizons WHERE strategy_version=$1 GROUP BY interval_minutes,horizon_seconds,status`,
    [TIMED_STRATEGY]);
  const today=new Date().toISOString().slice(0,10);
  return {strategyVersion:TIMED_STRATEGY,jobs:jobs.rows,horizons:horizon.rows,modelStatus:"BASELINE_ONLY",
    affectedArtifacts:affected.rows,artifactAudit:"Referenced withdrawn/disputed outcomes require reevaluation; no challenger is active.",
    dailyHealth:[5,15].map(interval=>{
      const job=jobs.rows.find(j=>Number(j.interval_minutes)===interval&&new Date(String(j.day)).toISOString().slice(0,10)===today);
      return {interval,day:today,status:!job?"MISSED_OR_NOT_STARTED":
        job.status==="RUNNING"&&Date.now()-Number(job.started_at_ms)>600000?"STALE_RUNNING":job.status};
    }),
    stoppingPolicy:"Deterministic 30-second qualification gates v3; learned stopping promotion not qualified",automaticPromotion:false};
}
