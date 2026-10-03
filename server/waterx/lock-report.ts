import type { LockReadinessReport, LockRoundSpeed, LockMetrics, LockPolicy } from "../../shared/lock-readiness";
import type { ResearchInterval } from "../../shared/waterx-research";
import { evaluateLockReadiness } from "./lock-readiness";
import { lockPool, lockObservation, type LockDb } from "./lock-store";

const numeric=(v:unknown)=>v==null?null:Number(v);
function metrics(points:{p:number;y:number}[]):LockMetrics {
  if(!points.length)return {n:0,accuracy:null,brier:null,logLoss:null};
  return {n:points.length,accuracy:points.filter(r=>(r.p>=.5?1:0)===r.y).length/points.length,
    brier:points.reduce((s,r)=>s+(r.p-r.y)**2,0)/points.length,
    logLoss:points.reduce((s,r)=>s-Math.log(Math.max(1e-10,Math.min(1-1e-10,r.y?r.p:1-r.p))),0)/points.length};
}
function comparison(rows:Record<string,unknown>[]) {
  const early=metrics(rows.map(r=>({p:Number(r.probability_up),y:r.outcome==="UP"?1:0})));
  const canonical=metrics(rows.map(r=>({p:Number(r.canonical_probability),y:r.outcome==="UP"?1:0})));
  return {state:rows.length<90?"INSUFFICIENT" as const:"DESCRIPTIVE_ONLY" as const,early,canonical,
    averageSecondsGained:rows.length?rows.reduce((s,r)=>s+(Number(r.canonical_at)-Number(r.decision_at_ms))/1000,0)/rows.length:null,
    averageSecondsGainedVsFallback:rows.length?rows.reduce((s,r)=>s+(Number(r.expiry_ms)-Number(r.decision_at_ms))/1000-
      (Number(r.interval_minutes)===5?60:180),0)/rows.length:null,
    averageSecondsBeforeEarlyLock:rows.length?rows.reduce((s,r)=>s+(Number(r.expiry_ms)-Number(r.decision_at_ms))/1000,0)/rows.length:null,
    averageSecondsBeforeCanonicalLock:rows.length?rows.reduce((s,r)=>s+(Number(r.expiry_ms)-Number(r.canonical_at))/1000,0)/rows.length:null,
    accuracyDifference:early.accuracy===null?null:early.accuracy-canonical.accuracy!,
    brierDifference:early.brier===null?null:early.brier-canonical.brier!,
    logLossDifference:early.logLoss===null?null:early.logLoss-canonical.logLoss!};
}
export const lockMatchedSql=`SELECT e.*,c.probability_up AS canonical_probability,c.decision_at_ms AS canonical_at,upper(l.outcome) AS outcome
  FROM bluewater_lock_candidates e JOIN waterx_research_choices c USING(interval_minutes,round_id,start_ms,expiry_ms)
  JOIN waterx_learning_rounds l USING(interval_minutes,round_id,start_ms,expiry_ms)
  WHERE e.interval_minutes=$1 AND e.start_ms>=$2 AND c.state='FROZEN'
    AND l.label_status='verified' AND NOT l.settlement_disputed
    AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
    AND l.first_verified_at<=clock_timestamp() AND l.first_verified_at>to_timestamp(e.expiry_ms::double precision/1000)
    AND l.settled_at>e.expiry_ms AND l.settled_at<=extract(epoch FROM clock_timestamp())*1000
    AND l.settle_price>0 AND l.settlement_anchor_price>0
    AND ((upper(l.outcome)='UP' AND l.settle_price>=l.settlement_anchor_price)
      OR (upper(l.outcome)='DOWN' AND l.settle_price<l.settlement_anchor_price))
  ORDER BY e.start_ms,e.checkpoint_seconds LIMIT 20001`;

export function speedForRound(round:Record<string,unknown>,obs:Record<string,unknown>[],
  lean:Record<string,unknown>|undefined,choice:Record<string,unknown>|undefined,
  candidate:Record<string,unknown>|undefined,timing:Record<string,unknown>|undefined):LockRoundSpeed {
  const start=Number(round.start_ms), expiry=Number(round.expiry_ms), final=choice?.state==="FROZEN"?choice:undefined;
  const leanAt=numeric(lean?.actual_at_ms),leanUp=numeric((lean?.details as {probabilityUp?:number})?.probabilityUp);
  const during=obs.filter(r=>leanAt!==null&&Number(r.observed_at_ms)>=leanAt&&
    (!final||Number(r.observed_at_ms)<=Number(final.decision_at_ms)));
  const side=final?.side??candidate?.side??(during.at(-1)&&Number(during.at(-1)!.probability_up)>=.5?"UP":"DOWN");
  const preferred=(r:Record<string,unknown>)=>Number(r.probability_up)>=.5?"UP":"DOWN";
  const probabilityForSide=(p:number)=>side==="UP"?p:1-p;
  const probs=during.map(r=>probabilityForSide(Number(r.probability_up)));
  const finalUp=numeric(final?.probability_up);
  const latest=finalUp??numeric(during.at(-1)?.probability_up);
  const t=timing?.timing as {totalMs?:number;receiptToEvaluationMs?:number;commitMs?:number}|undefined;
  return {roundId:String(round.round_id),startToLeanSeconds:leanAt===null?null:(leanAt-start)/1000,
    leanToFinalSeconds:leanAt===null||!final?null:(Number(final.decision_at_ms)-leanAt)/1000,
    secondsRemainingAtFinal:final?(expiry-Number(final.decision_at_ms))/1000:null,
    probabilityAtLean:leanUp===null?null:probabilityForSide(leanUp),
    probabilityAtFinal:finalUp===null?null:probabilityForSide(finalUp),
    reversals:during.filter((r,i)=>i>0&&preferred(r)!==preferred(during[i-1])).length,
    minProbabilityDuringLean:probs.length?Math.min(...probs):null,maxProbabilityDuringLean:probs.length?Math.max(...probs):null,
    marketMovementSinceLean:latest===null||leanUp===null?null:probabilityForSide(latest)-probabilityForSide(leanUp),
    probabilityAtEligibility:candidate?probabilityForSide(Number(candidate.probability_up)):null,
    captureLatencyMs:t?.totalMs??null,evaluationLatencyMs:t?.receiptToEvaluationMs??null,
    databaseCommitLatencyMs:t?.commitMs??null};
}
export async function getLockReport(interval:ResearchInterval,
  currentRound:{id:string;startMs:number;expiryMs:number}|null,sourceLive=true,
  db:LockDb=lockPool,now=Date.now()):Promise<LockReadinessReport> {
  const empty=comparison([]);
  const base:LockReadinessReport={intervalMinutes:interval,asOfMs:now,schemaStatus:"available",reason:null,
    researchOnly:true,source:"WaterX Market Baseline",current:null,
    counts:{rounds:0,observations:0,candidates:0,matched:0},comparison:empty,checkpoints:[],latency:{},missedWindows:[],recentSpeeds:[]};
  try {
    const cutoff=now-14*86400000;
    const counts=await db.query(`SELECT
      (SELECT count(*) FROM bluewater_lock_policies WHERE interval_minutes=$1 AND start_ms>=$2) AS rounds,
      (SELECT count(*) FROM bluewater_lock_observations WHERE interval_minutes=$1 AND start_ms>=$2) AS observations,
      (SELECT count(*) FROM bluewater_lock_candidates WHERE interval_minutes=$1 AND start_ms>=$2 AND checkpoint_seconds=0) AS candidates`,
    [interval,cutoff]);
    const matched=await db.query(lockMatchedSql,[interval,cutoff]);
    if(matched.rows.length>20000)throw new Error("Matched adaptive cohort exceeds explicit bound.");
    const primary=matched.rows.filter(r=>Number(r.checkpoint_seconds)===0);
    base.counts={rounds:Number(counts.rows[0].rounds),observations:Number(counts.rows[0].observations),
      candidates:Number(counts.rows[0].candidates),matched:primary.length};base.comparison=comparison(primary);
    base.checkpoints=(interval===5?[120,90]:[360,300,240]).map(lockSeconds=>({lockSeconds,
      ...comparison(matched.rows.filter(r=>Number(r.checkpoint_seconds)===lockSeconds))}));
    const latency=await db.query(`SELECT kind,k.key,count(*) AS n,
      percentile_cont(.5) WITHIN GROUP(ORDER BY (k.value::text)::double precision) AS p50,
      percentile_cont(.95) WITHIN GROUP(ORDER BY (k.value::text)::double precision) AS p95
      FROM bluewater_lock_latency t CROSS JOIN LATERAL jsonb_each(t.timing) k
      WHERE interval_minutes=$1 AND recorded_at>=to_timestamp($2::double precision/1000)
         AND timing->>'measurementVersion'='final-write-v1'
        AND k.key IN('providerToReceiptMs','receiptToEvaluationMs','evaluationToTransactionMs','commitMs','totalMs','evaluationComputeMs')
        AND jsonb_typeof(k.value)='number' GROUP BY kind,k.key`,[interval,cutoff]);
    for(const r of latency.rows)base.latency[`${r.kind}:${r.key}`]={n:Number(r.n),p50Ms:numeric(r.p50),p95Ms:numeric(r.p95)};
    const diagnostics=await db.query(`SELECT * FROM bluewater_lock_diagnostics
      WHERE interval_minutes=$1 AND at_ms>=$2 ORDER BY at_ms DESC LIMIT 100`,[interval,cutoff]);
    base.missedWindows=diagnostics.rows.map(r=>({roundId:String(r.round_id),lockSeconds:Number(r.lock_seconds),
      code:String(r.code),reason:String(r.reason),atMs:Number(r.at_ms)}));
    const policies=await db.query(`SELECT * FROM bluewater_lock_policies WHERE interval_minutes=$1
      AND start_ms>=$2 ORDER BY start_ms DESC LIMIT 30`,[interval,cutoff]);
    const ids=policies.rows.map(r=>String(r.round_id));
    const [observed,leans,choices,earlyCandidates,timings]=await Promise.all([
      db.query(`SELECT * FROM bluewater_lock_observations WHERE interval_minutes=$1 AND round_id=ANY($2::text[])
        ORDER BY observed_at_ms LIMIT 60001`,[interval,ids]),
      db.query(`SELECT round_id,start_ms,expiry_ms,actual_at_ms,details
        FROM waterx_research_lifecycle_events WHERE interval_minutes=$1 AND round_id=ANY($2::text[])
        AND event_type='LEANING' ORDER BY round_id,actual_at_ms LIMIT 50001`,[interval,ids]),
      db.query(`SELECT * FROM waterx_research_choices WHERE interval_minutes=$1 AND round_id=ANY($2::text[])`,[interval,ids]),
      db.query(`SELECT * FROM bluewater_lock_candidates WHERE interval_minutes=$1 AND round_id=ANY($2::text[])
        AND checkpoint_seconds=0`,[interval,ids]),
      db.query(`SELECT DISTINCT ON(round_id) round_id,timing FROM bluewater_lock_latency
        WHERE interval_minutes=$1 AND round_id=ANY($2::text[]) AND kind='CANONICAL_LOCK' ORDER BY round_id,id`,[interval,ids]),
    ]);
    if(observed.rows.length>60000)throw new Error("Adaptive reporting history exceeds bound.");
    if(leans.rows.length>50000)throw new Error("Lifecycle speed history exceeds bound.");
    for(const r of policies.rows){
      const exact=(row:Record<string,unknown>)=>row.round_id===r.round_id&&Number(row.start_ms)===Number(r.start_ms)&&Number(row.expiry_ms)===Number(r.expiry_ms);
      const obs=observed.rows.filter(exact),lean=leans.rows.find(exact),choice=choices.rows.find(exact),
        candidate=earlyCandidates.rows.find(exact),timing=timings.rows.find(row=>row.round_id===r.round_id);
      if(obs.length>2000)throw new Error("Adaptive history exceeds bound.");
      // Historical immutable LEANING events can inform descriptive speed/ranges,
      // never adaptive candidates or reconstructed readiness.
      const speedObservations=new Map<number,Record<string,unknown>>();
      for(const row of leans.rows.filter(exact)){
        const up=numeric((row.details as {probabilityUp?:number})?.probabilityUp);
        if(up!==null&&Number.isFinite(up)&&up>=0&&up<=1)speedObservations.set(Number(row.actual_at_ms),
          {...row,observed_at_ms:row.actual_at_ms,probability_up:up});
      }
      for(const row of obs)speedObservations.set(Number(row.observed_at_ms),row);
      const speed=speedForRound(r,Array.from(speedObservations.values()).sort((a,b)=>
        Number(a.observed_at_ms)-Number(b.observed_at_ms)),lean,choice,candidate,timing);
      base.recentSpeeds.push(speed);
      if(currentRound&&currentRound.id===r.round_id&&currentRound.startMs===Number(r.start_ms)&&currentRound.expiryMs===Number(r.expiry_ms)){
        const rows=obs.map(lockObservation);if(!sourceLive&&rows.length)rows[rows.length-1]={...rows.at(-1)!,sourceHealthy:false};
        const readiness=evaluateLockReadiness(r.policy as LockPolicy,Number(r.start_ms),Number(r.expiry_ms),rows,now);
        base.current={roundId:String(r.round_id),startMs:Number(r.start_ms),expiryMs:Number(r.expiry_ms),
          policy:r.policy as LockPolicy,readiness,candidate:candidate?{
            side:candidate.side as "UP"|"DOWN",
            probability:Math.max(Number(candidate.probability_up),1-Number(candidate.probability_up)),
            decisionAtMs:Number(candidate.decision_at_ms)}:null,speed};
      }
    }
    return base;
  }catch(error){
    if(["42P01","42703","3F000"].includes(String((error as {code?:string}).code??"")))
      return {...base,schemaStatus:"unavailable",reason:"Adaptive research schema is unavailable; no readiness or execution authority is inferred."};
    throw error;
  }
}