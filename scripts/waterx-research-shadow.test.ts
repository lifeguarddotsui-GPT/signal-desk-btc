import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import test from "node:test";
import {
  type ResearchChoice,
  WATERX_RESEARCH_POLICY,
} from "../shared/waterx-research";
import {
  captureResearchShadowPrediction,
  getResearchForwardEvaluation,
  type ResearchShadowQueryable,
} from "../server/waterx/research-shadow";
import {
  predictWaterxResearchShadow,
  trainWaterxResearchChoices,
  type ResearchShadowArtifact,
  type ResearchTrainingRound,
} from "../server/waterx/research-training-model";

function trainingRows(count: number): ResearchTrainingRound[] {
  const intervalMinutes = 5 as const;
  const cadence = intervalMinutes * 60_000;
  const base = Date.parse("2026-01-01T00:00:00Z");
  return Array.from({ length: count }, (_, index) => {
    const startMs = base + index * cadence;
    const decisionAtMs = startMs + cadence / 2;
    const up = index % 4 < 2;
    return {
      intervalMinutes,
      roundId: `research-${index}`,
      startMs,
      expiryMs: startMs + cadence,
      decisionAtMs,
      referenceObservedAtMs: decisionAtMs,
      marketObservedAtMs: decisionAtMs,
      probabilityUp: up ? 0.6 : 0.4,
      marketProbabilityUp: up ? 0.54 : 0.46,
      referencePrice: 95_000 + index * 0.2,
      referenceQuality: index % 2 ? "confirmed" : "provisional",
      comparisonPrice: 95_050 + index * 0.2,
      comparisonSourceAtMs: decisionAtMs - 1_000,
      comparisonReceivedAtMs: decisionAtMs - 750,
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

function genuineArtifact(): { artifact: ResearchShadowArtifact; report: Record<string, unknown>; finishedAt: number } {
  const training = trainWaterxResearchChoices(5, trainingRows(610));
  assert.equal(training.status, "candidate-evaluated");
  assert.ok(training.shadowArtifact);
  return {
    artifact: training.shadowArtifact!,
    report: training as unknown as Record<string, unknown>,
    finishedAt: training.evidenceAvailableThroughMs + 1_000,
  };
}

function choiceAt(nowMs: number): ResearchChoice {
  const checkpointAtMs = nowMs - 2_000;
  const decisionAtMs = nowMs - 1_000;
  const expiryMs = checkpointAtMs + 60_000;
  const startMs = expiryMs - 5 * 60_000;
  return {
    intervalMinutes: 5,
    roundId: `forward-${decisionAtMs}`,
    startMs,
    expiryMs,
    checkpointAtMs,
    decisionAtMs,
    state: "FROZEN",
    side: "UP",
    probabilityUp: 0.55,
    probabilityDown: 0.45,
    choiceSource: "market_baseline",
    modelVersion: null,
    calibrationVersion: null,
    policyVersion: WATERX_RESEARCH_POLICY.version,
    noChoiceCode: null,
    noChoiceReason: null,
    evidence: {
      reference: {
        price: 100_000,
        quality: "provisional",
        source: "WaterX",
        appObservedAtMs: decisionAtMs,
      },
      market: {
        probabilityUp: 0.55,
        probabilityDown: 0.45,
        appObservedAtMs: decisionAtMs,
        timestampKind: "app-observed",
      },
      comparison: {
        source: "Coinbase",
        price: 100_100,
        sourceAtMs: decisionAtMs - 1_000,
        receivedAtMs: decisionAtMs - 750,
        return1m: 0.002,
        return3m: -0.001,
        realizedVolatility: 0.001,
        tickCount: 13,
        coverage: "complete",
        reason: null,
      },
      qualityFlags: ["PROVISIONAL_REFERENCE"],
      tieBreakApplied: false,
    },
    settlement: {
      state: "pending",
      outcome: null,
      brier: null,
      logLoss: null,
      referenceDiscrepancyUsd: null,
      labelAvailableAt: null,
    },
  };
}

function reorderJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([key, nested]) => [key, reorderJson(nested)]));
}

type FakeState = {
  predictions: Map<string, Record<string, unknown>>;
  events: Map<string, Record<string, unknown>>;
};

class FakeShadowDatabase implements ResearchShadowQueryable {
  readonly state: FakeState = { predictions: new Map(), events: new Map() };
  readonly queries: { sql: string; values: unknown[] }[] = [];
  storedChoice: Record<string, unknown>;
  artifactRow: Record<string, unknown>;
  artifactRows: Record<string, unknown>[];
  featureSnapshot: Record<string, unknown> | null = null;
  evaluationRow: Record<string, unknown> = {};
  missingPredictionSchema = false;

  constructor(choice: ResearchChoice, artifact = genuineArtifact()) {
    this.storedChoice = JSON.parse(JSON.stringify({
      interval_minutes: choice.intervalMinutes,
      round_id: choice.roundId,
      start_ms: choice.startMs,
      expiry_ms: choice.expiryMs,
      checkpoint_at_ms: choice.checkpointAtMs,
      decision_at_ms: choice.decisionAtMs,
      state: choice.state,
      side: choice.side,
      probability_up: choice.probabilityUp,
      probability_down: choice.probabilityDown,
      choice_source: choice.choiceSource,
      policy_version: choice.policyVersion,
      evidence: choice.evidence,
    }));
    this.artifactRow = {
      interval_minutes: 5,
      status: "evaluated",
      finished_at: new Date(artifact.finishedAt),
      dataset_fingerprint: artifact.artifact.datasetFingerprint,
      artifact: JSON.parse(JSON.stringify(artifact.artifact)),
      report: JSON.parse(JSON.stringify(artifact.report)),
    };
    this.artifactRows = [this.artifactRow];
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount?: number | null }> {
    this.queries.push({ sql, values });
    if (this.missingPredictionSchema && sql.includes("waterx_research_shadow_predictions"))
      throw Object.assign(new Error("missing research shadow table"), { code: "42P01" });
    if (sql.includes("FROM waterx_research_choices") &&
        sql.includes("WHERE interval_minutes=$1 AND round_id=$2"))
      return { rows: [this.storedChoice as T] };
    if (sql.includes("FROM waterx_research_feature_supplements"))
      return { rows: this.featureSnapshot
        ? [{ feature_snapshot: this.featureSnapshot } as T] : [] };
    if (sql.includes("FROM waterx_research_daily_runs"))
      return { rows: this.artifactRows.filter(row =>
        row.finished_at instanceof Date && row.finished_at.getTime() < Number(values[1]))
        .slice(0, 2) as T[] };
    if (sql.includes("INSERT INTO waterx_research_shadow_predictions")) {
      const key = `${String(values[0])}:${String(values[1])}:${String(values[2])}`;
      if (this.state.predictions.has(key)) return { rows: [] };
      const observedAt = Number(values[5]);
      const decisionAt = Number(values[6]);
      if (observedAt < decisionAt || observedAt >= Number(values[11]) ||
          observedAt > Number(values[12]))
        return { rows: [] };
      const prediction = {
        interval_minutes: values[0],
        round_id: values[1],
        artifact_version: values[2],
        probability_up: values[3],
        baseline_probability_up: values[4],
        observed_at_ms: values[5],
        decision_at_ms: values[6],
        model_version: values[2],
        calibration_version: values[7],
        dataset_fingerprint: values[8],
        features: JSON.parse(String(values[9])),
        evidence: JSON.parse(String(values[10])),
      };
      this.state.predictions.set(key, prediction);
      return { rows: [{ artifact_version: values[2] } as T] };
    }
    if (sql.includes("SELECT artifact_version") &&
        sql.includes("FROM waterx_research_shadow_predictions")) {
      const key = `${String(values[0])}:${String(values[1])}:${String(values[2])}`;
      const prediction = this.state.predictions.get(key);
      return { rows: prediction ? [{ artifact_version: prediction.artifact_version } as T] : [] };
    }
    if (sql.includes("INSERT INTO waterx_research_capture_events")) {
      const key = `${String(values[0])}:${String(values[2])}:${String(values[4])}`;
      if (!this.state.events.has(key))
        this.state.events.set(key, {
          interval_minutes: values[0],
          round_id: values[1],
          start_ms: values[2],
          expiry_ms: values[3],
          stage: "shadow_forward_prediction",
          code: values[4],
          reason: values[5],
          details: JSON.parse(String(values[6])),
        });
      return { rows: [] };
    }
    if (sql.includes("WITH recorded AS MATERIALIZED"))
      return { rows: [this.evaluationRow as T] };
    throw new Error(`Unexpected shadow SQL: ${sql}`);
  }
}

function alternateArtifactRow(
  source: ReturnType<typeof genuineArtifact>,
  fingerprintChar: string,
  finishedAt: number,
): Record<string, unknown> {
  const fingerprint = fingerprintChar.repeat(64);
  const artifact = JSON.parse(JSON.stringify(source.artifact)) as ResearchShadowArtifact;
  artifact.datasetFingerprint = fingerprint;
  artifact.version = `waterx-research-shadow-v2:5:${fingerprint.slice(0, 16)}`;
  artifact.coefficients[0] += fingerprintChar === "b" ? 0.01 : 0.02;
  const report = JSON.parse(JSON.stringify(source.report)) as Record<string, unknown>;
  report.datasetFingerprint = fingerprint;
  report.shadowArtifact = artifact;
  return {
    interval_minutes: 5,
    status: "evaluated",
    finished_at: new Date(finishedAt),
    dataset_fingerprint: fingerprint,
    artifact,
    report,
  };
}

test("forward capture uses real daily artifact coefficients and JSONB-normalized frozen evidence", async () => {
  const now = Date.now();
  const choice = choiceAt(now);
  const db = new FakeShadowDatabase(choice);
  // Simulate node-postgres JSONB normalization (object key ordering differs
  // from the originally constructed choice; inference uses only stored proof).
  db.storedChoice.evidence = JSON.stringify(reorderJson(choice.evidence));
  db.artifactRow.artifact = JSON.stringify(reorderJson(db.artifactRow.artifact));
  db.artifactRow.report = JSON.stringify(reorderJson(db.artifactRow.report));
  await captureResearchShadowPrediction(choice, db);
  assert.equal(db.state.predictions.size, 1);
  const prediction = [...db.state.predictions.values()][0];
  const features = prediction.features as Record<string, number>;
  assert.ok(Math.abs(features.realizedVolatilityBps - 10) < 1e-10);
  assert.ok(Math.abs(features.referenceDistanceBps - 10) < 1e-10);
  assert.equal(prediction.baseline_probability_up, 0.55);
  const artifact = JSON.parse(String(db.artifactRow.artifact)) as ResearchShadowArtifact;
  const expected = predictWaterxResearchShadow(artifact, features as never);
  assert.equal(prediction.probability_up, expected);
  assert.equal(prediction.model_version, artifact.version);
  assert.equal(prediction.calibration_version, `${artifact.version}:platt`);
  assert.equal(prediction.dataset_fingerprint, artifact.datasetFingerprint);
  assert.equal((prediction.evidence as Record<string, unknown>).choice !== undefined, true);
  assert.equal((prediction.evidence as Record<string, unknown>).artifact !== undefined, true);
  assert.equal(db.state.events.size, 0);
  assert.equal(db.queries.some(query => /\bUPDATE\b/i.test(query.sql)), false);

  const immutableSnapshot = JSON.stringify(prediction);
  await captureResearchShadowPrediction(choice, db);
  assert.equal(db.state.predictions.size, 1);
  assert.equal(JSON.stringify([...db.state.predictions.values()][0]), immutableSnapshot);
});

test("shadow capture consumes a persisted exact-choice supplement while retaining original raw evidence", async () => {
  const now = Date.now();
  const choice = choiceAt(now);
  const db = new FakeShadowDatabase(choice);
  const originalEvidence = JSON.parse(JSON.stringify(choice.evidence)) as Record<string, unknown>;
  originalEvidence.comparison = {
    source: "Coinbase", price: null, sourceAtMs: null, receivedAtMs: null,
    return1m: null, return3m: null, realizedVolatility: null,
    tickCount: 0, coverage: "unavailable", reason: "captured after commit",
  };
  db.storedChoice.evidence = originalEvidence;
  db.featureSnapshot = { comparison: choice.evidence.comparison, ticks: [] };
  await captureResearchShadowPrediction(choice, db);
  assert.equal(db.state.predictions.size, 1);
  assert.equal(db.state.events.size, 0);
  const query = db.queries.find(item => item.sql.includes("FROM waterx_research_feature_supplements"));
  assert.ok(query);
  assert.deepEqual(originalEvidence.reference, choice.evidence.reference);
  assert.deepEqual(originalEvidence.market, choice.evidence.market);
});

test("forward capture records current and previous eligible rich artifacts for the same immutable choice", async () => {
  const now = Date.now();
  const choice = choiceAt(now);
  const valid = genuineArtifact();
  const db = new FakeShadowDatabase(choice, valid);
  const current = alternateArtifactRow(valid, "b", choice.decisionAtMs - 2_000);
  const previous = alternateArtifactRow(valid, "c", choice.decisionAtMs - 4_000);
  db.artifactRows = [current, previous];
  await captureResearchShadowPrediction(choice, db);
  assert.equal(db.state.predictions.size, 2);
  const predictions = [...db.state.predictions.values()];
  assert.deepEqual(new Set(predictions.map(row => row.artifact_version)),
    new Set([current.artifact && (current.artifact as ResearchShadowArtifact).version,
      previous.artifact && (previous.artifact as ResearchShadowArtifact).version]));
  assert.ok(predictions.every(row =>
    row.round_id === choice.roundId &&
    row.baseline_probability_up === choice.evidence.market.probabilityUp &&
    row.decision_at_ms === choice.decisionAtMs));
  assert.equal(db.state.events.size, 0);
});

test("a malformed previous artifact does not roll back the valid current shadow candidate", async () => {
  const now = Date.now();
  const choice = choiceAt(now);
  const valid = genuineArtifact();
  const db = new FakeShadowDatabase(choice, valid);
  const current = alternateArtifactRow(valid, "b", choice.decisionAtMs - 2_000);
  const malformed = alternateArtifactRow(valid, "c", choice.decisionAtMs - 4_000);
  (malformed.artifact as ResearchShadowArtifact).coefficients = [];
  db.artifactRows = [current, malformed];
  await captureResearchShadowPrediction(choice, db);
  assert.equal(db.state.predictions.size, 1);
  assert.equal([...db.state.predictions.values()][0].artifact_version,
    (current.artifact as ResearchShadowArtifact).version);
  assert.ok(db.state.events.size >= 1);
});

test("future-finished artifact is ignored and its reason is durably captured", async () => {
  const now = Date.now();
  const choice = choiceAt(now);
  const artifact = genuineArtifact();
  artifact.finishedAt = choice.decisionAtMs + 1;
  const db = new FakeShadowDatabase(choice, artifact);
  await captureResearchShadowPrediction(choice, db);
  assert.equal(db.state.predictions.size, 0);
  assert.match(String([...db.state.events.values()][0]?.code), /SHADOW_ARTIFACT_UNAVAILABLE/);
  assert.equal(db.state.events.size, 1);
});

test("incomplete or future-dated features cannot create a shadow prediction", async () => {
  const now = Date.now();
  const choice = choiceAt(now);
  choice.evidence.comparison.coverage = "partial";
  const db = new FakeShadowDatabase(choice);
  db.storedChoice.evidence = JSON.parse(JSON.stringify(choice.evidence));
  await captureResearchShadowPrediction(choice, db);
  assert.equal(db.state.predictions.size, 0);
  assert.equal([...db.state.events.values()][0]?.code, "INVALID_POINT_IN_TIME_FEATURES");
  assert.match(String([...db.state.events.values()][0]?.reason), /complete/);

  const futureChoice = choiceAt(Date.now());
  futureChoice.evidence.reference.appObservedAtMs = futureChoice.decisionAtMs + 1;
  const futureDb = new FakeShadowDatabase(futureChoice);
  futureDb.storedChoice.evidence = JSON.parse(JSON.stringify(futureChoice.evidence));
  await captureResearchShadowPrediction(futureChoice, futureDb);
  assert.equal(futureDb.state.predictions.size, 0);
  assert.equal([...futureDb.state.events.values()][0]?.code, "INVALID_POINT_IN_TIME_FEATURES");
});

test("a non-market official choice is never replaced by shadow inference", async () => {
  const choice = choiceAt(Date.now());
  const modelChoice = {
    ...choice,
    choiceSource: "bluewaterai_model" as const,
    modelVersion: "unpromoted-version",
    calibrationVersion: "unpromoted-calibration",
  };
  const db = new FakeShadowDatabase(modelChoice);
  const originalOfficialChoice = JSON.stringify(db.storedChoice);
  await captureResearchShadowPrediction(modelChoice, db);
  assert.equal(db.state.predictions.size, 0);
  assert.equal(JSON.stringify(db.storedChoice), originalOfficialChoice);
  assert.equal([...db.state.events.values()][0]?.code, "CHOICE_NOT_BASELINE");
});

test("post-close or post-checkpoint-grace attempts are event-only", async () => {
  const now = Date.now();
  const choice = choiceAt(now - 20_000);
  const db = new FakeShadowDatabase(choice);
  await captureResearchShadowPrediction(choice, db);
  assert.equal(db.state.predictions.size, 0);
  assert.equal([...db.state.events.values()][0]?.code, "SHADOW_CAPTURE_TOO_LATE");
});

test("model inference verifies artifact training evidence availability precedes finish and decision", async () => {
  const now = Date.now();
  const choice = choiceAt(now);
  const artifact = genuineArtifact();
  artifact.artifact.evidenceAvailableThroughMs = choice.decisionAtMs + 1;
  artifact.finishedAt = choice.decisionAtMs - 1;
  const db = new FakeShadowDatabase(choice, artifact);
  await captureResearchShadowPrediction(choice, db);
  assert.equal(db.state.predictions.size, 0);
  assert.equal([...db.state.events.values()][0]?.code, "SHADOW_ARTIFACT_INVALID");
});

test("artifact evidence chronology cannot exceed either its finish timestamp or choice decision", async () => {
  const choice = choiceAt(Date.now());
  const source = genuineArtifact();
  const artifact = {
    ...source.artifact,
    evidenceAvailableThroughMs: source.finishedAt + 1,
  };
  const report = {
    ...source.report,
    shadowArtifact: artifact,
  };
  const db = new FakeShadowDatabase(choice, {
    artifact,
    report,
    finishedAt: source.finishedAt,
  });
  await captureResearchShadowPrediction(choice, db);
  assert.equal(db.state.predictions.size, 0);
  assert.equal([...db.state.events.values()][0]?.code, "SHADOW_ARTIFACT_INVALID");
});

test("forward report aggregates recorded/scored N and matched candidate/baseline calibration only", async () => {
  const db = new FakeShadowDatabase(choiceAt(Date.now()));
  db.evaluationRow = {
    recorded_n: "3",
    scored_n: "2",
    disputed_excluded_n: "1",
    candidate_brier: "0.16",
    candidate_log_loss: "0.44",
    candidate_calibration: JSON.stringify([{
      lower: 0.5, upper: 0.6, n: 2, predictedUpMean: 0.55, observedUpRate: 0.5,
    }]),
    baseline_brier: "0.20",
    baseline_log_loss: "0.53",
    baseline_calibration: [{
      lower: 0.5, upper: 0.6, n: 2, predictedUpMean: 0.55, observedUpRate: 0.5,
    }],
  };
  const report = await getResearchForwardEvaluation(5, db);
  assert.equal(report.schemaStatus, "available");
  assert.equal(report.recordedN, 3);
  assert.equal(report.scoredN, 2);
  assert.equal(report.unscoredN, 1);
  assert.equal(report.disputedExcludedN, 1);
  assert.equal(report.candidate.brier, 0.16);
  assert.equal(report.marketBaseline.logLoss, 0.53);
  assert.equal(report.marketBaseline.calibration[0].n, 2);
  assert.equal(report.shadowOnly, true);
  const sql = db.queries.at(-1)!.sql;
  assert.match(sql, /label_status='verified'/);
  assert.match(sql, /settlement_disputed IS FALSE/);
  assert.match(sql, /c\.interval_minutes=p\.interval_minutes AND c\.round_id=p\.round_id/);
  assert.match(sql, /l\.start_ms=c\.start_ms AND l\.expiry_ms=c\.expiry_ms/);
  assert.match(sql, /first_verified_at >= to_timestamp\(settled_at/);
  assert.match(sql, /first_verified_at <= clock_timestamp\(\)/);
  assert.match(sql, /settled_at <= floor\(extract\(epoch FROM clock_timestamp/);
  assert.doesNotMatch(sql, /label_status='settled'/);
});

test("missing shadow schema degrades to event/DTO status without throwing or changing choice", async () => {
  const choice = choiceAt(Date.now());
  const db = new FakeShadowDatabase(choice);
  db.missingPredictionSchema = true;
  await assert.doesNotReject(captureResearchShadowPrediction(choice, db));
  assert.equal(db.state.predictions.size, 0);
  const evaluation = await getResearchForwardEvaluation(5, db);
  assert.equal(evaluation.schemaStatus, "unavailable");
  assert.equal(evaluation.shadowOnly, true);
});

test("migration declares keyed immutable predictions with database-side timeliness enforcement", async () => {
  const migration = await readFile("migrations/waterx-research-shadow.sql", "utf8");
  assert.match(migration, /PRIMARY KEY \(interval_minutes,round_id,artifact_version\)/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON waterx_research_shadow_predictions/);
  assert.match(migration, /BEFORE INSERT ON waterx_research_shadow_predictions/);
  assert.match(migration, /frozen_checkpoint_ms\s*\+\s*15000/i);
  assert.match(migration, /frozen_expiry_ms/);
  assert.match(migration, /artifact_evidence_available_ms/);
});

const shadowTestDatabaseUrl = process.env.WATERX_REFERENCE_CONFIRMATION_TEST_DATABASE_URL;
const safeShadowTestDatabase = (() => {
  if (!shadowTestDatabaseUrl) return false;
  try {
    const url = new URL(shadowTestDatabaseUrl);
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      /waterx_reference_test$/.test(url.pathname) &&
      !/production/i.test(url.pathname);
  } catch {
    return false;
  }
})();

test("isolated loopback PostgreSQL applies research migrations and enforces real shadow inference provenance", {
  skip: safeShadowTestDatabase
    ? false
    : "Requires disposable loopback waterx_reference_test DB; never uses app or production DB.",
}, async () => {
  const pool = new pg.Pool({ connectionString: shadowTestDatabaseUrl, max: 1 });
  const client = await pool.connect();
  const schema = `waterx_shadow_test_${process.pid}`;
  try {
    const fixture = genuineArtifact();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`CREATE TABLE waterx_learning_rounds (
      interval_minutes smallint NOT NULL, round_id text NOT NULL,
      start_ms bigint NOT NULL, expiry_ms bigint NOT NULL,
      label_status text, outcome text, settlement_disputed boolean DEFAULT false,
      settlement_quarantine jsonb, settlement_anchor_price numeric, settle_price numeric,
      settled_at bigint, settlement_observed_at timestamptz, first_verified_at timestamptz,
      PRIMARY KEY(interval_minutes,round_id))`);
    await client.query(await readFile(
      new URL("../migrations/waterx-research.sql", import.meta.url), "utf8",
    ));
    await client.query(await readFile(
      new URL("../migrations/waterx-research-shadow.sql", import.meta.url), "utf8",
    ));

    const choice = choiceAt(Date.now());
    await client.query(
      `INSERT INTO waterx_research_choices
        (interval_minutes,round_id,start_ms,expiry_ms,checkpoint_at_ms,decision_at_ms,
         state,side,probability_up,probability_down,choice_source,model_version,
         calibration_version,policy_version,no_choice_code,no_choice_reason,evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
      [choice.intervalMinutes, choice.roundId, choice.startMs, choice.expiryMs,
        choice.checkpointAtMs, choice.decisionAtMs, choice.state, choice.side,
        choice.probabilityUp, choice.probabilityDown, choice.choiceSource,
        choice.modelVersion, choice.calibrationVersion, choice.policyVersion,
        choice.noChoiceCode, choice.noChoiceReason,
        JSON.stringify(reorderJson(choice.evidence))],
    );
    await client.query(
      `INSERT INTO waterx_research_daily_runs
        (interval_minutes,scheduled_day,status,finished_at,dataset_fingerprint,
         dataset_count,report,artifact)
       VALUES (5,CURRENT_DATE,'evaluated',to_timestamp($1::double precision/1000),
         $2,610,$3::jsonb,$4::jsonb)`,
      [fixture.finishedAt, fixture.artifact.datasetFingerprint,
        JSON.stringify(fixture.report), JSON.stringify(fixture.artifact)],
    );
    const liveDb = {
      query: async (sql: string, values?: unknown[]) => {
        try {
          return await client.query(sql, values);
        } catch (error) {
          const diagnostic = error as { code?: unknown; message?: unknown };
          console.error("[shadow PG integration] query failed:",
            diagnostic.code ?? "unknown", diagnostic.message ?? "unknown error");
          throw error;
        }
      },
    } as ResearchShadowQueryable;
    await captureResearchShadowPrediction(choice, liveDb);
    const predictionResult = await client.query(
      `SELECT * FROM waterx_research_shadow_predictions
        WHERE interval_minutes=5 AND round_id=$1`,
      [choice.roundId],
    );
    const predictionErrors = await client.query(
      `SELECT code,reason FROM waterx_research_capture_events
        WHERE interval_minutes=5 AND round_id=$1`,
      [choice.roundId],
    );
    assert.equal(predictionResult.rowCount, 1,
      predictionErrors.rows.map(row => `${row.code}: ${row.reason}`).join("; ") ||
        "No shadow prediction row was inserted.");
    const prediction = predictionResult.rows[0];
    assert.equal(Number(prediction.probability_up),
      predictWaterxResearchShadow(fixture.artifact, prediction.features));
    assert.equal(Number(prediction.baseline_probability_up), 0.55);
    assert.equal(prediction.features.realizedVolatilityBps, 10);
    assert.equal(prediction.evidence.reference.source, "WaterX");
    assert.equal(prediction.evidence.artifact.version, fixture.artifact.version);
    assert.equal((await client.query(
      `SELECT evidence FROM waterx_research_choices
        WHERE interval_minutes=5 AND round_id=$1`,
      [choice.roundId],
    )).rows[0].evidence.market.probabilityUp, 0.55);

    await assert.rejects(
      client.query(
        `UPDATE waterx_research_shadow_predictions SET probability_up=0.01
          WHERE interval_minutes=5 AND round_id=$1`,
        [choice.roundId],
      ),
      /immutable/,
    );
    await assert.rejects(
      client.query(
        `DELETE FROM waterx_research_shadow_predictions
          WHERE interval_minutes=5 AND round_id=$1`,
        [choice.roundId],
      ),
      /immutable/,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO waterx_research_shadow_predictions
          (interval_minutes,round_id,artifact_version,probability_up,
           baseline_probability_up,observed_at_ms,decision_at_ms,model_version,
           calibration_version,dataset_fingerprint,features,evidence)
         SELECT interval_minutes,round_id,artifact_version,probability_up,
                baseline_probability_up,$2,decision_at_ms,model_version,
                calibration_version,dataset_fingerprint,features,evidence
           FROM waterx_research_shadow_predictions
          WHERE interval_minutes=5 AND round_id=$1`,
        [choice.roundId, choice.checkpointAtMs + WATERX_RESEARCH_POLICY.checkpointGraceMs + 1],
      ),
      /cannot be backfilled after expiry or checkpoint grace/,
    );

    await client.query(
      `INSERT INTO waterx_learning_rounds
        (interval_minutes,round_id,start_ms,expiry_ms,label_status,outcome,
         settlement_disputed,settlement_quarantine,settlement_anchor_price,
         settle_price,settled_at,settlement_observed_at,first_verified_at)
       VALUES (5,$1,$2,$3,'verified','Up',false,'[]'::jsonb,100000,100100,
         $4::bigint,to_timestamp($4::bigint::double precision/1000),
         to_timestamp($4::bigint::double precision/1000))`,
      [choice.roundId, choice.startMs, choice.expiryMs, choice.expiryMs + 1_000],
    );
    const forward = await getResearchForwardEvaluation(5, liveDb);
    assert.equal(forward.schemaStatus, "available", forward.reason ?? undefined);
    assert.equal(forward.recordedN, 1);
    assert.equal(forward.scoredN, 0);

    const futureChoice = choiceAt(Date.now());
    await client.query(
      `INSERT INTO waterx_research_choices
        (interval_minutes,round_id,start_ms,expiry_ms,checkpoint_at_ms,decision_at_ms,
         state,side,probability_up,probability_down,choice_source,model_version,
         calibration_version,policy_version,no_choice_code,no_choice_reason,evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
      [futureChoice.intervalMinutes, futureChoice.roundId, futureChoice.startMs,
        futureChoice.expiryMs, futureChoice.checkpointAtMs, futureChoice.decisionAtMs,
        futureChoice.state, futureChoice.side, futureChoice.probabilityUp,
        futureChoice.probabilityDown, futureChoice.choiceSource, futureChoice.modelVersion,
        futureChoice.calibrationVersion, futureChoice.policyVersion,
        futureChoice.noChoiceCode, futureChoice.noChoiceReason,
        JSON.stringify(reorderJson(futureChoice.evidence))],
    );
    await client.query("DELETE FROM waterx_research_daily_runs WHERE interval_minutes=5");
    await client.query(
      `INSERT INTO waterx_research_daily_runs
        (interval_minutes,scheduled_day,status,finished_at,dataset_fingerprint,
         dataset_count,report,artifact)
       VALUES (5,CURRENT_DATE,'evaluated',to_timestamp($1::double precision/1000),
         $2,610,$3::jsonb,$4::jsonb)`,
      [futureChoice.decisionAtMs + 1_000, fixture.artifact.datasetFingerprint,
        JSON.stringify(fixture.report), JSON.stringify(fixture.artifact)],
    );
    await captureResearchShadowPrediction(futureChoice, liveDb);
    assert.equal((await client.query(
      `SELECT COUNT(*)::integer AS n FROM waterx_research_shadow_predictions
        WHERE interval_minutes=5 AND round_id=$1`,
      [futureChoice.roundId],
    )).rows[0].n, 0);
    const rejected = await client.query(
      `SELECT code FROM waterx_research_capture_events
        WHERE interval_minutes=5 AND round_id=$1`,
      [futureChoice.roundId],
    );
    assert.equal(rejected.rows[0].code, "SHADOW_ARTIFACT_UNAVAILABLE");
  } finally {
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  }
});
