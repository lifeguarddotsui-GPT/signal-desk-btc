import { createHash } from "node:crypto";
import type { ReferenceQuality } from "../../shared/waterx-research";

const EPSILON = 1e-10;
const MINIMUMS = {
  records: 90,
  training: 40,
  calibration: 20,
  test: 20,
  spanMs: { 5: 48 * 60 * 60_000, 15: 7 * 24 * 60 * 60_000 },
} as const;

export type ResearchTrainingRound = Readonly<{
  intervalMinutes: 5 | 15;
  roundId: string;
  startMs: number;
  expiryMs: number;
  decisionAtMs: number;
  referenceObservedAtMs: number;
  marketObservedAtMs: number;
  probabilityUp: number;
  marketProbabilityUp: number;
  referencePrice: number;
  referenceQuality: Exclude<ReferenceQuality, "unavailable">;
  comparisonPrice: number;
  comparisonSourceAtMs: number;
  comparisonReceivedAtMs: number;
  return1m: number;
  return3m: number;
  realizedVolatilityBps: number;
  settlementAnchorPrice: number;
  settlePrice: number;
  outcome: "UP" | "DOWN";
  settledAtMs: number;
  labelAvailableAtMs: number;
}>;

export const RESEARCH_SHADOW_FEATURE_NAMES = [
  "marketProbabilityUp",
  "referenceDistanceBps",
  "timeRemainingFraction",
  "return1m",
  "return3m",
  "realizedVolatilityBps",
  "sourceAgeMs",
] as const;

export type ResearchShadowArtifact = Readonly<{
  status: "shadow-only";
  promoted: false;
  version: string;
  datasetFingerprint: string;
  featureNames: string[];
  means: number[];
  scales: number[];
  coefficients: number[];
  intercept: number;
  calibration: { slope: number; intercept: number };
  evidenceAvailableThroughMs: number;
}>;

export type ResearchShadowFeatures = Readonly<{
  marketProbabilityUp: number;
  referenceDistanceBps: number;
  timeRemainingFraction: number;
  return1m: number;
  return3m: number;
  realizedVolatilityBps: number;
  sourceAgeMs: number;
}>;

type Eligible = ResearchTrainingRound & { values: number[]; y: number };
type GroupMetric = Readonly<{
  count: number; brier: number; logLoss: number; accuracy: number;
  calibration: readonly Readonly<{
    lower: number; upper: number; count: number;
    meanPredicted: number | null; observedUpRate: number | null;
  }>[];
}>;

export type ResearchTrainingReport = Readonly<{
  status: "insufficient" | "candidate-evaluated";
  intervalMinutes: 5 | 15;
  protocol: "waterx-frozen-research-choices-60-20-20-v2";
  datasetFingerprint: string;
  datasetCount: number;
  uniqueEligibleCount: number;
  rejectedCount: number;
  evidenceAvailableThroughMs: number;
  provisionalReferenceCount: number;
  confirmedReferenceCount: number;
  spanMs: number;
  split: {
    method: string;
    trainingCount: number;
    calibrationCount: number;
    testCount: number;
    embargoExcludedCount: number;
    trainThroughMs: number | null;
    calibrationFromMs: number | null;
    calibrationThroughMs: number | null;
    testFromMs: number | null;
  };
  eligibility: { eligible: boolean; reasons: string[] };
  test: {
    count: number; candidate: GroupMetric | null; market: GroupMetric | null;
    referenceCohorts: {
      referenceQuality: ReferenceQuality;
      count: number;
      brier: number | null;
      meanReferenceSettlementDiscrepancyUsd: number | null;
    }[];
    timeRemaining: { bucket: string; count: number; brier: number | null }[];
    pairedBrierDifference: { mean: number; standardError: number; lower95: number; upper95: number } | null;
    adequateCoverage: boolean;
  };
  calibrationFit: { method: "Platt logistic on later chronological calibration partition"; count: number } | null;
  shadowArtifact: ResearchShadowArtifact | null;
  promotion: { enabled: false; eligible: false; reason: string };
  rejectionReasons: string[];
}>;

const FEATURES = RESEARCH_SHADOW_FEATURE_NAMES;

function logistic(value: number): number {
  const bounded = Math.max(-25, Math.min(25, value));
  return 1 / (1 + Math.exp(-bounded));
}

function logit(probability: number): number {
  const bounded = Math.max(EPSILON, Math.min(1 - EPSILON, probability));
  return Math.log(bounded / (1 - bounded));
}

/** Exact inference path paired with daily shadow training, including its
 * separate Platt calibration fit. It never changes the official choice. */
export function predictWaterxResearchShadow(
  artifact: ResearchShadowArtifact,
  features: ResearchShadowFeatures,
): number {
  const featureValues = [
    features.marketProbabilityUp,
    features.referenceDistanceBps,
    features.timeRemainingFraction,
    features.return1m,
    features.return3m,
    features.realizedVolatilityBps,
    features.sourceAgeMs,
  ];
  const width = RESEARCH_SHADOW_FEATURE_NAMES.length;
  if (artifact.status !== "shadow-only" || artifact.promoted !== false ||
      artifact.featureNames.length !== width ||
      artifact.featureNames.some((name, index) => name !== RESEARCH_SHADOW_FEATURE_NAMES[index]) ||
      artifact.means.length !== width || artifact.scales.length !== width ||
      artifact.coefficients.length !== width ||
      ![...artifact.means, ...artifact.scales, ...artifact.coefficients,
        artifact.intercept, artifact.calibration.slope, artifact.calibration.intercept,
        artifact.evidenceAvailableThroughMs, ...featureValues].every(Number.isFinite) ||
      artifact.means.some(mean => Math.abs(mean) > 100_000) ||
      artifact.scales.some(scale => scale <= 1e-12 || scale > 100_000) ||
      artifact.coefficients.some(coefficient => Math.abs(coefficient) > 1_000) ||
      Math.abs(artifact.intercept) > 1_000 ||
      Math.abs(artifact.calibration.slope) > 1_000 ||
      Math.abs(artifact.calibration.intercept) > 1_000 ||
      features.marketProbabilityUp < 0 || features.marketProbabilityUp > 1 ||
      features.referenceDistanceBps < -100_000 || features.referenceDistanceBps > 100_000 ||
      features.timeRemainingFraction < 0 || features.timeRemainingFraction > 1 ||
      Math.abs(features.return1m) > 0.1 || Math.abs(features.return3m) > 0.1 ||
      features.realizedVolatilityBps < 0 || features.realizedVolatilityBps > 500 ||
      features.sourceAgeMs < 0 || features.sourceAgeMs > 15_000)
    throw new Error("Research shadow artifact or point-in-time features failed inference validation.");
  const standardized = featureValues.map((value, index) =>
    (value - artifact.means[index]) / artifact.scales[index]);
  const raw = logistic(artifact.intercept +
    standardized.reduce((sum, value, index) => sum + value * artifact.coefficients[index], 0));
  const calibrated = logistic(artifact.calibration.intercept +
    artifact.calibration.slope * logit(raw));
  if (!Number.isFinite(calibrated) || calibrated < 0 || calibrated > 1)
    throw new Error("Research shadow model returned an invalid calibrated probability.");
  return calibrated;
}

export function fitLogistic(
  matrix: readonly (readonly number[])[],
  labels: readonly number[],
  ridge: number,
  iterations: number,
): { coefficients: number[]; intercept: number } {
  if (!matrix.length || !matrix[0]?.length) throw new Error("Research training partition is empty.");
  const width = matrix[0].length;
  let intercept = logit((labels.reduce((total, value) => total + value, 0) + 0.5) /
    (labels.length + 1));
  const coefficients = Array.from({ length: width }, () => 0);
  const rate = 0.08;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradients = Array.from({ length: width }, () => 0);
    let interceptGradient = 0;
    for (let row = 0; row < labels.length; row++) {
      const prediction = logistic(intercept +
        matrix[row].reduce((sum, value, column) => sum + value * coefficients[column], 0));
      const error = prediction - labels[row];
      interceptGradient += error;
      for (let column = 0; column < width; column++)
        gradients[column] += error * matrix[row][column];
    }
    intercept -= rate * interceptGradient / labels.length;
    for (let column = 0; column < width; column++)
      coefficients[column] -= rate *
        (gradients[column] / labels.length + ridge * coefficients[column]);
  }
  return { coefficients, intercept };
}

function metrics(probabilities: readonly number[], labels: readonly number[]): GroupMetric {
  if (!probabilities.length || probabilities.length !== labels.length)
    throw new Error("Research evaluation requires matched non-empty probabilities and labels.");
  const bins = Array.from({ length: 10 }, (_, index) => ({
    lower: index / 10, upper: (index + 1) / 10, count: 0, p: 0, up: 0,
  }));
  let brier = 0;
  let logLoss = 0;
  let correct = 0;
  probabilities.forEach((raw, index) => {
    const p = Math.max(EPSILON, Math.min(1 - EPSILON, raw));
    const y = labels[index];
    brier += (p - y) ** 2;
    logLoss -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
    correct += p === 0.5 ? 0.5 : ((p > 0.5 ? 1 : 0) === y ? 1 : 0);
    const bin = bins[Math.min(9, Math.floor(p * 10))];
    bin.count++;
    bin.p += p;
    bin.up += y;
  });
  return {
    count: labels.length,
    brier: brier / labels.length,
    logLoss: logLoss / labels.length,
    accuracy: correct / labels.length,
    calibration: bins.map(bin => ({
      lower: bin.lower, upper: bin.upper, count: bin.count,
      meanPredicted: bin.count ? bin.p / bin.count : null,
      observedUpRate: bin.count ? bin.up / bin.count : null,
    })),
  };
}

export function validResearchTrainingRound(row: ResearchTrainingRound, interval: number): boolean {
  const referenceDistanceBps = (row.comparisonPrice / row.referencePrice - 1) * 10_000;
  const finite = [
    row.startMs, row.expiryMs, row.decisionAtMs, row.probabilityUp,
    row.marketProbabilityUp, row.referencePrice, row.comparisonPrice,
    row.comparisonSourceAtMs, row.comparisonReceivedAtMs,
    row.referenceObservedAtMs, row.marketObservedAtMs,
    row.return1m, row.return3m, row.realizedVolatilityBps,
    row.settlementAnchorPrice, row.settlePrice, row.settledAtMs, row.labelAvailableAtMs,
  ].every(Number.isFinite);
  if (!finite || row.intervalMinutes !== interval || !row.roundId.trim() ||
      row.expiryMs - row.startMs !== interval * 60_000 ||
      row.decisionAtMs < row.startMs || row.decisionAtMs >= row.expiryMs ||
      row.comparisonSourceAtMs > row.decisionAtMs ||
      row.comparisonReceivedAtMs > row.decisionAtMs ||
      row.referenceObservedAtMs < row.startMs ||
      row.referenceObservedAtMs > row.decisionAtMs ||
      row.marketObservedAtMs < row.startMs ||
      row.marketObservedAtMs > row.decisionAtMs ||
      row.decisionAtMs - row.marketObservedAtMs > 10_000 ||
      row.decisionAtMs - row.comparisonSourceAtMs > 15_000 ||
      row.comparisonSourceAtMs - row.comparisonReceivedAtMs > 15_000 ||
      row.probabilityUp < 0 || row.probabilityUp > 1 ||
      row.marketProbabilityUp < 0 || row.marketProbabilityUp > 1 ||
      row.referencePrice <= 0 || row.comparisonPrice <= 0 ||
      !Number.isFinite(referenceDistanceBps) || Math.abs(referenceDistanceBps) > 100_000 ||
      row.realizedVolatilityBps < 0 || row.realizedVolatilityBps > 500 ||
      Math.abs(row.return1m) > 0.1 || Math.abs(row.return3m) > 0.1 ||
      row.settlementAnchorPrice <= 0 || row.settlePrice <= 0 ||
      row.settledAtMs <= row.expiryMs || row.labelAvailableAtMs < row.settledAtMs ||
      (row.outcome === "UP"
        ? row.settlePrice < row.settlementAnchorPrice
        : row.settlePrice >= row.settlementAnchorPrice))
    return false;
  return row.referenceQuality === "provisional" || row.referenceQuality === "confirmed";
}

function rejectedReport(
  intervalMinutes: 5 | 15,
  datasetFingerprint: string,
  datasetCount: number,
  rejectionReasons: string[],
  eligibleCount: number,
  evidenceAvailableThroughMs: number,
  provisionalCount: number,
  confirmedCount: number,
  spanMs: number,
  split: ResearchTrainingReport["split"],
  candidates?: {
    eligible: Eligible[]; training: Eligible[]; calibration: Eligible[]; test: Eligible[];
    embargoExcludedCount: number;
  },
): ResearchTrainingReport {
  const reasons = [...rejectionReasons];
  if (eligibleCount < 90) reasons.push(`Need at least 90 unique verified research choices; found ${eligibleCount}.`);
  if (spanMs < MINIMUMS.spanMs[intervalMinutes])
    reasons.push(`Need ${intervalMinutes === 5 ? "48 hours" : "7 days"} of prospective frozen-choice history.`);
  if (candidates) {
    if (candidates.training.length < 40) reasons.push(`Post-embargo training partition has ${candidates.training.length}; need 40.`);
    if (candidates.calibration.length < 20) reasons.push(`Post-embargo calibration partition has ${candidates.calibration.length}; need 20.`);
    if (candidates.test.length < 20) reasons.push(`Untouched later test partition has ${candidates.test.length}; need 20.`);
    if (!candidates.training.some(row => row.y === 1) ||
        !candidates.training.some(row => row.y === 0))
      reasons.push("Training partition needs both accepted outcomes.");
    if (!candidates.calibration.some(row => row.y === 1) ||
        !candidates.calibration.some(row => row.y === 0))
      reasons.push("Calibration partition needs both accepted outcomes.");
    if (!candidates.test.some(row => row.y === 1) ||
        !candidates.test.some(row => row.y === 0))
      reasons.push("Untouched test partition needs both accepted outcomes.");
  }
  return {
    status: "insufficient",
    intervalMinutes,
    protocol: "waterx-frozen-research-choices-60-20-20-v2",
    datasetFingerprint,
    datasetCount,
    uniqueEligibleCount: eligibleCount,
    rejectedCount: datasetCount - eligibleCount,
    evidenceAvailableThroughMs,
    provisionalReferenceCount: provisionalCount,
    confirmedReferenceCount: confirmedCount,
    spanMs,
    split,
    eligibility: { eligible: false, reasons },
    test: {
      count: 0, candidate: null, market: null,
      referenceCohorts: [], timeRemaining: [], pairedBrierDifference: null,
      adequateCoverage: false,
    },
    calibrationFit: null,
    shadowArtifact: null,
    promotion: { enabled: false, eligible: false, reason: "Promotion is disabled; offline runs are shadow-only." },
    rejectionReasons: Array.from(new Set(reasons)),
  };
}

/** Fits features only from immutable research choices and later-verified labels.
 * Provisional point-in-time references remain provisional and form a cohort.
 * Later test labels are never used to fit or calibrate. */
export function trainWaterxResearchChoices(
  intervalMinutes: 5 | 15,
  rawRows: readonly ResearchTrainingRound[],
  onPhase?: (phase: "training" | "trained" | "calibrating" | "calibrated" | "evaluating" | "evaluated") => void,
  featureNames: readonly string[] = RESEARCH_SHADOW_FEATURE_NAMES,
): ResearchTrainingReport {
  if (!featureNames.length || new Set(featureNames).size !== featureNames.length ||
      featureNames.some(name => !(RESEARCH_SHADOW_FEATURE_NAMES as readonly string[]).includes(name)))
    throw new Error("Unsupported deterministic research feature subset.");
  if (featureNames.some((name, i) => (RESEARCH_SHADOW_FEATURE_NAMES as readonly string[]).indexOf(name) <=
      (i ? (RESEARCH_SHADOW_FEATURE_NAMES as readonly string[]).indexOf(featureNames[i - 1]) : -1)))
    throw new Error("Feature subset must retain reproducible schema order.");
  const FEATURES = featureNames;
  const ordered = [...rawRows].sort((a, b) =>
    a.intervalMinutes - b.intervalMinutes || a.startMs - b.startMs || a.roundId.localeCompare(b.roundId));
  const fingerprint = createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
  const intervalRows = ordered.filter(row => row.intervalMinutes === intervalMinutes);
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const row of intervalRows) {
    const key = `${intervalMinutes}\0${row.roundId}`;
    if (seen.has(key)) duplicate.add(row.roundId);
    seen.add(key);
  }
  const validRows = intervalRows.filter(row => !duplicate.has(row.roundId) && validResearchTrainingRound(row, intervalMinutes));
  const provisionalCount = validRows.filter(row => row.referenceQuality === "provisional").length;
  const confirmedCount = validRows.filter(row => row.referenceQuality === "confirmed").length;
  const rows: Eligible[] = validRows.map(row => ({
    ...row,
    y: row.outcome === "UP" ? 1 : 0,
    values: [
      row.marketProbabilityUp,
      (row.comparisonPrice / row.referencePrice - 1) * 10_000,
      (row.expiryMs - row.decisionAtMs) / (row.expiryMs - row.startMs),
      row.return1m,
      row.return3m,
      row.realizedVolatilityBps,
      row.decisionAtMs - row.comparisonSourceAtMs,
    ].filter((_, index) => featureNames.includes(RESEARCH_SHADOW_FEATURE_NAMES[index])),
  }));
  const spanMs = rows.length > 1 ? rows.at(-1)!.startMs - rows[0].startMs : 0;
  const evidenceAvailableThroughMs = rows.length
    ? Math.max(...rows.flatMap(row => [
      row.decisionAtMs, row.referenceObservedAtMs, row.marketObservedAtMs,
      row.comparisonReceivedAtMs, row.settledAtMs, row.labelAvailableAtMs,
    ]))
    : 0;
  const trainEnd = Math.floor(rows.length * 0.6);
  const calibrationEnd = Math.floor(rows.length * 0.8);
  const rawTraining = rows.slice(0, trainEnd);
  const rawCalibration = rows.slice(trainEnd, calibrationEnd);
  const rawTest = rows.slice(calibrationEnd);
  const embargoMs = intervalMinutes * 60_000;
  const calibrationStart = rawCalibration[0]?.decisionAtMs ?? null;
  const testStart = rawTest[0]?.decisionAtMs ?? null;
  const training = calibrationStart === null ? [] : rawTraining.filter(row =>
    Math.max(row.settledAtMs, row.labelAvailableAtMs) <= calibrationStart - embargoMs);
  const calibration = testStart === null ? [] : rawCalibration.filter(row =>
    Math.max(row.settledAtMs, row.labelAvailableAtMs) <= testStart - embargoMs);
  const test = rawTest;
  const embargoExcludedCount = rawTraining.length - training.length +
    rawCalibration.length - calibration.length;
  const split: ResearchTrainingReport["split"] = {
    method: "Chronological round-start 60/20/20; later block Platt calibration; untouched final 20% test. Training/calibration settlement AND label-availability must precede next block by one full interval. Research comparison prices/features are immutable point-in-time values. Provisional-reference cohort is retained separately.",
    trainingCount: training.length,
    calibrationCount: calibration.length,
    testCount: test.length,
    embargoExcludedCount,
    trainThroughMs: training.at(-1)?.startMs ?? null,
    calibrationFromMs: calibration.at(0)?.startMs ?? null,
    calibrationThroughMs: calibration.at(-1)?.startMs ?? null,
    testFromMs: test.at(0)?.startMs ?? null,
  };
  const reasons: string[] = [];
  if (duplicate.size) reasons.push("Duplicate interval/round identities were excluded.");
  if (intervalRows.length > 5_000) reasons.push("Dataset exceeds the 5,000-record bound.");
  if (rawRows.some(row => row.intervalMinutes !== 5 && row.intervalMinutes !== 15))
    reasons.push("Unsupported research interval was supplied.");
  if (reasons.length || training.length < 40 || calibration.length < 20 || test.length < 20 ||
      !training.some(row => row.y === 1) || !training.some(row => row.y === 0) ||
      !calibration.some(row => row.y === 1) || !calibration.some(row => row.y === 0) ||
      !test.some(row => row.y === 1) || !test.some(row => row.y === 0))
    return rejectedReport(intervalMinutes, fingerprint, intervalRows.length, reasons,
      rows.length, evidenceAvailableThroughMs, provisionalCount, confirmedCount, spanMs, split,
      { eligible: rows, training, calibration, test, embargoExcludedCount });
  if (rows.length < 90 || spanMs < MINIMUMS.spanMs[intervalMinutes])
    return rejectedReport(intervalMinutes, fingerprint, intervalRows.length, reasons,
      rows.length, evidenceAvailableThroughMs, provisionalCount, confirmedCount, spanMs, split,
      { eligible: rows, training, calibration, test, embargoExcludedCount });

  const means = FEATURES.map((_, column) =>
    training.reduce((sum, row) => sum + row.values[column], 0) / training.length);
  const scales = FEATURES.map((_, column) => Math.sqrt(training.reduce(
    (sum, row) => sum + (row.values[column] - means[column]) ** 2, 0) / training.length) || 1);
  const scaled = (part: readonly Eligible[]) => part.map(row =>
    row.values.map((value, index) => (value - means[index]) / scales[index]));
  onPhase?.("training");
  const fit = fitLogistic(scaled(training), training.map(row => row.y), 0.1, 1000);
  onPhase?.("trained");
  const rawProbability = (row: Eligible) => logistic(fit.intercept +
    row.values.reduce((sum, value, index) =>
      sum + ((value - means[index]) / scales[index]) * fit.coefficients[index], 0));
  onPhase?.("calibrating");
  const calibrationLogits = calibration.map(row => logit(rawProbability(row)));
  const calibrationFit = fitLogistic(calibrationLogits.map(value => [value]),
    calibration.map(row => row.y), 0.1, 600);
  onPhase?.("calibrated");
  onPhase?.("evaluating");
  const calibrated = (row: Eligible) =>
    logistic(calibrationFit.intercept + calibrationFit.coefficients[0] * logit(rawProbability(row)));
  const candidate = metrics(test.map(calibrated), test.map(row => row.y));
  const market = metrics(test.map(row => row.marketProbabilityUp), test.map(row => row.y));
  const differences = test.map((row, index) =>
    (calibrated(row) - row.y) ** 2 - (row.marketProbabilityUp - row.y) ** 2);
  const pairedMean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const standardError = differences.length > 1 ? Math.sqrt(differences.reduce(
    (sum, value) => sum + (value - pairedMean) ** 2, 0) /
    (differences.length - 1) / differences.length) : 0;
  const referenceCohorts = (["provisional", "confirmed"] as const).map(quality => {
    const selected = test.filter(row => row.referenceQuality === quality);
    return {
      referenceQuality: quality,
      count: selected.length,
      brier: selected.length ? metrics(selected.map(calibrated), selected.map(row => row.y)).brier : null,
      meanReferenceSettlementDiscrepancyUsd: selected.length
        ? selected.reduce((sum, row) =>
          sum + Math.abs(row.referencePrice - row.settlementAnchorPrice), 0) / selected.length
        : null,
    };
  });
  const timeRemaining = ([
    { bucket: "0-25%", selected: test.filter(row => (row.expiryMs - row.decisionAtMs) /
      (row.expiryMs - row.startMs) <= 0.25) },
    { bucket: "25-50%", selected: test.filter(row => {
      const fraction = (row.expiryMs - row.decisionAtMs) / (row.expiryMs - row.startMs);
      return fraction > 0.25 && fraction <= 0.5;
    }) },
    { bucket: "50-100%", selected: test.filter(row => (row.expiryMs - row.decisionAtMs) /
      (row.expiryMs - row.startMs) > 0.5) },
  ]).map(({ bucket, selected }) => ({
    bucket,
    count: selected.length,
    brier: selected.length ? metrics(selected.map(calibrated), selected.map(row => row.y)).brier : null,
  }));
  const adequateCoverage = test.length >= 20 && candidate.count === test.length;
  onPhase?.("evaluated");
  const rejectionReasons: string[] = [];
  if (!adequateCoverage) rejectionReasons.push("Held-out coverage did not meet the minimum.");
  if (pairedMean >= 0) rejectionReasons.push("Held-out candidate Brier loss did not improve over the matched WaterX baseline.");
  if (pairedMean + 1.96 * standardError >= 0)
    rejectionReasons.push("Paired held-out Brier uncertainty does not demonstrate improvement.");
  return {
    status: "candidate-evaluated",
    intervalMinutes,
    protocol: "waterx-frozen-research-choices-60-20-20-v2",
    datasetFingerprint: fingerprint,
    datasetCount: intervalRows.length,
    uniqueEligibleCount: rows.length,
    rejectedCount: intervalRows.length - rows.length,
      evidenceAvailableThroughMs,
    provisionalReferenceCount: provisionalCount,
    confirmedReferenceCount: confirmedCount,
    spanMs,
    split,
    eligibility: { eligible: true, reasons: [] },
    test: {
      count: test.length,
      candidate,
      market,
      referenceCohorts,
      timeRemaining,
      pairedBrierDifference: {
        mean: pairedMean,
        standardError,
        lower95: pairedMean - 1.96 * standardError,
        upper95: pairedMean + 1.96 * standardError,
      },
      adequateCoverage,
    },
    calibrationFit: {
      method: "Platt logistic on later chronological calibration partition",
      count: calibration.length,
    },
    shadowArtifact: {
      status: "shadow-only",
      promoted: false,
      version: `waterx-research-shadow-v2:${intervalMinutes}:${fingerprint.slice(0, 16)}`,
      datasetFingerprint: fingerprint,
      featureNames: [...FEATURES],
      means, scales, coefficients: fit.coefficients, intercept: fit.intercept,
      calibration: {
        slope: calibrationFit.coefficients[0], intercept: calibrationFit.intercept,
      },
      evidenceAvailableThroughMs,
    },
    promotion: {
      enabled: false,
      eligible: false,
      reason: rejectionReasons[0] ??
        "A one-time chronological split is not ongoing forward validation. Promotion is explicitly disabled.",
    },
    rejectionReasons,
  };
}
