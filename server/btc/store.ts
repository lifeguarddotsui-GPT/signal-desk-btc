import pg from "pg";
import { createHash } from "node:crypto";
import type { Market } from "./source";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
export async function initializeStore() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for prospective evidence capture");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS btc_predict_rounds (
      id text PRIMARY KEY, expiry_ms bigint NOT NULL, start_ms bigint NOT NULL,
      reference_price numeric, settlement_price numeric, outcome text NOT NULL DEFAULT 'UNKNOWN',
      first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL,
      last_attempt_at timestamptz,
      cadence_evidence text NOT NULL, source text NOT NULL, quality text NOT NULL DEFAULT 'UNRESOLVED'
    );
    ALTER TABLE btc_predict_rounds ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
    CREATE TABLE IF NOT EXISTS btc_predict_snapshots (
      id text PRIMARY KEY, round_id text NOT NULL REFERENCES btc_predict_rounds(id),
      observed_at timestamptz NOT NULL, raw jsonb NOT NULL,
      indicative_up numeric, indicative_down numeric, comparison_price numeric,
      comparison_at timestamptz, source text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS btc_predict_snapshots_round_idx ON btc_predict_snapshots(round_id, observed_at);
  `);
}
export async function saveRound(m: Market, observedAt: string) {
  await pool.query(`INSERT INTO btc_predict_rounds
    (id,expiry_ms,start_ms,reference_price,first_seen_at,last_seen_at,cadence_evidence,source)
    VALUES ($1,$2,$3,$4,$5,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET
    last_seen_at=EXCLUDED.last_seen_at,
    reference_price=COALESCE(btc_predict_rounds.reference_price, EXCLUDED.reference_price)`,
    [m.id,m.expiryMs,m.startMs,m.referencePrice,observedAt,m.cadenceEvidence,"DeepBook Predict mainnet SDK read.markets"]);
}
export async function saveSnapshot(m: Market, raw: unknown, observedAt: string,
  quote: { up: number; down: number } | null,
  comparison: { price: number; asOf: string } | null) {
  const id = createHash("sha256").update(`${m.id}:${Math.floor(Date.parse(observedAt) / 15_000)}`).digest("hex");
  await pool.query(`INSERT INTO btc_predict_snapshots
    (id,round_id,observed_at,raw,indicative_up,indicative_down,comparison_price,comparison_at,source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
    [id,m.id,observedAt,JSON.stringify(raw),quote?.up ?? null,quote?.down ?? null,
      comparison?.price ?? null,comparison?.asOf ?? null,"DeepBook Predict mainnet SDK + Coinbase Exchange comparison"]);
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
  const outcome = reference === null ? "UNKNOWN" : price > reference ? "UP" : "DOWN";
  await pool.query(`UPDATE btc_predict_rounds SET settlement_price=$2, outcome=$3,
    quality=$4 WHERE id=$1 AND settlement_price IS NULL`,
    [id,price,outcome,reference === null ? "MISSING_REFERENCE" : "VERIFIED_SETTLEMENT"]);
}
export async function history() {
  const { rows } = await pool.query(`SELECT r.id,r.expiry_ms AS "expiryMs",r.reference_price AS "referencePrice",
    r.settlement_price AS "settlementPrice",r.outcome,r.quality,
    r.first_seen_at AS "firstSeenAt",r.last_seen_at AS "lastSeenAt",
    (SELECT COUNT(*)::int FROM btc_predict_snapshots s WHERE s.round_id=r.id) AS "quoteCount"
    FROM btc_predict_rounds r ORDER BY r.expiry_ms DESC LIMIT 1000`);
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