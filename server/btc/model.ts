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
  };
  window: WindowSummary;
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
    volatilityNeutral: null;
    volatilityNeutralUnavailableReason: string;
  };
  lastTrainingAt?: string;
};

const MINIMUM_SAMPLE = 300;
const MINIMUM_UTC_DAYS = 2;
const SPLIT_EMBARGO_MS = 90_000;
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
  const variance = losses.reduce((sum, loss) => sum + (loss - brier) ** 2, 0) / rows.length;
  const effectiveSampleSize = Math.max(1, Math.ceil(rows.length / 5));
  const halfWidth = Math.min(1, 1.96 * Math.sqrt(variance / effectiveSampleSize));
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
      method: "Normal approximation; standard error inflated by sqrt(5) for serial dependence",
      effectiveSampleSize,
    },
    window: summary(rows),
  };
}

function distinctUtcDays(rows: ShadowRow[]): number {
  return new Set(rows.map(row => new Date(row.observedMs).toISOString().slice(0, 10))).size;
}

function makeResult(rows: ShadowRow[]): ShadowResult {
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
  const split = {
    training: summary(trainingRows),
    calibration: summary(calibrationRows),
    test: summary(testRows),
  };
  const testSummary = summary(testRows);
  const upCount = testRows.filter(row => row.outcome === "UP").length;
  const evaluated = { ...testSummary, upCount, downCount: testRows.length - upCount, split };
  const fiftyFifty = metrics(testRows, testRows.map(() => 0.5));
  const onChainIndicative = metrics(testRows, testRows.map(row => row.indicativeUp));

  const eligible = rows.length >= MINIMUM_SAMPLE && distinctUtcDays(rows) >= MINIMUM_UTC_DAYS &&
    trainingRows.length >= 50 && calibrationRows.length >= 30 && testRows.length >= 30 &&
    new Set(trainingRows.map(row => row.outcome)).size === 2 &&
    new Set(calibrationRows.map(row => row.outcome)).size === 2;
  if (!eligible) {
    const reason = rows.length < MINIMUM_SAMPLE
      ? `Insufficient sample: need at least ${MINIMUM_SAMPLE} unique rounds`
      : distinctUtcDays(rows) < MINIMUM_UTC_DAYS
        ? `Insufficient history: need at least ${MINIMUM_UTC_DAYS} distinct UTC days`
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
        volatilityNeutral: null,
        volatilityNeutralUnavailableReason: "Unavailable: volatility alone does not provide settlement-relevant signed distance, and the input has no documented contract-reference distance with which to define a directional benchmark.",
      },
    };
  }

  const standardizedTraining = standardized(trainingRows);
  const weights = fitLogistic(trainingRows, standardizedTraining.vectors);
  const calibrationVectors = calibrationRows.map(row => {
    const raw = featureVector(row);
    return raw.map((value, j) => Math.max(-8, Math.min(8,
      (value - standardizedTraining.means[j]) / standardizedTraining.scales[j])));
  });
  const calibrationLogits = calibrationVectors.map(vector => rawLogit(vector, weights));
  const platt = fitPlatt(calibrationRows, calibrationLogits);
  const testVectors = testRows.map(row => {
    const raw = featureVector(row);
    return raw.map((value, j) => Math.max(-8, Math.min(8,
      (value - standardizedTraining.means[j]) / standardizedTraining.scales[j])));
  });
  const probabilities = testVectors.map(vector =>
    sigmoid(platt.slope * rawLogit(vector, weights) + platt.intercept));
  const challengerMetrics = metrics(testRows, probabilities);
  if (!challengerMetrics) throw new Error("Eligible test window unexpectedly empty");
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
        standardizedCoefficient: weights[j + 1],
        trainingMean: standardizedTraining.means[j],
        trainingScale: standardizedTraining.scales[j],
      })),
      plattCalibration: platt,
    },
    baselines: {
      fiftyFifty,
      onChainIndicative,
      volatilityNeutral: null,
      volatilityNeutralUnavailableReason: "Unavailable: volatility alone does not provide settlement-relevant signed distance, and the input has no documented contract-reference distance with which to define a directional benchmark.",
    },
    lastTrainingAt: new Date(trainingRows[trainingRows.length - 1].observedMs).toISOString(),
  };
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