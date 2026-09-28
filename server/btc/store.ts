import pg from "pg";
import { createHash } from "node:crypto";
import type { Market } from "./source";
import { classifySettlement, primaryDecisionWindow, snapshotBucketWidthMs } from "./policy";
import {
  BTC_FEATURE_SCHEMA,
  inferBtcArtifact,
  parseBtcArtifact,
  type BtcArtifact,
} from "./artifact";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const COLLECTOR_LOCK = "492886777169";
const PRIMARY_CAPTURE_LOCK = "492886777170";
const TRAINING_LOCK = "492886777171";
type PipelineErrorStage = "provider" | "capture" | "model" | "settlement" | "persistence" | "collector";

export class ShadowInferenceError extends Error {
  constructor(message: string, readonly report = true) {
    super(message);
    this.name = "ShadowInferenceError";
  }
}

export async function inferWithShadowFallback<T>(
  inference: () => Promise<T>,
): Promise<{ result: T | null; error: string | null; report: boolean }> {
  try {
    return { result: await inference(), error: null, report: false };
  } catch (error) {
    if (!(error instanceof ShadowInferenceError)) throw error;
    return { result: null, error: error.message, report: error.report };
  }
}

type CachedShadowArtifact = {
  version: string;
  artifact: Readonly<BtcArtifact> | null;
  error: string | null;
  reported: boolean;
};
let cachedShadowArtifact: CachedShadowArtifact | null = null;
const reportedInferenceErrors = new Set<string>();

// Independent PostgreSQL session locks coordinate collector, targeted capture,
// and training work across replicas; each lock is released if its process dies.
export async function withCollectorLease(
  work: () => Promise<void>, stage: "collector" | "primary" | "training" = "collector",
): Promise<boolean> {
  const client = await pool.connect();
  let discard = false;
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(${stage === "primary" ? PRIMARY_CAPTURE_LOCK
        : stage === "training" ? TRAINING_LOCK : COLLECTOR_LOCK}) AS acquired`);
    if (!rows[0]?.acquired) return false;
    try {
      await work();
      return true;
    } finally {
      try {
        const unlocked = await client.query<{ released: boolean }>(
          `SELECT pg_advisory_unlock(${stage === "primary" ? PRIMARY_CAPTURE_LOCK
            : stage === "training" ? TRAINING_LOCK : COLLECTOR_LOCK}) AS released`);
        if (!unlocked.rows[0]?.released) throw new Error("Collector advisory lock was not released");
      } catch (error) {
        discard = true;
        throw error;
      }
    }
  } finally {
    client.release(discard);
  }
}

export function snapshotIdForObservation(roundId: string, observedAtMs: number, expiryMs: number): string {
  const bucketWidthMs = snapshotBucketWidthMs(observedAtMs, expiryMs);
  const bucket = Math.floor(observedAtMs / bucketWidthMs);
  const identity = bucketWidthMs === 15_000
    ? `${roundId}:${bucket}`
    : `${roundId}:primary-3s:${bucket}`;
  return createHash("sha256").update(identity).digest("hex");
}

export async function initializeStore() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for prospective evidence capture");
  // Schema is managed in development and reviewed by Replit Publish for production.
  await pool.query("SELECT id FROM btc_predict_rounds LIMIT 0");
  await pool.query("SELECT id FROM btc_predict_predictions LIMIT 0");
}
export async function saveRound(m: Market, observedAt: string) {
  await pool.query(`INSERT INTO btc_predict_rounds
    (id,expiry_ms,start_ms,reference_price,first_seen_at,last_seen_at,cadence_evidence,source)
    VALUES ($1,$2,$3,$4,$5,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET
    last_seen_at=EXCLUDED.last_seen_at,
    reference_price=COALESCE(btc_predict_rounds.reference_price, EXCLUDED.reference_price)`,
    [m.id,m.expiryMs,m.startMs,m.referencePrice,observedAt,m.cadenceEvidence,"DeepBook Predict mainnet SDK read.markets"]);
}
async function saveSnapshot(client: pg.PoolClient, m: Market, raw: unknown, observedAt: string,
  quote: { up: number; down: number } | null,
  comparison: { price: number; asOf: string } | null) {
  if (Date.parse(observedAt) >= m.expiryMs) return null;
  const id = snapshotIdForObservation(m.id, Date.parse(observedAt), m.expiryMs);
  const { rows } = await client.query<{ id: string }>(`INSERT INTO btc_predict_snapshots
    (id,round_id,observed_at,raw,indicative_up,indicative_down,comparison_price,comparison_at,source)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
    WHERE now() < to_timestamp($10/1000.0)
    ON CONFLICT (id) DO NOTHING RETURNING id`,
    [id,m.id,observedAt,JSON.stringify(raw),quote?.up ?? null,quote?.down ?? null,
      comparison?.price ?? null,comparison?.asOf ?? null,"DeepBook Predict mainnet SDK + Coinbase Exchange comparison",m.expiryMs]);
  return rows[0]?.id ?? null;
}

async function shadowInference(client: pg.PoolClient, m: Market, observedAt: string,
  quote: { up: number; asOf: string; source: string }): Promise<{
    artifact: Readonly<BtcArtifact>;
    rawProbabilityUp: number;
    probabilityUp: number;
    rawLogit: number;
    calibratedLogit: number;
    featureSources: Record<string, unknown>;
  } | null> {
  const { rows: models } = await client.query<{ version: string }>(`SELECT version
    FROM btc_predict_models WHERE status='SHADOW' AND parameters ? 'artifact'
    ORDER BY created_at DESC LIMIT 1`);
  if (!models[0]) return null;
  let cached = cachedShadowArtifact;
  if (!cached || cached.version !== models[0].version) {
    const { rows: parameterRows } = await client.query<{ parameters: unknown }>(
      `SELECT parameters FROM btc_predict_models WHERE version=$1 AND status='SHADOW'`,
      [models[0].version]);
    if (!parameterRows[0]) return null;
    try {
      const parameters = typeof parameterRows[0].parameters === "string"
        ? JSON.parse(parameterRows[0].parameters) : parameterRows[0].parameters;
      if (!parameters || typeof parameters !== "object" || !("artifact" in parameters))
        throw new Error("Latest shadow model parameters do not contain an artifact");
      const artifact = parseBtcArtifact(JSON.stringify((parameters as { artifact: unknown }).artifact));
      if (artifact.modelVersion !== models[0].version)
        throw new Error("Artifact version does not match its immutable model row");
      cached = { version: models[0].version, artifact, error: null, reported: false };
    } catch (error) {
      cached = {
        version: models[0].version,
        artifact: null,
        error: error instanceof Error ? error.message : "Invalid shadow model artifact",
        reported: false,
      };
    }
    cachedShadowArtifact = cached;
  }
  if (cached.error) {
    const report = !cached.reported;
    cached.reported = true;
    throw new ShadowInferenceError(`Shadow artifact ${cached.version} quarantined: ${cached.error}`, report);
  }
  const artifact = cached.artifact!;
  const decisionTimeMs = Date.parse(observedAt);
  const quoteTimeMs = Date.parse(quote.asOf);
  if (!Number.isFinite(quoteTimeMs) || quoteTimeMs > decisionTimeMs)
    throw new Error("Indicative observation timestamp is later than decision time");
  if (decisionTimeMs - quoteTimeMs > 14_000 || m.mintPaused ||
    m.startMs > decisionTimeMs || !m.referencePrice || m.referencePrice <= 0)
    return null;

  const { rows: currentRows } = await client.query<{
    comparison_price: string; comparison_at: Date;
  }>(`SELECT comparison_price,comparison_at FROM btc_predict_snapshots
      WHERE observed_at <= $1 AND comparison_at <= $1
        AND comparison_at >= $1::timestamptz-interval '20 seconds'
        AND comparison_price IS NOT NULL
      ORDER BY comparison_at DESC,observed_at DESC LIMIT 1`, [observedAt]);
  let comparisonReturn: number | null = null;
  let comparisonReturnAtMs = decisionTimeMs;
  if (currentRows[0]) {
    const current = currentRows[0];
    const { rows: priorRows } = await client.query<{ comparison_price: string }>(`SELECT comparison_price
      FROM btc_predict_snapshots WHERE observed_at <= $1
        AND comparison_at <= $2::timestamptz-interval '20 seconds'
        AND comparison_at >= $2::timestamptz-interval '90 seconds'
        AND comparison_price IS NOT NULL
      ORDER BY comparison_at DESC,observed_at DESC LIMIT 1`,
    [observedAt,current.comparison_at]);
    if (priorRows[0]) {
      comparisonReturn = Number(current.comparison_price) / Number(priorRows[0].comparison_price) - 1;
      comparisonReturnAtMs = new Date(current.comparison_at).getTime();
    }
  }
  const { rows: volatilityRows } = await client.query<{
    vol: string | null; latest_at: Date | null; observations: number;
  }>(`WITH bounded AS (
      SELECT comparison_price,comparison_at FROM btc_predict_snapshots
      WHERE observed_at <= $1 AND comparison_at <= $1
        AND comparison_at >= $1::timestamptz-interval '90 seconds'
        AND comparison_price IS NOT NULL
    ), returns AS (
      SELECT ln(comparison_price / lag(comparison_price) OVER (ORDER BY comparison_at)) AS ret,
        comparison_at FROM bounded
    )
    SELECT CASE WHEN count(ret)>=4 THEN stddev_samp(ret) END AS vol,
      max(comparison_at) AS latest_at,count(ret)::int AS observations FROM returns`,
  [observedAt]);
  const volRow = volatilityRows[0];
  const realizedVolatility = volRow?.vol == null || !volRow.latest_at ||
    decisionTimeMs - new Date(volRow.latest_at).getTime() > 20_000
    ? null : Number(volRow.vol);
  const realizedVolatilityAtMs = volRow?.latest_at ? new Date(volRow.latest_at).getTime() : decisionTimeMs;
  const remainingSeconds = (m.expiryMs - decisionTimeMs) / 1000;
  const features = {
    indicativeUp: { value: quote.up, atMs: quoteTimeMs },
    remainingSeconds: { value: remainingSeconds, atMs: decisionTimeMs },
    comparisonReturn: { value: comparisonReturn, atMs: comparisonReturnAtMs },
    realizedVolatility: { value: realizedVolatility, atMs: realizedVolatilityAtMs },
  };
  let inference;
  try {
    inference = inferBtcArtifact(artifact, { decisionTimeMs, features });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shadow inference validation failed";
    const key = `${cached.version}:${message}`;
    const report = !reportedInferenceErrors.has(key);
    reportedInferenceErrors.add(key);
    throw new ShadowInferenceError(message, report);
  }
  return {
    artifact,
    rawProbabilityUp: inference.rawProbabilityUp,
    probabilityUp: inference.probabilityUp,
    rawLogit: inference.rawLogit,
    calibratedLogit: inference.calibratedLogit,
    featureSources: {
      modelVersion: artifact.modelVersion,
      artifactStatus: artifact.status,
      rawFeatures: features,
      featureNames: inference.featureNames,
      sourceTimestamps: {
        indicativeUp: new Date(quoteTimeMs).toISOString(),
        remainingSeconds: new Date(decisionTimeMs).toISOString(),
        comparisonReturn: comparisonReturn === null ? null : new Date(comparisonReturnAtMs).toISOString(),
        realizedVolatility: realizedVolatility === null ? null : new Date(realizedVolatilityAtMs).toISOString(),
      },
      featureSchema: BTC_FEATURE_SCHEMA,
      comparisonRole: "comparison-only; not oracle distance",
      comparisonVolatilityObservations: volRow?.observations ?? 0,
      provenance: artifact.provenance,
    },
  };
}

async function savePrediction(client: pg.PoolClient, m: Market, snapshotId: string, observedAt: string,
  quote: { up: number; asOf: string; source: string } | null,
  comparison: { asOf: string; source: string } | null): Promise<{
    inserted: boolean; modelError: string | null; reportModelError: boolean;
  }> {
  const remainingSeconds = (m.expiryMs - Date.parse(observedAt)) / 1000;
  if (remainingSeconds <= 0) return { inserted: false, modelError: null, reportModelError: false };
  const primaryWindow = primaryDecisionWindow(Date.parse(observedAt),m.expiryMs);
  const shadowResult = primaryWindow && quote
    ? await inferWithShadowFallback(() => shadowInference(client,m,observedAt,quote))
    : { result: null, error: null, report: false };
  const shadow = shadowResult.result;
  const reason = !m.referencePrice ? "On-chain reference not available."
    : !quote ? "Indicative source unavailable; no calibrated forecast."
    : shadow ? "Shadow-only artifact probability recorded for prospective evaluation; no promoted forecast or executable economics."
    : "No promoted, independently validated calibrated forecast or verified economic terms.";
  const { rowCount } = await client.query(`INSERT INTO btc_predict_predictions
    (id,round_id,snapshot_id,observed_at,remaining_seconds,indicative_up,
     forecast_up,model_version,action,reason,feature_sources,primary_window)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,'HOLD',$9,$10,$11
     WHERE now() < to_timestamp($12/1000.0)
    ON CONFLICT (snapshot_id) DO NOTHING`,
    [createHash("sha256").update(snapshotId + ":forecast:v1").digest("hex"),m.id,snapshotId,
      observedAt,remainingSeconds,quote?.up ?? null,shadow?.probabilityUp ?? null,
      shadow?.artifact.modelVersion ?? "NO_PROMOTED_MODEL",reason,JSON.stringify({
        market: "DeepBook Predict read.markets", reference: m.referencePrice,
        indicative: quote ? { source: quote.source, asOf: quote.asOf } : null,
        comparison: comparison ? { source: comparison.source, asOf: comparison.asOf, role: "comparison-only" } : null,
        cadence: m.cadenceEvidence,
        shadow: shadow ? {
          indicativeProbabilityUp: quote!.up,
          rawProbabilityUp: shadow.rawProbabilityUp,
          calibratedProbabilityUp: shadow.probabilityUp,
          rawLogit: shadow.rawLogit,
          calibratedLogit: shadow.calibratedLogit,
          ...shadow.featureSources,
        } : null,
      }),primaryWindow,m.expiryMs]);
  return { inserted: rowCount === 1, modelError: shadowResult.error,
    reportModelError: shadowResult.report };
}

export async function saveEvidence(m: Market, raw: unknown, observedAt: string,
  quote: { up: number; down: number; asOf: string; source: string } | null,
  comparison: { price: number; asOf: string; source: string } | null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const snapshotId = await saveSnapshot(client,m,raw,observedAt,quote,comparison);
    let prediction: { inserted: boolean; modelError: string | null; reportModelError: boolean } | null = null;
    if (snapshotId) {
      prediction = await savePrediction(client,m,snapshotId,observedAt,quote,comparison);
      if (!prediction.inserted) throw new Error("Evidence expired before its prediction could be committed");
    }
    await client.query("COMMIT");
    if (prediction?.modelError && prediction.reportModelError) {
      try {
        await recordPipelineError("model", prediction.modelError);
      } catch (error) {
        console.error("[btc] failed to persist shadow model error", error);
      }
    }
    return snapshotId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordPipelineError(stage: PipelineErrorStage, message: string) {
  const safe = message.slice(0, 240);
  await pool.query(`INSERT INTO btc_predict_provider_errors(message) VALUES ($1)`,
    [`[${stage}] ${safe}`]);
}

export async function markHeartbeat(input: {
  marketAt?: string; roundId?: string; error?: string; stage?: PipelineErrorStage;
}) {
  const now = new Date().toISOString();
  const stage = input.stage ?? "provider";
  await pool.query(`INSERT INTO btc_predict_worker_state
    (name,last_tick_at,last_market_at,last_error_at,last_error,provider_failures,last_round_id)
    VALUES ('collector',$1,$2,$3,$4,$5,$6)
    ON CONFLICT (name) DO UPDATE SET last_tick_at=EXCLUDED.last_tick_at,
      last_market_at=COALESCE(EXCLUDED.last_market_at,btc_predict_worker_state.last_market_at),
      last_error_at=COALESCE(EXCLUDED.last_error_at,btc_predict_worker_state.last_error_at),
      last_error=EXCLUDED.last_error,
      provider_failures=btc_predict_worker_state.provider_failures+EXCLUDED.provider_failures,
      last_round_id=COALESCE(EXCLUDED.last_round_id,btc_predict_worker_state.last_round_id)`,
    [now,input.marketAt ?? null,input.error ? now : null,input.error ?? null,
      input.error && stage === "provider" ? 1 : 0,input.roundId ?? null]);
  if (input.error)
    await recordPipelineError(stage, input.error);
}
export async function pendingSettlements(limit = 4) {
  const { rows } = await pool.query<{ id: string; expiry_ms: string; reference_price: string | null }>(
    `SELECT id,expiry_ms,reference_price FROM btc_predict_rounds
     WHERE settlement_price IS NULL AND expiry_ms < $1
       AND (last_attempt_at IS NULL OR last_attempt_at < now()-interval '2 minutes')
     ORDER BY last_attempt_at ASC NULLS FIRST, expiry_ms ASC LIMIT $2`,
    [Date.now() - 5_000,limit]);
  return rows;
}
export async function markSettlementAttempt(id: string) {
  await pool.query("UPDATE btc_predict_rounds SET last_attempt_at=now() WHERE id=$1", [id]);
}
export async function recordSettlement(id: string, price: number, reference: number | null) {
  // Reference must have been observed on-chain before an UP/DOWN label is assigned.
  const { outcome, quality } = classifySettlement(price,reference);
  await pool.query(`UPDATE btc_predict_rounds SET settlement_price=$2, settlement_verified_at=now(), outcome=$3,
    quality=$4 WHERE id=$1 AND settlement_price IS NULL`,
    [id,price,outcome,quality]);
  await pool.query(`UPDATE btc_predict_worker_state SET last_settlement_at=now() WHERE name='collector'`);
}
export async function scoreSettled() {
  const { rowCount } = await pool.query(`INSERT INTO btc_predict_scores
    (prediction_id,round_id,outcome,kind,brier,log_loss)
    SELECT DISTINCT ON (p.round_id) p.id,p.round_id,r.outcome,
      CASE WHEN p.model_version LIKE 'btc-shadow-logistic-v1-%' AND p.forecast_up IS NOT NULL
        THEN 'SHADOW_FORECAST' ELSE 'ONCHAIN_INDICATIVE_BASELINE' END,
      power((CASE WHEN p.model_version LIKE 'btc-shadow-logistic-v1-%' AND p.forecast_up IS NOT NULL
        THEN p.forecast_up ELSE p.indicative_up END) - CASE WHEN r.outcome='UP' THEN 1 ELSE 0 END,2),
      -ln(GREATEST(.000000001,CASE WHEN r.outcome='UP'
        THEN CASE WHEN p.model_version LIKE 'btc-shadow-logistic-v1-%' AND p.forecast_up IS NOT NULL
          THEN p.forecast_up ELSE p.indicative_up END
        ELSE 1-CASE WHEN p.model_version LIKE 'btc-shadow-logistic-v1-%' AND p.forecast_up IS NOT NULL
          THEN p.forecast_up ELSE p.indicative_up END END))
    FROM btc_predict_predictions p
    JOIN btc_predict_rounds r ON r.id=p.round_id
    WHERE p.primary_window AND p.indicative_up IS NOT NULL
      AND (p.model_version NOT LIKE 'btc-shadow-logistic-v1-%' OR p.forecast_up BETWEEN 0 AND 1)
      AND p.observed_at < to_timestamp(r.expiry_ms/1000.0)
      AND p.captured_at < to_timestamp(r.expiry_ms/1000.0)
      AND r.quality='VERIFIED_SETTLEMENT' AND r.settlement_verified_at IS NOT NULL
      AND r.settlement_verified_at >= to_timestamp(r.expiry_ms/1000.0)
      AND r.outcome IN ('UP','DOWN')
    ORDER BY p.round_id,p.observed_at ASC,p.id ASC
    ON CONFLICT (prediction_id) DO NOTHING`);
  if (rowCount && rowCount > 0) {
    await pool.query(`UPDATE btc_predict_worker_state SET last_evaluation_at=now() WHERE name='collector'`);
  }
  return rowCount ?? 0;
}
export async function prospectiveScores() {
  const { rows } = await pool.query(`SELECT kind,
    count(*)::int AS count,avg(brier) AS brier,avg(log_loss) AS "logLoss"
    FROM btc_predict_scores s JOIN btc_predict_rounds r ON r.id=s.round_id
    WHERE r.quality='VERIFIED_SETTLEMENT' AND r.settlement_verified_at IS NOT NULL
      AND r.settlement_verified_at >= to_timestamp(r.expiry_ms/1000.0)
    GROUP BY kind ORDER BY kind`);
  const persisted = rows.map((row: any) => ({
    name: row.kind === "ONCHAIN_INDICATIVE_BASELINE" ?
      "On-chain indicative (prospective baseline; not a fill)" : String(row.kind),
    count: Number(row.count), brier: Number(row.brier), logLoss: Number(row.logLoss),
  }));
  const { rows: [shadowBaseline] } = await pool.query(`SELECT
    count(*)::int AS count,
    avg(power(p.indicative_up - CASE WHEN r.outcome='UP' THEN 1 ELSE 0 END,2)) AS brier,
    avg(-ln(GREATEST(.000000001,CASE WHEN r.outcome='UP' THEN p.indicative_up ELSE 1-p.indicative_up END))) AS "logLoss"
    FROM btc_predict_predictions p
    JOIN btc_predict_scores s ON s.prediction_id=p.id AND s.kind='SHADOW_FORECAST'
    JOIN btc_predict_rounds r ON r.id=p.round_id
    WHERE p.primary_window AND p.indicative_up BETWEEN 0 AND 1
      AND p.forecast_up BETWEEN 0 AND 1
      AND p.observed_at < to_timestamp(r.expiry_ms/1000.0)
      AND p.captured_at < to_timestamp(r.expiry_ms/1000.0)
      AND r.quality='VERIFIED_SETTLEMENT' AND r.settlement_verified_at IS NOT NULL
      AND r.settlement_verified_at >= to_timestamp(r.expiry_ms/1000.0)
      AND r.outcome IN ('UP','DOWN')`);
  if (Number(shadowBaseline?.count ?? 0) > 0) persisted.push({
    name: "On-chain indicative on shadow-forecast rounds (read-only prospective baseline; not a second score)",
    count: Number(shadowBaseline.count),
    brier: Number(shadowBaseline.brier),
    logLoss: Number(shadowBaseline.logLoss),
  });
  return persisted;
}
export async function history(page = 1, pageSize = 30) {
  const { rows } = await pool.query(`SELECT r.id,r.expiry_ms AS "expiryMs",r.reference_price AS "referencePrice",
    r.settlement_price AS "settlementPrice",r.outcome,r.quality,
    r.first_seen_at AS "firstSeenAt",r.last_seen_at AS "lastSeenAt",
    (SELECT COUNT(*)::int FROM btc_predict_snapshots s WHERE s.round_id=r.id) AS "quoteCount"
    FROM btc_predict_rounds r ORDER BY r.expiry_ms DESC LIMIT $1 OFFSET $2`,
    [pageSize,(page-1)*pageSize]);
  return rows.map((r: any) => ({
    ...r, expiryMs: Number(r.expiryMs), referencePrice: r.referencePrice === null ? null : Number(r.referencePrice),
    settlementPrice: r.settlementPrice === null ? null : Number(r.settlementPrice),
    quoteCount: Number(r.quoteCount),
  }));
}
export async function chartPoints() {
  const { rows } = await pool.query(`SELECT observed_at,comparison_at,comparison_price FROM btc_predict_snapshots
    WHERE comparison_price IS NOT NULL AND observed_at > now()-interval '5 minutes'
    ORDER BY observed_at DESC LIMIT 90`);
  return rows.reverse().map((r: any) => ({
    at: new Date(r.observed_at).getTime(), price: Number(r.comparison_price),
    sourceAt: r.comparison_at ? new Date(r.comparison_at).toISOString() : null,
  }));
}
export async function evaluationRows() {
  const { rows } = await pool.query(`SELECT r.id,r.expiry_ms,r.outcome,s.indicative_up,s.observed_at FROM btc_predict_rounds r
    JOIN LATERAL (SELECT indicative_up,observed_at FROM btc_predict_snapshots
      WHERE round_id=r.id AND indicative_up IS NOT NULL
        AND observed_at < to_timestamp(r.expiry_ms/1000.0) - interval '5 seconds'
      ORDER BY observed_at ASC LIMIT 1) s ON true
    WHERE r.quality='VERIFIED_SETTLEMENT' AND r.settlement_verified_at IS NOT NULL
      AND r.settlement_verified_at >= to_timestamp(r.expiry_ms/1000.0)
      AND r.outcome IN ('UP','DOWN')
    ORDER BY r.expiry_ms ASC LIMIT 10000`);
  return rows.map((r: any) => ({ id: r.id, expiryMs: Number(r.expiry_ms), outcome: r.outcome as "UP"|"DOWN", up: Number(r.indicative_up) }));
}

export async function recentPredictions(limit = 20) {
  const { rows } = await pool.query(`SELECT p.round_id AS "roundId",p.observed_at AS "predictionAt",
    p.remaining_seconds AS "remainingSeconds",p.model_version AS "modelVersion",
    p.indicative_up AS "indicativeUp",p.forecast_up AS "calibratedUp",p.action,p.reason,
    r.outcome,r.quality,r.settlement_verified_at AS "settlementVerifiedAt",
    CASE WHEN r.settlement_verified_at IS NOT NULL
      AND r.settlement_verified_at >= to_timestamp(r.expiry_ms/1000.0)
      THEN s.scored_at END AS "evaluatedAt",
    CASE WHEN s.scored_at IS NOT NULL AND r.settlement_verified_at IS NOT NULL
      THEN extract(epoch from s.scored_at-r.settlement_verified_at) END AS "evaluationLatencySeconds",
    (s.prediction_id IS NOT NULL AND r.settlement_verified_at IS NOT NULL
      AND r.settlement_verified_at >= to_timestamp(r.expiry_ms/1000.0)) AS evaluated
    FROM btc_predict_predictions p
    JOIN btc_predict_rounds r ON r.id=p.round_id
    LEFT JOIN btc_predict_scores s ON s.prediction_id=p.id
    WHERE p.primary_window ORDER BY p.observed_at DESC LIMIT $1`,[limit]);
  return rows.map((row: any) => ({
    ...row,predictionAt: new Date(row.predictionAt).toISOString(),
    remainingSeconds: Number(row.remainingSeconds),
    indicativeUp: row.indicativeUp === null ? null : Number(row.indicativeUp),
    calibratedUp: row.calibratedUp === null ? null : Number(row.calibratedUp),
  }));
}
export async function healthStats() {
  const { rows: [counts] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM btc_predict_rounds) AS observed,
    (SELECT count(*)::int FROM btc_predict_rounds
      WHERE quality='VERIFIED_SETTLEMENT' AND settlement_verified_at IS NOT NULL
        AND settlement_verified_at >= to_timestamp(expiry_ms/1000.0)) AS settled,
    (SELECT count(*)::int FROM btc_predict_rounds
      WHERE quality='VERIFIED_SETTLEMENT' AND settlement_verified_at IS NULL) AS "legacyUnstamped",
    (SELECT count(*)::int FROM btc_predict_rounds
      WHERE quality='MISSING_REFERENCE') AS "missingReferenceSettlements",
    (SELECT count(*)::int FROM btc_predict_rounds
      WHERE quality='EQUALITY_RULE_UNVERIFIED') AS "equalityUnverifiedSettlements",
    (SELECT count(DISTINCT r.id)::int FROM btc_predict_rounds r
      JOIN btc_predict_snapshots s ON s.round_id=r.id
      WHERE r.quality='VERIFIED_SETTLEMENT' AND r.settlement_verified_at IS NOT NULL
        AND r.settlement_verified_at >= to_timestamp(r.expiry_ms/1000.0)
        AND r.outcome IN ('UP','DOWN')
        AND s.indicative_up BETWEEN 0 AND 1
        AND s.observed_at BETWEEN to_timestamp(r.expiry_ms/1000.0)-interval '45 seconds'
          AND to_timestamp(r.expiry_ms/1000.0)-interval '30 seconds') AS eligible,
    (SELECT count(DISTINCT round_id)::int FROM btc_predict_predictions
      WHERE primary_window AND indicative_up IS NOT NULL) AS "prospectiveEligible",
    (SELECT count(*)::int FROM btc_predict_scores s
      JOIN btc_predict_rounds r ON r.id=s.round_id
      WHERE r.quality='VERIFIED_SETTLEMENT' AND r.settlement_verified_at IS NOT NULL
        AND r.settlement_verified_at >= to_timestamp(r.expiry_ms/1000.0)) AS evaluated,
    (SELECT count(*)::int FROM btc_predict_scores s
      JOIN btc_predict_rounds r ON r.id=s.round_id
      WHERE r.settlement_verified_at IS NULL) AS "legacyScores",
    (SELECT count(*)::int FROM btc_predict_rounds
      WHERE quality <> 'VERIFIED_SETTLEMENT' OR settlement_verified_at IS NULL
        OR settlement_verified_at < to_timestamp(expiry_ms/1000.0)) AS unresolved,
    (SELECT count(*)::int FROM btc_predict_snapshots) AS "quoteSnapshots",
    (SELECT count(*)::int FROM btc_predict_rounds WHERE expiry_ms >= $1) AS "observed24h",
    (SELECT count(*)::int FROM btc_predict_rounds WHERE expiry_ms >= $2) AS "observed7d",
    (SELECT max(observed_at) FROM btc_predict_snapshots WHERE indicative_up IS NOT NULL) AS "lastQuoteAt",
    (SELECT max(observed_at) FROM btc_predict_snapshots) AS "lastObservationAt",
    (SELECT min(expiry_ms) FROM btc_predict_rounds) AS earliest,
    (SELECT max(expiry_ms) FROM btc_predict_rounds) AS latest`,
    [Date.now()-86_400_000,Date.now()-7*86_400_000]);
  const { rows: gaps } = await pool.query(`WITH times AS (
    SELECT expiry_ms,lag(expiry_ms) OVER (ORDER BY expiry_ms) AS previous
    FROM btc_predict_rounds WHERE expiry_ms > $1
  ) SELECT previous+60000 AS start,expiry_ms-60000 AS "end",
    ((expiry_ms-previous)/60000-1)::int AS minutes FROM times
    WHERE previous IS NOT NULL AND expiry_ms-previous > 60000
    ORDER BY expiry_ms DESC LIMIT 30`,[Date.now()-7*86_400_000]);
  const { rows: [pipeline] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM btc_predict_snapshots) AS "snapshotCount",
    (SELECT count(*)::int FROM btc_predict_snapshots WHERE indicative_up BETWEEN 0 AND 1) AS "validProbabilitySnapshots",
    (SELECT count(*)::int FROM btc_predict_predictions WHERE primary_window) AS "primaryAttempts",
    (SELECT count(*)::int FROM btc_predict_predictions
      WHERE primary_window AND indicative_up BETWEEN 0 AND 1) AS "qualifiedPrimaryPredictions",
    (SELECT count(*)::int FROM btc_predict_predictions
      WHERE primary_window AND indicative_up IS NULL) AS "missingProbabilityPredictions",
    (SELECT count(*)::int FROM btc_predict_predictions
      WHERE primary_window AND (feature_sources->'reference' IS NULL OR feature_sources->'reference'='null'::jsonb)
    ) AS "missingReferencePredictions",
    (SELECT count(*)::int FROM btc_predict_predictions p
      JOIN btc_predict_snapshots s ON s.id=p.snapshot_id
      WHERE p.round_id<>s.round_id) AS "wrongRoundPredictions",
    (SELECT count(*)::int FROM btc_predict_predictions p
      WHERE p.primary_window AND p.indicative_up BETWEEN 0 AND 1
        AND (p.feature_sources#>>'{indicative,asOf}')::timestamptz < p.observed_at-interval '14 seconds'
    ) AS "staleInputPredictions",
    (SELECT max(observed_at) FROM btc_predict_snapshots) AS "lastSnapshotAt",
    (SELECT max(observed_at) FROM btc_predict_predictions WHERE primary_window) AS "lastPrimaryAttemptAt",
    (SELECT max(observed_at) FROM btc_predict_predictions
      WHERE primary_window AND indicative_up BETWEEN 0 AND 1) AS "lastQualifiedPredictionAt",
    (SELECT max(scored_at) FROM btc_predict_scores) AS "lastScoreAt",
    (SELECT count(DISTINCT p.round_id)::int FROM btc_predict_predictions p
      JOIN btc_predict_rounds r ON r.id=p.round_id
      WHERE p.primary_window AND p.indicative_up BETWEEN 0 AND 1
        AND r.quality='VERIFIED_SETTLEMENT' AND r.settlement_verified_at >= to_timestamp(r.expiry_ms/1000.0)
        AND r.outcome IN ('UP','DOWN')
        AND NOT EXISTS (SELECT 1 FROM btc_predict_scores s WHERE s.round_id=p.round_id)
    ) AS "qualifiedUnscoredBacklog",
    (SELECT min(r.settlement_verified_at) FROM btc_predict_predictions p
      JOIN btc_predict_rounds r ON r.id=p.round_id
      WHERE p.primary_window AND p.indicative_up BETWEEN 0 AND 1
        AND r.quality='VERIFIED_SETTLEMENT' AND r.settlement_verified_at >= to_timestamp(r.expiry_ms/1000.0)
        AND r.outcome IN ('UP','DOWN')
        AND NOT EXISTS (SELECT 1 FROM btc_predict_scores s WHERE s.round_id=p.round_id)
    ) AS "oldestUnscoredAt",
    (SELECT count(*)::int FROM btc_predict_predictions p
      WHERE p.primary_window AND p.observed_at >= now()-interval '15 minutes') AS "primaryAttempts15m",
    (SELECT count(*)::int FROM btc_predict_predictions p
      WHERE p.primary_window AND p.indicative_up BETWEEN 0 AND 1
        AND p.observed_at >= now()-interval '15 minutes') AS "qualifiedPredictions15m",
    (SELECT count(DISTINCT p.round_id)::int FROM btc_predict_predictions p
      JOIN btc_predict_rounds r ON r.id=p.round_id
      WHERE p.primary_window AND p.indicative_up BETWEEN 0 AND 1
        AND r.expiry_ms >= (extract(epoch FROM now()-interval '15 minutes')*1000)::bigint
        AND r.expiry_ms <= (extract(epoch FROM now())*1000)::bigint
        AND r.reference_price > 0
        AND r.first_seen_at <= to_timestamp(r.expiry_ms/1000.0)-interval '30 seconds'
        AND r.last_seen_at >= to_timestamp(r.expiry_ms/1000.0)-interval '45 seconds'
    ) AS "qualifiedRounds15m",
    (SELECT count(*)::int FROM btc_predict_rounds
      WHERE settlement_verified_at >= now()-interval '15 minutes'
        AND settlement_verified_at >= to_timestamp(expiry_ms/1000.0)
        AND outcome IN ('UP','DOWN')) AS "verifiedSettlements15m",
    (SELECT count(*)::int FROM btc_predict_rounds r
      WHERE r.expiry_ms >= (extract(epoch FROM now()-interval '15 minutes')*1000)::bigint
        AND r.expiry_ms <= (extract(epoch FROM now())*1000)::bigint
        AND r.reference_price > 0
        AND r.first_seen_at <= to_timestamp(r.expiry_ms/1000.0)-interval '30 seconds'
        AND r.last_seen_at >= to_timestamp(r.expiry_ms/1000.0)-interval '45 seconds'
    ) AS "candidatePrimaryOpportunities15m",
    (SELECT avg(extract(epoch FROM (s.scored_at-r.settlement_verified_at)))
      FROM btc_predict_scores s JOIN btc_predict_rounds r ON r.id=s.round_id
      WHERE s.scored_at >= now()-interval '24 hours'
        AND r.settlement_verified_at IS NOT NULL
        AND s.scored_at >= r.settlement_verified_at) AS "meanScoreDelayAfterVerificationSeconds24h",
    (SELECT count(*)::int FROM btc_predict_rounds r
      WHERE r.settlement_verified_at >= now()-interval '15 minutes'
        AND r.settlement_verified_at >= to_timestamp(r.expiry_ms/1000.0)
        AND r.outcome IN ('UP','DOWN')
        AND NOT EXISTS (SELECT 1 FROM btc_predict_predictions p
          WHERE p.round_id=r.id AND p.primary_window)) AS "settlementsWithoutPrimary15m",
    (SELECT count(*)::int FROM btc_predict_rounds r
      WHERE r.settlement_verified_at >= now()-interval '15 minutes'
        AND r.settlement_verified_at >= to_timestamp(r.expiry_ms/1000.0)
        AND r.outcome IN ('UP','DOWN')
        AND EXISTS (SELECT 1 FROM btc_predict_predictions p
          WHERE p.round_id=r.id AND p.primary_window)
        AND NOT EXISTS (SELECT 1 FROM btc_predict_predictions p
          WHERE p.round_id=r.id AND p.primary_window AND p.indicative_up BETWEEN 0 AND 1)
    ) AS "settlementsWithoutProbability15m",
    (SELECT count(*)::int FROM btc_predict_rounds
      WHERE settlement_price IS NULL AND expiry_ms < (extract(epoch from now())*1000)::bigint - 5000
    ) AS "pendingSettlementCount",
    (SELECT min(expiry_ms) FROM btc_predict_rounds
      WHERE settlement_price IS NULL AND expiry_ms < (extract(epoch from now())*1000)::bigint - 5000
    ) AS "oldestPendingSettlementExpiry"`);
  const { rows: recentErrors } = await pool.query(`SELECT DISTINCT ON (
      COALESCE(substring(message FROM '^\\[([a-z_]+)\\]'), 'legacy'))
      message,recorded_at AS "recordedAt"
    FROM btc_predict_provider_errors
    WHERE recorded_at >= now()-interval '24 hours'
    ORDER BY COALESCE(substring(message FROM '^\\[([a-z_]+)\\]'), 'legacy'), recorded_at DESC`);
  const { rows: failureWindows } = await pool.query(`SELECT
      COALESCE(substring(message FROM '^\\[([a-z_]+)\\]'), 'legacy') AS stage,
      count(*) FILTER (WHERE recorded_at >= now()-interval '15 minutes')::int AS "last15m",
      count(*) FILTER (WHERE recorded_at >= now()-interval '1 hour')::int AS "last1h",
      count(*)::int AS "last24h"
    FROM btc_predict_provider_errors
    WHERE recorded_at >= now()-interval '24 hours'
    GROUP BY stage ORDER BY stage`);
  const { rows: [worker] } = await pool.query(`SELECT last_tick_at AS "lastTickAt",last_market_at AS "lastMarketAt",
    last_settlement_at AS "lastSettlementAt",last_evaluation_at AS "lastEvaluationAt",
    last_training_at AS "lastTrainingAt",last_error_at AS "lastErrorAt",
    last_error AS "lastError",provider_failures AS "providerFailures",last_round_id AS "lastRoundId"
    FROM btc_predict_worker_state WHERE name='collector'`);
  return {
    worker: worker ?? null, coverage: { ...counts,
      earliest: counts.earliest === null ? null : new Date(Number(counts.earliest)).toISOString(),
      latest: counts.latest === null ? null : new Date(Number(counts.latest)).toISOString(),
      missingUnknown: gaps.reduce((n: number,g: any) => n+Number(g.minutes),0),
      gaps: gaps.map((g: any) => ({
        start: new Date(Number(g.start)).toISOString(), end: new Date(Number(g.end)).toISOString(),
        minutes: Number(g.minutes),
      })),
    },
    pipeline: {
      ...pipeline,
      lastSnapshotAt: pipeline.lastSnapshotAt === null ? null : new Date(pipeline.lastSnapshotAt).toISOString(),
      lastPrimaryAttemptAt: pipeline.lastPrimaryAttemptAt === null ? null : new Date(pipeline.lastPrimaryAttemptAt).toISOString(),
      lastQualifiedPredictionAt: pipeline.lastQualifiedPredictionAt === null ? null : new Date(pipeline.lastQualifiedPredictionAt).toISOString(),
      lastScoreAt: pipeline.lastScoreAt === null ? null : new Date(pipeline.lastScoreAt).toISOString(),
      oldestUnscoredAt: pipeline.oldestUnscoredAt === null ? null : new Date(pipeline.oldestUnscoredAt).toISOString(),
      oldestPendingSettlementExpiry: pipeline.oldestPendingSettlementExpiry === null
        ? null : Number(pipeline.oldestPendingSettlementExpiry),
      meanScoreDelayAfterVerificationSeconds24h:
        pipeline.meanScoreDelayAfterVerificationSeconds24h === null
          ? null : Number(pipeline.meanScoreDelayAfterVerificationSeconds24h),
      failureWindows: failureWindows.map((window: any) => ({
        stage: String(window.stage), last15m: Number(window.last15m),
        last1h: Number(window.last1h), last24h: Number(window.last24h),
      })),
      recentErrors: recentErrors.map((error: any) => ({
        message: String(error.message), recordedAt: new Date(error.recordedAt).toISOString(),
      })),
    },
  };
}

export async function modelRows() {
  // One fixed, pre-expiry decision window per round; never sample later odds.
  const { rows } = await pool.query(`SELECT DISTINCT ON (r.id)
    r.id,r.expiry_ms,r.outcome,r.settlement_verified_at,s.observed_at,s.indicative_up,
    CASE WHEN s.comparison_at BETWEEN s.observed_at-interval '20 seconds' AND s.observed_at
      THEN s.comparison_price END AS comparison_price,
    prev.comparison_price AS prior_price,
    volatility.vol AS realized_volatility
    FROM btc_predict_rounds r
    JOIN btc_predict_snapshots s ON s.round_id=r.id
      AND s.observed_at BETWEEN to_timestamp(r.expiry_ms/1000.0)-interval '45 seconds'
                            AND to_timestamp(r.expiry_ms/1000.0)-interval '30 seconds'
      AND s.indicative_up BETWEEN 0 AND 1
    LEFT JOIN LATERAL (
       SELECT comparison_price FROM btc_predict_snapshots
      WHERE observed_at <= s.observed_at-interval '20 seconds'
        AND observed_at >= s.observed_at-interval '90 seconds'
         AND comparison_at BETWEEN s.observed_at-interval '90 seconds'
           AND s.observed_at-interval '20 seconds'
        AND comparison_price IS NOT NULL
      ORDER BY observed_at DESC LIMIT 1
    ) prev ON true
    LEFT JOIN LATERAL (
      SELECT CASE WHEN count(*)>=4 THEN stddev_samp(ret) ELSE NULL END AS vol FROM (
        SELECT ln(comparison_price / lag(comparison_price)
          OVER (ORDER BY observed_at)) AS ret FROM btc_predict_snapshots
        WHERE comparison_price IS NOT NULL
          AND comparison_at BETWEEN s.observed_at-interval '90 seconds' AND s.observed_at
          AND observed_at BETWEEN s.observed_at-interval '90 seconds' AND s.observed_at
      ) returns WHERE ret IS NOT NULL
    ) volatility ON true
    WHERE r.quality='VERIFIED_SETTLEMENT' AND r.settlement_verified_at IS NOT NULL
      AND r.settlement_verified_at >= to_timestamp(r.expiry_ms/1000.0)
      AND r.outcome IN ('UP','DOWN')
    ORDER BY r.id,s.observed_at ASC`);
  return rows.map((row: any) => ({
    id: String(row.id),expiryMs: Number(row.expiry_ms),
    observedMs: new Date(row.observed_at).getTime(),outcome: row.outcome as "UP"|"DOWN",
    labelAvailableMs: new Date(row.settlement_verified_at).getTime(),
    indicativeUp: Number(row.indicative_up),
    remainingSeconds: (Number(row.expiry_ms)-new Date(row.observed_at).getTime())/1000,
    comparisonReturn: row.comparison_price && row.prior_price
      ? Number(row.comparison_price)/Number(row.prior_price)-1 : null,
    realizedVolatility: row.realized_volatility === null ? null : Number(row.realized_volatility),
  })).sort((a,b) => a.expiryMs - b.expiryMs);
}

export async function saveShadowModel(artifactInput: BtcArtifact, trainedThrough: string, result: unknown) {
  const artifact = parseBtcArtifact(JSON.stringify(artifactInput));
  const { rowCount } = await pool.query(`INSERT INTO btc_predict_models
    (version,status,trained_through,calibrated_at,metrics,parameters)
    VALUES ($1,'SHADOW',$2,now(),$3,$4) ON CONFLICT (version) DO NOTHING`,
    [artifact.modelVersion,trainedThrough,JSON.stringify(result),JSON.stringify({
      kind: "offline-shadow", noLivePromotion: true, artifact,
    })]);
  // A duplicate immutable artifact is still a successful daily fit/validation.
  await pool.query(`UPDATE btc_predict_worker_state SET last_training_at=now() WHERE name='collector'`);
  return rowCount ?? 0;
}
export async function lastShadowTrainingAt() {
  const { rows } = await pool.query<{ last_training_at: Date | null }>(
    `SELECT max(created_at) AS last_training_at FROM btc_predict_models
     WHERE status='SHADOW' AND parameters ? 'artifact'`);
  return rows[0]?.last_training_at ?? null;
}
export async function lastShadowModel() {
  const { rows } = await pool.query<{ version: string; trainedThrough: Date;
    calibratedAt: Date; metrics: { challenger?: { metrics?: unknown } } | null;
    artifact: unknown }>(`SELECT version,trained_through AS "trainedThrough",
    calibrated_at AS "calibratedAt",metrics,parameters->'artifact' AS artifact FROM btc_predict_models
    WHERE status='SHADOW' AND parameters ? 'artifact' ORDER BY created_at DESC LIMIT 1`);
  if (!rows[0]) return null;
  const { artifact, ...metadata } = rows[0];
  // JSONB object-key order is not part of the artifact contract. Hash sorted
  // keys but retain array order so the digest identifies the actual feature order.
  const canonical = JSON.stringify(artifact, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value);
  return {
    ...metadata,
    artifactHash: canonical ? `sha256:${createHash("sha256").update(canonical).digest("hex")}` : null,
  };
}