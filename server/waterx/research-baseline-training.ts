import { createHash } from "node:crypto";

const EPSILON = 1e-10;
const MINIMUMS = {
  records: 90,
  training: 40,
  calibration: 20,
  test: 20,
  spanMs: { 5: 48 * 60 * 60_000, 15: 7 * 24 * 60 * 60_000 },
} as const;

export type CanonicalTrainingChoice = Readonly<{
  intervalMinutes: 5 | 15;
  roundId: string;
  startMs: number;
  expiryMs: number;
  decisionAtMs: number;
  probabilityUp: number;
  outcome: "UP" | "DOWN";
  settledAtMs: number;
  labelAvailableAtMs: number;
}>;

export type CanonicalBaselineArtifact = Readonly<{
  status: "shadow-only";
  promoted: false;
  version: string;
  datasetFingerprint: string;
  probabilityField: "frozenChoice.probabilityUp";
  method: "Platt logistic calibration of frozen choice probability";
  calibration: { slope: number; intercept: number };
  evidenceAvailableThroughMs: number;
}>;

type Bin = {
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number | null;
  observedUpRate: number | null;
};

type Metrics = {
  count: number;
  brier: number;
  logLoss: number;
  accuracy: number;
  calibration: Bin[];
};

export type CanonicalTrainingReport = Readonly<{
  status: "insufficient" | "candidate-evaluated";
  intervalMinutes: 5 | 15;
  protocol: "canonical-frozen-choice-probability-60-20-20-v1";
  datasetFingerprint: string;
  datasetCount: number;
  uniqueEligibleCount: number;
  rejectedCount: number;
  missingFeatureChoices: number;
  featureCoverage: {
    richFeatureEligibleCount: number;
    richFeatureCoverageRate: number;
    missingFeatureChoices: number;
  };
  evidenceAvailableThroughMs: number;
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
    count: number;
    candidate: Metrics | null;
    frozenProbability: Metrics | null;
    bins: Bin[];
    sideBias: {
      predictedUpRate: number | null;
      observedUpRate: number | null;
      difference: number | null;
    };
    pairedBrierDifference: {
      mean: number;
      standardError: number;
      lower95: number;
      upper95: number;
    } | null;
    adequateCoverage: boolean;
  };
  calibrationFit: { method: string; count: number } | null;
  baselineArtifact: CanonicalBaselineArtifact | null;
  promotion: { enabled: false; eligible: false; reason: string };
  rejectionReasons: string[];
}>;

type Eligible = CanonicalTrainingChoice & { y: number };

function logistic(value: number): number {
  const bounded = Math.max(-25, Math.min(25, value));
  return 1 / (1 + Math.exp(-bounded));
}

function logit(probability: number): number {
  const bounded = Math.max(EPSILON, Math.min(1 - EPSILON, probability));
  return Math.log(bounded / (1 - bounded));
}

function fitPlatt(logits: readonly number[], labels: readonly number[]) {
  let intercept = logit((labels.reduce((sum, value) => sum + value, 0) + 0.5) /
    (labels.length + 1));
  let slope = 0;
  for (let iteration = 0; iteration < 800; iteration++) {
    let interceptGradient = 0;
    let slopeGradient = 0;
    for (let index = 0; index < labels.length; index++) {
      const prediction = logistic(intercept + slope * logits[index]);
      const error = prediction - labels[index];
      interceptGradient += error;
      slopeGradient += error * logits[index];
    }
    intercept -= 0.05 * interceptGradient / labels.length;
    slope -= 0.05 * (slopeGradient / labels.length + 0.1 * slope);
    intercept = Math.max(-20, Math.min(20, intercept));
    slope = Math.max(-20, Math.min(20, slope));
  }
  return { slope, intercept };
}

function metrics(probabilities: readonly number[], labels: readonly number[]): Metrics {
  const bins = Array.from({ length: 10 }, (_, index) => ({
    lower: index / 10,
    upper: (index + 1) / 10,
    count: 0,
    predicted: 0,
    observed: 0,
  }));
  let brier = 0;
  let logLoss = 0;
  let correct = 0;
  probabilities.forEach((raw, index) => {
    const probability = Math.max(EPSILON, Math.min(1 - EPSILON, raw));
    const label = labels[index];
    brier += (probability - label) ** 2;
    logLoss -= label * Math.log(probability) + (1 - label) * Math.log(1 - probability);
    correct += (probability >= 0.5 ? 1 : 0) === label ? 1 : 0;
    const bin = bins[Math.min(9, Math.floor(probability * 10))];
    bin.count++;
    bin.predicted += probability;
    bin.observed += label;
  });
  return {
    count: labels.length,
    brier: brier / labels.length,
    logLoss: logLoss / labels.length,
    accuracy: correct / labels.length,
    calibration: bins.map(bin => ({
      lower: bin.lower,
      upper: bin.upper,
      count: bin.count,
      meanPredicted: bin.count ? bin.predicted / bin.count : null,
      observedUpRate: bin.count ? bin.observed / bin.count : null,
    })),
  };
}

function isValid(row: CanonicalTrainingChoice, interval: number, asOfMs: number): boolean {
  return row.intervalMinutes === interval && Boolean(row.roundId.trim()) &&
    [row.startMs, row.expiryMs, row.decisionAtMs, row.probabilityUp,
      row.settledAtMs, row.labelAvailableAtMs].every(Number.isFinite) &&
    row.expiryMs - row.startMs === interval * 60_000 &&
    row.decisionAtMs >= row.startMs && row.decisionAtMs < row.expiryMs &&
    row.startMs <= asOfMs && row.expiryMs <= asOfMs && row.decisionAtMs <= asOfMs &&
    row.probabilityUp >= 0 && row.probabilityUp <= 1 &&
    (row.outcome === "UP" || row.outcome === "DOWN") &&
    row.settledAtMs > row.expiryMs && row.labelAvailableAtMs >= row.settledAtMs &&
    row.labelAvailableAtMs <= asOfMs;
}

function insufficient(
  intervalMinutes: 5 | 15,
  fingerprint: string,
  datasetCount: number,
  rows: Eligible[],
  rejectedCount: number,
  missingFeatureChoices: number,
  reasons: string[],
  spanMs: number,
  evidenceAvailableThroughMs: number,
  split: CanonicalTrainingReport["split"],
  partitions?: { training: Eligible[]; calibration: Eligible[]; test: Eligible[] },
): CanonicalTrainingReport {
  const allReasons = [...reasons];
  if (rows.length < MINIMUMS.records)
    allReasons.push(`Need at least 90 unique canonical frozen choices; found ${rows.length}.`);
  if (spanMs < MINIMUMS.spanMs[intervalMinutes])
    allReasons.push(`Need ${intervalMinutes === 5 ? "48 hours" : "7 days"} of prospective frozen-choice history.`);
  if (partitions) {
    if (partitions.training.length < MINIMUMS.training)
      allReasons.push(`Post-embargo training partition has ${partitions.training.length}; need 40.`);
    if (partitions.calibration.length < MINIMUMS.calibration)
      allReasons.push(`Post-embargo calibration partition has ${partitions.calibration.length}; need 20.`);
    if (partitions.test.length < MINIMUMS.test)
      allReasons.push(`Untouched later test partition has ${partitions.test.length}; need 20.`);
    for (const [name, part] of Object.entries(partitions))
      if (!part.some(row => row.y === 1) || !part.some(row => row.y === 0))
        allReasons.push(`${name} partition needs both accepted outcomes.`);
  }
  return {
    status: "insufficient",
    intervalMinutes,
    protocol: "canonical-frozen-choice-probability-60-20-20-v1",
    datasetFingerprint: fingerprint,
    datasetCount,
    uniqueEligibleCount: rows.length,
    rejectedCount,
    missingFeatureChoices,
    featureCoverage: {
      richFeatureEligibleCount: Math.max(0, rows.length - missingFeatureChoices),
      richFeatureCoverageRate: rows.length ? Math.max(0, rows.length - missingFeatureChoices) / rows.length : 0,
      missingFeatureChoices,
    },
    evidenceAvailableThroughMs,
    spanMs,
    split,
    eligibility: { eligible: false, reasons: allReasons },
    test: {
      count: 0,
      candidate: null,
      frozenProbability: null,
      bins: [],
      sideBias: { predictedUpRate: null, observedUpRate: null, difference: null },
      pairedBrierDifference: null,
      adequateCoverage: false,
    },
    calibrationFit: null,
    baselineArtifact: null,
    promotion: { enabled: false, eligible: false, reason: "Promotion is disabled; offline runs are shadow-only." },
    rejectionReasons: Array.from(new Set(allReasons)),
  };
}

/**
 * Calibrates the canonical frozen choice probability alone. No reference,
 * Coinbase, payout, or rich-feature value is consulted by this route.
 */
export function trainCanonicalWaterxBaseline(
  intervalMinutes: 5 | 15,
  rawRows: readonly CanonicalTrainingChoice[],
  options: { asOfMs: number; richFeatureRoundIds?: ReadonlySet<string>;onPhase?:(stage:string)=>void },
): CanonicalTrainingReport {
  const ordered = [...rawRows].sort((a, b) =>
    a.intervalMinutes - b.intervalMinutes || a.startMs - b.startMs || a.roundId.localeCompare(b.roundId));
  const fingerprint = createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
  const intervalRows = ordered.filter(row => row.intervalMinutes === intervalMinutes);
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const row of intervalRows) {
    if (seen.has(row.roundId)) duplicate.add(row.roundId);
    seen.add(row.roundId);
  }
  const rows: Eligible[] = intervalRows
    .filter(row => !duplicate.has(row.roundId) && isValid(row, intervalMinutes, options.asOfMs))
    .map(row => ({ ...row, y: row.outcome === "UP" ? 1 : 0 }));
  const missingFeatureChoices = rows.filter(row =>
    !options.richFeatureRoundIds?.has(row.roundId)).length;
  const spanMs = rows.length > 1 ? rows.at(-1)!.startMs - rows[0].startMs : 0;
  const evidenceAvailableThroughMs = rows.length
    ? Math.max(...rows.flatMap(row => [row.decisionAtMs, row.settledAtMs, row.labelAvailableAtMs]))
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
  const split: CanonicalTrainingReport["split"] = {
    method: "Chronological round-start 60/20/20; calibrate frozenChoice.probabilityUp on the later calibration block; untouched final 20% test. Training and calibration labels must be available one full interval before the next block.",
    trainingCount: training.length,
    calibrationCount: calibration.length,
    testCount: test.length,
    embargoExcludedCount: rawTraining.length - training.length + rawCalibration.length - calibration.length,
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
  if (reasons.length || rows.length < MINIMUMS.records ||
      spanMs < MINIMUMS.spanMs[intervalMinutes] ||
      training.length < MINIMUMS.training || calibration.length < MINIMUMS.calibration ||
      test.length < MINIMUMS.test ||
      !training.some(row => row.y === 1) || !training.some(row => row.y === 0) ||
      !calibration.some(row => row.y === 1) || !calibration.some(row => row.y === 0) ||
      !test.some(row => row.y === 1) || !test.some(row => row.y === 0))
    return insufficient(intervalMinutes, fingerprint, intervalRows.length, rows,
      intervalRows.length - rows.length, missingFeatureChoices, reasons, spanMs,
      evidenceAvailableThroughMs, split, { training, calibration, test });

  const calibrationFit = fitPlatt(
    calibration.map(row => logit(row.probabilityUp)),
    calibration.map(row => row.y),
  );
  options.onPhase?.("canonical-calibrated");
  const calibrated = test.map(row => logistic(
    calibrationFit.intercept + calibrationFit.slope * logit(row.probabilityUp)));
  const labels = test.map(row => row.y);
  const candidate = metrics(calibrated, labels);
  const frozenProbability = metrics(test.map(row => row.probabilityUp), labels);
  options.onPhase?.("canonical-evaluated");
  const differences = test.map((row, index) =>
    (calibrated[index] - row.y) ** 2 - (row.probabilityUp - row.y) ** 2);
  const pairedMean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const standardError = differences.length > 1 ? Math.sqrt(differences.reduce(
    (sum, value) => sum + (value - pairedMean) ** 2, 0) /
    (differences.length - 1) / differences.length) : 0;
  const observedUpRate = labels.reduce((sum, value) => sum + value, 0) / labels.length;
  const predictedUpRate = calibrated.filter(probability => probability > 0.5).length / calibrated.length;
  const pairedBrierDifference = {
    mean: pairedMean,
    standardError,
    lower95: pairedMean - 1.96 * standardError,
    upper95: pairedMean + 1.96 * standardError,
  };
  const rejectionReasons: string[] = [];
  if (pairedMean >= 0) rejectionReasons.push("Held-out calibrated baseline Brier loss did not improve over the frozen choice probability.");
  if (pairedMean + 1.96 * standardError >= 0)
    rejectionReasons.push("Paired held-out Brier uncertainty does not demonstrate improvement.");
  return {
    status: "candidate-evaluated",
    intervalMinutes,
    protocol: "canonical-frozen-choice-probability-60-20-20-v1",
    datasetFingerprint: fingerprint,
    datasetCount: intervalRows.length,
    uniqueEligibleCount: rows.length,
    rejectedCount: intervalRows.length - rows.length,
    missingFeatureChoices,
    featureCoverage: {
      richFeatureEligibleCount: rows.length - missingFeatureChoices,
      richFeatureCoverageRate: (rows.length - missingFeatureChoices) / rows.length,
      missingFeatureChoices,
    },
    evidenceAvailableThroughMs,
    spanMs,
    split,
    eligibility: { eligible: true, reasons: [] },
    test: {
      count: test.length,
      candidate,
      frozenProbability,
      bins: candidate.calibration,
      sideBias: {
        predictedUpRate,
        observedUpRate,
        difference: predictedUpRate - observedUpRate,
      },
      pairedBrierDifference,
      adequateCoverage: candidate.count === test.length && test.length >= MINIMUMS.test,
    },
    calibrationFit: {
      method: "Platt logistic calibration using only frozenChoice.probabilityUp on later chronological calibration partition",
      count: calibration.length,
    },
    baselineArtifact: {
      status: "shadow-only",
      promoted: false,
      version: `waterx-canonical-probability-baseline-v1:${intervalMinutes}:${fingerprint.slice(0, 16)}`,
      datasetFingerprint: fingerprint,
      probabilityField: "frozenChoice.probabilityUp",
      method: "Platt logistic calibration of frozen choice probability",
      calibration: calibrationFit,
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