const DUE_MS = 1_790_892_164_752;

export function fullWindowValidity(nowMs, preview, health, intervalReports) {
  const elapsed = nowMs >= DUE_MS;
  const correctlyStarted = health.startMatchesExpected === true;
  const intervalIds = intervalReports.map(item => Number(item.intervalMinutes));
  const reportHasBothIntervals = intervalReports.length === 2 &&
    new Set(intervalIds).size === 2 &&
    intervalIds.includes(5) && intervalIds.includes(15);
  const accountingComplete = reportHasBothIntervals &&
    intervalReports.every(item => {
      const fixed = item?.fixedFirst24Hours;
      const expected = Number(item.intervalMinutes) === 5 ? 288 : 96;
      return fixed?.accountingComplete === true &&
        fixed.requiredRoundStarts === expected &&
        fixed.coverageRows === expected &&
        fixed.missingRoundStartCount === 0;
    });
  const identitiesValid = reportHasBothIntervals &&
    intervalReports.every(item => item?.fixedFirst24Hours?.identityVerified === true);
  const identityMismatchKeys = [
    "coveredRoundStartConflicts",
    "coverageIdentityMismatches",
    "expectedIdDoesNotMatchFirstAtStart",
    "expectedRoundStartGridMismatches",
    "wrongMarketUuidFirstRounds",
    "invalidRoundUuidFormat",
    "wrongCadenceOrBoundaryFirstRounds",
    "firstObservedOutsideRound",
    "coverageSuccessOutsideRound",
    "snapshotRoundJoinMissing",
    "snapshotIdentityMismatches",
    "snapshotObservedOutsideRound",
    "snapshotBucketMismatches",
    "duplicateSnapshotBucketConflicts",
  ];
  const identityMismatchObserved = intervalReports.some(item => {
    const checks = item?.fixedFirst24Hours?.sourceIdentityChecks ?? {};
    return identityMismatchKeys.some(key => Number(checks[key] ?? 0) > 0);
  });
  const complete = elapsed && correctlyStarted && reportHasBothIntervals &&
    accountingComplete;
  const gapFree = complete && intervalReports.every(item => {
    const window = item.fixedFirst24Hours;
    return window.identityVerified &&
      window.missingRoundStartCount === 0 &&
      window.actualCoverageFreshness?.hadGapRounds === 0 &&
      window.coverageSuccessfulRounds === window.requiredRoundStarts &&
      window.gapProofStatus === "verified_no_gaps_within_window";
  });
  const gapProofFailed = intervalReports.some(item =>
    item?.fixedFirst24Hours?.gapProofStatus === "failed_gap_detected");
  const gapProofComplete = reportHasBothIntervals &&
    intervalReports.every(item =>
      item?.fixedFirst24Hours?.gapProofStatus === "verified_no_gaps_within_window");
  const status = preview ? "not_measured_incomplete_preview" :
    !elapsed ? "not_measured_window_not_elapsed" :
      !correctlyStarted ? "failed_collector_start_identity_mismatch" :
        !reportHasBothIntervals ? "failed_private_evidence_intervals_missing_or_duplicated" :
          !accountingComplete ? "failed_window_accounting_incomplete" :
            identityMismatchObserved ? "failed_source_identity_checks" :
              !identitiesValid ? "not_measured_source_identity_evidence_incomplete" :
              gapProofFailed ? "failed_or_incomplete_collection_gaps" :
                !gapProofComplete ? "not_measured_window_gap_proof_incomplete" :
                  gapFree ? "verified_gap_free_window_accounted" :
                    "failed_or_incomplete_collection_gaps";
  return {
    status,
    preview,
    full24HoursElapsed: elapsed,
    full24hPassClaimed: !preview && status === "verified_gap_free_window_accounted",
    passScope: "Collection coverage only; not settlement audit completeness, prediction accuracy, browser closure, app compatibility, or production-cutover approval.",
    collectorStartedAtExpectedEpoch: correctlyStarted,
    privateEvidenceHasBothIntervals: reportHasBothIntervals,
    sourceIdentityMismatchObserved: identityMismatchObserved,
    expectedStartDenominators: { 5: 288, 15: 96 },
    directD1AccountingCompletePerInterval: Object.fromEntries(intervalReports.map(item =>
      [item.intervalMinutes, item.fixedFirst24Hours?.accountingComplete === true])),
    sourceIdentityVerifiedPerInterval: Object.fromEntries(intervalReports.map(item =>
      [item.intervalMinutes, item.fixedFirst24Hours?.identityVerified === true])),
    collectionGapProofByInterval: Object.fromEntries(intervalReports.map(item =>
      [item.intervalMinutes, item.fixedFirst24Hours?.gapProofStatus ?? "not_measured"])),
    collectionGapProofComplete: gapProofComplete,
    gapFree,
    note: "A preview is never marked as a full-24-hour pass. This summary does not claim app/API compatibility, paid-tier suitability, or safe production cutover.",
  };
}