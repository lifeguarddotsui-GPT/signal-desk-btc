import { freezeResearchDecision, unavailableComparison } from "./research-decision";
import {
  captureResearchEvent, recordResearchIdentityFailure, researchChoiceInsert,
  researchChoiceValues, researchPool, researchSchemaMissing, scoreResearchChoices,
} from "./research-store";
import { getResearchReport } from "./research-report";
import { waterxLive } from "./service";
import { maintainLockEvidence } from "./lock-maintenance";
import type { ResearchInterval } from "../../shared/waterx-research";
import {
  recordNoValidData, recordVerifiedResearchResult, withdrawDisputedResearchResult,
} from "./research-lifecycle";

/** Recovery creates only explicit NO_VALID_CHOICE audit rows, never expired forecasts. */
export async function reconcileMissedResearchChoices(interval:ResearchInterval,now=Date.now()) {
  const pending = await researchPool.query(`SELECT l.*,rejected.code AS rejection_code,
      rejected.reason AS rejection_reason,rejected.details AS rejection_evidence,
      p.primary_lock_seconds,p.policy_version AS pinned_policy_version
    FROM waterx_learning_rounds l
    JOIN waterx_research_capture_events e ON e.interval_minutes=l.interval_minutes
      AND e.round_id=l.round_id AND e.stage='OBSERVED'
    JOIN waterx_research_round_policy p ON p.interval_minutes=l.interval_minutes
      AND p.round_id=l.round_id AND p.start_ms=l.start_ms AND p.expiry_ms=l.expiry_ms
    LEFT JOIN waterx_research_choices c ON c.interval_minutes=l.interval_minutes AND c.round_id=l.round_id
    LEFT JOIN LATERAL (SELECT code,reason,details FROM waterx_research_capture_events
      WHERE interval_minutes=l.interval_minutes AND round_id=l.round_id AND stage='CHECKPOINT_REJECTED'
      ORDER BY recorded_at DESC LIMIT 1) rejected ON true
    WHERE l.interval_minutes=$1 AND l.expiry_ms<$2 AND c.round_id IS NULL
    ORDER BY l.expiry_ms LIMIT 200`,[interval,now]);
  for(const r of pending.rows) {
    const input={intervalMinutes:interval,roundId:r.round_id,startMs:Number(r.start_ms),
      expiryMs:Number(r.expiry_ms),anchorPrice:r.initial_anchor_price==null ? null : Number(r.initial_anchor_price),
      anchorConfirmed:r.initial_anchor_confirmed===true,probabilityUp:null,probabilityDown:null,
      observedAt:new Date(r.observed_at).toISOString()};
    const noChoice=freezeResearchDecision(input,now,
      unavailableComparison("No live primary-lock observation was recorded."),
      undefined,Number(r.primary_lock_seconds))!;
    if(noChoice.state!=="NO_VALID_CHOICE") throw new Error("Recovery must never create a historical prediction.");
    if(r.rejection_code) {
      noChoice.noChoiceCode=r.rejection_code;
      noChoice.noChoiceReason=`${r.rejection_reason} No valid replacement arrived within the declared checkpoint grace.`;
      noChoice.evidence=r.rejection_evidence;
    }
    const inserted=await researchPool.query(researchChoiceInsert,researchChoiceValues(noChoice));
    if(inserted.rows.length) {
      await recordNoValidData(researchPool,input,input.expiryMs);
      await captureResearchEvent(researchPool,{...input,stage:"NO_VALID_CHOICE",
        code:noChoice.noChoiceCode!,reason:noChoice.noChoiceReason!});
    }
  }
  // Expiry recovery is diagnostics-only. It never creates a late horizon
  // snapshot or reconstructs a probability from a stored first-odds row.
  const missedHorizons=await researchPool.query(`SELECT p.round_id,p.start_ms,p.expiry_ms,
      h.value::integer AS lock_seconds
    FROM waterx_research_round_policy p
    JOIN LATERAL jsonb_array_elements_text(p.horizon_seconds) h(value) ON true
    JOIN waterx_research_capture_events observed ON observed.interval_minutes=p.interval_minutes
      AND observed.round_id=p.round_id AND observed.stage='OBSERVED'
    LEFT JOIN waterx_research_horizon_snapshots s ON s.interval_minutes=p.interval_minutes
      AND s.round_id=p.round_id AND s.start_ms=p.start_ms AND s.expiry_ms=p.expiry_ms
      AND s.lock_seconds=h.value::integer
    LEFT JOIN waterx_research_capture_events audit ON audit.interval_minutes=p.interval_minutes
      AND audit.start_ms=p.start_ms AND audit.stage='HORIZON_SNAPSHOT_MISSED'
      AND audit.code='HORIZON_'||h.value||'S_WINDOW_MISSED'
    WHERE p.interval_minutes=$1 AND p.expiry_ms<$2 AND s.round_id IS NULL
      AND audit.id IS NULL
    ORDER BY p.expiry_ms LIMIT 500`,[interval,now]);
  for(const row of missedHorizons.rows) {
    await captureResearchEvent(researchPool,{intervalMinutes:interval,
      roundId:String(row.round_id),startMs:Number(row.start_ms),expiryMs:Number(row.expiry_ms),
      stage:"HORIZON_SNAPSHOT_MISSED",code:`HORIZON_${row.lock_seconds}S_WINDOW_MISSED`,
      reason:"The pinned horizon passed without an immutable in-window snapshot; expiry recovery records diagnostics only.",
      details:{lockSeconds:Number(row.lock_seconds),eligible:false,noBackfill:true}});
  }
}
async function reconcileDisputedLifecycleResults(interval:ResearchInterval,now=Date.now()) {
  const withdrawn = await researchPool.query(`SELECT e.start_ms,e.expiry_ms,e.round_id,e.side,e.outcome,
      CASE WHEN l.round_id IS NULL THEN 'matching verified settlement disappeared'
        WHEN l.settlement_disputed THEN 'settlement label is disputed'
        WHEN l.label_status<>'verified' OR upper(l.outcome)<>e.outcome THEN 'verified settlement no longer matches recorded result'
        ELSE 'settlement verification withdrawn' END AS reason
    FROM waterx_research_lifecycle_events e
    LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=e.interval_minutes
      AND l.round_id=e.round_id AND l.start_ms=e.start_ms AND l.expiry_ms=e.expiry_ms
    WHERE e.interval_minutes=$1 AND e.event_type='RESULT'
      AND (l.round_id IS NULL OR l.settlement_disputed OR l.label_status<>'verified'
        OR upper(l.outcome)<>e.outcome)
      AND NOT EXISTS (SELECT 1 FROM waterx_research_lifecycle_events w
        WHERE w.interval_minutes=e.interval_minutes AND w.round_id=e.round_id
          AND w.event_type='RESULT_WITHDRAWN')
    ORDER BY e.actual_at_ms LIMIT 200`,[interval]);
  for (const row of withdrawn.rows) {
    await withdrawDisputedResearchResult(researchPool,{
      intervalMinutes:interval,roundId:String(row.round_id),startMs:Number(row.start_ms),
      expiryMs:Number(row.expiry_ms),side:String(row.side).toUpperCase() as "UP"|"DOWN",
      previousOutcome:String(row.outcome).toUpperCase() as "UP"|"DOWN",
      actualAtMs:now,reason:String(row.reason),
    });
  }
}
export function startResearchMaintenance() {
  let stopped=false,working=false,lastAlertCheck=0;
  const alertLogged=new Map<ResearchInterval,number>();
  async function run() {
    if(stopped||working||!process.env.DATABASE_URL) return;
    working=true;
    try {
      for(const interval of [5,15] as const) {
        try {
          const now=Date.now(),live=waterxLive(interval);
          if(live.status!=="LIVE"||!live.round) await recordResearchIdentityFailure(interval,now);
          await reconcileMissedResearchChoices(interval,now);
          await scoreResearchChoices(interval);
          await reconcileDisputedLifecycleResults(interval,now);
          if(process.env.NODE_ENV==="development")try{await maintainLockEvidence(interval);}
          catch(error){if(!researchSchemaMissing(error))console.warn("Adaptive research maintenance failed:",
            error instanceof Error?error.message.slice(0,160):"unknown");}
          if(now-lastAlertCheck>=60000) {
            const round=live.round ? {id:live.round.id,startMs:live.round.startMs,expiryMs:live.round.expiryMs} : null;
            const report=await getResearchReport(interval,round,now);
            if(report.alert.active && now-(alertLogged.get(interval)??0)>3600000) {
              console.error(`[waterx-${interval}m] research capture alert: ${report.alert.reason}`);
              alertLogged.set(interval,now);
            }
          }
        } catch(error) {
          if(!researchSchemaMissing(error)) console.warn(`[waterx-${interval}m] research maintenance failed:`,
            error instanceof Error ? error.message.slice(0,180) : "unknown failure");
        }
      }
      if(Date.now()-lastAlertCheck>=60000) lastAlertCheck=Date.now();
    } finally { working=false; }
  }
  // Round settlement remains independently polled by the collector.
  // Reconciliation and scoring may lag by up to one maintenance period;
  // they must not cause four database scans per minute when idle.
  const periodMs = process.env.WATERX_RESEARCH_MAINTENANCE_FAST === "true"
    ? 15_000 : 60_000;
  const timer=setInterval(()=>void run(),periodMs);timer.unref();
  void run();
  return ()=>{stopped=true;clearInterval(timer);};
}