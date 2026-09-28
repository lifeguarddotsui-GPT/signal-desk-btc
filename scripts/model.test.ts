import test from "node:test";
import assert from "node:assert/strict";
import { inferBtcArtifact } from "../server/btc/artifact";
import {
  buildShadowArtifact,
  evaluateShadow,
  predictShadowTestWindow,
  type ShadowRow,
} from "../server/btc/model";

function rows(count: number, startMs = Date.UTC(2025, 0, 1), stepMs = 15 * 60_000): ShadowRow[] {
  return Array.from({ length: count }, (_, i) => {
    const observedMs = startMs + i * stepMs;
    return {
      id: `round-${i}`,
      observedMs,
      expiryMs: observedMs + 60_000,
      labelAvailableMs: observedMs + 65_000,
      outcome: i % 3 === 0 || i % 3 === 1 ? "UP" : "DOWN",
      indicativeUp: 0.25 + ((i * 17) % 50) / 100,
      comparisonReturn: ((i % 11) - 5) / 10_000,
      realizedVolatility: 0.001 + (i % 7) / 10_000,
      remainingSeconds: 60,
    };
  });
}

test("walk-forward training, calibration, and test windows are strictly ordered", () => {
  const history = rows(420);
  const result = evaluateShadow(history);
  assert.equal(result.status, "shadow");
  assert.equal(result.eligible, true);
  assert.ok(result.challenger);
  const { training, calibration, test: heldOut } = result.evaluated.split;
  assert.ok(training.endUtc! < calibration.startUtc!);
  assert.ok(calibration.endUtc! < heldOut.startUtc!);
  assert.equal(result.challenger!.trainingCount, training.count);
  assert.equal(result.challenger!.calibrationCount, calibration.count);
  assert.equal(result.challenger!.metrics.count, heldOut.count);
  assert.equal(result.baselines.onChainIndicative!.count, heldOut.count);
  assert.equal(result.baselines.deepBookCalibrated!.metrics.count, heldOut.count);
  assert.equal(result.lastTrainingAt, training.endUtc);
  assert.ok(result.challenger!.method.includes("untouched later test window"));
  assert.ok(Date.parse(calibration.startUtc!) - Date.parse(training.endUtc!) >= 90_000);
  assert.ok(Date.parse(heldOut.startUtc!) - Date.parse(calibration.endUtc!) >= 90_000);
  assert.ok(!("champion" in result));
});

test("90-second embargo purges close boundary rows and volatility benchmark stays unavailable", () => {
  const closeObservations = rows(420, Date.UTC(2025, 0, 1), 30_000);
  const result = evaluateShadow(closeObservations);
  const { training, calibration, test: heldOut } = result.evaluated.split;
  assert.ok(Date.parse(calibration.startUtc!) - Date.parse(training.endUtc!) >= 90_000);
  assert.ok(Date.parse(heldOut.startUtc!) - Date.parse(calibration.endUtc!) >= 90_000);
  assert.equal(result.baselines.volatilityNeutral, null);
  assert.match(result.baselines.volatilityNeutralUnavailableReason, /settlement-relevant signed distance/);
  assert.equal(result.baselines.onChainIndicative!.brierUncertainty.effectiveSampleSize,
    result.baselines.onChainIndicative!.brierUncertainty.blockCount);
});

test("changing untouched test outcomes cannot change fitted model or calibration", () => {
  const history = rows(420);
  const first = evaluateShadow(history);
  const calibrationEnd = Math.floor(history.length * 0.6) + Math.floor(history.length * 0.2);
  const changedTest = history.map((row, index) => index >= calibrationEnd
    ? { ...row, outcome: row.outcome === "UP" ? "DOWN" as const : "UP" as const }
    : row);
  const second = evaluateShadow(changedTest);
  assert.deepEqual(second.challenger!.coefficients, first.challenger!.coefficients);
  assert.deepEqual(second.challenger!.plattCalibration, first.challenger!.plattCalibration);
  assert.deepEqual(second.baselines.deepBookCalibrated!.plattCalibration,
    first.baselines.deepBookCalibrated!.plattCalibration);
  assert.deepEqual(second.featureAblations.comparisons.map(comparison => [
    comparison.trainingDataHash, comparison.calibrationDataHash,
  ]), first.featureAblations.comparisons.map(comparison => [
    comparison.trainingDataHash, comparison.calibrationDataHash,
  ]));
  assert.ok(second.featureAblations.comparisons.every(comparison =>
    comparison.evaluationRoundIdsHash === first.featureAblations.reference.evaluationRoundIdsHash));
  assert.notEqual(second.challenger!.metrics.brier, first.challenger!.metrics.brier);
});

test("shadow probabilities and calibration bins stay bounded and sum to evaluated count", () => {
  const result = evaluateShadow(rows(420));
  const challenger = result.challenger!;
  const metrics = challenger.metrics;
  assert.ok(metrics.brier >= 0 && metrics.brier <= 1);
  assert.ok(metrics.logLoss >= 0);
  assert.equal(metrics.calibrationBins.reduce((sum, bin) => sum + bin.count, 0), metrics.count);
  for (const bin of metrics.calibrationBins) {
    assert.ok(bin.lower >= 0 && bin.upper <= 1 && bin.lower < bin.upper);
    if (bin.count) {
      assert.ok(bin.meanPredicted! >= 0 && bin.meanPredicted! <= 1);
      assert.ok(bin.observedUpRate! >= 0 && bin.observedUpRate! <= 1);
    } else {
      assert.equal(bin.meanPredicted, null);
      assert.equal(bin.observedUpRate, null);
    }
  }
  assert.equal(metrics.upCount + metrics.downCount, metrics.count);
  assert.ok(metrics.brierUncertainty.lower >= 0);
  assert.ok(metrics.brierUncertainty.upper <= 1);
  assert.ok(metrics.brierUncertainty.method.includes("30-minute time blocks"));
  assert.equal(metrics.brierUncertainty.effectiveSampleSize, metrics.brierUncertainty.blockCount);
  assert.equal(metrics.brierUncertainty.blockDurationMinutes, 30);
});

test("duplicate rounds and future or invalid probability features are rejected", () => {
  const duplicate = rows(3);
  duplicate[2] = { ...duplicate[2], id: duplicate[1].id };
  assert.throws(() => evaluateShadow(duplicate), /Duplicate round id/);

  const future = rows(2);
  future[1] = { ...future[1], observedMs: future[1].expiryMs + 1 };
  assert.throws(() => evaluateShadow(future), /Future observation/);

  const invalidProbability = rows(2);
  invalidProbability[0] = { ...invalidProbability[0], indicativeUp: 1.01 };
  assert.throws(() => evaluateShadow(invalidProbability), /must be a probability/);
});

test("low sample history returns insufficient shadow status without a challenger", () => {
  const result = evaluateShadow(rows(120));
  assert.equal(result.status, "insufficient");
  assert.equal(result.eligible, false);
  assert.match(result.reason, /at least 300/);
  assert.equal(result.challenger, null);
});

test("one-day history fails the elapsed verified-history eligibility gate", () => {
  const oneDay = rows(300, Date.UTC(2025, 0, 1), 60_000);
  const result = evaluateShadow(oneDay);
  assert.equal(result.status, "insufficient");
  assert.equal(result.eligible, false);
  assert.match(result.reason, /48 hours of elapsed verified observations/);
  assert.equal(result.challenger, null);
});

test("crossing UTC midnight without 48 elapsed hours is insufficient", () => {
  const crossesMidnight = rows(300, Date.UTC(2025, 0, 1, 23), 60_000);
  assert.notEqual(
    new Date(crossesMidnight[0].observedMs).toISOString().slice(0, 10),
    new Date(crossesMidnight.at(-1)!.observedMs).toISOString().slice(0, 10),
  );
  const result = evaluateShadow(crossesMidnight);
  assert.equal(result.status, "insufficient");
  assert.match(result.reason, /48 hours of elapsed verified observations/);
});

test("elapsed history with a long observation gap fails coverage", () => {
  const withOutage = rows(300).map((row, index) => index < 150
    ? row
    : {
      ...row,
      observedMs: row.observedMs + 13 * 60 * 60 * 1000,
      expiryMs: row.expiryMs + 13 * 60 * 60 * 1000,
      labelAvailableMs: row.labelAvailableMs! + 13 * 60 * 60 * 1000,
    });
  const result = evaluateShadow(withOutage);
  assert.equal(result.status, "insufficient");
  assert.match(result.reason, /at least 300 unique verified rounds/);
  assert.equal(result.readiness.eligibleRounds, 150);
  assert.equal(result.readiness.remainingRounds, 150);
  assert.ok(result.readiness.missingIntervals.some(interval =>
    interval.unobservedDurationMinutes >= 12 * 60 &&
    interval.interpretation.includes("does not prove a market round existed")));
});

test("repeated evaluation of identical history is deterministic", () => {
  const history = rows(420);
  const first = evaluateShadow(history);
  const second = evaluateShadow(history);
  assert.deepEqual(second, first);
  assert.equal(first.challenger!.metrics.count, first.evaluated.count);
});

test("history with at least 48 elapsed hours and regular coverage is eligible", () => {
  const history = rows(420, Date.UTC(2025, 0, 1, 12));
  assert.ok(history.at(-1)!.observedMs - history[0].observedMs >= 48 * 60 * 60 * 1000);
  const result = evaluateShadow(history);
  assert.equal(result.status, "shadow");
  assert.equal(result.eligible, true);
});

test("a historical archive gap does not disqualify a sufficiently long post-recovery cohort", () => {
  const archive = rows(300, Date.UTC(2025, 0, 1)).map(row => ({
    ...row,
    id: `archive-${row.id}`,
  }));
  const recovered = rows(420, archive.at(-1)!.observedMs + 13 * 60 * 60 * 1000).map(row => ({
    ...row,
    id: `recovered-${row.id}`,
  }));
  const history = [...archive, ...recovered];
  const result = evaluateShadow(history);
  assert.equal(result.status, "shadow");
  assert.equal(result.readiness.ready, true);
  assert.equal(result.readiness.eligibleRounds, recovered.length);
  assert.equal(result.readiness.cleanHours,
    (recovered.at(-1)!.observedMs - recovered[0].observedMs) / 3_600_000);
  assert.match(result.readiness.cohortVersion, /^btc-clean-cohort-v1-[a-f\d]{24}$/);
  assert.ok(result.readiness.missingIntervals.some(interval =>
    interval.unobservedDurationMinutes >= 12 * 60 &&
    interval.interpretation.includes("does not prove a market round existed")));

  const artifact = buildShadowArtifact(history);
  assert.equal(artifact.provenance.trainingRowCount, result.evaluated.split.training.count);
  assert.equal(artifact.provenance.trainingCutoffMs,
    Date.parse(result.readiness.trainingObservedThroughUtc!));
});

test("a current gap starts a new cohort and reports remaining recovery requirements", () => {
  const history = rows(300).map((row, index) => index < 150 ? row : {
    ...row,
    observedMs: row.observedMs + 13 * 60 * 60 * 1000,
    expiryMs: row.expiryMs + 13 * 60 * 60 * 1000,
    labelAvailableMs: row.labelAvailableMs! + 13 * 60 * 60 * 1000,
  });
  const result = evaluateShadow(history);
  assert.equal(result.status, "insufficient");
  assert.equal(result.readiness.eligibleRounds, 150);
  assert.equal(result.readiness.remainingRounds, 150);
  assert.ok(result.readiness.remainingHours > 0);
  assert.ok(result.readiness.maximumGapHours! <= 12);
  assert.ok(result.readiness.missingIntervals.length > 0);
  assert.equal(result.readiness.trainingObservedFromUtc,
    new Date(history[150].observedMs).toISOString());
  assert.ok(result.readiness.evidenceInterpretation.includes("Offline chronological"));
});

test("delayed test-label verification is timestamped without changing the fitted model version", () => {
  const history = rows(420);
  const originalArtifactVersion = buildShadowArtifact(history).modelVersion;
  const last = history.length - 1;
  const { labelAvailableMs: _notYetVerified, ...unverified } = history[last];
  history[last] = unverified;
  const beforeVerification = evaluateShadow(history);
  assert.equal(beforeVerification.readiness.eligibleRounds, 419);
  assert.equal(beforeVerification.readiness.ready, false);
  assert.equal(beforeVerification.evaluated.labelAvailability.missingCount, 1);

  history[last] = { ...history[last], labelAvailableMs: history[last].expiryMs + 24 * 60 * 60 * 1000 };
  const afterVerification = evaluateShadow(history);
  assert.equal(afterVerification.readiness.eligibleRounds, 420);
  assert.equal(afterVerification.readiness.ready, true);
  assert.equal(afterVerification.readiness.scoringLabelsAvailableThroughUtc,
    new Date(history[last].labelAvailableMs!).toISOString());
  assert.equal(afterVerification.readiness.cohortVersion,
    beforeVerification.readiness.cohortVersion);
  assert.equal(buildShadowArtifact(history).modelVersion, originalArtifactVersion);
  assert.deepEqual(evaluateShadow(history), afterVerification);
});

test("DeepBook calibration, raw market, and logistic scores use identical held-out rounds", () => {
  const result = evaluateShadow(rows(420));
  const heldOutCount = result.evaluated.split.test.count;
  const raw = result.baselines.onChainIndicative!;
  const calibrated = result.baselines.deepBookCalibrated!;
  const logistic = result.challenger!.metrics;
  assert.equal(raw.count, heldOutCount);
  assert.equal(calibrated.metrics.count, heldOutCount);
  assert.equal(logistic.count, heldOutCount);
  assert.equal(raw.window.startUtc, calibrated.metrics.window.startUtc);
  assert.equal(raw.window.endUtc, logistic.window.endUtc);
  assert.equal(calibrated.calibrationCount, result.evaluated.split.calibration.count);
  assert.match(calibrated.method, /same untouched later primary-window rounds/);
});

test("fixed experiment registry compares identity, Platt, beta, and correction on matched held-out rounds", () => {
  const result = evaluateShadow(rows(420));
  const registry = result.experimentRegistry;
  assert.equal(registry.promotionDecision.decision, "retain_current_no_qualified_champion");
  assert.match(registry.tuningPolicy, /not used for fitting, selection, or repeated tuning/);
  assert.deepEqual(registry.candidates.map(candidate => candidate.name), [
    "raw-market-identity",
    "market-platt-l2",
    "market-beta-l2",
    "market-correction-l2-logistic",
  ]);
  const [identity, platt, beta, correction] = registry.candidates;
  assert.ok(registry.candidates.every(candidate => candidate.status === "evaluated"));
  assert.ok(registry.candidates.every(candidate =>
    candidate.evaluationRoundIdsHash === identity.evaluationRoundIdsHash));
  assert.ok(registry.candidates.every(candidate =>
    candidate.evaluationDataHash === identity.evaluationDataHash));
  assert.ok(registry.candidates.slice(1).every(candidate =>
    typeof candidate.config.fitParameters === "string"));
  assert.ok(registry.candidates.every(candidate =>
    candidate.metrics?.count === result.evaluated.split.test.count));
  assert.equal(identity.metrics!.brier, result.baselines.onChainIndicative!.brier);
  assert.equal(platt.metrics!.brier, result.baselines.deepBookCalibrated!.metrics.brier);
  assert.ok(beta.metrics!.brier >= 0 && beta.metrics!.brier <= 1);
  assert.equal(correction.metrics!.brier, result.challenger!.metrics.brier);
  assert.equal(correction.cutoffs.trainingLabelsAvailableThroughMs,
    Math.max(...rows(420).slice(0, 252).map(row => row.labelAvailableMs!)));
});

test("feature-family ablations refit on fixed train/calibration and score identical held-out rounds", () => {
  const result = evaluateShadow(rows(420));
  const report = result.featureAblations;
  assert.equal(report.status, "evaluated");
  assert.match(report.protocol, /identical chronological training split/);
  assert.match(report.policy, /Descriptive comparison only.*no candidate selection.*claim of improvement/);
  assert.equal(report.reference.metrics?.count, result.evaluated.split.test.count);
  assert.deepEqual(report.comparisons.map(comparison => comparison.family), [
    "indicative-market-probability",
    "remaining-time-to-expiry",
    "comparison-return",
    "realized-volatility",
  ]);
  assert.ok(report.comparisons.every(comparison =>
    comparison.trainingCount === result.evaluated.split.training.count &&
    comparison.calibrationCount === result.evaluated.split.calibration.count &&
    comparison.evaluationCount === result.evaluated.split.test.count &&
    comparison.evaluationRoundIdsHash === report.reference.evaluationRoundIdsHash &&
    comparison.trainingDataHash === report.comparisons[0].trainingDataHash &&
    comparison.calibrationDataHash === report.comparisons[0].calibrationDataHash &&
    comparison.metrics?.count === report.reference.metrics?.count &&
    comparison.metrics?.brier !== undefined &&
    comparison.metrics?.logLoss !== undefined));
  assert.equal(report.comparisons.length, 4);
  assert.equal(result.experimentRegistry.promotionDecision.decision,
    "retain_current_no_qualified_champion");

  const insufficient = evaluateShadow(rows(120)).featureAblations;
  assert.equal(insufficient.status, "insufficient");
  assert.ok(insufficient.comparisons.every(comparison => comparison.metrics === null));
});

test("missing verification timestamps do not infer labels at expiry or qualify candidates", () => {
  const history = rows(420).map(({ labelAvailableMs: _labelAvailableMs, ...row }) => row);
  const result = evaluateShadow(history);
  assert.equal(result.status, "insufficient");
  assert.match(result.reason, /actual settlement label-availability timestamps are required/);
  assert.equal(result.evaluated.labelAvailability.missingCount, history.length);
  assert.ok(result.experimentRegistry.candidates.every(candidate => candidate.status === "insufficient"));
  assert.ok(result.experimentRegistry.candidates.every(candidate =>
    candidate.reason!.includes("label-availability timestamps")));
  assert.equal(result.experimentRegistry.promotionDecision.decision,
    "retain_current_no_qualified_champion");
});

test("late label verification is purged from earlier fitting splits", () => {
  const history = rows(420);
  const calibrationStartIndex = Math.floor(history.length * 0.6);
  history[calibrationStartIndex - 2] = {
    ...history[calibrationStartIndex - 2],
    labelAvailableMs: history[calibrationStartIndex].observedMs + 1,
  };
  const result = evaluateShadow(history);
  assert.equal(result.status, "shadow");
  const candidate = result.experimentRegistry.candidates[0];
  assert.ok(candidate.cutoffs.trainingLabelsAvailableThroughMs! <
    candidate.cutoffs.calibrationObservedFromMs!);
  assert.ok(candidate.cutoffs.calibrationLabelsAvailableThroughMs! <
    candidate.cutoffs.evaluationObservedFromMs!);
});

test("remaining-time evaluation marks sparse five-second coverage without generalizing", () => {
  const history = rows(420).map((row, index) =>
    index >= 410 ? { ...row, remainingSeconds: 5 } : row);
  const result = evaluateShadow(history);
  assert.equal(result.status, "shadow");
  const nearExpiry = result.evaluated.remainingTimeBuckets[0];
  assert.equal(nearExpiry.count, 10);
  assert.equal(nearExpiry.coverage, "sparse");
  assert.match(nearExpiry.reason!, /at least 30 required/);
  assert.equal(nearExpiry.logistic!.count, nearExpiry.count);
  assert.equal(result.evaluated.remainingTimeBuckets[3].coverage, "sufficient");
});

test("uncertainty is conservative when held-out evidence occupies one time block", () => {
  const result = evaluateShadow(rows(420, Date.UTC(2025, 0, 1), 2_000));
  const uncertainty = result.baselines.onChainIndicative!.brierUncertainty;
  assert.equal(uncertainty.blockCount, 1);
  assert.equal(uncertainty.effectiveSampleSize, 1);
  assert.equal(uncertainty.lower, 0);
  assert.equal(uncertainty.upper, 1);
  assert.match(uncertainty.method, /fewer than two independent 30-minute time blocks/);
});

test("shadow artifact reproduces held-out challenger metrics from fitted train/calibration windows", () => {
  const history = rows(420);
  const result = evaluateShadow(history);
  const artifact = buildShadowArtifact(history);
  assert.ok(Object.isFrozen(artifact));
  assert.ok(Object.isFrozen(artifact.logistic.weights));
  assert.equal(artifact.status, "shadow_only");
  assert.equal(artifact.provenance.evidenceStatus, "shadow_only_not_promoted");
  assert.equal(artifact.provenance.trainingRowCount, result.evaluated.split.training.count);
  assert.equal(artifact.provenance.calibrationRowCount, result.evaluated.split.calibration.count);
  assert.equal(artifact.provenance.trainingCutoffMs, Date.parse(result.evaluated.split.training.endUtc!));
  assert.equal(artifact.provenance.calibrationCutoffMs, Date.parse(result.evaluated.split.calibration.endUtc!));
  assert.match(artifact.provenance.trainingDataHash, /^[a-f\d]{64}$/);
  assert.match(artifact.provenance.calibrationDataHash, /^[a-f\d]{64}$/);
  assert.match(artifact.modelVersion, /^btc-shadow-logistic-v1-[a-f\d]{24}$/);
  assert.equal(artifact.modelVersion, buildShadowArtifact(history).modelVersion);

  const testRows = history.slice(Math.floor(history.length * 0.8));
  const challengerPredictions = predictShadowTestWindow(history);
  const predictions = testRows.map(row => inferBtcArtifact(artifact, {
    decisionTimeMs: row.observedMs,
    features: {
      indicativeUp: { value: row.indicativeUp, atMs: row.observedMs },
      remainingSeconds: { value: row.remainingSeconds, atMs: row.observedMs },
      comparisonReturn: { value: row.comparisonReturn ?? null, atMs: row.observedMs },
      realizedVolatility: { value: row.realizedVolatility ?? null, atMs: row.observedMs },
    },
  }).probabilityUp);
  assert.equal(predictions.length, challengerPredictions.length);
  predictions.forEach((probability, index) =>
    assert.ok(Math.abs(probability - challengerPredictions[index]) < 1e-14));
  const expected = result.challenger!.metrics;
  const brier = predictions.reduce((sum, probability, index) =>
    sum + (probability - (testRows[index].outcome === "UP" ? 1 : 0)) ** 2, 0) / predictions.length;
  const logLoss = predictions.reduce((sum, probability, index) => {
    const up = testRows[index].outcome === "UP";
    return sum - (up ? Math.log(Math.max(1e-12, probability)) :
      Math.log(Math.max(1e-12, 1 - probability)));
  }, 0) / predictions.length;
  assert.ok(Math.abs(brier - expected.brier) < 1e-14);
  assert.ok(Math.abs(logLoss - expected.logLoss) < 1e-14);
});

test("changing held-out labels cannot leak into the shadow artifact", () => {
  const history = rows(420);
  const testStart = Math.floor(history.length * 0.6) + Math.floor(history.length * 0.2);
  const changedTestLabels = history.map((row, index) => index >= testStart
    ? { ...row, outcome: row.outcome === "UP" ? "DOWN" as const : "UP" as const }
    : row);
  const baseline = buildShadowArtifact(history);
  const changed = buildShadowArtifact(changedTestLabels);
  assert.deepEqual(changed, baseline);

  const changedTrainingLabels = history.map((row, index) => index < Math.floor(history.length * 0.6)
    ? { ...row, outcome: row.outcome === "UP" ? "DOWN" as const : "UP" as const }
    : row);
  const trainedOnDifferentLabels = buildShadowArtifact(changedTrainingLabels);
  assert.notEqual(trainedOnDifferentLabels.provenance.trainingDataHash,
    baseline.provenance.trainingDataHash);
  assert.notDeepEqual(trainedOnDifferentLabels.logistic, baseline.logistic);
});

test("artifact inference keeps raw and calibrated probabilities distinct and rejects future feature times", () => {
  const history = rows(420);
  const artifact = buildShadowArtifact(history);
  const decisionTimeMs = Date.UTC(2025, 0, 3);
  const input = {
    decisionTimeMs,
    features: {
      indicativeUp: { value: 0.63, atMs: decisionTimeMs - 1_000 },
      remainingSeconds: { value: 38, atMs: decisionTimeMs },
      comparisonReturn: { value: null, atMs: decisionTimeMs - 5_000 },
      realizedVolatility: { value: 0.001, atMs: decisionTimeMs - 2_000 },
    },
  };
  const prediction = inferBtcArtifact(artifact, input);
  assert.ok(prediction.rawProbabilityUp >= 0 && prediction.rawProbabilityUp <= 1);
  assert.ok(prediction.probabilityUp >= 0 && prediction.probabilityUp <= 1);
  assert.equal(prediction.featureNames.length, artifact.featureSchema.length);

  assert.throws(() => inferBtcArtifact(artifact, {
    ...input,
    features: {
      ...input.features,
      realizedVolatility: { value: 0.001, atMs: decisionTimeMs + 1 },
    },
  }), /later than decision time/);
});