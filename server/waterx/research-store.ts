import pg from "pg";
import {
  WATERX_RESEARCH_CONFIG as CONFIG,
  type ResearchChoice, type ResearchInterval,
} from "../../shared/waterx-research";
import { WATERX_RESEARCH_POLICY as POLICY } from "../../shared/waterx-research";
import { captureResearchShadowPrediction } from "./research-shadow";
import { captureResearchFeatureSupplement } from "./research-feature-supplement";
import { observeFeatureState, type FeatureSnapshot } from "./bluewater-fast";
import { captureBluewaterForecasts, appendModelResults } from "./bluewater-store";
import { appendLockTiming } from "./lock-store";
import { lockLatency } from "./lock-readiness";
import { createWaterxBackgroundQueue } from "./background-queue";
import { roundDecisions } from "./round-decision";
import {refreshHealth} from "./refresh-health";
import {
  pinResearchRoundPolicy, recordResearchHorizonSnapshot, recordResearchLifecycleEvent,
  recordResearchLiveObservation, recordVerifiedResearchResult, hasResearchHorizonSnapshot,
} from "./research-lifecycle";
import {
  checkpointAt, freezeResearchDecision, researchScore, unavailableComparison,
  type ResearchObservation,
} from "./research-decision";

export const researchPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL, max: 2,
  connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000,
});
export type ResearchDb = Pick<pg.Pool,"query">;
const deferredResearchQueue=createWaterxBackgroundQueue<{
  intervalMinutes:ResearchInterval;run:()=>Promise<void>;
}>(input=>input.run(),(interval,error)=>console.warn(`[waterx-${interval}m] deferred model enrichment failed:`,
  error instanceof Error?error.message.slice(0,160):"unknown"));
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
  LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=c.interval_minutes AND l.round_id=c.round_id
    AND l.start_ms=c.start_ms AND l.expiry_ms=c.expiry_ms
  LEFT JOIN waterx_research_scores s ON s.interval_minutes=c.interval_minutes AND s.round_id=c.round_id`;
export const researchChoiceInsert = `INSERT INTO waterx_research_choices
  (interval_minutes,round_id,start_ms,expiry_ms,checkpoint_at_ms,decision_at_ms,state,side,
   probability_up,probability_down,choice_source,model_version,calibration_version,
   policy_version,no_choice_code,no_choice_reason,evidence)
  SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb
  WHERE ($7='NO_VALID_CHOICE' OR
    (extract(epoch FROM clock_timestamp())*1000 < $4::bigint
      AND $6::bigint <= extract(epoch FROM clock_timestamp())*1000))
  ON CONFLICT (interval_minutes,round_id) DO NOTHING RETURNING round_id`;
export function researchChoiceValues(c:ResearchChoice) {
  return [c.intervalMinutes,c.roundId,c.startMs,c.expiryMs,c.checkpointAtMs,c.decisionAtMs,
    c.state,c.side,c.probabilityUp,c.probabilityDown,c.choiceSource,c.modelVersion,
    c.calibrationVersion,c.policyVersion,c.noChoiceCode,c.noChoiceReason,
    JSON.stringify(c.evidence)];
}
/** Immutable first-odds storage remains a retrospective baseline. Research
 * freezes its own declared checkpoint odds; it never mixes those observations. */
export async function captureResearchObservation(input:ResearchObservation,
  options: { db?:ResearchDb; nowMs?:number; deferEnrichment?:boolean } = {}): Promise<string> {
  const db = options.db ?? researchPool;
  const now = options.nowMs ?? Date.now();
  let feature:FeatureSnapshot|null=null;
  try{
    const at=Date.parse(input.observedAt);
    if(input.probabilityUp!==null&&input.probabilityDown!==null)feature=observeFeatureState({
      intervalMinutes:input.intervalMinutes,roundId:input.roundId,startMs:input.startMs,expiryMs:input.expiryMs,
      decisionAtMs:now,market:{probabilityUp:input.probabilityUp,probabilityDown:input.probabilityDown,sourceAtMs:at,receivedAtMs:at},
      reference:input.anchorPrice!==null?{price:input.anchorPrice,confirmed:input.anchorConfirmed,sourceAtMs:at,receivedAtMs:at}:null});
  }catch{/* Invalid optional features cannot change canonical eligibility. */}
  const event = { intervalMinutes:input.intervalMinutes,roundId:input.roundId,
    startMs:input.startMs,expiryMs:input.expiryMs };
  const client = db instanceof pg.Pool ? await db.connect() : null;
  const q = client ?? db;
  const optionalBluewater=async(force=false)=>{
    if(options.deferEnrichment&&!force){
      deferredResearchQueue.enqueue({intervalMinutes:input.intervalMinutes,run:()=>optionalBluewater(true)});
      return;
    }
    if(!feature)return;
    try{await captureBluewaterForecasts(db,feature);}
    catch(error){await captureResearchEvent(db,{...event,stage:"OPTIONAL_ENRICHMENT",
      code:"BLUEWATER_CAPTURE_FAILED",reason:"Bluewater optional capture failed; WaterX canonical evidence is unchanged.",
      details:{databaseCode:String((error as {code?:unknown}).code??"FEATURE_CAPTURE_FAILED")}});}
  };
  let released = false;
  const transactionStartMs=Date.now();
  let canonicalLockPersisted=false;
  let canonicalEvaluationMs=now;
  let canonicalTransactionMs=transactionStartMs;
  let canonicalComputeMs=0;
  let committedChoice:ResearchChoice|null=null;
  const commit = async () => {
    if (client) {
      await q.query("COMMIT");
      client.release();
      released = true;
    }
    if(canonicalLockPersisted){
      const committedAtMs=Date.now();
      refreshHealth.record({interval:input.intervalMinutes,roundId:input.roundId,
        stage:"DATABASE_COMMIT",outcome:"ok",elapsedMs:committedAtMs-canonicalTransactionMs});
      if(committedChoice?.state==="FROZEN"&&committedChoice.side&&committedChoice.probabilityUp!==null)
        roundDecisions.committed(input,{side:committedChoice.side,probabilityUp:committedChoice.probabilityUp,
          decisionAtMs:committedChoice.decisionAtMs,committedAtMs});
      try {await appendLockTiming(db,event,{...lockLatency("CANONICAL_LOCK",{
        atMs:Date.parse(input.observedAt),receivedAtMs:input.receivedAtMs??Date.parse(input.observedAt),
        providerSourceAtMs:input.providerSourceAtMs??null,
        probabilityUp:input.probabilityUp!,probabilityDown:input.probabilityDown!,sourceHealthy:true},
        canonicalEvaluationMs,canonicalTransactionMs,committedAtMs),evaluationComputeMs:canonicalComputeMs});}
      catch(error){console.warn("Canonical lock latency could not be retained",String((error as {code?:string}).code??"TIMING_ERROR"));}
    }
  };
  try {
    if (client) await q.query("BEGIN");
    const priorChoice=await q.query(`SELECT state,side,probability_up,decision_at_ms FROM waterx_research_choices
      WHERE interval_minutes=$1 AND round_id=$2 AND start_ms=$3 AND expiry_ms=$4`,
    [input.intervalMinutes,input.roundId,input.startMs,input.expiryMs]);
    // All configured research horizons precede or equal the primary. Once
    // immutable, repeating feature/model/lifecycle writes cannot improve it and
    // can starve the next round's bounded checkpoint connection.
    if(priorChoice.rows[0]?.state==="FROZEN"){
      const previous=priorChoice.rows[0];
      if(previous.side==="UP"||previous.side==="DOWN")roundDecisions.committed(input,{
        side:previous.side,probabilityUp:Number(previous.probability_up),
        decisionAtMs:Number(previous.decision_at_ms),committedAtMs:null});
      await commit();
      // Frozen choice is authoritative, but it must not stop the distinct
      // mutable live-odds observation. This optional write is post-commit and
      // cannot alter the saved choice or reconstruct an on-time horizon.
      const at=Date.parse(input.observedAt),up=input.probabilityUp,down=input.probabilityDown;
      if(Number.isFinite(at)&&at>=input.startMs&&at<=now&&now<input.expiryMs&&
        now-at<=POLICY.maxOddsAgeMs&&up!==null&&down!==null&&
        Number.isFinite(up)&&Number.isFinite(down)&&up>=0&&up<=1&&down>=0&&down<=1&&
        Math.abs(up+down-1)<=0.000001){
        await recordResearchLiveObservation(q,{...event,probabilityUp:up,probabilityDown:down,
          side:up>=down?"UP":"DOWN",source:"waterx_market_baseline",observedAtMs:at});
      }
      return "Research primary choice already immutable for this round.";
    }
    if(priorChoice.rows.length) {
      const oldPolicy=await q.query(`SELECT 1 FROM waterx_research_round_policy
        WHERE interval_minutes=$1 AND round_id=$2 AND start_ms=$3 AND expiry_ms=$4`,
      [input.intervalMinutes,input.roundId,input.startMs,input.expiryMs]);
      if(!oldPolicy.rows.length) {
        await commit();
        return "Legacy immutable research choice retained without fabricating lifecycle policy history.";
      }
    }
    // Identity validation deliberately does not inspect entry eligibility,
    // settlement-reference quality, or optional Coinbase availability.
    freezeResearchDecision(input,input.startMs,unavailableComparison("Identity validation only."));
    const pinned = await pinResearchRoundPolicy(q,event);
    const primaryAt = input.expiryMs-pinned.primaryLockSeconds*1000;
    await captureResearchEvent(q,{...event,stage:"OBSERVED",code:"VALID_ROUND_OBSERVED",
      reason:"Valid exact WaterX round identity observed by the research collector.",
      details:{referenceQuality:input.anchorPrice===null||!Number.isFinite(input.anchorPrice)||input.anchorPrice<=0
        ? "unavailable" : input.anchorConfirmed ? "confirmed" : "provisional",
        anchorPrice:input.anchorPrice,appObservedAt:input.observedAt}});
    await recordResearchLifecycleEvent(q,{...event,eventType:"WATCHING",actualAtMs:now,
      details:{policyVersion:pinned.policyVersion}});

    const at = Date.parse(input.observedAt);
    const up = input.probabilityUp, down = input.probabilityDown;
    const fresh = Number.isFinite(at) && at>=input.startMs && at<=now &&
      now-at<=POLICY.maxOddsAgeMs && up!==null && down!==null &&
      Number.isFinite(up) && Number.isFinite(down) && up>=0 && up<=1 &&
      down>=0 && down<=1 && Math.abs(up+down-1)<=0.000001;
    const side = fresh ? (up!>=down! ? "UP" : "DOWN") : null;
    if(fresh) await recordResearchLiveObservation(q,{...event,probabilityUp:up,
      probabilityDown:down,side,source:"waterx_market_baseline",observedAtMs:at});
    const saveHorizons = async (includePrimary:boolean) => {
      if (now>=input.expiryMs) return;
      for (const seconds of pinned.horizonSeconds) {
        const primary=seconds===pinned.primaryLockSeconds;
        const target=input.expiryMs-seconds*1000;
        if (now<target || (primary&&!includePrimary)) continue;
        if(await hasResearchHorizonSnapshot(db,event,seconds)) continue;
        if(!primary && now>target+pinned.horizonCaptureGraceMs) {
          await captureResearchEvent(db,{...event,stage:"HORIZON_SNAPSHOT_MISSED",
            code:`HORIZON_${seconds}S_WINDOW_MISSED`,
            reason:"No fresh snapshot was captured inside the pinned bounded horizon window; no historical backfill was made.",
            details:{lockSeconds:seconds,targetAtMs:target,observedAtMs:now,
              eligible:false,researchOnly:true}});
          continue;
        }
        if(!fresh) continue;
        const eligible=now<=target+pinned.horizonCaptureGraceMs;
        await recordResearchHorizonSnapshot(db,{...event,lockSeconds:seconds,
          primary,actualAtMs:now,oddsObservedAtMs:at,eligible,
          horizonCaptureGraceMs:pinned.horizonCaptureGraceMs,
          probabilityUp:up,probabilityDown:down,side,source:"waterx_market_baseline",valid:true});
        if(primary&&!eligible) await captureResearchEvent(db,{...event,
          stage:"HORIZON_SNAPSHOT_MISSED",code:"PRIMARY_HORIZON_ACTUAL_TIMING_LATE",
          reason:"A fresh canonical primary choice was locked after the bounded horizon-comparison window; actual timing is retained and excluded from on-time cohort scores.",
          details:{lockSeconds:seconds,targetAtMs:target,observedAtMs:now,eligible:false,
            primaryChoiceStillValid:true}});
      }
    };

    const prior = await q.query(`${researchChoicesSelect}
      WHERE c.interval_minutes=$1 AND c.round_id=$2`,[input.intervalMinutes,input.roundId]);
    if (prior.rows.length) {
      await commit();
      try { await saveHorizons(false); }
      catch { await captureResearchEvent(db,{...event,stage:"OPTIONAL_ENRICHMENT",
        code:"HORIZON_SNAPSHOT_FAILED",reason:"Optional research horizon snapshot could not be persisted; canonical choice is unchanged."}); }
      await optionalBluewater();
      return "Research primary choice already immutable for this round.";
    }
    if (fresh) await recordResearchLifecycleEvent(q,{...event,eventType:"LEANING",
      side,actualAtMs:now,details:{probabilityUp:up,probabilityDown:down,
        source:"waterx_market_baseline",inputObservedAt:input.observedAt}});
    if (now < primaryAt) {
      await commit();
      try { await saveHorizons(false); }
      catch { await captureResearchEvent(db,{...event,stage:"OPTIONAL_ENRICHMENT",
        code:"HORIZON_SNAPSHOT_FAILED",reason:"Optional research horizon snapshot could not be persisted."}); }
      await optionalBluewater();
      return "Research awaiting pinned primary lock.";
    }

    // The canonical baseline is committed before any optional feature lookup,
    // inference, shadow write, or entry assessment can delay capture.
    // Do not backdate a choice after a connection/query queue delayed state evaluation.
    canonicalEvaluationMs=options.nowMs??Date.now();
    await captureResearchEvent(q,{...event,stage:"CHECKPOINT_ATTEMPTED",code:"PINNED_PRIMARY_ATTEMPTED",
      reason:"The exact pinned checkpoint is being evaluated using the received observation.",
      details:{targetAtMs:primaryAt,actualAtMs:canonicalEvaluationMs,observationAtMs:at}});
    const canonicalComputeStart=performance.now();
    const choice = freezeResearchDecision(input,canonicalEvaluationMs,
      unavailableComparison("Optional Coinbase evidence is not required for the canonical primary choice."),
      undefined,pinned.primaryLockSeconds)!;
    canonicalComputeMs=performance.now()-canonicalComputeStart;
    if(choice.state==="NO_VALID_CHOICE" && choice.noChoiceCode!=="CHECKPOINT_MISSED") {
      await captureResearchEvent(q,{...event,stage:"CHECKPOINT_REJECTED",
        code:choice.noChoiceCode!,reason:choice.noChoiceReason!,details:choice.evidence});
      await commit();
      try { await saveHorizons(false); }
      catch { await captureResearchEvent(db,{...event,stage:"OPTIONAL_ENRICHMENT",
        code:"HORIZON_SNAPSHOT_FAILED",reason:"Optional research horizon snapshot could not be persisted."}); }
      await optionalBluewater();
      return `Research evidence rejected: ${choice.noChoiceCode}; awaiting fresh valid WaterX odds before expiry.`;
    }
    await captureResearchEvent(q,{...event,stage:"CHOICE_WRITE_ATTEMPTED",code:"IMMUTABLE_PRIMARY_INSERT",
      reason:"Attempted prospective immutable choice insertion; visibility of the final choice proves commit, not this event's timestamp.",
      details:{state:choice.state,side:choice.side,decisionAtMs:choice.decisionAtMs}});
    // Actual final-row-write start; excludes the preceding audit insert.
    canonicalTransactionMs=Date.now();
    const inserted = await q.query(researchChoiceInsert,researchChoiceValues(choice));
    if (!inserted.rows.length) {
      const existing = await q.query("SELECT round_id FROM waterx_research_choices WHERE interval_minutes=$1 AND round_id=$2",
        [input.intervalMinutes,input.roundId]);
      if (existing.rows.length) {
        await commit();
        return "Research primary choice already immutable for this round.";
      }
      if (choice.state==="FROZEN") throw new Error("Database cutoff rejected a still-unexpired primary choice.");
    }
    if (choice.state==="FROZEN") {
      const finalEvent=await recordResearchLifecycleEvent(q,{...event,eventType:"FINAL_CHOICE",
        side:choice.side,actualAtMs:choice.decisionAtMs,
        details:{probabilityUp:choice.probabilityUp,probabilityDown:choice.probabilityDown,
          source:choice.choiceSource,lateActualTiming:choice.evidence.qualityFlags.includes("PRIMARY_LOCK_LATE_ACTUAL_TIMING"),
          primaryLockSeconds:pinned.primaryLockSeconds}});
      if(!finalEvent) throw new Error("Canonical primary choice and FINAL_CHOICE lifecycle event could not be persisted atomically.");
      canonicalLockPersisted=true;
      committedChoice=choice;
    } else {
      const noDataEvent=await recordResearchLifecycleEvent(q,{...event,eventType:"NO_VALID_DATA",
        actualAtMs:Math.min(now,input.expiryMs),
        details:{code:choice.noChoiceCode,reason:choice.noChoiceReason}});
      if(!noDataEvent) throw new Error("NO_VALID_DATA lifecycle event could not be persisted.");
    }
    await captureResearchEvent(q,{...event,
      stage:choice.state==="FROZEN" ? "CHOICE_FROZEN" : "NO_VALID_CHOICE",
      code:choice.noChoiceCode ?? "PRIMARY_CHOICE_FROZEN",
      reason:choice.noChoiceReason ?? "Official immutable primary choice stored before optional enrichment.",
      details:{side:choice.side,source:choice.choiceSource,referenceQuality:choice.evidence.reference.quality,
        decisionAtMs:choice.decisionAtMs}});
    await commit();

    try { await saveHorizons(choice.state==="FROZEN"); }
    catch(error) { await captureResearchEvent(db,{...event,stage:"OPTIONAL_ENRICHMENT",
      code:"HORIZON_SNAPSHOT_FAILED",reason:"Optional research horizon snapshot could not be persisted; canonical decision remains immutable.",
      details:{databaseCode:String((error as {code?:unknown})?.code ?? "UNKNOWN")}}); }
    const enrichFinalChoice=async()=>{
    await optionalBluewater(true);
    let shadowChoice=choice;
    if(choice.state==="FROZEN") {
      try { shadowChoice=await captureResearchFeatureSupplement(choice,db); }
      catch(error) {
        await captureResearchEvent(db,{...event,stage:"OPTIONAL_ENRICHMENT",
          code:"CHOICE_FEATURE_SUPPLEMENT_FAILED",
          reason:`Optional Coinbase supplement failed after official choice persistence (${String((error as {code?:unknown})?.code ?? "FEATURE_READ_FAILED")}).`});
      }
    }
    // Shadow inference is optional and cannot roll back/starve the official row.
    if(choice.state==="FROZEN") {
      try { await captureResearchShadowPrediction(
        Date.now()<choice.expiryMs ? shadowChoice : choice,db); }
      catch(error) {
        await captureResearchEvent(db,{...event,stage:"OPTIONAL_ENRICHMENT",
          code:"SHADOW_CAPTURE_FAILED",
          reason:`Optional candidate capture failed after official primary choice persisted (${String((error as {code?:unknown})?.code ?? "CAPTURE_FAILED")}).`});
      }
    }
    };
    // One final enrichment per round; do not make subsequent canonical samples
    // wait for a model/feature lookup. It cannot hold the committed client.
    if(options.deferEnrichment)void enrichFinalChoice().catch(error=>
      console.warn("Deferred final research enrichment failed:",error instanceof Error?error.message.slice(0,160):"unknown"));
    else await enrichFinalChoice();
    return choice.state==="FROZEN"
      ? `Research ${choice.side} primary choice frozen (market baseline).`
      : `Research no valid choice: ${choice.noChoiceCode}.`;
  } catch(error) {
    if (client && !released) await q.query("ROLLBACK").catch(()=>{});
    if(client&&!released){client.release();released=true;}
    try{
      const rawCode=String((error as {code?:unknown})?.code??"");
      await captureResearchEvent(db,{...event,stage:canonicalTransactionMs===null?"PROSPECTIVE_CAPTURE_FAILED":"CHOICE_WRITE_FAILED",
        code:"PROSPECTIVE_CAPTURE_TRANSACTION_FAILED",
        reason:"The prospective capture transaction failed; no successful choice or historical prediction is inferred.",
        details:{observedAtMs:Date.parse(input.observedAt),failureAtMs:Date.now(),choiceWriteAttempted:canonicalTransactionMs!==null,
          databaseCode:/^[A-Z0-9]{5}$/.test(rawCode)?rawCode:null}});
    }catch{/* An unavailable database cannot durably record its own outage. */}
    throw error;
  } finally { if (client && !released) client.release(); }
}

/** Settlement is joined by exact identity; scoring never fetches or invents a label. */
export async function scoreResearchChoices(interval:ResearchInterval, db:ResearchDb=researchPool,nowMs=Date.now()) {
  const client = db instanceof pg.Pool ? await db.connect() : null;
  const q = client ?? db;
  let scored=0;
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
      const stored = await q.query(`INSERT INTO waterx_research_scores
        (interval_minutes,round_id,outcome,correct,brier,log_loss,market_baseline_brier,
         market_baseline_log_loss,probability_band,time_remaining_seconds,reference_quality,
         reference_discrepancy_usd,label_available_at,settlement_evidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (interval_minutes,round_id) DO NOTHING RETURNING round_id`,
      [interval,choice.roundId,outcome,score.correct,score.brier,score.logLoss,
        score.marketBaselineBrier,score.marketBaselineLogLoss,score.probabilityBand,
        score.timeRemainingSeconds,score.referenceQuality,score.referenceDiscrepancyUsd,
        available,JSON.stringify(r.settlement_evidence)]);
      if (stored.rows.length) {
        const recorded=await recordVerifiedResearchResult(q,{
          intervalMinutes:interval,roundId:choice.roundId,startMs:choice.startMs,
          expiryMs:choice.expiryMs,side:choice.side!,outcome,
          actualAtMs:new Date(available).getTime(),labelEvidence:r.settlement_evidence,
        });
        if(!recorded) await captureResearchEvent(q,{intervalMinutes:interval,
          roundId:choice.roundId,startMs:choice.startMs,expiryMs:choice.expiryMs,
          stage:"LIFECYCLE_DIAGNOSTIC",code:"LEGACY_RESULT_NOT_LIFECYCLE_PINNED",
          reason:"Legacy immutable choice was scored, but no matching original pinned lifecycle policy exists; no lifecycle history was fabricated."});
      }
    }
    if (client) await q.query("COMMIT");
    scored=result.rows.length;
  } catch(error) {
    if (client) await q.query("ROLLBACK").catch(()=>{});
    throw error;
  } finally { client?.release(); }
  if(process.env.NODE_ENV==="development")try{await appendModelResults(db,interval);}catch(error){
    console.warn("Bluewater optional result append failed; canonical scores retained",
      String((error as {code?:unknown}).code??"MODEL_RESULT_FAILED"));
  }
  return scored;
}

/** Missed identity checkpoints are audit slots, not fabricated WaterX round IDs. */
export async function recordResearchIdentityFailure(interval:ResearchInterval,now=Date.now(),db:ResearchDb=researchPool) {
  const cadence = interval*60000, start = Math.floor(now/cadence)*cadence, expiry = start+cadence;
  if (now < checkpointAt(interval,expiry,CONFIG.primaryLockSeconds[interval])+POLICY.checkpointGraceMs) return;
  const observed = await db.query(`SELECT 1 FROM waterx_research_capture_events
    WHERE interval_minutes=$1 AND start_ms=$2 AND stage='OBSERVED' LIMIT 1`,[interval,start]);
  if (observed.rows.length) return;
  await captureResearchEvent(db,{intervalMinutes:interval,roundId:null,startMs:start,expiryMs:expiry,
    stage:"NO_VALID_CHOICE",code:"ROUND_IDENTITY_UNAVAILABLE",
    reason:"No valid timely WaterX round identity was observed at this expected checkpoint; no round ID or prediction was fabricated."});
}