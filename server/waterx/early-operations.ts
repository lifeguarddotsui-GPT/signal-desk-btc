import {TIMED_STRATEGY} from "../../shared/timed-decision";
import {timedPool} from "./timed-db";
import type {LockDb} from "./lock-store";
export const EARLY_CAPTURE_VERSION="atomic-gate-capture-v1";
/** Read-only diagnostics never run on a provider-read or gate-write promise.
 * Cohorts are based on actual persisted activation/repair evidence, not fabricated
 * historical lock rows. Errors when the database is down remain separately in logs. */
export async function earlyOperationalReport(now=Date.now(),db:LockDb=timedPool){
  const result=await db.query(`WITH activation AS(
    SELECT min(discovered_at_ms) AS at FROM waterx_timed_rounds WHERE strategy_version=$1
  ), repair AS(
    SELECT min(scheduled_at_ms) AS at FROM waterx_gate_journals
    WHERE strategy_version=$1 AND journal->>'captureVersion'=$2
  ) SELECT r.interval_minutes,r.round_id,r.start_ms,r.expiry_ms,r.discovered_at_ms,
    d.status,o.committed_ack_at_ms,activation.at AS activation_at_ms,repair.at AS repair_at_ms,
    CASE WHEN r.start_ms<activation.at THEN 'PRE_ACTIVATION'
      WHEN repair.at IS NOT NULL AND r.start_ms>=repair.at THEN 'POST_REPAIR'
      ELSE 'HISTORICAL_OPERATIONAL' END AS cohort,
    r.discovered_at_ms-r.start_ms AS discovery_delay_ms,
    g.gates,g.missed,g.fresh_failures,g.qualified,g.invalid_pairs,g.missing_sources,
    CASE WHEN r.discovered_at_ms>=r.start_ms+30000 THEN 'LATE_DISCOVERY'
      WHEN d.status='ABSTAINED_NO_QUALIFIED_SIGNAL' THEN 'POLICY_ABSTENTION'
      WHEN d.id IS NULL AND g.qualified>0 THEN 'QUALIFIED_WITHOUT_DURABLE_DECISION'
      WHEN d.id IS NULL AND r.expiry_ms<=$3 THEN 'MISSING_FINAL_RECORD'
      WHEN g.missed>0 THEN 'MISSED_SCHEDULED_GATES'
      WHEN g.invalid_pairs>0 THEN 'INVALID_PROBABILITY_PAIR'
      WHEN g.missing_sources>0 THEN 'MISSING_SOURCE_OBSERVATIONS'
      WHEN g.fresh_failures>0 THEN 'STALE_OR_INVALID_SOURCE'
      WHEN d.status='LOCKED' AND (o.committed_ack_at_ms IS NULL OR
        o.committed_ack_at_ms>(d.decision->>'hardDeadlineAtMs')::bigint) THEN 'ACK_UNKNOWN_OR_LATE'
      WHEN r.expiry_ms>$3 THEN 'ACTIVE_ROUND'
      ELSE 'RECORDED' END AS primary_reason
    FROM waterx_timed_rounds r CROSS JOIN activation CROSS JOIN repair
    LEFT JOIN waterx_timed_decisions d USING(network,strategy_version,interval_minutes,round_id)
    LEFT JOIN waterx_timed_outbox o ON o.decision_id=d.id
    LEFT JOIN LATERAL(SELECT count(*)::int AS gates,
      count(*) FILTER(WHERE result='MISSED_GATE')::int AS missed,
      count(*) FILTER(WHERE result='WAIT_FRESH_DATA')::int AS fresh_failures,
      count(*) FILTER(WHERE result='QUALIFIED')::int AS qualified,
      count(*) FILTER(WHERE journal->'evidenceSnapshot'->>'latestInputValid'='false'
        AND journal->'evidenceSnapshot'->>'missingInput'='false')::int AS invalid_pairs,
      count(*) FILTER(WHERE journal->'evidenceSnapshot'->>'missingInput'='true'
        AND result<>'MISSED_GATE')::int AS missing_sources
      FROM waterx_gate_journals j WHERE j.network=r.network AND j.strategy_version=r.strategy_version
        AND j.interval_minutes=r.interval_minutes AND j.round_id=r.round_id) g ON true
    WHERE r.strategy_version=$1 AND r.start_ms >= $3::bigint-14::bigint*86400000
    ORDER BY r.start_ms DESC LIMIT 2501`,[TIMED_STRATEGY,EARLY_CAPTURE_VERSION,now]);
  if(result.rows.length>2500)throw new Error("Explicit operational cohort bound exceeded");
  const groups:Record<string,{interval:number;cohort:string;n:number;reasons:Record<string,number>;missedGates:number}>={};
  for(const r of result.rows){
    const cohort=String(r.cohort),reason=String(r.primary_reason);
    const key=`${r.interval_minutes}:${cohort}`,g=groups[key]??={interval:Number(r.interval_minutes),cohort,n:0,reasons:{},missedGates:0};
    g.n++;g.reasons[reason]=(g.reasons[reason]??0)+1;g.missedGates+=Number(r.missed);
  }
  return {strategyVersion:TIMED_STRATEGY,captureVersion:EARLY_CAPTURE_VERSION,asOfMs:now,
    cohorts:Object.values(groups),rounds:result.rows,
    databaseFailureEvidence:"Acquisition/write failures are separately reported by delivery metrics and sanitized runtime logs. Absence of a row is not proof of its cause.",
    collector:"Server-owned persisted round identities and absolute 30-second gate timers; no browser trigger",
    autoscaleIndependent:false,limitation:"An Autoscale process cannot wake itself when idle. No always-on edge cutover or production repair is claimed."};
}
