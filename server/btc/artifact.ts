/**
 * Portable, shadow-only logistic model artifact.
 *
 * This module deliberately contains no training or persistence logic. Artifacts
 * are data contracts: callers must supply coefficients and provenance from an
 * independently generated training run.
 */

export const BTC_ARTIFACT_FORMAT = "btc-logistic-artifact" as const;
export const BTC_ARTIFACT_VERSION = 1 as const;
export const BTC_FEATURE_SCHEMA = Object.freeze([
  Object.freeze({
    name: "indicativeUpLogit",
    source: "indicativeUp",
    transform: "clamped_logit",
    missing: "not_allowed",
  }),
  Object.freeze({
    name: "remainingSeconds",
    source: "remainingSeconds",
    transform: "identity",
    missing: "not_allowed",
  }),
  Object.freeze({
    name: "comparisonReturn",
    source: "coinbaseComparisonReturn",
    transform: "identity",
    missing: "impute_zero_and_indicator",
  }),
  Object.freeze({
    name: "realizedVolatility",
    source: "comparisonMarketRealizedVolatility",
    transform: "identity",
    missing: "impute_zero_and_indicator",
  }),
  Object.freeze({
    name: "comparisonReturnMissing",
    source: "comparisonReturn",
    transform: "missing_indicator",
    missing: "not_applicable",
  }),
  Object.freeze({
    name: "realizedVolatilityMissing",
    source: "realizedVolatility",
    transform: "missing_indicator",
    missing: "not_applicable",
  }),
] as const);

const RAW_FEATURE_NAMES = [
  "indicativeUp",
  "remainingSeconds",
  "comparisonReturn",
  "realizedVolatility",
] as const;
const FEATURE_NAMES = BTC_FEATURE_SCHEMA.map(feature => feature.name);
const LOGIT_EPSILON = 1e-6;
const STANDARDIZED_CLAMP = 8;

export type BtcArtifact = {
  format: typeof BTC_ARTIFACT_FORMAT;
  artifactVersion: typeof BTC_ARTIFACT_VERSION;
  modelVersion: string;
  status: "shadow_only";
  featureSchema: typeof BTC_FEATURE_SCHEMA;
  scaling: {
    fitOn: "training_only";
    means: number[];
    scales: number[];
    standardizedValueClamp: number;
  };
  missingValueRules: {
    nullableFeatures: ["comparisonReturn", "realizedVolatility"];
    imputation: "zero";
    indicators: ["comparisonReturnMissing", "realizedVolatilityMissing"];
  };
  logistic: {
    intercept: number;
    weights: number[];
  };
  plattCalibration: {
    slope: number;
    intercept: number;
    fitOn: "separate_calibration_window";
  };
  provenance: {
    trainingDataHash: string;
    trainingDataVersion: string;
    trainingCutoffMs: number;
    trainingRowCount: number;
    calibrationDataHash: string;
    calibrationDataVersion: string;
    calibrationCutoffMs: number;
    calibrationRowCount: number;
    method: string;
    labelDefinition: string;
    evidenceStatus: "shadow_only_not_promoted";
  };
};

export type ArtifactInput = BtcArtifact;

export type TimedFeature = {
  value: number | null;
  atMs: number;
};

export type InferenceInput = {
  decisionTimeMs: number;
  features: {
    indicativeUp: TimedFeature;
    remainingSeconds: TimedFeature;
    comparisonReturn: TimedFeature;
    realizedVolatility: TimedFeature;
  };
};

export type InferenceResult = {
  rawProbabilityUp: number;
  probabilityUp: number;
  rawLogit: number;
  calibratedLogit: number;
  featureNames: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has missing or out-of-schema fields`);
  }
}

function finite(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be finite`);
}

function positiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
}

function hash(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f\d]{64}$/i.test(value))
    throw new Error(`${name} must be a SHA-256 hex digest`);
}

function nonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} must be a non-empty string`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * Validates, canonicalizes, and deeply freezes a serializable artifact.
 * Feature order and feature metadata are fixed by this module, not caller input.
 */
export function createBtcArtifact(input: ArtifactInput): Readonly<BtcArtifact> {
  if (!isRecord(input)) throw new Error("Artifact must be an object");
  exactKeys(input, [
    "format", "artifactVersion", "modelVersion", "status", "featureSchema", "scaling",
    "missingValueRules", "logistic", "plattCalibration", "provenance",
  ], "Artifact");
  if (input.format !== BTC_ARTIFACT_FORMAT || input.artifactVersion !== BTC_ARTIFACT_VERSION)
    throw new Error("Unsupported artifact format or version");
  if (typeof input.modelVersion !== "string" ||
    !/^btc-shadow-logistic-v1-[a-f\d]{24}$/.test(input.modelVersion))
    throw new Error("Artifact modelVersion is invalid");
  if (input.status !== "shadow_only") throw new Error("Artifact must remain shadow_only");
  if (!Array.isArray(input.featureSchema) ||
    JSON.stringify(input.featureSchema) !== JSON.stringify(BTC_FEATURE_SCHEMA))
    throw new Error("Artifact feature schema or feature order is invalid");

  if (!isRecord(input.scaling)) throw new Error("Artifact scaling must be an object");
  exactKeys(input.scaling, ["fitOn", "means", "scales", "standardizedValueClamp"], "Scaling");
  if (input.scaling.fitOn !== "training_only")
    throw new Error("Scaling must be fitted on training data only");
  if (!Array.isArray(input.scaling.means) || input.scaling.means.length !== FEATURE_NAMES.length ||
    !Array.isArray(input.scaling.scales) || input.scaling.scales.length !== FEATURE_NAMES.length)
    throw new Error("Scaling vectors must match the exact feature schema");
  input.scaling.means.forEach((value, index) => finite(`training mean ${FEATURE_NAMES[index]}`, value));
  input.scaling.scales.forEach((value, index) => {
    finite(`training scale ${FEATURE_NAMES[index]}`, value);
    if (value <= 0) throw new Error(`Training scale ${FEATURE_NAMES[index]} must be positive`);
  });
  finite("standardizedValueClamp", input.scaling.standardizedValueClamp);
  if (input.scaling.standardizedValueClamp !== STANDARDIZED_CLAMP)
    throw new Error(`standardizedValueClamp must be ${STANDARDIZED_CLAMP}`);

  if (!isRecord(input.missingValueRules)) throw new Error("Missing value rules must be an object");
  exactKeys(input.missingValueRules, ["nullableFeatures", "imputation", "indicators"], "Missing value rules");
  if (JSON.stringify(input.missingValueRules.nullableFeatures) !==
      JSON.stringify(["comparisonReturn", "realizedVolatility"]) ||
    input.missingValueRules.imputation !== "zero" ||
    JSON.stringify(input.missingValueRules.indicators) !==
      JSON.stringify(["comparisonReturnMissing", "realizedVolatilityMissing"])) {
    throw new Error("Artifact missing value rules are invalid");
  }

  if (!isRecord(input.logistic)) throw new Error("Logistic coefficients must be an object");
  exactKeys(input.logistic, ["intercept", "weights"], "Logistic coefficients");
  finite("logistic intercept", input.logistic.intercept);
  if (!Array.isArray(input.logistic.weights) || input.logistic.weights.length !== FEATURE_NAMES.length)
    throw new Error("Logistic weights must match the exact feature schema");
  input.logistic.weights.forEach((value, index) => finite(`logistic weight ${FEATURE_NAMES[index]}`, value));

  if (!isRecord(input.plattCalibration)) throw new Error("Platt calibration must be an object");
  exactKeys(input.plattCalibration, ["slope", "intercept", "fitOn"], "Platt calibration");
  finite("Platt slope", input.plattCalibration.slope);
  finite("Platt intercept", input.plattCalibration.intercept);
  if (input.plattCalibration.fitOn !== "separate_calibration_window")
    throw new Error("Platt calibration must use a separate calibration window");

  if (!isRecord(input.provenance)) throw new Error("Artifact provenance must be an object");
  exactKeys(input.provenance, [
    "trainingDataHash", "trainingDataVersion", "trainingCutoffMs", "trainingRowCount",
    "calibrationDataHash", "calibrationDataVersion", "calibrationCutoffMs",
    "calibrationRowCount", "method", "labelDefinition", "evidenceStatus",
  ], "Provenance");
  hash("trainingDataHash", input.provenance.trainingDataHash);
  hash("calibrationDataHash", input.provenance.calibrationDataHash);
  nonEmptyString("trainingDataVersion", input.provenance.trainingDataVersion);
  nonEmptyString("calibrationDataVersion", input.provenance.calibrationDataVersion);
  positiveInteger("trainingCutoffMs", input.provenance.trainingCutoffMs);
  positiveInteger("calibrationCutoffMs", input.provenance.calibrationCutoffMs);
  positiveInteger("trainingRowCount", input.provenance.trainingRowCount);
  positiveInteger("calibrationRowCount", input.provenance.calibrationRowCount);
  nonEmptyString("provenance method", input.provenance.method);
  nonEmptyString("labelDefinition", input.provenance.labelDefinition);
  if (input.provenance.evidenceStatus !== "shadow_only_not_promoted")
    throw new Error("Artifact provenance cannot claim promotion or validation");
  if (input.provenance.calibrationCutoffMs <= input.provenance.trainingCutoffMs)
    throw new Error("Calibration cutoff must follow the training cutoff");

  // Build in canonical key order and detach from mutable caller-owned arrays.
  return deepFreeze({
    format: BTC_ARTIFACT_FORMAT,
    artifactVersion: BTC_ARTIFACT_VERSION,
    modelVersion: input.modelVersion,
    status: "shadow_only",
    featureSchema: BTC_FEATURE_SCHEMA,
    scaling: {
      fitOn: "training_only",
      means: [...input.scaling.means],
      scales: [...input.scaling.scales],
      standardizedValueClamp: STANDARDIZED_CLAMP,
    },
    missingValueRules: {
      nullableFeatures: ["comparisonReturn", "realizedVolatility"],
      imputation: "zero",
      indicators: ["comparisonReturnMissing", "realizedVolatilityMissing"],
    },
    logistic: {
      intercept: input.logistic.intercept,
      weights: [...input.logistic.weights],
    },
    plattCalibration: {
      slope: input.plattCalibration.slope,
      intercept: input.plattCalibration.intercept,
      fitOn: "separate_calibration_window",
    },
    provenance: {
      trainingDataHash: input.provenance.trainingDataHash,
      trainingDataVersion: input.provenance.trainingDataVersion,
      trainingCutoffMs: input.provenance.trainingCutoffMs,
      trainingRowCount: input.provenance.trainingRowCount,
      calibrationDataHash: input.provenance.calibrationDataHash,
      calibrationDataVersion: input.provenance.calibrationDataVersion,
      calibrationCutoffMs: input.provenance.calibrationCutoffMs,
      calibrationRowCount: input.provenance.calibrationRowCount,
      method: input.provenance.method,
      labelDefinition: input.provenance.labelDefinition,
      evidenceStatus: "shadow_only_not_promoted",
    },
  });
}

export function serializeBtcArtifact(artifact: BtcArtifact): string {
  return JSON.stringify(createBtcArtifact(artifact));
}

export function parseBtcArtifact(serialized: string): Readonly<BtcArtifact> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Artifact JSON is invalid");
  }
  return createBtcArtifact(parsed as ArtifactInput);
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-Math.min(value, 40)));
  const exp = Math.exp(Math.max(value, -40));
  return exp / (1 + exp);
}

function readTimedFeature(
  input: Record<string, unknown>,
  name: typeof RAW_FEATURE_NAMES[number],
  decisionTimeMs: number,
  nullable: boolean,
): number | null {
  const timed = input[name];
  if (!isRecord(timed)) throw new Error(`Feature ${name} must include a value and timestamp`);
  exactKeys(timed, ["value", "atMs"], `Feature ${name}`);
  finite(`${name} timestamp`, timed.atMs);
  if (timed.atMs > decisionTimeMs) throw new Error(`Feature ${name} timestamp is later than decision time`);
  if (timed.value === null && nullable) return null;
  finite(name, timed.value);
  if (name === "indicativeUp" && (timed.value < 0 || timed.value > 1))
    throw new Error("indicativeUp must be a probability");
  if (name === "remainingSeconds" && timed.value < 0)
    throw new Error("remainingSeconds must be non-negative");
  if (name === "realizedVolatility" && timed.value < 0)
    throw new Error("realizedVolatility must be non-negative");
  return timed.value;
}

/**
 * Deterministic shadow inference. All raw inputs carry their observation time;
 * Coinbase-derived fields are comparison-only and never an oracle distance.
 */
export function inferBtcArtifact(
  artifact: BtcArtifact,
  input: InferenceInput,
): InferenceResult {
  const validatedArtifact = createBtcArtifact(artifact);
  if (!isRecord(input)) throw new Error("Inference input must be an object");
  exactKeys(input, ["decisionTimeMs", "features"], "Inference input");
  finite("decisionTimeMs", input.decisionTimeMs);
  if (input.decisionTimeMs <= 0) throw new Error("decisionTimeMs must be positive");
  if (!isRecord(input.features)) throw new Error("Inference features must be an object");
  exactKeys(input.features, RAW_FEATURE_NAMES, "Inference features");

  const up = readTimedFeature(input.features, "indicativeUp", input.decisionTimeMs, false)!;
  const remaining = readTimedFeature(input.features, "remainingSeconds", input.decisionTimeMs, false)!;
  const comparisonReturn = readTimedFeature(input.features, "comparisonReturn", input.decisionTimeMs, true);
  const realizedVolatility = readTimedFeature(input.features, "realizedVolatility", input.decisionTimeMs, true);
  const boundedUp = Math.min(1 - LOGIT_EPSILON, Math.max(LOGIT_EPSILON, up));
  const rawFeatures = [
    Math.log(boundedUp / (1 - boundedUp)),
    remaining,
    comparisonReturn ?? 0,
    realizedVolatility ?? 0,
    comparisonReturn === null ? 1 : 0,
    realizedVolatility === null ? 1 : 0,
  ];
  const standardized = rawFeatures.map((value, index) =>
    Math.max(-STANDARDIZED_CLAMP, Math.min(STANDARDIZED_CLAMP,
      (value - validatedArtifact.scaling.means[index]) / validatedArtifact.scaling.scales[index])));
  const rawLogit = validatedArtifact.logistic.intercept + standardized.reduce(
    (sum, value, index) => sum + value * validatedArtifact.logistic.weights[index], 0);
  const calibratedLogit = validatedArtifact.plattCalibration.slope * rawLogit +
    validatedArtifact.plattCalibration.intercept;
  return Object.freeze({
    rawProbabilityUp: sigmoid(rawLogit),
    probabilityUp: sigmoid(calibratedLogit),
    rawLogit,
    calibratedLogit,
    featureNames: Object.freeze([...FEATURE_NAMES]),
  });
}