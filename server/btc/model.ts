import { createHash } from "node:crypto";
import {
  BTC_FEATURE_SCHEMA,
  createBtcArtifact,
  type BtcArtifact,
} from "./artifact";

export type ShadowOutcome = "UP" | "DOWN";

export type ShadowRow = {
  id: string;
  expiryMs: number;
  observedMs: number;
  outcome: ShadowOutcome;
  indicativeUp: number;
  comparisonReturn?: number | null;
  realizedVolatility?: number | null;
  remainingSeconds: number;
};

type WindowSummary = {
  count: number;
  startUtc: string | null;
  endUtc: string | null;
};

type Metrics = {
  count: number;
  upCount: number;
  downCount: number;
  brier: number;
  logLoss: number;
  calibrationBins: Array<{
    lower: number;
    upper: number;
    count: number;
    meanPredicted: number | null;
    observedUpRate: number | null;
  }>;
  brierUncertainty: {
    lower: number;
    upper: number;
    method: string;
    effectiveSampleSize: number;
    blockCount: number;
    blockDurationMinutes: number;
  };
  window: WindowSummary;
};

type RemainingTimeBucket = {
  label: string;
  minimumSeconds: number;
  maximumSeconds: number;
  count: number;
  coverage: "sufficient" | "sparse";
  reason: string | null;
  rawDeepBook: Metrics | null;
  calibratedDeepBook: Metrics | null;
  logistic: Metrics | null;
};

type ShadowResult = {
  status: "shadow" | "insufficient";
  reason: string;
  eligible: boolean;
  evaluated: WindowSummary & {
    upCount: number;
    downCount: number;
    split: {
      training: WindowSummary;
      calibration: WindowSummary;
      test: WindowSummary;
    };
    remainingTimeBuckets: RemainingTimeBucket[];
  };
  challenger: null | {
    name: string;
    method: string;
    trainingCount: number;
    calibrationCount: number;
    metrics: Metrics;
    coefficients: Array<{
      feature: string;
      standardizedCoefficient: number;
      trainingMean: number;
      trainingScale: number;
    }>;
    plattCalibration: { slope: number; intercept: number };
  };
  baselines: {
    fiftyFifty: Metrics | null;
    onChainIndicative: Metrics | null;
    deepBookCalibrated: null | {
      name: string;
      method: string;
      calibrationCount: number;
      metrics: Metrics;
      plattCalibration: { slope: number; intercept: number };
    };
    volatilityNeutral: null;
    volatilityNeutralUnavailableReason: string;
  };
  lastTrainingAt?: string;
};

const MINIMUM_SAMPLE = 300;
const MINIMUM_ELAPSED_HISTORY_MS = 48 * 60 * 60 * 1000;
const MAXIMUM_HISTORY_GAP_MS = 12 * 60 * 60 * 1000;
const PRIMARY_WINDOW_MIN_SECONDS = 30;
const PRIMARY_WINDOW_MAX_SECONDS = 60;
const MINIMUM_PRIMARY_WINDOW_COVERAGE = 30;
const MINIMUM_BUCKET_EVALUATION_SAMPLE = 30;
const SPLIT_EMBARGO_MS = 90_000;
const UNCERTAINTY_BLOCK_MS = 30 * 60 * 1000;
const FEATURE_NAMES = [
  "indicativeUpLogit",
  "remainingSeconds",
  "comparisonReturn",
  "realizedVolatility",
  "comparisonReturnMissing",
  "realizedVolatilityMissing",
];
const BIN_COUNT = 10;
const cache = new Map<string, ShadowResult>();

function assertFinite(name: string, value: number) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

function validateRows(rows: ShadowRow[]): ShadowRow[] {
  if (!Array.isArray(rows)) throw new Error("Rows must be an array");
  const ids = new Set<string>();
  let previousObserved = -Infinity;
  let previousExpiry = -Infinity;
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || row.id.trim() === "")
      throw new Error("Every round must have a non-empty id");
    if (ids.has(row.id)) throw new Error(`Duplicate round id: ${row.id}`);
    ids.add(row.id);
    assertFinite("expiryMs", row.expiryMs);
    assertFinite("observedMs", row.observedMs);
    assertFinite("remainingSeconds", row.remainingSeconds);
    assertFinite("indicativeUp", row.indicativeUp);
    if (row.expiryMs <= 0 || row.observedMs <= 0)
      throw new Error("Round timestamps must be positive milliseconds");
    if (row.observedMs > row.expiryMs)
      throw new Error(`Future observation for round ${row.id}`);
    if (row.expiryMs <= previousExpiry || row.observedMs <= previousObserved)
      throw new Error("Rows must be chronological with strictly increasing timestamps");
    if (row.remainingSeconds < 0 ||
      row.remainingSeconds > (row.expiryMs - row.observedMs) / 1000 + 2)
      throw new Error(`Invalid remainingSeconds for round ${row.id}`);
    if (row.indicativeUp < 0 || row.indicativeUp > 1)
      throw new Error(`indicativeUp must be a probability for round ${row.id}`);
    if (row.outcome !== "UP" && row.outcome !== "DOWN")
      throw new Error(`Invalid outcome for round ${row.id}`);
    for (const [name, value] of [
      ["comparisonReturn", row.comparisonReturn],
      ["realizedVolatility", row.realizedVolatility],
    ] as const) {
      if (value != null) assertFinite(name, value);
    }
    if (row.realizedVolatility != null && row.realizedVolatility < 0)
      throw new Error(`realizedVolatility must be non-negative for round ${row.id}`);
    previousObserved = row.observedMs;
    previousExpiry = row.expiryMs;
  }
  return rows;
}

function featureVector(row: ShadowRow): number[] {
  const p = Math.min(1 - 1e-6, Math.max(1e-6, row.indicativeUp));
  return [
    Math.log(p / (1 - p)),
    row.remainingSeconds,
    row.comparisonReturn ?? 0,
    row.realizedVolatility ?? 0,
    row.comparisonReturn == null ? 1 : 0,
    row.realizedVolatility == null ? 1 : 0,
  ];
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-Math.min(value, 40)));
  const exp = Math.exp(Math.max(value, -40));
  return exp / (1 + exp);
}

function standardized(
  rows: ShadowRow[],
): { vectors: number[][]; means: number[]; scales: number[] } {
  const raw = rows.map(featureVector);
  const means = FEATURE_NAMES.map((_, j) => raw.reduce((sum, x) => sum + x[j], 0) / raw.length);
  const scales = FEATURE_NAMES.map((_, j) => {
    const variance = raw.reduce((sum, x) => sum + (x[j] - means[j]) ** 2, 0) / raw.length;
    return Math.sqrt(variance) || 1;
  });
  return {
    means,
    scales,
    vectors: raw.map(x => x.map((value, j) =>
      Math.max(-8, Math.min(8, (value - means[j]) / scales[j])))),
  };
}

function fitLogistic(rows: ShadowRow[], vectors: number[][]): number[] {
  const weights = Array(FEATURE_NAMES.length + 1).fill(0) as number[];
  const lambda = 1;
  const learningRate = 0.06;
  for (let iteration = 0; iteration < 1200; iteration++) {
    const gradients = Array(weights.length).fill(0) as number[];
    for (let i = 0; i < rows.length; i++) {
      const x = [1, ...vectors[i]];
      const p = sigmoid(x.reduce((sum, value, j) => sum + value * weights[j], 0));
      const error = p - (rows[i].outcome === "UP" ? 1 : 0);
      for (let j = 0; j < weights.length; j++) gradients[j] += error * x[j];
    }
    for (let j = 0; j < weights.length; j++) {
      gradients[j] = gradients[j] / rows.length + (j === 0 ? 0 : lambda * weights[j] / rows.length);
      weights[j] -= learningRate * gradients[j];
    }
  }
  return weights;
}

function rawLogit(vector: number[], weights: number[]): number {
  return weights[0] + vector.reduce((sum, value, j) => sum + value * weights[j + 1], 0);
}

type FittedShadowModel = {
  means: number[];
  scales: number[];
  weights: number[];
  platt: { slope: number; intercept: number };
};

function fitShadowModel(trainingRows: ShadowRow[], calibrationRows: ShadowRow[]): FittedShadowModel {
  const standardizedTraining = standardized(trainingRows);
  const weights = fitLogistic(trainingRows, standardizedTraining.vectors);
  const calibrationVectors = calibrationRows.map(row => {
    const raw = featureVector(row);
    return raw.map((value, index) => Math.max(-8, Math.min(8,
      (value - standardizedTraining.means[index]) / standardizedTraining.scales[index])));
  });
  const calibrationLogits = calibrationVectors.map(vector => rawLogit(vector, weights));
  return {
    means: standardizedTraining.means,
    scales: standardizedTraining.scales,
    weights,
    platt: fitPlatt(calibrationRows, calibrationLogits),
  };
}

function predictWithFittedModel(rows: ShadowRow[], fitted: FittedShadowModel): number[] {
  return rows.map(row => {
    const raw = featureVector(row);
    const vector = raw.map((value, index) => Math.max(-8, Math.min(8,
      (value - fitted.means[index]) / fitted.scales[index])));
    return sigmoid(fitted.platt.slope * rawLogit(vector, fitted.weights) + fitted.platt.intercept);
  });
}

function fitPlatt(rows: ShadowRow[], logits: number[]): { slope: number; intercept: number } {
  let slope = 1;
  let intercept = 0;
  const learningRate = 0.04;
  for (let iteration = 0; iteration < 1200; iteration++) {
    let slopeGradient = 0;
    let interceptGradient = 0;
    for (let i = 0; i < rows.length; i++) {
      const p = sigmoid(slope * logits[i] + intercept);
      const error = p - (rows[i].outcome === "UP" ? 1 : 0);
      slopeGradient += error * logits[i];
      interceptGradient += error;
    }
    slopeGradient = slopeGradient / rows.length + 0.001 * slope;
    interceptGradient /= rows.length;
    slope -= learningRate * slopeGradient;
    intercept -= learningRate * interceptGradient;
    slope = Math.max(-10, Math.min(10, slope));
    intercept = Math.max(-10, Math.min(10, intercept));
  }
  return { slope, intercept };
}

function summary(rows: ShadowRow[]): WindowSummary {
  return {
    count: rows.length,
    startUtc: rows.length ? new Date(rows[0].observedMs).toISOString() : null,
    endUtc: rows.length ? new Date(rows[rows.length - 1].observedMs).toISOString() : null,
  };
}

function metrics(rows: ShadowRow[], probabilities: number[]): Metrics | null {
  if (!rows.length) return null;
  let brier = 0;
  let logLoss = 0;
  let upCount = 0;
  const bins = Array.from({ length: BIN_COUNT }, (_, i) => ({
    lower: i / BIN_COUNT,
    upper: (i + 1) / BIN_COUNT,
    count: 0,
    probabilitySum: 0,
    upCount: 0,
  }));
  const losses: number[] = [];
  rows.forEach((row, i) => {
    const p = probabilities[i];
    if (!Number.isFinite(p) || p < 0 || p > 1)
      throw new Error("Model produced an invalid probability");
    const y = row.outcome === "UP" ? 1 : 0;
    if (y) upCount++;
    const loss = (p - y) ** 2;
    losses.push(loss);
    brier += loss;
    logLoss -= y * Math.log(Math.max(1e-12, p)) + (1 - y) * Math.log(Math.max(1e-12, 1 - p));
    const index = Math.min(BIN_COUNT - 1, Math.floor(p * BIN_COUNT));
    bins[index].count++;
    bins[index].probabilitySum += p;
    bins[index].upCount += y;
  });
  brier /= rows.length;
  logLoss /= rows.length;
  const lossByTimeBlock = new Map<number, { sum: number; count: number }>();
  rows.forEach((row, index) => {
    const block = Math.floor(row.observedMs / UNCERTAINTY_BLOCK_MS);
    const current = lossByTimeBlock.get(block) ?? { sum: 0, count: 0 };
    current.sum += losses[index];
    current.count++;
    lossByTimeBlock.set(block, current);
  });
  const blocks = Array.from(lossByTimeBlock.values());
  const blockCount = blocks.length;
  const effectiveSampleSize = blockCount;
  const clusterVariance = blockCount > 1
    ? blockCount / (blockCount - 1) *
      blocks.reduce((sum, block) => sum + (block.sum - block.count * brier) ** 2, 0) /
      rows.length ** 2
    : null;
  const halfWidth = clusterVariance == null
    ? 1
    : Math.min(1, 1.96 * Math.sqrt(clusterVariance));
  return {
    count: rows.length,
    upCount,
    downCount: rows.length - upCount,
    brier,
    logLoss,
    calibrationBins: bins.map(bin => ({
      lower: bin.lower,
      upper: bin.upper,
      count: bin.count,
      meanPredicted: bin.count ? bin.probabilitySum / bin.count : null,
      observedUpRate: bin.count ? bin.upCount / bin.count : null,
    })),
    brierUncertainty: {
      lower: Math.max(0, brier - halfWidth),
      upper: Math.min(1, brier + halfWidth),
      method: blockCount < 2
        ? "Conservative full-range interval: fewer than two independent 30-minute time blocks"
        : "Cluster-robust normal interval over 30-minute time blocks; reported effective sample size is the independent block count",
      effectiveSampleSize,
      blockCount,
      blockDurationMinutes: UNCERTAINTY_BLOCK_MS / 60_000,
    },
    window: summary(rows),
  };
}

function historyCoverage(rows: ShadowRow[]): {
  elapsedMs: number;
  maximumGapMs: number;
} {
  let maximumGapMs = 0;
  for (let index = 1; index < rows.length; index++)
    maximumGapMs = Math.max(maximumGapMs, rows[index].observedMs - rows[index - 1].observedMs);
  return {
    elapsedMs: rows.length > 1 ? rows[rows.length - 1].observedMs - rows[0].observedMs : 0,
    maximumGapMs,
  };
}

function splitRows(rows: ShadowRow[]) {
  const trainEnd = Math.floor(rows.length * 0.6);
  const calibrationEnd = trainEnd + Math.floor(rows.length * 0.2);
  const trainingRows = rows.slice(0, trainEnd);
  const calibrationCandidates = rows.slice(trainEnd, calibrationEnd);
  const testCandidates = rows.slice(calibrationEnd);
  const trainBoundaryMs = trainingRows.at(-1)?.observedMs;
  const calibrationRows = trainBoundaryMs == null ? [] : calibrationCandidates.filter(row =>
    row.observedMs - trainBoundaryMs >= SPLIT_EMBARGO_MS);
  const calibrationBoundaryMs = calibrationRows.at(-1)?.observedMs;
  const testRows = calibrationBoundaryMs == null ? [] : testCandidates.filter(row =>
    row.observedMs - calibrationBoundaryMs >= SPLIT_EMBARGO_MS);
  return { trainingRows, calibrationRows, testRows };
}

function eligibleForArtifact(
  rows: ShadowRow[],
  trainingRows: ShadowRow[],
  calibrationRows: ShadowRow[],
  testRows: ShadowRow[],
): boolean {
  const primaryWindowCount = testRows.filter(row =>
    row.remainingSeconds >= PRIMARY_WINDOW_MIN_SECONDS &&
    row.remainingSeconds <= PRIMARY_WINDOW_MAX_SECONDS).length;
  const coverage = historyCoverage(rows);
  return rows.length >= MINIMUM_SAMPLE &&
    coverage.elapsedMs >= MINIMUM_ELAPSED_HISTORY_MS &&
    coverage.maximumGapMs <= MAXIMUM_HISTORY_GAP_MS &&
    primaryWindowCount >= MINIMUM_PRIMARY_WINDOW_COVERAGE &&
    trainingRows.length >= 50 && calibrationRows.length >= 30 && testRows.length >= 30 &&
    new Set(trainingRows.map(row => row.outcome)).size === 2 &&
    new Set(calibrationRows.map(row => row.outcome)).size === 2;
}

function fitDeepBookCalibration(rows: ShadowRow[]): { slope: number; intercept: number } {
  const logits = rows.map(row => {
    const probability = Math.min(1 - 1e-6, Math.max(1e-6, row.indicativeUp));
    return Math.log(probability / (1 - probability));
  });
  return fitPlatt(rows, logits);
}

function applyPlatt(probability: number, calibration: { slope: number; intercept: number }): number {
  const bounded = Math.min(1 - 1e-6, Math.max(1e-6, probability));
  return sigmoid(calibration.slope * Math.log(bounded / (1 - bounded)) + calibration.intercept);
}

function remainingTimeBuckets(
  rows: ShadowRow[],
  rawDeepBookProbabilities: number[],
  calibratedDeepBookProbabilities: number[] | null,
  logisticProbabilities: number[] | null,
): RemainingTimeBucket[] {
  const definitions = [
    { label: "0–15 seconds", minimumSeconds: 0, maximumSeconds: 15 },
    { label: "15–30 seconds", minimumSeconds: 15, maximumSeconds: 30 },
    { label: "30–45 seconds", minimumSeconds: 30, maximumSeconds: 45 },
    { label: "45–60 seconds", minimumSeconds: 45, maximumSeconds: 60 },
  ];
  return definitions.map((definition, bucketIndex) => {
    const indices = rows.map((row, index) => ({ row, index })).filter(({ row }) =>
      row.remainingSeconds >= definition.minimumSeconds &&
      (bucketIndex === definitions.length - 1
        ? row.remainingSeconds <= definition.maximumSeconds
        : row.remainingSeconds < definition.maximumSeconds));
    const bucketRows = indices.map(({ row }) => row);
    const coverage = bucketRows.length >= MINIMUM_BUCKET_EVALUATION_SAMPLE ? "sufficient" : "sparse";
    return {
      ...definition,
      count: bucketRows.length,
      coverage,
      reason: coverage === "sparse"
        ? `Sparse held-out coverage: ${bucketRows.length} rounds; at least ${MINIMUM_BUCKET_EVALUATION_SAMPLE} required for bucket-level evidence`
        : null,
      rawDeepBook: metrics(bucketRows, indices.map(({ index }) => rawDeepBookProbabilities[index])),
      calibratedDeepBook: calibratedDeepBookProbabilities
        ? metrics(bucketRows, indices.map(({ index }) => calibratedDeepBookProbabilities[index]))
        : null,
      logistic: logisticProbabilities
        ? metrics(bucketRows, indices.map(({ index }) => logisticProbabilities[index]))
        : null,
    };
  });
}

function canonicalWindowHash(rows: ShadowRow[]): string {
  const canonicalRows = rows.map(row => ({
    id: row.id,
    expiryMs: row.expiryMs,
    observedMs: row.observedMs,
    outcome: row.outcome,
    indicativeUp: row.indicativeUp,
    comparisonReturn: row.comparisonReturn ?? null,
    realizedVolatility: row.realizedVolatility ?? null,
    remainingSeconds: row.remainingSeconds,
  }));
  return createHash("sha256").update(JSON.stringify(canonicalRows)).digest("hex");
}

function makeResult(rows: ShadowRow[]): ShadowResult {
  const { trainingRows, calibrationRows, testRows } = splitRows(rows);
  const split = {
    training: summary(trainingRows),
    calibration: summary(calibrationRows),
    test: summary(testRows),
  };
  const testSummary = summary(testRows);
  const upCount = testRows.filter(row => row.outcome === "UP").length;
  const rawDeepBookProbabilities = testRows.map(row => row.indicativeUp);
  let evaluated = {
    ...testSummary,
    upCount,
    downCount: testRows.length - upCount,
    split,
    remainingTimeBuckets: remainingTimeBuckets(
      testRows, rawDeepBookProbabilities, null, null,
    ),
  };
  const fiftyFifty = metrics(testRows, testRows.map(() => 0.5));
  const onChainIndicative = metrics(testRows, rawDeepBookProbabilities);

  const eligible = eligibleForArtifact(rows, trainingRows, calibrationRows, testRows);
  if (!eligible) {
    const coverage = historyCoverage(rows);
    const primaryWindowCount = testRows.filter(row =>
      row.remainingSeconds >= PRIMARY_WINDOW_MIN_SECONDS &&
      row.remainingSeconds <= PRIMARY_WINDOW_MAX_SECONDS).length;
    const reason = rows.length < MINIMUM_SAMPLE
      ? `Insufficient sample: need at least ${MINIMUM_SAMPLE} unique verified rounds`
      : coverage.elapsedMs < MINIMUM_ELAPSED_HISTORY_MS
        ? "Insufficient history: need at least 48 hours of elapsed verified observations; crossing midnight is not sufficient"
        : coverage.maximumGapMs > MAXIMUM_HISTORY_GAP_MS
          ? "Insufficient history coverage: no gap between verified observations may exceed 12 hours"
          : primaryWindowCount < MINIMUM_PRIMARY_WINDOW_COVERAGE
            ? `Insufficient primary-window coverage: need at least ${MINIMUM_PRIMARY_WINDOW_COVERAGE} held-out rounds with 30–60 seconds remaining`
            : "Insufficient split size or outcome diversity for independent training and calibration";
    return {
      status: "insufficient",
      reason,
      eligible: false,
      evaluated,
      challenger: null,
      baselines: {
        fiftyFifty,
        onChainIndicative,
        deepBookCalibrated: null,
        volatilityNeutral: null,
        volatilityNeutralUnavailableReason: "Unavailable: volatility alone does not provide settlement-relevant signed distance, and the input has no documented contract-reference distance with which to define a directional benchmark.",
      },
    };
  }

  const fitted = fitShadowModel(trainingRows, calibrationRows);
  const probabilities = predictWithFittedModel(testRows, fitted);
  const deepBookCalibration = fitDeepBookCalibration(calibrationRows);
  const calibratedDeepBookProbabilities = rawDeepBookProbabilities.map(probability =>
    applyPlatt(probability, deepBookCalibration));
  evaluated = {
    ...evaluated,
    remainingTimeBuckets: remainingTimeBuckets(
      testRows,
      rawDeepBookProbabilities,
      calibratedDeepBookProbabilities,
      probabilities,
    ),
  };
  const challengerMetrics = metrics(testRows, probabilities);
  const calibratedDeepBookMetrics = metrics(testRows, calibratedDeepBookProbabilities);
  if (!challengerMetrics) throw new Error("Eligible test window unexpectedly empty");
  if (!calibratedDeepBookMetrics) throw new Error("Eligible calibrated baseline window unexpectedly empty");
  return {
    status: "shadow",
    reason: "Eligible for shadow-only evaluation; no champion, trade, or profitable signal is produced",
    eligible: true,
    evaluated,
    challenger: {
      name: "L2 logistic (shadow only)",
      method: "L2-regularized logistic regression on earlier rounds; Platt scaling fit on a separate earlier validation window; untouched later test window",
      trainingCount: trainingRows.length,
      calibrationCount: calibrationRows.length,
      metrics: challengerMetrics,
      coefficients: FEATURE_NAMES.map((feature, j) => ({
        feature,
        standardizedCoefficient: fitted.weights[j + 1],
        trainingMean: fitted.means[j],
        trainingScale: fitted.scales[j],
      })),
      plattCalibration: fitted.platt,
    },
    baselines: {
      fiftyFifty,
      onChainIndicative,
      deepBookCalibrated: {
        name: "DeepBook probability calibration (shadow baseline)",
        method: "Platt calibration fit only on the earlier calibration window from DeepBook indicative probabilities; evaluated on the same untouched later primary-window rounds as the raw baseline and logistic challenger",
        calibrationCount: calibrationRows.length,
        metrics: calibratedDeepBookMetrics,
        plattCalibration: deepBookCalibration,
      },
      volatilityNeutral: null,
      volatilityNeutralUnavailableReason: "Unavailable: volatility alone does not provide settlement-relevant signed distance, and the input has no documented contract-reference distance with which to define a directional benchmark.",
    },
    lastTrainingAt: new Date(trainingRows[trainingRows.length - 1].observedMs).toISOString(),
  };
}

/**
 * Fits and packages a deterministic shadow artifact from the same chronological
 * training/calibration split used by evaluateShadow. The later test window is
 * used only for the existing eligibility gate, never for coefficients,
 * calibration, hashes, or versioning.
 */
export function buildShadowArtifact(input: ShadowRow[]): Readonly<BtcArtifact> {
  const rows = validateRows(input);
  const { trainingRows, calibrationRows, testRows } = splitRows(rows);
  if (!eligibleForArtifact(rows, trainingRows, calibrationRows, testRows))
    throw new Error("Insufficient split size or outcome diversity to build a shadow artifact");

  const fitted = fitShadowModel(trainingRows, calibrationRows);
  const trainingCutoffMs = trainingRows[trainingRows.length - 1].observedMs;
  const calibrationCutoffMs = calibrationRows[calibrationRows.length - 1].observedMs;
  const trainingDataHash = canonicalWindowHash(trainingRows);
  const calibrationDataHash = canonicalWindowHash(calibrationRows);
  const modelVersion = `btc-shadow-logistic-v1-${createHash("sha256")
    .update(`${trainingDataHash}:${calibrationDataHash}`).digest("hex").slice(0, 24)}`;

  return createBtcArtifact({
    format: "btc-logistic-artifact",
    artifactVersion: 1,
    modelVersion,
    status: "shadow_only",
    featureSchema: BTC_FEATURE_SCHEMA,
    scaling: {
      fitOn: "training_only",
      means: fitted.means,
      scales: fitted.scales,
      standardizedValueClamp: 8,
    },
    missingValueRules: {
      nullableFeatures: ["comparisonReturn", "realizedVolatility"],
      imputation: "zero",
      indicators: ["comparisonReturnMissing", "realizedVolatilityMissing"],
    },
    logistic: {
      intercept: fitted.weights[0],
      weights: fitted.weights.slice(1),
    },
    plattCalibration: {
      slope: fitted.platt.slope,
      intercept: fitted.platt.intercept,
      fitOn: "separate_calibration_window",
    },
    provenance: {
      trainingDataHash,
      trainingDataVersion: `btc-shadow-training-v1:${trainingDataHash}`,
      trainingCutoffMs,
      trainingRowCount: trainingRows.length,
      calibrationDataHash,
      calibrationDataVersion: `btc-shadow-calibration-v1:${calibrationDataHash}`,
      calibrationCutoffMs,
      calibrationRowCount: calibrationRows.length,
      method: "L2 logistic fit on chronological training rows; Platt calibration fit on separate embargoed calibration rows",
      labelDefinition: "UP/DOWN outcome recorded in the shadow training rows",
      evidenceStatus: "shadow_only_not_promoted",
    },
  });
}

/**
 * Returns the held-out shadow probabilities from the same fitting path used by
 * evaluateShadow. Exposed for artifact parity checks and reproducible audits.
 */
export function predictShadowTestWindow(input: ShadowRow[]): readonly number[] {
  const rows = validateRows(input);
  const { trainingRows, calibrationRows, testRows } = splitRows(rows);
  if (!eligibleForArtifact(rows, trainingRows, calibrationRows, testRows))
    throw new Error("Insufficient split size or outcome diversity to evaluate shadow predictions");
  return Object.freeze(predictWithFittedModel(
    testRows,
    fitShadowModel(trainingRows, calibrationRows),
  ));
}

/**
 * Evaluates chronological, one-snapshot-per-round history. The function only
 * reports shadow evidence; it never chooses a champion or emits a trade signal.
 */
export function evaluateShadow(input: ShadowRow[]): ShadowResult {
  const rows = validateRows(input);
  const key = JSON.stringify(rows);
  const cached = cache.get(key);
  if (cached) return JSON.parse(JSON.stringify(cached)) as ShadowResult;
  const result = makeResult(rows);
  cache.clear();
  cache.set(key, result);
  return JSON.parse(JSON.stringify(result)) as ShadowResult;
}