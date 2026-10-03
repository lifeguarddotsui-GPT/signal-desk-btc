import assert from "node:assert/strict";
import test from "node:test";
import type { ResearchTrainingQueryable } from "../server/waterx/research-training";
import { startWaterxWorker } from "../server/waterx/worker";
import {
  getResearchDailyJob,
  runResearchTrainingDay,
  startResearchSchedule,
} from "../server/waterx/research-training";
import {
  trainWaterxResearchChoices,
  type ResearchTrainingRound,
} from "../server/waterx/research-training-model";

function choices(interval: 5 | 15, count: number): ResearchTrainingRound[] {
  const cadence = interval * 60_000;
  const base = Date.parse("2026-01-01T00:00:00Z");
  return Array.from({ length: count }, (_, index) => {
    const startMs = base + index * cadence;
    const up = index % 4 < 2;
    return {
      intervalMinutes: interval,
      roundId: `${interval}m-round-${index}`,
      startMs,
      expiryMs: startMs + cadence,
      decisionAtMs: startMs + cadence / 2,
      referenceObservedAtMs: startMs + cadence / 2,
      marketObservedAtMs: startMs + cadence / 2,
      probabilityUp: up ? 0.6 : 0.4,
      marketProbabilityUp: up ? 0.54 : 0.46,
      referencePrice: 95_000 + index * 0.2,
      referenceQuality: index % 2 === 0 ? "provisional" : "confirmed",
      comparisonPrice: 95_050 + index * 0.2,
      comparisonSourceAtMs: startMs + cadence / 2 - 1_000,
      comparisonReceivedAtMs: startMs + cadence / 2 - 750,
      return1m: Math.sin(index / 11) * 0.002,
      return3m: Math.cos(index / 13) * 0.003,
      realizedVolatilityBps: 3 + Math.abs(Math.sin(index / 7)),
      settlementAnchorPrice: 95_000 + index * 0.2,
      settlePrice: up ? 95_100 + index * 0.2 : 94_900 + index * 0.2,
      outcome: up ? "UP" : "DOWN",
      settledAtMs: startMs + cadence + 1_000,
      labelAvailableAtMs: startMs + cadence + 1_200,
    };
  });
}

class FakeResearchDatabase implements ResearchTrainingQueryable {
  readonly runs = new Map<string, Record<string, unknown>>();
  lock = false;
  dataset: ResearchTrainingRound[] = [];
  failChoiceRead = false;
  disputedRoundIds = new Set<string>();
  invalidAvailabilityIds = new Set<string>();
  unconfirmedLegacyAnchorIds = new Set<string>();
  incompleteComparisonIds = new Set<string>();
  featureSupplementAvailable = false;
  featureSupplements = new Map<string, Record<string, unknown>>();
  lastChoiceQuery = "";

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount?: number | null }> {
    if (sql.includes("to_regclass('waterx_research_choices')"))
      return { rows: [{
        choices: "waterx_research_choices",
        daily: "waterx_research_daily_runs",
        rounds: "waterx_learning_rounds",
      } as T] };
    if (sql.includes("to_regclass('waterx_research_feature_supplements')"))
      return { rows: [{ supplements: this.featureSupplementAvailable
        ? "waterx_research_feature_supplements" : null } as T] };
    if (sql.includes("pg_try_advisory_lock(95695,51516)")) {
      if (this.lock) return { rows: [{ acquired: false } as T] };
      this.lock = true;
      return { rows: [{ acquired: true } as T] };
    }
    if (sql.includes("pg_advisory_unlock(95695,51516)")) {
      this.lock = false;
      return { rows: [{ unlocked: true } as T] };
    }
    if (sql.startsWith("SET ") || sql.startsWith("RESET "))
      return { rows: [] };
    if (sql.includes("UPDATE waterx_research_daily_runs") &&
        sql.includes("status='failed'")) {
      const interval = String(values[0]);
      for (const [key, row] of this.runs) {
        if (key.startsWith(`${interval}:`) && row.status === "started") {
          this.runs.set(key, {
            ...row,
            status: "failed",
            reason: "stale_started_attempt_recovered",
          });
        }
      }
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO waterx_research_daily_runs")) {
      const interval = Number(values[0]);
      const day = String(values[1]);
      const key = `${interval}:${day}`;
      if (this.runs.has(key)) return { rows: [] };
      const row = { started_at: new Date(String(values[2])), status: "started" };
      this.runs.set(key, row);
      return { rows: [{ started_at: row.started_at } as T] };
    }
    if (sql.includes("SELECT status,reason FROM waterx_research_daily_runs")) {
      const key = `${String(values[0])}:${String(values[1])}`;
      const row = this.runs.get(key);
      return { rows: row ? [{ status: row.status, reason: row.reason ?? null } as T] : [] };
    }
    if (sql.includes("FROM waterx_research_choices")) {
      if (this.failChoiceRead) throw new Error("research choices database unavailable");
      this.lastChoiceQuery = sql;
      return { rows: this.dataset.filter(row => row.intervalMinutes === Number(values[0])).map(row => {
        const value = toPersistedChoice(row);
        if (this.incompleteComparisonIds.has(row.roundId)) {
          const evidence = value.evidence as Record<string, unknown>;
          const comparison = evidence.comparison as Record<string, unknown>;
          evidence.comparison = { ...comparison, coverage: "partial" };
          if (this.featureSupplementAvailable && sql.includes("jsonb_set") &&
              this.featureSupplements.has(row.roundId))
            evidence.comparison = this.featureSupplements.get(row.roundId);
        }
        if (this.disputedRoundIds.has(row.roundId)) value.settlement_disputed = true;
        if (this.unconfirmedLegacyAnchorIds.has(row.roundId)) value.anchor_confirmed = false;
        if (this.invalidAvailabilityIds.has(row.roundId))
          value.settlement_observed_at = new Date(row.settledAtMs - 1);
        return value as T;
      }) };
    }
    if (sql.includes("UPDATE waterx_research_daily_runs SET phases")) {
      return { rows: [] };
    }
    if (sql.includes("SELECT scheduled_day,status,started_at,finished_at")) {
      return { rows: [] };
    }
    if (sql.includes("SELECT min(scheduled_day)::text AS first_day")) {
      return { rows: [{ first_day: null, days: [] } as T] };
    }
    if (sql.includes("SET status=$3")) {
      const key = `${String(values[0])}:${String(values[1])}`;
      const existing = this.runs.get(key);
      if (!existing) return { rows: [] };
      this.runs.set(key, {
        ...existing,
        status: values[2],
        finished_at: values[3],
        dataset_fingerprint: values[4],
        dataset_count: values[5],
        error: values[6],
        reason: values[7],
        phases: values[8],
        report: values[9],
        artifact: values[10],
      });
      return { rows: [{ interval_minutes: values[0] } as T] };
    }
    throw new Error(`Unexpected research training SQL: ${sql}`);
  }
}

function toPersistedChoice(row: ResearchTrainingRound): Record<string, unknown> {
  return {
    interval_minutes: row.intervalMinutes,
    round_id: row.roundId,
    start_ms: row.startMs,
    expiry_ms: row.expiryMs,
    decision_at_ms: row.decisionAtMs,
    state: "FROZEN",
    probability_up: row.probabilityUp,
    evidence: {
      reference: {
        price: row.referencePrice,
        quality: row.referenceQuality,
        source: "WaterX",
        appObservedAtMs: row.decisionAtMs,
      },
      market: {
        probabilityUp: row.marketProbabilityUp,
        probabilityDown: 1 - row.marketProbabilityUp,
        appObservedAtMs: row.decisionAtMs,
        timestampKind: "app-observed",
      },
      comparison: {
        source: "Coinbase",
        price: row.comparisonPrice,
        sourceAtMs: row.comparisonSourceAtMs,
        receivedAtMs: row.comparisonReceivedAtMs,
        return1m: row.return1m,
        return3m: row.return3m,
        realizedVolatility: row.realizedVolatilityBps / 10_000,
        tickCount: 13,
        coverage: "complete",
      },
    },
    label_status: "verified",
    settlement_disputed: false,
    settlement_quarantine: null,
    anchor_confirmed: true,
    settlement_anchor_price: row.settlementAnchorPrice,
    settle_price: row.settlePrice,
    outcome: row.outcome === "UP" ? "Up" : "Down",
    settled_at: row.settledAtMs,
    settlement_observed_at: new Date(row.labelAvailableAtMs),
  };
}

test("provisional frozen research choices train in a distinct recorded cohort", () => {
  const dataset = choices(5, 610);
  const report = trainWaterxResearchChoices(5, dataset);
  assert.equal(report.status, "candidate-evaluated");
  assert.equal(report.datasetCount, 610);
  assert.equal(report.provisionalReferenceCount, 305);
  assert.equal(report.confirmedReferenceCount, 305);
  assert.ok(report.test.referenceCohorts.some(row => row.referenceQuality === "provisional" && row.count > 0));
  assert.ok(report.split.embargoExcludedCount > 0);
  assert.equal(report.shadowArtifact?.promoted, false);
  assert.equal(report.promotion.enabled, false);
  assert.ok(report.test.pairedBrierDifference);
});

test("15-minute chronological partitions respect the seven-day span and settlement embargo", () => {
  const report = trainWaterxResearchChoices(15, choices(15, 680));
  assert.equal(report.status, "candidate-evaluated");
  assert.ok(report.spanMs >= 7 * 24 * 60 * 60_000);
  assert.ok(report.split.testFromMs! > report.split.calibrationThroughMs!);
  assert.ok(report.split.calibrationFromMs! > report.split.trainThroughMs!);
  assert.ok(report.split.embargoExcludedCount > 0);
});

test("missing Coinbase lookback, disputed labels, and late outcomes are never fitted", async () => {
  const dataset = choices(5, 610);
  dataset[0] = { ...dataset[0], comparisonSourceAtMs: dataset[0].decisionAtMs - 16_000 };
  const invalid = trainWaterxResearchChoices(5, dataset);
  assert.equal(invalid.rejectedCount, 1);
  const afterLock = { ...dataset[3], decisionAtMs: dataset[3].expiryMs };
  const lateDataset = choices(5, 610);
  lateDataset[3] = afterLock;
  const noOutcome = trainWaterxResearchChoices(5, lateDataset);
  assert.equal(noOutcome.rejectedCount, 1);
  assert.notEqual(noOutcome.datasetFingerprint, invalid.datasetFingerprint);

  const db = new FakeResearchDatabase();
  db.dataset = choices(5, 610);
  db.disputedRoundIds.add(db.dataset[0].roundId);
  db.invalidAvailabilityIds.add(db.dataset[1].roundId);
  db.unconfirmedLegacyAnchorIds.add(db.dataset[2].roundId);
  const result = await runResearchTrainingDay(db, 5, {
    now: () => Date.parse("2026-03-03T00:00:00Z"),
  });
  assert.equal(result.outcome, "trained");
  assert.equal(result.datasetCount, 608);
  assert.match(db.lastChoiceQuery, /l\.label_status='verified'\s+AND l\.settlement_disputed IS FALSE/);
  assert.doesNotMatch(db.lastChoiceQuery, /anchor_confirmed/);
});

test("training conditionally joins complete exact-choice feature supplements without rewriting choice evidence", async () => {
  const db = new FakeResearchDatabase();
  db.dataset = choices(5, 610);
  const selected = db.dataset[0];
  db.featureSupplementAvailable = true;
  db.incompleteComparisonIds.add(selected.roundId);
  const official = toPersistedChoice(selected);
  db.featureSupplements.set(
    selected.roundId,
    ((official.evidence as Record<string, unknown>).comparison as Record<string, unknown>),
  );
  let richRoundCount = 0;
  const result = await runResearchTrainingDay(db, 5, {
    now: () => Date.parse("2026-03-03T00:00:00Z"),
    train: (interval, rounds, onPhase) => {
      richRoundCount = rounds.length;
      return trainWaterxResearchChoices(interval, rounds, onPhase);
    },
  });
  assert.equal(result.outcome, "trained");
  assert.equal(richRoundCount, 610);
  assert.match(db.lastChoiceQuery, /jsonb_set\(c\.evidence,'\{comparison\}'/);
  assert.match(db.lastChoiceQuery, /fs\.decision_at_ms=c\.decision_at_ms/);
});

test("future settlement labels are not eligible before settlement and label availability", () => {
  const data = choices(5, 610);
  data[0] = { ...data[0], labelAvailableAtMs: data[0].settledAtMs - 1 };
  const report = trainWaterxResearchChoices(5, data);
  assert.equal(report.rejectedCount, 1);
});

test("daily runs persist start, trained/calibrated/test phases, fingerprint and shadow-only artifact exactly once", async () => {
  const db = new FakeResearchDatabase();
  db.dataset = choices(5, 610);
  db.dataset.push(...choices(15, 680));
  let now = Date.parse("2026-03-01T03:00:00Z");
  const result = await runResearchTrainingDay(db, 5, { now: () => now });
  assert.equal(result.outcome, "trained");
  assert.equal(result.datasetCount, 610);
  const row = db.runs.get("5:2026-03-01")!;
  assert.equal(row.status, "evaluated");
  assert.equal(row.dataset_count, 610);
  assert.match(String(row.dataset_fingerprint), /^[a-f0-9]{64}$/);
  const phases = JSON.parse(String(row.phases)) as { status: string }[];
  assert.deepEqual(phases.map(phase => phase.status), [
    "started", "canonical-calibrated", "canonical-evaluated", "training", "trained", "calibrating", "calibrated", "evaluating", "evaluated",
  ]);
  assert.equal((JSON.parse(String(row.artifact)) as { promoted: boolean }).promoted, false);
  assert.equal(db.lock, false);

  now += 60 * 60_000;
  const retry = await runResearchTrainingDay(db, 5, { now: () => now });
  assert.equal(retry.outcome, "not-due");
  assert.equal(db.runs.size, 1);
});

test("a restart on a new UTC date records a new insufficient attempt when evidence is not ready", async () => {
  const db = new FakeResearchDatabase();
  db.dataset = choices(5, 30);
  let now = Date.parse("2026-03-01T23:58:00Z");
  const first = await runResearchTrainingDay(db, 5, { now: () => now });
  assert.equal(first.outcome, "insufficient");
  now += 5 * 60_000;
  const afterRestart = await runResearchTrainingDay(db, 5, { now: () => now });
  assert.equal(afterRestart.outcome, "insufficient");
  assert.equal(db.runs.size, 2);
  assert.equal([...db.runs.values()].every(row => row.error === null), true);
});

test("a stale started row left by process death is recovered as failed before the next day runs", async () => {
  const db = new FakeResearchDatabase();
  db.dataset = choices(5, 30);
  db.runs.set("5:2026-03-01", {
    status: "started",
    started_at: new Date("2026-03-01T00:00:00Z"),
  });
  const result = await runResearchTrainingDay(db, 5, {
    now: () => Date.parse("2026-03-02T00:00:00Z"),
  });
  assert.equal(result.outcome, "insufficient");
  assert.equal(db.runs.get("5:2026-03-01")?.status, "failed");
  assert.match(String(db.runs.get("5:2026-03-01")?.reason), /stale_started_attempt_recovered/);
});

test("failed fit persists terminal failure and releases the shared session lease", async () => {
  const db = new FakeResearchDatabase();
  db.dataset = choices(5, 120);
  const result = await runResearchTrainingDay(db, 5, {
    now: () => Date.parse("2026-03-04T00:00:00Z"),
    train: () => { throw new Error("bounded fitting failed"); },
  });
  assert.equal(result.outcome, "failed");
  assert.equal(db.runs.get("5:2026-03-04")?.status, "failed");
  assert.equal(db.lock, false);
});

test("lease contention cannot begin a second training attempt", async () => {
  const db = new FakeResearchDatabase();
  db.lock = true;
  const result = await runResearchTrainingDay(db, 15, {
    now: () => Date.parse("2026-03-07T00:00:00Z"),
  });
  assert.equal(result.outcome, "lease-unavailable");
  assert.equal(db.runs.size, 0);
});

test("scheduled-status endpoint says autoscale cannot guarantee daily attempts", async () => {
  const db = new FakeResearchDatabase();
  const job = await getResearchDailyJob(5, { mode: "opportunistic-existing-process", db });
  assert.equal(job.guaranteesDailyExecution, false);
  assert.equal(job.mode, "opportunistic-existing-process");
});

test("opportunistic schedule wakes at startup and hourly but never claims continuous daily execution", async () => {
  const db = new FakeResearchDatabase();
  let intervalCallback: (() => void) | undefined;
  let cleared = false;
  const stop = startResearchSchedule({
    mode: "opportunistic-existing-process",
    db,
    intervalMs: 60_000,
    setInterval: (callback) => {
      intervalCallback = callback;
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => { cleared = true; },
  });
  const active = await getResearchDailyJob(5, { mode: "opportunistic-existing-process", db });
  assert.equal(active.guaranteesDailyExecution, false);
  assert.equal(active.configured, true);
  assert.equal(typeof intervalCallback, "function");
  await new Promise(resolve => setTimeout(resolve, 2));
  intervalCallback!();
  await new Promise(resolve => setTimeout(resolve, 2));
  stop();
  const inactive = await getResearchDailyJob(5, { mode: "opportunistic-existing-process", db });
  assert.equal(cleared, true);
  assert.equal(inactive.configured, false);
});

test("leased collector owns the research daily schedule and requires its session lock", async () => {
  const queries: string[] = [];
  const database = {
    async query<T = unknown>(sql: string): Promise<{ rows: T[] }> {
      queries.push(sql);
      if (sql.includes("to_regclass('waterx_learning_rounds')")) {
        return { rows: [{
          learning: "waterx_learning_rounds",
          ticks: "waterx_comparison_ticks",
          researchChoices: "waterx_research_choices",
          researchDaily: "waterx_research_daily_runs",
        } as T] };
      }
      if (sql.includes("pg_try_advisory_lock(95695,51515)"))
        return { rows: [{ acquired: true } as T] };
      if (sql.includes("FROM pg_locks"))
        return { rows: [{ lease_owned: true } as T] };
      throw new Error(`Unexpected worker query: ${sql}`);
    },
    async end() {},
  };
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const evaluated: number[] = [];
  const worker = await startWaterxWorker(database, {
    startPriceCapture: () => () => {},
    startWaterxCapture: () => () => {},
    candidateEvaluationEnabled: false,
    researchEvaluationEnabled: true,
    runResearchTraining: async (_db, interval) => {
      evaluated.push(interval);
      return { intervalMinutes: interval, outcome: "insufficient", reason: "test cohort too small" };
    },
    setInterval: ((callback: () => void, delay: number) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(evaluated, [5, 15]);
  assert.ok(timers.some(timer => timer.delay === 60 * 60_000));
  assert.match(queries[2], /pg_locks/);
  assert.equal(queries.some(sql => /\b(?:CREATE|ALTER|DROP)\b/i.test(sql)), false);
  await worker.stop();
});
