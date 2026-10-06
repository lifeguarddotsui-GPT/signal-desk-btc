import * as React from "react";
import { RefreshCw } from "lucide-react";
import type { RoundDecision } from "../../shared/round-decision";
import type { LockReadiness, LockReadinessReport } from "../../shared/lock-readiness";
import type { ResearchInterval } from "../../shared/waterx-research";
import type { AtomicDecisionView } from "./live-decision-contract";

export type RoundDecisionEvidence = RoundDecision;

type RoundDecisionProps = {
  view: AtomicDecisionView;
  interval: ResearchInterval;
  round: { id: string; startMs: number; expiryMs: number } | null;
  now: number;
  browserReceivedAtMs: number;
  refresh: { pending: boolean; error: string; retryCount: number; failureCount: number };
  retry?: () => void;
  simulated?: boolean;
  historicalReport?: LockReadinessReport | null;
  historicalLoading?: boolean;
  historicalError?: string;
  retryHistorical?: () => void;
};

const decisionStamp = (ms: number | null | undefined) => ms == null || !Number.isFinite(ms)
  ? "Not reported"
  : new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC", hour12: false }) + " UTC";

export function RoundDecisionPanel({
  view, interval, round, now, browserReceivedAtMs, refresh,
  retry, simulated = false, historicalReport = null, historicalLoading = false, historicalError, retryHistorical,
}: RoundDecisionProps) {
  const decision = view.decision;
  const readiness = decision?.readiness ?? null;
  const fresh = view.fresh;
  const score = fresh ? view.score : null;
  const state = fresh ? view.stage : "WATCHING";
  const stage = state === "READY" ? 2 : state === "LEANING" || state === "BUILDING LOCK" ? 1 : 0;
  const remainingSeconds = round ? Math.max(0, Math.ceil((round.expiryMs - now) / 1000)) : null;
  const countdown = remainingSeconds == null ? "—:—"
    : `${String(Math.floor(remainingSeconds / 60)).padStart(2, "0")}:${String(remainingSeconds % 60).padStart(2, "0")}`;
  const browserTime = browserReceivedAtMs > 0 ? decisionStamp(browserReceivedAtMs) : "Not received";
  const strength = fresh && readiness ? pct(readiness.components.strength) : "—";
  const freshness = view.sourceAgeMs == null ? "Unavailable" : elapsed(view.sourceAgeMs);
  const persistenceStatus = decision?.persistence.status ?? "WAITING";
  const operationalWarning = !fresh || refresh.failureCount >= 2 ||
    ["QUEUED", "WRITING", "FAILED", "AWAITING_CHOICE"].includes(persistenceStatus);
  const canonical = decision?.canonical;

  return <section className={`round-decision-panel${fresh ? " is-current" : ""}`} aria-label="Exact-round decision readiness">
    <header className="round-decision-head">
      <div>
        <span className="research-side-label">ATOMIC ROUND SNAPSHOT · SUI MAINNET · {interval} MIN</span>
        <h2>Round decision readiness</h2>
        <p>One shared server snapshot for readiness, live lean and canonical choice.</p>
      </div>
      <div className="decision-readiness-ring" style={{ "--readiness-angle": `${score ?? 0}%` } as React.CSSProperties} aria-label={`Readiness score ${score == null ? "unavailable" : `${score} out of 100`}`}>
        <strong>{score == null ? "—" : score}</strong><span>/ 100</span>
      </div>
    </header>
    <div className="round-decision-progress">
      <div className="round-progress-top"><span>DECISION PROGRESS</span><b>{score == null ? "WITHHELD" : `${score}%`}</b></div>
      <div className="round-progress-track" role="progressbar" aria-label="Readiness score, not win probability" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score ?? undefined} aria-valuetext={score == null ? "Unavailable" : `${score} of 100`}>
        <i style={{ width: `${score ?? 0}%` }} />
      </div>
      <ol aria-label="Research readiness progression">
        {(["WATCHING", "LEANING", "READY"] as const).map((label, index) =>
          <li key={label} className={`${index < stage ? "is-complete" : ""}${index === stage ? " is-current" : ""}`}><i />{label}</li>)}
      </ol>
    </div>
    <div className="round-decision-facts">
      <article><span>DIRECTION STRENGTH</span><strong>{strength}</strong><small>Signal strength · not win probability</small></article>
      <article><span>STABILITY</span><strong>{fresh && readiness ? readiness.components.stable ? "STABLE" : "UNPROVEN" : "Unavailable"}</strong><small>{fresh && readiness ? `Range ${pct(readiness.components.range)}` : "Exact-round evidence withheld"}</small></article>
      <article><span>FRESHNESS</span><strong>{freshness}</strong><small>Observation age · retained same-round source</small></article>
      <article><span>REVERSALS</span><strong>{fresh && readiness ? readiness.components.reversals : "—"}</strong><small>Recent direction reversals</small></article>
    </div>
    <div className="round-decision-detail">
      <div><span>LIVE LEAN</span><strong>{fresh && view.lean ? `LEANING ${view.lean}` : "WITHHELD"}</strong></div>
      <div><span>SAME-SIDE DURATION</span><strong>{fresh && readiness ? elapsed(readiness.sameSideMs) : "—"}</strong></div>
      <div><span>ROUND CLOSES IN</span><strong className="round-close-clock">{round ? countdown : "—:—"}</strong></div>
    </div>
    <div className="round-decision-blocker"><span>EXACT STATE REASON</span><p>{view.reason}</p></div>
    <div className="round-execution-facts">
      <div><span>LATEST SAFE ORDER TIME</span><strong>Unknown</strong><small>No measured safe-order estimate supplied.</small></div>
      <div><span>EXECUTION WINDOW</span><strong>Unknown</strong><small>Quote-to-accepted-order latency is unmeasured.</small></div>
      <div><span>EXECUTION STATUS</span><strong>NOT ALLOWED</strong><small>No connection, signing, or order state is asserted.</small></div>
    </div>
    <div className="round-decision-blocker execution-blocker"><span>EXACT EXECUTION BLOCKER</span><p>{decision ? decision.executionBlocker : "Withheld until the exact active-round snapshot is available."}</p></div>
    {canonical && <div className="round-canonical">
      <span>CANONICAL DECISION · EXACT ROUND</span>
      <b>{canonical.side}</b>
      <small>{canonical.committedAtMs===null?
        "Committed database record · acknowledgement timestamp not observed in this process":
        `Commit acknowledged ${decisionStamp(canonical.committedAtMs)} · application clock`}</small>
    </div>}
    {simulated && <p className="round-decision-notice">SIMULATION · development fixture active; no live decision evidence is shown.</p>}
    {refresh.pending && <p className="round-decision-notice" role="status">Refreshing snapshot · retained same-round source age {freshness}.</p>}
    {refresh.error && <div className="round-decision-notice" role="status">Advisory refresh failed ({refresh.error}); retained exact-round record is shown only where still valid. {retry && <button className="text-button" onClick={retry}><RefreshCw size={12} /> Retry</button>}</div>}
    {operationalWarning && <p className="round-decision-notice" role="status">
      Operational status · {persistenceStatus}{refresh.failureCount >= 2 ? ` · ${refresh.failureCount} consecutive refresh failures` : ""}{refresh.retryCount ? ` · retry ${refresh.retryCount}` : ""}
    </p>}
    {!simulated && !decision && <p className="round-decision-notice" role="status">{view.reason}</p>}
    <small className="round-browser-receipt">Browser snapshot receipt · local clock {browserTime} · not server time</small>
    {decision?.market && <small className="round-browser-receipt">Last WaterX HTTP receipt · {decisionStamp(decision.market.receivedAtMs)} · application clock · provider odds timestamp unknown</small>}
    {decision && <small className="round-decision-audit">Exact round {decision.roundId} · policy {decision.policyVersion} · state v{decision.stateVersion} · stream {decision.streamId} · published {decisionStamp(decision.publishedAtMs)}</small>}
    {decision && <small className="round-decision-audit">{decision.timestampSemantics}</small>}
    <details className="round-historical-details">
      <summary>Historical readiness comparison · separate research feed</summary>
      <p>Aggregate historical comparison only. This feed does not drive the live readiness score above.</p>
      {historicalError && <div className="lock-inline-error" role="status">Historical comparison unavailable: {historicalError}{retryHistorical && <button className="text-button" onClick={retryHistorical}><RefreshCw size={12} /> Retry</button>}</div>}
      {historicalLoading && !historicalReport && <div className="lock-loading" aria-label="Loading historical comparison"><i /><i /><i /></div>}
      {historicalReport && <LockReadinessPanel report={historicalReport} interval={interval} round={null} now={now} />}
      {!historicalReport && !historicalLoading && !historicalError && <p>No historical comparison report received.</p>}
    </details>
  </section>;
}

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