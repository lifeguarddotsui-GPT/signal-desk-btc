import pg from "pg";
import type { ResearchChoice, ResearchInterval } from "../../shared/waterx-research";
import { WATERX_RESEARCH_POLICY as POLICY } from "../../shared/waterx-research";
import { COMPARISON_SOURCE } from "../btc/chart";
import { captureResearchShadowPrediction } from "./research-shadow";
import {
  checkpointAt, comparisonFeatures, freezeResearchDecision, researchScore,
  unavailableComparison, type ResearchObservation, type ResearchTick,
} from "./research-decision";

export const researchPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL, max: 2,
  connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000,
});
export type ResearchDb = Pick<pg.Pool,"query">;
export function researchSchemaMissing(error: unknown) {
  return ["42P01","42703","3F000"].includes(String((error as {code?:unknown})?.code ?? ""));
}
export async function captureResearchEvent(db: ResearchDb, input: {
  intervalMinutes: ResearchInterval; roundId: string | null; startMs: number; expiryMs: number;
  stage: string; code: string; reason: string; details?: unknown;
}) {
  await db.query(`INSERT INTO waterx_research_capture_events
    (interval_minutes,round_id,start_ms,expiry_ms,stage,code,reason,details)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (interval_minutes,start_ms,stage,code) DO NOTHING`,
  [input.intervalMinutes,input.roundId,input.startMs,input.expiryMs,input.stage,
    input.code,input.reason,JSON.stringify(input.details ?? {})]);
}
export function choiceFromRow(row: Record<string,unknown>): ResearchChoice {
  const evidence = typeof row.evidence === "string" ? JSON.parse(row.evidence) : row.evidence;
  const state = row.state as ResearchChoice["state"];
  const disputed = row.settlement_disputed === true;
  const verifiedScore = row.scored_outcome != null && row.label_status === "verified" &&
    !disputed && String(row.label_outcome).toUpperCase() === row.scored_outcome;
  const number = (v:unknown) => v == null ? null : Number(v);
  return {
    intervalMinutes: Number(row.interval_minutes) as ResearchInterval, roundId: String(row.round_id),
    startMs: Number(row.start_ms), expiryMs: Number(row.expiry_ms),
    checkpointAtMs: Number(row.checkpoint_at_ms), decisionAtMs: Number(row.decision_at_ms),
    state, side: row.side as ResearchChoice["side"], probabilityUp: number(row.probability_up),
    probabilityDown: number(row.probability_down), choiceSource: row.choice_source as ResearchChoice["choiceSource"],
    modelVersion: row.model_version as string|null, calibrationVersion: row.calibration_version as string|null,
    policyVersion: String(row.policy_version), noChoiceCode: row.no_choice_code as string|null,
    noChoiceReason: row.no_choice_reason as string|null, evidence,
    settlement: {
      state: state === "NO_VALID_CHOICE" ? "not-applicable" : disputed ? "disputed"
        : verifiedScore ? row.correct ? "correct" : "incorrect"
        : row.label_status === "withheld" ? "withheld" : "pending",
      outcome: verifiedScore ? row.scored_outcome as "UP"|"DOWN" : null,
      brier: verifiedScore ? number(row.brier) : null,
      logLoss: verifiedScore ? number(row.log_loss) : null,
      referenceDiscrepancyUsd: verifiedScore ? number(row.reference_discrepancy_usd) : null,
      labelAvailableAt: verifiedScore && row.label_available_at
        ? new Date(String(row.label_available_at)).toISOString() : null,
    },
  };
}
export const researchChoicesSelect = `SELECT c.*,l.label_status,l.outcome AS label_outcome,
  l.settlement_disputed,s.outcome AS scored_outcome,s.correct,s.brier,s.log_loss,
  s.reference_discrepancy_usd,s.label_available_at
  FROM waterx_research_choices c
  LEFT JOIN waterx_learning_rounds l USING (interval_minutes,round_id)
  LEFT JOIN waterx_research_scores s USING (interval_minutes,round_id)`;
export const researchChoiceInsert = `INSERT INTO waterx_research_choices
  (interval_minutes,round_id,start_ms,expiry_ms,checkpoint_at_ms,decision_at_ms,state,side,
   probability_up,probability_down,choice_source,model_version,calibration_version,
   policy_version,no_choice_code,no_choice_reason,evidence)
  SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb
  WHERE ($7='NO_VALID_CHOICE' OR
    (extract(epoch FROM clock_timestamp())*1000 < $4::bigint
      AND extract(epoch FROM clock_timestamp())*1000 <= $5::bigint+$18::bigint
      AND $6::bigint <= extract(epoch FROM clock_timestamp())*1000))
  ON CONFLICT (interval_minutes,round_id) DO NOTHING RETURNING round_id`;
export function researchChoiceValues(c:ResearchChoice) {
  return [c.intervalMinutes,c.roundId,c.startMs,c.expiryMs,c.checkpointAtMs,c.decisionAtMs,
    c.state,c.side,c.probabilityUp,c.probabilityDown,c.choiceSource,c.modelVersion,
    c.calibrationVersion,c.policyVersion,c.noChoiceCode,c.noChoiceReason,
    JSON.stringify(c.evidence),POLICY.checkpointGraceMs];
}
/** Immutable first-odds storage remains a retrospective baseline. Research
 * freezes its own declared checkpoint odds; it never mixes those observations. */
export async function captureResearchObservation(input:ResearchObservation,
  options: { db?:ResearchDb; nowMs?:number } = {}): Promise<string> {
  const db = options.db ?? researchPool;
  const now = options.nowMs ?? Date.now();
  const event = { intervalMinutes:input.intervalMinutes,roundId:input.roundId,
    startMs:input.startMs,expiryMs:input.expiryMs };
  // Validate identity before accepting any audit event.
  freezeResearchDecision(input, Math.min(now,checkpointAt(input.intervalMinutes,input.expiryMs)-1),
    unavailableComparison("Not evaluated before the primary checkpoint."));
  await captureResearchEvent(db,{...event,stage:"OBSERVED",code:"VALID_ROUND_OBSERVED",
    reason:"Valid WaterX round identity observed by the research collector.",
    details:{referenceQuality:input.anchorPrice===null ? "unavailable" : input.anchorConfirmed ? "confirmed" : "provisional",
      anchorPrice:input.anchorPrice,appObservedAt:input.observedAt}});
  if (now < checkpointAt(input.intervalMinutes,input.expiryMs)) return "Research awaiting declared checkpoint.";
  const prior = await db.query(`${researchChoicesSelect}
    WHERE c.interval_minutes=$1 AND c.round_id=$2`,[input.intervalMinutes,input.roundId]);
  if (prior.rows.length) return "Research choice already immutable for this round.";
  const at = Date.parse(input.observedAt);
  let comparison = unavailableComparison("Coinbase lookback unavailable at the checkpoint.");
  if (Number.isFinite(at)) {
    try {
    const result = await db.query(`SELECT id,source_at,received_at,price
      FROM waterx_comparison_ticks
      WHERE source=$1 AND source_at >= $2 AND source_at <= $3 AND received_at <= $3
      ORDER BY source_at DESC,id DESC LIMIT 20000`,
    [COMPARISON_SOURCE,new Date(at-195000),new Date(at)]);
    const ticks:ResearchTick[] = result.rows.map(r=>({id:String(r.id),price:Number(r.price),
      sourceAtMs:new Date(r.source_at).getTime(),receivedAtMs:new Date(r.received_at).getTime()}));
    comparison = comparisonFeatures(ticks,at,result.rows.length===20000);
    } catch(error) {
      comparison=unavailableComparison(`Bounded Coinbase evidence read failed (code ${String((error as {code?:unknown})?.code ?? "READ_FAILED")}); a baseline choice does not require comparison features.`);
    }
  }
  const choice = freezeResearchDecision(input,now,comparison)!;
  if(choice.state==="NO_VALID_CHOICE" && choice.noChoiceCode!=="CHECKPOINT_MISSED") {
    // A first queued/stale observation must not consume the whole declared
    // grace period. Persist the rejection and permit a genuinely fresh retry.
    await captureResearchEvent(db,{...event,stage:"CHECKPOINT_REJECTED",
      code:choice.noChoiceCode!,reason:choice.noChoiceReason!,details:choice.evidence});
    return `Research checkpoint evidence rejected: ${choice.noChoiceCode}; awaiting a timely retry.`;
  }
  if (comparison.coverage !== "complete") await captureResearchEvent(db,{...event,
    stage:"FEATURE_QUALITY",code:"COINBASE_LOOKBACK_INCOMPLETE",
    reason:comparison.reason ?? "Incomplete Coinbase coverage.",details:comparison});
  const inserted = await db.query(researchChoiceInsert,researchChoiceValues(choice));
  if (!inserted.rows.length) {
    // A slow DB lookup cannot backfill a previously valid decision after cutoff.
    const existing = await db.query("SELECT round_id FROM waterx_research_choices WHERE interval_minutes=$1 AND round_id=$2",
      [input.intervalMinutes,input.roundId]);
    if (existing.rows.length) return "Research choice already immutable for this round.";
    const missed = freezeResearchDecision(input,Math.max(Date.now(),
      checkpointAt(input.intervalMinutes,input.expiryMs)+POLICY.checkpointGraceMs+1),comparison)!;
    if (missed.state !== "NO_VALID_CHOICE") throw new Error("Late research insert rejected.");
    missed.noChoiceCode="INSERT_CUTOFF_PASSED";
    missed.noChoiceReason="Database insertion did not complete before the declared checkpoint cutoff; no prediction was backfilled.";
    await db.query(researchChoiceInsert,researchChoiceValues(missed));
    await captureResearchEvent(db,{...event,stage:"NO_VALID_CHOICE",code:"INSERT_CUTOFF_PASSED",
      reason:"Database insertion did not complete before the declared checkpoint cutoff; no prediction was backfilled."});
    return "Research no valid choice: INSERT_CUTOFF_PASSED.";
  }
  await captureResearchEvent(db,{...event,
    stage:choice.state==="FROZEN" ? "CHOICE_FROZEN" : "NO_VALID_CHOICE",
    code:choice.noChoiceCode ?? "CHECKPOINT_CHOICE_FROZEN",
    reason:choice.noChoiceReason ?? "Official checkpoint choice frozen; not an entry recommendation.",
    details:{side:choice.side,source:choice.choiceSource,referenceQuality:choice.evidence.reference.quality}});
  // Genuine candidate forecasts are separate shadow evidence, never entry
  // proof or a reason to replace the official baseline choice.
  if(choice.state==="FROZEN") await captureResearchShadowPrediction(choice,db);
  return choice.state==="FROZEN" ? `Research ${choice.side} checkpoint choice frozen (market baseline).`
    : `Research no valid choice: ${choice.noChoiceCode}.`;
}

/** Settlement is joined by exact identity; scoring never fetches or invents a label. */
export async function scoreResearchChoices(interval:ResearchInterval, db:ResearchDb=researchPool,nowMs=Date.now()) {
  const client = db instanceof pg.Pool ? await db.connect() : null;
  const q = client ?? db;
  try {
    if (client) await q.query("BEGIN");
    const result = await q.query(`SELECT c.*,l.outcome,l.settlement_anchor_price,l.settlement_evidence,
      l.settlement_observed_at,l.first_verified_at
      FROM waterx_research_choices c JOIN waterx_learning_rounds l USING(interval_minutes,round_id)
      LEFT JOIN waterx_research_scores s USING(interval_minutes,round_id)
      WHERE c.interval_minutes=$1 AND c.state='FROZEN' AND s.round_id IS NULL
        AND c.start_ms=l.start_ms AND c.expiry_ms=l.expiry_ms
        AND l.label_status='verified' AND NOT l.settlement_disputed
        AND l.outcome IN ('Up','Down') AND l.settlement_anchor_price>0
        AND l.settled_at>c.expiry_ms AND l.settlement_observed_at IS NOT NULL
        AND l.settled_at<=$2
        AND l.settlement_observed_at<=to_timestamp($2::double precision/1000)
        AND l.settlement_observed_at>to_timestamp(c.expiry_ms::double precision/1000)
        AND c.decision_at_ms<c.expiry_ms
      ORDER BY c.decision_at_ms LIMIT 200
      FOR SHARE OF l`,[interval,nowMs]);
    for (const r of result.rows) {
      const choice = choiceFromRow(r);
      const outcome = String(r.outcome).toUpperCase() as "UP"|"DOWN";
      const score = researchScore(choice,outcome,Number(r.settlement_anchor_price));
      const available = r.first_verified_at;
      if (!available) throw new Error("Verified label lacks its first accepted availability timestamp.");
      await q.query(`INSERT INTO waterx_research_scores
        (interval_minutes,round_id,outcome,correct,brier,log_loss,market_baseline_brier,
         market_baseline_log_loss,probability_band,time_remaining_seconds,reference_quality,
         reference_discrepancy_usd,label_available_at,settlement_evidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (interval_minutes,round_id) DO NOTHING`,
      [interval,choice.roundId,outcome,score.correct,score.brier,score.logLoss,
        score.marketBaselineBrier,score.marketBaselineLogLoss,score.probabilityBand,
        score.timeRemainingSeconds,score.referenceQuality,score.referenceDiscrepancyUsd,
        available,JSON.stringify(r.settlement_evidence)]);
    }
    if (client) await q.query("COMMIT");
    return result.rows.length;
  } catch(error) {
    if (client) await q.query("ROLLBACK").catch(()=>{});
    throw error;
  } finally { client?.release(); }
}

/** Missed identity checkpoints are audit slots, not fabricated WaterX round IDs. */
export async function recordResearchIdentityFailure(interval:ResearchInterval,now=Date.now(),db:ResearchDb=researchPool) {
  const cadence = interval*60000, start = Math.floor(now/cadence)*cadence, expiry = start+cadence;
  if (now < checkpointAt(interval,expiry)+POLICY.checkpointGraceMs) return;
  const observed = await db.query(`SELECT 1 FROM waterx_research_capture_events
    WHERE interval_minutes=$1 AND start_ms=$2 AND stage='OBSERVED' LIMIT 1`,[interval,start]);
  if (observed.rows.length) return;
  await captureResearchEvent(db,{intervalMinutes:interval,roundId:null,startMs:start,expiryMs:expiry,
    stage:"NO_VALID_CHOICE",code:"ROUND_IDENTITY_UNAVAILABLE",
    reason:"No valid timely WaterX round identity was observed at this expected checkpoint; no round ID or prediction was fabricated."});
}