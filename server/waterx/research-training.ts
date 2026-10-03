import pg from "pg";
import type { ResearchDailyJob } from "../../shared/waterx-research";
import { WATERX_RESEARCH_POLICY as POLICY } from "../../shared/waterx-research";
import {
  trainWaterxResearchChoices,
  type ResearchTrainingRound,
  type ResearchTrainingReport,
} from "./research-training-model";
import {
  trainCanonicalWaterxBaseline,
  type CanonicalTrainingChoice,
  type CanonicalTrainingReport,
} from "./research-baseline-training";

export type ResearchTrainingQueryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

export type ResearchTrainingOptions = {
  now?: () => number;
  onError?: (error: unknown) => void;
  train?: typeof trainWaterxResearchChoices;
  executionMode?: ResearchDailyJob["mode"];
};

const MAX_RECORDS = POLICY.trainingMaxRows;
const STATEMENT_TIMEOUT_MS = 30_000;
const TRAINING_INTERVAL_MS = 60 * 60_000;
const activeScheduleCounts = new Map<ResearchDailyJob["mode"], number>();
const POOL = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5_000,
  query_timeout: STATEMENT_TIMEOUT_MS,
  statement_timeout: STATEMENT_TIMEOUT_MS,
}) as unknown as ResearchTrainingQueryable;

function isMissingSchema(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    ["42P01", "3F000", "42703"].includes(String((error as { code?: unknown }).code ?? ""));
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function finite(value: unknown): number | null {
  const converted = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(converted) ? converted : null;
}

function parseReferenceQuality(value: unknown): "provisional" | "confirmed" | null {
  return value === "provisional" || value === "confirmed" ? value : null;
}

export function choiceToTrainingRound(row: Record<string, unknown>): ResearchTrainingRound | null {
  const evidence = parseJson(row.evidence);
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  const value = evidence as Record<string, unknown>;
  const reference = value.reference && typeof value.reference === "object"
    ? value.reference as Record<string, unknown> : null;
  const market = value.market && typeof value.market === "object"
    ? value.market as Record<string, unknown> : null;
  const comparison = value.comparison && typeof value.comparison === "object"
    ? value.comparison as Record<string, unknown> : null;
  const source = comparison?.source === "Coinbase" ? comparison : null;
  if (!reference || !market || !source || source.coverage !== "complete") return null;
  const quality = parseReferenceQuality(reference.quality);
  if (!quality) return null;
  const roundId = typeof row.round_id === "string" ? row.round_id : "";
  const intervalMinutes = finite(row.interval_minutes);
  const startMs = finite(row.start_ms);
  const expiryMs = finite(row.expiry_ms);
  const decisionAtMs = finite(row.decision_at_ms);
  const probabilityUp = finite(row.probability_up);
  const marketProbabilityUp = finite(market.probabilityUp);
  const referenceObservedAtMs = finite(reference.appObservedAtMs);
  const marketObservedAtMs = finite(market.appObservedAtMs);
  const referencePrice = finite(reference.price);
  const comparisonPrice = finite(source.price);
  const comparisonSourceAtMs = finite(source.sourceAtMs);
  const comparisonReceivedAtMs = finite(source.receivedAtMs);
  const return1m = finite(source.return1m);
  const return3m = finite(source.return3m);
  const realizedVolatility = finite(source.realizedVolatility);
  const settlementAnchorPrice = finite(row.settlement_anchor_price);
  const settlePrice = finite(row.settle_price);
  const settledAtMs = finite(row.settled_at);
  const labelAvailableAtMs = row.settlement_observed_at instanceof Date
    ? row.settlement_observed_at.getTime()
    : Date.parse(String(row.settlement_observed_at ?? ""));
  if (!roundId || (intervalMinutes !== 5 && intervalMinutes !== 15) ||
      ![startMs, expiryMs, decisionAtMs, probabilityUp, marketProbabilityUp,
        referenceObservedAtMs, marketObservedAtMs,
        referencePrice, comparisonPrice, comparisonSourceAtMs, comparisonReceivedAtMs,
        return1m, return3m, realizedVolatility, settlementAnchorPrice, settlePrice,
        settledAtMs, labelAvailableAtMs].every(value => value !== null && Number.isFinite(value)))
    return null;
  if (row.state !== "FROZEN" || row.settlement_disputed === true ||
      row.label_status !== "verified" ||
      labelAvailableAtMs < settledAtMs! ||
      !["UP", "DOWN"].includes(String(row.outcome).toUpperCase()) ||
      row.settlement_quarantine !== null && parseJson(row.settlement_quarantine) !== null &&
        JSON.stringify(parseJson(row.settlement_quarantine)) !== "[]")
    return null;
  return {
    intervalMinutes,
    roundId,
    startMs: startMs!,
    expiryMs: expiryMs!,
    decisionAtMs: decisionAtMs!,
    referenceObservedAtMs: referenceObservedAtMs!,
    marketObservedAtMs: marketObservedAtMs!,
    probabilityUp: probabilityUp!,
    marketProbabilityUp: marketProbabilityUp!,
    referencePrice: referencePrice!,
    referenceQuality: quality,
    comparisonPrice: comparisonPrice!,
    comparisonSourceAtMs: comparisonSourceAtMs!,
    comparisonReceivedAtMs: comparisonReceivedAtMs!,
    return1m: return1m!,
    return3m: return3m!,
    realizedVolatilityBps: realizedVolatility! * 10_000,
    settlementAnchorPrice: settlementAnchorPrice!,
    settlePrice: settlePrice!,
    outcome: String(row.outcome).toUpperCase() === "UP" ? "UP" : "DOWN",
    settledAtMs: settledAtMs!,
    labelAvailableAtMs,
  };
}

/** Extracts the immutable-choice probability and verified outcome without
 * requiring reference or Coinbase feature coverage. The rich-feature route
 * remains separately validated by choiceToTrainingRound. */
export function choiceToCanonicalTrainingChoice(
  row: Record<string, unknown>,
): CanonicalTrainingChoice | null {
  const roundId = typeof row.round_id === "string" ? row.round_id : "";
  const intervalMinutes = finite(row.interval_minutes);
  const startMs = finite(row.start_ms);
  const expiryMs = finite(row.expiry_ms);
  const decisionAtMs = finite(row.decision_at_ms);
  const probabilityUp = finite(row.probability_up);
  const settlementAnchorPrice = finite(row.settlement_anchor_price);
  const settlePrice = finite(row.settle_price);
  const settledAtMs = finite(row.settled_at);
  const labelAvailableAtMs = row.settlement_observed_at instanceof Date
    ? row.settlement_observed_at.getTime()
    : Date.parse(String(row.settlement_observed_at ?? ""));
  const outcome = String(row.outcome).toUpperCase();
  if (!roundId || (intervalMinutes !== 5 && intervalMinutes !== 15) ||
      ![startMs, expiryMs, decisionAtMs, probabilityUp, settlementAnchorPrice,
        settlePrice, settledAtMs, labelAvailableAtMs].every(value =>
        value !== null && Number.isFinite(value)) ||
      row.state !== "FROZEN" || row.label_status !== "verified" ||
      row.settlement_disputed === true ||
      !["UP", "DOWN"].includes(outcome) ||
      settlementAnchorPrice! <= 0 || settlePrice! <= 0 ||
      settledAtMs! <= expiryMs! || labelAvailableAtMs < settledAtMs! ||
      row.settlement_quarantine !== null &&
        parseJson(row.settlement_quarantine) !== null &&
        JSON.stringify(parseJson(row.settlement_quarantine)) !== "[]")
    return null;
  if (outcome === "UP" ? settlePrice! < settlementAnchorPrice! :
      settlePrice! >= settlementAnchorPrice!)
    return null;
  return {
    intervalMinutes,
    roundId,
    startMs: startMs!,
    expiryMs: expiryMs!,
    decisionAtMs: decisionAtMs!,
    probabilityUp: probabilityUp!,
    outcome: outcome === "UP" ? "UP" : "DOWN",
    settledAtMs: settledAtMs!,
    labelAvailableAtMs,
  };
}

function isoForDate(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0)
    throw new Error("Research schedule requires a valid system timestamp.");
  return new Date(nowMs).toISOString().slice(0, 10);
}

async function researchSchemaAvailable(db: ResearchTrainingQueryable): Promise<boolean> {
  const result = await db.query<{ choices: string | null; daily: string | null; rounds: string | null }>(
    `SELECT to_regclass('waterx_research_choices')::text AS choices,
            to_regclass('waterx_research_daily_runs')::text AS daily,
            to_regclass('waterx_learning_rounds')::text AS rounds`,
  );
  return Boolean(result.rows[0]?.choices && result.rows[0]?.daily && result.rows[0]?.rounds);
}

async function researchFeatureSupplementAvailable(db: ResearchTrainingQueryable): Promise<boolean> {
  const result = await db.query<{ supplements: string | null }>(
    "SELECT to_regclass('waterx_research_feature_supplements')::text AS supplements",
  );
  return Boolean(result.rows[0]?.supplements);
}

async function persistFinished(
  db: ResearchTrainingQueryable,
  interval: 5 | 15,
  day: string,
  startedAt: string,
  status: "evaluated" | "insufficient" | "failed",
  finishedAt: string,
  fingerprint: string | null,
  count: number,
  error: string | null,
  reason: string | null,
  phases: { status: string; at: string }[],
  report: Record<string, unknown> | null,
  artifact: Record<string, unknown> | null,
) {
  const result = await db.query(
    `UPDATE waterx_research_daily_runs
        SET status=$3,finished_at=$4,dataset_fingerprint=$5,dataset_count=$6,
            error=$7,reason=$8,phases=$9::jsonb,report=$10::jsonb,artifact=$11::jsonb
      WHERE interval_minutes=$1 AND scheduled_day=$2::date AND started_at IS NOT DISTINCT FROM $12
      RETURNING interval_minutes`,
    [interval, day, status, finishedAt, fingerprint, count, error, reason,
      JSON.stringify(phases), JSON.stringify(report ?? {}),
      artifact === null ? null : JSON.stringify(artifact), startedAt],
  );
  if (!result.rows.length) throw new Error("Research daily attempt could not persist its terminal status.");
}

export type RunResearchTrainingResult = Readonly<{
  intervalMinutes: 5 | 15;
  scheduledDay: string;
  outcome: "trained" | "insufficient" | "failed" | "not-due" | "not-configured" | "lease-unavailable";
  reason: string | null;
  report?: (ResearchTrainingReport & { canonicalTraining?: CanonicalTrainingReport }) | null;
  datasetFingerprint?: string | null;
  datasetCount?: number;
}>;

/** Run one durable interval/day attempt on an existing database session. The
 * table's (interval_minutes,scheduled_day) PK, lease and insert gate make a
 * restart or second replica idempotent. No DDL or HTTP write trigger exists. */
export async function runResearchTrainingDay(
  db: ResearchTrainingQueryable,
  intervalMinutes: 5 | 15,
  options: ResearchTrainingOptions = {},
): Promise<RunResearchTrainingResult> {
  // Session advisory locks and SET/RESET cannot safely use pool.query:
  // concurrent status reads can route the next statement to another session.
  if (db instanceof pg.Pool) {
    const client=await db.connect();
    let released=false;
    try { return await runResearchTrainingDayOnSession(client,intervalMinutes,options); }
    catch(error) {
      // A cleanup/connection failure must not return a possibly leased session
      // to the pool. Destroying it lets PostgreSQL release its session locks.
      client.release(error instanceof Error ? error : new Error("Research session failed."));
      released=true;throw error;
    } finally { if(!released) client.release(); }
  }
  return runResearchTrainingDayOnSession(db,intervalMinutes,options);
}
async function runResearchTrainingDayOnSession(
  db: ResearchTrainingQueryable,
  intervalMinutes: 5 | 15,
  options: ResearchTrainingOptions = {},
): Promise<RunResearchTrainingResult> {
  const clock = options.now ?? Date.now;
  const now = clock();
  const day = isoForDate(now);
  const timestamp = new Date(now).toISOString();
  if (intervalMinutes !== 5 && intervalMinutes !== 15)
    throw new Error("Research training interval must be 5 or 15 minutes.");
  if (!await researchSchemaAvailable(db))
    return {
      intervalMinutes, scheduledDay: day, outcome: "not-configured",
      reason: "Research-choice, daily-run, and verified-learning schemas must be reviewed and applied before training.",
    };
  const lease = await db.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(95695,51516) AS acquired",
  );
  if (lease.rows[0]?.acquired !== true)
    return { intervalMinutes, scheduledDay: day, outcome: "lease-unavailable",
      reason: "Another WaterX research training session holds lease 95695/51516." };
  let resetTimeout = false;
  try {
    await db.query(`SET statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    resetTimeout = true;
    // An abandoned STARTED attempt is not evidence of a completed fit. Mark it
    // failed before reserving any new daily run; never convert it to trained.
    await db.query(
      `UPDATE waterx_research_daily_runs
          SET status='failed',finished_at=clock_timestamp(),
              error='Previous process ended before recording a terminal training result.',
              reason='stale_started_attempt_recovered'
        WHERE interval_minutes=$1 AND status='started'
          AND ((scheduled_day < $2::date) OR started_at < $3::timestamptz - interval '30 minutes')`,
      [intervalMinutes, day, timestamp],
    );
    const started = await db.query<{ started_at: Date | string }>(
      `INSERT INTO waterx_research_daily_runs
         (interval_minutes,scheduled_day,status,started_at,dataset_count,phases,report)
       VALUES ($1,$2::date,'started',$3,0,'[]'::jsonb,'{}'::jsonb)
       ON CONFLICT (interval_minutes,scheduled_day) DO NOTHING
       RETURNING started_at`,
      [intervalMinutes, day, timestamp],
    );
    if (!started.rows.length) {
      const previous = await db.query<{ status: string; reason: string | null }>(
        `SELECT status,reason FROM waterx_research_daily_runs
          WHERE interval_minutes=$1 AND scheduled_day=$2::date`,
        [intervalMinutes, day],
      );
      return {
        intervalMinutes,
        scheduledDay: day,
        outcome: "not-due",
        reason: `This UTC day already has a durable ${previous.rows[0]?.status ?? "recorded"} attempt.`,
      };
    }
    const startedAt = started.rows[0].started_at instanceof Date
      ? started.rows[0].started_at.toISOString() : new Date(started.rows[0].started_at).toISOString();
    const phases: { status: string; at: string }[] = [{ status: "started", at: timestamp }];
    let phaseWrites = Promise.resolve();
    let recordCount = 0;
    let fingerprint: string | null = null;
    try {
      const hasFeatureSupplements = await researchFeatureSupplementAvailable(db);
      const trainingEvidence = hasFeatureSupplements
        ? `CASE WHEN fs.feature_snapshot IS NOT NULL
                 THEN jsonb_set(c.evidence,'{comparison}',fs.feature_snapshot->'comparison',true)
                 ELSE c.evidence END`
        : "c.evidence";
      const supplementJoin = hasFeatureSupplements
        ? `LEFT JOIN waterx_research_feature_supplements fs
             ON fs.interval_minutes=c.interval_minutes AND fs.round_id=c.round_id
            AND fs.start_ms=c.start_ms AND fs.expiry_ms=c.expiry_ms
            AND fs.decision_at_ms=c.decision_at_ms
            AND fs.feature_snapshot->'comparison'->>'coverage'='complete'`
        : "";
      const selected = await db.query(
        `SELECT c.interval_minutes,c.round_id,c.start_ms,c.expiry_ms,c.decision_at_ms,
                c.state,c.probability_up,${trainingEvidence} AS evidence,
                l.label_status,l.settlement_disputed,l.settlement_quarantine,
                l.settlement_anchor_price,l.settle_price,l.outcome,
                 l.settled_at,l.first_verified_at AS settlement_observed_at
           FROM waterx_research_choices c
           JOIN waterx_learning_rounds l
              ON l.interval_minutes=c.interval_minutes AND l.round_id=c.round_id
                AND l.start_ms=c.start_ms AND l.expiry_ms=c.expiry_ms
           ${supplementJoin}
          WHERE c.interval_minutes=$1 AND c.state='FROZEN'
             AND l.label_status='verified'
            AND l.settlement_disputed IS FALSE AND l.outcome IN ('Up','Down','UP','DOWN')
            AND l.settlement_anchor_price>0 AND l.settle_price>0
            AND l.settled_at>c.expiry_ms AND l.settlement_observed_at IS NOT NULL
            AND l.settlement_observed_at >=
                to_timestamp(l.settled_at::double precision / 1000.0)
            AND l.settlement_observed_at <= clock_timestamp()
             AND l.first_verified_at IS NOT NULL
             AND l.first_verified_at<=to_timestamp($3::double precision/1000)
            AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
             AND c.decision_at_ms<=$3 AND c.expiry_ms<=$3
             AND l.settled_at<=$3
             AND l.settlement_observed_at<=to_timestamp($3::double precision/1000)
             AND c.decision_at_ms>=$4
          ORDER BY c.start_ms DESC,c.round_id
          LIMIT $2`,
        [intervalMinutes, MAX_RECORDS + 1,now,now-POLICY.trainingLookbackDays*86_400_000],
      );
      if (selected.rows.length > MAX_RECORDS)
        throw new Error(`Verified research cohort exceeds the ${MAX_RECORDS}-choice training bound; no truncated fit was produced.`);
      const canonicalRows = selected.rows
        .map(choiceToCanonicalTrainingChoice)
        .filter((row): row is CanonicalTrainingChoice => row !== null)
        .sort((a, b) => a.startMs - b.startMs || a.roundId.localeCompare(b.roundId));
      const rounds = selected.rows
        .map(choiceToTrainingRound)
        .filter((row): row is ResearchTrainingRound => row !== null)
        .sort((a, b) => a.startMs - b.startMs || a.roundId.localeCompare(b.roundId));
      const richFeatureRoundIds = new Set(rounds.map(row => row.roundId));
      const onPhase=(phase:string)=>{
        const event={status:phase,at:new Date(clock()).toISOString()};
        phases.push(event);
        const snapshot=JSON.stringify(phases);
        phaseWrites=phaseWrites.then(async()=>{
          await db.query(`UPDATE waterx_research_daily_runs SET phases=$3::jsonb
            WHERE interval_minutes=$1 AND scheduled_day=$2::date AND started_at=$4`,
          [intervalMinutes,day,snapshot,startedAt]);
        });
      };
      const canonicalTraining = trainCanonicalWaterxBaseline(intervalMinutes, canonicalRows, {
        asOfMs: now,
        richFeatureRoundIds,
        onPhase,
      });
      const trainer = options.train ?? trainWaterxResearchChoices;
      const report = trainer(intervalMinutes, rounds, onPhase);
      // Model fitting is pure, deterministic and deliberately bounded below
      // 30 seconds. Await phase writes so every terminal report has an auditable
      // sequence, and surface a failed write rather than losing training evidence.
      await phaseWrites;
      recordCount = canonicalTraining.datasetCount;
      fingerprint = canonicalTraining.datasetFingerprint;
      const terminalStatus = report.status === "candidate-evaluated" ||
          canonicalTraining.status === "candidate-evaluated"
        ? "evaluated" as const : "insufficient" as const;
      const finishedAt = new Date(clock()).toISOString();
      if (terminalStatus !== "insufficient" && !phases.some(phase =>
        phase.status === "evaluated" || phase.status === "canonical-evaluated")) {
        phases.push({ status: "canonical-evaluated", at: finishedAt });
        await db.query(
          `UPDATE waterx_research_daily_runs SET phases=$3::jsonb
            WHERE interval_minutes=$1 AND scheduled_day=$2::date AND started_at=$4`,
          [intervalMinutes, day, JSON.stringify(phases), startedAt],
        );
      }
      if (terminalStatus !== "insufficient" && !phases.some(phase =>
        phase.status === "evaluated" || phase.status === "canonical-evaluated"))
        throw new Error("Research trainer returned a candidate report without an evaluated held-out test.");
      await persistFinished(
        db, intervalMinutes, day, startedAt, terminalStatus, finishedAt,
        fingerprint, recordCount, null,
        [...report.rejectionReasons, ...canonicalTraining.rejectionReasons].join(" ") || null,
        phases, { ...report, canonicalTraining,
          cohortPolicy:{lookbackDays:POLICY.trainingLookbackDays,maxRows:MAX_RECORDS,
            from:new Date(now-POLICY.trainingLookbackDays*86400000).toISOString(),asOf:timestamp},
          executionMode: options.executionMode ??
          "opportunistic-existing-process" } as unknown as Record<string, unknown>,
          report.shadowArtifact as unknown as Record<string, unknown> | null,
      );
      try{
        const {registerDailyArtifacts}=await import("./bluewater-store");
        const range=(rows:{startMs:number;expiryMs:number}[])=>({
          fromMs:rows[0]?.startMs??now,throughMs:rows.at(-1)?.expiryMs??now});
        await registerDailyArtifacts(db,intervalMinutes,canonicalTraining,report,Date.now(),{
          canonical:range(canonicalRows),rich:range(rounds)});
        const {writeDailyResearchReport}=await import("./bluewater-experiments");
        await writeDailyResearchReport(db,intervalMinutes);
      }catch(error){options.onError?.(error);}
      return {
        intervalMinutes,
        scheduledDay: day,
        outcome: terminalStatus === "insufficient" ? "insufficient" : "trained",
        reason: report.rejectionReasons[0] ?? canonicalTraining.rejectionReasons[0] ?? null,
        report: { ...report, canonicalTraining },
        datasetFingerprint: fingerprint,
        datasetCount: recordCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown research training failure.";
      await persistFinished(db, intervalMinutes, day, startedAt, "failed",
        new Date(clock()).toISOString(), fingerprint, recordCount, message,
        "Training attempt failed; no promotion or serving model was changed.", phases, null, null);
      options.onError?.(error);
      return {
        intervalMinutes,
        scheduledDay: day,
        outcome: "failed",
        reason: message,
        datasetFingerprint: fingerprint,
        datasetCount: recordCount,
      };
    }
  } finally {
    try { if (resetTimeout) await db.query("RESET statement_timeout"); }
    finally { await db.query("SELECT pg_advisory_unlock(95695,51516)"); }
  }
}

function unavailableDaily(
  intervalMinutes: 5 | 15,
  mode: ResearchDailyJob["mode"],
  reason: string,
): ResearchDailyJob {
  return {
    configured: false,
    mode,
    guaranteesDailyExecution: false,
    scheduledDay: null,
    status: "unavailable",
    startedAt: null,
    finishedAt: null,
    datasetFingerprint: null,
    datasetCount: 0,
    error: null,
    reason: `Research training for ${intervalMinutes}m is unavailable: ${reason}`,
    phases: [],
    missedDays: 0,
  };
}

export async function getResearchDailyJob(
  intervalMinutes: 5 | 15,
  options: { mode?: ResearchDailyJob["mode"]; db?: ResearchTrainingQueryable } = {},
): Promise<ResearchDailyJob> {
  const mode = options.mode ?? "opportunistic-existing-process";
  const db = options.db ?? POOL;
  if (!process.env.DATABASE_URL && !options.db)
    return unavailableDaily(intervalMinutes, mode, "DATABASE_URL is not configured.");
  try {
    const available = await researchSchemaAvailable(db);
    if (!available) return unavailableDaily(intervalMinutes, mode,
      "Reviewed research schema has not been applied. No startup DDL was run.");
    const { rows } = await db.query(
      `SELECT scheduled_day,status,started_at,finished_at,dataset_fingerprint,
              dataset_count,error,reason,phases,report
         FROM waterx_research_daily_runs
        WHERE interval_minutes=$1
        ORDER BY scheduled_day DESC LIMIT 1`,
      [intervalMinutes],
    );
    const row = rows[0];
    if (!row) {
      return {
        configured: (activeScheduleCounts.get(mode) ?? 0) > 0,
        mode,
        guaranteesDailyExecution: false,
        scheduledDay: null,
        status: "not-run",
        startedAt: null,
        finishedAt: null,
        datasetFingerprint: null,
        datasetCount: 0,
        error: null,
        reason: "No daily attempt is recorded yet; opportunistic autoscale execution cannot guarantee a daily wake.",
        phases: [],
        missedDays: 0,
      };
    }
    const first = await db.query<{ first_day: string | null; days: string[] }>(
      `SELECT min(scheduled_day)::text AS first_day,
              array_agg(DISTINCT scheduled_day::text ORDER BY scheduled_day::text) AS days
         FROM waterx_research_daily_runs WHERE interval_minutes=$1`,
      [intervalMinutes],
    );
    const firstDay = first.rows[0]?.first_day;
    const scheduledDays = Array.isArray(first.rows[0]?.days) ? first.rows[0].days : [];
    const expected = firstDay
      ? Math.max(1, Math.floor((Date.now() - Date.parse(`${firstDay}T00:00:00Z`)) / 86_400_000) + 1)
      : 0;
    return {
      configured: (activeScheduleCounts.get(mode) ?? 0) > 0,
      mode: (() => {
        const report = parseJson(row.report);
        return report && typeof report === "object" &&
            (report as Record<string, unknown>).executionMode === "leased-worker"
          ? "leased-worker" as const : "opportunistic-existing-process" as const;
      })(),
      guaranteesDailyExecution: false,
      scheduledDay: row.scheduled_day instanceof Date
        ? row.scheduled_day.toISOString().slice(0, 10) : String(row.scheduled_day),
      status: String(row.status),
      startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
      finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
      datasetFingerprint: typeof row.dataset_fingerprint === "string" ? row.dataset_fingerprint : null,
      datasetCount: Number(row.dataset_count) || 0,
      error: typeof row.error === "string" ? row.error : null,
      reason: typeof row.reason === "string" ? row.reason : null,
      phases: (parseJson(row.phases) as { status: string; at: string }[] | null) ?? [],
      missedDays: Math.max(0, expected - scheduledDays.length),
    };
  } catch (error) {
    if (isMissingSchema(error))
      return unavailableDaily(intervalMinutes, mode, "Research schema is not applied.");
    throw error;
  }
}

export function startResearchSchedule(options: {
  mode?: ResearchDailyJob["mode"];
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  db?: ResearchTrainingQueryable;
  onResult?: (result: RunResearchTrainingResult) => void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
} = {}): () => void {
  const mode = options.mode ?? "opportunistic-existing-process";
  const schedule = options.setInterval ?? setInterval;
  const unschedule = options.clearInterval ?? clearInterval;
  if (mode === "leased-worker" && !options.db)
    throw new Error("Leased research schedule requires the existing collector's database session.");
  activeScheduleCounts.set(mode, (activeScheduleCounts.get(mode) ?? 0) + 1);
  let stopped = false;
  let active: Promise<void> | undefined;
  const run = () => {
    if (stopped || active) return;
    active = (async () => {
      const db = options.db ?? POOL;
      if (!process.env.DATABASE_URL && !options.db) return;
      for (const interval of [5, 15] as const) {
        if (stopped) return;
        try {
          const result = await runResearchTrainingDay(db, interval, {
            onError: options.onError,
            executionMode: mode,
          });
          options.onResult?.(result);
        } catch (error) {
          options.onError?.(error);
          console.error("[waterx-research] daily shadow evaluation failed closed:",
            error instanceof Error ? error.message : "Unknown error.");
        }
      }
    })().finally(() => { active = undefined; });
  };
  const timer = schedule(run, Math.max(60_000, options.intervalMs ?? TRAINING_INTERVAL_MS));
  timer.unref?.();
  // Startup wake remains bounded/idempotent. A sleeping autoscale app cannot
  // make up missed execution; status reporting never claims it can.
  run();
  return () => {
    stopped = true;
    const remaining = (activeScheduleCounts.get(mode) ?? 1) - 1;
    if (remaining > 0) activeScheduleCounts.set(mode, remaining);
    else activeScheduleCounts.delete(mode);
    unschedule(timer);
    void active?.catch(error => options.onError?.(error));
  };
}
