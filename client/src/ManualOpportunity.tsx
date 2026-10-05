import * as React from "react";
import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { RoundDecision } from "../../shared/round-decision";
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

function healthLabel(value: string | undefined) {
  return value?.replaceAll("_", " ") ?? "UNKNOWN";
}

function sideLabel(side: "UP" | "DOWN" | null | undefined) {
  return side ?? "Unavailable";
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
  const status = early ? "Locked"
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
        <small>{early ? "Early research choice · immutable" : view.fresh && view.lean ? "Current live lean · not yet saved" : "No current side is established"}</small>
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
        <span className="mo-label">EARLY / CANONICAL ARE INDEPENDENT</span>
        <strong>Early {early ? `${early.side} · ${stamp(early.committedAtMs)}` : persistenceStatus === "FAILED" ? "Save failed" : "Not saved"}</strong>
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
    {(!pending || decision) && <DecisionContent decision={decision} view={view} now={now} browserReceivedAtMs={browserReceivedAtMs}
      minimumWinningProfit={minimumWinningProfit} onMinimumWinningProfitChange={setMinimumWinningProfit} />}
    <p className="mo-safety">Research display only · no wallet connection, signing, funded order or in-app submission. Requote after any navigation delay.</p>
  </section>;
}
