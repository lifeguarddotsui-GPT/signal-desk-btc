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
  onIntervalChange?: (interval: Interval) => void;
  onRetry?: () => void;
  refresh?: { pending: boolean; error: string };
  marketReference?: { price: number | null; quality: string; source: string };
  comparison?: { price: number | null; source: string; receivedAtMs: number | null };
  fixtureName?: string | null;
  children?: React.ReactNode;
};

const usd = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Unavailable" : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "—" : `${(value * 100).toFixed(1)}%`;
const clock = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
const time = (ms: number | null | undefined) => ms == null || !Number.isFinite(ms)
  ? "Time unavailable" : new Date(ms).toLocaleTimeString([], { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " UTC";
const identityMatches = (decision: RoundDecision | null, round: RoundIdentity | null) =>
  !!decision && !!round && decision.roundId === round.id && decision.startMs === round.startMs && decision.expiryMs === round.expiryMs;

export function ManualOpportunity({
  view, now, interval = view.decision?.intervalMinutes ?? 5, round, onIntervalChange, onRetry, refresh,
  marketReference, comparison, fixtureName, children,
}: Props) {
  const decision = view.decision;
  const exactRound = round !== undefined ? round : (decision ? { id: decision.roundId, startMs: decision.startMs, expiryMs: decision.expiryMs } : null);
  const exactDecision = identityMatches(decision, exactRound) && decision?.intervalMinutes === interval ? decision : null;
  const exactFresh = !!exactDecision && view.fresh;
  const timed = exactDecision?.timedDecision ?? null;
  const health = exactDecision ? view.dataHealth ?? exactDecision.dataHealth : undefined;
  // The shared projection owns the saved choice. Do not fall back to legacy canonical data here.
  const savedProjection = exactDecision ? view.savedDecision : null;
  const saved = savedProjection && "status" in savedProjection ? savedProjection : null;
  const fixtureLocked = fixtureName === "locked";
  const fixtureLean = fixtureName === "high-likelihood-up" ? "UP"
    : fixtureName === "high-likelihood-down" ? "DOWN" : null;
  const savedSide = fixtureLocked ? "UP" : saved?.side ?? null;
  const locked = saved?.status === "LOCKED" && (savedSide === "UP" || savedSide === "DOWN");
  const currentSide = exactFresh ? view.provisionalLean : fixtureLean;
  const fixtureOdds = fixtureName && ["normal", "high-likelihood-up", "high-likelihood-down"].includes(fixtureName)
    ? { probabilityUp: .583, probabilityDown: .417, receivedAtMs: now } : null;
  const odds = exactFresh ? exactDecision.market : fixtureOdds;
  const waitingForOdds = !odds && (health?.probabilities.status === "PROBABILITIES_MISSING" ||
    (!exactDecision?.market && /odds missing|probabilities missing/i.test(view.reason)));
  const loading = !!refresh?.pending && !decision;
  const failed = !!refresh?.error;
  const roundRemaining = exactRound && exactRound.expiryMs > now ? clock(exactRound.expiryMs - now) : null;
  const roundComplete = !!exactRound && now >= exactRound.expiryMs;
  const nextGateAtMs = exactDecision ? view.nextGateAtMs ?? timed?.nextGateAtMs ?? null : null;
  const nextGate = nextGateAtMs != null ? clock(nextGateAtMs - now) : null;
  const saving = !!exactDecision && !locked && (timed?.persistence === "SAVING" || view.persistenceState === "WRITING" || view.persistenceState === "QUEUED");
  const state = fixtureLocked ? "LOCKED UP"
    : locked ? `LOCKED ${savedSide}`
      : saving ? "SAVING"
        : roundComplete ? "ROUND COMPLETE"
          : currentSide ? `LEANING ${currentSide}` : "WATCHING";
  const blocker = !exactDecision ? "Waiting for an exact active-round snapshot."
    : timed?.remainingRequirement && timed.remainingRequirement !== "Evidence qualifies; evaluated only at a scheduled gate"
    ? timed.remainingRequirement
    : timed?.blocker && timed.blocker !== "CONDITIONS_SATISFIED"
      ? timed.blocker.replaceAll("_", " ").toLowerCase()
        : !view.fresh ? view.reason || "Live evidence is stale; provisional lean withheld."
          : "Waiting for the next 30-second qualification gate.";
  const message = fixtureName
    ? "Development visual fixture only. Research display does not authorize a trade."
    : locked
      ? "Saved decision is frozen for this exact round. WaterX market odds continue to update separately."
      : saving
        ? "The qualifying choice is being persisted. It is not locked until acknowledged."
        : roundComplete ? "Round complete. No new decision can be inferred from this round."
          : blocker;
  const referencePrice = marketReference?.price ?? exactDecision?.opportunity?.reference.price ?? null;
  const comparisonPrice = comparison?.price ?? null;
  const priceDifference = referencePrice != null && comparisonPrice != null &&
    Number.isFinite(referencePrice) && referencePrice > 0 && Number.isFinite(comparisonPrice)
    ? comparisonPrice - referencePrice : null;
  const differencePercent = priceDifference != null && referencePrice
    ? priceDifference / referencePrice * 100 : null;
  const confirmed = marketReference?.quality === "confirmed" || exactDecision?.opportunity?.reference.status === "confirmed";
  const frozenUp = saved?.probabilityUp ?? null;
  const frozenDown = saved?.probabilityDown ?? (frozenUp == null ? null : 1 - frozenUp);
  const requirementMet = timed?.requirementsMet ?? null;
  const requirementsTotal = timed?.requirementsTotal ?? 4;
  const components = timed?.components;
  const qualified = [
    exactFresh && (timed?.sourceAgeMs == null || timed.sourceAgeMs <= 10_000),
    !!components && components.strength >= components.requiredStrength,
    !!components && components.sameSideMs >= components.requiredSameSideMs,
    !!components && components.validCount >= components.requiredCount &&
      (components.recentReversals ?? 0) === 0 &&
      (components.probabilityRange == null || components.probabilityRange <= components.maximumRange || components.trendKind === "STRENGTHENING"),
  ];
  const savedSource = saved?.status === "LOCKED"
    ? "Frozen WaterX market probability · not a calibrated forecast" : null;
  const stale = health?.probabilities.lastValid;
  const staleSameRound = !!exactRound && !!stale &&
    stale.receivedAtMs >= exactRound.startMs && stale.receivedAtMs < exactRound.expiryMs &&
    stale.receivedAtMs <= now;

  return <section className={`manual-opportunity compact-decision${locked ? " is-locked" : ""}`} aria-label="Exact-round research state" aria-busy={loading}>
    <header className="desk-round-header">
      <div className="desk-round-identity">
        <span className="desk-round-symbol">BTC</span><span>· {interval}m</span>
        {onIntervalChange && <div className="desk-interval-control" role="group" aria-label="Research interval">
          {([5, 15] as const).map(value => <button key={value} type="button" aria-pressed={interval === value} onClick={() => onIntervalChange(value)}>{value}m</button>)}
        </div>}
      </div>
      <span className="desk-round-close">{roundComplete ? "Round complete" : roundRemaining ? `Closes in ${roundRemaining}` : "Round not confirmed"}</span>
    </header>

    <div className="desk-percentage-board" aria-label="WaterX market odds">
      <div className="desk-probability probability-up"><span>UP</span><strong>{odds ? percent(odds.probabilityUp) : "—"}</strong></div>
      <div className="desk-probability probability-down"><span>DOWN</span><strong>{odds ? percent(odds.probabilityDown) : "—"}</strong></div>
      <div className="desk-probability-source">
        <span>WaterX market</span>
        <small>{odds ? `Observed ${time(odds.receivedAtMs)}` : waitingForOdds ? "Odds unavailable · awaiting recovery" : "Waiting for current-round odds"}</small>
      </div>
      {locked && <div className="desk-frozen-evidence">
        <span>Saved lock · {savedSide}</span>
        <strong>UP {percent(frozenUp)} <i>·</i> DOWN {percent(frozenDown)}</strong>
        <small>{savedSource} · saved {time(saved?.committedAtMs ?? saved?.decisionAtMs)}</small>
      </div>}
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
        <div className="desk-next-evaluation"><span>{locked ? "Saved choice" : "Next gate"}</span><strong>{fixtureLocked ? "Preview only" : locked ? time(saved?.committedAtMs ?? saved?.decisionAtMs) : nextGate ?? "Not scheduled"}</strong></div>
        {!locked && <div className="desk-checklist" aria-label={`Qualification progress: ${requirementMet ?? "—"} of ${requirementsTotal} conditions met`}>
          {qualified.map((met, index) => <span key={index} className={met ? "met" : ""} title={["Fresh input", "Directional strength", "Same-side persistence", "Stable evidence"][index]} />)}
          <small>{requirementMet == null ? "Qualification" : `${requirementMet} of ${requirementsTotal} conditions`}</small>
        </div>}
      </div>
      <div className={`desk-data-health${exactFresh ? " current" : ""}`}>
        <span>MARKET DATA</span><b>{health?.probabilities.status?.replaceAll("_", " ") ?? (exactFresh ? "CURRENT" : "UNAVAILABLE")}</b>
      </div>
      {waitingForOdds && <p className="desk-odds-notice" role="status">WaterX market odds unavailable. UP and DOWN positions remain visible; no model substitutes for market input.</p>}
      {fixtureName && <span className="desk-fixture-indicator">Development visual fixture · {fixtureName.replaceAll("-", " ")}</span>}
    </div>

    <div className="desk-price-strip" aria-label="BTC comparison and WaterX reference prices">
      <div className="desk-price-item">
        <span>BTC comparison</span><strong>{usd(comparisonPrice)}</strong>
        <small>{comparison?.source && comparisonPrice != null ? `Updated ${time(comparison.receivedAtMs)}` : "Waiting for a live comparison"}</small>
      </div>
      <div className="desk-price-item">
        <span>WaterX price to beat</span><strong>{usd(referencePrice)}</strong>
        <small>{confirmed ? "Confirmed round reference" : referencePrice != null ? "Provisional WaterX reference" : "Reference unavailable"}</small>
      </div>
      <div className={`desk-price-difference${priceDifference == null ? "" : priceDifference >= 0 ? " is-above" : " is-below"}`}>
        <span>Difference</span>
        <strong>{priceDifference == null ? "—" : `${priceDifference >= 0 ? "+" : "−"}${usd(Math.abs(priceDifference))}`}</strong>
        <small>{differencePercent == null ? "Both prices required" : `${differencePercent >= 0 ? "+" : "−"}${Math.abs(differencePercent).toFixed(2)}% from reference`}</small>
      </div>
    </div>
    {children}
    <details className="desk-details">
      <summary>Details</summary>
      <div className="desk-details-grid">
        <span>Live odds source</span><b>{odds ? "WaterX market" : "Unavailable; no trained-model fallback"}</b>
        <span>Data condition</span><b>{health?.primaryReason?.replaceAll("_", " ") ?? (view.fresh ? "Current" : "Waiting for snapshot")}</b>
        <span>Saved round choice</span><b>{saved ? `${savedSide ?? "No side"} · immutable · ${time(saved.committedAtMs ?? saved.decisionAtMs)}` : fixtureLocked ? "Synthetic visual lock · not saved" : "No saved choice reported"}</b>
        {saved && <><span>Frozen probability</span><b>{savedSource} · UP {percent(frozenUp)} · DOWN {percent(frozenDown)}</b></>}
        <span>Exact round</span><b>{exactRound?.id ?? "Not available"}</b>
        <span>Strategy</span><b>{exactDecision ? view.strategyVersion ?? exactDecision.policyVersion : "Not reported"}</b>
        <span>Timed blocker</span><b>{timed?.blocker?.replaceAll("_", " ") ?? "Not reported"}</b>
        {timed?.lastGate && <><span>Last gate</span><b>{timed.lastGate.result.replaceAll("_", " ")} · {time(timed.lastGate.scheduledAtMs)}</b></>}
        {nextGateAtMs != null && <><span>Next gate</span><b>{time(nextGateAtMs)}</b></>}
        {staleSameRound && <><span>Last same-round odds</span><b>Stale · UP {percent(stale.up)} · DOWN {percent(stale.down)} · observed {time(stale.receivedAtMs)}</b></>}
        <span>Snapshot revision</span><b>{!exactDecision || view.snapshotVersion == null ? "Not available" : `v${view.snapshotVersion} · ${time(view.componentTimestamps.snapshotPublishedAtMs)}`}</b>
      </div>
      <p className="desk-detail-note">This is read-only market research, not a forecast or trading instruction. Comparison price does not determine WaterX settlement. Automatic execution is disabled.</p>
    </details>
  </section>;
}
