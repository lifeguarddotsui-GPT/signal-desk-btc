import {z} from "zod";
import {researchPool} from "./research-store";
import {TIMED_STRATEGY,type TimedDecision} from "../../shared/timed-decision";
import {V4_CONFIRMATION_STRATEGY} from "../../shared/confirmation-v4";
import type {LockDb} from "./lock-store";
export const v4ComparisonQuery=z.object({interval:z.enum(["5","15"]),window:z.enum(["24h","7d"]).default("24h")}).strict();
type Row=Record<string,unknown>&{v3:TimedDecision|null;v4:TimedDecision|null};
const validSide=(v:unknown)=>v==="UP"||v==="DOWN";
function counts(rows:Row[],stage:"v3"|"v4"){
  const locked=rows.filter(r=>r[stage]?.status==="LOCKED"&&validSide(r[stage]?.side));
  const scored=locked.filter(r=>r.verified===true);
  const correct=scored.filter(r=>r[stage]?.side===String(r.outcome).toUpperCase()).length;
  return {cohortN:rows.length,locks:locked.length,coverage:rows.length?locked.length/rows.length:null,
    scoredN:scored.length,correct,incorrect:scored.length-correct,
    accuracy:scored.length?correct/scored.length:null,unscoredLocks:locked.length-scored.length,
    noSavedLock:rows.length-locked.length};
}
/** One bounded, read-only DB query and no provider requests. */
export async function v4Comparison(query:unknown,now=Date.now(),db:LockDb=researchPool){
  const q=v4ComparisonQuery.parse(query),since=now-(q.window==="24h"?86400000:604800000);
  const sql=[
    "WITH cohort AS (SELECT network,interval_minutes,round_id,start_ms,expiry_ms FROM waterx_timed_rounds",
    "WHERE network='sui:mainnet' AND strategy_version=$1 AND interval_minutes=$3 AND start_ms>=$5 AND expiry_ms<$4",
    "ORDER BY start_ms DESC LIMIT 1001)",
    "SELECT r.*,b.decision AS v3,c.decision AS v4,",
    "COALESCE(l.label_status='verified' AND NOT l.settlement_disputed",
    "AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)",
    "AND l.settled_at>r.expiry_ms AND l.settled_at<=$4",
    "AND l.first_verified_at<=to_timestamp($4::double precision/1000)",
    "AND l.settle_price>0 AND l.settlement_anchor_price>0",
    "AND l.settle_price<'Infinity'::float8 AND l.settlement_anchor_price<'Infinity'::float8",
    "AND ((upper(l.outcome)='UP' AND l.settle_price>=l.settlement_anchor_price)",
    "OR (upper(l.outcome)='DOWN' AND l.settle_price<l.settlement_anchor_price)),false) AS verified, l.outcome",
    "FROM cohort r",
    "LEFT JOIN waterx_timed_decisions b ON b.network=r.network AND b.strategy_version=$1",
    "AND b.interval_minutes=r.interval_minutes AND b.round_id=r.round_id",
    "AND (b.decision->>'startMs')::bigint=r.start_ms AND (b.decision->>'expiryMs')::bigint=r.expiry_ms",
    "LEFT JOIN waterx_timed_decisions c ON c.network=r.network AND c.strategy_version=$2",
    "AND c.interval_minutes=r.interval_minutes AND c.round_id=r.round_id",
    "AND (c.decision->>'startMs')::bigint=r.start_ms AND (c.decision->>'expiryMs')::bigint=r.expiry_ms",
    "LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=r.interval_minutes AND l.round_id=r.round_id",
    "AND l.start_ms=r.start_ms AND l.expiry_ms=r.expiry_ms ORDER BY r.start_ms DESC"
  ].join(" ");
  const result=await db.query(sql,[TIMED_STRATEGY,V4_CONFIRMATION_STRATEGY,Number(q.interval),now,since]);
  if(result.rows.length>1000)return {status:"BOUND_EXCEEDED" as const,
    reason:"History exceeds safe query bound. Select a shorter window; no partial summary presented."};
  const rows=result.rows as Row[],v3=counts(rows,"v3"),v4=counts(rows,"v4");
  const paired=rows.filter(r=>r.verified===true&&r.v3?.status==="LOCKED"&&r.v4?.status==="LOCKED"&&
    validSide(r.v3.side)&&validSide(r.v4.side));
  const p=paired.map(r=>({
    v3Correct:r.v3!.side===String(r.outcome).toUpperCase(),
    v4Correct:r.v4!.side===String(r.outcome).toUpperCase(),
    v3:r.v3!,v4:r.v4!
  }));
  const sameClock=p.filter(x=>x.v4.evidence.clockDomain&&
    x.v4.evidence.clockDomain===(x.v3.evidence.features as Record<string,unknown>|undefined)?.decisionClockDomain);
  const gain=sameClock.map(x=>(x.v3.decisionAtMs-x.v4.decisionAtMs)/1000).sort((a,b)=>a-b);
  const correct3=p.filter(x=>x.v3Correct).length,correct4=p.filter(x=>x.v4Correct).length;
  return {status:"OK" as const,asOfMs:now,intervalMinutes:Number(q.interval),window:q.window,
    strategyV3:TIMED_STRATEGY,strategyV4:V4_CONFIRMATION_STRATEGY,shadowOnly:true,automaticExecutionAllowed:false,
    v3,v4,paired:{scoredN:p.length,v3Correct:correct3,v4Correct:correct4,
      v3Accuracy:p.length?correct3/p.length:null,v4Accuracy:p.length?correct4/p.length:null,
      bothCorrect:p.filter(x=>x.v3Correct&&x.v4Correct).length,
      v3OnlyCorrect:p.filter(x=>x.v3Correct&&!x.v4Correct).length,
      v4OnlyCorrect:p.filter(x=>!x.v3Correct&&x.v4Correct).length,
      bothIncorrect:p.filter(x=>!x.v3Correct&&!x.v4Correct).length,
      sameProcessClockPairs:gain.length,
      v4LeadGainSecondsP50:gain.length?gain[Math.ceil(gain.length*.5)-1]:null,
      v4LeadGainSecondsP95:gain.length?gain[Math.ceil(gain.length*.95)-1]:null},
    readyForProduction:false,source:"EXACT_ROUND_VERIFIED_WATERX_SETTLEMENT",
    note:"A missing V4 lock is not a loss. Accuracy is based only on verified scored decisions. Lead time only compares matching application-process clock domains. Shadow decisions never place an order."};
}
