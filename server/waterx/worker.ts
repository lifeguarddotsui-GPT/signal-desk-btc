import pg from "pg";
import { startPriceCapture } from "../btc/chart";
import { startWaterxCapture } from "./service";

/** Run only under an explicitly configured, continuously running worker target. */
async function main() {
  if (!process.env.DATABASE_URL)
    throw new Error("WaterX collector requires a persistent DATABASE_URL.");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  let stopPrice: (() => void) | undefined;
  let stopWaterx: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (heartbeat) clearInterval(heartbeat);
    stopWaterx?.();
    stopPrice?.();
    await db.end().catch(() => {});
    process.exit(0);
  };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
  try {
    const schema = await db.query<{ learning: string | null; ticks: string | null }>(
      `SELECT to_regclass('waterx_learning_rounds')::text AS learning,
              to_regclass('waterx_comparison_ticks')::text AS ticks`);
    if (!schema.rows[0]?.learning || !schema.rows[0]?.ticks)
      throw new Error("WaterX worker requires learning and comparison tick migrations.");
    const lock = await db.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(95695,51515) AS acquired");
    if (!lock.rows[0]?.acquired)
      throw new Error("Another WaterX collector worker holds the database lease.");
    stopPrice = startPriceCapture();
    stopWaterx = startWaterxCapture();
    // A lost database session releases the lock. Stop rather than continuing
    // to collect with no durable evidence or at-least-one-worker guarantee.
    heartbeat = setInterval(() => {
      void db.query("SELECT 1").catch(error => {
        console.error("WaterX worker lost its database lease:", error);
        void stop();
      });
    }, 30_000);
    console.log("WaterX independent collector running; advisory database lease acquired.");
  } catch (error) {
    await db.end().catch(() => {});
    throw error;
  }
}

main().catch(error => {
  console.error("Cannot start WaterX collector:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});