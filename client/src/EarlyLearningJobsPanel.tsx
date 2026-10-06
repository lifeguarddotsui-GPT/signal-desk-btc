import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

type HorizonEvaluation = {
  horizon?: number;
  horizon_seconds?: number;
  status?: string;
  counts?: Record<string, unknown>;
  partitions?: Record<string, unknown>;
  reason?: string;
  artifact?: unknown;
  baseline?: Record<string, unknown>;
  challenger?: Record<string, unknown>;
  promotion?: string;
};
type FunnelRow = {
  roundId?: string;
  startMs?: number;
  horizon?: number;
  primaryReason?: string;
  details?: unknown;
};
type EligibilityFunnel = {
  captured?: number;
  validIdentity?: number;
  timelyFeatures?: number;
  verifiedOutcome?: number;
  correctStrategySchema?: number;
  eligibleHorizon?: number;
  selected?: number;
  excluded?: number | Record<string, unknown>;
  byReason?: Record<string, unknown>;
  rows?: FunnelRow[];
};
type JobReport = {
  reports?: HorizonEvaluation[];
  digestRejected?: number;
  selected?: number;
  promotion?: string;
  stoppingPolicy?: string;
  funnel?: EligibilityFunnel;
  datasetDigest?: string;
  newEligibleSincePreviousAttempt?: number;
  retainedBaselineStatus?: string;
};
type EarlyLearningJob = {
  id: string;
  day: string;
  interval_minutes: number;
  status: string;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  dataset_cutoff_ms: number | null;
  report: JobReport | null;
  error_class: string | null;
};
type HorizonCapture = { interval_minutes: number; horizon_seconds: number; status: string; n: number };
export type EarlyLearningPayload = {
  strategyVersion: string;
  jobs: EarlyLearningJob[];
  horizons: HorizonCapture[];
  modelStatus: string;
  stoppingPolicy: string;
  automaticPromotion: boolean;
};
type LoadState = { data: EarlyLearningPayload | null; loading: boolean; error: string };

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "Not reported";
const stamp = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not reported" : new Date(value).toLocaleString();
const pretty = (value: string | undefined | null) => value ? value.replaceAll("_", " ") : "Not reported";
const stageLabel = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
  .replace(/^./, character => character.toUpperCase());
const horizonLabel = (seconds: number | undefined) => seconds == null || !Number.isFinite(seconds)
  ? "Not reported" : seconds >= 60 ? `${seconds / 60} min` : `${seconds} sec`;
const diagnosticText = (value: unknown) => typeof value === "string" ? value
  : value == null ? "Not reported" : JSON.stringify(value);
const keys = ["eligible", "training", "calibration", "test"] as const;

function HorizonDetails({ horizon }: { horizon: HorizonEvaluation }) {
  const horizonSeconds = horizon.horizon_seconds ?? horizon.horizon;
  const counts = horizon.counts ?? {};
  const partitions = horizon.partitions ?? {};
  const baseline = horizon.baseline ?? {};
  const challenger = horizon.challenger ?? {};
  const metric = (obj: Record<string, unknown>, key: string) => typeof obj[key] === "number" ? Number(obj[key]).toFixed(4) : "Not scored";
  return <details className="early-job-horizon">
    <summary>{count(horizonSeconds)}s · {pretty(horizon.status)}</summary>
    <div className="early-job-horizon-facts">
      {keys.map(key => <span key={key}>{key}<b>{count(counts[key])}</b></span>)}
      {Object.entries(partitions).map(([key, value]) => <span key={key}>{pretty(key)}<b>{typeof value === "number" && /Ms$/.test(key) ? stamp(value) : count(value)}</b></span>)}
      <span>Baseline scored n<b>{count(baseline.n)}</b></span>
      <span>Baseline Brier<b>{metric(baseline, "brier")}</b></span>
      <span>Baseline log loss<b>{metric(baseline, "logLoss")}</b></span>
      <span>Challenger scored n<b>{count(challenger.n)}</b></span>
      <span>Shadow challenger Brier<b>{metric(challenger, "brier")}</b></span>
      <span>Shadow challenger log loss<b>{metric(challenger, "logLoss")}</b></span>
      <span>Horizon promotion<b>{pretty(horizon.promotion)}</b></span>
      {horizon.reason && <p>{horizon.reason}</p>}
      {horizon.artifact != null && <span className="early-job-artifact">Shadow artifact {typeof horizon.artifact === "object" &&
        horizon.artifact && "digest" in horizon.artifact && typeof horizon.artifact.digest === "string"
          ? horizon.artifact.digest : "present"} · not promoted</span>}
    </div>
  </details>;
}

export function EarlyLearningJobsView({ data, loading, error, onRetry }: {
  data: EarlyLearningPayload | null; loading: boolean; error: string; onRetry: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const jobs = data?.jobs ?? [];
  const horizonRows = data?.horizons ?? [];
  const visibleJobs = showAll ? jobs : jobs.slice(0, 5);
  if (!data && loading) return <section className="early-learning-jobs panel" aria-label="Early-horizon training jobs" aria-busy="true">
    <div className="early-jobs-loading"><i /><i /><i /></div><span>Loading recorded early-horizon jobs…</span>
  </section>;
  return <section className="early-learning-jobs panel" aria-labelledby="early-jobs-title">
    <div className="early-jobs-heading">
      <div><span className="eyebrow">EARLY-HORIZON LEARNING · API JOB RECORDS</span><h2 id="early-jobs-title">Training &amp; stopping policy</h2></div>
      <button type="button" className="early-jobs-retry" onClick={onRetry} aria-label="Refresh early learning jobs"><RefreshCw size={13} /> Refresh</button>
    </div>
    {error && <div className="early-jobs-warning" role="status">
      {data ? "Job refresh failed · last successful job report retained." : "Early-learning jobs unavailable."} {error}
      {!data && <button type="button" onClick={onRetry}>Retry</button>}
    </div>}
    {data && <>
      <div className="early-jobs-summary">
        <div><span>MODEL STATUS</span><b className="early-jobs-baseline">{pretty(data.modelStatus)}</b></div>
        <div><span>STRATEGY</span><b>{data.strategyVersion}</b></div>
        <div><span>STOPPING POLICY</span><b>{pretty(data.stoppingPolicy)}</b></div>
        <div><span>AUTOMATIC PROMOTION</span><b>{data.automaticPromotion ? "Enabled by API" : "Disabled"}</b></div>
      </div>
      <div className="early-jobs-boundary"><b>{data.modelStatus === "BASELINE_ONLY" && !data.automaticPromotion
        ? "SHADOW ONLY · BASELINE RETAINED · CANDIDATE ONLY" : `${pretty(data.modelStatus)} · PROMOTION STATUS`}</b>
        <span>{data.automaticPromotion ? "Automatic promotion is enabled by the API contract." : "No early-horizon challenger or learned stopping rule is promoted."}</span>
      </div>
      <div className="early-horizon-capture">
        <div className="early-jobs-subhead"><h3>Prospective horizon capture</h3><span>Observed records by status</span></div>
        {horizonRows.length ? <div className="early-horizon-rows">{horizonRows.map((row, index) =>
          <div key={`${row.interval_minutes}:${row.horizon_seconds}:${row.status}:${index}`}>
            <b>{row.interval_minutes}m · {row.horizon_seconds}s</b><span>{pretty(row.status)}</span><strong>n {count(row.n)}</strong>
          </div>)}</div> : <p className="early-jobs-empty">No horizon captures reported.</p>}
      </div>
      <div className="early-jobs-list">
        <div className="early-jobs-subhead"><h3>Recorded training attempts</h3><span>{jobs.length} returned · newest first</span></div>
        {visibleJobs.length ? visibleJobs.map(job => {
          const report = job.report;
          const evaluations = Array.isArray(report?.reports) ? report.reports : [];
          return <article key={job.id} className={`early-job-row ${job.status.toLowerCase()}`}>
            <div className="early-job-main">
              <span className={`early-job-status ${job.status.toLowerCase()}`}>{pretty(job.status)}</span>
              <b>{job.interval_minutes}m · {job.day}</b>
              <span>Started {stamp(job.started_at_ms)} · finished {stamp(job.finished_at_ms)}</span>
            </div>
            <div className="early-job-facts">
              <span>Dataset cutoff <b>{stamp(job.dataset_cutoff_ms)}</b></span>
              <span>Selected rows <b>{count(report?.selected)}</b></span>
              <span>Digest rejected <b>{count(report?.digestRejected)}</b></span>
              <span>Newly eligible since prior attempt <b>{count(report?.newEligibleSincePreviousAttempt)}</b></span>
              {report?.datasetDigest && <span>Dataset digest <b>{report.datasetDigest}</b></span>}
              <span>Disposition <b>{pretty(report?.promotion)}</b></span>
              <span>Stopping qualification <b>{pretty(report?.stoppingPolicy)}</b></span>
              {report?.retainedBaselineStatus && <span>Retained baseline · candidate only <b>{pretty(report.retainedBaselineStatus)}</b></span>}
              {job.error_class && <span className="early-job-error">Error class <b>{job.error_class}</b></span>}
            </div>
            {report?.funnel && <details className="early-job-funnel">
              <summary>Eligibility funnel &amp; exclusions · diagnostics</summary>
              <div className="early-job-funnel-stages">
                {(["captured", "validIdentity", "timelyFeatures", "verifiedOutcome", "correctStrategySchema", "eligibleHorizon", "selected"] as const)
                  .map(stage => <span key={stage}>{stageLabel(stage)}<b>{count(report.funnel?.[stage])}</b></span>)}
                <span>Excluded<b>{count(report.funnel.excluded)}</b></span>
              </div>
              {report.funnel.byReason && <div className="early-job-funnel-reasons">
                <b>Exclusions by reason</b>
                {Object.entries(report.funnel.byReason).map(([reason, value]) =>
                  <span key={reason}>{pretty(reason)}<b>{diagnosticText(value)}</b></span>)}
              </div>}
              {report.funnel.rows?.length ? <div className="early-job-funnel-rows">
                <b>Excluded round diagnostics · {report.funnel.rows.length} returned</b>
                {report.funnel.rows.map((row, index) => <div key={`${row.roundId ?? "round"}:${row.startMs ?? index}:${index}`}>
                  <span>{row.roundId ?? "Round ID not reported"}</span>
                  <span>{row.startMs == null ? "Start not reported" : stamp(row.startMs)} · {horizonLabel(row.horizon)}</span>
                  <b>{pretty(row.primaryReason)}</b>
                  {row.details != null && <small>{diagnosticText(row.details)}</small>}
                </div>)}
              </div> : <p className="early-job-funnel-empty">No row-level exclusion diagnostics reported.</p>}
            </details>}
            {evaluations.length > 0 ? <div className="early-job-horizons">{evaluations.map((horizon, index) =>
              <HorizonDetails key={`${horizon.horizon_seconds ?? horizon.horizon ?? index}:${index}`} horizon={horizon} />)}</div>
              : <p className="early-job-reason">{job.error_class || "No per-horizon report was recorded for this attempt."}</p>}
          </article>;
        }) : <p className="early-jobs-empty">No early-learning jobs have been recorded by the API.</p>}
        {jobs.length > 5 && <button type="button" className="early-jobs-show-all" onClick={() => setShowAll(value => !value)}>
          {showAll ? "Show latest five" : `Show all ${jobs.length} attempts`}
        </button>}
      </div>
      {loading && <p className="early-jobs-refreshing" role="status">Refreshing job report…</p>}
    </>}
  </section>;
}

export default function EarlyLearningJobsPanel() {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<LoadState>({ data: null, loading: true, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => ({ ...previous, loading: true, error: "" }));
    fetch("/api/waterx/early-learning", {
      credentials: "include", signal: controller.signal, headers: { Accept: "application/json" },
    }).then(async response => {
      const payload = await response.json().catch(() => ({})) as Partial<EarlyLearningPayload> & { error?: string };
      if (!response.ok || typeof payload.strategyVersion !== "string" || !Array.isArray(payload.jobs) ||
        !Array.isArray(payload.horizons) || typeof payload.modelStatus !== "string" ||
        typeof payload.stoppingPolicy !== "string" || typeof payload.automaticPromotion !== "boolean") {
        throw new Error(payload.error || `Early-horizon learning status unavailable (${response.status}).`);
      }
      if (!controller.signal.aborted) setState({ data: payload as EarlyLearningPayload, loading: false, error: "" });
    }).catch(reason => {
      if (!controller.signal.aborted) setState(previous => ({
        data: previous.data, loading: false,
        error: reason instanceof Error ? reason.message : "Early-horizon learning status unavailable.",
      }));
    });
    return () => controller.abort();
  }, [reloadKey]);
  return <EarlyLearningJobsView data={state.data} loading={state.loading} error={state.error}
    onRetry={() => setReloadKey(value => value + 1)} />;
}
