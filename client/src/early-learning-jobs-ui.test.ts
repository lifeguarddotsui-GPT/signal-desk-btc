import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EarlyLearningJobsView, type EarlyLearningPayload } from "./EarlyLearningJobsPanel";

const report: EarlyLearningPayload = {
  strategyVersion: "waterx-early-baseline-v2",
  modelStatus: "BASELINE_ONLY",
  stoppingPolicy: "Deterministic runtime v2; learned stopping promotion not qualified",
  automaticPromotion: false,
  horizons: [{ interval_minutes: 5, horizon_seconds: 60, status: "FROZEN", n: 37 }],
  jobs: [
    {
      id: "job-early-1", day: "2025-03-11", interval_minutes: 5, status: "INSUFFICIENT",
      started_at_ms: 1741708800000, finished_at_ms: 1741708801500, dataset_cutoff_ms: 1741651200000,
      error_class: null,
      report: {
        selected: 37, digestRejected: 2, promotion: "RETAIN_BASELINE", stoppingPolicy: "NOT_YET_QUALIFIED",
        datasetDigest: "sha256:round-set-a", newEligibleSincePreviousAttempt: 4,
        retainedBaselineStatus: "CANDIDATE_ONLY",
        funnel: {
          captured: 80, validIdentity: 72, timelyFeatures: 68, verifiedOutcome: 54,
          correctStrategySchema: 50, eligibleHorizon: 42, selected: 37, excluded: 43,
          byReason: { IDENTITY_MISMATCH: 8, OUTCOME_UNVERIFIED: 14 },
          rows: [{ roundId: "btc-round-17", startMs: 1741600000000, horizon: 60,
            primaryReason: "OUTCOME_UNVERIFIED", details: { outcome: "pending" } }],
        },
        reports: [{
          horizon_seconds: 60, status: "INSUFFICIENT",
          counts: { eligible: 35, training: 8, calibration: 10, test: 17 },
          partitions: { trainEndMs: 1741305600000, calibrationEndMs: 1741478400000, testEndMs: 1741651200000 },
          reason: "Requires 200 training, 60 calibration, 60 untouched test rounds and both classes per partition.",
        }],
      },
    },
    {
      id: "job-early-2", day: "2025-03-10", interval_minutes: 15, status: "FAILED",
      started_at_ms: 1741622400000, finished_at_ms: 1741622400100, dataset_cutoff_ms: 1741564800000,
      report: null, error_class: "EARLY_QUERY_TIMEOUT",
    },
  ],
};

test("early-horizon panel renders actual insufficient and failed job facts without inventing results", () => {
  const html = renderToStaticMarkup(React.createElement(EarlyLearningJobsView, {
    data: report, loading: false, error: "", onRetry() {},
  }));
  assert.match(html, /BASELINE ONLY/);
  assert.match(html, /SHADOW ONLY · BASELINE RETAINED/);
  assert.match(html, /60s · INSUFFICIENT/);
  assert.match(html, /training.*8/);
  assert.match(html, /Digest rejected.*2/);
  assert.match(html, /NOT YET QUALIFIED/);
  assert.match(html, /EARLY_QUERY_TIMEOUT/);
  assert.match(html, /Dataset cutoff/);
  assert.match(html, /No early-horizon challenger or learned stopping rule is promoted/);
  assert.match(html, /Eligibility funnel &amp; exclusions/);
  assert.match(html, /Valid identity.*72/);
  assert.match(html, /OUTCOME UNVERIFIED.*14/);
  assert.match(html, /btc-round-17/);
  assert.match(html, /1 min/);
  assert.match(html, /CANDIDATE ONLY/);
  assert.match(html, /sha256:round-set-a/);
  assert.match(html, /Newly eligible since prior attempt.*4/);
  assert.doesNotMatch(html, /Learning is active|Training succeeded|Model promoted/);
});

test("an optional early-learning API error retains its last returned jobs", () => {
  const html = renderToStaticMarkup(React.createElement(EarlyLearningJobsView, {
    data: report, loading: false, error: "temporary timeout", onRetry() {},
  }));
  assert.match(html, /Job refresh failed · last successful job report retained/);
  assert.match(html, /waterx-early-baseline-v2/);
  assert.match(html, /EARLY_QUERY_TIMEOUT/);
});

test("no-job response is shown as API-reported absence rather than a mock attempt", () => {
  const empty: EarlyLearningPayload = { ...report, jobs: [], horizons: [] };
  const html = renderToStaticMarkup(React.createElement(EarlyLearningJobsView, {
    data: empty, loading: false, error: "", onRetry() {},
  }));
  assert.match(html, /No early-learning jobs have been recorded by the API/);
  assert.match(html, /No horizon captures reported/);
  assert.doesNotMatch(html, /INSUFFICIENT|FAILED/);
});
