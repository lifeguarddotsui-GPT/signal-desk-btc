import pg from "pg";
import type { WaterxInterval } from "./types";
import {
  WATERX_CANDIDATE_ARTIFACT_VERSION,
  WATERX_CANDIDATE_CALIBRATION_VERSION,
} from "./candidate-training";

type CandidateStatusQueryable = {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

function objectOrNull(value: unknown): Record<string, any> | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, any> : null;
}

/**
 * Read-only learning-page audit summary. Candidate artifacts are retained for
 * research only; neither this query nor the trainer exposes a champion.
 */
export async function latestCandidateStatus(
  interval: WaterxInterval,
  db: CandidateStatusQueryable = pool,
) {
  if (db === pool && !process.env.DATABASE_URL)
    return { status: "unavailable", reason: "Candidate audit database is not configured.", promoted: false };
  try {
    const { rows } = await db.query<{
      latest_attempt: unknown;
      latest_scheduled_attempt: unknown;
      latest_candidate_artifact: unknown;
      latest_accepted_settlement: unknown;
      latest_prediction: unknown;
      accepted_label_count: number | string;
      feature_snapshot_count: number | string;
      prospective_prediction_count: number | string;
      scored_prospective_prediction_count: number | string;
    }>(`WITH latest_attempt AS (
         SELECT attempt_id,created_at,status,dataset_hash,rejection_reason,
                report,artifact,promoted
           FROM waterx_candidate_training_attempts
          WHERE interval_minutes=$1
          ORDER BY created_at DESC,attempt_id DESC LIMIT 1
        ), latest_scheduled_attempt AS (
          SELECT created_at
            FROM waterx_candidate_training_attempts
           WHERE interval_minutes=$1
             AND report->>'scheduledEvaluation'='daily-waterx-candidate-v1'
           ORDER BY created_at DESC,attempt_id DESC LIMIT 1
       ), latest_candidate_artifact AS (
         SELECT created_at,artifact
           FROM waterx_candidate_training_attempts
          WHERE interval_minutes=$1 AND status='candidate-evaluated'
            AND promoted=false AND artifact IS NOT NULL
            AND artifact->>'artifactVersion'=$2
          ORDER BY created_at DESC,attempt_id DESC LIMIT 1
       ), accepted_labels AS (
         SELECT round_id,outcome,settled_at,settlement_observed_at
           FROM waterx_learning_rounds
          WHERE interval_minutes=$1 AND label_status='verified'
            AND settlement_disputed=false AND anchor_confirmed=true
            AND outcome IN ('Up','Down')
            AND settlement_anchor_price IS NOT NULL AND settle_price IS NOT NULL
            AND settlement_anchor_price=anchor_price
            AND settled_at > expiry_ms AND settlement_observed_at IS NOT NULL
            AND (settlement_quarantine IS NULL OR settlement_quarantine='[]'::jsonb)
       ), latest_label AS (
         SELECT round_id,outcome,settled_at,settlement_observed_at
           FROM accepted_labels
          ORDER BY settlement_observed_at DESC,settled_at DESC,round_id LIMIT 1
       ), latest_prediction AS (
         SELECT record_data->'candidatePrediction' AS prediction
           FROM waterx_candidate_feature_snapshots
          WHERE interval_minutes=$1
            AND jsonb_typeof(record_data->'candidatePrediction')='object'
           ORDER BY captured_at DESC,round_id DESC LIMIT 1
       )
        SELECT (SELECT to_jsonb(a) FROM latest_attempt a) AS latest_attempt,
               (SELECT to_jsonb(a) FROM latest_scheduled_attempt a) AS latest_scheduled_attempt,
              (SELECT to_jsonb(a) FROM latest_candidate_artifact a) AS latest_candidate_artifact,
              (SELECT to_jsonb(l) FROM latest_label l) AS latest_accepted_settlement,
              (SELECT count(*)::int FROM accepted_labels) AS accepted_label_count,
              (SELECT count(*)::int FROM waterx_candidate_feature_snapshots
                WHERE interval_minutes=$1) AS feature_snapshot_count,
              (SELECT count(*)::int FROM waterx_candidate_feature_snapshots
                WHERE interval_minutes=$1
                  AND jsonb_typeof(record_data->'candidatePrediction')='object')
                AS prospective_prediction_count,
              (SELECT count(*)::int
                 FROM waterx_candidate_feature_snapshots s
                 JOIN waterx_learning_rounds l
                   ON l.interval_minutes=s.interval_minutes AND l.round_id=s.round_id
                WHERE s.interval_minutes=$1
                  AND jsonb_typeof(s.record_data->'candidatePrediction')='object'
                  AND l.label_status='verified' AND l.settlement_disputed=false
                  AND l.anchor_confirmed=true AND l.outcome IN ('Up','Down')
                  AND l.settlement_anchor_price IS NOT NULL AND l.settle_price IS NOT NULL
                  AND l.settlement_anchor_price=s.confirmed_anchor_price
                  AND l.settled_at > l.expiry_ms AND l.settlement_observed_at IS NOT NULL
                  AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb))
                AS scored_prospective_prediction_count,
              (SELECT prediction FROM latest_prediction) AS latest_prediction`,
    [interval, WATERX_CANDIDATE_ARTIFACT_VERSION]);
    const summary = rows[0];
    if (!summary) throw new Error("WaterX candidate status query returned no summary row.");
    const attempt = objectOrNull(summary.latest_attempt);
    const scheduledAttempt = objectOrNull(summary.latest_scheduled_attempt);
    const report = objectOrNull(attempt?.report);
    const latestArtifactRow = objectOrNull(summary.latest_candidate_artifact);
    const artifact = objectOrNull(latestArtifactRow?.artifact);
    const accepted = objectOrNull(summary.latest_accepted_settlement);
    const latestPrediction = objectOrNull(summary.latest_prediction);
    const attemptedAt = attempt?.created_at
      ? new Date(attempt.created_at).toISOString() : null;
    const scheduledAttemptAt = scheduledAttempt?.created_at
      ? new Date(scheduledAttempt.created_at).toISOString() : null;
    const candidateSchedulingConfigured = process.env.NODE_ENV === "development" ||
      (process.env.NODE_ENV === "production" &&
        process.env.WATERX_CANDIDATE_SCHEDULE_ENABLED === "true");
    const nextEligibleRunAt = scheduledAttemptAt
      ? new Date(new Date(scheduledAttemptAt).getTime() + 24 * 60 * 60_000).toISOString()
      : null;
    const candidateModelVersion = typeof artifact?.modelVersion === "string"
      ? artifact.modelVersion : null;
    const hasStoredCandidateArtifact = artifact !== null;
    const trainingDatasetSize = Number(report?.split?.trainCount ?? 0);
    const acceptedLabelDatasetSize = Number(report?.acceptedLabelCount ?? 0);
    const trainingSnapshotCount = Number(report?.recordCount ?? 0);
    const prospectivePredictionCount = Number(summary.prospective_prediction_count ?? 0);
    const featureSnapshotCount = Number(summary.feature_snapshot_count ?? 0);
    const scoredProspectivePredictionCount = Number(
      summary.scored_prospective_prediction_count ?? 0);
    const datasetFingerprint = typeof report?.datasetFingerprint === "string"
      ? report.datasetFingerprint
      : typeof attempt?.dataset_hash === "string" ? attempt.dataset_hash : null;
    const noAttemptReason = "No offline candidate training attempt has been recorded yet.";
    const rejectionReason = report?.rejectionReason ??
      attempt?.rejection_reason ?? noAttemptReason;
    const prospectiveCapture = featureSnapshotCount === 0
      ? {
        status: "blocked",
        snapshotCount: 0,
        blockingReason:
          "No prospective feature snapshots are persisted. The exact per-round capture skip reason is not retained, so the available API/database evidence cannot distinguish an unconfirmed first-round anchor or odds, missing fresh Coinbase lookback coverage, expiry before insertion, or unavailable capture schema.",
        requiredGates: [
          "Confirmed WaterX anchor and the immutable first WaterX probability observed on the same pre-expiry poll.",
          "Complete Coinbase tick evidence for the three-minute pre-prediction window, with source and receive timestamps no later than prediction time and no gaps over 15 seconds.",
          "Snapshot insertion before round expiry into the existing candidate schema.",
        ],
        nextEvidence: "Thrown capture/database failures can appear in collector logs, but normal skip reasons returned by the capture helper are currently discarded. No per-round historical cause can be reconstructed from the snapshot count alone.",
      }
      : {
        status: "snapshots-persisted",
        snapshotCount: featureSnapshotCount,
        blockingReason: prospectivePredictionCount === 0
          ? "Feature snapshots exist, but none embeds a qualified candidate prediction from an interval-matched candidate artifact already persisted before prediction time."
          : null,
        requiredGates: [],
        nextEvidence: null,
      };
    return {
      status: report?.status ?? attempt?.status ?? "insufficient",
      reason: report ? undefined : noAttemptReason,
      attemptedAt,
      lastTrainingAttempt: attemptedAt,
      lastTrainingOutcome: attempt?.status ?? "not-run",
      trainingJob: {
        runner: "scripts/train-waterx-candidate.ts",
        command: "npm run train:waterx",
        trigger: process.env.NODE_ENV === "development"
          ? "development worker: daily evaluation with persisted per-interval eligibility/cadence; also supports manual/offline invocation"
          : process.env.NODE_ENV === "production" && candidateSchedulingConfigured
            ? "configured for daily evaluation by a dedicated leased worker; persisted per-interval eligibility/cadence still applies"
            : process.env.NODE_ENV === "production"
              ? "manual/offline invocation only; production scheduling is disabled unless WATERX_CANDIDATE_SCHEDULE_ENABLED=true"
              : "manual/offline invocation only; no automatic candidate-training scheduler is configured",
      },
      candidateScheduling: {
        configured: candidateSchedulingConfigured,
        workerRequirement: "dedicated leased worker",
        lastScheduledAttemptAt: scheduledAttemptAt,
        nextEligibleRunAt: candidateSchedulingConfigured ? nextEligibleRunAt : null,
      },
      artifactVersion: report?.artifactVersion ?? artifact?.artifactVersion ?? null,
      datasetFingerprint,
      recordCount: trainingSnapshotCount,
      acceptedLabelCount: trainingDatasetSize,
      trainingDatasetSize,
      acceptedLabelDatasetSize,
      trainingSnapshotCount,
      featureSnapshotCount,
      prospectiveCapture,
      authoritativeAcceptedLabelCount: Number(summary.accepted_label_count ?? 0),
      lastAcceptedSettlement: accepted ? {
        roundId: accepted.round_id,
        outcome: accepted.outcome,
        settledAt: accepted.settled_at === null ? null : Number(accepted.settled_at),
        labelAvailableAt: accepted.settlement_observed_at
          ? new Date(accepted.settlement_observed_at).toISOString() : null,
      } : null,
      candidateModelVersion,
      candidateArtifactDatasetFingerprint: artifact?.datasetFingerprint ?? null,
      candidateArtifactTrainedAt: latestArtifactRow?.created_at
        ? new Date(latestArtifactRow.created_at).toISOString() : null,
      modelArtifactPersisted: hasStoredCandidateArtifact,
      calibrationVersion: hasStoredCandidateArtifact
        ? WATERX_CANDIDATE_CALIBRATION_VERSION : null,
      prospectiveModelPredictionCount: prospectivePredictionCount,
      prospectivePredictionStatus: prospectivePredictionCount > 0
        ? "recorded" : "none",
      scoredProspectivePredictionCount,
      unscoredProspectivePredictionCount: Math.max(
        0, prospectivePredictionCount - scoredProspectivePredictionCount),
      prospectivePredictionLabelAvailabilityPercent: prospectivePredictionCount
        ? Number((scoredProspectivePredictionCount / prospectivePredictionCount * 100).toFixed(2))
        : 0,
      latestProspectivePrediction: latestPrediction,
      prospectivePredictionNote:
        "Research-only probabilities are embedded in immutable pre-settlement feature snapshots. Label-availability percentage covers recorded predictions only, not every scheduled or eligible round; these are not serving forecasts.",
      rejectionReason,
      split: report?.split ?? null,
      candidateTestMetrics: report?.candidateTestMetrics ?? null,
      matchingMarketTestMetrics: report?.matchingMarketTestMetrics ?? null,
      matchedTestComparison: report?.matchedTestComparison ?? null,
      testRegimeEvaluations: report?.testRegimeEvaluations ?? [],
      forwardPredictionEvaluation: report?.forwardPredictionEvaluation ?? null,
      promoted: false,
      currentChampion: null,
      championStatus: "none",
      promotionStatus: "disabled",
      promotionRejectionReason: report?.promotionRejectionReason ??
        "No candidate is serving; promotion is intentionally disabled.",
    };
  } catch (error) {
    if (error && typeof error === "object" &&
        ["42P01", "42703", "3F000"].includes(String((error as { code?: unknown }).code)))
      return { status: "unavailable", reason: "Candidate audit schema is not installed in this environment.", promoted: false };
    throw error;
  }
}