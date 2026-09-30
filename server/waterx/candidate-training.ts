import { createHash } from "node:crypto";

export type WaterxCandidateInterval = 5 | 15;
export const WATERX_CANDIDATE_ARTIFACT_VERSION = "waterx-logistic-candidate-v2";
export const WATERX_CANDIDATE_FEATURE_SCHEMA = "waterx-round-snapshot-v1";
export const WATERX_CANDIDATE_CALIBRATION_VERSION = "waterx-platt-logistic-v1";

/**
 * Features are copied from a prospective, round-scoped snapshot. This module
 * deliberately has no tick stream or feature reconstruction logic.
 */
export type WaterxProspectiveFeatures = Readonly<{
  referenceDistanceBps: number;
  timeRemainingFraction: number;
  return1m: number;
  return3m: number;
  realizedVolatilityBps: number;
  marketProbabilityUpDelta: number;
  sourceAgeMs: number;
}>;

export type WaterxAcceptedLabel = Readonly<{
  source: "WaterX";
  acceptedByWaterxSettlementGate: true;
  resolutionStatus: "resolved";
  anchorConfirmed: true;
  settlementAnchorPrice: number;
  settlePrice: number;
  outcome: "Up" | "Down";
  settledAtMs: number;
  labelAvailableMs: number;
}>;

export type WaterxProspectiveCandidatePrediction = Readonly<{
  kind: "shadow-candidate";
  artifactVersion: typeof WATERX_CANDIDATE_ARTIFACT_VERSION;
  modelVersion: string;
  datasetFingerprint: string;
  calibrationVersion: typeof WATERX_CANDIDATE_CALIBRATION_VERSION;
  probabilityUp: number;
  issuedAtMs: number;
  trainingAttemptAtMs: number;
}>;

export type WaterxProspectiveRoundRecord = Readonly<{
  intervalMinutes: WaterxCandidateInterval;
  roundId: string;
  source: "WaterX";
  featureSchema: typeof WATERX_CANDIDATE_FEATURE_SCHEMA;
  frozen: true;
  startMs: number;
  expiryMs: number;
  predictionAtMs: number;
  featureSnapshotAtMs: number;
  confirmedAnchorPrice: number;
  marketProbabilityUp: number;
  features: WaterxProspectiveFeatures;
  /** Optional pre-settlement research prediction frozen with the feature snapshot. */
  candidatePrediction?: WaterxProspectiveCandidatePrediction | null;
  /** Null means no authoritative accepted label is currently available. */
  label: WaterxAcceptedLabel | null;
}>;

export type WaterxCandidateMetrics = Readonly<{
  count: number;
  brier: number;
  logLoss: number;
  directionalAccuracy: number;
  calibration: readonly Readonly<{
    lower: number;
    upper: number;
    count: number;
    meanPredicted: number | null;
    observedUpRate: number | null;
  }>[];
}>;

export type WaterxCandidatePairedComparison = Readonly<{
  count: number;
  candidateMinusMarketBrier: Readonly<{
    mean: number;
    standardError: number;
    normalApproximation95Lower: number;
    normalApproximation95Upper: number;
  }>;
  candidateMinusMarketLogLoss: Readonly<{
    mean: number;
    standardError: number;
    normalApproximation95Lower: number;
    normalApproximation95Upper: number;
  }>;
  directionalAccuracyDifference: number;
  uncertaintyNote: string;
}>;

export type WaterxCandidateRegimeEvaluation = Readonly<{
  dimension: "time-remaining" | "market-probability";
  band: string;
  count: number;
  candidate: WaterxCandidateMetrics | null;
  market: WaterxCandidateMetrics | null;
}>;

export type WaterxProspectiveForwardEvaluation = Readonly<{
  storedPredictionCount: number;
  scoredPredictionCount: number;
  unscoredPredictionCount: number;
  labelAvailabilityPercent: number;
  coverageNote: string;
  byModelVersion: readonly Readonly<{
    modelVersion: string;
    trainingAttemptAtMs: number;
    storedPredictionCount: number;
    scoredPredictionCount: number;
    unscoredPredictionCount: number;
    labelAvailabilityPercent: number;
    candidateMetrics: WaterxCandidateMetrics | null;
    matchingMarketMetrics: WaterxCandidateMetrics | null;
    matchedComparison: WaterxCandidatePairedComparison | null;
  }>[];
}>;

export type WaterxCandidateModelArtifact = Readonly<{
  artifactVersion: typeof WATERX_CANDIDATE_ARTIFACT_VERSION;
  modelVersion: string;
  intervalMinutes: WaterxCandidateInterval;
  datasetFingerprint: string;
  featureSchema: typeof WATERX_CANDIDATE_FEATURE_SCHEMA;
  featureNames: readonly string[];
  means: readonly number[];
  scales: readonly number[];
  coefficients: readonly number[];
  intercept: number;
  calibration: Readonly<{ slope: number; intercept: number }>;
}>;

export type WaterxCandidateTrainingReport = Readonly<{
  protocol: "waterx-prospective-round-candidate-v2";
  status: "insufficient" | "candidate-evaluated";
  intervalMinutes: WaterxCandidateInterval;
  artifactVersion: typeof WATERX_CANDIDATE_ARTIFACT_VERSION;
  datasetFingerprint: string;
  recordCount: number;
  acceptedLabelCount: number;
  rejectedRecordCount: number;
  split: Readonly<{
    method: string;
    trainCount: number;
    calibrationCount: number;
    testCount: number;
    embargoExcludedCount: number;
    trainThroughMs: number | null;
    calibrationFromMs: number | null;
    calibrationThroughMs: number | null;
    testFromMs: number | null;
  }>;
  eligibility: Readonly<{
    eligible: boolean;
    requirements: Readonly<Record<string, number | boolean>>;
    rejectionReason: string | null;
  }>;
  rejectionReason: string;
  candidateTestMetrics: WaterxCandidateMetrics | null;
  matchingMarketTestMetrics: WaterxCandidateMetrics | null;
  matchedTestComparison: WaterxCandidatePairedComparison | null;
  testRegimeEvaluations: readonly WaterxCandidateRegimeEvaluation[];
  forwardPredictionEvaluation: WaterxProspectiveForwardEvaluation;
  artifact: WaterxCandidateModelArtifact | null;
  promoted: false;
  promotionRejectionReason: string;
}>;

const FEATURE_NAMES = [
  "marketProbabilityUp",
  "referenceDistanceBps",
  "timeRemainingFraction",
  "return1m",
  "return3m",
  "realizedVolatilityBps",
  "sourceAgeMs",
] as const;
type FeatureName = typeof FEATURE_NAMES[number];

function featureValue(
  record: Pick<WaterxProspectiveRoundRecord, "marketProbabilityUp" | "features">,
  name: FeatureName,
): number {
  return name === "marketProbabilityUp" ? record.marketProbabilityUp : record.features[name];
}

const REGULARIZATION = 0.1;
const LOGIT_CLAMP = 30;
const EPSILON = 1e-12;
const MINIMUMS = {
  eligibleRounds: 90,
  trainingRounds: 40,
  calibrationRounds: 20,
  testRounds: 20,
  spanMsByInterval: {
    5: 48 * 60 * 60_000,
    15: 7 * 24 * 60 * 60_000,
  },
} as const;

type ValidRow = {
  record: WaterxProspectiveRoundRecord;
  label: WaterxAcceptedLabel;
  x: number[];
  y: number;
};

function assertInterval(interval: number): asserts interval is WaterxCandidateInterval {
  if (interval !== 5 && interval !== 15)
    throw new Error("WaterX candidate interval must be 5 or 15 minutes");
}

function canonicalRecord(record: WaterxProspectiveRoundRecord): unknown {
  const label = record.label;
  return [
    record.intervalMinutes, record.roundId, record.source, record.featureSchema,
    record.frozen, record.startMs, record.expiryMs, record.predictionAtMs,
    record.featureSnapshotAtMs, record.confirmedAnchorPrice, record.marketProbabilityUp,
    FEATURE_NAMES.map(name => featureValue(record, name)),
    label ? [
      label.source, label.acceptedByWaterxSettlementGate, label.resolutionStatus,
      label.anchorConfirmed, label.settlementAnchorPrice, label.settlePrice,
      label.outcome, label.settledAtMs, label.labelAvailableMs,
    ] : null,
  ];
}

function fingerprint(records: readonly WaterxProspectiveRoundRecord[]): string {
  const ordered = [...records].sort((a, b) =>
    a.intervalMinutes - b.intervalMinutes ||
    a.startMs - b.startMs ||
    a.roundId.localeCompare(b.roundId));
  return createHash("sha256")
    .update(JSON.stringify(ordered.map(canonicalRecord)))
    .digest("hex");
}

function acceptedLabelIsValid(record: WaterxProspectiveRoundRecord): record is WaterxProspectiveRoundRecord & {
  label: WaterxAcceptedLabel;
} {
  const label = record.label;
  if (!label || label.source !== "WaterX" ||
      label.acceptedByWaterxSettlementGate !== true ||
      label.resolutionStatus !== "resolved" || label.anchorConfirmed !== true ||
      !Number.isFinite(label.settlementAnchorPrice) ||
      label.settlementAnchorPrice !== record.confirmedAnchorPrice ||
      !Number.isFinite(label.settlePrice) || label.settlePrice <= 0 ||
      !Number.isFinite(label.settledAtMs) || label.settledAtMs <= record.expiryMs ||
      !Number.isFinite(label.labelAvailableMs) || label.labelAvailableMs < label.settledAtMs)
    return false;
  const expected = label.settlePrice >= label.settlementAnchorPrice ? "Up" : "Down";
  return label.outcome === expected;
}

function validRecord(record: WaterxProspectiveRoundRecord, interval: number): boolean {
  if (record.intervalMinutes !== interval || record.source !== "WaterX" ||
      record.featureSchema !== WATERX_CANDIDATE_FEATURE_SCHEMA || record.frozen !== true ||
      typeof record.roundId !== "string" || !record.roundId.trim())
    return false;
  const values = [
    record.startMs, record.expiryMs, record.predictionAtMs,
    record.featureSnapshotAtMs, record.confirmedAnchorPrice,
    record.marketProbabilityUp,
    ...FEATURE_NAMES.map(name => featureValue(record, name)),
  ];
  if (!values.every(Number.isFinite) ||
      record.startMs <= 0 || record.expiryMs <= record.startMs ||
      record.expiryMs - record.startMs !== interval * 60_000 ||
      record.predictionAtMs < record.startMs ||
      record.predictionAtMs >= record.expiryMs ||
      record.featureSnapshotAtMs > record.predictionAtMs ||
      record.confirmedAnchorPrice <= 0 ||
      record.marketProbabilityUp < 0 || record.marketProbabilityUp > 1 ||
      record.features.timeRemainingFraction < 0 ||
      record.features.timeRemainingFraction > 1 ||
      record.features.sourceAgeMs < 0)
    return false;
  return acceptedLabelIsValid(record);
}

function validProspectivePrediction(
  record: WaterxProspectiveRoundRecord,
  interval: WaterxCandidateInterval,
): record is WaterxProspectiveRoundRecord & {
  candidatePrediction: WaterxProspectiveCandidatePrediction;
} {
  const prediction = record.candidatePrediction;
  return !!prediction &&
    record.intervalMinutes === interval &&
    record.source === "WaterX" &&
    record.featureSchema === WATERX_CANDIDATE_FEATURE_SCHEMA &&
    record.frozen === true &&
    typeof record.roundId === "string" && !!record.roundId.trim() &&
    Number.isFinite(record.startMs) &&
    record.expiryMs - record.startMs === interval * 60_000 &&
    record.predictionAtMs >= record.startMs &&
    record.predictionAtMs < record.expiryMs &&
    prediction.kind === "shadow-candidate" &&
    prediction.artifactVersion === WATERX_CANDIDATE_ARTIFACT_VERSION &&
    prediction.calibrationVersion === WATERX_CANDIDATE_CALIBRATION_VERSION &&
    typeof prediction.modelVersion === "string" &&
    prediction.modelVersion.startsWith(`${WATERX_CANDIDATE_ARTIFACT_VERSION}:`) &&
    typeof prediction.datasetFingerprint === "string" &&
    /^[a-f\d]{64}$/i.test(prediction.datasetFingerprint) &&
    Number.isFinite(prediction.probabilityUp) &&
    prediction.probabilityUp >= 0 && prediction.probabilityUp <= 1 &&
    prediction.issuedAtMs === record.predictionAtMs &&
    Number.isFinite(prediction.trainingAttemptAtMs) &&
    prediction.trainingAttemptAtMs < prediction.issuedAtMs;
}

function logistic(z: number): number {
  const bounded = Math.max(-LOGIT_CLAMP, Math.min(LOGIT_CLAMP, z));
  return 1 / (1 + Math.exp(-bounded));
}

function logit(p: number): number {
  const bounded = Math.max(EPSILON, Math.min(1 - EPSILON, p));
  return Math.log(bounded / (1 - bounded));
}

function fitLogistic(
  matrix: readonly (readonly number[])[],
  labels: readonly number[],
  ridge: number,
  iterations: number,
): { coefficients: number[]; intercept: number } {
  const width = matrix[0]?.length ?? 0;
  const positives = labels.reduce((sum, value) => sum + value, 0);
  let intercept = logit((positives + 0.5) / (labels.length + 1));
  const coefficients = Array.from({ length: width }, () => 0);
  const learningRate = 0.08;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradient = Array.from({ length: width }, () => 0);
    let interceptGradient = 0;
    for (let row = 0; row < matrix.length; row++) {
      const z = intercept + matrix[row].reduce(
        (sum, value, column) => sum + value * coefficients[column], 0);
      const error = logistic(z) - labels[row];
      interceptGradient += error;
      for (let column = 0; column < width; column++)
        gradient[column] += error * matrix[row][column];
    }
    const denominator = Math.max(1, matrix.length);
    intercept -= learningRate * interceptGradient / denominator;
    for (let column = 0; column < width; column++) {
      const regularizedGradient = gradient[column] / denominator +
        ridge * coefficients[column];
      coefficients[column] -= learningRate * regularizedGradient;
    }
  }
  return { coefficients, intercept };
}

function candidateRawProbability(
  row: ValidRow,
  means: readonly number[],
  scales: readonly number[],
  coefficients: readonly number[],
  intercept: number,
): number {
  const z = intercept + row.x.reduce((sum, value, index) =>
    sum + ((value - means[index]) / scales[index]) * coefficients[index], 0);
  return logistic(z);
}

/** Score a future round only with a previously persisted current-version artifact. */
export function predictWaterxCandidate(
  candidateArtifact: unknown,
  record: Pick<WaterxProspectiveRoundRecord, "intervalMinutes" | "marketProbabilityUp" | "features">,
): number | null {
  const value = candidateArtifact && typeof candidateArtifact === "object" &&
      !Array.isArray(candidateArtifact)
    ? candidateArtifact as Partial<WaterxCandidateModelArtifact> : null;
  if (!value || value.artifactVersion !== WATERX_CANDIDATE_ARTIFACT_VERSION ||
      value.intervalMinutes !== record.intervalMinutes ||
      value.featureSchema !== WATERX_CANDIDATE_FEATURE_SCHEMA ||
      !Array.isArray(value.featureNames) ||
      JSON.stringify(value.featureNames) !== JSON.stringify(FEATURE_NAMES) ||
      !Array.isArray(value.means) || !Array.isArray(value.scales) ||
      !Array.isArray(value.coefficients) ||
      value.means.length !== FEATURE_NAMES.length ||
      value.scales.length !== FEATURE_NAMES.length ||
      value.coefficients.length !== FEATURE_NAMES.length ||
      !value.means.every(Number.isFinite) ||
      !value.scales.every(scale => Number.isFinite(scale) && scale > 0) ||
      !value.coefficients.every(Number.isFinite) ||
      !Number.isFinite(value.intercept) ||
      !value.calibration ||
      !Number.isFinite(value.calibration.slope) ||
      !Number.isFinite(value.calibration.intercept) ||
      !Number.isFinite(record.marketProbabilityUp) ||
      record.marketProbabilityUp < 0 || record.marketProbabilityUp > 1 ||
      !FEATURE_NAMES.every(name => Number.isFinite(featureValue(record, name))))
    return null;
  const x = FEATURE_NAMES.map(name => featureValue(record, name));
  const raw = logistic(value.intercept! + x.reduce((sum, feature, index) =>
    sum + ((feature - value.means![index]) / value.scales![index]) *
      value.coefficients![index], 0));
  return logistic(value.calibration!.intercept +
    value.calibration!.slope * logit(raw));
}

function metrics(probabilities: readonly number[], labels: readonly number[]): WaterxCandidateMetrics {
  let brier = 0;
  let logLoss = 0;
  let correctDirections = 0;
  const bins = Array.from({ length: 10 }, (_, index) => ({
    lower: index / 10,
    upper: (index + 1) / 10,
    count: 0,
    predictedSum: 0,
    upCount: 0,
  }));
  for (let index = 0; index < labels.length; index++) {
    const p = Math.max(EPSILON, Math.min(1 - EPSILON, probabilities[index]));
    const y = labels[index];
    brier += (p - y) ** 2;
    logLoss -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
    correctDirections += p === 0.5 ? 0.5 : (p > 0.5 ? 1 : 0) === y ? 1 : 0;
    const bin = bins[Math.min(9, Math.floor(p * 10))];
    bin.count++;
    bin.predictedSum += p;
    bin.upCount += y;
  }
  return {
    count: labels.length,
    brier: brier / labels.length,
    logLoss: logLoss / labels.length,
    directionalAccuracy: correctDirections / labels.length,
    calibration: bins.map(bin => ({
      lower: bin.lower,
      upper: bin.upper,
      count: bin.count,
      meanPredicted: bin.count ? bin.predictedSum / bin.count : null,
      observedUpRate: bin.count ? bin.upCount / bin.count : null,
    })),
  };
}

function pairedLossComparison(
  candidate: readonly number[],
  market: readonly number[],
  labels: readonly number[],
): WaterxCandidatePairedComparison {
  if (candidate.length !== market.length || candidate.length !== labels.length || !labels.length)
    throw new Error("Matched candidate and market test probabilities must have identical non-empty rounds.");
  const pairedLoss = (probability: number, label: number, kind: "brier" | "logLoss") => {
    const p = Math.max(EPSILON, Math.min(1 - EPSILON, probability));
    return kind === "brier" ? (p - label) ** 2 :
      -(label * Math.log(p) + (1 - label) * Math.log(1 - p));
  };
  const summarize = (kind: "brier" | "logLoss") => {
    const differences = labels.map((label, index) =>
      pairedLoss(candidate[index], label, kind) - pairedLoss(market[index], label, kind));
    const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
    const variance = differences.length > 1
      ? differences.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        (differences.length - 1)
      : 0;
    const standardError = Math.sqrt(variance / differences.length);
    return {
      mean,
      standardError,
      normalApproximation95Lower: mean - 1.96 * standardError,
      normalApproximation95Upper: mean + 1.96 * standardError,
    };
  };
  const directionCredit = (probability: number, label: number) =>
    probability === 0.5 ? 0.5 : (probability > 0.5 ? 1 : 0) === label ? 1 : 0;
  const candidateCorrect = labels.reduce((sum, label, index) =>
    sum + directionCredit(candidate[index], label), 0);
  const marketCorrect = labels.reduce((sum, label, index) =>
    sum + directionCredit(market[index], label), 0);
  return {
    count: labels.length,
    candidateMinusMarketBrier: summarize("brier"),
    candidateMinusMarketLogLoss: summarize("logLoss"),
    directionalAccuracyDifference: (candidateCorrect - marketCorrect) / labels.length,
    uncertaintyNote: "Paired round-level loss differences with a normal-approximation 95% interval; descriptive only, unadjusted for serial dependence or model selection, and not a promotion test or model confidence score.",
  };
}

function evaluateProspectivePredictions(
  interval: WaterxCandidateInterval,
  records: readonly WaterxProspectiveRoundRecord[],
  duplicatedRoundIds: ReadonlySet<string>,
): WaterxProspectiveForwardEvaluation {
  const groups = new Map<string, {
    trainingAttemptAtMs: number;
    predictions: number;
    candidate: number[];
    market: number[];
    labels: number[];
  }>();
  for (const record of records) {
    if (duplicatedRoundIds.has(record.roundId) ||
        !validProspectivePrediction(record, interval))
      continue;
    const prediction = record.candidatePrediction;
    let group = groups.get(prediction.modelVersion);
    if (!group) {
      group = {
        trainingAttemptAtMs: prediction.trainingAttemptAtMs,
        predictions: 0,
        candidate: [],
        market: [],
        labels: [],
      };
      groups.set(prediction.modelVersion, group);
    }
    // One immutable interval/round prediction is the scoring unit.
    group.predictions++;
    if (!acceptedLabelIsValid(record)) continue;
    group.candidate.push(prediction.probabilityUp);
    group.market.push(record.marketProbabilityUp);
    group.labels.push(record.label.outcome === "Up" ? 1 : 0);
  }
  const byModelVersion = Array.from(groups.entries()).map(([modelVersion, group]) => {
    const scoredPredictionCount = group.labels.length;
    return {
      modelVersion,
      trainingAttemptAtMs: group.trainingAttemptAtMs,
      storedPredictionCount: group.predictions,
      scoredPredictionCount,
      unscoredPredictionCount: group.predictions - scoredPredictionCount,
      labelAvailabilityPercent: group.predictions
        ? Number((scoredPredictionCount / group.predictions * 100).toFixed(2)) : 0,
      candidateMetrics: scoredPredictionCount
        ? metrics(group.candidate, group.labels) : null,
      matchingMarketMetrics: scoredPredictionCount
        ? metrics(group.market, group.labels) : null,
      matchedComparison: scoredPredictionCount
        ? pairedLossComparison(group.candidate, group.market, group.labels) : null,
    };
  }).sort((a, b) => a.trainingAttemptAtMs - b.trainingAttemptAtMs ||
    a.modelVersion.localeCompare(b.modelVersion));
  const storedPredictionCount = byModelVersion.reduce(
    (sum, group) => sum + group.storedPredictionCount, 0);
  const scoredPredictionCount = byModelVersion.reduce(
    (sum, group) => sum + group.scoredPredictionCount, 0);
  return {
    storedPredictionCount,
    scoredPredictionCount,
    unscoredPredictionCount: storedPredictionCount - scoredPredictionCount,
    labelAvailabilityPercent: storedPredictionCount
      ? Number((scoredPredictionCount / storedPredictionCount * 100).toFixed(2)) : 0,
    coverageNote: "Label availability among persisted prospective predictions only; this is not capture coverage over all scheduled rounds.",
    byModelVersion,
  };
}

function hasBothClasses(rows: readonly ValidRow[]): boolean {
  return rows.some(row => row.y === 0) && rows.some(row => row.y === 1);
}

/**
 * Pure candidate fitting/evaluation. It never persists or promotes an artifact.
 * One frozen record and one accepted label per unique round are the only units
 * of evidence; callers must obtain these records from the authoritative store.
 */
export function trainWaterxCandidate(
  intervalMinutes: WaterxCandidateInterval,
  inputRecords: readonly WaterxProspectiveRoundRecord[],
): WaterxCandidateTrainingReport {
  assertInterval(intervalMinutes);
  // Interval is part of the dataset boundary: a 5m result is independent of
  // every 15m record, even if a caller accidentally supplies both cohorts.
  const intervalRecords = inputRecords.filter(record => record.intervalMinutes === intervalMinutes);
  const datasetFingerprint = fingerprint(intervalRecords);
  const seen = new Set<string>();
  const duplicatedRoundIds = new Set<string>();
  let duplicateCount = 0;
  for (const record of intervalRecords) {
    const key = `${record.intervalMinutes}\u0000${record.roundId}`;
    if (seen.has(key)) {
      duplicateCount++;
      duplicatedRoundIds.add(record.roundId);
    }
    seen.add(key);
  }

  const filtered = intervalRecords.filter(record => validRecord(record, intervalMinutes));
  const rows: ValidRow[] = filtered.filter(acceptedLabelIsValid).map(record => ({
    record,
    label: record.label,
    x: FEATURE_NAMES.map(name => featureValue(record, name)),
    y: record.label.outcome === "Up" ? 1 : 0,
  })).sort((a, b) =>
    a.record.startMs - b.record.startMs || a.record.roundId.localeCompare(b.record.roundId));
  const uniqueRows = rows.filter((row, index) => index === 0 ||
    row.record.roundId !== rows[index - 1].record.roundId);
  const eligibleRows = uniqueRows.filter(row => !duplicatedRoundIds.has(row.record.roundId));
  const rejectedRecordCount = intervalRecords.length - eligibleRows.length;

  const trainBoundary = Math.floor(eligibleRows.length * 0.6);
  const testBoundary = Math.floor(eligibleRows.length * 0.8);
  const rawTrain = eligibleRows.slice(0, trainBoundary);
  const rawCalibration = eligibleRows.slice(trainBoundary, testBoundary);
  const rawTest = eligibleRows.slice(testBoundary);
  const calibrationStartMs = rawCalibration[0]?.record.predictionAtMs ?? null;
  const testStartMs = rawTest[0]?.record.predictionAtMs ?? null;
  const embargoMs = intervalMinutes * 60_000;
  const train = calibrationStartMs === null ? [] : rawTrain.filter(row =>
    Math.max(row.label.settledAtMs, row.label.labelAvailableMs) <= calibrationStartMs - embargoMs);
  const calibration = testStartMs === null ? [] : rawCalibration.filter(row =>
    Math.max(row.label.settledAtMs, row.label.labelAvailableMs) <= testStartMs - embargoMs);
  const test = rawTest;
  const embargoExcludedCount =
    (rawTrain.length - train.length) + (rawCalibration.length - calibration.length);
  const spanMs = eligibleRows.length > 1
    ? eligibleRows.at(-1)!.record.startMs - eligibleRows[0].record.startMs
    : 0;

  const requirements = {
    minimumEligibleRounds: MINIMUMS.eligibleRounds,
    minimumTrainingRounds: MINIMUMS.trainingRounds,
    minimumCalibrationRounds: MINIMUMS.calibrationRounds,
    minimumTestRounds: MINIMUMS.testRounds,
    minimumSpanMs: MINIMUMS.spanMsByInterval[intervalMinutes],
    actualSpanMs: spanMs,
    trainingHasBothLabels: hasBothClasses(train),
    calibrationHasBothLabels: hasBothClasses(calibration),
    testHasBothLabels: hasBothClasses(test),
    duplicateRoundCount: duplicateCount,
  };
  const reasons: string[] = [];
  if (duplicateCount) reasons.push("Duplicate interval/round identities are present.");
  if (eligibleRows.length < MINIMUMS.eligibleRounds)
    reasons.push(`Need at least ${MINIMUMS.eligibleRounds} unique accepted-label rounds; found ${eligibleRows.length}.`);
  if (spanMs < MINIMUMS.spanMsByInterval[intervalMinutes])
    reasons.push("Prospective accepted-label history does not cover the required interval-specific span.");
  if (train.length < MINIMUMS.trainingRounds)
    reasons.push(`Training partition has ${train.length}; at least ${MINIMUMS.trainingRounds} post-embargo rounds are required.`);
  if (calibration.length < MINIMUMS.calibrationRounds)
    reasons.push(`Calibration partition has ${calibration.length}; at least ${MINIMUMS.calibrationRounds} post-embargo rounds are required.`);
  if (test.length < MINIMUMS.testRounds)
    reasons.push(`Untouched test partition has ${test.length}; at least ${MINIMUMS.testRounds} rounds are required.`);
  if (!hasBothClasses(train)) reasons.push("Training partition must contain accepted Up and Down labels.");
  if (!hasBothClasses(calibration)) reasons.push("Calibration partition must contain accepted Up and Down labels.");
  if (!hasBothClasses(test)) reasons.push("Untouched test partition must contain accepted Up and Down labels.");
  const eligible = reasons.length === 0;

  const base = {
    protocol: "waterx-prospective-round-candidate-v2" as const,
    intervalMinutes,
    artifactVersion: WATERX_CANDIDATE_ARTIFACT_VERSION as typeof WATERX_CANDIDATE_ARTIFACT_VERSION,
    datasetFingerprint,
    recordCount: intervalRecords.length,
    acceptedLabelCount: eligibleRows.length,
    rejectedRecordCount,
    split: {
      method: "Chronological round-grouped 60/20/20 split; training and calibration labels must be authoritatively available at least one full interval before the next partition begins. Test labels are never used for fitting.",
      trainCount: train.length,
      calibrationCount: calibration.length,
      testCount: test.length,
      embargoExcludedCount,
      trainThroughMs: train.at(-1)?.record.startMs ?? null,
      calibrationFromMs: calibration[0]?.record.startMs ?? null,
      calibrationThroughMs: calibration.at(-1)?.record.startMs ?? null,
      testFromMs: test[0]?.record.startMs ?? null,
    },
    eligibility: {
      eligible,
      requirements,
      rejectionReason: reasons.length ? reasons.join(" ") : null,
    },
    forwardPredictionEvaluation: evaluateProspectivePredictions(
      intervalMinutes, intervalRecords, duplicatedRoundIds),
    rejectionReason: reasons.length
      ? reasons.join(" ")
      : "Candidate remains shadow-only; promotion is disabled and requires a separately reviewed promotion gate.",
    promoted: false as const,
    promotionRejectionReason:
      "Promotion is intentionally disabled in this pure candidate-training module; no serving model was written or changed.",
  };

  if (!eligible) {
    return {
      ...base, status: "insufficient", candidateTestMetrics: null,
      matchingMarketTestMetrics: null, matchedTestComparison: null,
      testRegimeEvaluations: [], artifact: null,
    };
  }

  const means = FEATURE_NAMES.map((_, column) =>
    train.reduce((sum, row) => sum + row.x[column], 0) / train.length);
  const scales = FEATURE_NAMES.map((_, column) => {
    const variance = train.reduce((sum, row) =>
      sum + (row.x[column] - means[column]) ** 2, 0) / train.length;
    return Math.sqrt(variance) || 1;
  });
  const standardized = (selected: readonly ValidRow[]) => selected.map(row =>
    row.x.map((value, column) => (value - means[column]) / scales[column]));
  const fitted = fitLogistic(standardized(train), train.map(row => row.y), REGULARIZATION, 1500);

  // Platt calibration is fit only on the distinct chronological calibration block.
  const calibrationLogits = calibration.map(row =>
    logit(candidateRawProbability(row, means, scales, fitted.coefficients, fitted.intercept)));
  const calibrationFit = fitLogistic(
    calibrationLogits.map(value => [value]), calibration.map(row => row.y), REGULARIZATION, 1500);
  const calibrated = test.map(row => {
    const rawLogit = logit(candidateRawProbability(
      row, means, scales, fitted.coefficients, fitted.intercept));
    return logistic(calibrationFit.intercept + calibrationFit.coefficients[0] * rawLogit);
  });
  const candidateTestMetrics = metrics(calibrated, test.map(row => row.y));
  const testLabels = test.map(row => row.y);
  const marketProbabilities = test.map(row => row.record.marketProbabilityUp);
  const matchingMarketTestMetrics = metrics(marketProbabilities, testLabels);
  const matchedTestComparison = pairedLossComparison(calibrated, marketProbabilities, testLabels);
  const evaluationRows = test.map((row, index) => ({
    candidate: calibrated[index],
    market: row.record.marketProbabilityUp,
    label: row.y,
    timeRemainingFraction: row.record.features.timeRemainingFraction,
  }));
  const regimes: readonly WaterxCandidateRegimeEvaluation[] = [
    ...([
      { band: "early-round: remaining > 2/3", includes: (value: number) => value > 2 / 3 },
      { band: "mid-round: remaining > 1/3 to 2/3", includes: (value: number) => value > 1 / 3 && value <= 2 / 3 },
      { band: "late-round: remaining <= 1/3", includes: (value: number) => value <= 1 / 3 },
    ] as const).map(({ band, includes }) => {
      const selected = evaluationRows.filter(row => includes(row.timeRemainingFraction));
      return {
        dimension: "time-remaining" as const,
        band,
        count: selected.length,
        candidate: selected.length ? metrics(selected.map(row => row.candidate), selected.map(row => row.label)) : null,
        market: selected.length ? metrics(selected.map(row => row.market), selected.map(row => row.label)) : null,
      };
    }),
    ...([
      { band: "market-UP-low: p < 0.4", includes: (value: number) => value < 0.4 },
      { band: "market-balanced: 0.4 <= p <= 0.6", includes: (value: number) => value >= 0.4 && value <= 0.6 },
      { band: "market-UP-high: p > 0.6", includes: (value: number) => value > 0.6 },
    ] as const).map(({ band, includes }) => {
      const selected = evaluationRows.filter(row => includes(row.market));
      return {
        dimension: "market-probability" as const,
        band,
        count: selected.length,
        candidate: selected.length ? metrics(selected.map(row => row.candidate), selected.map(row => row.label)) : null,
        market: selected.length ? metrics(selected.map(row => row.market), selected.map(row => row.label)) : null,
      };
    }),
  ];
  const fittedModelFingerprint = createHash("sha256").update(JSON.stringify([
    intervalMinutes, FEATURE_NAMES, means, scales, fitted.coefficients, fitted.intercept,
    calibrationFit.coefficients[0], calibrationFit.intercept,
  ])).digest("hex");
  const artifact: WaterxCandidateModelArtifact = {
    artifactVersion: WATERX_CANDIDATE_ARTIFACT_VERSION,
    modelVersion: `${WATERX_CANDIDATE_ARTIFACT_VERSION}:${fittedModelFingerprint.slice(0, 16)}`,
    intervalMinutes,
    datasetFingerprint,
    featureSchema: WATERX_CANDIDATE_FEATURE_SCHEMA,
    featureNames: FEATURE_NAMES,
    means,
    scales,
    coefficients: fitted.coefficients,
    intercept: fitted.intercept,
    calibration: {
      slope: calibrationFit.coefficients[0],
      intercept: calibrationFit.intercept,
    },
  };
  return {
    ...base, status: "candidate-evaluated", candidateTestMetrics,
    matchingMarketTestMetrics, matchedTestComparison, testRegimeEvaluations: regimes, artifact,
  };
}

/**
 * Integration contract:
 * - Supply exactly one frozen pre-expiry snapshot for each WaterX interval/round.
 * - Populate label only from the existing authoritative accepted-settlement
 *   path, including its first accepted label-availability time.
 * - Run this off the live request/collection path and retain the report/artifact
 *   as a shadow candidate only after a separately reviewed persistence design.
 * - Keep champion selection, rollback, scheduling, and serving outside this
 *   module. In particular, never publish this candidate as a forecast.
 */