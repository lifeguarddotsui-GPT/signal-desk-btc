import type { WaterxCandidateInterval } from "./candidate-training";

const DAY_MS = 24 * 60 * 60_000;
const METRIC_MINIMUM_SAMPLE_SIZE = 20;
const DEFAULT_MAX_ROWS = 1_000;
const CALIBRATION_BINS = 10;
const EPSILON = 1e-12;

type Interval = WaterxCandidateInterval;

export type WaterxDailyAuditQueryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, any>> }>;
};

type WaterxDailyAuditRound = Readonly<{
  intervalMinutes: number;
  roundId: string;
  startMs: number;
  expiryMs: number;
  anchorPrice: number | null;
  anchorConfirmed: boolean;
  probabilityUp: number | null;
  observedAtMs: number;
  sourceProof: unknown;
  labelStatus: string;
  withheldReason: string | null;
  settlementAnchorPrice: number | null;
  settlePrice: number | null;
  outcome: string | null;
  settledAtMs: number | null;
  labelAvailableMs: number | null;
  settlementEvidence: unknown;
  settlementDisputed: boolean;
  settlementDisputedReason: string | null;
  settlementQuarantine: unknown;
}>;

type WaterxDailyAuditSnapshot = Readonly<{
  intervalMinutes: number;
  roundId: string;
  startMs: number;
  expiryMs: number;
  predictionAtMs: number;
  featureSnapshotAtMs: number;
  capturedAtMs: number;
  confirmedAnchorPrice: number;
  marketProbabilityUp: number;
  featureSchema: string;
  recordData: unknown;
  sourceEvidence: unknown;
}>;

export type WaterxDailyAuditEvidence = Readonly<{
  round: WaterxDailyAuditRound | null;
  snapshot: WaterxDailyAuditSnapshot | null;
}>;

type MetricRow = Readonly<{
  roundId: string;
  startMs: number;
  expiryMs: number;
  outcome: "Up" | "Down";
  candidateProbability: number | null;
  marketProbability: number;
  remainingMs: number;
  remainingFraction: number;
}>;

type CalibrationBin = {
  lower: number;
  upper: number;
  count: number;
  predictedSum: number;
  upCount: number;
};

function objectValue(value: unknown): Record<string, any> | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any> : null;
}

function isFiniteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function sameNumber(left: unknown, right: unknown): boolean {
  return typeof left === "number" && Number.isFinite(left) &&
    typeof right === "number" && Number.isFinite(right) && left === right;
}

function utcDayStart(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0)
    throw new Error("WaterX daily audit requires a valid current timestamp.");
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS;
}

function intervalSlots(interval: Interval): number {
  return DAY_MS / (interval * 60_000);
}

function expectedStarts(dayStartMs: number, interval: Interval): number[] {
  const cadenceMs = interval * 60_000;
  return Array.from({ length: intervalSlots(interval) }, (_, index) =>
    dayStartMs + index * cadenceMs);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dbTimestampMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function mapEvidenceRow(row: Record<string, any>): WaterxDailyAuditEvidence {
  const round = row.l_round_id === null || row.l_round_id === undefined ? null : {
    intervalMinutes: Number(row.l_interval_minutes),
    roundId: String(row.l_round_id),
    startMs: Number(row.l_start_ms),
    expiryMs: Number(row.l_expiry_ms),
    anchorPrice: numberOrNull(row.l_anchor_price),
    anchorConfirmed: row.l_anchor_confirmed === true,
    probabilityUp: numberOrNull(row.l_probability_up),
    observedAtMs: Number(row.l_observed_at_ms),
    sourceProof: row.l_source_proof,
    labelStatus: String(row.l_label_status ?? ""),
    withheldReason: row.l_withheld_reason === null ? null : String(row.l_withheld_reason),
    settlementAnchorPrice: numberOrNull(row.l_settlement_anchor_price),
    settlePrice: numberOrNull(row.l_settle_price),
    outcome: row.l_outcome === null ? null : String(row.l_outcome),
    settledAtMs: numberOrNull(row.l_settled_at),
    labelAvailableMs: numberOrNull(row.l_label_available_ms),
    settlementEvidence: row.l_settlement_evidence,
    settlementDisputed: row.l_settlement_disputed === true,
    settlementDisputedReason: row.l_settlement_disputed_reason === null
      ? null : String(row.l_settlement_disputed_reason),
    settlementQuarantine: row.l_settlement_quarantine,
  } satisfies WaterxDailyAuditRound;

  const snapshot = row.s_round_id === null || row.s_round_id === undefined ? null : {
    intervalMinutes: Number(row.s_interval_minutes),
    roundId: String(row.s_round_id),
    startMs: Number(row.s_start_ms),
    expiryMs: Number(row.s_expiry_ms),
    predictionAtMs: Number(row.s_prediction_at_ms),
    featureSnapshotAtMs: Number(row.s_feature_snapshot_at_ms),
    capturedAtMs: Number(row.s_captured_at_ms),
    confirmedAnchorPrice: Number(row.s_confirmed_anchor_price),
    marketProbabilityUp: Number(row.s_market_probability_up),
    featureSchema: String(row.s_feature_schema ?? ""),
    recordData: row.s_record_data,
    sourceEvidence: row.s_source_evidence,
  } satisfies WaterxDailyAuditSnapshot;
  return { round, snapshot };
}

function roundIdentityError(round: WaterxDailyAuditRound, interval: Interval): string | null {
  const cadenceMs = interval * 60_000;
  if (round.intervalMinutes !== interval || !round.roundId.trim() ||
      !Number.isSafeInteger(round.startMs) || !Number.isSafeInteger(round.expiryMs) ||
      round.startMs <= 0 || round.expiryMs - round.startMs !== cadenceMs)
    return "bad-round-identity";
  return null;
}

function hasWaterxRoundProof(proof: unknown): boolean {
  const parsed = objectValue(proof);
  return parsed?.provider === "WaterX" &&
    parsed?.evidenceKind === "WaterX round observation";
}

function validMarketObservation(
  round: WaterxDailyAuditRound,
  interval: Interval,
): boolean {
  return hasWaterxRoundProof(round.sourceProof) &&
    round.anchorConfirmed === true && isFinitePositive(round.anchorPrice) &&
    isFiniteProbability(round.probabilityUp) &&
    Number.isSafeInteger(round.observedAtMs) &&
    round.observedAtMs >= round.startMs &&
    round.observedAtMs < round.expiryMs &&
    round.expiryMs - round.startMs === interval * 60_000;
}

function validSelectedTicks(
  sourceEvidence: Record<string, any>,
  predictionAtMs: number,
): boolean {
  if (!Array.isArray(sourceEvidence.selectedTicks) || sourceEvidence.selectedTicks.length < 2)
    return false;
  return sourceEvidence.selectedTicks.every((tick: Record<string, any>) =>
    tick && tick.sourceAtMs <= predictionAtMs &&
    tick.receivedAtMs <= predictionAtMs &&
    Number.isSafeInteger(tick.sourceAtMs) &&
    Number.isSafeInteger(tick.receivedAtMs) &&
    isFinitePositive(tick.price) &&
    typeof tick.archiveId === "string" && tick.archiveId.length > 0);
}

function validFrozenSnapshot(
  round: WaterxDailyAuditRound,
  snapshot: WaterxDailyAuditSnapshot,
  interval: Interval,
): boolean {
  const record = objectValue(snapshot.recordData);
  const sourceEvidence = objectValue(snapshot.sourceEvidence);
  const expectedRemainingFraction = (snapshot.expiryMs - snapshot.predictionAtMs) /
    (snapshot.expiryMs - snapshot.startMs);
  if (!record || !sourceEvidence ||
      snapshot.intervalMinutes !== interval ||
      snapshot.roundId !== round.roundId ||
      snapshot.startMs !== round.startMs ||
      snapshot.expiryMs !== round.expiryMs ||
      snapshot.featureSchema !== "waterx-round-snapshot-v1" ||
      record.source !== "WaterX" ||
      record.intervalMinutes !== interval ||
      record.roundId !== round.roundId ||
      record.featureSchema !== "waterx-round-snapshot-v1" ||
      record.frozen !== true ||
      record.startMs !== round.startMs ||
      record.expiryMs !== round.expiryMs ||
      record.predictionAtMs !== snapshot.predictionAtMs ||
      record.featureSnapshotAtMs !== snapshot.featureSnapshotAtMs ||
      record.confirmedAnchorPrice !== snapshot.confirmedAnchorPrice ||
      record.marketProbabilityUp !== snapshot.marketProbabilityUp ||
      !Number.isSafeInteger(snapshot.predictionAtMs) ||
      snapshot.predictionAtMs < round.startMs ||
      snapshot.predictionAtMs >= round.expiryMs ||
      !Number.isSafeInteger(snapshot.featureSnapshotAtMs) ||
      snapshot.featureSnapshotAtMs > snapshot.predictionAtMs ||
      !Number.isSafeInteger(snapshot.capturedAtMs) ||
      snapshot.capturedAtMs < snapshot.predictionAtMs ||
      snapshot.capturedAtMs >= round.expiryMs ||
      !isFinitePositive(snapshot.confirmedAnchorPrice) ||
      snapshot.confirmedAnchorPrice !== round.anchorPrice ||
      !isFiniteProbability(snapshot.marketProbabilityUp) ||
      snapshot.marketProbabilityUp !== round.probabilityUp ||
      !validMarketObservation(round, interval) ||
      round.observedAtMs > snapshot.predictionAtMs)
    return false;

  const features = objectValue(record.features);
  const snapshotOdds = objectValue(sourceEvidence.marketProbabilitySnapshot);
  if (!features || !snapshotOdds ||
      sourceEvidence.source !== "Coinbase" ||
      sourceEvidence.archiveSource !== "coinbase_ticks" ||
      sourceEvidence.marketProbabilityObservedAtMs !== round.observedAtMs ||
      sourceEvidence.firstFrozenMarketProbabilityUp !== round.probabilityUp ||
      sourceEvidence.firstFrozenMarketProbabilityAtMs !== round.observedAtMs ||
      snapshotOdds.storage !== "waterx_learning_rounds" ||
      snapshotOdds.frozen !== true ||
      snapshotOdds.intervalMinutes !== interval ||
      snapshotOdds.roundId !== round.roundId ||
      snapshotOdds.probabilityUp !== round.probabilityUp ||
      snapshotOdds.appObservedAtMs !== round.observedAtMs ||
      !sameNumber(features.timeRemainingFraction, expectedRemainingFraction) ||
      !validSelectedTicks(sourceEvidence, snapshot.predictionAtMs))
    return false;
  return true;
}

function validCandidatePrediction(
  record: Record<string, any>,
  predictionAtMs: number,
): boolean {
  const prediction = objectValue(record.candidatePrediction);
  return !!prediction &&
    prediction.kind === "shadow-candidate" &&
    prediction.artifactVersion === "waterx-logistic-candidate-v2" &&
    prediction.calibrationVersion === "waterx-platt-logistic-v1" &&
    typeof prediction.modelVersion === "string" &&
    prediction.modelVersion.startsWith("waterx-logistic-candidate-v2:") &&
    typeof prediction.datasetFingerprint === "string" &&
    /^[a-f\d]{64}$/i.test(prediction.datasetFingerprint) &&
    isFiniteProbability(prediction.probabilityUp) &&
    prediction.issuedAtMs === predictionAtMs &&
    Number.isSafeInteger(prediction.trainingAttemptAtMs) &&
    prediction.trainingAttemptAtMs < prediction.issuedAtMs;
}

function validAcceptedLabel(round: WaterxDailyAuditRound, asOfMs: number): boolean {
  if (round.labelStatus !== "verified" || round.settlementDisputed ||
      round.outcome !== "Up" && round.outcome !== "Down" ||
      round.settledAtMs === null || round.settledAtMs <= round.expiryMs ||
      round.labelAvailableMs === null ||
      round.labelAvailableMs < round.settledAtMs ||
      round.labelAvailableMs > asOfMs ||
      round.settlementAnchorPrice !== round.anchorPrice ||
      !round.anchorConfirmed || !isFinitePositive(round.settlePrice) ||
      !isFinitePositive(round.settlementAnchorPrice))
    return false;
  const expectedOutcome = round.settlePrice >= round.settlementAnchorPrice ? "Up" : "Down";
  if (round.outcome !== expectedOutcome) return false;
  const evidence = objectValue(round.settlementEvidence);
  return evidence?.source === "WaterX" &&
    evidence.accepted === true &&
    evidence.resolutionStatus === "resolved" &&
    evidence.anchorConfirmed === true &&
    evidence.anchorPrice === round.settlementAnchorPrice &&
    evidence.settlePrice === round.settlePrice &&
    evidence.outcome === round.outcome &&
    evidence.settledAt === round.settledAtMs &&
    dbTimestampMs(evidence.observedAt) === round.labelAvailableMs;
}

function hasQuarantinedEvidence(value: unknown): boolean {
  const parsed = objectValue(value);
  if (Array.isArray(parsed)) return parsed.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") {
    try {
      const decoded = JSON.parse(value);
      return Array.isArray(decoded) && decoded.length > 0;
    } catch {
      return true;
    }
  }
  return value !== null && value !== undefined;
}

function metrics(rows: readonly MetricRow[], probability: (row: MetricRow) => number) {
  if (rows.length < METRIC_MINIMUM_SAMPLE_SIZE) return null;
  let brier = 0;
  let logLoss = 0;
  const bins: CalibrationBin[] = Array.from({ length: CALIBRATION_BINS }, (_, index) => ({
    lower: index / CALIBRATION_BINS,
    upper: (index + 1) / CALIBRATION_BINS,
    count: 0,
    predictedSum: 0,
    upCount: 0,
  }));
  for (const row of rows) {
    const p = probability(row);
    const y = row.outcome === "Up" ? 1 : 0;
    brier += (p - y) ** 2;
    const bounded = Math.max(EPSILON, Math.min(1 - EPSILON, p));
    logLoss -= y * Math.log(bounded) + (1 - y) * Math.log(1 - bounded);
    const bin = bins[Math.min(CALIBRATION_BINS - 1, Math.floor(p * CALIBRATION_BINS))];
    bin.count++;
    bin.predictedSum += p;
    bin.upCount += y;
  }
  return {
    sampleSize: rows.length,
    brier: brier / rows.length,
    logLoss: logLoss / rows.length,
    calibrationByProbabilityBand: bins.map(bin => ({
      lower: bin.lower,
      upper: bin.upper,
      count: bin.count,
      meanPredicted: bin.count ? bin.predictedSum / bin.count : null,
      observedUpRate: bin.count ? bin.upCount / bin.count : null,
    })),
  };
}

function timeRemainingBands(rows: readonly MetricRow[]) {
  const bands = [
    { label: "0-25%", lower: 0, upper: 0.25 },
    { label: "25-50%", lower: 0.25, upper: 0.5 },
    { label: "50-75%", lower: 0.5, upper: 0.75 },
    { label: "75-100%", lower: 0.75, upper: 1 },
  ];
  return bands.map(band => {
    const selected = rows.filter(row => row.remainingFraction >= band.lower &&
      (row.remainingFraction < band.upper ||
        band.upper === 1 && row.remainingFraction <= band.upper));
    return {
      band: band.label,
      sampleSize: selected.length,
      candidateMetrics: metrics(selected.filter(row => row.candidateProbability !== null),
        row => row.candidateProbability!),
      waterxBaselineMetrics: metrics(selected, row => row.marketProbability),
    };
  });
}

function scoreContributions(rows: readonly MetricRow[]) {
  const contribution = (row: MetricRow) => {
    const y = row.outcome === "Up" ? 1 : 0;
    const candidate = row.candidateProbability!;
    const candidateBrier = (candidate - y) ** 2;
    const marketBrier = (row.marketProbability - y) ** 2;
    const boundedCandidate = Math.max(EPSILON, Math.min(1 - EPSILON, candidate));
    const boundedMarket = Math.max(EPSILON, Math.min(1 - EPSILON, row.marketProbability));
    const candidateLogLoss = -(y * Math.log(boundedCandidate) +
      (1 - y) * Math.log(1 - boundedCandidate));
    const marketLogLoss = -(y * Math.log(boundedMarket) +
      (1 - y) * Math.log(1 - boundedMarket));
    return {
      roundId: row.roundId,
      startMs: row.startMs,
      label: row.outcome,
      candidateProbabilityUp: candidate,
      waterxProbabilityUp: row.marketProbability,
      timeRemainingMs: row.remainingMs,
      candidateBrierContribution: candidateBrier,
      waterxBrierContribution: marketBrier,
      candidateMinusWaterxBrier: candidateBrier - marketBrier,
      candidateLogLossContribution: candidateLogLoss,
      waterxLogLossContribution: marketLogLoss,
      candidateMinusWaterxLogLoss: candidateLogLoss - marketLogLoss,
    };
  };
  const contributions = rows.map(contribution);
  const worst = (key: "candidateBrierContribution" | "candidateLogLossContribution") =>
    [...contributions].sort((a, b) => b[key] - a[key] || a.startMs - b.startMs)
      .slice(0, 10);
  const largestAbsoluteDifference = [...contributions].sort((a, b) =>
    Math.abs(b.candidateMinusWaterxBrier) - Math.abs(a.candidateMinusWaterxBrier) ||
    a.startMs - b.startMs).slice(0, 10);
  return {
    sampleSize: rows.length,
    topCandidateBrierLosses: worst("candidateBrierContribution"),
    topCandidateLogLosses: worst("candidateLogLossContribution"),
    largestAbsolutePairedBrierDifferences: largestAbsoluteDifference,
  };
}

function intervalAudit(
  dayStartMs: number,
  interval: Interval,
  inputRows: readonly WaterxDailyAuditEvidence[],
  asOfMs: number,
) {
  const cadenceMs = interval * 60_000;
  const slots = expectedStarts(dayStartMs, interval);
  const byStart = new Map<number, WaterxDailyAuditEvidence>();
  const seenRoundIds = new Set<string>();
  const excludedEvidenceCounts: Record<string, number> = {};
  const exclude = (reason: string) => {
    excludedEvidenceCounts[reason] = (excludedEvidenceCounts[reason] ?? 0) + 1;
  };
  const rows = inputRows.filter(item =>
    (item.round?.intervalMinutes ?? item.snapshot?.intervalMinutes) === interval);

  for (const item of rows) {
    const round = item.round;
    const snapshot = item.snapshot;
    if (!round) throw new Error(`WaterX ${interval}m candidate snapshot has no persisted learning-round identity.`);
    if (roundIdentityError(round, interval))
      throw new Error(`WaterX ${interval}m evidence has a bad round identity: ${round.roundId || "(empty)"}.`);
    if (snapshot && (snapshot.intervalMinutes !== interval ||
        snapshot.roundId !== round.roundId ||
        snapshot.startMs !== round.startMs || snapshot.expiryMs !== round.expiryMs))
      throw new Error(`WaterX ${interval}m snapshot identity conflicts with round ${round.roundId}.`);
    if (seenRoundIds.has(round.roundId))
      throw new Error(`Duplicate WaterX ${interval}m round identity: ${round.roundId}.`);
    seenRoundIds.add(round.roundId);
    if (round.startMs < dayStartMs || round.startMs >= dayStartMs + DAY_MS) continue;
    const slotIndex = (round.startMs - dayStartMs) / cadenceMs;
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= slots.length) {
      exclude("round-start-outside-expected-cadence");
      continue;
    }
    if (byStart.has(round.startMs))
      throw new Error(`Duplicate WaterX ${interval}m round start identity at ${new Date(round.startMs).toISOString()}.`);
    byStart.set(round.startMs, item);
  }

  const missingStarts: string[] = [];
  let roundIdentityCount = 0;
  let validSnapshotCount = 0;
  let candidatePredictionCount = 0;
  let marketObservationCount = 0;
  let withheldRoundCount = 0;
  let missingLabelRoundCount = 0;
  let disputedRoundCount = 0;
  const candidateRows: MetricRow[] = [];
  const baselineRows: MetricRow[] = [];
  const matchedRows: MetricRow[] = [];
  const validPredictionRemainders: number[] = [];

  for (const startMs of slots) {
    const item = byStart.get(startMs);
    if (!item) {
      missingStarts.push(new Date(startMs).toISOString());
      continue;
    }
    const round = item.round!;
    roundIdentityCount++;
    if (round.startMs !== startMs || round.expiryMs !== startMs + cadenceMs)
      throw new Error(`WaterX ${interval}m round ${round.roundId} does not match its expected UTC cadence identity.`);
    if (round.settlementDisputed) disputedRoundCount++;
    if (round.labelStatus === "withheld") withheldRoundCount++;
    const labelAvailable = validAcceptedLabel(round, asOfMs) &&
      !hasQuarantinedEvidence(round.settlementQuarantine);
    if (!labelAvailable && !round.settlementDisputed && round.labelStatus !== "withheld")
      missingLabelRoundCount++;

    const validMarket = validMarketObservation(round, interval);
    if (!validMarket) exclude("missing-or-invalid-preclose-waterx-observation");
    const snapshot = item.snapshot;
    const snapshotRecord = snapshot ? objectValue(snapshot.recordData) : null;
    const validSnapshot = !!snapshot && validMarket &&
      validFrozenSnapshot(round, snapshot, interval);
    if (snapshot && !validSnapshot) exclude("postclose-backfilled-or-invalid-frozen-snapshot");
    if (validSnapshot) {
      validSnapshotCount++;
      marketObservationCount++;
    }

    const candidateValid = validSnapshot && !!snapshotRecord &&
      validCandidatePrediction(snapshotRecord, snapshot!.predictionAtMs);
    if (snapshotRecord?.candidatePrediction !== null &&
        snapshotRecord?.candidatePrediction !== undefined && !candidateValid)
      exclude("postclose-backfilled-or-invalid-candidate-prediction");
    if (candidateValid) {
      candidatePredictionCount++;
      validPredictionRemainders.push(snapshot!.expiryMs - snapshot!.predictionAtMs);
    }

    if (validSnapshot && labelAvailable) {
      const row: MetricRow = {
        roundId: round.roundId,
        startMs: round.startMs,
        expiryMs: round.expiryMs,
        outcome: round.outcome as "Up" | "Down",
        candidateProbability: candidateValid
          ? objectValue(snapshotRecord!.candidatePrediction)!.probabilityUp : null,
        marketProbability: snapshot!.marketProbabilityUp,
        remainingMs: snapshot!.expiryMs - snapshot!.predictionAtMs,
        remainingFraction: (snapshot!.expiryMs - snapshot!.predictionAtMs) / cadenceMs,
      };
      baselineRows.push(row);
      if (candidateValid) {
        candidateRows.push(row);
        matchedRows.push(row);
      }
    }
  }

  const candidateMetrics = metrics(candidateRows, row => row.candidateProbability!);
  const baselineMetrics = metrics(baselineRows, row => row.marketProbability);
  const matchedCandidateMetrics = metrics(matchedRows, row => row.candidateProbability!);
  const matchedBaselineMetrics = metrics(matchedRows, row => row.marketProbability);
  const brierDifference = matchedCandidateMetrics && matchedBaselineMetrics
    ? matchedCandidateMetrics.brier - matchedBaselineMetrics.brier : null;
  const logLossDifference = matchedCandidateMetrics && matchedBaselineMetrics
    ? matchedCandidateMetrics.logLoss - matchedBaselineMetrics.logLoss : null;
  const allValidRoundRows = Array.from(byStart.values()).filter(item => {
    const round = item.round!;
    return round.startMs >= dayStartMs && round.startMs < dayStartMs + DAY_MS;
  });
  const labelledRows = allValidRoundRows.map(item => item.round!)
    .filter(round => round.labelStatus === "verified" &&
      validAcceptedLabel(round, asOfMs) &&
      !hasQuarantinedEvidence(round.settlementQuarantine));
  const withheldReasons: Record<string, number> = {};
  for (const round of allValidRoundRows.map(item => item.round!)) {
    if (round.labelStatus !== "withheld") continue;
    const reason = round.settlementDisputedReason ?? round.withheldReason ?? "unspecified";
    withheldReasons[reason] = (withheldReasons[reason] ?? 0) + 1;
  }
  const expectedRoundCount = slots.length;
  const enoughCandidateMetrics = candidateRows.length >= METRIC_MINIMUM_SAMPLE_SIZE;
  const enoughBaselineMetrics = baselineRows.length >= METRIC_MINIMUM_SAMPLE_SIZE;
  const enoughMatchedMetrics = matchedRows.length >= METRIC_MINIMUM_SAMPLE_SIZE;

  return {
    intervalMinutes: interval,
    expectedRoundCount,
    expectedEligibleRounds: expectedRoundCount,
    coverage: {
      persistedRoundIdentities: roundIdentityCount,
      persistedRoundIdentityPercent: Number((roundIdentityCount / expectedRoundCount * 100).toFixed(2)),
      missingRoundCount: missingStarts.length,
      missingStartsUtc: missingStarts,
      frozenPrecloseSnapshotCount: validSnapshotCount,
      frozenPrecloseSnapshotCoveragePercent: Number((validSnapshotCount / expectedRoundCount * 100).toFixed(2)),
      validCandidatePredictionCount: candidatePredictionCount,
      candidatePredictionCoveragePercent: Number((candidatePredictionCount / expectedRoundCount * 100).toFixed(2)),
      withheldRoundCount,
      withheldReasonCounts: withheldReasons,
      missingLabelRoundCount,
      disputedRoundCount,
      eligibleWaterxBaselineObservations: marketObservationCount,
      currentlyVerifiedLabelsOnExpectedRounds: labelledRows.length,
    },
    predictionEligibility: {
      minimumMetricSampleSize: METRIC_MINIMUM_SAMPLE_SIZE,
      validCandidatePredictionCount: candidatePredictionCount,
      candidateScoredSampleSize: candidateRows.length,
      waterxBaselineScoredSampleSize: baselineRows.length,
      matchedScoredSampleSize: matchedRows.length,
      candidateMetricsStatus: enoughCandidateMetrics ? "scored" : "insufficient",
      waterxBaselineMetricsStatus: enoughBaselineMetrics ? "scored" : "insufficient",
      matchedMetricsStatus: enoughMatchedMetrics ? "scored" : "insufficient",
      insufficientReason: enoughMatchedMetrics ? null :
        `Metrics are null unless at least ${METRIC_MINIMUM_SAMPLE_SIZE} eligible labeled predictions are available in the matched candidate/WaterX cohort.`,
    },
    scores: {
      candidate: candidateMetrics,
      waterxBaseline: baselineMetrics,
      matchedSameObservation: {
        sampleSize: matchedRows.length,
        candidate: matchedCandidateMetrics,
        waterxBaseline: matchedBaselineMetrics,
        candidateMinusWaterxBrier: brierDifference,
        candidateMinusWaterxLogLoss: logLossDifference,
      },
    },
    timeRemaining: {
      validCandidatePredictionCount: validPredictionRemainders.length,
      meanAtPredictionMs: validPredictionRemainders.length
        ? validPredictionRemainders.reduce((sum, value) => sum + value, 0) /
          validPredictionRemainders.length : null,
      minimumAtPredictionMs: validPredictionRemainders.length
        ? Math.min(...validPredictionRemainders) : null,
      maximumAtPredictionMs: validPredictionRemainders.length
        ? Math.max(...validPredictionRemainders) : null,
      scoredSampleSize: matchedRows.length,
      scoreBands: timeRemainingBands(matchedRows),
    },
    largestScoreContributions: scoreContributions(matchedRows),
    excludedEvidenceCounts,
    labelTiming: {
      firstAvailabilityField: "waterx_learning_rounds.settlement_observed_at",
      firstAvailabilityIsAppObservedUtc: true,
      scoredLabelCount: baselineRows.length,
      scoredRoundIds: baselineRows.map(row => row.roundId),
      verifiedLabelFirstAvailabilityByRound: labelledRows.map(round => ({
        roundId: round.roundId,
        availableAtUtc: new Date(round.labelAvailableMs!).toISOString(),
        settledAtUtc: new Date(round.settledAtMs!).toISOString(),
      })),
      labelAvailabilityUtcByRound: baselineRows.map(row => {
        const round = byStart.get(row.startMs)!.round!;
        return {
          roundId: round.roundId,
          availableAtUtc: new Date(round.labelAvailableMs!).toISOString(),
          settledAtUtc: new Date(round.settledAtMs!).toISOString(),
        };
      }),
    },
  };
}

/**
 * Pure prior-UTC-day audit. Rows are already joined by the composite WaterX
 * (interval, round_id) identity; invalid or duplicate identities fail closed.
 */
export function buildWaterxDailyAudit(
  dayStartMs: number,
  evidence: readonly WaterxDailyAuditEvidence[],
  generatedAtMs = Date.now(),
) {
  if (!Number.isSafeInteger(dayStartMs) || dayStartMs <= 0 ||
      dayStartMs % DAY_MS !== 0)
    throw new Error("WaterX audit day must start at UTC midnight.");
  if (!Number.isSafeInteger(generatedAtMs) || generatedAtMs < dayStartMs + DAY_MS)
    throw new Error("WaterX daily audit requires a fully completed UTC day.");
  for (const item of evidence) {
    if (item.round && item.round.intervalMinutes !== 5 && item.round.intervalMinutes !== 15)
      throw new Error(`Invalid WaterX interval for round ${item.round.roundId}.`);
    if (item.snapshot && item.snapshot.intervalMinutes !== 5 &&
        item.snapshot.intervalMinutes !== 15)
      throw new Error(`Invalid WaterX interval for candidate snapshot ${item.snapshot.roundId}.`);
    if (item.round && item.snapshot &&
        (item.round.intervalMinutes !== item.snapshot.intervalMinutes ||
         item.round.roundId !== item.snapshot.roundId))
      throw new Error("WaterX snapshot and learning-round composite identities conflict.");
  }
  const dayEndMs = dayStartMs + DAY_MS;
  const intervals = ([5, 15] as const).map(interval => intervalAudit(
    dayStartMs, interval, evidence, generatedAtMs));
  return {
    protocol: "waterx-read-only-prior-utc-day-audit-v1",
    status: "development-read-only",
    day: {
      startUtc: new Date(dayStartMs).toISOString(),
      endUtcExclusive: new Date(dayEndMs).toISOString(),
      startMs: dayStartMs,
      endMsExclusive: dayEndMs,
    },
    generatedAtUtc: new Date(generatedAtMs).toISOString(),
    metricPolicy: {
      minimumSampleSize: METRIC_MINIMUM_SAMPLE_SIZE,
      zeroOrInsufficientEligiblePredictions: "Brier, log-loss, calibration, and paired deltas are null; coverage and sample counts remain explicit.",
      probabilityCalibrationBands: CALIBRATION_BINS,
      logLossProbabilityClip: EPSILON,
    },
    safeguards: {
      readOnly: true,
      usesOnlyPersistedWaterxRoundAndFrozenCandidateSnapshotEvidence: true,
      requiresExactIntervalAndRoundIdentityJoin: true,
      requiresAppObservedMarketOddsAndFrozenSnapshotToBePreclose: true,
      requiresCandidateTrainingAttemptBeforePrediction: true,
      excludesPostcloseOrBackfilledSnapshotsAndMeasurements: true,
      excludesDisputedQuarantinedOrUnverifiedLabels: true,
      productionSchedulingPublishingAndPromotion: "not performed",
      laterBatchingCost: "Unknown until measured trial evidence exists; no cost or production-run claim is made.",
    },
    intervals,
  };
}

/**
 * Loads a bounded, read-only set of existing round/snapshot/label evidence.
 * The caller should execute this through a PostgreSQL READ ONLY transaction.
 */
export async function auditWaterxPriorUtcDay(
  db: WaterxDailyAuditQueryable,
  nowMs = Date.now(),
  maximumRows = DEFAULT_MAX_ROWS,
) {
  if (!Number.isInteger(maximumRows) || maximumRows < 1 || maximumRows > DEFAULT_MAX_ROWS)
    throw new Error(`WaterX audit row bound must be between 1 and ${DEFAULT_MAX_ROWS}.`);
  const dayStartMs = utcDayStart(nowMs);
  const dayEndMs = dayStartMs + DAY_MS;
  const { rows } = await db.query(
    `SELECT
       l.interval_minutes AS l_interval_minutes,
       l.round_id AS l_round_id,
       l.start_ms AS l_start_ms,
       l.expiry_ms AS l_expiry_ms,
       l.anchor_price AS l_anchor_price,
       l.anchor_confirmed AS l_anchor_confirmed,
       l.probability_up AS l_probability_up,
       floor(extract(epoch FROM l.observed_at) * 1000)::bigint AS l_observed_at_ms,
       l.source_proof AS l_source_proof,
       l.label_status AS l_label_status,
       l.withheld_reason AS l_withheld_reason,
       l.settlement_anchor_price AS l_settlement_anchor_price,
       l.settle_price AS l_settle_price,
       l.outcome AS l_outcome,
       l.settled_at AS l_settled_at,
       floor(extract(epoch FROM l.settlement_observed_at) * 1000)::bigint
         AS l_label_available_ms,
       l.settlement_evidence AS l_settlement_evidence,
       l.settlement_disputed AS l_settlement_disputed,
       l.settlement_disputed_reason AS l_settlement_disputed_reason,
       l.settlement_quarantine AS l_settlement_quarantine,
       s.interval_minutes AS s_interval_minutes,
       s.round_id AS s_round_id,
       s.start_ms AS s_start_ms,
       s.expiry_ms AS s_expiry_ms,
       s.prediction_at_ms AS s_prediction_at_ms,
       s.feature_snapshot_at_ms AS s_feature_snapshot_at_ms,
       floor(extract(epoch FROM s.captured_at) * 1000)::bigint AS s_captured_at_ms,
       s.confirmed_anchor_price AS s_confirmed_anchor_price,
       s.market_probability_up AS s_market_probability_up,
       s.feature_schema AS s_feature_schema,
       s.record_data AS s_record_data,
       s.source_evidence AS s_source_evidence
     FROM waterx_learning_rounds l
     FULL OUTER JOIN waterx_candidate_feature_snapshots s
       ON s.interval_minutes=l.interval_minutes AND s.round_id=l.round_id
     WHERE (l.start_ms >= $1 AND l.start_ms < $2)
        OR (s.start_ms >= $1 AND s.start_ms < $2)
     ORDER BY COALESCE(l.interval_minutes,s.interval_minutes),
              COALESCE(l.start_ms,s.start_ms),
              COALESCE(l.round_id,s.round_id)
     LIMIT $3`,
    [dayStartMs, dayEndMs, maximumRows + 1],
  );
  if (rows.length > maximumRows)
    throw new Error(`WaterX prior-day audit exceeded its ${maximumRows}-row read bound; no partial report was returned.`);
  const evidence = rows.map(mapEvidenceRow);
  const report = buildWaterxDailyAudit(dayStartMs, evidence, nowMs);
  return {
    ...report,
    readBound: {
      maximumRows,
      rowsRead: rows.length,
      truncated: false,
    },
  };
}