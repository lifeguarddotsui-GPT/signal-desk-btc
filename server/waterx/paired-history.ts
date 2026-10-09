import { z } from "zod";
import { researchPool } from "./research-store";
import { TIMED_STRATEGY } from "../../shared/timed-decision";
import { stageScore, comparePaired, pairedSummary, projectFrozenBenchmark, type Direction, type PairedRow, type Stage } from "../../shared/paired-history";

export const pairedHistoryQuery = z.object({
  interval: z.enum(["all","5","15"]).default("all"),
  window: z.enum(["24h","7d","lifetime","20","50","100"]).default("24h"),
}).strict();
export type PairedHistoryQueryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
const direction = (v:unknown):Direction|null => v === "UP" || v === "DOWN" ? v : null;
const number = (v:unknown):number|null => v === null || v === undefined ? null : Number(v);
const integer = (v:unknown):number => Number(v) || 0;

export async function pairedHistory(query:unknown,now=Date.now(),db:PairedHistoryQueryable=researchPool) {
  const q=pairedHistoryQuery.parse(query),since=q.window==="24h"?now-86400000:q.window==="7d"?now-604800000:0;
  const bound=["20","50","100"].includes(q.window)?Number(q.window):5001;
  const params=[q.interval==="all"?null:Number(q.interval),now,since,TIMED_STRATEGY,bound];
  // Exact interval/round/boundary identity. No reconstructed historical predictions.
  // All three observed research stores participate; unobserved rounds are not fabricated.
  const statement=`WITH identities AS (
      SELECT interval_minutes,round_id,start_ms,expiry_ms FROM waterx_learning_rounds
      UNION
      SELECT interval_minutes,round_id,start_ms,expiry_ms FROM bluewater_lock_candidates WHERE checkpoint_seconds=0
      UNION
      SELECT interval_minutes,round_id,start_ms,expiry_ms FROM waterx_timed_rounds
        WHERE network='sui:mainnet' AND strategy_version=$4
    ), cohort AS (
      SELECT * FROM identities
      WHERE ($1::int IS NULL OR interval_minutes=$1) AND expiry_ms<=$2 AND start_ms>=$3
      ORDER BY start_ms DESC,interval_minutes,round_id LIMIT $5
    )
    SELECT r.interval_minutes,r.round_id,r.start_ms,r.expiry_ms,
      e.side AS early_side,e.probability_up AS early_probability,e.decision_at_ms AS early_at,
      d.status AS confirmation_status,d.decision AS confirmation_decision,
      g.gate_count,g.missed_gate_count,g.fresh_wait_count,g.qualified_count,
      b.frozen_choices,
      l.label_status,l.outcome,l.settlement_disputed,
      COALESCE(l.label_status='verified' AND NOT l.settlement_disputed
        AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
        AND l.settled_at>r.expiry_ms AND l.settled_at<=$2
        AND l.first_verified_at<=to_timestamp($2::double precision/1000)
        AND l.settle_price>0 AND l.settlement_anchor_price>0
        AND l.settle_price<'Infinity'::float8 AND l.settlement_anchor_price<'Infinity'::float8
        AND ((upper(l.outcome)='UP' AND l.settle_price>=l.settlement_anchor_price)
          OR (upper(l.outcome)='DOWN' AND l.settle_price<l.settlement_anchor_price)),false) AS verified
    FROM cohort r
    LEFT JOIN bluewater_lock_candidates e ON e.interval_minutes=r.interval_minutes
      AND e.round_id=r.round_id AND e.start_ms=r.start_ms AND e.expiry_ms=r.expiry_ms
      AND e.checkpoint_seconds=0
    LEFT JOIN waterx_timed_decisions d ON d.network='sui:mainnet' AND d.strategy_version=$4
      AND d.interval_minutes=r.interval_minutes AND d.round_id=r.round_id
      AND (d.decision->>'startMs')::bigint=r.start_ms
      AND (d.decision->>'expiryMs')::bigint=r.expiry_ms
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS gate_count,
        count(*) FILTER(WHERE result='MISSED_GATE')::int AS missed_gate_count,
        count(*) FILTER(WHERE result='WAIT_FRESH_DATA')::int AS fresh_wait_count,
        count(*) FILTER(WHERE result='QUALIFIED')::int AS qualified_count
      FROM waterx_gate_journals j
      WHERE j.network='sui:mainnet' AND j.strategy_version=$4
        AND j.interval_minutes=r.interval_minutes AND j.round_id=r.round_id
    ) g ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.decision_at_ms) AS frozen_choices
      FROM waterx_research_choices c
      WHERE c.interval_minutes=r.interval_minutes AND c.round_id=r.round_id
        AND c.start_ms=r.start_ms AND c.expiry_ms=r.expiry_ms
        AND (c.choice_source IS NULL OR c.choice_source='market_baseline')
        AND COALESCE(c.evidence->>'tieBreakApplied','false') <> 'true'
        AND c.state='FROZEN'
    ) b ON true
    LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=r.interval_minutes AND l.round_id=r.round_id
      AND l.start_ms=r.start_ms AND l.expiry_ms=r.expiry_ms
    ORDER BY r.start_ms DESC,r.interval_minutes,r.round_id`;
  try {
    const result=await db.query(statement,params);
    if(result.rows.length>5000)return {status:"unavailable" as const,
      reason:"Cohort exceeds the 5,000-round audit bound; select a shorter time window. No partial summary is reported."};
    const rows:PairedRow[]=result.rows.map(r=>{
      const expiryMs=Number(r.expiry_ms);
      const verified=r.verified===true;
      const disputed=r.settlement_disputed===true;
      const outcome=verified?direction(String(r.outcome).toUpperCase()):null;
      const earlySide=direction(r.early_side);
      const confirm=r.confirmation_decision && typeof r.confirmation_decision==="object" ?
        r.confirmation_decision as Record<string,unknown> : {};
      const confirmationStatus=String(r.confirmation_status??"UNRECORDED");
      const confirmationSide=confirmationStatus==="LOCKED"?direction(confirm.side):null;
      const earlyAt=number(r.early_at),confirmAt=confirmationStatus==="LOCKED"?number(confirm.decisionAtMs):null;
      const makeStage=(side:Direction|null,status:string,at:number|null,probabilityUp:number|null):Stage=>({
        side,status,probabilityUp,decisionAtMs:at,
        secondsBeforeExpiry:at===null?null:Math.max(0,(expiryMs-at)/1000),
        result:stageScore(side,status,outcome,disputed),
      });
      const early=makeStage(earlySide,earlySide?"LOCKED":"UNRECORDED",earlyAt,number(r.early_probability));
      const confirmation=makeStage(confirmationSide,confirmationStatus,confirmAt,number(confirm.probabilityUp));
      // This is the Bluewater Decision frozen baseline: a third evidence stream,
      // NOT a substitute Confirmation Lock or a reconstructed retrospective choice.
      const choices=Array.isArray(r.frozen_choices)?r.frozen_choices:[];
      const benchmark=projectFrozenBenchmark(choices,outcome,disputed,Number(r.start_ms),expiryMs);
      const comparison=comparePaired(early,confirmation);
      const missedGates=integer(r.missed_gate_count),waitsForFreshData=integer(r.fresh_wait_count);
      const cause=confirmationStatus==="DATA_FAILURE" ?
        missedGates?"MISSED_GATE":waitsForFreshData?"STALE_OR_MISSING_PROVIDER_DATA":"INCOMPLETE_GATE_JOURNAL_OR_PERSISTENCE"
        : confirmationStatus==="ABSTAINED_NO_QUALIFIED_SIGNAL"?"NO_QUALIFIED_SIGNAL":
        confirmationStatus==="UNRECORDED"?"NO_DURABLE_FINAL_DECISION":confirmationStatus;
      return {intervalMinutes:Number(r.interval_minutes) as 5|15,roundId:String(r.round_id),
        startMs:Number(r.start_ms),expiryMs,early,confirmation,benchmark,...comparison,
        outcome,settlement:disputed?"DISPUTED":verified?"VERIFIED":
          r.label_status==null?"NOT_OBSERVED":
          String(r.label_status).toLowerCase()==="withheld"?"WITHHELD":"PENDING",
        diagnostics:{gateCount:integer(r.gate_count),missedGates,waitsForFreshData,
          qualifiedGates:integer(r.qualified_count),confirmationCause:cause}};
    });
    const summary=pairedSummary(rows);
    return {status:"ok" as const,asOfMs:now,cohort:q,summary,rows:rows.slice(0,150),
      totalRows:rows.length,rowsTruncated:rows.length>150,
      note:"Exact observed 5m/15m rounds only. Frozen market-baseline Bluewater Decision is reported separately from qualification-gate Confirmation Lock; neither is retroactively substituted for the other. No lock is not a prediction loss. WITHHELD and NOT_OBSERVED settlement evidence are separate from PENDING. No wallet fills or P/L inferred."};
  }catch(e){
    if(["42P01","42703","3F000"].includes(String((e as {code?:unknown})?.code??"")))
      return {status:"unavailable" as const,reason:"Required paired-history or gate-journal schema is unavailable."};
    throw e;
  }
}
