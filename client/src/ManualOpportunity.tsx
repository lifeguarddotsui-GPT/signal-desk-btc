import * as React from "react";
import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { RoundDecision } from "../../shared/round-decision";
import type { TimedDecision, TimedState } from "../../shared/timed-decision";
import { indicativeFiveDollar } from "../../shared/manual-opportunity";
import type { AtomicDecisionView } from "./live-decision-contract";

type Props = {
  view: AtomicDecisionView;
  now: number;
  onRetry?: () => void;
  refresh?: { pending: boolean; error: string };
  browserReceivedAtMs?: number;
};

const stamp = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not reported"
  : new Date(value).toLocaleTimeString([], { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " UTC";
const usd = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value)
  ? "Unknown" : `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) || value < 0 || value > 1
  ? "Unavailable" : `${(value * 100).toFixed(1)}%`;
const duration = (value: number | null | undefined) => value == null || !Number.isFinite(value) || value < 0
  ? "Unknown" : value < 1000 ? `${Math.floor(value)} ms` : `${(value / 1000).toFixed(1)} sec`;
const mmss = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return "—:—";
  const seconds = Math.max(0, Math.ceil(value / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
const elapsedLabel = (value: number) => {
  const seconds = Math.max(0, Math.floor(value / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const exactReason = (value: string | null | undefined) => value?.replaceAll("_", " ") ?? "No blocker reported";

function healthLabel(value: string | undefined) {
  return value?.replaceAll("_", " ") ?? "UNKNOWN";
}

function sideLabel(side: "UP" | "DOWN" | null | undefined) {
  return side ?? "Unavailable";
}

function TimedDecisionCard({ timed, decision, now, liveFresh }: { timed: TimedState | null; decision: RoundDecision | null; now: number; liveFresh: boolean }) {
  const saved: TimedDecision | null = timed?.saved ?? null;
  const isLocked = saved?.status === "LOCKED" && saved.side !== null;
  const stateKind = isLocked ? "locked"
    : saved?.status === "NO_VALID_INPUT" || saved?.status === "MISSED_DEADLINE" || timed?.persistence === "FAILED" ? "failed"
      : timed?.persistence === "SAVING" ? "saving" : "watching";
  const status = isLocked ? `${saved.side} locked`
    : saved?.status === "NO_VALID_INPUT" ? "Recorded · no valid input"
      : saved?.status === "MISSED_DEADLINE" ? "Recorded · deadline missed"
        : timed?.persistence === "FAILED" ? "Decision persistence failed"
          : timed?.persistence === "SAVING" ? "Saving decision"
            : timed?.phase === "EVALUATING" ? "Evaluating"
              : timed?.phase === "DEADLINE" ? "Mandatory deadline reached"
                : timed?.phase === "EXPIRED" ? "Round expired · no saved decision"
                  : "Observing";
  const nextLabel = timed?.phase === "OBSERVING" ? "TARGET DECISION IN"
    : timed?.phase === "EVALUATING" ? "MANDATORY DECISION IN"
      : timed?.phase === "DEADLINE" ? "HARD DEADLINE"
        : timed?.phase === "EXPIRED" ? "ROUND STATUS" : "DECISION STATUS";
  const countdown = timed?.phase === "OBSERVING" ? timed.targetAtMs - now
    : timed?.phase === "EVALUATING" ? timed.hardDeadlineAtMs - now : null;
  const savedProbability = saved?.probabilityUp;
  const sideProbability = saved?.side === "UP" ? savedProbability
    : saved?.side === "DOWN" ? saved.probabilityDown : null;
  const liveSide = timed?.liveSide;
  const liveProbability = timed?.liveProbabilityUp;
  const displayedLiveProbability = liveSide === "UP" ? liveProbability
    : liveSide === "DOWN" && liveProbability != null ? decision?.market?.probabilityDown ?? null : null;
  const remainingRound = saved ? Math.max(0, saved.expiryMs - (saved.committedAtMs ?? saved.decisionAtMs)) : null;
  const timeProgress = Math.max(0, Math.min(100, timed?.timeProgress == null ? 0 : timed.timeProgress * 100));
  const readiness = Math.max(0, Math.min(100, timed?.readinessPercent ?? 0));

  return <section className="mo-timed" aria-label="Early timed decision">
    <div className="mo-timed-top">
      <div className="mo-timed-title">
        <span className="mo-label">EARLY STRATEGY · {timed?.strategyVersion ?? "waterx-timed-baseline-v1"}</span>
        <strong className={`mo-timed-status ${stateKind}`} role="status">{status}</strong>
        <small>{decision ? `${decision.intervalMinutes}m round · ${decision.roundId}` : "Waiting for exact-round authoritative state"}</small>
      </div>
      <div className="mo-timed-countdown">
        <span className="mo-label">{nextLabel}</span>
        <strong>{countdown == null ? (timed?.phase === "DEADLINE" ? "00:00" : "—:—") : mmss(countdown)}</strong>
      </div>
    </div>
    <div className="mo-timed-evidence">
      <div className="mo-timed-direction">
        <span className="mo-label">{isLocked ? "FROZEN RESEARCH CHOICE" : "CURRENT LIVE LEAN"}</span>
        <strong className={`mo-side ${(isLocked ? saved.side : liveSide)?.toLowerCase() ?? "unavailable"}`}>
          {sideLabel(isLocked ? saved.side : liveSide)}
        </strong>
        <small>{isLocked
          ? `Frozen probability ${percent(sideProbability)} · ${saved.observationId ? `source ${saved.observationId}` : "source not reported"}${liveFresh ? "" : " · current quote unavailable; frozen choice retained"}`
          : `Live observation ${percent(displayedLiveProbability)} · source age ${duration(timed?.sourceAgeMs)}`}</small>
      </div>
      <div className="mo-progress-set">
        <div className="mo-progress-label"><span>OBSERVATION TIME</span><b>{timed ? elapsedLabel(timed.elapsedMs) : "—:—"} elapsed</b></div>
        <div className="mo-progress-track" role="progressbar" aria-label="Observation time progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(timeProgress)}>
          <i style={{ transform: `scaleX(${timeProgress / 100})` }} />
        </div>
        <div className="mo-progress-label"><span>READINESS CONDITIONS</span><b>{timed ? `${readiness}%` : "Unavailable"}</b></div>
        <div className="mo-progress-track readiness" role="progressbar" aria-label="Readiness conditions" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(readiness)}>
          <i style={{ transform: `scaleX(${readiness / 100})` }} />
        </div>
      </div>
    </div>
    <div className="mo-timed-bottom">
      {isLocked ? <div className="mo-timed-result">
        <b>{saved.side} LOCKED · {elapsedLabel(saved.elapsedMs)} INTO ROUND · {elapsedLabel(remainingRound ?? 0)} REMAINING</b>
        <span>{saved.lockReason.replaceAll("_", " ")} · decision ID <code>{saved.id}</code></span>
        <span>Observation {saved.observationId ?? "not reported"} · received {stamp(saved.receivedAtMs)} · commit {stamp(saved.committedAtMs)}</span>
        {saved.onTime === null && <span>On-time commit status not yet acknowledged.</span>}
        {saved.operationalFailure && <span className="mo-failure-note">Operational failure: {saved.operationalFailure}</span>}
      </div> : saved?.status === "NO_VALID_INPUT" ? <div className="mo-timed-result failed">
        <b>NO VALID INPUT RECORDED</b>
        <span>{saved.earlyBlocker.replaceAll("_", " ")}</span>
        <span>Decision ID <code>{saved.id}</code> · operational failure {saved.operationalFailure ?? "none reported"}</span>
      </div> : saved?.status === "MISSED_DEADLINE" ? <div className="mo-timed-result failed">
        <b>HARD DEADLINE MISSED</b>
        <span>{saved.earlyBlocker.replaceAll("_", " ")} · no late choice substituted.</span>
        <span>Decision ID <code>{saved.id}</code> · recorded {stamp(saved.committedAtMs)}</span>
      </div> : <div className="mo-timed-blocker">
        <b>{timed?.phase === "EVALUATING" ? "CURRENT BLOCKER" : "READINESS BLOCKER"}</b>
        <span>{exactReason(timed?.blocker)}</span>
        {timed?.persistence === "FAILED" && <span className="mo-failure-note">Persistence failed · {timed.errorClass ?? "error class not reported"}</span>}
        {timed?.phase === "DEADLINE" && <span>Deadline reached; waiting for authoritative persistence outcome. No lock is asserted before commit acknowledgement.</span>}
      </div>}
      <div className="mo-timed-safety">
        <b>READ ONLY</b>
        <span>Automatic execution disabled · order adapter unverified</span>
        <span>Research probability is not a win guarantee.</span>
      </div>
    </div>
  </section>;
}

function safeRoundUrl(value: string | undefined,decision:RoundDecision|null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return decision&&url.protocol==="https:"&&url.hostname==="waterx.app"&&!url.username&&!url.password&&
      url.pathname===`/en/predict/market/crypto/crypto-btc-updown-${decision.intervalMinutes}m/${decision.expiryMs/1000}`?
      url.href:null;
  } catch {
    return null;
  }
}

function DecisionContent({
  decision, view, now, browserReceivedAtMs, minimumWinningProfit, onMinimumWinningProfitChange,
}: {
  decision: RoundDecision | null;
  view: AtomicDecisionView;
  now: number;
  browserReceivedAtMs?: number;
  minimumWinningProfit: 1 | 2;
  onMinimumWinningProfitChange: (amount: 1 | 2) => void;
}) {
  const early = decision?.earlyDecision ?? null;
  const canonical = decision?.canonical ?? null;
  const opportunity = decision?.opportunity ?? null;
  const sourceValid = !!decision && !!opportunity &&
    opportunity.sourceId === "waterx.public.crypto.v1" &&
    !!opportunity.observationId &&
    Number.isFinite(opportunity.receivedAtMs) &&
    opportunity.receivedAtMs >= decision.startMs &&
    opportunity.receivedAtMs <= now;
  const quoteAgeMs = sourceValid && opportunity ? Math.max(0, now - opportunity.receivedAtMs) : null;
  const quoteStale = quoteAgeMs !== null && quoteAgeMs > 10_000;
  const selectedSide = early?.side ?? (view.fresh ? view.lean : null);
  const purchase = selectedSide === "UP" ? opportunity?.purchase.up
    : selectedSide === "DOWN" ? opportunity?.purchase.down : null;
  const candidateAsk = purchase?.status === "reported" ? purchase.askCents : null;
  const ask = sourceValid && candidateAsk != null && Number.isFinite(candidateAsk) &&
    candidateAsk >= 0 && candidateAsk <= 100 ? candidateAsk : null;
  const indicative = indicativeFiveDollar(ask, minimumWinningProfit);
  const providerUrl = sourceValid ? safeRoundUrl(opportunity?.url,decision) : null;
  const priceProbability = view.fresh && decision?.market
    ? selectedSide === "UP" ? decision.market.probabilityUp
      : selectedSide === "DOWN" ? decision.market.probabilityDown : null
    : null;
  const earlyCommit = early?.committedAtMs ?? null;
  // An absolute browser clock cannot be subtracted from a server commit acknowledgement.
  // Existing request/render telemetry records monotonic durations; cross-clock latency is unqualified.
  const browserDuration = null;
  const workerDuration = earlyCommit != null && early?.workerReceivedAtMs != null &&
    early.workerReceivedAtMs >= earlyCommit ? early.workerReceivedAtMs - earlyCommit : null;
  const persistenceStatus = decision?.earlyPersistence?.status;
  const status = early ? "Adaptive benchmark saved"
    : persistenceStatus === "FAILED" ? "Conditions met; saving decision failed"
      : persistenceStatus === "SAVING" ? "Saving decision"
        : persistenceStatus === "SAVED" ? "Saved record unavailable"
          : view.fresh && decision?.readiness.score === 100 ? "No saved early choice"
        : view.fresh ? "Developing" : "Data delayed";
  const statusKind = early ? "locked" : persistenceStatus === "FAILED" ? "failed"
    : persistenceStatus === "SAVING" ? "saving"
      : persistenceStatus === "SAVED" ? "delayed"
        : view.fresh ? "developing" : "delayed";
  const sideAvailability = !selectedSide ? "No decision side available"
    : !sourceValid ? "Purchase evidence unavailable"
      : purchase?.status === "locked" ? `${selectedSide} purchase locked`
        : purchase?.status === "unavailable" || !purchase ? `${selectedSide} purchase unavailable`
          : purchase.askCents == null || !Number.isFinite(purchase.askCents) || purchase.askCents < 0 || purchase.askCents > 100 ? `${selectedSide} purchase price unavailable`
            : purchase.askCents === 0 ? `${selectedSide} ask is 0¢ · not purchasable`
              : `${selectedSide} side reported · not a verified fill`;
  const grossReceipt = indicative.grossReceiptIfCorrect;
  const health = decision?.componentHealth;

  return <div className="mo-body">
    <div className="mo-decision-row">
      <div className="mo-decision">
        <span className="mo-label">DECISION · EXACT ROUND</span>
        <strong className={selectedSide ? `mo-side ${selectedSide.toLowerCase()}` : "mo-side unavailable"}>
          {sideLabel(selectedSide)}
        </strong>
        <small>{early ? "Adaptive early benchmark · separate from timed strategy" : view.fresh && view.lean ? "Current live lean · not yet saved" : "No current side is established"}</small>
      </div>
      <div className="mo-state-block">
        <span className="mo-label">STATUS</span>
        <b className={`mo-status ${statusKind}`} role="status">{status}</b>
        {early ? <small>Locked at {stamp(early.committedAtMs)}</small>
          : persistenceStatus === "FAILED" ? <small>{decision?.earlyPersistence?.errorClass ?? "Commit acknowledgement unavailable"}</small>
            : <small>{view.fresh ? "Readiness is decision progress, not win probability." : view.reason}</small>}
      </div>
      <div className="mo-market-time">
        <span className="mo-label">TIME UNTIL VERIFIED ORDER CUTOFF</span>
        <strong>Unknown</strong>
        <small>Round expiry is not assumed to be the order deadline. Safe execution time unknown.</small>
      </div>
    </div>

    <div className="mo-value-grid">
      <div className="mo-value-group">
        <span className="mo-label">MARKET-DERIVED ESTIMATE</span>
        <strong>{percent(priceProbability)}</strong>
        <small>{view.fresh && decision?.market ? "WaterX probability · app-observed snapshot" : "Unavailable · current evidence withheld"}</small>
        <small>Round reference {opportunity ? usd(opportunity.reference.price, 2) : "Unknown"} · {opportunity?.reference.status ?? "not reported"}</small>
      </div>
      <div className="mo-value-group">
        <span className="mo-label">BLUEWATER CALIBRATED ESTIMATE</span>
        <strong>Unavailable</strong>
        <small>No promoted, qualified model estimate is available.</small>
      </div>
      <div className="mo-value-group mo-quote-value">
        <span className="mo-label">$5 ASK-BASED ILLUSTRATION</span>
        <strong>{ask == null ? "Unavailable" : `${ask}¢ / share`}</strong>
        <small>{quoteStale ? "Stale source receipt · requote manually" : sourceValid ? "Same-round reported ask · not executable" : "No verified same-round purchase quote"}</small>
      </div>
    </div>

    <div className="mo-economics" aria-label="Indicative purchase economics">
      <div><span>Gross receipt if correct</span><b>{grossReceipt == null ? "Unknown" : usd(grossReceipt)}</b></div>
      <div><span>Net profit if correct</span><b>Unknown</b></div>
      <div><span>Loss if incorrect · before unverified fees/gas</span><b>{usd(5)} collateral</b></div>
      <div><span>Fees · gas · break-even · EV</span><b>Unknown</b></div>
      <p>Gross receipt is ask-based only. Full $5 fill, net settlement, fees, gas in SUI, its USD conversion basis and break-even are unverified; expected net value is unqualified.</p>
    </div>

    <div className="mo-last-row">
      <div className="mo-side-result">
        <span className="mo-label">SELECTED SIDE AVAILABILITY</span>
        <strong>{sideAvailability}</strong>
        <small>{selectedSide && purchase?.selection ? `Provider selection ${purchase.selection}` : "Unavailable side is never replaced with the opposite side."}</small>
      </div>
      <div className="mo-age">
        <span className="mo-label">QUOTE / SOURCE AGE</span>
        <strong>{quoteAgeMs == null ? "Unknown" : duration(quoteAgeMs)}</strong>
        <small>Age is measured from app receipt, not last price change{opportunity?.priceLastChangedAtMs != null ? ` · last changed ${stamp(opportunity.priceLastChangedAtMs)}` : ""}.</small>
      </div>
      <div className="mo-action">
        <span className="mo-label">MANUAL ACTION / BLOCKER</span>
        {providerUrl ? <a href={providerUrl} target="_blank" rel="noopener noreferrer">
          View verified provider round <ExternalLink size={13} aria-hidden="true" />
        </a> : <strong>No verified exact-round link</strong>}
        <small>{providerUrl
          ? `Read-only route · no in-app order submission · blocker: ${decision?.executionBlocker ?? "No verified order route."} Recheck and requote after navigation or signing delay.`
          : `Exact-round route is not available from this snapshot. ${decision?.executionBlocker ?? "No order action is enabled."}`}</small>
      </div>
    </div>

    <div className="mo-filter-row">
      <div className="mo-filter" role="group" aria-label="Desired winning profit preference">
        <span className="mo-label">$5 WINNING-PROFIT PREFERENCE</span>
        {([1, 2] as const).map(amount => <button key={amount} type="button"
          aria-pressed={minimumWinningProfit === amount}
          className={minimumWinningProfit === amount ? "selected" : ""}
          onClick={() => onMinimumWinningProfitChange(amount)}>
          ${amount}
        </button>)}
        <small>Payout preference only · does not represent expected return. Unverified quote cannot pass this filter.</small>
        <b className="mo-filter-result">UNQUALIFIED · requires {usd(minimumWinningProfit)} net profit if correct</b>
      </div>
      <div className="mo-early-audit">
        <span className="mo-label">ADAPTIVE / CANONICAL BENCHMARKS</span>
        <strong>Adaptive early {early ? `${early.side} · ${stamp(early.committedAtMs)}` : persistenceStatus === "FAILED" ? "Save failed" : "Not saved"}</strong>
        <small>Canonical {canonical ? `${canonical.side} · ${stamp(canonical.committedAtMs)}` : "not committed"}{early ? ` · commit → browser ${duration(browserDuration)} · worker receipt ${duration(workerDuration)}` : ""}</small>
      </div>
    </div>

    <div className="mo-health" aria-label="System component health">
      <div><i className={health?.priceFeed === "AVAILABLE" ? "ok" : "unknown"} /><span>PRICE FEED</span><b>{healthLabel(health?.priceFeed)}</b></div>
      <div><i className={health?.decisionService === "AVAILABLE" ? "ok" : health?.decisionService === "STALE" ? "warn" : "unknown"} /><span>DECISION SERVICE</span><b>{healthLabel(health?.decisionService)}</b></div>
      <div><i className={health?.storage === "COMMITTED" ? "ok" : health?.storage === "FAILED" ? "bad" : "unknown"} /><span>STORAGE</span><b>{healthLabel(health?.storage)}</b></div>
      <div><i className="unknown" /><span>ORDER ADAPTER</span><b>UNVERIFIED</b></div>
    </div>

    <p className="mo-readiness-note">{view.fresh && decision?.readiness
      ? `Readiness ${Math.round(decision.readiness.score)} / 100 is decision progress, not win probability and not an order guarantee.`
      : "Readiness is decision progress, not win probability or an order guarantee."}</p>
    {view.decision?.earlyDecision?.committedAtMs === null && view.decision.earlyDecision && <p className="mo-receipt-note">Early choice exists, but historical commit acknowledgement time is unknown.</p>}
  </div>;
}

export function ManualOpportunity({ view, now, onRetry, refresh, browserReceivedAtMs }: Props) {
  const [minimumWinningProfit, setMinimumWinningProfit] = useState<1 | 2>(1);
  const decision = view.decision;
  const pending = refresh?.pending ?? false;
  const error = refresh?.error ?? "";
  return <section className="manual-opportunity" aria-label="Manual round opportunity" aria-busy={pending}>
    <header className="mo-header">
      <div>
        <span className="mo-kicker">MANUAL OPPORTUNITY · BTC / USD</span>
        <h2>Exact-round decision &amp; $5 economics</h2>
      </div>
      <div className="mo-header-tools">
        {pending && <span className="mo-refreshing" role="status">Refreshing snapshot</span>}
        {onRetry && <button className="mo-retry" type="button" onClick={onRetry} aria-label="Retry live snapshot"><RefreshCw size={14} /> Retry</button>}
      </div>
    </header>
    {error && <div className="mo-refresh-error" role="status">Snapshot refresh failed · same-round decision retained only while valid. {error}</div>}
    {!decision && pending && <div className="mo-loading" role="status" aria-label="Loading exact-round snapshot">
      <div className="mo-skeleton-lines" aria-hidden="true"><i /><i /><i /></div>
      <strong>Waiting for exact-round snapshot</strong>
    </div>}
    {!decision && !pending && <div className="mo-missing-state" role="status">
      <span className="mo-missing-mark" aria-hidden="true">—</span>
      <div><strong>Data delayed · no exact-round decision snapshot</strong><p>{view.reason} Quotes and decisions are withheld until a matching snapshot arrives.</p></div>
    </div>}
    <TimedDecisionCard timed={decision?.timedDecision ?? null} decision={decision} now={now} liveFresh={view.fresh} />
    <details className="mo-benchmark-details">
      <summary>Canonical benchmark &amp; indicative $5 economics · separate from early strategy</summary>
      {(!pending || decision) && <DecisionContent decision={decision} view={view} now={now} browserReceivedAtMs={browserReceivedAtMs}
        minimumWinningProfit={minimumWinningProfit} onMinimumWinningProfitChange={setMinimumWinningProfit} />}
    </details>
    <p className="mo-safety">Research display only · no wallet connection, signing, funded order or in-app submission. Requote after any navigation delay.</p>
  </section>;
}
