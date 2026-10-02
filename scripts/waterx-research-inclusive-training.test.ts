import assert from "node:assert/strict";
import test from "node:test";
import {
  choiceToCanonicalTrainingChoice,
  runResearchTrainingDay,
  type ResearchTrainingQueryable,
} from "../server/waterx/research-training";
import {
  trainCanonicalWaterxBaseline,
  type CanonicalTrainingChoice,
} from "../server/waterx/research-baseline-training";

function canonicalChoices(interval: 5 | 15, count: number): CanonicalTrainingChoice[] {
  const cadence = interval * 60_000;
  const base = Date.parse("2026-01-01T00:00:00Z");
  return Array.from({ length: count }, (_, index) => {
    const startMs = base + index * cadence;
    const up = index % 4 < 2;
    return {
      intervalMinutes: interval,
      roundId: `${interval}m-canonical-${index}`,
      startMs,
      expiryMs: startMs + cadence,
      decisionAtMs: startMs + cadence / 2,
      probabilityUp: up ? 0.57 : 0.43,
      outcome: up ? "UP" : "DOWN",
      settledAtMs: startMs + cadence + 1_000,
      labelAvailableAtMs: startMs + cadence + 1_200,
    };
  });
}

function persistedChoice(choice: CanonicalTrainingChoice): Record<string, unknown> {
  return {
    interval_minutes: choice.intervalMinutes,
    round_id: choice.roundId,
    start_ms: choice.startMs,
    expiry_ms: choice.expiryMs,
    decision_at_ms: choice.decisionAtMs,
    state: "FROZEN",
    probability_up: choice.probabilityUp,
    // Deliberately absent reference and Coinbase evidence: these are not
    // eligibility requirements for the canonical probability baseline.
    evidence: {
      reference: { quality: "unavailable" },
      market: { probabilityUp: 0.99 },
      comparison: { coverage: "missing" },
    },
    label_status: "verified",
    settlement_disputed: false,
    settlement_quarantine: null,
    settlement_anchor_price: 100,
    settle_price: choice.outcome === "UP" ? 101 : 99,
    outcome: choice.outcome,
    settled_at: choice.settledAtMs,
    settlement_observed_at: new Date(choice.labelAvailableAtMs),
  };
}

class DailyDatabase implements ResearchTrainingQueryable {
  readonly run = new Map<string, Record<string, unknown>>();
  rows: Record<string, unknown>[] = [];
  locked = false;

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount?: number | null }> {
    if (sql.includes("to_regclass('waterx_research_choices')"))
      return { rows: [{ choices: "choices", daily: "daily", rounds: "rounds" } as T] };
    if (sql.includes("to_regclass('waterx_research_feature_supplements')"))
      return { rows: [{ supplements: null } as T] };
    if (sql.includes("pg_try_advisory_lock(95695,51516)")) {
      if (this.locked) return { rows: [{ acquired: false } as T] };
      this.locked = true;
      return { rows: [{ acquired: true } as T] };
    }
    if (sql.includes("pg_advisory_unlock(95695,51516)")) {
      this.locked = false;
      return { rows: [{ unlocked: true } as T] };
    }
    if (sql.startsWith("SET ") || sql.startsWith("RESET ")) return { rows: [] };
    if (sql.includes("status='failed'")) return { rows: [] };
    if (sql.includes("INSERT INTO waterx_research_daily_runs")) {
      const key = `${values[0]}:${values[1]}`;
      if (this.run.has(key)) return { rows: [] };
      const started = new Date(String(values[2]));
      this.run.set(key, { started_at: started, status: "started" });
      return { rows: [{ started_at: started } as T] };
    }
    if (sql.includes("FROM waterx_research_choices"))
      return { rows: this.rows as T[] };
    if (sql.includes("UPDATE waterx_research_daily_runs SET phases")) return { rows: [] };
    if (sql.includes("SET status=$3")) {
      const key = `${values[0]}:${values[1]}`;
      const previous = this.run.get(key);
      if (!previous) return { rows: [] };
      this.run.set(key, {
        ...previous,
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
    throw new Error(`Unexpected daily training SQL: ${sql}`);
  }
}

test("canonical probability cohort includes verified frozen choices missing reference and Coinbase features", () => {
  const all = canonicalChoices(5, 610);
  const extracted = all.map(choice => choiceToCanonicalTrainingChoice(persistedChoice(choice)));
  assert.ok(extracted.every(Boolean));
  assert.equal(extracted[0]?.probabilityUp, all[0].probabilityUp);
  const richFeatureIds = new Set(all.slice(0, 400).map(choice => choice.roundId));
  const asOfMs = all.at(-1)!.labelAvailableAtMs + 60_000;
  const report = trainCanonicalWaterxBaseline(
    5,
    extracted.filter((row): row is CanonicalTrainingChoice => row !== null),
    { asOfMs, richFeatureRoundIds: richFeatureIds },
  );
  assert.equal(report.status, "candidate-evaluated");
  assert.equal(report.datasetCount, all.length);
  assert.equal(report.uniqueEligibleCount, all.length);
  assert.equal(report.missingFeatureChoices, 210);
  assert.equal(report.featureCoverage.richFeatureEligibleCount, 400);
  assert.ok(report.test.count >= 20);
  assert.equal(report.baselineArtifact?.probabilityField, "frozenChoice.probabilityUp");
  assert.equal(report.baselineArtifact?.promoted, false);
  assert.equal(report.promotion.enabled, false);
  assert.equal(report.test.bins.length, 10);
  assert.ok(report.test.pairedBrierDifference);
});

test("canonical cohort rejects future labels and disputed choices without requiring feature evidence", () => {
  const interval = 5;
  const base = canonicalChoices(interval, 3);
  const valid = persistedChoice(base[0]);
  const disputed = persistedChoice(base[1]);
  disputed.settlement_disputed = true;
  const future = persistedChoice(base[2]);
  future.settlement_observed_at = new Date(base[2].labelAvailableAtMs + 10_000);
  const extracted = [
    choiceToCanonicalTrainingChoice(valid),
    choiceToCanonicalTrainingChoice(disputed),
    choiceToCanonicalTrainingChoice(future),
  ];
  assert.ok(extracted[0]);
  assert.equal(extracted[1], null);
  assert.ok(extracted[2]);
  const report = trainCanonicalWaterxBaseline(
    interval,
    extracted.filter((row): row is CanonicalTrainingChoice => row !== null),
    { asOfMs: base[2].labelAvailableAtMs },
  );
  assert.equal(report.datasetCount, 2);
  assert.equal(report.uniqueEligibleCount, 1);
  assert.equal(report.rejectedCount, 1);
  assert.equal(report.status, "insufficient");
});

test("canonical calibrated baseline uses only the frozen probability field and chronological embargo", () => {
  const choices = canonicalChoices(15, 680);
  const report = trainCanonicalWaterxBaseline(15, choices, {
    asOfMs: choices.at(-1)!.labelAvailableAtMs + 1,
  });
  assert.equal(report.status, "candidate-evaluated");
  assert.equal(report.split.method.includes("frozenChoice.probabilityUp"), true);
  assert.ok(report.split.embargoExcludedCount > 0);
  assert.ok(report.split.calibrationFromMs! > report.split.trainThroughMs!);
  assert.ok(report.split.testFromMs! > report.split.calibrationThroughMs!);
  assert.equal(report.baselineArtifact?.probabilityField, "frozenChoice.probabilityUp");
  assert.ok(report.calibrationFit?.method.includes("frozenChoice.probabilityUp"));
});

test("daily persisted report retains every canonical choice and separates baseline artifact from rich artifact", async () => {
  const data = canonicalChoices(5, 610);
  const db = new DailyDatabase();
  db.rows = data.map(persistedChoice);
  const result = await runResearchTrainingDay(db, 5, {
    now: () => Date.parse("2026-03-01T00:00:00Z"),
  });
  assert.equal(result.outcome, "trained");
  assert.equal(result.datasetCount, data.length);
  const saved = db.run.get("5:2026-03-01")!;
  const report = JSON.parse(String(saved.report)) as {
    canonicalTraining: {
      datasetCount: number;
      uniqueEligibleCount: number;
      missingFeatureChoices: number;
      baselineArtifact: { promoted: boolean; probabilityField: string } | null;
    };
    shadowArtifact: unknown;
  };
  assert.equal(report.canonicalTraining.datasetCount, data.length);
  assert.equal(report.canonicalTraining.uniqueEligibleCount, data.length);
  assert.equal(report.canonicalTraining.missingFeatureChoices, data.length);
  assert.equal(report.canonicalTraining.baselineArtifact?.probabilityField, "frozenChoice.probabilityUp");
  assert.equal(report.canonicalTraining.baselineArtifact?.promoted, false);
  assert.equal(report.shadowArtifact, null);
  assert.equal(saved.artifact, null);
});