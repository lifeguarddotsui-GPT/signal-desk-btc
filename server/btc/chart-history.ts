import pg from "pg";
import type { ArchivedChartPoint } from "./chart";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const HISTORY_LIMIT = 512;

/**
 * Comparison history is read from the existing prospective snapshot table.
 * It is intentionally bounded and does not require a schema migration.
 */
export async function persistedComparisonHistory(windowMs: 5 | 15): Promise<ArchivedChartPoint[]> {
  const cutoff = new Date(Date.now() - windowMs * 60_000).toISOString();
  const { rows } = await pool.query<{
    observed_at: Date;
    comparison_at: Date | null;
    comparison_price: string;
  }>(`SELECT observed_at,comparison_at,comparison_price
      FROM btc_predict_snapshots
      WHERE comparison_price IS NOT NULL AND observed_at >= $1
      ORDER BY observed_at DESC LIMIT $2`, [cutoff, HISTORY_LIMIT]);
  return rows.reverse().map(row => ({
    at: new Date(row.observed_at).getTime(),
    price: Number(row.comparison_price),
    sourceAt: row.comparison_at ? new Date(row.comparison_at).toISOString() : null,
  }));
}