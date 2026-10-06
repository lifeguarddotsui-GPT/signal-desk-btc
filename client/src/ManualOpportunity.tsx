import * as React from "react";
import { RefreshCw } from "lucide-react";
import type { RoundDecision } from "../../shared/round-decision";
import type { AtomicDecisionView } from "./live-decision-contract";

type Interval = 5 | 15;
type RoundIdentity = { id: string; startMs: number; expiryMs: number };
type Props = {
  view: AtomicDecisionView;
  now: number;
  interval?: Interval;
  round?: RoundIdentity | null;
  onRetry?: () => void;
  refresh?: { pending: boolean; error: string };
  marketReference?: { price: number | null; quality: string; source: string };
  comparison?: { price: number | null; source: string; receivedAtMs: number | null };
  fixtureName?: string | null;
};

const usd = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Unavailable" : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "—" : `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
const clock = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
const time = (ms: number | null | undefined) => ms == null || !Number.isFinite(ms)
  ? "Time unavailable" : new Date(ms).toLocaleTimeString([], { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " UTC";
const probability = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "—" : `${(value * 100).toFixed(1)}%`;
const identityMatches = (decision: RoundDecision | null, round: RoundIdentity | null) =>
  !!decision && !!round && decision.roundId === round.id && decision.startMs === round.startMs && decision.expiryMs === round.expiryMs;

export function ManualOpportunity({
  view, now, interval = view.decision?.intervalMinutes ?? 5, round, onRetry, refresh,
  marketReference, comparison, fixtureName,
}: Props) {
  const decision = view.decision;
  const exactRound = round !== undefined ? round : (decision ? { id: decision.roundId, startMs: decision.startMs, expiryMs: decision.expiryMs } : null);
  const exactDecision = identityMatches(decision, exactRound) && decision?.intervalMinutes === interval ? decision : null;
  const health = view.dataHealth ?? exactDecision?.dataHealth;
  const saved = exactDecision?.canonical ??
    (exactDecision?.timedDecision?.saved?.status === "LOCKED" ? exactDecision.timedDecision.saved : null);
  const fixtureLocked = fixtureName === "locked";
  const fixtureLeaning = fixtureName === "high-likelihood-up" ? "UP"
    : fixtureName === "high-likelihood-down" ? "DOWN" : null;
  const savedSide = fixtureLocked ? "UP" : saved?.side;
  const locked = savedSide === "UP" || savedSide === "DOWN";
  const fixtureOdds = fixtureName && ["normal", "high-likelihood-up", "high-likelihood-down"].includes(fixtureName)
    ? { probabilityUp: .583, probabilityDown: .417, receivedAtMs: now } : null;
  const exactFresh = !!exactDecision && view.fresh;
  const odds = exactFresh ? exactDecision.market : fixtureOdds;
  const waitingForOdds = !locked && (health?.probabilities.status === "PROBABILITIES_MISSING" ||
    (!exactDecision?.market && /odds missing|probabilities missing/i.test(view.reason)));
  const loading = !!refresh?.pending && !decision;
  const failed = !!refresh?.error;
  const roundRemaining = exactRound && exactRound.expiryMs > now ? clock(exactRound.expiryMs - now) : null;
  const nextEvaluation = exactDecision?.timedDecision?.nextGateAtMs != null
    ? clock(exactDecision.timedDecision.nextGateAtMs - now) : null;
  const currentSide = exactFresh ? view.lean : fixtureLeaning;
  const state = locked ? `LOCKED ${savedSide}`
    : waitingForOdds ? "WAITING FOR ODDS"
      : currentSide ? `LEANING ${currentSide}` : "WATCHING";
  const message = locked
    ? fixtureLocked ? "Synthetic visual state only; production decision authority is unchanged."
      : "This exact-round choice is saved and remains unchanged while live data recovers."
    : fixtureName && fixtureLeaning ? "Synthetic visual state only; production decision authority is unchanged."
      : fixtureName === "normal" ? "Development preview only; live decision polling is intentionally disabled."
    : waitingForOdds ? "No usable WaterX probability input was returned for this round."
      : !exactDecision ? "Waiting for an exact active-round snapshot."
        : !view.fresh ? "Current round evidence is not fresh enough to establish a lean."
          : currentSide ? exactDecision.readiness.reason
            : exactDecision.readiness.reason || "Conditions are still developing.";
  const referencePrice = marketReference?.price ?? null;
  const comparisonPrice = comparison?.price ?? null;
  const priceDifference = referencePrice != null && comparisonPrice != null &&
    Number.isFinite(referencePrice) && referencePrice > 0 && Number.isFinite(comparisonPrice)
    ? comparisonPrice - referencePrice : null;
  const differencePercent = priceDifference != null && referencePrice
    ? priceDifference / referencePrice * 100 : null;
  const confirmed = marketReference?.quality === "confirmed";
  const readiness = exactFresh ? exactDecision.readiness : null;
  const conditions = readiness ? [
    ["Fresh source", readiness.components.fresh],
    ["Stable", readiness.components.stable],
    ["Source healthy", readiness.components.sourceHealthy],
    ["Within round", readiness.components.withinWindow],
  ] as const : [];
  const stale = health?.probabilities.lastValid;
  const staleSameRound = !!exactRound && !!stale &&
    stale.receivedAtMs >= exactRound.startMs && stale.receivedAtMs < exactRound.expiryMs &&
    stale.receivedAtMs <= now;

  return <section className={`manual-opportunity compact-decision${locked ? " is-locked" : ""}`} aria-label="Exact-round research state" aria-busy={loading}>
    <header className="desk-round-header">
      <div><span className="desk-round-symbol">BTC</span><span>· {interval}m</span></div>
      <span className="desk-round-close">{roundRemaining ? `Closes in ${roundRemaining}` : "Round not confirmed"}</span>
    </header>
    <div className="desk-price-strip" aria-label="BTC comparison and WaterX reference prices">
      <div className="desk-price-item">
        <span>BTC comparison</span><strong>{usd(comparisonPrice)}</strong>
        <small>{comparison?.source && comparisonPrice != null ? `Updated ${time(comparison.receivedAtMs)}` : "Waiting for a live comparison"}</small>
      </div>
      <div className="desk-price-item">
        <span>WaterX price to beat</span><strong>{usd(referencePrice)}</strong>
        <small>{confirmed ? "Confirmed round reference" : referencePrice != null ? "Provisional reference" : "Reference unavailable"}</small>
      </div>
      <div className={`desk-price-difference${priceDifference == null ? "" : priceDifference >= 0 ? " is-above" : " is-below"}`}>
        <span>Difference</span>
        <strong>{priceDifference == null ? "—" : `${priceDifference >= 0 ? "+" : "−"}${usd(Math.abs(priceDifference))}`}</strong>
        <small>{differencePercent == null ? "Both prices required" : `${percent(differencePercent)} ${priceDifference! >= 0 ? "above" : "below"} reference`}</small>
      </div>
    </div>
    <div className={`desk-decision-card${locked ? " locked" : ""}`}>
      <div className="desk-decision-main">
        <div className="desk-state-line">
          {!loading && <span className={`desk-state-tag${locked ? " locked" : currentSide ? " leaning" : ""}`} role="status">{state}</span>}
          {exactDecision && <span className="desk-round-version">Round {interval}m · snapshot v{exactDecision.stateVersion}</span>}
        </div>
        {loading ? <div className="desk-skeleton" aria-label="Loading exact-round decision"><i /><i /><i /></div>
          : <p>{message}</p>}
        {failed && <p className="desk-error" role="status">Live snapshot could not refresh. {onRetry && <button type="button" onClick={onRetry}><RefreshCw size={13} /> Retry</button>}</p>}
      </div>
      <div className="desk-decision-side">
        <div className="desk-next-evaluation"><span>{locked ? "Saved choice" : "Next evaluation"}</span><strong>{fixtureLocked ? "Preview only" : locked ? time(saved?.committedAtMs ?? saved?.decisionAtMs) : nextEvaluation ?? "Not scheduled"}</strong></div>
        {!locked && conditions.length > 0 && <div className="desk-checklist" aria-label="Qualification conditions">
          {conditions.map(([label, met]) => <span key={label} className={met ? "met" : ""} title={label} aria-label={`${label}: ${met ? "met" : "not met"}`} />)}
          <small>Qualification conditions</small>
        </div>}
        {!locked && !view.fresh && <small className="desk-checklist-waiting">{waitingForOdds ? "Conditions not evaluated without odds" : "Waiting for current evidence"}</small>}
      </div>
      {odds && <div className="desk-market-odds">
        <span>WaterX market</span><b>UP {probability(odds.probabilityUp)}</b><b>DOWN {probability(odds.probabilityDown)}</b>
        <small>Observed {time(odds.receivedAtMs)}</small>
      </div>}
      {waitingForOdds && <p className="desk-odds-notice" role="status">WaterX odds unavailable. Live BTC chart remains available.</p>}
      {fixtureName && <span className="desk-fixture-indicator">Development visual fixture · {fixtureName.replaceAll("-", " ")}</span>}
    </div>
    <details className="desk-details">
      <summary>Details</summary>
      <div className="desk-details-grid">
        <span>Current odds</span><b>{odds ? `UP ${probability(odds.probabilityUp)} · DOWN ${probability(odds.probabilityDown)}` : "Unavailable"}</b>
        <span>Data condition</span><b>{health?.primaryReason?.replaceAll("_", " ") ?? (exactFresh ? "Current" : "Waiting for snapshot")}</b>
        <span>Decision persistence</span><b>{exactDecision?.persistence.status ?? "Not reported"}</b>
        <span>Saved round choice</span><b>{saved ? `${savedSide} · immutable · ${time(saved.committedAtMs ?? saved.decisionAtMs)}` : fixtureLocked ? "Synthetic visual lock · not saved" : "No saved choice reported"}</b>
        <span>Exact round</span><b>{exactRound?.id ?? "Not available"}</b>
        <span>Strategy</span><b>{view.strategyVersion ?? exactDecision?.policyVersion ?? "Not reported"}</b>
        <span>Projection version</span><b>{view.sourceProjectionVersion ?? view.projectionVersion}</b>
        <span>Snapshot revision</span><b>{view.snapshotVersion == null ? "Not available" : `v${view.snapshotVersion} · ${time(view.componentTimestamps.snapshotPublishedAtMs)}`}</b>
        {staleSameRound && <><span>Last same-round odds</span><b>Stale · UP {probability(stale.up)} · DOWN {probability(stale.down)} · observed {time(stale.receivedAtMs)}</b></>}
        {exactDecision?.timedDecision?.lastGate && <>
          <span>Last gate</span><b>{exactDecision.timedDecision.lastGate.result.replaceAll("_", " ")} · {time(exactDecision.timedDecision.lastGate.scheduledAtMs)}</b>
        </>}
        {exactDecision?.timedDecision?.nextGateAtMs != null && <>
          <span>Next gate</span><b>{time(exactDecision.timedDecision.nextGateAtMs)}</b>
        </>}
        {exactDecision?.dataHealth?.transport.errorClass && <>
          <span>Transport detail</span><b>{exactDecision.dataHealth.transport.errorClass}</b>
        </>}
      </div>
      <p className="desk-detail-note">Market odds are public market observations, not a calibrated probability. BTC comparison is context only and does not forecast settlement.</p>
    </details>
  </section>;
}
