const START_MS = 1_790_805_764_752;
const DUE_MS = 1_790_892_164_752;
const STOP_MS = 1_790_899_364_752;
const MARKET_IDS = {
  5: "9129d50d-6e9c-4c1d-b4af-a76b5993bf85",
  15: "3bad357c-3e20-4533-b8c4-e4938dfe30b6",
};

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function floorTo(value, step) {
  return Math.floor(value / step) * step;
}

function ceilTo(value, step) {
  return Math.ceil(value / step) * step;
}

export function expectedRoundStarts(startMs, endMs, intervalMinutes) {
  const step = intervalMinutes * 60_000;
  const starts = [];
  for (let start = ceilTo(startMs, step); start < endMs; start += step)
    starts.push(start);
  return starts;
}

function byInterval(rows, interval) {
  return rows.filter(row => Number(row.intervalMinutes) === interval);
}

function uniqueCount(values) {
  return new Set(values).size;
}

export function createCoverageSummary(interval, evidence) {
  const step = interval * 60_000;
  const requiredStarts = expectedRoundStarts(START_MS, DUE_MS, interval);
  const allCoverage = byInterval(evidence.coverage, interval);
  const firsts = byInterval(evidence.firstRounds, interval);
  const allSnapshots = byInterval(evidence.snapshots, interval);
  const fixedSnapshots = allSnapshots.filter(row =>
    Number(row.observedAtMs) >= START_MS && Number(row.observedAtMs) < DUE_MS);
  const fixedCoverage = allCoverage.filter(row =>
    Number(row.expectedStartMs) >= START_MS && Number(row.expectedStartMs) < DUE_MS);
  const firstByKey = new Map(firsts.map(row => [`${interval}:${row.roundId}`, row]));
  const firstByStart = new Map();
  for (const row of firsts) {
    const key = Number(row.startsAtMs);
    if (!firstByStart.has(key)) firstByStart.set(key, []);
    firstByStart.get(key).push(row);
  }
  const coverageByStart = new Map();
  for (const row of fixedCoverage) {
    const key = Number(row.expectedStartMs);
    if (!coverageByStart.has(key)) coverageByStart.set(key, []);
    coverageByStart.get(key).push(row);
  }
  const snapshotsByRound = new Map();
  for (const row of fixedSnapshots) {
    const key = `${interval}:${row.roundId}`;
    if (!snapshotsByRound.has(key)) snapshotsByRound.set(key, []);
    snapshotsByRound.get(key).push(row);
  }

  const missingStarts = [];
  let coverageFirstSuccess = 0;
  let roundsWithSnapshot = 0;
  let roundsWithAnyObservedRecord = 0;
  let expectedRoundUuidJoined = 0;
  let coverageIdentityMismatches = 0;
  let expectedStartGridMismatches = 0;
  let firstMarketIdMismatches = 0;
  let firstCadenceMismatches = 0;
  let firstObservationOutsideRound = 0;
  let invalidRoundUuidCount = 0;
  let coverageSuccessOutsideRound = 0;
  let coverageSuccessAtOrAfterWindowEnd = 0;
  let conflictingRoundIdsAtStart = 0;
  let expectedIdDoesNotMatchFirstAtStart = 0;
  let maxFreshnessAgeMs = null;
  let maxScheduledDelayMs = null;
  let coverageHadGapRounds = 0;
  let coverageFreshnessRows = 0;
  let coverageRowsWithKnownGapFlag = 0;
  let upProbabilityMissing = 0;
  let downProbabilityMissing = 0;
  let upOddsMissing = 0;
  let downOddsMissing = 0;
  let referenceMissing = 0;
  let referenceUnconfirmed = 0;
  const duplicateSnapshotKeys = new Set();
  let snapshotRoundJoinMissing = 0;
  let snapshotIdentityMismatches = 0;
  let snapshotOutsideRound = 0;
  let snapshotBucketMismatches = 0;
  const roundGapEvidence = [];
  const snapshotCountByStart = new Map();

  for (const start of requiredStarts) {
    const coverageRows = coverageByStart.get(start) ?? [];
    const coverage = coverageRows[0];
    const roundFirstsAtStart = firstByStart.get(start) ?? [];
    if (coverageRows.length > 1 || roundFirstsAtStart.length > 1)
      conflictingRoundIdsAtStart++;
    if (start % step !== 0) expectedStartGridMismatches++;
    const expectedId = coverage?.expectedRoundId ?? null;
    const first = expectedId === null ? null : firstByKey.get(`${interval}:${expectedId}`);
    const rows = expectedId === null ? [] :
      snapshotsByRound.get(`${interval}:${expectedId}`) ?? [];
    const hasFirst = Boolean(first);
    const firstSuccessAt = numeric(coverage?.firstSuccessAtMs);
    const successWithinWindow = firstSuccessAt !== null &&
      firstSuccessAt >= start && firstSuccessAt < Math.min(start + step, DUE_MS);
    const hasObservation = rows.length > 0 || hasFirst || successWithinWindow;
    if (!hasObservation) missingStarts.push(start);
    if (rows.length) roundsWithSnapshot++;
    if (hasObservation) roundsWithAnyObservedRecord++;
    if (expectedId !== null && first) expectedRoundUuidJoined++;
    if (expectedId !== null && !first) coverageIdentityMismatches++;
    if (successWithinWindow) {
      coverageFirstSuccess++;
    }
    if (coverage?.firstSuccessAtMs != null &&
        (firstSuccessAt === null || firstSuccessAt < start ||
         firstSuccessAt >= start + step))
      coverageSuccessOutsideRound++;
    if (firstSuccessAt !== null && firstSuccessAt >= DUE_MS)
      coverageSuccessAtOrAfterWindowEnd++;
    if (coverage?.hadGap != null && Number(coverage.hadGap) !== 0)
      coverageHadGapRounds++;
    const freshness = numeric(coverage?.maxFreshnessAgeMs);
    const scheduledDelay = numeric(coverage?.maxScheduledDelayMs);
    const hadGap = coverage?.hadGap == null ? null : numeric(coverage.hadGap);
    if (hadGap === 0 || hadGap === 1) coverageRowsWithKnownGapFlag++;
    if (freshness !== null) {
      coverageFreshnessRows++;
      maxFreshnessAgeMs = maxFreshnessAgeMs === null
        ? freshness : Math.max(maxFreshnessAgeMs, freshness);
    }
    if (scheduledDelay !== null) {
      maxScheduledDelayMs = maxScheduledDelayMs === null
        ? scheduledDelay : Math.max(maxScheduledDelayMs, scheduledDelay);
    }
    if (expectedId !== null && roundFirstsAtStart.length === 1 &&
        roundFirstsAtStart[0].roundId !== expectedId)
      expectedIdDoesNotMatchFirstAtStart++;
    if (first) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(String(first.roundId))) invalidRoundUuidCount++;
      if (first.marketId !== MARKET_IDS[interval]) firstMarketIdMismatches++;
      const startsAt = numeric(first.startsAtMs);
      const endsAt = numeric(first.endsAtMs);
      if (startsAt !== start || endsAt !== start + step ||
          endsAt - startsAt !== step) firstCadenceMismatches++;
      const observedAt = numeric(first.firstObservedAtMs);
      if (observedAt === null || startsAt === null || endsAt === null ||
          observedAt < startsAt || observedAt >= endsAt)
        firstObservationOutsideRound++;
    }
    snapshotCountByStart.set(start, rows.length);
    const freshnessThresholdMs = interval === 5 ? 15_000 : 30_000;
    const whollyInsideWindow = start + step <= DUE_MS;
    let gapProofStatus = "not_measured_missing_round_evidence";
    if (coverageRows.length === 1 && successWithinWindow && rows.length > 0 &&
        freshness !== null && freshness >= 0 &&
        scheduledDelay !== null && scheduledDelay >= 0 &&
        (hadGap === 0 || hadGap === 1)) {
      if (whollyInsideWindow &&
          (hadGap === 1 || freshness > freshnessThresholdMs)) {
        gapProofStatus = "failed_gap_detected_inside_full_round";
      } else if (hadGap === 1 || freshness > freshnessThresholdMs) {
        gapProofStatus = "not_measured_boundary_or_round_stat_could_include_outside_window";
      } else {
        gapProofStatus = "verified_no_gap_upper_bound_for_round";
      }
    }
    roundGapEvidence.push({
      expectedRoundStart: iso(start),
      intervalFullyInsideWindow: whollyInsideWindow,
      inWindowFirstSuccess: successWithinWindow,
      inWindowSnapshotCount: rows.length,
      maxFreshnessAgeMs: freshness,
      maxScheduledDelayMs: scheduledDelay,
      hadGap,
      freshnessThresholdMs,
      status: gapProofStatus,
    });
  }

  const fieldNames = [
    ["upProbabilityCents", "upProbabilityMissing"],
    ["downProbabilityCents", "downProbabilityMissing"],
    ["upOddsCents", "upOddsMissing"],
    ["downOddsCents", "downOddsMissing"],
    ["referencePrice", "referenceMissing"],
  ];
  for (const row of fixedSnapshots) {
    const round = firstByKey.get(`${interval}:${row.roundId}`);
    if (!round) snapshotRoundJoinMissing++;
    if (round && (
      Number(row.startsAtMs) !== Number(round.startsAtMs) ||
      Number(row.endsAtMs) !== Number(round.endsAtMs) ||
      row.source !== "WaterX" ||
      round.marketId !== MARKET_IDS[interval]
    )) snapshotIdentityMismatches++;
    const observedAt = numeric(row.observedAtMs);
    const startsAt = numeric(row.startsAtMs);
    const endsAt = numeric(row.endsAtMs);
    if (observedAt === null || startsAt === null || endsAt === null ||
        observedAt < startsAt || observedAt >= endsAt)
      snapshotOutsideRound++;
    if (numeric(row.observedBucketMs) !==
        (observedAt === null ? null : floorTo(observedAt, 30_000)))
      snapshotBucketMismatches++;
    const duplicateKey = `${interval}:${row.roundId}:${row.observedBucketMs}`;
    if (duplicateSnapshotKeys.has(duplicateKey))
      duplicateSnapshotKeys.add(`${duplicateKey}:duplicate`);
    else duplicateSnapshotKeys.add(duplicateKey);
    for (const [field, missingKey] of fieldNames) {
      if (row[field] === null || row[field] === undefined) {
        if (missingKey === "upProbabilityMissing") upProbabilityMissing++;
        else if (missingKey === "downProbabilityMissing") downProbabilityMissing++;
        else if (missingKey === "upOddsMissing") upOddsMissing++;
        else if (missingKey === "downOddsMissing") downOddsMissing++;
        else referenceMissing++;
      }
    }
    if (Number(row.referenceConfirmed) !== 1) referenceUnconfirmed++;
  }
  const duplicateSnapshotBucketCount = [...duplicateSnapshotKeys]
    .filter(key => key.endsWith(":duplicate")).length;
  const sortedObservations = fixedSnapshots.map(row => numeric(row.observedAtMs))
    .filter(time => time !== null && time >= START_MS && time < DUE_MS)
    .sort((left, right) => left - right);
  let longestGapMs = DUE_MS - START_MS;
  if (sortedObservations.length) {
    longestGapMs = Math.max(0, sortedObservations[0] - START_MS);
    let previous = sortedObservations[0];
    for (const observedAt of sortedObservations.slice(1)) {
      longestGapMs = Math.max(longestGapMs, observedAt - previous);
      previous = observedAt;
    }
    longestGapMs = Math.max(longestGapMs, DUE_MS - previous);
  }
  const fieldObservedCount = fixedSnapshots.length;
  const missingFields = {
    upProbabilityCents: upProbabilityMissing,
    downProbabilityCents: downProbabilityMissing,
    upOddsCents: upOddsMissing,
    downOddsCents: downOddsMissing,
    referencePrice: referenceMissing,
  };
  const sourceIdentityChecks = {
    expectedMarketUuid: MARKET_IDS[interval],
    expectedStarts: requiredStarts.length,
    coverageRows: fixedCoverage.length,
    missingCoverageStarts: requiredStarts.length - fixedCoverage.length,
    coveredRoundStartConflicts: conflictingRoundIdsAtStart,
    expectedRoundUuidJoins: expectedRoundUuidJoined,
    coverageIdentityMismatches,
    expectedIdDoesNotMatchFirstAtStart,
    expectedRoundStartGridMismatches: expectedStartGridMismatches,
    wrongMarketUuidFirstRounds: firstMarketIdMismatches,
    invalidRoundUuidFormat: invalidRoundUuidCount,
    wrongCadenceOrBoundaryFirstRounds: firstCadenceMismatches,
    firstObservedOutsideRound: firstObservationOutsideRound,
    coverageSuccessOutsideRound,
    coverageSuccessAtOrAfterWindowEnd,
    snapshotRoundJoinMissing,
    snapshotIdentityMismatches,
    snapshotObservedOutsideRound: snapshotOutsideRound,
    snapshotBucketMismatches,
    duplicateSnapshotBucketConflicts: duplicateSnapshotBucketCount,
    schemaPrimaryKeyGuardsSnapshotBuckets: true,
    independentlyStoredProviderMarketId: false,
    rolloverProof: {
      status: snapshotOutsideRound || snapshotIdentityMismatches ||
        expectedIdDoesNotMatchFirstAtStart ? "failed" :
        "stored_joins_consistent_but_behavior_not_fully_proven",
      limitation: "30-second samples may not land immediately on both sides of each rollover.",
    },
  };
  const accountingComplete = fixedCoverage.length === requiredStarts.length;
  const identityVerified = firstMarketIdMismatches === 0 &&
    firstCadenceMismatches === 0 && firstObservationOutsideRound === 0 &&
    invalidRoundUuidCount === 0 && expectedStartGridMismatches === 0 &&
    coverageIdentityMismatches === 0 &&
    expectedRoundUuidJoined === requiredStarts.length &&
    conflictingRoundIdsAtStart === 0 &&
    coverageSuccessOutsideRound === 0 &&
    expectedIdDoesNotMatchFirstAtStart === 0 && snapshotRoundJoinMissing === 0 &&
    snapshotIdentityMismatches === 0 && snapshotOutsideRound === 0 &&
    snapshotBucketMismatches === 0 && duplicateSnapshotBucketCount === 0;
  const freshnessThresholdMs = interval === 5 ? 15_000 : 30_000;
  const initialFixedWindowRound = analyzeBoundaryRound(
    evidence, interval, START_MS, START_MS, DUE_MS,
  );
  const initialBoundaryEvidenceComplete =
    initialFixedWindowRound.coverageRowsForRound === 1 &&
    initialFixedWindowRound.matchingFirstFrozenRoundCount === 1 &&
    initialFixedWindowRound.firstRoundIdentityVerified === true &&
    initialFixedWindowRound.persistedSnapshotsDuringTrialOverlap > 0 &&
    initialFixedWindowRound.maxFreshnessAgeMs !== null &&
    initialFixedWindowRound.maxFreshnessAgeMs >= 0 &&
    initialFixedWindowRound.maxScheduledDelayMs !== null &&
    initialFixedWindowRound.maxScheduledDelayMs >= 0 &&
    initialFixedWindowRound.hadGap !== null;
  const initialBoundaryGapProof = !initialBoundaryEvidenceComplete
    ? "not_measured_initial_intersecting_round_evidence_incomplete"
    : initialFixedWindowRound.hadGap ||
        initialFixedWindowRound.maxFreshnessAgeMs > freshnessThresholdMs
      ? "not_measured_initial_round_statistics_may_include_pre_window_lateness"
      : "verified_initial_round_window_subset_bounded";
  const fixedRoundProofFailed = roundGapEvidence.some(item =>
    item.status === "failed_gap_detected_inside_full_round");
  const fixedRoundProofIncomplete = roundGapEvidence.some(item =>
    item.status !== "verified_no_gap_upper_bound_for_round");
  const gapProofStatus = fixedRoundProofFailed
    ? "failed_gap_detected"
    : fixedRoundProofIncomplete || initialBoundaryGapProof !==
        "verified_initial_round_window_subset_bounded"
      ? "not_measured_window_gap_proof_incomplete"
      : "verified_no_gaps_within_window";
  return {
    intervalMinutes: interval,
    fixedFirst24Hours: {
      windowStartMs: START_MS,
      windowStart: iso(START_MS),
      windowEndExclusiveMs: DUE_MS,
      windowEndExclusive: iso(DUE_MS),
      intervalDurationMs: step,
      requiredRoundStarts: requiredStarts.length,
      roundStartsInclusiveOfWindowStart: requiredStarts.map(iso),
      coverageRows: fixedCoverage.length,
      coverageSuccessfulRounds: coverageFirstSuccess,
      roundsWithFirstFrozenObservation: uniqueCount(firsts
        .filter(row => Number(row.startsAtMs) >= START_MS && Number(row.startsAtMs) < DUE_MS)
        .map(row => row.roundId)),
      roundsWithAtLeastOneSnapshot: roundsWithSnapshot,
      roundsWithAnyObservedRecord,
      observations: fixedSnapshots.length,
      missingRoundStarts: missingStarts.map(iso),
      missingRoundStartCount: missingStarts.length,
      longestNoObservationGap: {
        milliseconds: longestGapMs,
        seconds: Number((longestGapMs / 1000).toFixed(3)),
        basis: "Coarse gaps between persisted approximately 30-second snapshots inside the fixed window, including leading and trailing tails and initial-intersecting-round samples; this is not an actual high-frequency outage measurement or a substitute for poll-level freshness.",
        snapshotBucketWidthMs: 30_000,
      },
      actualCoverageFreshness: {
        maxFreshnessAgeMs,
        maxScheduledDelayMs,
        coverageRoundsWithFreshnessMeasurement: coverageFreshnessRows,
        coverageRowsWithKnownGapFlag,
        hadGapRounds: coverageHadGapRounds,
        gapProofStatus,
        gapProofByExpectedRound: roundGapEvidence,
        initialIntersectingRound: {
          ...initialFixedWindowRound,
          gapProofStatus: initialBoundaryGapProof,
        },
        limitation: "The worker's freshness, schedule-delay, and had-gap values are whole-round aggregates. A terminal-round maximum may include post-window data and an initial-round gap may predate this measurement window; ambiguous boundary statistics leave the window unproved rather than being treated as an in-window outage or as a pass.",
      },
      sourceFieldCompleteness: {
        observations: fieldObservedCount,
        missingValues: missingFields,
        nonNullValues: Object.fromEntries(Object.entries(missingFields).map(([field, missing]) =>
          [field, Math.max(0, fieldObservedCount - missing)])),
        completenessRatio: Object.fromEntries(Object.entries(missingFields).map(([field, missing]) =>
          [field, fieldObservedCount === 0 ? null :
            Number(((fieldObservedCount - missing) / fieldObservedCount).toFixed(6))])),
        referenceUnconfirmed,
        denominatorPerField: fieldObservedCount,
      },
      delayedScheduling: { maxScheduledDelayMs },
      accountingComplete,
      identityVerified,
      gapProofStatus,
      inWindowSnapshotsPresent: fixedSnapshots.length > 0,
      coverageRowsWithKnownFreshness: coverageFreshnessRows,
      coverageRowsWithKnownScheduledDelay: fixedCoverage.filter(row =>
        numeric(row.maxScheduledDelayMs) !== null).length,
      coverageRowsWithKnownGapFlag,
      allExpectedRoundsHaveInWindowSnapshots: roundGapEvidence.every(item =>
        item.inWindowSnapshotCount > 0),
      sourceIdentityChecks,
      snapshotCountByExpectedRoundStart: Object.fromEntries([...snapshotCountByStart]
        .map(([start, count]) => [iso(start), count])),
    },
    trialBoundaryPartialRounds: {
      collectionWindowStart: iso(START_MS),
      collectionWindowStopExclusive: iso(STOP_MS),
      initialRound: analyzeBoundaryRound(evidence, interval, START_MS),
      terminalRound: analyzeBoundaryRound(evidence, interval, STOP_MS),
      fixedFirst24HourWindowBoundaries: {
        initialIntersectingRound: initialFixedWindowRound,
        terminalIntersectingRound: analyzeBoundaryRound(
          evidence, interval, DUE_MS, START_MS, DUE_MS,
        ),
      },
      note: "These boundary rounds intersect the 26-hour trial but are not additional full five-/fifteen-minute observations; denominators are explicit.",
    },
  };
}

function analyzeBoundaryRound(
  evidence, intervalMinutes, boundaryMs,
  windowStartMs = START_MS, windowEndExclusiveMs = STOP_MS,
) {
  const timing = describeBoundaryRound(
    boundaryMs, intervalMinutes, windowStartMs, windowEndExclusiveMs,
  );
  const coverage = byInterval(evidence.coverage, intervalMinutes).filter(row =>
    Number(row.expectedStartMs) === timing.roundStartMs);
  const firstRounds = byInterval(evidence.firstRounds, intervalMinutes).filter(row =>
    Number(row.startsAtMs) === timing.roundStartMs);
  const expectedRoundId = coverage[0]?.expectedRoundId ??
    firstRounds[0]?.roundId ?? null;
  const snapshots = byInterval(evidence.snapshots, intervalMinutes).filter(row =>
    Number(row.observedAtMs) >= Number(timing.trialOverlapStart ? Date.parse(timing.trialOverlapStart) : 0) &&
    Number(row.observedAtMs) < Number(timing.trialOverlapEndExclusive ? Date.parse(timing.trialOverlapEndExclusive) : 0) &&
    (expectedRoundId === null || row.roundId === expectedRoundId));
  const denominator = Math.max(0, timing.trialOverlapMs);
  const fields = ["upProbabilityCents", "downProbabilityCents", "upOddsCents",
    "downOddsCents", "referencePrice"];
  const missing = Object.fromEntries(fields.map(field => [field,
    snapshots.filter(row => row[field] === null || row[field] === undefined).length]));
  const firstSuccessAtMs = numeric(coverage[0]?.firstSuccessAtMs);
  const firstRound = firstRounds[0];
  const firstRoundIdentityVerified = firstRounds.length === 1 &&
    firstRound.roundId === expectedRoundId &&
    firstRound.marketId === MARKET_IDS[intervalMinutes] &&
    Number(firstRound.startsAtMs) === timing.roundStartMs &&
    Number(firstRound.endsAtMs) === timing.roundEndMs &&
    Number(firstRound.endsAtMs) - Number(firstRound.startsAtMs) ===
      timing.intervalDurationMs &&
    numeric(firstRound.firstObservedAtMs) !== null &&
    numeric(firstRound.firstObservedAtMs) >= timing.roundStartMs &&
    numeric(firstRound.firstObservedAtMs) < timing.roundEndMs &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(String(firstRound.roundId));
  return {
    ...timing,
    roundStartDenominator: 1,
    trialOverlapDenominatorMs: denominator,
    trialOverlapFractionOfRound: timing.intervalDurationMs
      ? Number((denominator / timing.intervalDurationMs).toFixed(6)) : null,
    coverageRowsForRound: coverage.length,
    firstSuccessAtMs,
    firstSuccessAt: iso(firstSuccessAtMs),
    coverageSuccessful: firstSuccessAtMs !== null &&
      firstSuccessAtMs < windowEndExclusiveMs,
    coverageFirstSuccessWithinAnalysisWindow: firstSuccessAtMs !== null &&
      firstSuccessAtMs >= windowStartMs &&
      firstSuccessAtMs < windowEndExclusiveMs,
    expectedRoundId,
    firstRoundIdentityVerified,
    matchingFirstFrozenRoundCount: firstRounds.filter(row =>
      expectedRoundId === null || row.roundId === expectedRoundId).length,
    persistedSnapshotsDuringTrialOverlap: snapshots.length,
    missingSourceFields: missing,
    referenceUnconfirmedSnapshots: snapshots.filter(row =>
      Number(row.referenceConfirmed) !== 1).length,
    hadGap: coverage[0]?.hadGap == null ? null : Number(coverage[0].hadGap) !== 0,
    maxFreshnessAgeMs: numeric(coverage[0]?.maxFreshnessAgeMs),
    maxScheduledDelayMs: numeric(coverage[0]?.maxScheduledDelayMs),
    observationStatus: snapshots.length
      ? "observed" : "not_observed",
  };
}

function describeBoundaryRound(
  boundaryMs, intervalMinutes, windowStartMs = START_MS,
  windowEndExclusiveMs = STOP_MS,
) {
  const durationMs = intervalMinutes * 60_000;
  const startMs = floorTo(boundaryMs, durationMs);
  const endMs = startMs + durationMs;
  const overlapStart = Math.max(startMs, windowStartMs);
  const overlapEnd = Math.min(endMs, windowEndExclusiveMs);
  return {
    roundStartMs: startMs,
    roundStart: iso(startMs),
    roundEndMs: endMs,
    roundEnd: iso(endMs),
    intervalDurationMs: durationMs,
    trialOverlapStart: iso(overlapStart),
    trialOverlapEndExclusive: iso(overlapEnd),
    trialOverlapMs: Math.max(0, overlapEnd - overlapStart),
    partial: overlapEnd - overlapStart < durationMs,
  };
}