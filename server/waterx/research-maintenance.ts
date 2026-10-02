import { freezeResearchDecision, unavailableComparison } from "./research-decision";
import {
  captureResearchEvent, recordResearchIdentityFailure, researchChoiceInsert,
  researchChoiceValues, researchPool, researchSchemaMissing, scoreResearchChoices,
} from "./research-store";
import { getResearchReport } from "./research-report";
import { waterxLive } from "./service";
import type { ResearchInterval } from "../../shared/waterx-research";
import { WATERX_RESEARCH_POLICY as POLICY } from "../../shared/waterx-research";

/** Recovery creates only explicit NO_VALID_CHOICE audit rows, never expired forecasts. */
export async function reconcileMissedResearchChoices(interval:ResearchInterval,now=Date.now()) {
  const pending = await researchPool.query(`SELECT l.*,rejected.code AS rejection_code,
      rejected.reason AS rejection_reason,rejected.details AS rejection_evidence
    FROM waterx_learning_rounds l
    JOIN waterx_research_capture_events e ON e.interval_minutes=l.interval_minutes
      AND e.round_id=l.round_id AND e.stage='OBSERVED'
    LEFT JOIN waterx_research_choices c ON c.interval_minutes=l.interval_minutes AND c.round_id=l.round_id
    LEFT JOIN LATERAL (SELECT code,reason,details FROM waterx_research_capture_events
      WHERE interval_minutes=l.interval_minutes AND round_id=l.round_id AND stage='CHECKPOINT_REJECTED'
      ORDER BY recorded_at DESC LIMIT 1) rejected ON true
    WHERE l.interval_minutes=$1 AND l.expiry_ms-$3+$4<$2 AND c.round_id IS NULL
    ORDER BY l.expiry_ms LIMIT 200`,[interval,now,
      POLICY.checkpointSecondsBeforeClose[interval]*1000,POLICY.checkpointGraceMs]);
  for(const r of pending.rows) {
    const input={intervalMinutes:interval,roundId:r.round_id,startMs:Number(r.start_ms),
      expiryMs:Number(r.expiry_ms),anchorPrice:r.initial_anchor_price==null ? null : Number(r.initial_anchor_price),
      anchorConfirmed:r.initial_anchor_confirmed===true,probabilityUp:null,probabilityDown:null,
      observedAt:new Date(r.observed_at).toISOString()};
    const noChoice=freezeResearchDecision(input,now,unavailableComparison("No checkpoint feature snapshot exists."))!;
    if(noChoice.state!=="NO_VALID_CHOICE") throw new Error("Recovery must never create a historical prediction.");
    if(r.rejection_code) {
      noChoice.noChoiceCode=r.rejection_code;
      noChoice.noChoiceReason=`${r.rejection_reason} No valid replacement arrived within the declared checkpoint grace.`;
      noChoice.evidence=r.rejection_evidence;
    }
    const inserted=await researchPool.query(researchChoiceInsert,researchChoiceValues(noChoice));
    if(inserted.rows.length) await captureResearchEvent(researchPool,{...input,stage:"NO_VALID_CHOICE",
      code:noChoice.noChoiceCode!,reason:noChoice.noChoiceReason!});
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
  const timer=setInterval(()=>void run(),15000);timer.unref();
  void run();
  return ()=>{stopped=true;clearInterval(timer);};
}