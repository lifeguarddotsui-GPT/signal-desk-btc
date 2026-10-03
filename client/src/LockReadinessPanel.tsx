import * as React from "react";
import type { LockReadinessReport } from "../../shared/lock-readiness";
import type { ResearchInterval } from "../../shared/waterx-research";

type Props = {
  report: LockReadinessReport | null;
  interval: ResearchInterval;
  round: { id: string; startMs: number; expiryMs: number } | null;
  now: number;
  loading?: boolean;
  error?: string;
};

const pct = (n: number | null | undefined, digits = 1) =>
  n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(digits)}%`;
const metric = (n: number | null | undefined, digits = 3) =>
  n == null || !Number.isFinite(n) ? "—" : n.toFixed(digits);
const elapsed = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};
const stamp = (ms: number | null | undefined) => ms == null || !Number.isFinite(ms)
  ? "Not established"
  : new Date(ms).toLocaleTimeString([], { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " UTC";
const safeScore = (score: number) => Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null;

function metrics(n: number, accuracy: number | null, brier: number | null, logLoss: number | null, gained: number | null) {
  return <div className="lock-metrics">
    <span>Matched <b>{n}</b></span><span>Accuracy <b>{pct(accuracy)}</b></span>
    <span>Brier <b>{metric(brier)}</b></span><span>Log loss <b>{metric(logLoss)}</b></span>
    <span>Seconds gained <b>{gained == null ? "—" : `${metric(gained, 1)}s`}</b></span>
  </div>;
}

export function LockReadinessPanel({ report, interval, round, now, loading = false, error }: Props) {
  const exact = !!report && report.intervalMinutes === interval && report.schemaStatus === "available" &&
    report.current?.roundId === round?.id && report.current?.startMs === round?.startMs &&
    report.current?.expiryMs === round?.expiryMs && !!round;
  const current = exact ? report?.current ?? null : null;
  const readiness = current?.readiness;
  const candidate = current?.candidate;
  const age = report ? now - report.asOfMs : null;
  const fresh = exact && report?.researchOnly === true && age != null && age >= -1000 &&
    age <= (current?.policy.maxAgeMs ?? 0) && now < (current?.expiryMs ?? 0);
  const observationAge = readiness?.components.ageMs == null ? null :
    readiness.components.ageMs + Math.max(0, now - readiness.evaluatedAtMs);
  const evidenceFresh = fresh && readiness?.components.fresh === true && observationAge !== null &&
    observationAge <= (current?.policy.maxAgeMs ?? 0);
  const ready = evidenceFresh && readiness?.state === "READY" &&
    now < (current?.expiryMs ?? 0) - (current?.policy.fallbackSeconds ?? 0) * 1000;
  const visibleState = evidenceFresh ? readiness?.state === "READY" && !ready ? "LEANING" : readiness?.state ?? "WATCHING" : "WATCHING";
  const steps = ["WATCHING", "LEANING", "READY", "LOCKED"] as const;
  const step = visibleState === "READY" ? 2 : visibleState === "BUILDING LOCK" ? 1
    : visibleState === "LEANING" ? 1 : 0;
  const liveProbability = readiness?.side === "UP" ? readiness.probability
    : readiness?.side === "DOWN" ? readiness.probability : null;
  const remainingMs = round ? Math.max(0, round.expiryMs - now) : null;
  const secondsLeft = remainingMs == null ? null : Math.ceil(remainingMs / 1000);
  const timeLeft = secondsLeft == null ? "—" : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;
  const speed = current?.speed;

  return <section className="lock-readiness" aria-label="Research lock readiness">
    <header className="lock-readiness-head">
      <div><span className="research-side-label">WATERX BASELINE · RESEARCH-ONLY</span>
        <h3>Lock readiness</h3>
        <p>Decision progress, not win probability. This shadow candidate does not change the canonical round decision.</p>
      </div>
      <div className={`lock-score${ready ? " is-ready" : ""}`} aria-label={`Lock readiness ${fresh && readiness ? safeScore(readiness.score) ?? "not reported" : "not reported"} percent`}>
        <strong>{fresh && readiness ? `${safeScore(readiness.score) ?? "—"}%` : "—"}</strong>
        <span>LOCK READINESS</span>
      </div>
    </header>
    <ol className="lock-research-rail" aria-label="Research progression; LOCKED denotes a shadow candidate, not an official choice">
      {steps.map((label, index) => <li key={label} className={`${index < step ? "is-complete" : ""}${index === step ? " is-current" : ""}${index === 3 && candidate ? " is-candidate" : ""}`}>
        <i aria-hidden="true" />{label}
      </li>)}
    </ol>
    {visibleState === "BUILDING LOCK" && <p className="lock-building">BUILDING LOCK · persistence and stability are still being observed.</p>}
    <div className="lock-health" role="status">
      <b>{evidenceFresh && readiness ? readiness.health : report ? "DATA/COLLECTOR DELAY" : "WAITING FOR EVIDENCE"}</b>
      <span>{fresh ? "Fresh report" : report?.schemaStatus === "unavailable" ? "Readiness schema unavailable" : loading ? "Waiting for first report" : "Report stale, expired, or does not match this round"}</span>
    </div>
    {error && <div className="lock-inline-error" role="status">Readiness feed unavailable: {error}</div>}
    {!error && !loading && report?.schemaStatus === "unavailable" && <div className="lock-inline-error" role="status">{report.reason || "Readiness report unavailable."}</div>}
    {loading && !report && <div className="lock-loading" aria-label="Loading lock readiness"><i /><i /><i /></div>}

    <div className="lock-readiness-grid">
      <article className="lock-direction">
        <span>DIRECTION STRENGTH</span><strong>{fresh && readiness ? pct(readiness.components.strength) : "—"}</strong>
        <small>Required {fresh && readiness ? pct(readiness.components.requiredStrength) : "—"}</small>
      </article>
      <article><span>STABILITY</span><strong>{fresh && readiness ? readiness.components.stable ? "STABLE" : "UNPROVEN" : "—"}</strong>
        <small>{fresh && readiness ? `Range ${pct(readiness.components.range)} · ${readiness.components.reversals} recent reversals` : "Awaiting exact-round evidence"}</small>
      </article>
      <article><span>FRESHNESS</span><strong>{evidenceFresh ? elapsed(observationAge) : "STALE"}</strong>
        <small>{report ? `Observation age · report as of ${stamp(report.asOfMs)}` : "No report received"}</small>
      </article>
      <article><span>RECENT REVERSALS</span><strong>{fresh && readiness ? readiness.components.reversals : "—"}</strong>
        <small>{fresh && readiness ? `Observed / max ${readiness.components.reversals}/${current?.policy.maxReversals ?? "—"}` : "Not reported"}</small>
      </article>
    </div>
    <div className="lock-current">
      <div className="lock-current-side">
        <span>PREFERRED SIDE · CURRENT WATERX PROBABILITY</span>
        <strong>{evidenceFresh && readiness?.side ? `LEANING ${readiness.side} · ${pct(liveProbability)}` : "NO VALID LEAN"}</strong>
      </div>
      <div><span>SAME-SIDE DURATION</span><strong>{fresh && readiness ? elapsed(readiness.sameSideMs) : "—"}</strong></div>
      <div><span>TIME REMAINING</span><strong>{timeLeft}</strong></div>
      <div><span>EARLIEST POSSIBLE CONDITIONAL LOCK</span><strong>{fresh && readiness ? stamp(readiness.earliestPossibleAtMs) : "Not established"}</strong></div>
    </div>
    <div className="lock-reason"><span>READINESS REASON</span><p>{fresh && !evidenceFresh ? "Waiting for fresh WaterX observation" : fresh && readiness ? readiness.reason : report?.reason || "No current exact-round readiness evidence. A stale or expired READY state is withheld."}</p></div>
    {candidate && <div className="lock-shadow-note"><b>SHADOW EARLY CANDIDATE · {candidate.side}</b><span>Recorded at {stamp(candidate.decisionAtMs)}. It is not an official lock; canonical FINAL CHOICE remains governed by the existing lifecycle.</span></div>}
    <p className="lock-probability-note">Lock readiness is not win probability; it is decision progress.</p>
    <div className="lock-shadow-note" role="status"><b>EARLY EXECUTION SIGNAL · SHADOW ONLY</b>
      <span>HOLD / NO VALID EXECUTION SIGNAL. Executable quote, liquidity and BTC side mapping are unverified. No trade is forced.</span>
      <span>Latest safe execution lock: unmeasured. Execution-window countdown: unavailable until WaterX&apos;s actual order deadline and conservative quote-to-accepted-order latency are measured. Round expiry is not assumed to be the order deadline.</span>
    </div>
    <details className="lock-audit">
      <summary>Matched accuracy versus time · {report?.comparison.state === "DESCRIPTIVE_ONLY" ? "descriptive only" : "insufficient matched outcomes"}</summary>
      {report && <div className="lock-audit-content">
        <p className="lock-audit-intro">Actual matched outcomes only. Research candidates do not qualify or alter the model.</p>
        <h4>Overall comparison</h4>
        <div className="lock-comparison">
          <section><b>EARLY CANDIDATE</b>{metrics(report.comparison.early.n, report.comparison.early.accuracy, report.comparison.early.brier, report.comparison.early.logLoss, report.comparison.averageSecondsGained)}</section>
          <section><b>CANONICAL FINAL CHOICE</b>{metrics(report.comparison.canonical.n, report.comparison.canonical.accuracy, report.comparison.canonical.brier, report.comparison.canonical.logLoss, null)}</section>
        </div>
        <div className="lock-differences"><span>Accuracy difference <b>{pct(report.comparison.accuracyDifference)}</b></span><span>Brier difference <b>{metric(report.comparison.brierDifference)}</b></span><span>Log-loss difference <b>{metric(report.comparison.logLossDifference)}</b></span></div>
        <div className="lock-differences"><span>Early remaining <b>{metric(report.comparison.averageSecondsBeforeEarlyLock,1)}s</b></span><span>Canonical remaining <b>{metric(report.comparison.averageSecondsBeforeCanonicalLock,1)}s</b></span><span>Gain vs nominal fallback <b>{metric(report.comparison.averageSecondsGainedVsFallback,1)}s</b></span></div>
        <h4>Checkpoint results</h4>
        {report.checkpoints.length ? <div className="lock-checkpoints">{report.checkpoints.map(item => <article key={item.lockSeconds}>
          <b>{item.lockSeconds}s before close</b><span>Early n={item.early.n} · accuracy {pct(item.early.accuracy)} · Brier {metric(item.early.brier)} · log loss {metric(item.early.logLoss)}</span>
          <span>Canonical n={item.canonical.n} · accuracy {pct(item.canonical.accuracy)} · Brier {metric(item.canonical.brier)} · log loss {metric(item.canonical.logLoss)}</span>
          <span>Seconds gained {item.averageSecondsGained == null ? "—" : `${metric(item.averageSecondsGained, 1)}s`}</span>
        </article>)}</div> : <p>No matched checkpoint outcomes reported.</p>}
        <h4>Market movement since first lean · speed record</h4>
        {speed ? <div className="lock-speed">
          <span>Start to lean <b>{speed.startToLeanSeconds == null ? "—" : `${metric(speed.startToLeanSeconds, 1)}s`}</b></span>
          <span>Lean to final <b>{speed.leanToFinalSeconds == null ? "—" : `${metric(speed.leanToFinalSeconds, 1)}s`}</b></span>
          <span>Remaining at final <b>{speed.secondsRemainingAtFinal == null ? "—" : `${metric(speed.secondsRemainingAtFinal, 1)}s`}</b></span>
          <span>Probability at lean <b>{pct(speed.probabilityAtLean)}</b></span><span>Probability at final <b>{pct(speed.probabilityAtFinal)}</b></span>
          <span>Probability at eligibility <b>{pct(speed.probabilityAtEligibility)}</b></span>
          <span>Movement since lean <b>{speed.marketMovementSinceLean == null ? "—" : `${(speed.marketMovementSinceLean * 100).toFixed(1)} pp`}</b></span>
          <span>Lean range <b>{pct(speed.minProbabilityDuringLean)} – {pct(speed.maxProbabilityDuringLean)}</b></span><span>Reversals <b>{speed.reversals}</b></span>
        </div> : <p>No current-round movement speed record.</p>}
        <h4>Latency and missed windows</h4>
        <div className="lock-latency">{Object.entries(report.latency).length ? Object.entries(report.latency).map(([kind, value]) => <span key={kind}>{kind.replaceAll("_", " ")} · n={value.n} · p50 {value.p50Ms == null ? "—" : `${metric(value.p50Ms, 0)}ms`} · p95 {value.p95Ms == null ? "—" : `${metric(value.p95Ms, 0)}ms`}</span>) : <span>No latency samples reported.</span>}</div>
        {report.missedWindows.length ? <ul className="lock-missed">{report.missedWindows.map((item, index) => <li key={`${item.roundId}-${item.lockSeconds}-${item.atMs}-${index}`}>{item.roundId} · {item.lockSeconds}s window · {item.code}: {item.reason} · {stamp(item.atMs)}</li>)}</ul> : <p>No missed windows reported.</p>}
        <small className="lock-counts">Rounds {report.counts.rounds} · observations {report.counts.observations} · candidates {report.counts.candidates} · matched {report.counts.matched} · {report.source}</small>
      </div>}
    </details>
  </section>;
}