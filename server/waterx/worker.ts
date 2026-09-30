import pg from "pg";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startPriceCapture } from "../btc/chart";
import { startWaterxCapture } from "./service";

type WorkerDatabase = {
  query<T = unknown>(sql: string): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};

type WorkerOptions = {
  startPriceCapture: () => () => void;
  startWaterxCapture: () => () => void;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  onLeaseLost?: (error: unknown) => void;
};

/** Acquire the session-scoped lock before starting either collector. */
export async function startWaterxWorker(
  db: WorkerDatabase,
  options: WorkerOptions = {
    startPriceCapture,
    startWaterxCapture,
  },
) {
  let stopPrice: (() => void) | undefined;
  let stopWaterx: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const schedule = options.setInterval ?? setInterval;
  const unschedule = options.clearInterval ?? clearInterval;

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    if (heartbeat) unschedule(heartbeat);
    stopPromise = (async () => {
      try { stopWaterx?.(); } catch (error) {
        console.error("WaterX collector shutdown failed:", error);
      }
      try { stopPrice?.(); } catch (error) {
        console.error("BTC collector shutdown failed:", error);
      }
      await db.end().catch(error => {
        console.error("WaterX worker database shutdown failed:", error);
      });
    })();
    return stopPromise;
  };

  try {
    const schema = await db.query<{ learning: string | null; ticks: string | null }>(
      `SELECT to_regclass('waterx_learning_rounds')::text AS learning,
              to_regclass('waterx_comparison_ticks')::text AS ticks`,
    );
    if (!schema.rows[0]?.learning || !schema.rows[0]?.ticks)
      throw new Error("WaterX worker requires learning and comparison tick migrations.");
    const lock = await db.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(95695,51515) AS acquired",
    );
    if (!lock.rows[0]?.acquired)
      throw new Error("Another WaterX collector worker holds the database lease.");

    stopPrice = options.startPriceCapture();
    stopWaterx = options.startWaterxCapture();
    heartbeat = schedule(() => {
      if (stopping) return;
      void db.query("SELECT 1").catch(error => {
        if (stopping) return;
        console.error("WaterX worker lost its database lease:", error);
        options.onLeaseLost?.(error);
        void stop();
      });
    }, 30_000);
    heartbeat.unref?.();
    return { stop };
  } catch (error) {
    stopWaterx?.();
    stopPrice?.();
    await db.end().catch(() => {});
    throw error;
  }
}

async function main() {
  if (!process.env.DATABASE_URL)
    throw new Error("WaterX collector requires a persistent DATABASE_URL.");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const worker = await startWaterxWorker(db, {
    startPriceCapture,
    startWaterxCapture,
    onLeaseLost: () => { process.exitCode = 1; },
  });
  const stop = () => {
    void worker.stop().then(() => {
      process.exitCode ??= 0;
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  if (typeof process.send === "function") process.send({ type: "waterx-worker-ready" });
  console.log("WaterX independent collector running; advisory database lease acquired.");
}

const launchedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (launchedDirectly) {
  main().catch(error => {
    console.error("Cannot start WaterX collector:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}