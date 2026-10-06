import { choiceToCanonicalTrainingChoice, choiceToTrainingRound } from "./research-training";
import type { CanonicalTrainingChoice } from "./research-baseline-training";
import type { Db } from "./bluewater-store";
import { json } from "./bluewater-store";
import type { FeatureSnapshot } from "./bluewater-fast";
import type { NumericTrainingRow } from "./bluewater-training";
export async function loadBluewaterCohort(db:Db,interval:5|15,now:number){
  const r=await db.query(`SELECT c.*,l.label_status,l.outcome,l.settlement_disputed,l.settlement_quarantine,
    l.settlement_anchor_price,l.settle_price,l.settled_at,l.first_verified_at AS settlement_observed_at,
    CASE WHEN fs.feature_snapshot IS NOT NULL THEN jsonb_set(c.evidence,'{comparison}',fs.feature_snapshot->'comparison',true)
      ELSE c.evidence END AS evidence
    FROM waterx_research_choices c JOIN waterx_learning_rounds l
      ON l.interval_minutes=c.interval_minutes AND l.round_id=c.round_id AND l.start_ms=c.start_ms AND l.expiry_ms=c.expiry_ms
    LEFT JOIN waterx_research_feature_supplements fs ON fs.interval_minutes=c.interval_minutes AND fs.round_id=c.round_id
      AND fs.start_ms=c.start_ms AND fs.expiry_ms=c.expiry_ms AND fs.decision_at_ms=c.decision_at_ms
    WHERE c.interval_minutes=$1 AND c.state='FROZEN' AND c.decision_at_ms<c.expiry_ms AND c.expiry_ms<=$2
      AND c.decision_at_ms>=$3 AND l.label_status='verified' AND NOT l.settlement_disputed
      AND l.settled_at<=$2 AND l.first_verified_at<=to_timestamp($2::double precision/1000)
      AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
    ORDER BY c.start_ms,c.round_id LIMIT 5001`,[interval,now,now-14*86400000]);
  if(r.rows.length>5000)throw new Error("Cohort exceeds 5000 records; no truncated evaluation.");
  return {raw:r.rows,canonical:r.rows.map(choiceToCanonicalTrainingChoice).filter(x=>x!==null),
    rich:r.rows.map(choiceToTrainingRound).filter(x=>x!==null)};
}
export function inspectCanonicalCohort(rows:CanonicalTrainingChoice[],interval:5|15){
  const sorted=[...rows].sort((a,b)=>a.startMs-b.startMs||a.roundId.localeCompare(b.roundId));
  const trainEnd=Math.floor(sorted.length*.6),calEnd=Math.floor(sorted.length*.8),embargo=interval*60000;
  const calStart=sorted[trainEnd]?.decisionAtMs,testStart=sorted[calEnd]?.decisionAtMs;
  const train=sorted.slice(0,trainEnd).filter(r=>calStart!==undefined&&r.labelAvailableAtMs<=calStart-embargo);
  const cal=sorted.slice(trainEnd,calEnd).filter(r=>testStart!==undefined&&r.labelAvailableAtMs<=testStart-embargo);
  const test=sorted.slice(calEnd),span=sorted.length>1?sorted.at(-1)!.startMs-sorted[0].startMs:0;
  const reasons=[];
  if(sorted.length<90)reasons.push(`Need at least 90 records; found ${sorted.length}.`);
  if(span<(interval===5?48*3600000:7*86400000))reasons.push(`Need ${interval===5?"48 hours":"7 days"} of history.`);
  for(const [name,part,min] of [["training",train,40],["calibration",cal,20],["test",test,20]] as const){
    if(part.length<min)reasons.push(`${name}: ${part.length}/${min} after embargo.`);
    if(new Set(part.map(r=>r.outcome)).size<2)reasons.push(`${name} lacks both accepted outcomes.`);
  }
  return {status:reasons.length?"INSUFFICIENT":"ELIGIBLE_FOR_DAILY_EVALUATION",records:sorted.length,spanMs:span,
    training:train.length,calibration:cal.length,test:test.length,embargoExcluded:sorted.length-train.length-cal.length-test.length,
    reasons,note:"Eligibility inspection only; no fitting occurs on API reads."};
}
export async function loadNumericCohort(db:Db,interval:5|15,now:number):Promise<NumericTrainingRow[]>{
  const r=await db.query(`SELECT DISTINCT ON(f.round_id) f.*,l.outcome,l.settled_at,l.first_verified_at
    FROM waterx_research_feature_snapshots f JOIN waterx_research_round_policy p
      USING(interval_minutes,round_id,start_ms,expiry_ms)
    JOIN waterx_learning_rounds l USING(interval_minutes,round_id,start_ms,expiry_ms)
    WHERE f.interval_minutes=$1 AND f.decision_at_ms>=$3 AND f.expiry_ms<=$2
      AND f.decision_at_ms>=f.expiry_ms-p.primary_lock_seconds*1000
      AND f.decision_at_ms<=f.expiry_ms-p.primary_lock_seconds*1000+p.horizon_capture_grace_ms
      AND l.label_status='verified' AND NOT l.settlement_disputed AND upper(l.outcome) IN('UP','DOWN')
      AND l.first_verified_at<=to_timestamp($2::double precision/1000) AND l.settled_at<=$2
      AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
    ORDER BY f.round_id,f.decision_at_ms LIMIT 5001`,[interval,now,now-14*86400000]);
  if(r.rows.length>5000)throw new Error("Prospective feature cohort exceeds bound.");
  return r.rows.map(r=>({snapshot:{...json<Omit<FeatureSnapshot,"digest">>(r.feature_snapshot),digest:String(r.feature_snapshot_digest)},
    outcome:String(r.outcome).toUpperCase() as "UP"|"DOWN",labelAvailableAtMs:new Date(String(r.first_verified_at)).getTime(),
    settledAtMs:Number(r.settled_at)}));
}