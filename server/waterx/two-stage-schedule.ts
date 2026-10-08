import type { LockDb } from "./lock-store";
import { runTwoStageLearning } from "./two-stage-learning";
import { STAGE_TRAINING_PROTOCOL } from "./two-stage-registry";

/** Persisted daily report plus transaction lock bounds work across replicas and
 * restarts. Uses only the current process; never promises autoscale uptime. */
export async function runStageLearningDay(db: LockDb, interval: 5 | 15, now = Date.now(),
  learn = runTwoStageLearning) {
  const day = Math.floor(now / 86400000) * 86400000;
  await db.query("BEGIN");
  try {
    const claimed = await db.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
      [`two-stage-training:${interval}:${day}`]);
    if (!claimed.rows[0]?.acquired) { await db.query("ROLLBACK"); return "BUSY" as const; }
    const prior = await db.query(`SELECT id FROM waterx_two_stage_training
      WHERE interval_minutes=$1 AND created_at_ms>=$2 AND created_at_ms<$3 AND report->>'protocol'=$4 LIMIT 1`,
      [interval, day, day + 86400000, STAGE_TRAINING_PROTOCOL]);
    if (prior.rows.length) { await db.query("COMMIT"); return "ALREADY_RECORDED" as const; }
    await learn(interval, now, db);
    await db.query("COMMIT");
    return "RECORDED" as const;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export function createStageLearningWake(options: {
  connect: () => Promise<LockDb & {release(): void}>;
  allowed: () => boolean; refresh: () => Promise<void>; now?: () => number;
  run?: typeof runStageLearningDay;
}) {
  let job: Promise<void> | null = null, retryAtMs = 0, stopped = false;
  let lastSuccessMs: number | null = null, lastFailureMs: number | null = null;
  const now = options.now ?? Date.now;
  function wake() {
    if (job) return job;
    if (stopped || !options.allowed() || now() < retryAtMs) return Promise.resolve();
    job = (async () => {
      const client = await options.connect();
      try {
        for (const interval of [5, 15] as const) {
          if (stopped || !options.allowed()) break;
          await (options.run ?? runStageLearningDay)(client, interval, now());
        }
        lastSuccessMs = now();
      } finally { client.release(); }
      await options.refresh();
      retryAtMs = now() + 3600000;
    })().catch(() => {
      lastFailureMs = now(); retryAtMs = now() + 300000;
      console.warn("Stage training unavailable; retry bounded, qualification unchanged.");
    }).finally(() => { job = null; });
    return job;
  }
  return {wake, stop: () => { stopped = true; },
    health: () => ({running: !!job, lastSuccessMs, lastFailureMs, retryAtMs,
      mode: "OPPORTUNISTIC_EXISTING_PROCESS", executionAllowed: false})};
}
