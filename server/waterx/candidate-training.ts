import { createHash } from "node:crypto";

export type WaterxCandidateInterval = 5 | 15;
export const WATERX_CANDIDATE_ARTIFACT_VERSION = "waterx-logistic-candidate-v1";
export const WATERX_CANDIDATE_FEATURE_SCHEMA = "waterx-round-snapshot-v1";

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
  /** Null means no authoritative accepted label is currently available. */
  label: WaterxAcceptedLabel | null;
}>;

export type WaterxCandidateMetrics = Readonly<{
  count: number;
  brier: number;
  logLoss: number;
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
  protocol: "waterx-prospective-round-candidate-v1";
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
  artifact: WaterxCandidateModelArtifact | null;
  promoted: false;
  promotionRejectionReason: string;
}>;

const FEATURE_NAMES = [
  "referenceDistanceBps",
  "timeRemainingFraction",
  "return1m",
  "return3m",
  "realizedVolatilityBps",
  "marketProbabilityUpDelta",
  "sourceAgeMs",
] as const;

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
    FEATURE_NAMES.map(name => record.features[name]),
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
    ...FEATURE_NAMES.map(name => record.features?.[name]),
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

function metrics(probabilities: readonly number[], labels: readonly number[]): WaterxCandidateMetrics {
  let brier = 0;
  let logLoss = 0;
  for (let index = 0; index < labels.length; index++) {
    const p = Math.max(EPSILON, Math.min(1 - EPSILON, probabilities[index]));
    const y = labels[index];
    brier += (p - y) ** 2;
    logLoss -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
  }
  return {
    count: labels.length,
    brier: brier / labels.length,
    logLoss: logLoss / labels.length,
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
  let duplicateCount = 0;
  for (const record of intervalRecords) {
    const key = `${record.intervalMinutes}\u0000${record.roundId}`;
    if (seen.has(key)) duplicateCount++;
    seen.add(key);
  }

  const filtered = intervalRecords.filter(record => validRecord(record, intervalMinutes));
  const rows: ValidRow[] = filtered.filter(acceptedLabelIsValid).map(record => ({
    record,
    label: record.label,
    x: FEATURE_NAMES.map(name => record.features[name]),
    y: record.label.outcome === "Up" ? 1 : 0,
  })).sort((a, b) =>
    a.record.startMs - b.record.startMs || a.record.roundId.localeCompare(b.record.roundId));
  const uniqueRows = rows.filter((row, index) => index === 0 ||
    row.record.roundId !== rows[index - 1].record.roundId);
  const eligibleRows = uniqueRows.filter(row => !intervalRecords.some(other =>
    other !== row.record && other.intervalMinutes === intervalMinutes &&
    other.roundId === row.record.roundId));
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
    protocol: "waterx-prospective-round-candidate-v1" as const,
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
      matchingMarketTestMetrics: null, artifact: null,
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
  const matchingMarketTestMetrics = metrics(
    test.map(row => row.record.marketProbabilityUp), test.map(row => row.y));
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
    matchingMarketTestMetrics, artifact,
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