import test from "node:test";
import assert from "node:assert/strict";
import { latestCandidateStatus } from "../server/waterx/candidate-status";

test("candidate status exposes latest evidence and preserves the explicit no-champion safety state", async () => {
  let queriedSql = "";
  const db = {
    async query(sql: string) {
      queriedSql = sql;
      return { rows: [{
        latest_attempt: {
          attempt_id: 7,
          created_at: "2025-01-02T00:00:00.000Z",
          status: "candidate-evaluated",
          report: {
            status: "candidate-evaluated",
            artifactVersion: "waterx-logistic-candidate-v2",
            datasetFingerprint: "a".repeat(64),
            recordCount: 120,
            acceptedLabelCount: 100,
            rejectionReason: "Candidate remains shadow-only.",
            split: { trainCount: 60, calibrationCount: 20, testCount: 20 },
            candidateTestMetrics: { count: 20, brier: 0.21 },
            matchingMarketTestMetrics: { count: 20, brier: 0.23 },
            matchedTestComparison: { count: 20, candidateMinusMarketBrier: { mean: -0.02 } },
            testRegimeEvaluations: [{ dimension: "time-remaining", band: "late-round", count: 4 }],
            promotionRejectionReason: "Promotion is disabled.",
          },
          artifact: {
            artifactVersion: "waterx-logistic-candidate-v2",
            modelVersion: "waterx-logistic-candidate-v2:abc",
            datasetFingerprint: "c".repeat(64),
          },
          promoted: false,
        },
        latest_candidate_artifact: {
          created_at: "2025-01-02T00:00:00.000Z",
          artifact: {
            artifactVersion: "waterx-logistic-candidate-v2",
            modelVersion: "waterx-logistic-candidate-v2:abc",
            datasetFingerprint: "c".repeat(64),
          },
        },
        latest_accepted_settlement: {
          round_id: "last-round",
          outcome: "Up",
          settled_at: 1_735_776_300_000,
          settlement_observed_at: "2025-01-02T00:05:00.000Z",
        },
        latest_prediction: {
          kind: "shadow-candidate",
          modelVersion: "waterx-logistic-candidate-v2:abc",
          probabilityUp: 0.58,
          issuedAtMs: 1_735_776_600_000,
        },
        accepted_label_count: 75,
        feature_snapshot_count: 120,
        prospective_prediction_count: 4,
        scored_prospective_prediction_count: 3,
      }] };
    },
  };

  const status = await latestCandidateStatus(5, db);
  assert.match(queriedSql, /label_status='verified'/);
  assert.match(queriedSql, /settlement_disputed=false/);
  assert.match(queriedSql, /settlement_anchor_price=anchor_price/);
  assert.match(queriedSql, /l\.settlement_anchor_price=s\.confirmed_anchor_price/);
  assert.match(queriedSql, /settled_at > expiry_ms/);
  assert.equal(status.status, "candidate-evaluated");
  assert.equal(status.lastTrainingOutcome, "candidate-evaluated");
  assert.equal(status.trainingDatasetSize, 60);
  assert.equal(status.acceptedLabelDatasetSize, 100);
  assert.equal(status.trainingSnapshotCount, 120);
  assert.equal(status.datasetFingerprint, "a".repeat(64));
  assert.equal(status.lastAcceptedSettlement?.roundId, "last-round");
  assert.equal(status.authoritativeAcceptedLabelCount, 75);
  assert.equal(status.candidateModelVersion, "waterx-logistic-candidate-v2:abc");
  assert.equal(status.candidateArtifactDatasetFingerprint, "c".repeat(64));
  assert.equal(status.candidateArtifactTrainedAt, "2025-01-02T00:00:00.000Z");
  assert.equal(status.modelArtifactPersisted, true);
  assert.equal(status.prospectiveModelPredictionCount, 4);
  assert.equal(status.scoredProspectivePredictionCount, 3);
  assert.equal(status.unscoredProspectivePredictionCount, 1);
  assert.equal(status.prospectivePredictionLabelAvailabilityPercent, 75);
  assert.equal(status.latestProspectivePrediction?.probabilityUp, 0.58);
  assert.equal(status.matchedTestComparison?.count, 20);
  assert.equal(status.testRegimeEvaluations.length, 1);
  assert.match(status.prospectivePredictionNote, /not every scheduled or eligible round/);
  assert.equal(status.promoted, false);
  assert.equal(status.currentChampion, null);
  assert.equal(status.promotionStatus, "disabled");
  assert.match(status.trainingJob.trigger, /no automatic candidate-training scheduler/);
});

test("no attempt or artifact is reported as missing rather than invented", async () => {
  const db = {
    async query() {
      return { rows: [{
        latest_attempt: null,
        latest_accepted_settlement: null,
        latest_prediction: null,
        accepted_label_count: 2,
        feature_snapshot_count: 3,
        prospective_prediction_count: 0,
        scored_prospective_prediction_count: 0,
      }] };
    },
  };
  const status = await latestCandidateStatus(15, db);
  assert.equal(status.status, "insufficient");
  assert.equal(status.lastTrainingOutcome, "not-run");
  assert.equal(status.trainingDatasetSize, 0);
  assert.equal(status.datasetFingerprint, null);
  assert.equal(status.lastAcceptedSettlement, null);
  assert.equal(status.prospectiveModelPredictionCount, 0);
  assert.equal(status.prospectivePredictionStatus, "none");
  assert.equal(status.candidateModelVersion, null);
  assert.equal(status.calibrationVersion, null);
  assert.equal(status.currentChampion, null);
  assert.equal(status.promoted, false);
});

test("missing candidate/learning schema is surfaced as unavailable", async () => {
  const db = {
    async query() {
      throw Object.assign(new Error("missing schema"), { code: "42P01" });
    },
  };
  const status = await latestCandidateStatus(5, db);
  assert.equal(status.status, "unavailable");
  assert.match(status.reason, /schema is not installed/);
});

test("production candidate status reports configured eligibility and persisted schedule timing", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalScheduleEnabled = process.env.WATERX_CANDIDATE_SCHEDULE_ENABLED;
  process.env.NODE_ENV = "production";
  try {
    const previousAttemptAt = "2025-01-02T00:00:00.000Z";
    const db = {
      async query(sql: string) {
        assert.match(sql, /latest_scheduled_attempt/);
        assert.match(sql, /daily-waterx-candidate-v1/);
        return { rows: [{
          latest_attempt: null,
          latest_scheduled_attempt: { created_at: previousAttemptAt },
          latest_candidate_artifact: null,
          latest_accepted_settlement: null,
          latest_prediction: null,
          accepted_label_count: 0,
          feature_snapshot_count: 0,
          prospective_prediction_count: 0,
          scored_prospective_prediction_count: 0,
        }] };
      },
    };
    for (const scenario of [
      { env: undefined, configured: false },
      { env: "false", configured: false },
      { env: "true", configured: true },
    ]) {
      if (scenario.env === undefined) delete process.env.WATERX_CANDIDATE_SCHEDULE_ENABLED;
      else process.env.WATERX_CANDIDATE_SCHEDULE_ENABLED = scenario.env;
      const status = await latestCandidateStatus(5, db);
      assert.equal(status.candidateScheduling.configured, scenario.configured);
      assert.equal(status.candidateScheduling.lastScheduledAttemptAt, previousAttemptAt);
      assert.equal(
        status.candidateScheduling.nextEligibleRunAt,
        scenario.configured ? "2025-01-03T00:00:00.000Z" : null,
      );
      assert.match(status.trainingJob.trigger, scenario.configured
        ? /dedicated leased worker/
        : /production scheduling is disabled/);
    }
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalScheduleEnabled === undefined)
      delete process.env.WATERX_CANDIDATE_SCHEDULE_ENABLED;
    else process.env.WATERX_CANDIDATE_SCHEDULE_ENABLED = originalScheduleEnabled;
  }
});

test("candidate status does not invent an eligible run before any scheduled attempt is persisted", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalScheduleEnabled = process.env.WATERX_CANDIDATE_SCHEDULE_ENABLED;
  process.env.NODE_ENV = "production";
  process.env.WATERX_CANDIDATE_SCHEDULE_ENABLED = "true";
  try {
    const db = {
      async query() {
        return { rows: [{
          latest_attempt: null,
          latest_scheduled_attempt: null,
          latest_candidate_artifact: null,
          latest_accepted_settlement: null,
          latest_prediction: null,
          accepted_label_count: 0,
          feature_snapshot_count: 0,
          prospective_prediction_count: 0,
          scored_prospective_prediction_count: 0,
        }] };
      },
    };
    const status = await latestCandidateStatus(15, db);
    assert.equal(status.candidateScheduling.configured, true);
    assert.equal(status.candidateScheduling.lastScheduledAttemptAt, null);
    assert.equal(status.candidateScheduling.nextEligibleRunAt, null);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalScheduleEnabled === undefined)
      delete process.env.WATERX_CANDIDATE_SCHEDULE_ENABLED;
    else process.env.WATERX_CANDIDATE_SCHEDULE_ENABLED = originalScheduleEnabled;
  }
});