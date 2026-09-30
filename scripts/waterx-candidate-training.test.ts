import test from "node:test";
import assert from "node:assert/strict";
import {
  WATERX_CANDIDATE_FEATURE_SCHEMA,
  WATERX_CANDIDATE_ARTIFACT_VERSION,
  WATERX_CANDIDATE_CALIBRATION_VERSION,
  predictWaterxCandidate,
  trainWaterxCandidate,
  type WaterxCandidateInterval,
  type WaterxProspectiveRoundRecord,
} from "../server/waterx/candidate-training";

function records(intervalMinutes: WaterxCandidateInterval, count: number): WaterxProspectiveRoundRecord[] {
  const cadenceMs = intervalMinutes * 60_000;
  const gapMs = intervalMinutes === 5 ? 30 * 60_000 : 60 * 60_000;
  const firstStart = Date.UTC(2025, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    const startMs = firstStart + index * gapMs;
    const expiryMs = startMs + cadenceMs;
    const outcome = index % 2 === 0 ? "Up" : "Down";
    const direction = outcome === "Up" ? 1 : -1;
    return {
      intervalMinutes,
      roundId: `${intervalMinutes}m-round-${index}`,
      source: "WaterX",
      featureSchema: WATERX_CANDIDATE_FEATURE_SCHEMA,
      frozen: true,
      startMs,
      expiryMs,
      predictionAtMs: startMs + 1_000,
      featureSnapshotAtMs: startMs + 900,
      confirmedAnchorPrice: 100,
      marketProbabilityUp: 0.5 + (index % 5 - 2) * 0.025,
      features: {
        referenceDistanceBps: direction * (4 + index % 3),
        timeRemainingFraction: 0.95,
        return1m: direction * 0.001,
        return3m: direction * 0.002,
        realizedVolatilityBps: 5 + index % 4,
        marketProbabilityUpDelta: direction * 0.01,
        sourceAgeMs: 250 + index % 8,
      },
      label: {
        source: "WaterX",
        acceptedByWaterxSettlementGate: true,
        resolutionStatus: "resolved",
        anchorConfirmed: true,
        settlementAnchorPrice: 100,
        settlePrice: outcome === "Up" ? 100.1 : 99.9,
        outcome,
        settledAtMs: expiryMs + 1_000,
        labelAvailableMs: expiryMs + 30 * 60_000,
      },
    };
  });
}

test("prospective candidate scoring uses contemporaneous WaterX probability and rejects incompatible artifacts", () => {
  const artifact = {
    artifactVersion: WATERX_CANDIDATE_ARTIFACT_VERSION,
    modelVersion: `${WATERX_CANDIDATE_ARTIFACT_VERSION}:score-fixture`,
    intervalMinutes: 5 as const,
    datasetFingerprint: "a".repeat(64),
    featureSchema: WATERX_CANDIDATE_FEATURE_SCHEMA,
    featureNames: [
      "marketProbabilityUp", "referenceDistanceBps", "timeRemainingFraction",
      "return1m", "return3m", "realizedVolatilityBps", "sourceAgeMs",
    ],
    means: [0, 0, 0, 0, 0, 0, 0],
    scales: [1, 1, 1, 1, 1, 1, 1],
    coefficients: [4, 0, 0, 0, 0, 0, 0],
    intercept: 0,
    calibration: { slope: 1, intercept: 0 },
  };
  const features = records(5, 1)[0].features;
  const lower = predictWaterxCandidate(artifact, {
    intervalMinutes: 5, marketProbabilityUp: 0.25, features,
  });
  const higher = predictWaterxCandidate(artifact, {
    intervalMinutes: 5, marketProbabilityUp: 0.75, features,
  });
  assert.ok(lower !== null && higher !== null);
  assert.ok(lower! < higher!);
  assert.equal(predictWaterxCandidate({
    ...artifact, artifactVersion: "waterx-logistic-candidate-v1",
  }, { intervalMinutes: 5, marketProbabilityUp: 0.5, features }), null);
  assert.equal(predictWaterxCandidate(artifact, {
    intervalMinutes: 15, marketProbabilityUp: 0.5, features,
  }), null);
});

test("forward predictions are scored only after an accepted delayed label and against same-round WaterX odds", () => {
  const sample = records(5, 3).map((record, index) => ({
    ...record,
    candidatePrediction: {
      kind: "shadow-candidate" as const,
      artifactVersion: WATERX_CANDIDATE_ARTIFACT_VERSION,
      modelVersion: `${WATERX_CANDIDATE_ARTIFACT_VERSION}:forward-fixture`,
      datasetFingerprint: "b".repeat(64),
      calibrationVersion: WATERX_CANDIDATE_CALIBRATION_VERSION,
      probabilityUp: index === 0 ? 0.8 : 0.2,
      issuedAtMs: record.predictionAtMs,
      trainingAttemptAtMs: record.predictionAtMs - 1,
    },
  }));
  sample[2] = { ...sample[2], label: null };
  const report = trainWaterxCandidate(5, sample);
  assert.equal(report.status, "insufficient");
  assert.equal(report.forwardPredictionEvaluation.storedPredictionCount, 3);
  assert.equal(report.forwardPredictionEvaluation.scoredPredictionCount, 2);
  assert.equal(report.forwardPredictionEvaluation.unscoredPredictionCount, 1);
  assert.equal(report.forwardPredictionEvaluation.labelAvailabilityPercent, 66.67);
  const evaluated = report.forwardPredictionEvaluation.byModelVersion[0];
  assert.equal(evaluated.modelVersion, `${WATERX_CANDIDATE_ARTIFACT_VERSION}:forward-fixture`);
  assert.equal(evaluated.candidateMetrics?.count, 2);
  assert.equal(evaluated.matchingMarketMetrics?.count, 2);
  assert.equal(evaluated.matchedComparison?.count, 2);

  sample[0] = {
    ...sample[0],
    candidatePrediction: {
      ...sample[0].candidatePrediction!,
      trainingAttemptAtMs: sample[0].predictionAtMs,
    },
  };
  const invalidTimestamp = trainWaterxCandidate(5, sample);
  assert.equal(invalidTimestamp.forwardPredictionEvaluation.storedPredictionCount, 2);
});

test("fits deterministically with separate chronological train/calibration/test and matched market metrics", () => {
  const sample = records(5, 240);
  const result = trainWaterxCandidate(5, sample);
  const repeated = trainWaterxCandidate(5, sample);

  assert.equal(result.status, "candidate-evaluated");
  assert.equal(result.eligibility.eligible, true);
  assert.equal(result.split.trainCount >= 40, true);
  assert.equal(result.split.calibrationCount >= 20, true);
  assert.equal(result.split.testCount >= 20, true);
  assert.ok(result.split.embargoExcludedCount > 0);
  assert.ok(result.split.trainThroughMs! < result.split.calibrationFromMs!);
  assert.ok(result.split.calibrationThroughMs! < result.split.testFromMs!);
  assert.deepEqual(result.artifact, repeated.artifact);
  assert.deepEqual(result.candidateTestMetrics, repeated.candidateTestMetrics);
  assert.equal(result.candidateTestMetrics?.count, result.matchingMarketTestMetrics?.count);
  assert.equal(result.matchedTestComparison?.count, result.candidateTestMetrics?.count);
  assert.match(result.matchedTestComparison!.uncertaintyNote, /descriptive only/);
  assert.ok(Number.isFinite(result.matchedTestComparison!.candidateMinusMarketBrier.mean));
  assert.equal(result.testRegimeEvaluations.filter(regime =>
    regime.dimension === "time-remaining").reduce((sum, regime) => sum + regime.count, 0),
  result.candidateTestMetrics?.count);
  assert.equal(result.testRegimeEvaluations.filter(regime =>
    regime.dimension === "market-probability").reduce((sum, regime) => sum + regime.count, 0),
  result.candidateTestMetrics?.count);
  assert.ok(result.artifact?.featureNames.includes("marketProbabilityUp"));
  assert.ok(!result.artifact?.featureNames.includes("marketProbabilityUpDelta"));
  assert.equal(result.promoted, false);
  assert.equal(result.artifact?.intervalMinutes, 5);
  assert.equal(result.artifact?.artifactVersion, "waterx-logistic-candidate-v2");
  assert.match(result.datasetFingerprint, /^[a-f0-9]{64}$/);
  assert.match(result.promotionRejectionReason, /disabled/);
  assert.match(result.rejectionReason, /shadow-only/);
});

test("test outcomes cannot alter the fitted model or calibration", () => {
  const sample = records(5, 240);
  const baseline = trainWaterxCandidate(5, sample);
  const boundaryIndex = Math.floor(sample.length * 0.8);
  const changedTestLabels = sample.map((record, index) => {
    if (index < boundaryIndex || !record.label) return record;
    const outcome = record.label.outcome === "Up" ? "Down" : "Up";
    return {
      ...record,
      label: {
        ...record.label,
        outcome,
        settlePrice: outcome === "Up" ? 100.1 : 99.9,
      },
    };
  });
  const changed = trainWaterxCandidate(5, changedTestLabels);
  assert.deepEqual(changed.artifact?.means, baseline.artifact?.means);
  assert.deepEqual(changed.artifact?.scales, baseline.artifact?.scales);
  assert.deepEqual(changed.artifact?.coefficients, baseline.artifact?.coefficients);
  assert.deepEqual(changed.artifact?.calibration, baseline.artifact?.calibration);
  assert.equal(changed.artifact?.modelVersion, baseline.artifact?.modelVersion);
  assert.notEqual(changed.datasetFingerprint, baseline.datasetFingerprint);
  assert.notDeepEqual(changed.candidateTestMetrics, baseline.candidateTestMetrics);
});

test("tiny 5m and 15m cohorts are explicitly ineligible and never promoted", () => {
  for (const [interval, count] of [[5, 12], [15, 4]] as const) {
    const result = trainWaterxCandidate(interval, records(interval, count));
    assert.equal(result.status, "insufficient");
    assert.equal(result.eligibility.eligible, false);
    assert.match(result.eligibility.rejectionReason!, /at least 90/);
    assert.equal(result.artifact, null);
    assert.equal(result.candidateTestMetrics, null);
    assert.equal(result.promoted, false);
  }
});

test("only valid authoritative labels enter; inconsistent outcomes and provisional evidence are rejected", () => {
  const sample = records(5, 100);
  sample[3] = {
    ...sample[3],
    label: { ...sample[3].label!, outcome: "Up", settlePrice: 99.9 },
  };
  sample[4] = { ...sample[4], label: null };
  const result = trainWaterxCandidate(5, sample);
  assert.equal(result.acceptedLabelCount, 98);
  assert.equal(result.rejectedRecordCount, 2);
});

test("round duplicates are rejected from the dataset and block eligibility", () => {
  const sample = records(5, 100);
  sample.push({ ...sample[0] });
  const result = trainWaterxCandidate(5, sample);
  assert.equal(result.eligibility.eligible, false);
  assert.match(result.eligibility.rejectionReason!, /Duplicate interval\/round identities/);
  assert.equal(result.promoted, false);
});

test("authoritative label-availability embargo excludes delayed pre-boundary labels", () => {
  const sample = records(5, 240);
  const baseline = trainWaterxCandidate(5, sample);
  const boundary = Math.floor(sample.length * 0.6);
  const delayedIndex = boundary - 2;
  sample[delayedIndex] = {
    ...sample[delayedIndex],
    label: {
      ...sample[delayedIndex].label!,
      labelAvailableMs: sample[boundary].predictionAtMs + 1,
    },
  };
  const delayed = trainWaterxCandidate(5, sample);
  assert.ok(delayed.split.embargoExcludedCount > baseline.split.embargoExcludedCount);
  assert.ok(delayed.split.trainCount < baseline.split.trainCount);
});

test("15m candidates remain isolated and enforce the longer span requirement", () => {
  const short = records(15, 100).map((record, index) => ({
    ...record,
    startMs: Date.UTC(2025, 0, 1) + index * 15 * 60_000,
    expiryMs: Date.UTC(2025, 0, 1) + index * 15 * 60_000 + 15 * 60_000,
    predictionAtMs: Date.UTC(2025, 0, 1) + index * 15 * 60_000 + 1_000,
    featureSnapshotAtMs: Date.UTC(2025, 0, 1) + index * 15 * 60_000 + 900,
    label: {
      ...record.label!,
      settledAtMs: Date.UTC(2025, 0, 1) + index * 15 * 60_000 + 16 * 60_000,
      labelAvailableMs: Date.UTC(2025, 0, 1) + index * 15 * 60_000 + 17 * 60_000,
    },
  }));
  const result = trainWaterxCandidate(15, short);
  assert.equal(result.status, "insufficient");
  assert.equal(result.eligibility.requirements.minimumSpanMs, 7 * 24 * 60 * 60_000);
  assert.match(result.eligibility.rejectionReason!, /span/);
});

test("interval datasets and fingerprints do not cross-contaminate", () => {
  const fiveMinute = records(5, 120);
  const baseline = trainWaterxCandidate(5, fiveMinute);
  const mixed = trainWaterxCandidate(5, [...fiveMinute, ...records(15, 8)]);
  assert.equal(mixed.datasetFingerprint, baseline.datasetFingerprint);
  assert.equal(mixed.recordCount, baseline.recordCount);
  assert.deepEqual(mixed.artifact, baseline.artifact);
});