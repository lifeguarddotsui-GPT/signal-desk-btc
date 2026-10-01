import pg from "pg";
import {
  auditWaterxPriorUtcDay,
  type WaterxDailyAuditQueryable,
} from "../server/waterx/daily-audit";

async function main() {
  if (process.argv.length > 2) {
    throw new Error("Usage: node --import tsx scripts/audit-waterx-prior-day.ts");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("DATABASE_URL is required; the read-only WaterX audit was not run.");

  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '12s'");
    const report = await auditWaterxPriorUtcDay(
      client as unknown as WaterxDailyAuditQueryable);
    await client.query("COMMIT");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the audit error; the connection will be released and closed.
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`WaterX prior-day audit failed closed: ${message}\n`);
  process.exitCode = 1;
});