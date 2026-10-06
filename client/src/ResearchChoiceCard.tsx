import * as React from "react";
import { LockKeyhole } from "lucide-react";
import type { ResearchInterval, ResearchReport } from "../../shared/waterx-research";
import type { AtomicDecisionView } from "./live-decision-contract";

type Props = {
  report: ResearchReport | null;
  interval: ResearchInterval;
  round: { id: string; startMs: number; expiryMs: number } | null;
  view: AtomicDecisionView;
  refresh: { pending: boolean; error: string; retryCount: number; failureCount: number };
  retrySnapshot: () => void;
  loading?: boolean;
  error?: string;
  fixture?: boolean;
};

const probability = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) || value < 0 || value > 1
    ? "—" : `${(value * 100).toFixed(1)}%`;
const time = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Time not reported"
  : new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC", hour12: false }) + " UTC";
const elapsed = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not reported"
  : `${Math.floor(Math.max(0, value) / 1000)}s`;

export function ResearchChoiceCard({
  report, interval, round, view, refresh, retrySnapshot, loading = false, error, fixture = false,
}: Props) {
  const decision = view.decision;
  const canonical = decision?.canonical ?? null;
  const freshLean = view.fresh ? view.lean : null;
  const market = view.fresh ? decision?.market ?? null : null;
  const locked = canonical !== null;
  const stageIndex = locked ? 2 : view.fresh && freshLean ? 1 : 0;
  const version = decision ? `v${decision.stateVersion} · ${decision.streamId}` : "No exact snapshot";
  const headline = canonical
    ? `CANONICAL CHOICE: ${canonical.side}`
    : freshLean ? `LEANING ${freshLean}`
      : view.fresh ? "WATCHING" : "CURRENT LEAN WITHHELD";
  const detail = canonical
    ? `Immutable exact-round record · decision ${time(canonical.decisionAtMs)} · ${canonical.committedAtMs == null ? "commit acknowledgement unavailable" : `commit acknowledged ${time(canonical.committedAtMs)}`}`
    : view.fresh ? view.reason
      : `No current lean is asserted. ${view.reason}`;
  const recentHistorical = report?.intervalMinutes === interval
    ? (report.recentChoices ?? []).filter(item => item.roundId !== round?.id &&
        item.state === "FROZEN" && item.side !== null &&
        (item.settlement.state === "correct" || item.settlement.state === "incorrect") &&
        item.settlement.outcome !== null)
      .sort((a, b) => b.decisionAtMs - a.decisionAtMs)[0] ?? null
    : null;
  const operationalWarning = !view.fresh || refresh.failureCount >= 2 ||
    ["QUEUED", "WRITING", "FAILED", "AWAITING_CHOICE"].includes(decision?.persistence.status ?? "WAITING_CHECKPOINT");

  return <section className={`research-choice-card${locked ? " is-final" : ""}${canonical?.side === "UP" ? " choice-up" : canonical?.side === "DOWN" ? " choice-down" : ""}`} aria-label="Atomic exact-round research decision">
    <div className="research-choice-main">
      <div className="research-choice-heading">
        <div>
          <span className="research-choice-kicker">EXACT ROUND · {interval} MIN · SHARED SNAPSHOT</span>
          <h2>One atomic round state</h2>
        </div>
        <span className={`research-lock${locked ? " is-locked" : ""}`}>
          {locked ? <><LockKeyhole size={12} aria-hidden="true" /> CANONICAL</> : "NOT LOCKED"}
        </span>
      </div>
      <ol className="research-lifecycle" aria-label="Atomic round decision progression">
        {(["WATCHING", "LEANING", "CANONICAL", "RESULT"] as const).map((label, index) =>
          <li key={label} className={index === stageIndex ? "is-current" : index < stageIndex ? "is-complete" : ""}>
            <span>{index + 1}</span>{label}
          </li>)}
      </ol>
      <div className={`research-choice-result${locked ? " is-result" : ""}`} aria-live="polite">
        <strong>{headline}</strong><small>{detail}</small>
      </div>
      {canonical && <p className="research-immutable-note">Canonical record retained from this exact round, including during refresh errors.</p>}
      <div className="research-choice-meta">
        <span><b>Round</b>{round?.id ?? "No active metadata round"}</span>
        <span><b>Snapshot</b>{version}</span>
        <span><b>Policy</b>{decision?.policyVersion ?? "Unavailable"}</span>
        <span><b>Market age</b>{view.sourceAgeMs == null ? "Unavailable" : elapsed(view.sourceAgeMs)}</span>
      </div>
      <p className="research-disclaimer">Research state only · no wallet, transaction, order or execution status</p>
      {fixture && <span className="research-fixture-label">SYNTHETIC DEVELOPMENT FIXTURE · NO LIVE SNAPSHOT</span>}
      {refresh.pending && <div className="research-inline-error" role="status">Refreshing exact-round snapshot · retaining the last valid record.</div>}
      {refresh.error && <div className="research-inline-error" role="status">
        Snapshot refresh failed: {refresh.error} {refresh.failureCount >= 2 ? `· ${refresh.failureCount} consecutive failures` : ""}
        <button className="text-button" onClick={retrySnapshot}>Retry snapshot</button>
      </div>}
      {operationalWarning && <div className="research-inline-error" role="status">
        Operational state · {decision?.persistence.status ?? "NO VALID SNAPSHOT"}{refresh.retryCount > 0 ? ` · retry ${refresh.retryCount}` : ""}
      </div>}
      {error && <div className="research-inline-error" role="status">Historical research feed unavailable: {error}</div>}
      {!error && !loading && report?.schemaStatus === "unavailable" && <div className="research-inline-error" role="status">Historical research context unavailable: {report.reason || "No report reason supplied."}</div>}
      {recentHistorical && <details className={`research-previous-result ${recentHistorical.settlement.state === "correct" ? "is-correct" : "is-incorrect"}`}>
        <summary>
          <span>HISTORICAL VERIFIED ROUND · NOT CURRENT STATE</span>
          <strong>{recentHistorical.settlement.state === "correct" ? "CORRECT" : "INCORRECT"} · {recentHistorical.settlement.outcome} settled</strong>
        </summary>
        <div className="research-previous-result-facts">
          <span>Exact round ID<b>{recentHistorical.roundId}</b></span>
          <span>Frozen choice<b>{recentHistorical.side}</b></span>
          <span>Verified outcome<b>{recentHistorical.settlement.outcome}</b></span>
          <span>Choice time<b>{time(recentHistorical.decisionAtMs)}</b></span>
        </div>
      </details>}
    </div>
    <div className="research-choice-side">
      <div className={`research-live-market${market ? " is-current" : " is-unavailable"}`}>
        <span className="research-side-label">LIVE WATERX MARKET · SAME ATOMIC SNAPSHOT</span>
        {market ? <>
          <div><b>UP {probability(market.probabilityUp)}</b><b>DOWN {probability(market.probabilityDown)}</b></div>
          <small>App observed {time(market.receivedAtMs)} · provider odds timestamp unknown</small>
        </> : <small>Withheld · current exact-round source is stale, mismatched, or not received.</small>}
      </div>
      <div className="research-checkpoint-snapshot">
        <span className="research-side-label">CANONICAL RECORD</span>
        {canonical ? <>
          <strong>{canonical.side} · {probability(canonical.side === "UP" ? canonical.probabilityUp : 1 - canonical.probabilityUp)}</strong>
          <small>Immutable decision from state {decision?.stateVersion}; not replaced by a database lean.</small>
        </> : <small className="research-no-snapshot">No canonical record in the atomic snapshot.</small>}
      </div>
      <div className={`research-live-estimate${view.fresh && freshLean ? " is-available" : " is-unavailable"}`}>
        <span className="research-side-label">LIVE LEAN · ATOMIC ROUND VIEW</span>
        {view.fresh && freshLean
          ? <><strong>LEANING {freshLean}</strong><small>{view.stage} · readiness {view.score == null ? "not reported" : `${view.score}/100`} · not win probability</small></>
          : <><strong>WITHHELD</strong><small>{view.reason}</small></>}
      </div>
      <div className="research-snapshot-version">Snapshot identity: {version}</div>
    </div>
  </section>;
}
