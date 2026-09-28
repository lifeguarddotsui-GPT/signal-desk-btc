import test from "node:test";
import assert from "node:assert/strict";
import {
  BTC_FEATURE_SCHEMA,
  createBtcArtifact,
  inferBtcArtifact,
  parseBtcArtifact,
  serializeBtcArtifact,
  type ArtifactInput,
  type InferenceInput,
} from "../server/btc/artifact";

function artifactFixture(): ArtifactInput {
  return {
    format: "btc-logistic-artifact",
    artifactVersion: 1,
    modelVersion: `btc-shadow-logistic-v1-${"c".repeat(24)}`,
    status: "shadow_only",
    featureSchema: BTC_FEATURE_SCHEMA,
    scaling: {
      fitOn: "training_only",
      means: [0, 60, 0, 0.001, 0.1, 0.05],
      scales: [1, 30, 0.001, 0.0005, 0.3, 0.2],
      standardizedValueClamp: 8,
    },
    missingValueRules: {
      nullableFeatures: ["comparisonReturn", "realizedVolatility"],
      imputation: "zero",
      indicators: ["comparisonReturnMissing", "realizedVolatilityMissing"],
    },
    logistic: {
      intercept: 0.1,
      weights: [0.4, -0.02, 0.3, -0.1, 0.05, 0.02],
    },
    plattCalibration: {
      slope: 0.9,
      intercept: -0.05,
      fitOn: "separate_calibration_window",
    },
    provenance: {
      trainingDataHash: "a".repeat(64),
      trainingDataVersion: "fixture-v1",
      trainingCutoffMs: 1_735_689_600_000,
      trainingRowCount: 120,
      calibrationDataHash: "b".repeat(64),
      calibrationDataVersion: "fixture-v1",
      calibrationCutoffMs: 1_735_700_000_000,
      calibrationRowCount: 40,
      method: "Test fixture only; not fitted model evidence",
      labelDefinition: "Fixture UP/DOWN outcome",
      evidenceStatus: "shadow_only_not_promoted",
    },
  };
}

function inputFixture(): InferenceInput {
  return {
    decisionTimeMs: 1_735_710_000_000,
    features: {
      indicativeUp: { value: 0.62, atMs: 1_735_709_900_000 },
      remainingSeconds: { value: 45, atMs: 1_735_709_900_000 },
      comparisonReturn: { value: 0.0002, atMs: 1_735_709_850_000 },
      realizedVolatility: { value: 0.0012, atMs: 1_735_709_800_000 },
    },
  };
}

test("artifact round-trips canonically and produces deterministic immutable inference", () => {
  const frozen = createBtcArtifact(artifactFixture());
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.scaling.means));
  const serialized = serializeBtcArtifact(frozen);
  const restored = parseBtcArtifact(serialized);
  assert.equal(serializeBtcArtifact(restored), serialized);
  const first = inferBtcArtifact(restored, inputFixture());
  const second = inferBtcArtifact(restored, inputFixture());
  assert.deepEqual(first, inferBtcArtifact(frozen, inputFixture()));
  assert.deepEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.featureNames));
  assert.ok(first.probabilityUp > 0 && first.probabilityUp < 1);
  assert.deepEqual(first.featureNames, BTC_FEATURE_SCHEMA.map(feature => feature.name));
  assert.throws(() => {
    (restored.scaling.means as number[])[0] = 999;
  }, TypeError);
});

test("JSONB-style sorted schema object keys parse while feature array reordering stays invalid", () => {
  const input = artifactFixture();
  const jsonbStyleSchema = JSON.parse(JSON.stringify(input.featureSchema.map(feature =>
    Object.fromEntries(Object.entries(feature).sort(([left], [right]) => left.localeCompare(right))))));
  const restored = parseBtcArtifact(JSON.stringify({ ...input, featureSchema: jsonbStyleSchema }));
  assert.deepEqual(restored.featureSchema, BTC_FEATURE_SCHEMA);
  assert.deepEqual(
    inferBtcArtifact(restored, inputFixture()),
    inferBtcArtifact(createBtcArtifact(input), inputFixture()),
  );

  const reordered = {
    ...input,
    featureSchema: JSON.parse(JSON.stringify(jsonbStyleSchema.reverse())),
  } as unknown as ArtifactInput;
  assert.throws(() => parseBtcArtifact(JSON.stringify(reordered)), /schema or feature order/);
});

test("feature observations later than decision time are rejected", () => {
  const input = inputFixture();
  input.features.comparisonReturn.atMs = input.decisionTimeMs + 1;
  assert.throws(
    () => inferBtcArtifact(createBtcArtifact(artifactFixture()), input),
    /later than decision time/,
  );
});

test("invalid, nonfinite, out-of-schema, and falsely promoted artifacts are rejected", () => {
  const invalidWeight = artifactFixture();
  (invalidWeight.logistic.weights as number[])[2] = Number.NaN;
  assert.throws(() => createBtcArtifact(invalidWeight), /must be finite/);

  const invalidSchema = {
    ...artifactFixture(),
    featureSchema: [...BTC_FEATURE_SCHEMA].reverse(),
  } as unknown as ArtifactInput;
  assert.throws(() => createBtcArtifact(invalidSchema), /schema or feature order/);

  const promoted = {
    ...artifactFixture(),
    status: "promoted",
  } as unknown as ArtifactInput;
  assert.throws(() => createBtcArtifact(promoted), /shadow_only/);

  const extraFeature = inputFixture() as InferenceInput & Record<string, unknown>;
  extraFeature.features = {
    ...extraFeature.features,
    oracleDistance: { value: 1, atMs: extraFeature.decisionTimeMs },
  } as InferenceInput["features"];
  assert.throws(
    () => inferBtcArtifact(createBtcArtifact(artifactFixture()), extraFeature),
    /out-of-schema/,
  );
});

test("Coinbase comparison measurements are explicitly comparison-only and never an oracle distance", () => {
  const comparisonFeature = BTC_FEATURE_SCHEMA.find(feature => feature.name === "comparisonReturn");
  assert.equal(comparisonFeature?.source, "coinbaseComparisonReturn");
  assert.ok(!BTC_FEATURE_SCHEMA.some(feature => /oracle|distance/i.test(feature.name)));
  const missing = inputFixture();
  missing.features.comparisonReturn.value = null;
  const probability = inferBtcArtifact(createBtcArtifact(artifactFixture()), missing).probabilityUp;
  assert.ok(Number.isFinite(probability));
});