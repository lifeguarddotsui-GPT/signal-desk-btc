import test from "node:test";
import assert from "node:assert/strict";
import {
  captureWaterxCandidateSnapshot,
  runWaterxCandidateTraining,
  type CoinbaseCandidateTick,
  type WaterxCandidateCaptureInput,
  type WaterxCandidateQueryable,
} from "../server/waterx/candidate-runtime";
import {
  WATERX_CANDIDATE_ARTIFACT_VERSION,
  WATERX_CANDIDATE_FEATURE_SCHEMA,
  type WaterxProspectiveRoundRecord,
} from "../server/waterx/candidate-training";

const predictionAtMs = Date.UTC(2025, 0, 1, 0, 4);

function ticks(): CoinbaseCandidateTick[] {
  return Array.from({ length: 19 }, (_, index) => ({
    archiveId: `coinbase-${index}`,
    source: "Coinbase" as const,
    sourceAtMs: predictionAtMs - 180_000 + index * 10_000,
    receivedAtMs: predictionAtMs - 180_000 + index * 10_000 + 100,
    price: 100 + index * 0.01,
  }));
}

function captureInput(overrides: Partial<WaterxCandidateCaptureInput> = {}): WaterxCandidateCaptureInput {
  return {
    intervalMinutes: 5,
    roundId: "waterx-5m-123",
    source: "WaterX",
    startMs: predictionAtMs - 240_000,
    expiryMs: predictionAtMs + 60_000,
    predictionAtMs,
    confirmedAnchorPrice: 100,
    anchorConfirmed: true,
    marketProbabilityUp: 0.61,
    marketProbabilityObservedAtMs: predictionAtMs - 200,
    marketProbabilitySnapshot: {
      storage: "waterx_learning_rounds",
      intervalMinutes: 5,
      roundId: "waterx-5m-123",
      probabilityUp: 0.61,
      appObservedAtMs: predictionAtMs - 200,
      frozen: true,
    },
    firstFrozenMarketProbabilityUp: 0.61,
    firstFrozenMarketProbabilityAtMs: predictionAtMs - 200,
    comparisonArchive: {
      source: "Coinbase",
      archiveSource: "coinbase_ticks",
      status: "available",
      truncated: false,
      requestedStartMs: predictionAtMs - 180_000,
      requestedEndMs: predictionAtMs,
      ticks: ticks(),
    },
    ...overrides,
  };
}

function candidateArtifact(createdAt: number) {
  return {
    created_at: new Date(createdAt),
    artifact: {
      artifactVersion: WATERX_CANDIDATE_ARTIFACT_VERSION,
      modelVersion: `${WATERX_CANDIDATE_ARTIFACT_VERSION}:shadow-fixture`,
      intervalMinutes: 5,
      datasetFingerprint: "a".repeat(64),
      featureSchema: WATERX_CANDIDATE_FEATURE_SCHEMA,
      featureNames: [
        "marketProbabilityUp", "referenceDistanceBps", "timeRemainingFraction",
        "return1m", "return3m", "realizedVolatilityBps", "sourceAgeMs",
      ],
      means: [0, 0, 0, 0, 0, 0, 0],
      scales: [1, 1, 1, 1, 1, 1, 1],
      coefficients: [2, 0, 0, 0, 0, 0, 0],
      intercept: -1,
      calibration: { slope: 1, intercept: 0 },
    },
  };
}

test("captures sourced prospective features and persists exactly once without overwrite", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const db: WaterxCandidateQueryable = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("FROM waterx_learning_rounds")) return { rows: [{
        probability_up: 0.61,
        observed_at: new Date(predictionAtMs - 200),
        anchor_price: 100,
        anchor_confirmed: true,
      }] };
      if (sql.includes("FROM waterx_candidate_training_attempts")) return { rows: [] };
      const inserts = calls.filter(call =>
        call.sql.includes("INSERT INTO waterx_candidate_feature_snapshots")).length;
      return { rows: [{ before_expiry: true, inserted: inserts === 1 }] };
    },
  };
  const result = await captureWaterxCandidateSnapshot(captureInput(), db);
  assert.equal(result.status, "captured");
  if (result.status !== "captured") return;
  assert.ok(Math.abs(result.record.features.return1m - (100.17 / 100.12 - 1)) < 1e-12);
  assert.ok(Math.abs(result.record.features.return3m - (100.17 / 100 - 1)) < 1e-12);
  assert.equal(result.record.features.marketProbabilityUpDelta, 0);
  assert.equal(result.record.features.sourceAgeMs, 10_000);
  assert.equal(result.record.featureSchema, WATERX_CANDIDATE_FEATURE_SCHEMA);
  assert.match(calls[0].sql, /FROM waterx_learning_rounds/);
  assert.match(calls[2].sql, /ON CONFLICT \(interval_minutes,round_id\) DO NOTHING/);
  assert.equal(JSON.parse(String(calls[2].values?.[8])).label, null);
  assert.equal(JSON.parse(String(calls[2].values?.[8])).candidatePrediction, null);
  assert.equal(JSON.parse(String(calls[2].values?.[9])).marketProbabilitySnapshot.storage,
    "waterx_learning_rounds");

  const duplicate = await captureWaterxCandidateSnapshot(captureInput(), db);
  assert.equal(duplicate.status, "duplicate");
  assert.equal(calls.length, 6);
});

test("a previously persisted interval-matched artifact makes an immutable pre-settlement shadow prediction", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const trainingAt = predictionAtMs - 5_000;
  const db: WaterxCandidateQueryable = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("FROM waterx_learning_rounds")) return { rows: [{
        probability_up: 0.61,
        observed_at: new Date(predictionAtMs - 200),
        anchor_price: 100,
        anchor_confirmed: true,
      }] };
      if (sql.includes("FROM waterx_candidate_training_attempts")) {
        assert.match(sql, /created_at < to_timestamp/);
        return { rows: [candidateArtifact(trainingAt)] };
      }
      return { rows: [{ before_expiry: true, inserted: true }] };
    },
  };
  const result = await captureWaterxCandidateSnapshot(captureInput(), db);
  assert.equal(result.status, "captured");
  if (result.status !== "captured") return;
  assert.ok(result.record.candidatePrediction);
  assert.equal(result.record.candidatePrediction?.issuedAtMs, predictionAtMs);
  assert.equal(result.record.candidatePrediction?.trainingAttemptAtMs, trainingAt);
  assert.equal(result.record.candidatePrediction?.modelVersion,
    `${WATERX_CANDIDATE_ARTIFACT_VERSION}:shadow-fixture`);
  assert.ok(result.record.candidatePrediction!.probabilityUp > 0.5);
  const inserted = calls.find(call =>
    call.sql.includes("INSERT INTO waterx_candidate_feature_snapshots"));
  assert.ok(inserted);
  assert.equal(JSON.parse(String(inserted?.values?.[8])).candidatePrediction.modelVersion,
    result.record.candidatePrediction?.modelVersion);
  assert.equal(JSON.parse(String(inserted?.values?.[9])).candidatePredictionProvenance,
    "previously persisted, interval-matched candidate artifact; captured before expiry");
});

test("database expiry gate skips instead of inserting or claiming duplicate after a delayed read", async () => {
  const calls: string[] = [];
  const db: WaterxCandidateQueryable = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("FROM waterx_learning_rounds")) return { rows: [{
        probability_up: 0.61,
        observed_at: new Date(predictionAtMs - 200),
        anchor_price: 100,
        anchor_confirmed: true,
      }] };
      if (sql.includes("FROM waterx_candidate_training_attempts")) return { rows: [] };
      assert.match(sql, /clock_timestamp\(\) < to_timestamp\(\$4::double precision \/ 1000\.0\)/);
      return { rows: [{ before_expiry: false, inserted: false }] };
    },
  };
  const input = captureInput();
  assert.ok(input.predictionAtMs < input.expiryMs);
  const result = await captureWaterxCandidateSnapshot(input, db);
  assert.equal(result.status, "skipped");
  if (result.status === "skipped")
    assert.match(result.reason, /expired before the database insert/);
  assert.equal(calls.length, 3);
});

test("rejects odds that mismatch the frozen snapshot and revised in-round odds", async () => {
  const unusedDb: WaterxCandidateQueryable = {
    async query() { throw new Error("mismatched odds must not be persisted"); },
  };
  const mismatch = await captureWaterxCandidateSnapshot(captureInput({
    marketProbabilityUp: 0.62,
  }), unusedDb);
  assert.equal(mismatch.status, "skipped");
  if (mismatch.status === "skipped")
    assert.match(mismatch.reason, /immutable WaterX round snapshot/);

  const revisedOdds = 0.62;
  const revisedAt = predictionAtMs - 100;
  const revised = await captureWaterxCandidateSnapshot(captureInput({
    marketProbabilityUp: revisedOdds,
    marketProbabilityObservedAtMs: revisedAt,
    marketProbabilitySnapshot: {
      ...captureInput().marketProbabilitySnapshot,
      probabilityUp: revisedOdds,
      appObservedAtMs: revisedAt,
    },
  }), unusedDb);
  assert.equal(revised.status, "skipped");
  if (revised.status === "skipped")
    assert.match(revised.reason, /revised in-round odds are not eligible/);
});

test("rejects odds evidence that differs from the persisted app-observed WaterX snapshot", async () => {
  const db: WaterxCandidateQueryable = {
    async query(sql) {
      if (sql.includes("FROM waterx_learning_rounds")) return { rows: [{
        probability_up: 0.62,
        observed_at: new Date(predictionAtMs - 200),
        anchor_price: 100,
        anchor_confirmed: true,
      }] };
      throw new Error("candidate insert must not run for mismatched persisted odds");
    },
  };
  const result = await captureWaterxCandidateSnapshot(captureInput(), db);
  assert.equal(result.status, "skipped");
  if (result.status === "skipped")
    assert.match(result.reason, /do not match the persisted immutable first WaterX round observation/);
});

test("refuses partial, legacy, post-prediction, and gapped Coinbase evidence with explicit reasons", async () => {
  const unusedDb: WaterxCandidateQueryable = {
    async query() { throw new Error("must not persist a skipped snapshot"); },
  };
  const partial = await captureWaterxCandidateSnapshot(captureInput({
    comparisonArchive: { ...captureInput().comparisonArchive, status: "partial" },
  }), unusedDb);
  assert.equal(partial.status, "skipped");
  if (partial.status === "skipped") assert.match(partial.reason, /complete, untruncated/);

  const legacy = await captureWaterxCandidateSnapshot(captureInput({
    comparisonArchive: {
      ...captureInput().comparisonArchive,
      archiveSource: "legacy_snapshots" as "coinbase_ticks",
    },
  }), unusedDb);
  assert.equal(legacy.status, "skipped");
  if (legacy.status === "skipped") assert.match(legacy.reason, /Coinbase tick archive evidence/);

  const postPrediction = ticks();
  postPrediction[0] = { ...postPrediction[0], sourceAtMs: predictionAtMs + 1 };
  const lookahead = await captureWaterxCandidateSnapshot(captureInput({
    comparisonArchive: { ...captureInput().comparisonArchive, ticks: postPrediction },
  }), unusedDb);
  assert.equal(lookahead.status, "skipped");
  if (lookahead.status === "skipped") assert.match(lookahead.reason, /reach the three-minute/);

  const gapped = ticks().filter((_, index) => index !== 8);
  const gapResult = await captureWaterxCandidateSnapshot(captureInput({
    comparisonArchive: { ...captureInput().comparisonArchive, ticks: gapped },
  }), unusedDb);
  assert.equal(gapResult.status, "skipped");
  if (gapResult.status === "skipped") assert.match(gapResult.reason, /gap exceeding/);
});

test("missing candidate schema is an explicit migration error", async () => {
  const db: WaterxCandidateQueryable = {
    async query() { throw Object.assign(new Error("missing relation"), { code: "42P01" }); },
  };
  await assert.rejects(
    captureWaterxCandidateSnapshot(captureInput(), db),
    /Required WaterX learning\/candidate schema is missing/,
  );
});

function frozenRecord(index: number): WaterxProspectiveRoundRecord {
  const startMs = Date.UTC(2025, 0, 1) + index * 30 * 60_000;
  const expiryMs = startMs + 5 * 60_000;
  const outcome = index % 2 === 0 ? "Up" : "Down";
  return {
    intervalMinutes: 5,
    roundId: `frozen-${index}`,
    source: "WaterX",
    featureSchema: WATERX_CANDIDATE_FEATURE_SCHEMA,
    frozen: true,
    startMs,
    expiryMs,
    predictionAtMs: startMs + 1_000,
    featureSnapshotAtMs: startMs + 900,
    confirmedAnchorPrice: 100,
    marketProbabilityUp: 0.5,
    features: {
      referenceDistanceBps: index % 2 ? -3 : 3,
      timeRemainingFraction: 0.95,
      return1m: index % 2 ? -0.001 : 0.001,
      return3m: index % 2 ? -0.002 : 0.002,
      realizedVolatilityBps: 5 + index % 3,
      marketProbabilityUpDelta: index % 2 ? -0.01 : 0.01,
      sourceAgeMs: 200,
    },
    label: null,
  };
}

test("offline training reads only snapshot/verified-label join and persists two shadow attempts", async () => {
  const attempts: unknown[][] = [];
  const db: WaterxCandidateQueryable = {
    async query(sql, values) {
      if (sql.includes("FROM waterx_candidate_feature_snapshots s")) {
        assert.match(sql, /l\.label_status='verified'/);
        assert.match(sql, /l\.settlement_observed_at IS NOT NULL/);
        assert.match(sql, /l\.settlement_anchor_price=s\.confirmed_anchor_price/);
        assert.ok(sql.includes("settlement_quarantine='[]'::jsonb"));
        return {
          rows: Array.from({ length: 100 }, (_, index) => {
            const record = frozenRecord(index);
            return {
              record_data: record,
              settlement_anchor_price: 100,
              settle_price: index % 2 === 0 ? 100.1 : 99.9,
              outcome: index % 2 === 0 ? "Up" : "Down",
              settled_at: record.expiryMs + 1_000,
              settlement_observed_at: new Date(record.expiryMs + 30 * 60_000),
            };
          }),
        };
      }
      attempts.push(values ?? []);
      assert.match(sql, /INSERT INTO waterx_candidate_training_attempts/);
      assert.match(sql, /false\)/);
      return { rows: [] };
    },
  };
  const reports = await runWaterxCandidateTraining(db);
  assert.equal(reports.length, 2);
  assert.deepEqual(attempts.map(values => values[0]), [5, 15]);
  assert.ok(attempts.every(values => values[1] === reports[0].datasetFingerprint ||
    values[1] === reports[1].datasetFingerprint));
  assert.ok(attempts.every(values => values[5] === null || typeof values[5] === "string"));
  assert.ok(reports.every(report => report.promoted === false));
});