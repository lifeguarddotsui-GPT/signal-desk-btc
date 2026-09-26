import pg from "pg";
import { createHash } from "node:crypto";
import type { Market } from "./source";
import { classifySettlement, primaryDecisionWindow } from "./policy";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
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
  const id = createHash("sha256").update(`${m.id}:${Math.floor(Date.parse(observedAt) / 15_000)}`).digest("hex");
  const { rows } = await client.query<{ id: string }>(`INSERT INTO btc_predict_snapshots
    (id,round_id,observed_at,raw,indicative_up,indicative_down,comparison_price,comparison_at,source)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
    WHERE now() < to_timestamp($10/1000.0)
    ON CONFLICT (id) DO NOTHING RETURNING id`,
    [id,m.id,observedAt,JSON.stringify(raw),quote?.up ?? null,quote?.down ?? null,
      comparison?.price ?? null,comparison?.asOf ?? null,"DeepBook Predict mainnet SDK + Coinbase Exchange comparison",m.expiryMs]);
  return rows[0]?.id ?? null;
}

async function savePrediction(client: pg.PoolClient, m: Market, snapshotId: string, observedAt: string,
  quote: { up: number; asOf: string; source: string } | null,
  comparison: { asOf: string; source: string } | null) {
  const remainingSeconds = (m.expiryMs - Date.parse(observedAt)) / 1000;
  if (remainingSeconds <= 0) return false;
  const primaryWindow = primaryDecisionWindow(Date.parse(observedAt),m.expiryMs);
  const reason = !m.referencePrice ? "On-chain reference not available."
    : !quote ? "Indicative source unavailable; no calibrated forecast."
    : "No promoted, independently validated calibrated forecast or verified economic terms.";
  const { rowCount } = await client.query(`INSERT INTO btc_predict_predictions
    (id,round_id,snapshot_id,observed_at,remaining_seconds,indicative_up,
     forecast_up,model_version,action,reason,feature_sources,primary_window)
    SELECT $1,$2,$3,$4,$5,$6,NULL,'NO_PROMOTED_MODEL','HOLD',$7,$8,$9
    WHERE now() < to_timestamp($10/1000.0)
    ON CONFLICT (snapshot_id) DO NOTHING`,
    [createHash("sha256").update(snapshotId + ":forecast:v1").digest("hex"),m.id,snapshotId,
      observedAt,remainingSeconds,quote?.up ?? null,reason,JSON.stringify({
        market: "DeepBook Predict read.markets", reference: m.referencePrice,
        indicative: quote ? { source: quote.source, asOf: quote.asOf } : null,
        comparison: comparison ? { source: comparison.source, asOf: comparison.asOf, role: "comparison-only" } : null,
        cadence: m.cadenceEvidence,
      }),primaryWindow,m.expiryMs]);
  return rowCount === 1;
}

export async function saveEvidence(m: Market, raw: unknown, observedAt: string,
  quote: { up: number; down: number; asOf: string; source: string } | null,
  comparison: { price: number; asOf: string; source: string } | null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const snapshotId = await saveSnapshot(client,m,raw,observedAt,quote,comparison);
    if (snapshotId && !await savePrediction(client,m,snapshotId,observedAt,quote,comparison))
      throw new Error("Evidence expired before its prediction could be committed");
    await client.query("COMMIT");
    return snapshotId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markHeartbeat(input: { marketAt?: string; roundId?: string; error?: string }) {
  const now = new Date().toISOString();
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
      input.error ? 1 : 0,input.roundId ?? null]);
  if (input.error)
    await pool.query(`INSERT INTO btc_predict_provider_errors(message) VALUES ($1)`,
      [input.error.slice(0,240)]);
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
    SELECT DISTINCT ON (p.round_id) p.id,p.round_id,r.outcome,'ONCHAIN_INDICATIVE_BASELINE',
      power(p.indicative_up - CASE WHEN r.outcome='UP' THEN 1 ELSE 0 END,2),
      -ln(GREATEST(.000000001,CASE WHEN r.outcome='UP' THEN p.indicative_up ELSE 1-p.indicative_up END))
    FROM btc_predict_predictions p
    JOIN btc_predict_rounds r ON r.id=p.round_id
    WHERE p.primary_window AND p.indicative_up IS NOT NULL
      AND p.observed_at < to_timestamp(r.expiry_ms/1000.0)
      AND p.captured_at < to_timestamp(r.expiry_ms/1000.0)
      AND r.quality='VERIFIED_SETTLEMENT' AND r.outcome IN ('UP','DOWN')
    ORDER BY p.round_id,p.observed_at ASC
    ON CONFLICT (prediction_id) DO NOTHING`);
  if (rowCount && rowCount > 0) {
    await pool.query(`UPDATE btc_predict_worker_state SET last_evaluation_at=now() WHERE name='collector'`);
  }
  return rowCount ?? 0;
}
export async function prospectiveScores() {
  const { rows } = await pool.query(`SELECT kind,
    count(*)::int AS count,avg(brier) AS brier,avg(log_loss) AS "logLoss"
    FROM btc_predict_scores GROUP BY kind ORDER BY kind`);
  return rows.map((row: any) => ({
    name: row.kind === "ONCHAIN_INDICATIVE_BASELINE" ?
      "On-chain indicative (prospective baseline; not a fill)" : String(row.kind),
    count: Number(row.count), brier: Number(row.brier), logLoss: Number(row.logLoss),
  }));
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
  const { rows } = await pool.query(`SELECT observed_at,comparison_price FROM btc_predict_snapshots
    WHERE comparison_price IS NOT NULL AND observed_at > now()-interval '5 minutes'
    ORDER BY observed_at DESC LIMIT 90`);
  return rows.reverse().map((r: any) => ({ at: new Date(r.observed_at).getTime(), price: Number(r.comparison_price) }));
}
export async function evaluationRows() {
  const { rows } = await pool.query(`SELECT r.id,r.expiry_ms,r.outcome,s.indicative_up,s.observed_at FROM btc_predict_rounds r
    JOIN LATERAL (SELECT indicative_up,observed_at FROM btc_predict_snapshots
      WHERE round_id=r.id AND indicative_up IS NOT NULL
        AND observed_at < to_timestamp(r.expiry_ms/1000.0) - interval '5 seconds'
      ORDER BY observed_at ASC LIMIT 1) s ON true
    WHERE r.quality='VERIFIED_SETTLEMENT' AND r.outcome IN ('UP','DOWN')
    ORDER BY r.expiry_ms ASC LIMIT 10000`);
  return rows.map((r: any) => ({ id: r.id, expiryMs: Number(r.expiry_ms), outcome: r.outcome as "UP"|"DOWN", up: Number(r.indicative_up) }));
}

export async function recentPredictions(limit = 20) {
  const { rows } = await pool.query(`SELECT p.round_id AS "roundId",p.observed_at AS "predictionAt",
    p.remaining_seconds AS "remainingSeconds",p.model_version AS "modelVersion",
    p.indicative_up AS "indicativeUp",p.forecast_up AS "calibratedUp",p.action,p.reason,
    r.outcome,r.quality,r.settlement_verified_at AS "settlementVerifiedAt",
    s.scored_at AS "evaluatedAt",
    CASE WHEN s.scored_at IS NOT NULL AND r.settlement_verified_at IS NOT NULL
      THEN extract(epoch from s.scored_at-r.settlement_verified_at) END AS "evaluationLatencySeconds",
    (s.prediction_id IS NOT NULL) AS evaluated
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
    (SELECT count(*)::int FROM btc_predict_rounds WHERE quality='VERIFIED_SETTLEMENT') AS settled,
    (SELECT count(DISTINCT r.id)::int FROM btc_predict_rounds r
      JOIN btc_predict_snapshots s ON s.round_id=r.id
      WHERE r.quality='VERIFIED_SETTLEMENT' AND r.outcome IN ('UP','DOWN')
        AND s.indicative_up BETWEEN 0 AND 1
        AND s.observed_at BETWEEN to_timestamp(r.expiry_ms/1000.0)-interval '45 seconds'
          AND to_timestamp(r.expiry_ms/1000.0)-interval '30 seconds') AS eligible,
    (SELECT count(DISTINCT round_id)::int FROM btc_predict_predictions
      WHERE primary_window AND indicative_up IS NOT NULL) AS "prospectiveEligible",
    (SELECT count(*)::int FROM btc_predict_scores) AS evaluated,
    (SELECT count(*)::int FROM btc_predict_rounds WHERE quality <> 'VERIFIED_SETTLEMENT') AS unresolved,
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
  };
}

export async function modelRows() {
  // One fixed, pre-expiry decision window per round; never sample later odds.
  const { rows } = await pool.query(`SELECT DISTINCT ON (r.id)
    r.id,r.expiry_ms,r.outcome,s.observed_at,s.indicative_up,s.comparison_price,
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
        AND comparison_price IS NOT NULL
      ORDER BY observed_at DESC LIMIT 1
    ) prev ON true
    LEFT JOIN LATERAL (
      SELECT CASE WHEN count(*)>=4 THEN stddev_samp(ret) ELSE NULL END AS vol FROM (
        SELECT ln(comparison_price / lag(comparison_price)
          OVER (ORDER BY observed_at)) AS ret FROM btc_predict_snapshots
        WHERE comparison_price IS NOT NULL
          AND observed_at BETWEEN s.observed_at-interval '90 seconds' AND s.observed_at
      ) returns WHERE ret IS NOT NULL
    ) volatility ON true
    WHERE r.quality='VERIFIED_SETTLEMENT' AND r.outcome IN ('UP','DOWN')
    ORDER BY r.id,s.observed_at ASC`);
  return rows.map((row: any) => ({
    id: String(row.id),expiryMs: Number(row.expiry_ms),
    observedMs: new Date(row.observed_at).getTime(),outcome: row.outcome as "UP"|"DOWN",
    indicativeUp: Number(row.indicative_up),
    remainingSeconds: (Number(row.expiry_ms)-new Date(row.observed_at).getTime())/1000,
    comparisonReturn: row.comparison_price && row.prior_price
      ? Number(row.comparison_price)/Number(row.prior_price)-1 : null,
    realizedVolatility: row.realized_volatility === null ? null : Number(row.realized_volatility),
  })).sort((a,b) => a.expiryMs - b.expiryMs);
}

export async function saveShadowModel(version: string, trainedThrough: string, result: unknown) {
  const { rowCount } = await pool.query(`INSERT INTO btc_predict_models
    (version,status,trained_through,calibrated_at,metrics,parameters)
    VALUES ($1,'SHADOW',$2,now(),$3,$4) ON CONFLICT (version) DO NOTHING`,
    [version,trainedThrough,JSON.stringify(result),JSON.stringify({ kind: "offline-shadow", noLivePromotion: true })]);
  if (rowCount && rowCount > 0)
    await pool.query(`UPDATE btc_predict_worker_state SET last_training_at=now() WHERE name='collector'`);
}
export async function lastShadowModel() {
  const { rows } = await pool.query(`SELECT version,trained_through AS "trainedThrough",
    calibrated_at AS "calibratedAt",metrics FROM btc_predict_models
    WHERE status='SHADOW' ORDER BY created_at DESC LIMIT 1`);
  return rows[0] ?? null;
}