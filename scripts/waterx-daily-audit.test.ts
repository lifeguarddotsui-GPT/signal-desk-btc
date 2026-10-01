import test from "node:test";
import assert from "node:assert/strict";
import {
  auditWaterxPriorUtcDay,
  buildWaterxDailyAudit,
  type WaterxDailyAuditEvidence,
} from "../server/waterx/daily-audit";

const DAY = Date.UTC(2025, 0, 2);

function evidenceFor(
  index: number,
  options: {
    interval?: 5 | 15;
    candidate?: boolean;
    label?: boolean;
    withheld?: boolean;
    disputed?: boolean;
    capturedAfterExpiry?: boolean;
    tickAfterPrediction?: boolean;
  } = {},
): WaterxDailyAuditEvidence {
  const interval = options.interval ?? 5;
  const cadenceMs = interval * 60_000;
  const startMs = DAY + index * cadenceMs;
  const expiryMs = startMs + cadenceMs;
  const observedAtMs = startMs + 500;
  const predictionAtMs = startMs + 2_000;
  const featureSnapshotAtMs = startMs + 1_900;
  const capturedAtMs = options.capturedAfterExpiry ? expiryMs + 1 : startMs + 3_000;
  const outcome = index % 2 === 0 ? "Up" : "Down";
  const labelAvailableMs = expiryMs + 2_000;
  const candidatePrediction = options.candidate === false ? null : {
    kind: "shadow-candidate",
    artifactVersion: "waterx-logistic-candidate-v2",
    modelVersion: "waterx-logistic-candidate-v2:daily-test",
    datasetFingerprint: "a".repeat(64),
    calibrationVersion: "waterx-platt-logistic-v1",
    probabilityUp: outcome === "Up" ? 0.8 : 0.25,
    issuedAtMs: predictionAtMs,
    trainingAttemptAtMs: predictionAtMs - 1_000,
  };
  const recordData = {
    intervalMinutes: interval,
    roundId: `${interval}m-${index}`,
    source: "WaterX",
    featureSchema: "waterx-round-snapshot-v1",
    frozen: true,
    startMs,
    expiryMs,
    predictionAtMs,
    featureSnapshotAtMs,
    confirmedAnchorPrice: 100,
    marketProbabilityUp: 0.6,
    features: { timeRemainingFraction: (expiryMs - predictionAtMs) / cadenceMs },
    candidatePrediction,
  };
  const sourceEvidence = {
    source: "Coinbase",
    archiveSource: "coinbase_ticks",
    marketProbabilityObservedAtMs: observedAtMs,
    firstFrozenMarketProbabilityUp: 0.6,
    firstFrozenMarketProbabilityAtMs: observedAtMs,
    marketProbabilitySnapshot: {
      storage: "waterx_learning_rounds",
      intervalMinutes: interval,
      roundId: `${interval}m-${index}`,
      probabilityUp: 0.6,
      appObservedAtMs: observedAtMs,
      frozen: true,
    },
    selectedTicks: [
      {
        archiveId: `tick-${index}-1`,
        sourceAtMs: predictionAtMs - 1_000,
        receivedAtMs: predictionAtMs - 900,
        price: 100,
      },
      {
        archiveId: `tick-${index}-2`,
        sourceAtMs: options.tickAfterPrediction ? predictionAtMs + 1 : predictionAtMs - 100,
        receivedAtMs: predictionAtMs - 50,
        price: 100.1,
      },
    ],
  };
  const labelStatus = options.disputed || options.withheld
    ? "withheld" : options.label === false ? "unresolved" : "verified";
  const labelPresent = options.label !== false;
  const settlementEvidence = labelPresent ? {
    source: "WaterX",
    resolutionStatus: "resolved",
    anchorPrice: 100,
    anchorConfirmed: true,
    settlePrice: outcome === "Up" ? 101 : 99,
    outcome,
    settledAt: expiryMs + 1_000,
    observedAt: new Date(labelAvailableMs).toISOString(),
    accepted: true,
  } : null;
  return {
    round: {
      intervalMinutes: interval,
      roundId: `${interval}m-${index}`,
      startMs,
      expiryMs,
      anchorPrice: 100,
      anchorConfirmed: true,
      probabilityUp: 0.6,
      observedAtMs,
      sourceProof: { provider: "WaterX", evidenceKind: "WaterX round observation" },
      labelStatus,
      withheldReason: options.withheld ? "Provider evidence incomplete" : null,
      settlementAnchorPrice: labelPresent ? 100 : null,
      settlePrice: labelPresent ? outcome === "Up" ? 101 : 99 : null,
      outcome: labelPresent ? outcome : null,
      settledAtMs: labelPresent ? expiryMs + 1_000 : null,
      labelAvailableMs: labelPresent ? labelAvailableMs : null,
      settlementEvidence,
      settlementDisputed: options.disputed === true,
      settlementDisputedReason: options.disputed ? "Conflicting revision" : null,
      settlementQuarantine: options.disputed ? [{ quarantined: true }] : [],
    },
    snapshot: {
      intervalMinutes: interval,
      roundId: `${interval}m-${index}`,
      startMs,
      expiryMs,
      predictionAtMs,
      featureSnapshotAtMs,
      capturedAtMs,
      confirmedAnchorPrice: 100,
      marketProbabilityUp: 0.6,
      featureSchema: "waterx-round-snapshot-v1",
      recordData,
      sourceEvidence,
    },
  };
}

test("prior UTC day audit compares frozen candidate probabilities with same-observation WaterX baseline", () => {
  const rows = Array.from({ length: 24 }, (_, index) => evidenceFor(index));
  const report = buildWaterxDailyAudit(DAY, rows, DAY + 2 * 24 * 60 * 60_000);
  const fiveMinute = report.intervals[0];

  assert.equal(report.protocol, "waterx-read-only-prior-utc-day-audit-v1");
  assert.equal(report.day.startUtc, new Date(DAY).toISOString());
  assert.equal(fiveMinute.expectedEligibleRounds, 288);
  assert.equal(fiveMinute.coverage.persistedRoundIdentities, 24);
  assert.equal(fiveMinute.coverage.missingRoundCount, 264);
  assert.equal(fiveMinute.coverage.validCandidatePredictionCount, 24);
  assert.equal(fiveMinute.predictionEligibility.matchedScoredSampleSize, 24);
  assert.equal(fiveMinute.scores.candidate?.sampleSize, 24);
  assert.equal(fiveMinute.scores.waterxBaseline?.sampleSize, 24);
  assert.equal(fiveMinute.scores.matchedSameObservation.candidate?.sampleSize, 24);
  assert.equal(fiveMinute.scores.candidate?.calibrationByProbabilityBand
    .reduce((sum, band) => sum + band.count, 0), 24);
  assert.equal(fiveMinute.largestScoreContributions.sampleSize, 24);
  assert.equal(fiveMinute.largestScoreContributions.topCandidateBrierLosses.length, 10);
  assert.equal(fiveMinute.labelTiming.labelAvailabilityUtcByRound.length, 24);
  assert.equal(report.safeguards.readOnly, true);
  assert.match(report.safeguards.laterBatchingCost, /Unknown/);
});

test("zero or insufficient matched predictions leave aggregate metrics null", () => {
  const rows = Array.from({ length: 19 }, (_, index) => evidenceFor(index));
  const report = buildWaterxDailyAudit(DAY, rows, DAY + 3 * 24 * 60 * 60_000);
  const fiveMinute = report.intervals[0];

  assert.equal(fiveMinute.predictionEligibility.matchedMetricsStatus, "insufficient");
  assert.equal(fiveMinute.scores.candidate, null);
  assert.equal(fiveMinute.scores.waterxBaseline, null);
  assert.equal(fiveMinute.scores.matchedSameObservation.candidate, null);
  assert.equal(fiveMinute.scores.matchedSameObservation.candidateMinusWaterxBrier, null);
  assert.equal(fiveMinute.timeRemaining.scoreBands.every(band =>
    band.candidateMetrics === null), true);

  const noPredictions = Array.from({ length: 30 }, (_, index) =>
    evidenceFor(index, { candidate: false }));
  const noPredictionsReport = buildWaterxDailyAudit(
    DAY, noPredictions, DAY + 3 * 24 * 60 * 60_000);
  assert.equal(noPredictionsReport.intervals[0].coverage.validCandidatePredictionCount, 0);
  assert.equal(noPredictionsReport.intervals[0].scores.candidate, null);
  assert.equal(noPredictionsReport.intervals[0].scores.matchedSameObservation.candidate, null);
});

test("withheld, missing, and disputed labels are counted but never scored", () => {
  const rows = [
    evidenceFor(0, { withheld: true }),
    evidenceFor(1, { label: false }),
    evidenceFor(2, { disputed: true }),
    ...Array.from({ length: 21 }, (_, index) => evidenceFor(index + 3)),
  ];
  const fiveMinute = buildWaterxDailyAudit(
    DAY, rows, DAY + 3 * 24 * 60 * 60_000).intervals[0];

  assert.equal(fiveMinute.coverage.withheldRoundCount, 2);
  assert.equal(fiveMinute.coverage.disputedRoundCount, 1);
  assert.equal(fiveMinute.coverage.missingLabelRoundCount, 1);
  assert.equal(fiveMinute.scores.matchedSameObservation.sampleSize, 21);
});

test("postclose, backfilled, and future-timestamp evidence is excluded", () => {
  const invalid = [
    evidenceFor(0, { capturedAfterExpiry: true }),
    evidenceFor(1, { tickAfterPrediction: true }),
  ];
  const report = buildWaterxDailyAudit(
    DAY, [...invalid, ...Array.from({ length: 21 }, (_, index) => evidenceFor(index + 2))],
    DAY + 3 * 24 * 60 * 60_000);
  const fiveMinute = report.intervals[0];

  assert.equal(fiveMinute.coverage.validCandidatePredictionCount, 21);
  assert.equal(fiveMinute.scores.matchedSameObservation.sampleSize, 21);
  assert.equal(fiveMinute.excludedEvidenceCounts["postclose-backfilled-or-invalid-frozen-snapshot"], 2);
});

test("duplicate and malformed composite round identities fail closed", () => {
  const one = evidenceFor(0);
  assert.throws(() => buildWaterxDailyAudit(
    DAY, [one, one], DAY + 2 * 24 * 60 * 60_000), /Duplicate WaterX 5m round identity/);
  const badSnapshot = evidenceFor(1);
  const mismatchedSnapshot: WaterxDailyAuditEvidence = {
    ...badSnapshot,
    snapshot: { ...badSnapshot.snapshot!, roundId: "different-round" },
  };
  assert.throws(() => buildWaterxDailyAudit(
    DAY, [mismatchedSnapshot], DAY + 2 * 24 * 60 * 60_000), /composite identities conflict/);
});

test("15-minute expected denominator and interval-specific round identity remain separate", () => {
  const rows = Array.from({ length: 24 }, (_, index) =>
    evidenceFor(index, { interval: 15 }));
  const report = buildWaterxDailyAudit(DAY, rows, DAY + 2 * 24 * 60 * 60_000);
  const fifteenMinute = report.intervals[1];

  assert.equal(fifteenMinute.expectedRoundCount, 96);
  assert.equal(fifteenMinute.coverage.persistedRoundIdentities, 24);
  assert.equal(fifteenMinute.predictionEligibility.matchedScoredSampleSize, 24);
  assert.equal(report.intervals[0].coverage.persistedRoundIdentities, 0);
});

test("database loader is bounded and uses the prior completed UTC day", async () => {
  let sql = "";
  let values: unknown[] = [];
  const report = await auditWaterxPriorUtcDay({
    async query(text, parameters) {
      sql = text;
      values = parameters ?? [];
      return { rows: [] };
    },
  }, Date.UTC(2025, 0, 3, 4), 100);

  assert.equal(report.day.startUtc, new Date(DAY).toISOString());
  assert.match(sql, /FULL OUTER JOIN waterx_candidate_feature_snapshots/);
  assert.match(sql, /settlement_quarantine/);
  assert.match(sql, /LIMIT \$3/);
  assert.deepEqual(values, [DAY, DAY + 24 * 60 * 60_000, 101]);
  await assert.rejects(() => auditWaterxPriorUtcDay({
    async query() { return { rows: Array.from({ length: 2 }, () => ({})) }; },
  }, Date.UTC(2025, 0, 3, 4), 1), /exceeded its 1-row read bound/);
});