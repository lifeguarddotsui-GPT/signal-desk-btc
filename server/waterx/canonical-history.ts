import { z } from "zod";
import { researchPool } from "./research-store";
import { projectHistory, historySummary, type HistoryFact, type HistorySource } from "../../shared/canonical-history";

export const historyQuerySchema=z.object({
  interval:z.enum(["all","5","15"]).default("all"),
  window:z.enum(["lifetime","100","50","20","24h","7d"]).default("lifetime"),
  source:z.enum(["baseline","bluewater"]).default("baseline"),
}).strict();
export async function canonicalHistory(query:unknown,now=Date.now()) {
  const q=historyQuerySchema.parse(query),source=q.source as HistorySource;
  const since=q.window==="24h"?now-86400000:q.window==="7d"?now-7*86400000:0;
  const limit=["100","50","20"].includes(q.window)?Number(q.window):50001;
  // No later odds fill a missing choice. Exact identity includes both boundaries.
  // Multiple champion freezes for one primary checkpoint are an ambiguity, not
  // permission to pick the most successful model after observing its outcome.
  const choiceJoin=source==="baseline"?`LEFT JOIN LATERAL (
      SELECT count(*) AS n,jsonb_agg(to_jsonb(c)) AS choices FROM waterx_research_choices c
      WHERE c.interval_minutes=l.interval_minutes AND c.round_id=l.round_id
        AND c.start_ms=l.start_ms AND c.expiry_ms=l.expiry_ms
    ) c ON true`:`LEFT JOIN LATERAL (
      SELECT count(*) AS n,jsonb_agg(jsonb_build_object('state','FROZEN','side',f.chosen_side,
        'probability_up',f.displayed_probability_up,'decision_at_ms',f.decision_at_ms,'model_version',f.model_version)) AS choices
      FROM waterx_research_model_forecasts f
      JOIN waterx_research_round_policy p USING(interval_minutes,round_id,start_ms,expiry_ms)
      WHERE f.interval_minutes=l.interval_minutes AND f.round_id=l.round_id
        AND f.start_ms=l.start_ms AND f.expiry_ms=l.expiry_ms AND f.forecast_status='CHAMPION'
        AND f.lock_seconds=p.primary_lock_seconds
    ) c ON true`;
  try {
    const result=await researchPool.query(`SELECT l.interval_minutes,l.round_id,l.start_ms,l.expiry_ms,l.outcome,
      l.label_status,l.settlement_disputed,c.n,c.choices,
      (l.label_status='verified' AND NOT l.settlement_disputed
       AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
       AND l.settled_at>l.expiry_ms AND l.settled_at<=$2
       AND l.first_verified_at<=to_timestamp($2::double precision/1000)
       AND ((upper(l.outcome)='UP' AND l.settle_price>=l.settlement_anchor_price)
         OR (upper(l.outcome)='DOWN' AND l.settle_price<l.settlement_anchor_price))) AS verified
      FROM waterx_learning_rounds l ${choiceJoin}
      WHERE ($1::int IS NULL OR l.interval_minutes=$1) AND l.expiry_ms<=$2 AND l.start_ms>=$3
      ORDER BY l.start_ms DESC,l.interval_minutes,l.round_id,l.expiry_ms DESC LIMIT $4`,
      [q.interval==="all"?null:Number(q.interval),now,since,limit]);
    if(result.rows.length>50000)return {status:"unavailable",reason:"Full cohort exceeds the explicit 50,000-round query bound; select a time window. No partial lifetime statistics are shown."};
    const rows=result.rows.map(r=>{
      const c=r.n==1?r.choices?.[0]:null;
      const fact:HistoryFact={intervalMinutes:Number(r.interval_minutes) as 5|15,roundId:r.round_id,
        startMs:Number(r.start_ms),expiryMs:Number(r.expiry_ms),choiceCount:Number(r.n),
        choiceState:c?.state??null,side:c?.side??null,
        probabilityUp:c?.probability_up==null?null:Number(c.probability_up),
        lockAtMs:c?.decision_at_ms==null?null:Number(c.decision_at_ms),modelVersion:c?.model_version??null,
        outcome:r.outcome==null?null:String(r.outcome).toUpperCase(),verificationState:r.settlement_disputed?"disputed":r.label_status,
        disputed:r.settlement_disputed===true,verifiedOutcome:r.verified===true};
      return projectHistory(fact,source);
    });
    return {status:"ok",asOfMs:now,source,cohort:q,summary:historySummary(rows),
      rows:rows.slice(0,200),rowsTruncated:rows.length>200,totalRows:rows.length,
      note:"Closed observed rounds only. Missing collector rounds are reported by coverage separately. Public prediction correctness excludes wallet trading records; no order or P/L is inferred."};
  }catch(e){
    if(["42P01","42703"].includes((e as {code?:string}).code??""))
      return {status:"unavailable",reason:"Canonical history schema is unavailable. No market odds or shadow models substitute for frozen choices."};
    throw e;
  }
}