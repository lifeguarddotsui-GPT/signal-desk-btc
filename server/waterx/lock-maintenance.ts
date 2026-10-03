import { lockPool, type LockDb } from "./lock-store";
import type { ResearchInterval } from "../../shared/waterx-research";

/** Append scores/withdrawals and missed-deadline diagnostics, never historical candidates. */
export async function maintainLockEvidence(interval:ResearchInterval,db:LockDb=lockPool) {
  await db.query(`INSERT INTO bluewater_lock_results
    (interval_minutes,round_id,checkpoint_seconds,event_type,outcome,label_available_at,brier,log_loss,correct)
    SELECT c.interval_minutes,c.round_id,c.checkpoint_seconds,'SCORED',upper(l.outcome),l.first_verified_at,
      power(c.probability_up-CASE WHEN upper(l.outcome)='UP' THEN 1 ELSE 0 END,2),
      -ln(greatest(0.0000000001,least(0.9999999999,CASE WHEN upper(l.outcome)='UP'
        THEN c.probability_up ELSE 1-c.probability_up END))),c.side=upper(l.outcome)
    FROM bluewater_lock_candidates c JOIN waterx_learning_rounds l USING(interval_minutes,round_id,start_ms,expiry_ms)
    WHERE c.interval_minutes=$1 AND l.label_status='verified' AND NOT l.settlement_disputed
      AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
      AND l.first_verified_at>to_timestamp(c.expiry_ms::double precision/1000) AND l.first_verified_at<=clock_timestamp()
      AND l.settled_at>c.expiry_ms AND l.settled_at<=extract(epoch FROM clock_timestamp())*1000
      AND l.settle_price>0 AND l.settlement_anchor_price>0
      AND ((upper(l.outcome)='UP' AND l.settle_price>=l.settlement_anchor_price)
        OR (upper(l.outcome)='DOWN' AND l.settle_price<l.settlement_anchor_price))
    ON CONFLICT DO NOTHING`,[interval]);
  await db.query(`INSERT INTO bluewater_lock_results
    (interval_minutes,round_id,checkpoint_seconds,event_type,outcome,label_available_at,brier,log_loss,correct)
    SELECT r.interval_minutes,r.round_id,r.checkpoint_seconds,'WITHDRAWN',r.outcome,r.label_available_at,r.brier,r.log_loss,r.correct
    FROM bluewater_lock_results r JOIN bluewater_lock_candidates c USING(interval_minutes,round_id,checkpoint_seconds)
    LEFT JOIN waterx_learning_rounds l USING(interval_minutes,round_id,start_ms,expiry_ms)
    WHERE r.interval_minutes=$1 AND r.event_type='SCORED' AND
      (l.round_id IS NULL OR l.label_status<>'verified' OR l.settlement_disputed OR upper(l.outcome)<>r.outcome
        OR (l.settlement_quarantine IS NOT NULL AND l.settlement_quarantine<>'[]'::jsonb))
    ON CONFLICT DO NOTHING`,[interval]);
  await db.query(`INSERT INTO bluewater_lock_diagnostics(interval_minutes,round_id,lock_seconds,code,reason,at_ms,details)
    SELECT p.interval_minutes,p.round_id,h.v::integer,
      CASE WHEN o.n=0 OR o.delayed THEN 'DATA_COLLECTOR_DELAY' WHEN o.ready THEN 'DATA_COMMIT_DELAY'
        ELSE 'WAITING_FOR_EVIDENCE' END,
      CASE WHEN o.n=0 OR o.delayed OR o.ready THEN 'Checkpoint missed because timely persisted evidence was unavailable; not intelligent hesitation.'
        ELSE 'Fresh checkpoint observations did not satisfy pinned readiness.' END,
      (extract(epoch FROM clock_timestamp())*1000)::bigint,
      jsonb_build_object('targetAtMs',p.expiry_ms-h.v::integer*1000,'graceMs',5000,'noBackfill',true)
    FROM bluewater_lock_policies p CROSS JOIN LATERAL jsonb_array_elements_text(p.policy->'windows') h(v)
    LEFT JOIN bluewater_lock_candidates c ON c.interval_minutes=p.interval_minutes AND c.round_id=p.round_id AND c.checkpoint_seconds=h.v::integer
    CROSS JOIN LATERAL (SELECT count(*) AS n,
      coalesce(bool_or(readiness->>'state'='READY'),false) AS ready,
      coalesce(bool_or(readiness->>'health'='DATA/COLLECTOR DELAY' OR
        (readiness->>'evaluatedAtMs')::bigint>p.expiry_ms-h.v::integer*1000+5000),false) AS delayed
      FROM bluewater_lock_observations WHERE interval_minutes=p.interval_minutes AND round_id=p.round_id
        AND observed_at_ms BETWEEN p.expiry_ms-h.v::integer*1000 AND p.expiry_ms-h.v::integer*1000+5000) o
    WHERE p.interval_minutes=$1 AND h.v::integer>(p.policy->>'fallbackSeconds')::integer
      AND extract(epoch FROM clock_timestamp())*1000>p.expiry_ms-h.v::integer*1000+5000
      AND c.round_id IS NULL ON CONFLICT DO NOTHING`,[interval]);
}