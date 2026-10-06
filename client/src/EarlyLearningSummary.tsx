import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

type Interval = 5 | 15;
type TrainingReport = {
  status?: string;
  reason?: string;
  counts?: { training?: number; calibration?: number; test?: number; eligible?: number };
  verifiedTrainingRounds?: number;
  trainingRounds?: number;
};
type JobReport = {
  nextEligibility?: {horizon?:number;training?:number;calibration?:number;test?:number}[];
  reports?: TrainingReport[];
  stopping?: {
    status?: string; reason?: string;
    test?: { roundN?: number; decisionN?: number; coverage?: number | null; meanElapsedSeconds?: number | null; forecast?: { brier?: number | null } };
    heldOutCriteriaPassed?: boolean;
  };
  pooled?: TrainingReport;
  funnel?: { verifiedRounds?: number; uniqueVerifiedRounds?: number };
  verifiedTrainingRounds?: number;
  trainingRounds?: number;
};
type Job = {
  interval_minutes?: number | string;
  interval?: number | string;
  started_at_ms?: number | string;
  finished_at_ms?: number | string | null;
  status?: string;
  error_class?: string | null;
  report?: JobReport | string | null;
};
type Payload = {
  strategyVersion?: string;
  jobs?: Job[];
  modelStatus?: string;
  stoppingPolicy?: string;
  automaticPromotion?: boolean;
  scheduler?: {limitation?: string};
  error?: string;
};
type Props = { interval: Interval };

const displayTime = (value?: number | string | null) => {
  if (value == null) return "Not reported";
  const parsed = typeof value === "number" ? value : Number(value);
  const date = Number.isFinite(parsed) ? new Date(parsed) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC" : "Not reported";
};
const formatPct = (value?: number | null) => value == null || !Number.isFinite(value) ? "Not reported" : `${(value * 100).toFixed(1)}%`;
const parseReport = (report: Job["report"]): JobReport | null => {
  if (!report) return null;
  if (typeof report === "string") {
    try { return JSON.parse(report) as JobReport; } catch { return null; }
  }
  return report;
};
export function trainingEvidenceFacts(jobs: Job[]) {
  const trained = jobs.find(job => job.status === "EVALUATED");
  const report = parseReport((trained ?? jobs[0])?.report);
  const counts = (report?.reports ?? []).map(r => r.counts?.training)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0);
  return {
    trainedAt: trained ? trained.finished_at_ms ?? trained.started_at_ms : null,
    rounds: report?.verifiedTrainingRounds ?? report?.trainingRounds ??
      (counts.length ? Math.max(...counts) : null),
  };
}

export default function EarlyLearningSummary({ interval }: Props) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError("");
    fetch("/api/waterx/early-learning", { signal: controller.signal })
      .then(async response => {
        const data = await response.json().catch(() => ({})) as Payload;
        if (!response.ok) throw new Error(data.error || `Learning summary unavailable (${response.status})`);
        return data;
      })
      .then(data => { if (active) { setPayload(data); setLoading(false); } })
      .catch(reason => {
        if (active && reason?.name !== "AbortError") {
          setError(reason instanceof Error ? reason.message : "Learning summary unavailable");
          setPayload(null);
          setLoading(false);
        }
      });
    return () => { active = false; controller.abort(); };
  }, [interval, retry]);

  const jobs = (payload?.jobs ?? []).filter(job => Number(job.interval_minutes ?? job.interval) === interval);
  const latest = jobs[0] ?? null;
  const latestReport = parseReport(latest?.report);
  const {trainedAt,rounds:roundsReported} = trainingEvidenceFacts(jobs);
  const reports = latestReport?.reports ?? [];
  const insufficient = reports.find(item => item.status === "INSUFFICIENT" && item.reason)?.reason ??
    latestReport?.pooled?.reason ??
    (latest?.status === "INSUFFICIENT" ? reports.find(item => item.reason)?.reason : null) ??
    (latest?.status === "FAILED" ? latest.error_class ?? "The latest training job failed; no alternative reason was returned." : null);
  const stopping = latestReport?.stopping;
  const stoppingTest = stopping?.test;
  const stoppedChoiceEvidence = stopping?.status === "EVALUATED" && stoppingTest
    ? `${stoppingTest.decisionN ?? "—"} decisions from ${stoppingTest.roundN ?? "—"} verified rounds · coverage ${formatPct(stoppingTest.coverage)} · mean lock time ${stoppingTest.meanElapsedSeconds == null ? "not reported" : `${stoppingTest.meanElapsedSeconds.toFixed(0)}s`}`
    : null;

  return <section className="early-learning-panel" aria-labelledby="early-learning-title" aria-busy={loading}>
    <header className="timed-research-heading">
      <div><span className="research-eyebrow">SHADOW LEARNING · {interval}M</span><h2 id="early-learning-title">Early-decision learning</h2>
        <p>Training status is evidence about research readiness, not a claim of better predictions.</p></div>
      <button type="button" className="research-retry" onClick={() => setRetry(value => value + 1)} aria-label="Refresh early-learning summary"><RefreshCw size={14} /> Refresh</button>
    </header>
    {loading && !payload ? <div className="research-skeleton" aria-label="Loading learning summary"><i /><i /><i /></div> :
      error ? <div className="research-error" role="status">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></div> :
        <>
          <div className="learning-status-grid">
            <div><span>Last trained</span><strong>{trainedAt == null ? "Not yet trained" : displayTime(trainedAt)}</strong></div>
            <div><span>Verified training rounds</span><strong>{roundsReported == null ? "Not reported" : roundsReported.toLocaleString()}</strong><small>Largest fit cohort; checkpoints not summed</small></div>
            <div><span>Current model</span><strong>Experimental market baseline</strong><small>Challengers remain shadow-only</small></div>
            <div><span>Earlier-decision performance</span><strong>{stoppedChoiceEvidence ?? "Not qualified for a performance claim"}</strong></div>
          </div>
          <div className="learning-model-note">
            <strong>Current method: deterministic 30-second qualification gates v3</strong>
            <span>Market probabilities are not a trained Bluewater forecast. No model challenger is active; promotion is not automatic.</span>
          </div>
          <div className={`learning-insufficient${insufficient ? "" : " no-reason"}`}>
            <span>{latest?.status === "INSUFFICIENT" || insufficient ? "Exact training limitation" : "Training eligibility"}</span>
            <p>{insufficient ?? (latest ? "No insufficient-data reason was returned for the latest job." : "No training job is available for this interval yet.")}</p>
            {latestReport?.nextEligibility?.[0] && <p>
              Next eligibility · {latestReport.nextEligibility[0].horizon}s forecast:{" "}
              {latestReport.nextEligibility[0].training ?? "unreported"} more training,{" "}
              {latestReport.nextEligibility[0].calibration ?? "unreported"} more calibration,{" "}
              {latestReport.nextEligibility[0].test ?? "unreported"} more test rounds, with both outcome classes in each partition.
            </p>}
          </div>
          <p className="research-footnote">{payload?.stoppingPolicy ?? "A challenger needs chronological validation and full-sequence evidence before any promotion."} {payload?.automaticPromotion === false ? "Automatic promotion is disabled." : ""}</p>
          {payload?.scheduler?.limitation && <p className="research-footnote">{payload.scheduler.limitation}</p>}
        </>}
  </section>;
}
