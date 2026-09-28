import test from "node:test";
import assert from "node:assert/strict";
import {
  computeAccuracyPeriod,
  computeAccuracyReport,
  csvCell,
  normalizeExportOptions,
  type AccuracyInputRow,
} from "../server/btc/reporting";

const hour = 3_600_000;
const now = 2_000_000_000_000;

function row(overrides: Partial<AccuracyInputRow> = {}): AccuracyInputRow {
  const expiryMs = overrides.expiryMs ?? now - hour;
  const predictionAtMs = overrides.predictionAtMs ?? expiryMs - 40_000;
  return {
    roundId: "0xround",
    expiryMs,
    outcome: "UP",
    quality: "VERIFIED_SETTLEMENT",
    settlementPresent: true,
    settlementVerifiedAtMs: overrides.settlementVerifiedAtMs ?? expiryMs + 8_000,
    predictionId: "prediction-1",
    predictionAtMs,
    capturedAtMs: overrides.capturedAtMs ?? predictionAtMs + 100,
    remainingSeconds: 40,
    marketUp: 0.7,
    forecastUp: null,
    modelVersion: "NO_PROMOTED_MODEL",
    action: "HOLD",
    scoreAtMs: overrides.scoreAtMs ?? expiryMs + 9_000,
    scoreKind: "ONCHAIN_INDICATIVE_BASELINE",
    snapshotInWindow: true,
    hasPreExpirySnapshot: true,
    modelStatus: null,
    modelCreatedAtMs: null,
    modelTrainedThroughMs: null,
    modelCalibratedAtMs: null,
    hasFrozenArtifact: false,
    artifactMatchesVersion: false,
    ...overrides,
  };
}

test("prospective metrics use persisted pre-expiry round forecasts and scores", () => {
  const rounds = [
    row({ roundId: "r1", predictionId: "p1", outcome: "UP", marketUp: 0.8,
      action: "UP", expiryMs: now - hour, predictionAtMs: now - hour - 40_000,
      settlementVerifiedAtMs: now - hour + 8_000, scoreAtMs: now - hour + 9_000 }),
    row({ roundId: "r2", predictionId: "p2", outcome: "DOWN", marketUp: 0.2,
      action: "DOWN", expiryMs: now - 2 * hour, predictionAtMs: now - 2 * hour - 40_000,
      settlementVerifiedAtMs: now - 2 * hour + 8_000, scoreAtMs: now - 2 * hour + 9_000 }),
    row({ roundId: "r3", predictionId: "p3", outcome: "UP", marketUp: 0.6,
      action: "HOLD", expiryMs: now - 3 * hour, predictionAtMs: now - 3 * hour - 40_000,
      settlementVerifiedAtMs: now - 3 * hour + 8_000, scoreAtMs: now - 3 * hour + 9_000 }),
  ];
  const report = computeAccuracyPeriod(rounds, "lifetime", now);
  assert.equal(report.evaluatedUniqueRounds, 3);
  assert.equal(report.rawMarket.evaluatedRounds, 3);
  assert.equal(report.rawMarket.directionalCalls, 2);
  assert.equal(report.rawMarket.directionalHits, 2);
  assert.equal(report.rawMarket.hitRate, 1);
  assert.equal(report.rawMarket.abstentions, 1);
  assert.equal(report.rawMarket.coverage, 2 / 3);
  assert.ok(Math.abs(report.rawMarket.brier! -
    (((0.2 ** 2) + (0.2 ** 2) + (0.4 ** 2)) / 3)) < 1e-12);
  assert.equal(report.calibratedMarketBaseline.available, false);
  assert.match(report.calibratedMarketBaseline.unavailableReason, /No separately frozen/);
});

test("a later scored primary with a probability supersedes an earlier null-probability primary", () => {
  const firstNull = row({
    roundId: "same-round",
    predictionId: "first-null",
    marketUp: null,
    predictionAtMs: now - hour - 40_000,
    capturedAtMs: now - hour - 39_900,
    scoreAtMs: null,
  });
  const laterScored = row({
    roundId: "same-round",
    predictionId: "later-valid",
    marketUp: 0.8,
    predictionAtMs: now - hour - 35_000,
    capturedAtMs: now - hour - 34_900,
    remainingSeconds: 35,
    scoreAtMs: now - hour + 9_000,
  });
  const report = computeAccuracyPeriod([firstNull, laterScored], "lifetime", now);
  assert.equal(report.evaluatedUniqueRounds, 1);
  assert.equal(report.rawMarket.evaluatedRounds, 1);
  assert.ok(Math.abs(report.rawMarket.brier! - 0.04) < 1e-12);
  assert.equal(report.lastIssuedAt, new Date(laterScored.predictionAtMs!).toISOString());
  assert.equal(report.exclusions.missing_probability, undefined);
});

test("shadow and champion forecasts require a matching frozen artifact issued beforehand", () => {
  const raw = row({
    modelVersion: "btc-shadow-logistic-v1-000000000000000000000000",
    modelStatus: "SHADOW",
    scoreKind: "SHADOW_FORECAST",
    forecastUp: 0.9,
    hasFrozenArtifact: true,
    artifactMatchesVersion: true,
    modelCreatedAtMs: now - 2 * hour,
    modelTrainedThroughMs: now - 3 * hour,
    modelCalibratedAtMs: now - 2 * hour,
  });
  const good = { ...raw, roundId: "eligible-shadow", predictionId: "eligible-prediction" };
  const trainedAfterIssue = { ...raw, roundId: "late-training", predictionId: "late-prediction",
    modelTrainedThroughMs: raw.predictionAtMs! + 1 };
  const badArtifact = { ...raw, roundId: "invalid-artifact", predictionId: "invalid-prediction",
    artifactMatchesVersion: false };
  const result = computeAccuracyPeriod([good, trainedAfterIssue, badArtifact],
    "lifetime", now);
  assert.equal(result.shadowChallenger.matchedRoundCount, 1);
  assert.equal(result.shadowChallenger.metrics.evaluatedRounds, 1);
  assert.equal(result.shadowChallenger.marketOnMatchedRounds.evaluatedRounds, 1);
  assert.ok(Math.abs(result.shadowChallenger.metrics.brier! - 0.01) < 1e-12);
  assert.equal(result.promotedChampion.matchedRoundCount, 0);
});

test("verified but unscored, missing quote, missed window, and absent observation have explicit exclusions", () => {
  const report = computeAccuracyPeriod([
    row({ roundId: "unscored", predictionId: "p0", scoreAtMs: null }),
    row({ roundId: "no-quote", predictionId: "p1", marketUp: null }),
    row({ roundId: "missed-window", predictionId: null,
      snapshotInWindow: false, hasPreExpirySnapshot: true }),
    row({ roundId: "no-observation", predictionId: null,
      snapshotInWindow: false, hasPreExpirySnapshot: false }),
    row({ roundId: "no-settlement", quality: "PENDING",
      settlementPresent: false, settlementVerifiedAtMs: null, outcome: null }),
  ], "lifetime", now);
  assert.equal(report.evaluatedUniqueRounds, 0);
  assert.equal(report.exclusions.verified_prediction_not_scored, 1);
  assert.equal(report.exclusions.missing_probability, 1);
  assert.equal(report.exclusions.missed_prediction_window, 1);
  assert.equal(report.exclusions.no_pre_expiry_observation, 1);
  assert.equal(report.exclusions.missing_settlement, 1);
});

test("only verified and scored round timestamps enter daily and seven-day windows", () => {
  const day = 86_400_000;
  const recent = row({ roundId: "today", predictionId: "pt",
    expiryMs: now - day / 2, predictionAtMs: now - day / 2 - 40_000,
    settlementVerifiedAtMs: now - day / 2 + 8_000, scoreAtMs: now - day / 2 + 9_000 });
  const old = row({ roundId: "old", predictionId: "po",
    expiryMs: now - 8 * day, predictionAtMs: now - 8 * day - 40_000,
    settlementVerifiedAtMs: now - 8 * day + 8_000, scoreAtMs: now - 8 * day + 9_000 });
  const report = computeAccuracyReport([recent, old], now);
  assert.equal(report.status, "OK");
  assert.equal(report.periods.daily.evaluatedUniqueRounds, 1);
  assert.equal(report.periods.sevenDay.evaluatedUniqueRounds, 1);
  assert.equal(report.periods.lifetime.evaluatedUniqueRounds, 2);
});

test("chronological trend groups by original issuance window and waits for scored labels", () => {
  const delayed = row({
    roundId: "delayed-label",
    predictionId: "delayed-prediction",
    expiryMs: now - 25 * hour,
    predictionAtMs: now - 25 * hour - 40_000,
    capturedAtMs: now - 25 * hour - 39_000,
    settlementVerifiedAtMs: now - hour,
    scoreAtMs: now - 30 * 60_000,
    marketUp: 0.8,
    outcome: "UP",
  });
  const notYetScored = row({
    roundId: "unavailable-label",
    predictionId: "pending-prediction",
    expiryMs: now - 3 * hour,
    predictionAtMs: now - 3 * hour - 40_000,
    capturedAtMs: now - 3 * hour - 39_000,
    settlementVerifiedAtMs: now - hour,
    scoreAtMs: now + hour,
  });
  const report = computeAccuracyReport([delayed, notYetScored], now);
  assert.equal(report.timeline.entries?.length, 7);
  assert.equal(report.timeline.entries?.[5].evaluatedUniqueRounds, 1);
  assert.ok(Math.abs(report.timeline.entries![5].rawMarketBrier! - 0.04) < 1e-12);
  assert.equal(report.timeline.entries?.[6].evaluatedUniqueRounds, 0);
  assert.equal(report.timeline.entries?.[6].rawMarketBrier, null);

  const incomplete = computeAccuracyReport([delayed], now, {
    dailyComplete: true, sevenDayComplete: false, lifetimeComplete: false,
  });
  assert.equal(incomplete.timeline.entries, null);
  assert.match(incomplete.timeline.unavailableReason!, /safe query window/);
});

test("lifetime truncation does not invalidate complete recent periods", () => {
  const recent = row({
    roundId: "recent",
    predictionId: "recent-prediction",
    expiryMs: now - hour,
    predictionAtMs: now - hour - 40_000,
    scoreAtMs: now - hour + 9_000,
  });
  const report = computeAccuracyReport([recent], now, {
    lifetimeComplete: false,
    dailyComplete: true,
    sevenDayComplete: true,
  });
  assert.equal(report.status, "PARTIAL");
  assert.equal(report.periods.daily?.evaluatedUniqueRounds, 1);
  assert.equal(report.periods.sevenDay?.evaluatedUniqueRounds, 1);
  assert.equal(report.periods.lifetime, null);
  assert.match(report.unavailablePeriods.lifetime!, /no partial metrics are published/);
});

test("time-bucketed calibration and clustered uncertainty disclose effective blocks", () => {
  const rows = Array.from({ length: 4 }, (_, index) => row({
    roundId: `round-${index}`, predictionId: `prediction-${index}`,
    expiryMs: now - (index + 1) * hour,
    predictionAtMs: now - (index + 1) * hour - (34 + index * 3) * 1_000,
    settlementVerifiedAtMs: now - (index + 1) * hour + 8_000,
    scoreAtMs: now - (index + 1) * hour + 9_000,
    remainingSeconds: 34 + index * 3,
    marketUp: index < 2 ? 0.25 : 0.75,
    outcome: index % 2 ? "DOWN" : "UP",
  }));
  const { rawMarket } = computeAccuracyPeriod(rows, "lifetime", now);
  assert.equal(rawMarket.calibrationByProbability.reduce((sum, bin) => sum + bin.count, 0), 4);
  assert.equal(rawMarket.byRemainingTime.reduce((sum, bucket) => sum + bucket.count, 0), 4);
  assert.equal(rawMarket.brierUncertainty.blockDurationMinutes, 30);
  assert.equal(rawMarket.brierUncertainty.effectiveSampleSize, 4);
  assert.equal(rawMarket.brierUncertainty.lower, null);
  assert.equal(rawMarket.calibrationByProbability[0].observedUpRate, null);
  assert.ok(rawMarket.byRemainingTime.every(bucket => bucket.observedUpRate === null));
});

test("adaptive calibration only reveals observed frequencies after enough round and block evidence", () => {
  const rows = Array.from({ length: 40 }, (_, index) => row({
    roundId: `bin-${index}`, predictionId: `forecast-${index}`,
    expiryMs: now - (index + 1) * hour,
    predictionAtMs: now - (index + 1) * hour - 40_000,
    settlementVerifiedAtMs: now - (index + 1) * hour + 8_000,
    scoreAtMs: now - (index + 1) * hour + 9_000,
    marketUp: index < 20 ? 0.3 : 0.7,
    outcome: index % 2 === 0 ? "UP" : "DOWN",
  }));
  const { rawMarket } = computeAccuracyPeriod(rows, "lifetime", now);
  assert.equal(rawMarket.calibrationByProbability.length, 2);
  assert.deepEqual(rawMarket.calibrationByProbability.map(bin => bin.count), [20, 20]);
  assert.deepEqual(rawMarket.calibrationByProbability.map(bin => bin.observedUpRate), [0.5, 0.5]);
  assert.equal(rawMarket.brierUncertainty.effectiveSampleSize, 40);
  assert.notEqual(rawMarket.brierUncertainty.lower, null);
});

test("export cursors are bounded, validated, and collection-bound", () => {
  assert.equal(normalizeExportOptions("predictions", { limit: 100 }).limit, 100);
  assert.throws(() => normalizeExportOptions("scores", { limit: 101 }), /limit must be/);
  assert.throws(() => normalizeExportOptions("outcomes", { limit: 0 }), /limit must be/);
  const cursor = Buffer.from(JSON.stringify({
    collection: "predictions", at: "2025-01-01T00:00:00.123456Z", id: "prediction-1",
  })).toString("base64url");
  assert.deepEqual(normalizeExportOptions("predictions", { cursor }).cursor,
    { collection: "predictions", at: "2025-01-01T00:00:00.123456Z", id: "prediction-1" });
  assert.throws(() => normalizeExportOptions("scores", { cursor }), /Invalid pagination cursor/);
  assert.throws(() => normalizeExportOptions("predictions", { cursor: "x".repeat(513) }),
    /Invalid pagination cursor/);
});

test("microsecond timestamp cursors preserve same-millisecond tuple boundaries and reject legacy cursors", () => {
  const base = "2025-01-01T00:00:00.";
  const rows = [
    { at: `${base}123789Z`, id: "z" },
    { at: `${base}123789Z`, id: "b" },
    { at: `${base}123789Z`, id: "a" },
    { at: `${base}123456Z`, id: "c" },
  ];
  assert.equal(Date.parse(rows[0].at), Date.parse(rows[3].at));
  const makeCursor = (at: string, id: string) => Buffer.from(JSON.stringify({
    collection: "predictions", at, id,
  })).toString("base64url");
  const firstBoundary = normalizeExportOptions("predictions", {
    cursor: makeCursor(rows[0].at, rows[0].id),
  }).cursor!;
  const nextPage = rows.filter(row => row.at < firstBoundary.at ||
    (row.at === firstBoundary.at && row.id < firstBoundary.id));
  assert.deepEqual(nextPage.map(({ at, id }) => ({ at, id })),
    rows.slice(1).map(({ at, id }) => ({ at, id })));
  assert.deepEqual(normalizeExportOptions("predictions", {
    cursor: makeCursor(rows[1].at, rows[1].id),
  }).cursor, { collection: "predictions", at: rows[1].at, id: "b" });

  const legacyCursor = Buffer.from(JSON.stringify({
    collection: "predictions", at: now, id: "prediction-1",
  })).toString("base64url");
  assert.throws(() => normalizeExportOptions("predictions", { cursor: legacyCursor }),
    /Invalid pagination cursor/);
});

test("CSV cells neutralize spreadsheet formulas and preserve quoting", () => {
  assert.equal(csvCell("=IMPORTXML(\"bad\")"), "\"'=IMPORTXML(\"\"bad\"\")\"");
  assert.equal(csvCell("safe, value"), "\"safe, value\"");
  assert.equal(csvCell(0.25), "0.25");
  assert.equal(csvCell(-0.25), "-0.25");
  assert.equal(csvCell(null), "");
});