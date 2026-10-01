import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSettlementEvidence,
  createCoverageSummary,
  expectedRoundStarts,
  fullWindowValidity,
  buildMonthlyProjection,
  metricsWindowIsFullDay,
} from "./cloudflare-waterx-report.mjs";

const START_MS = 1_790_805_764_752;
const DUE_MS = 1_790_892_164_752;
const MARKET_5M = "9129d50d-6e9c-4c1d-b4af-a76b5993bf85";
const MARKET_15M = "3bad357c-3e20-4533-b8c4-e4938dfe30b6";

function coverageEvidence(interval, {
  snapshots = true,
  nullRoundMetrics = false,
  initialHadGap = 0,
  initialFreshness = 1_000,
  terminalHadGap = 0,
  terminalFreshness = 1_000,
  terminalSuccessAt = null,
} = {}) {
  const step = interval * 60_000;
  const initialStart = Math.floor(START_MS / step) * step;
  const marketId = interval === 5 ? MARKET_5M : MARKET_15M;
  const evidence = { coverage: [], firstRounds: [], snapshots: [] };
  const addRound = (start, index, options = {}) => {
    const roundId = `${String(interval).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const end = start + step;
    const initial = options.initial === true;
    const firstObservedAtMs = initial
      ? START_MS + 10_000 : start + 10_000;
    const firstSuccessAtMs = options.firstSuccessAtMs ?? firstObservedAtMs;
    const nullMetrics = nullRoundMetrics;
    evidence.coverage.push({
      intervalMinutes: interval,
      expectedStartMs: start,
      expectedRoundId: roundId,
      firstSuccessAtMs: nullMetrics ? null : firstSuccessAtMs,
      maxFreshnessAgeMs: nullMetrics ? null : options.freshness ?? 1_000,
      maxScheduledDelayMs: nullMetrics ? null : 0,
      hadGap: nullMetrics ? null : options.hadGap ?? 0,
    });
    evidence.firstRounds.push({
      intervalMinutes: interval,
      roundId,
      marketId,
      startsAtMs: start,
      endsAtMs: end,
      firstObservedAtMs,
    });
    if (snapshots && options.includeSnapshot !== false) {
      const observedAtMs = initial ? START_MS + 20_000 : start + 20_000;
      if (observedAtMs < DUE_MS) evidence.snapshots.push({
        intervalMinutes: interval,
        roundId,
        startsAtMs: start,
        endsAtMs: end,
        observedAtMs,
        observedBucketMs: Math.floor(observedAtMs / 30_000) * 30_000,
        source: "WaterX",
        referenceConfirmed: 1,
      });
    }
    return roundId;
  };
  addRound(initialStart, 1, {
    initial: true,
    hadGap: initialHadGap,
    freshness: initialFreshness,
  });
  const starts = expectedRoundStarts(START_MS, DUE_MS, interval);
  starts.forEach((start, index) => {
    const terminal = index === starts.length - 1;
    addRound(start, index + 2, {
      hadGap: terminal ? terminalHadGap : 0,
      freshness: terminal ? terminalFreshness : 1_000,
      ...(terminal && terminalSuccessAt !== null
        ? { firstSuccessAtMs: terminalSuccessAt }
        : {}),
    });
  });
  return evidence;
}

function currentFreshness(timeWindow, lagSeconds = 60, staleLimitSeconds = 7_200) {
  const endMs = Date.parse(timeWindow.end);
  const latest = new Date(endMs - lagSeconds * 1_000).toISOString();
  return {
    latestDataTimestamp: latest,
    lagSeconds,
    referenceTime: timeWindow.end,
    referenceBasis: "requested_analytics_window_end",
    staleLimitSeconds,
  };
}

test("fixed first-day denominators include starts at-or-after start and before due", () => {
  const five = expectedRoundStarts(START_MS, DUE_MS, 5);
  const fifteen = expectedRoundStarts(START_MS, DUE_MS, 15);
  assert.equal(five.length, 288);
  assert.equal(fifteen.length, 96);
  assert.ok(five[0] >= START_MS);
  assert.ok(five.at(-1) < DUE_MS);
  assert.ok(fifteen[0] >= START_MS);
  assert.ok(fifteen.at(-1) < DUE_MS);
});

test("complete coverage-row counts with null freshness, had-gap, and no snapshots remain incomplete", () => {
  const summaries = [5, 15].map(interval => createCoverageSummary(interval,
    coverageEvidence(interval, {
      snapshots: false,
      nullRoundMetrics: true,
    })));
  const assessment = fullWindowValidity(DUE_MS + 1, false,
    { startMatchesExpected: true }, summaries);
  assert.deepEqual(summaries.map(item => item.fixedFirst24Hours.coverageRows),
    [288, 96]);
  assert.ok(summaries.every(item => item.fixedFirst24Hours.accountingComplete));
  assert.ok(summaries.every(item => item.fixedFirst24Hours.observations === 0));
  assert.ok(summaries.every(item =>
    item.fixedFirst24Hours.longestNoObservationGap.milliseconds ===
      DUE_MS - START_MS));
  assert.ok(summaries.every(item =>
    item.fixedFirst24Hours.gapProofStatus ===
      "not_measured_window_gap_proof_incomplete"));
  assert.equal(assessment.full24hPassClaimed, false);
  assert.equal(assessment.status, "not_measured_window_gap_proof_incomplete");
});

test("fully bounded fixed-window evidence can pass only with per-round and initial-boundary proof", () => {
  const summaries = [5, 15].map(interval => createCoverageSummary(interval,
    coverageEvidence(interval)));
  const assessment = fullWindowValidity(DUE_MS + 1, false,
    { startMatchesExpected: true }, summaries);
  assert.equal(summaries[0].fixedFirst24Hours.gapProofStatus,
    "verified_no_gaps_within_window");
  assert.equal(summaries[1].fixedFirst24Hours.gapProofStatus,
    "verified_no_gaps_within_window");
  assert.equal(assessment.status, "verified_gap_free_window_accounted");
  assert.equal(assessment.full24hPassClaimed, true);
});

test("snapshot gaps include window tails and initial intersecting-round samples", () => {
  const evidence = coverageEvidence(5);
  const summary = createCoverageSummary(5, evidence).fixedFirst24Hours;
  const times = evidence.snapshots.map(row => row.observedAtMs)
    .filter(time => time >= START_MS && time < DUE_MS).sort((a, b) => a - b);
  const exactGap = Math.max(
    times[0] - START_MS,
    ...times.slice(1).map((time, index) => time - times[index]),
    DUE_MS - times.at(-1),
  );
  assert.equal(summary.longestNoObservationGap.milliseconds, exactGap);
  assert.ok(exactGap > 0 && exactGap <= 5 * 60_000);
  assert.equal(summary.actualCoverageFreshness.gapProofStatus,
    "verified_no_gaps_within_window");
});

test("ambiguous initial and terminal whole-round gaps remain unproved, not false failures", () => {
  const initial = createCoverageSummary(5, coverageEvidence(5, {
    initialHadGap: 1,
    initialFreshness: 300_000,
  })).fixedFirst24Hours;
  assert.equal(initial.gapProofStatus,
    "not_measured_window_gap_proof_incomplete");
  assert.equal(initial.actualCoverageFreshness.initialIntersectingRound.gapProofStatus,
    "not_measured_initial_round_statistics_may_include_pre_window_lateness");

  const terminal = createCoverageSummary(5, coverageEvidence(5, {
    terminalHadGap: 1,
    terminalFreshness: 300_000,
  })).fixedFirst24Hours;
  assert.equal(terminal.gapProofStatus,
    "not_measured_window_gap_proof_incomplete");
  assert.equal(terminal.actualCoverageFreshness.gapProofByExpectedRound.at(-1).status,
    "not_measured_boundary_or_round_stat_could_include_outside_window");
});

test("terminal first success at due is excluded from fixed-window successful rounds", () => {
  const report = createCoverageSummary(5, coverageEvidence(5, {
    terminalSuccessAt: DUE_MS,
  }));
  const summary = report.fixedFirst24Hours;
  const terminal = report.trialBoundaryPartialRounds
    .fixedFirst24HourWindowBoundaries.terminalIntersectingRound;
  assert.equal(summary.coverageSuccessfulRounds, 287);
  assert.equal(summary.actualCoverageFreshness.gapProofStatus,
    "not_measured_window_gap_proof_incomplete");
  assert.equal(summary.sourceIdentityChecks.coverageSuccessAtOrAfterWindowEnd, 1);
  assert.equal(terminal.coverageSuccessful, false);
  assert.equal(terminal.coverageFirstSuccessWithinAnalysisWindow, false);
  assert.equal(summary.gapProofStatus,
    "not_measured_window_gap_proof_incomplete");
});

test("settlement attempts collapse to distinct labels and explicit contradictions are excluded", () => {
  const roundId = "11111111-2222-4333-8444-555555555555";
  const roundEndMs = START_MS + 300_000;
  const firstRounds = [{
    intervalMinutes: 5,
    roundId,
    marketId: MARKET_5M,
    startsAtMs: START_MS,
    endsAtMs: roundEndMs,
  }];
  const base = {
    intervalMinutes: 5,
    expectedRoundId: roundId,
    expectedClosingEpoch: roundEndMs / 1000,
    expectedRoundEndMs: roundEndMs,
    expectedMarketId: MARKET_5M,
    providerRoundId: roundId,
    providerClosingEpoch: roundEndMs / 1000,
    providerStatus: "resolved",
    providerSettledAtEpoch: roundEndMs / 1000 + 20,
    providerAnchorPrice: 100,
    providerAnchorConfirmed: 1,
    source: "WaterX",
  };
  const rows = [
    {
      ...base,
      observedAtMs: roundEndMs + 60_000,
      probeBucketMs: roundEndMs + 60_000,
      providerOutcome: "up",
      providerSettlePrice: 101,
      verdict: "VERIFIED",
    },
    {
      ...base,
      observedAtMs: roundEndMs + 120_000,
      probeBucketMs: roundEndMs + 120_000,
      providerOutcome: "down",
      providerSettlePrice: 99,
      verdict: "WITHHELD",
      reason: "contradictory probe",
    },
  ];
  const report = analyzeSettlementEvidence(rows, firstRounds);
  assert.equal(report.observedSettlementAttempts, 2);
  assert.equal(report.workerVerifiedDistinctOutcomeLabels, 1);
  assert.equal(report.conflictFreeWorkerVerifiedDistinctOutcomeLabels, 0);
  assert.equal(report.independentlyAuditCompleteDistinctLabels, 0);
  assert.equal(report.conflictCount, 1);
  assert.equal(
    report.explicitlyResolvedContradictoryRounds[0].conflict,
    "contradictory_resolved_outcomes",
  );
  assert.equal(
    report.latestEvidenceByInterval[5].withheldReasonCounts["contradictory probe"],
    1,
  );
});

test("missing provider market identity can never count as independently audit-complete", () => {
  const result = analyzeSettlementEvidence([], []);
  assert.equal(result.workerVerifiedDistinctOutcomeLabels, 0);
  assert.equal(result.independentlyAuditCompleteDistinctLabels, 0);
  assert.match(result.independentlyAuditCompleteReason, /market identity\/raw response/);
});

test("explicitly resolved settlement-price revisions are conflicts even when outcomes agree", () => {
  const roundId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const roundEndMs = START_MS + 600_000;
  const base = {
    intervalMinutes: 5,
    expectedRoundId: roundId,
    expectedClosingEpoch: roundEndMs / 1000,
    expectedRoundEndMs: roundEndMs,
    expectedMarketId: MARKET_5M,
    providerRoundId: roundId,
    providerClosingEpoch: roundEndMs / 1000,
    providerStatus: "resolved",
    providerOutcome: "up",
    providerSettledAtEpoch: roundEndMs / 1000 + 20,
    providerAnchorPrice: 100,
    providerAnchorConfirmed: 1,
    source: "WaterX",
  };
  const report = analyzeSettlementEvidence([
    { ...base, observedAtMs: 1, probeBucketMs: 1,
      providerSettlePrice: 101, verdict: "VERIFIED" },
    { ...base, observedAtMs: 2, probeBucketMs: 2,
      providerSettlePrice: 102, verdict: "WITHHELD" },
  ], [{
    intervalMinutes: 5,
    roundId,
    marketId: MARKET_5M,
    startsAtMs: roundEndMs - 300_000,
    endsAtMs: roundEndMs,
  }]);
  assert.equal(report.conflictCount, 1);
  assert.equal(
    report.explicitlyResolvedContradictoryRounds[0].conflict,
    "contradictory_resolved_settlement_prices",
  );
  assert.equal(report.conflictFreeWorkerVerifiedDistinctOutcomeLabels, 0);
});

test("a Worker-VERIFIED outcome inconsistent with its anchor is excluded from audit-eligible labels", () => {
  const roundId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const roundEndMs = START_MS + 300_000;
  const row = {
    intervalMinutes: 5,
    expectedRoundId: roundId,
    expectedClosingEpoch: roundEndMs / 1000,
    expectedRoundEndMs: roundEndMs,
    expectedMarketId: MARKET_5M,
    providerRoundId: roundId,
    providerClosingEpoch: roundEndMs / 1000,
    providerStatus: "resolved",
    providerOutcome: "up",
    providerSettledAtEpoch: roundEndMs / 1000 + 20,
    providerSettlePrice: 99,
    providerAnchorPrice: 100,
    providerAnchorConfirmed: 1,
    observedAtMs: roundEndMs + 60_000,
    probeBucketMs: roundEndMs + 60_000,
    verdict: "VERIFIED",
    source: "WaterX",
  };
  const report = analyzeSettlementEvidence([row], [{
    intervalMinutes: 5,
    roundId,
    marketId: MARKET_5M,
    startsAtMs: roundEndMs - 300_000,
    endsAtMs: roundEndMs,
  }]);
  assert.equal(report.workerVerifiedDistinctOutcomeLabels, 1);
  assert.equal(report.auditedEligibleWorkerVerifiedDistinctOutcomeLabels, 0);
  assert.equal(report.providerEvidenceConsistencyFailureCount, 1);
  assert.equal(report.status, "failed");
});

test("unresolved-to-resolved settlement progress is not treated as a dispute", () => {
  const roundId = "cccccccc-dddd-4eee-8fff-000000000001";
  const roundEndMs = START_MS + 300_000;
  const base = {
    intervalMinutes: 5,
    expectedRoundId: roundId,
    expectedClosingEpoch: roundEndMs / 1000,
    expectedRoundEndMs: roundEndMs,
    expectedMarketId: MARKET_5M,
    source: "WaterX",
  };
  const report = analyzeSettlementEvidence([
    {
      ...base,
      providerStatus: "unresolved",
      providerRoundId: null,
      providerClosingEpoch: null,
      providerOutcome: null,
      providerSettledAtEpoch: null,
      providerSettlePrice: null,
      providerAnchorPrice: null,
      providerAnchorConfirmed: 0,
      observedAtMs: roundEndMs + 30_000,
      probeBucketMs: roundEndMs + 30_000,
      verdict: "WITHHELD",
    },
    {
      ...base,
      providerStatus: "resolved",
      providerRoundId: roundId,
      providerClosingEpoch: roundEndMs / 1000,
      providerOutcome: "up",
      providerSettledAtEpoch: roundEndMs / 1000 + 20,
      providerSettlePrice: 101,
      providerAnchorPrice: 100,
      providerAnchorConfirmed: 1,
      observedAtMs: roundEndMs + 60_000,
      probeBucketMs: roundEndMs + 60_000,
      verdict: "VERIFIED",
    },
  ], [{
    intervalMinutes: 5,
    roundId,
    marketId: MARKET_5M,
    startsAtMs: roundEndMs - 300_000,
    endsAtMs: roundEndMs,
  }]);
  assert.equal(report.conflictCount, 0);
  assert.equal(report.providerEvidenceConsistencyFailureCount, 0);
  assert.equal(report.auditedEligibleWorkerVerifiedDistinctOutcomeLabels, 1);
});

test("resolved evidence conflicts include revised anchors, settlement times, and post-resolution statuses", () => {
  const roundId = "dddddddd-eeee-4fff-8000-000000000001";
  const roundEndMs = START_MS + 300_000;
  const base = {
    intervalMinutes: 5,
    expectedRoundId: roundId,
    expectedClosingEpoch: roundEndMs / 1000,
    expectedRoundEndMs: roundEndMs,
    expectedMarketId: MARKET_5M,
    providerRoundId: roundId,
    providerClosingEpoch: roundEndMs / 1000,
    providerStatus: "resolved",
    providerOutcome: "up",
    providerSettledAtEpoch: roundEndMs / 1000 + 20,
    providerSettlePrice: 102,
    providerAnchorPrice: 100,
    providerAnchorConfirmed: 1,
    source: "WaterX",
    verdict: "VERIFIED",
  };
  const cases = [
    {
      name: "anchor revision",
      later: { providerAnchorPrice: 101 },
      reason: "contradictory_resolved_anchor_prices",
    },
    {
      name: "settlement-time revision",
      later: { providerSettledAtEpoch: roundEndMs / 1000 + 21 },
      reason: "contradictory_resolved_settlement_times",
    },
    {
      name: "post-resolution status revision",
      later: { providerStatus: "disputed", verdict: "WITHHELD" },
      reason: "provider_status_changed_after_resolution",
    },
  ];
  for (const item of cases) {
    const report = analyzeSettlementEvidence([
      {
        ...base,
        observedAtMs: roundEndMs + 60_000,
        probeBucketMs: roundEndMs + 60_000,
      },
      {
        ...base,
        ...item.later,
        observedAtMs: roundEndMs + 120_000,
        probeBucketMs: roundEndMs + 120_000,
      },
    ], [{
      intervalMinutes: 5,
      roundId,
      marketId: MARKET_5M,
      startsAtMs: roundEndMs - 300_000,
      endsAtMs: roundEndMs,
    }]);
    assert.equal(report.conflictCount, 1, item.name);
    assert.ok(report.explicitlyResolvedContradictoryRounds[0].conflictReasons
      .includes(item.reason), item.name);
    assert.equal(report.auditedEligibleWorkerVerifiedDistinctOutcomeLabels, 0);
    assert.equal(report.status, "failed");
  }
});

test("full-day assessment fails closed when private evidence has zero or one interval", () => {
  const now = DUE_MS + 1;
  const health = { startMatchesExpected: true };
  const noIntervals = fullWindowValidity(now, false, health, []);
  assert.equal(noIntervals.status,
    "failed_private_evidence_intervals_missing_or_duplicated");
  assert.equal(noIntervals.full24hPassClaimed, false);

  const oneInterval = fullWindowValidity(now, false, health, [{
    intervalMinutes: 5,
    fixedFirst24Hours: {
      accountingComplete: true,
      identityVerified: true,
      requiredRoundStarts: 288,
      coverageRows: 288,
      missingRoundStartCount: 0,
      coverageSuccessfulRounds: 288,
      actualCoverageFreshness: { hadGapRounds: 0 },
    },
  }]);
  assert.equal(oneInterval.status,
    "failed_private_evidence_intervals_missing_or_duplicated");
  assert.equal(oneInterval.full24hPassClaimed, false);
});

test("monthly projection rejects a same-duration but wrong fixed first-day metrics window", () => {
  const expectedStart = new Date(START_MS).toISOString();
  const expectedEnd = new Date(DUE_MS).toISOString();
  const metrics = {
    timeWindow: {
      start: new Date(START_MS + 1_000).toISOString(),
      end: new Date(DUE_MS + 1_000).toISOString(),
      durationSeconds: 86_400,
    },
    datasets: {
      workerCpuAndRequests: {
        availability: "available",
        possiblyTruncated: false,
        selectedFields: { sum: ["requests"] },
        rows: [{ sum: { requests: 12 } }],
      },
    },
  };
  assert.equal(metricsWindowIsFullDay(metrics, START_MS, DUE_MS), false);
  const projection = buildMonthlyProjection(metrics, true, {
    startMs: START_MS,
    endMs: DUE_MS,
  });
  assert.equal(projection.projectionEligible, false);
  assert.ok(projection.projectionBlockedReasons.includes(
    "metrics_window_does_not_exactly_match_fixed_first_24_hours",
  ));
  assert.equal(projection.monthlyProjection["30DayMonth"].projectedTotal.workerRequests, null);
  assert.equal(projection.monthlyProjection["31DayMonth"].projectedTotal.workerRequests, null);
});

test("partial datasets contribute only selected complete fields and exclude lagged fields", () => {
  const expectedWindow = { startMs: START_MS, endMs: DUE_MS };
  const timeWindow = {
    start: new Date(START_MS).toISOString(),
    end: new Date(DUE_MS).toISOString(),
    durationSeconds: 86_400,
  };
  const knownPartial = buildMonthlyProjection({
    timeWindow,
    datasets: {
      workerCpuAndRequests: {
        availability: "partial",
        possiblyTruncated: false,
        selectedFields: { sum: ["requests"] },
        freshness: currentFreshness(timeWindow),
        rows: [{ sum: { requests: 12 } }],
      },
    },
  }, true, expectedWindow);
  assert.equal(knownPartial.projectionEligible, true);
  assert.equal(knownPartial.monthlyProjection["30DayMonth"].projectedTotal.workerRequests, 360);
  assert.equal(knownPartial.monthlyProjection["30DayMonth"].projectedTotal.d1RowsRead, null);

  const lagged = buildMonthlyProjection({
    timeWindow,
    datasets: {
      workerCpuAndRequests: {
        availability: "partial",
        possiblyTruncated: false,
        selectedFields: { sum: ["requests"] },
        freshness: currentFreshness(timeWindow, 7_201, 7_200),
        rows: [{ sum: { requests: 12 } }],
      },
    },
  }, true, expectedWindow);
  assert.equal(lagged.projectionEligible, false);
  assert.equal(lagged.monthlyProjection["30DayMonth"].projectedTotal.workerRequests, null);
});

test("partial selected fields with unknown date-only freshness cannot project monthly usage", () => {
  const timeWindow = {
    start: new Date(START_MS).toISOString(),
    end: new Date(DUE_MS).toISOString(),
    durationSeconds: 86_400,
  };
  const projection = buildMonthlyProjection({
    timeWindow,
    datasets: {
      workerCpuAndRequests: {
        availability: "partial",
        possiblyTruncated: false,
        selectedFields: { sum: ["requests"] },
        freshness: {
          latestDataTimestamp: null,
          lagSeconds: null,
          referenceTime: timeWindow.end,
          referenceBasis: "requested_analytics_window_end",
          staleLimitSeconds: 7_200,
          note: "Dataset is grouped by date.",
        },
        rows: [{ sum: { requests: 12 } }],
      },
    },
  }, true, { startMs: START_MS, endMs: DUE_MS });
  assert.equal(projection.projectionEligible, false);
  assert.equal(projection.actualDailyUsage.workerRequests, null);
  assert.equal(projection.monthlyProjection["30DayMonth"].projectedTotal.workerRequests, null);
  assert.equal(projection.cloudflareDatasets.workerCpuAndRequests.status, "not_measured");
  assert.equal(
    projection.cloudflareDatasets.workerCpuAndRequests.freshnessVerifiedWithinLimit,
    false,
  );
});

test("incomplete fixed evidence blocks resource and storage month forecasts", () => {
  const projection = buildMonthlyProjection({
    timeWindow: {
      start: new Date(START_MS).toISOString(),
      end: new Date(DUE_MS).toISOString(),
      durationSeconds: 86_400,
    },
    datasets: {
      workerCpuAndRequests: {
        availability: "available",
        possiblyTruncated: false,
        selectedFields: { sum: ["requests"] },
        rows: [{ sum: { requests: 12 } }],
      },
      d1Storage: {
        availability: "available",
        possiblyTruncated: false,
        selectedFields: { max: ["databaseSizeBytes"] },
        rows: [
          { dimensions: { datetimeHour: new Date(START_MS).toISOString() },
            max: { databaseSizeBytes: 100 } },
          { dimensions: { datetimeHour: new Date(START_MS + 3_600_000).toISOString() },
            max: { databaseSizeBytes: 200 } },
        ],
      },
    },
  }, false, { startMs: START_MS, endMs: DUE_MS });
  assert.equal(projection.projectionEligible, false);
  assert.equal(projection.monthlyProjection["30DayMonth"].projectedTotal.workerRequests, null);
  assert.equal(projection.dailyQuotaChecks.d1Storage.monthProjection.after30DaysBytes, null);
});