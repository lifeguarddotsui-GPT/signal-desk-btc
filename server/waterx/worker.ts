import pg from "pg";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startPriceCapture } from "../btc/chart";
import {startTwoStageSupport} from "./two-stage-support";
import { startWaterxCapture } from "./service";
import {
  runScheduledWaterxCandidateEvaluation,
  type WaterxCandidateQueryable,
} from "./candidate-runtime";
import {
  runResearchTrainingDay,
  type ResearchTrainingQueryable,
} from "./research-training";
import { startResearchMaintenance } from "./research-maintenance";
import {setDecisionWorkerLease} from "./decision-authority";

type WorkerDatabase = {
  query<T = unknown>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};

type WorkerOptions = {
  startPriceCapture: () => () => void;
  startWaterxCapture: () => () => void;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  onLeaseLost?: (error: unknown) => void;
  candidateEvaluationEnabled?: boolean;
  candidateScheduleIntervalMs?: number;
  runCandidateEvaluation?: (db: WaterxCandidateQueryable) => Promise<unknown>;
  researchEvaluationEnabled?: boolean;
  researchScheduleIntervalMs?: number;
  runResearchTraining?: (db: ResearchTrainingQueryable, interval: 5 | 15) => Promise<unknown>;
  startResearchMaintenance?: () => () => void;
};

const DAILY_CANDIDATE_SCHEDULE_MS = 24 * 60 * 60_000;

/** Acquire the session-scoped lock before starting either collector. */
export async function startWaterxWorker(
  db: WorkerDatabase,
  options: WorkerOptions = {
    startPriceCapture:()=>{const stopSupport=startTwoStageSupport(),stopPrice=startPriceCapture();
      return ()=>{stopPrice();stopSupport();};},
    startWaterxCapture: () => startWaterxCapture({
      onStalled: () => { process.exit(1); },
    }),
  },
) {
  let stopPrice: (() => void) | undefined;
  let stopWaterx: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let candidateSchedule: ReturnType<typeof setInterval> | undefined;
  let researchSchedule: ReturnType<typeof setInterval> | undefined;
  let stopResearchMaintenance: (() => void) | undefined;
  let stopping = false;
  let leaseOwned = false;
  let candidateEvaluation: Promise<void> | undefined;
  let researchEvaluation: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const schedule = options.setInterval ?? setInterval;
  const unschedule = options.clearInterval ?? clearInterval;

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    setDecisionWorkerLease(false);
    if (heartbeat) unschedule(heartbeat);
    if (candidateSchedule) unschedule(candidateSchedule);
    if (researchSchedule) unschedule(researchSchedule);
    stopResearchMaintenance?.();
    stopPromise = (async () => {
      try { stopWaterx?.(); } catch (error) {
        console.error("WaterX collector shutdown failed:", error);
      }
      try { stopPrice?.(); } catch (error) {
        console.error("BTC collector shutdown failed:", error);
      }
      await candidateEvaluation?.catch(error => {
        console.error("WaterX daily candidate evaluation shutdown failed:", error);
      });
      await researchEvaluation?.catch(error => {
        console.error("WaterX daily research evaluation shutdown failed:", error);
      });
      await db.end().catch(error => {
        console.error("WaterX worker database shutdown failed:", error);
      });
    })();
    return stopPromise;
  };

  try {
    const schema = await db.query<{
      learning: string | null; ticks: string | null;
      researchChoices: string | null; researchDaily: string | null;
    }>(
      `SELECT to_regclass('waterx_learning_rounds')::text AS learning,
              to_regclass('waterx_comparison_ticks')::text AS ticks,
              to_regclass('waterx_research_choices')::text AS "researchChoices",
              to_regclass('waterx_research_daily_runs')::text AS "researchDaily"`,
    );
    if (!schema.rows[0]?.learning || !schema.rows[0]?.ticks)
      throw new Error("WaterX worker requires learning and comparison tick migrations.");
    const lock = await db.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(95695,51515) AS acquired",
    );
    if (!lock.rows[0]?.acquired)
      throw new Error("Another WaterX collector worker holds the database lease.");

    leaseOwned = true;
    setDecisionWorkerLease(true);
    stopPrice = options.startPriceCapture();
    stopWaterx = options.startWaterxCapture();
    heartbeat = schedule(() => {
      if (stopping) return;
      void db.query<{ lease_owned: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_locks
            WHERE locktype='advisory' AND pid=pg_backend_pid()
              AND classid=95695::oid AND objid=51515::oid AND objsubid=2
         ) AS lease_owned`,
      ).then(result => {
        if (result.rows[0]?.lease_owned === true) return;
        const error = new Error("WaterX worker advisory lease is no longer held.");
        if (stopping) return;
        leaseOwned = false;
        console.error("WaterX worker lost its database lease:", error);
        options.onLeaseLost?.(error);
        void stop();
      }).catch(error => {
        if (stopping) return;
        leaseOwned = false;
        console.error("WaterX worker lost its database lease:", error);
        options.onLeaseLost?.(error);
        void stop();
      });
    }, 30_000);
    heartbeat.unref?.();

    const candidateSchedulingConfigured = process.env.NODE_ENV === "development" ||
      (process.env.NODE_ENV === "production" &&
        process.env.WATERX_CANDIDATE_SCHEDULE_ENABLED === "true");
    const candidateSchedulingEnabled = candidateSchedulingConfigured &&
      options.candidateEvaluationEnabled !== false;
    if (candidateSchedulingEnabled) {
      const runEvaluation = options.runCandidateEvaluation ??
        runScheduledWaterxCandidateEvaluation;
      const evaluate = () => {
        if (stopping || !leaseOwned || candidateEvaluation) return;
        candidateEvaluation = db.query<{ lease_owned: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks
              WHERE locktype='advisory' AND pid=pg_backend_pid()
                AND classid=95695::oid AND objid=51515::oid AND objsubid=2
           ) AS lease_owned`,
        ).then(result => {
          if (result.rows[0]?.lease_owned !== true)
            throw new Error("WaterX candidate evaluation refused because the worker advisory lease is not held.");
          if (stopping || !leaseOwned)
            throw new Error("WaterX candidate evaluation cancelled because worker lease ownership was lost.");
          return runEvaluation(db);
        }).then(result => {
          const summary = Array.isArray(result) ? result.map(value => {
            const outcome = value && typeof value === "object"
              ? value as { intervalMinutes?: unknown; outcome?: unknown; reason?: unknown; report?: { status?: unknown } }
              : {};
            return {
              intervalMinutes: outcome.intervalMinutes,
              outcome: outcome.outcome ?? outcome.report?.status,
              reason: outcome.reason,
            };
          }) : result;
          console.log("WaterX daily candidate evaluation completed:", summary);
        }).catch(error => {
          console.error("WaterX daily candidate evaluation failed closed:",
            error instanceof Error ? error.message : error);
        }).finally(() => {
          candidateEvaluation = undefined;
        });
      };
      candidateSchedule = schedule(
        evaluate,
        options.candidateScheduleIntervalMs ?? DAILY_CANDIDATE_SCHEDULE_MS,
      );
      candidateSchedule.unref?.();
      // The runtime checks persisted per-interval cadence before doing work, so
      // restarts cannot turn this initial wake-up into more frequent training.
      evaluate();
    }
    // Research fitting is attached to the already-running, already-leased
    // collector. It never starts a new process, worker topology, schema, or
    // external service. The persisted daily key makes startup/hourly wakeups
    // idempotent after ordinary worker restarts.
    const researchSchedulingEnabled = options.researchEvaluationEnabled !== false;
    if (researchSchedulingEnabled &&
        schema.rows[0]?.researchChoices && schema.rows[0]?.researchDaily) {
      stopResearchMaintenance=(options.startResearchMaintenance ?? startResearchMaintenance)();
      const runResearch = options.runResearchTraining ??
        ((researchDb: ResearchTrainingQueryable, interval: 5 | 15) =>
          runResearchTrainingDay(researchDb, interval, { executionMode: "leased-worker" }));
      const evaluateResearch = () => {
        if (stopping || !leaseOwned || researchEvaluation) return;
        researchEvaluation = (async () => {
          const check = await db.query<{ lease_owned: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_locks
                WHERE locktype='advisory' AND pid=pg_backend_pid()
                  AND classid=95695::oid AND objid=51515::oid AND objsubid=2
             ) AS lease_owned`,
          );
          if (check.rows[0]?.lease_owned !== true)
            throw new Error("WaterX research evaluation refused because the existing collector lease is not held.");
          if (stopping || !leaseOwned)
            throw new Error("WaterX research evaluation cancelled because the collector lease was lost.");
          for (const interval of [5, 15] as const) {
            if (stopping || !leaseOwned) break;
            const result = await runResearch(
              db as unknown as ResearchTrainingQueryable, interval);
            const value = result && typeof result === "object"
              ? result as { intervalMinutes?: unknown; outcome?: unknown; reason?: unknown }
              : {};
            console.log("[waterx-research] UTC daily shadow evaluation:", {
              intervalMinutes: value.intervalMinutes ?? interval,
              outcome: value.outcome,
              reason: value.reason,
              promoted: false,
            });
          }
        })().catch(error => {
          console.error("[waterx-research] daily evaluation failed closed:",
            error instanceof Error ? error.message : "Unknown error.");
        }).finally(() => { researchEvaluation = undefined; });
      };
      researchSchedule = schedule(evaluateResearch,
        Math.max(60_000, options.researchScheduleIntervalMs ?? 60 * 60_000));
      researchSchedule.unref?.();
      evaluateResearch();
    } else if (researchSchedulingEnabled) {
      console.warn("[waterx-research] daily evaluation remains unavailable: reviewed choice/run schema is not installed; the collector continues without DDL.");
    }
    return { stop };
  } catch (error) {
    leaseOwned = false;
    if (candidateSchedule) unschedule(candidateSchedule);
    if (researchSchedule) unschedule(researchSchedule);
    if (heartbeat) unschedule(heartbeat);
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
    startPriceCapture:()=>{const stopSupport=startTwoStageSupport(),stopPrice=startPriceCapture();
      return ()=>{stopPrice();stopSupport();};},
    startWaterxCapture: () => startWaterxCapture({
      onStalled: () => { process.exit(1); },
    }),
    onLeaseLost: () => { process.exitCode = 1; },
  });
  let shuttingDown = false;
  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // The worker is the only responsibility of this process. A shared pool or
    // open network handle must not keep its advisory lease until the supervisor
    // resorts to SIGKILL; process exit releases any remaining session locks.
    const deadline = setTimeout(() => {
      console.error("WaterX worker shutdown exceeded five seconds.");
      process.exit(1);
    }, 5_000);
    void worker.stop().then(() => {
      clearTimeout(deadline);
      process.exit(process.exitCode ?? 0);
    }, error => {
      clearTimeout(deadline);
      console.error("WaterX worker shutdown failed:", error);
      process.exit(1);
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