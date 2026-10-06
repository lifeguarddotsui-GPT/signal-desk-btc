const START_MS = 1_790_805_764_752;
const DUE_MS = 1_790_892_164_752;
const INTERVALS = [5, 15];
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

function normalizedStatus(row) {
  return String(row.providerStatus ?? "").trim().toLowerCase();
}

function consistencyReasons(row, interval) {
  const close = numeric(row.expectedClosingEpoch);
  const providerClose = numeric(row.providerClosingEpoch);
  const settledAt = numeric(row.providerSettledAtEpoch);
  const observedAt = numeric(row.observedAtMs);
  const settlePrice = numeric(row.providerSettlePrice);
  const anchorPrice = numeric(row.providerAnchorPrice);
  const outcome = String(row.providerOutcome ?? "").trim().toLowerCase();
  const reasons = [];
  if (normalizedStatus(row) !== "resolved") reasons.push("provider_status_not_resolved");
  if (outcome !== "up" && outcome !== "down") reasons.push("provider_outcome_missing_or_invalid");
  if (row.providerRoundId !== row.expectedRoundId) reasons.push("provider_round_id_mismatch");
  if (close === null || providerClose !== close ||
      close * 1000 !== Number(row.expectedRoundEndMs))
    reasons.push("provider_or_expected_closing_time_mismatch");
  if (settledAt === null || observedAt === null || close === null ||
      settledAt <= close || settledAt > Math.floor(observedAt / 1000))
    reasons.push("settlement_time_inconsistent_with_close_or_observation");
  if (settlePrice === null || settlePrice <= 0)
    reasons.push("settlement_price_missing_or_nonpositive");
  if (Number(row.providerAnchorConfirmed) !== 1 ||
      anchorPrice === null || anchorPrice <= 0)
    reasons.push("anchor_unconfirmed_or_invalid");
  if ((outcome === "up" || outcome === "down") && settlePrice !== null &&
      anchorPrice !== null && settlePrice > 0 && anchorPrice > 0 &&
      (outcome === "up") !== (settlePrice >= anchorPrice))
    reasons.push("outcome_disagrees_with_settlement_and_anchor_price");
  if (row.expectedMarketId !== MARKET_IDS[interval])
    reasons.push("prospective_market_id_mismatch");
  if (row.source !== "WaterX") reasons.push("evidence_source_mismatch");
  return reasons;
}

function statusRevisionConflict(probes) {
  const ordered = [...probes].sort((left, right) =>
    Number(left.observedAtMs) - Number(right.observedAtMs));
  const resolvedSeen = ordered.some(row => normalizedStatus(row) === "resolved");
  if (!resolvedSeen) return false;
  return ordered.some(row => {
    const status = normalizedStatus(row);
    const observedAt = Number(row.observedAtMs);
    const resolvedBefore = ordered.some(prior =>
      normalizedStatus(prior) === "resolved" &&
      Number(prior.observedAtMs) < observedAt);
    return resolvedBefore && [
      "unresolved", "pending", "open", "active", "awaiting_settlement",
      "disputed", "cancelled", "canceled", "void", "reversed", "invalidated",
    ].includes(status);
  });
}

export function analyzeSettlementEvidence(rows, firstRounds) {
  const latestByRound = new Map();
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.intervalMinutes}:${row.expectedRoundId}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
    const prior = latestByRound.get(key);
    if (!prior || Number(row.observedAtMs) > Number(prior.observedAtMs) ||
        (Number(row.observedAtMs) === Number(prior.observedAtMs) &&
         Number(row.probeBucketMs) > Number(prior.probeBucketMs)))
      latestByRound.set(key, row);
  }

  const conflicts = [];
  for (const [key, probes] of groups) {
    const explicitlyResolved = probes.filter(row =>
      String(row.providerStatus ?? "").trim().toLowerCase() === "resolved");
    const outcomes = [...new Set(explicitlyResolved
      .map(row => String(row.providerOutcome ?? "").trim().toLowerCase())
      .filter(outcome => outcome === "up" || outcome === "down"))];
    const prices = [...new Set(explicitlyResolved
      .map(row => numeric(row.providerSettlePrice))
      .filter(price => price !== null))];
    const anchors = [...new Set(explicitlyResolved
      .map(row => numeric(row.providerAnchorPrice))
      .filter(price => price !== null))];
    const settledAtTimes = [...new Set(explicitlyResolved
      .map(row => numeric(row.providerSettledAtEpoch))
      .filter(time => time !== null))];
    const providerRoundIds = [...new Set(explicitlyResolved
      .map(row => row.providerRoundId).filter(value => value !== null && value !== undefined))];
    const providerClosingTimes = [...new Set(explicitlyResolved
      .map(row => numeric(row.providerClosingEpoch)).filter(time => time !== null))];
    const anchorConfirmationStates = [...new Set(explicitlyResolved
      .filter(row => row.providerAnchorConfirmed !== null &&
        row.providerAnchorConfirmed !== undefined)
      .map(row => Number(row.providerAnchorConfirmed) === 1))];
    const hasStatusRevision = statusRevisionConflict(probes);
    if (outcomes.length > 1 || prices.length > 1 || anchors.length > 1 ||
        settledAtTimes.length > 1 || providerRoundIds.length > 1 ||
        providerClosingTimes.length > 1 || anchorConfirmationStates.length > 1 ||
        hasStatusRevision) {
      const [intervalText, roundId] = key.split(":");
      const conflictReasons = [
        ...(outcomes.length > 1 ? ["contradictory_resolved_outcomes"] : []),
        ...(prices.length > 1 ? ["contradictory_resolved_settlement_prices"] : []),
        ...(anchors.length > 1 ? ["contradictory_resolved_anchor_prices"] : []),
        ...(settledAtTimes.length > 1 ? ["contradictory_resolved_settlement_times"] : []),
        ...(providerRoundIds.length > 1 ? ["contradictory_resolved_provider_round_ids"] : []),
        ...(providerClosingTimes.length > 1 ? ["contradictory_resolved_provider_closing_times"] : []),
        ...(anchorConfirmationStates.length > 1 ? ["contradictory_resolved_anchor_confirmation"] : []),
        ...(hasStatusRevision ? ["provider_status_changed_after_resolution"] : []),
      ];
      conflicts.push({
        intervalMinutes: Number(intervalText),
        expectedRoundId: roundId,
        explicitResolvedProbeCount: explicitlyResolved.length,
        distinctProviderOutcomes: outcomes,
        distinctProviderSettlementPrices: prices,
        distinctProviderAnchorPrices: anchors,
        distinctProviderSettlementTimes: settledAtTimes,
        distinctProviderRoundIds: providerRoundIds,
        distinctProviderClosingTimes: providerClosingTimes,
        distinctAnchorConfirmationStates: anchorConfirmationStates,
        distinctProviderStatuses: [...new Set(probes
          .map(normalizedStatus).filter(Boolean))],
        statusRevisionObserved: hasStatusRevision,
        conflictReasons,
        conflict: conflictReasons[0],
      });
    }
  }
  const conflictKeys = new Set(conflicts.map(item =>
    `${item.intervalMinutes}:${item.expectedRoundId}`));
  const latest = [...latestByRound.values()];
  const workerVerifiedKeys = [...groups.keys()].filter(key =>
    groups.get(key).some(row => row.verdict === "VERIFIED"));
  const conflictFreeVerified = workerVerifiedKeys.filter(key => !conflictKeys.has(key));
  const evidenceRoundsByInterval = new Map(INTERVALS.map(interval => [
    interval,
    new Set(firstRounds.filter(row =>
      Number(row.intervalMinutes) === interval).map(row => row.roundId)),
  ]));
  const evidenceJoinMismatches = rows.filter(row => {
    const interval = Number(row.intervalMinutes);
    return INTERVALS.includes(interval) &&
      (!evidenceRoundsByInterval.get(interval).has(row.expectedRoundId) ||
       row.providerRoundId !== null && row.providerRoundId !== row.expectedRoundId ||
       row.providerClosingEpoch !== null &&
         Number(row.providerClosingEpoch) !== Number(row.expectedClosingEpoch) ||
       Number(row.expectedClosingEpoch) * 1000 !== Number(row.expectedRoundEndMs) ||
       row.expectedMarketId !== MARKET_IDS[interval] ||
       row.source !== "WaterX");
  });
  const evidenceConsistencyFailures = rows.flatMap(row => {
    const interval = Number(row.intervalMinutes);
    if (!INTERVALS.includes(interval)) return [];
    if (normalizedStatus(row) !== "resolved" && row.verdict !== "VERIFIED")
      return [];
    const reasons = consistencyReasons(row, interval);
    return reasons.length ? [{
      intervalMinutes: interval,
      expectedRoundId: row.expectedRoundId,
      verdict: row.verdict,
      providerStatus: row.providerStatus ?? null,
      observedAt: iso(Number(row.observedAtMs)),
      reasons,
    }] : [];
  });
  const joinMismatchKeys = new Set(evidenceJoinMismatches.map(row =>
    `${row.intervalMinutes}:${row.expectedRoundId}`));
  const consistencyFailureKeys = new Set(evidenceConsistencyFailures.map(item =>
    `${item.intervalMinutes}:${item.expectedRoundId}`));
  const auditedEligibleVerified = workerVerifiedKeys.filter(key =>
    !conflictKeys.has(key) && !joinMismatchKeys.has(key) &&
    !consistencyFailureKeys.has(key));
  const perInterval = Object.fromEntries(INTERVALS.map(interval => {
    const intervalKeys = [...groups.keys()].filter(key => key.startsWith(`${interval}:`));
    const verified = workerVerifiedKeys.filter(key => key.startsWith(`${interval}:`));
    const conflictFree = conflictFreeVerified.filter(key => key.startsWith(`${interval}:`));
    const auditedEligible = auditedEligibleVerified.filter(key =>
      key.startsWith(`${interval}:`));
    const latestRows = latest.filter(row => Number(row.intervalMinutes) === interval);
    const withheldReasonCounts = {};
    const fieldMissingCounts = (rowsToCount, recordReasons = true) => {
      const counts = {
        providerRoundId: 0,
        providerClosingEpoch: 0,
        providerStatus: 0,
        providerOutcome: 0,
        providerSettledAtEpoch: 0,
        providerSettlePrice: 0,
        providerAnchorPrice: 0,
        providerAnchorUnconfirmed: 0,
        providerMarketId: 0,
        providerRawResponse: 0,
      };
      for (const row of rowsToCount) {
        if (recordReasons && row.verdict === "WITHHELD") {
          const reason = String(row.reason ?? "withheld_reason_not_recorded").slice(0, 240);
          withheldReasonCounts[reason] = (withheldReasonCounts[reason] ?? 0) + 1;
        }
        for (const key of [
          "providerRoundId", "providerClosingEpoch", "providerStatus",
          "providerOutcome", "providerSettledAtEpoch", "providerSettlePrice",
          "providerAnchorPrice", "providerMarketId", "providerRawResponse",
        ]) {
          if (row[key] === null || row[key] === undefined) counts[key]++;
        }
        if (Number(row.providerAnchorConfirmed) !== 1)
          counts.providerAnchorUnconfirmed++;
      }
      return counts;
    };
    const latestMissingFields = fieldMissingCounts(latestRows);
    const withheldLatestRows = latestRows.filter(row => row.verdict === "WITHHELD");
    const withheldMissingFields = fieldMissingCounts(withheldLatestRows, false);
    const intervalConflicts = conflicts.filter(item => item.intervalMinutes === interval);
    const intervalJoinMismatches = evidenceJoinMismatches.filter(row =>
      Number(row.intervalMinutes) === interval);
    const intervalConsistencyFailures = evidenceConsistencyFailures.filter(item =>
      Number(item.intervalMinutes) === interval);
    const outcomeCounts = { up: 0, down: 0, unknown: 0 };
    for (const key of auditedEligible) {
      const outcome = String(latestByRound.get(key)?.providerOutcome ?? "").trim().toLowerCase();
      if (outcome === "up" || outcome === "down") outcomeCounts[outcome]++;
      else outcomeCounts.unknown++;
    }
    return [interval, {
      settlementAttempts: rows.filter(row => Number(row.intervalMinutes) === interval).length,
      verdictAttemptCounts: Object.fromEntries(["VERIFIED", "WITHHELD",
        "IDENTITY_MISMATCH", "READ_ERROR"].map(verdict => [
        verdict,
        rows.filter(row => Number(row.intervalMinutes) === interval &&
          row.verdict === verdict).length,
      ])),
      distinctRoundsWithEvidence: intervalKeys.length,
      latestEvidencePerRound: latestRows.map(row => ({
        expectedRoundId: row.expectedRoundId,
        expectedMarketIdFromProspectiveJoin: row.expectedMarketId,
        expectedClosingEpoch: row.expectedClosingEpoch,
        expectedRoundEnd: iso(Number(row.expectedClosingEpoch) * 1000),
        providerRoundId: row.providerRoundId,
        providerClosingEpoch: row.providerClosingEpoch,
        providerStatus: row.providerStatus,
        providerOutcome: row.providerOutcome,
        providerSettledAtEpoch: row.providerSettledAtEpoch,
        providerSettlePrice: row.providerSettlePrice,
        providerAnchorPrice: row.providerAnchorPrice,
        providerAnchorConfirmed: Number(row.providerAnchorConfirmed) === 1,
        verdict: row.verdict,
        reason: row.reason ?? null,
        observedAt: iso(Number(row.observedAtMs)),
        source: row.source,
      })),
      workerVerifiedDistinctOutcomes: verified.length,
      conflictFreeWorkerVerifiedDistinctOutcomes: conflictFree.length,
      auditedEligibleWorkerVerifiedDistinctOutcomes: auditedEligible.length,
      auditedEligibleOutcomeCounts: outcomeCounts,
      independentlyAuditCompleteDistinctLabels: 0,
      independentAuditCompletionStatus: "not_measured",
      independentlyAuditIncompleteReason: "Provider market UUID is not persisted separately; no raw provider response/marketID proof is retained, so the Worker-side market check cannot be independently re-audited.",
      withheldReasonCounts,
      latestProviderFieldMissingCounts: latestRows.length ? latestMissingFields : null,
      latestWithheldProviderFieldMissingCounts: withheldLatestRows.length
        ? withheldMissingFields : null,
      explicitlyResolvedContradictions: intervalConflicts,
      conflictedDistinctRoundCount: intervalConflicts.length,
      evidenceJoinMismatches: intervalJoinMismatches.length,
      providerEvidenceConsistencyFailures: intervalConsistencyFailures.length,
      providerEvidenceConsistencyFailureDetails: intervalConsistencyFailures,
       providerEvidenceConsistencyBasis: "Checks every explicitly resolved or Worker-VERIFIED row for persisted status/outcome, expected/provider round identity and closing time, settlement time, positive settlement/confirmed-anchor prices, and outcome-versus-price consistency; unresolved-to-resolved progress is not a failure. Cannot verify unpersisted provider marketId/raw response.",
      missingProviderMarketIdProof: true,
      missingProviderAuditFields: {
        providerMarketId: latestRows.length,
        rawProviderResponse: latestRows.length,
        basis: "These fields are not present in edge/0001_schema.sql; counts mean one missing value for each retained latest round record.",
      },
      limitations: [
        "Worker VERIFIED checks the fetched provider market against the frozen prospective market, but D1 does not persist provider marketId or the raw response for independent audit.",
        "The historical verifier requires a confirmed settlement anchor but does not require its numeric value to match the provisional prospective anchor.",
        "After one VERIFIED verdict, the Worker excludes that round from later probes; subsequent provider revisions or disputes are not observed by this trial.",
        "A verified settlement outcome is a retrospective label, not a prospective model result.",
      ],
    }];
  }));
  return {
    evidenceWindow: {
      roundsStartingAtOrAfter: iso(START_MS),
      roundsStartingBefore: iso(DUE_MS),
      evidenceObservedThrough: "all retained evidence currently returned by the isolated D1 query",
    },
    observedSettlementAttempts: rows.length,
    persistedReadErrorEvidenceCount: rows.filter(row => row.verdict === "READ_ERROR").length,
    persistedReadErrorReasons: Object.fromEntries(rows
      .filter(row => row.verdict === "READ_ERROR")
      .map(row => [String(row.reason ?? "read_error_reason_not_recorded").slice(0, 240), 1])
      .reduce((counts, [reason]) => {
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
        return counts;
      }, new Map())),
    uniqueExpectedRoundsWithEvidence: groups.size,
    workerVerifiedDistinctOutcomeLabels: workerVerifiedKeys.length,
    conflictFreeWorkerVerifiedDistinctOutcomeLabels: conflictFreeVerified.length,
    auditedEligibleWorkerVerifiedDistinctOutcomeLabels: auditedEligibleVerified.length,
    providerEvidenceConsistencyFailureCount: evidenceConsistencyFailures.length,
    providerEvidenceConsistencyFailureDetails: evidenceConsistencyFailures,
    evidenceJoinMismatchCount: evidenceJoinMismatches.length,
    independentlyAuditCompleteDistinctLabels: 0,
    independentlyAuditCompleteReason: "Provider market identity/raw response is not persisted; worker verification cannot be independently reconstructed.",
    explicitlyResolvedContradictoryRounds: conflicts,
    conflictCount: conflicts.length,
    latestEvidenceByInterval: perInterval,
    status: conflicts.length || evidenceConsistencyFailures.length ||
      evidenceJoinMismatches.length ? "failed" :
      workerVerifiedKeys.length ? "verified_worker_evidence_only" :
        rows.length ? "not_measured_only_nonverified_evidence" : "not_measured",
    noPriceInference: true,
    frozenModelPredictions: 0,
    predictionAccuracy: "not measured",
    activeLearning: "not measured",
    reasonPredictionEvaluationUnavailable: "This source-only edge trial records no frozen independent-model prediction rows. Verified settlement labels alone are not prospective predictions or evidence of accuracy.",
  };
}