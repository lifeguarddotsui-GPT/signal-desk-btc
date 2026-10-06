import * as React from "react";
import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { RoundDecision } from "../../shared/round-decision";
import type { TimedDecision, TimedState } from "../../shared/timed-decision";
import { TIMED_STRATEGY } from "../../shared/timed-decision";
import { indicativeFiveDollar } from "../../shared/manual-opportunity";
import type { AtomicDecisionView } from "./live-decision-contract";

type Props = {
  view: AtomicDecisionView;
  now: number;
  onRetry?: () => void;
  refresh?: { pending: boolean; error: string };
  browserReceivedAtMs?: number;
  marketReference?: { price: number | null; quality: string; source: string };
  comparison?: { price: number | null; source: string; receivedAtMs: number | null };
};

const stamp = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not reported"
  : new Date(value).toLocaleTimeString([], { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " UTC";
const usd = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value)
  ? "Unknown" : `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) || value < 0 || value > 1
  ? "Unavailable" : `${(value * 100).toFixed(1)}%`;
const duration = (value: number | null | undefined) => value == null || !Number.isFinite(value) || value < 0
  ? "Unknown" : `${value < 10_000 ? (value / 1000).toFixed(1) : Math.floor(value / 1000)} sec`;
const mmss = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return "—:—";
  const seconds = Math.max(0, Math.ceil(value / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
const elapsedLabel = (value: number) => {
  const seconds = Math.max(0, Math.floor(value / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
const requirementDuration = (value: number) => `${Math.ceil(Math.max(0, value) / 1000)} second${Math.ceil(Math.max(0, value) / 1000) === 1 ? "" : "s"}`;
const exactReason = (value: string | null | undefined) => value?.replaceAll("_", " ") ?? "No blocker reported";

function healthLabel(value: string | undefined) {
  return value?.replaceAll("_", " ") ?? "UNKNOWN";
}

function sideLabel(side: "UP" | "DOWN" | null | undefined) {
  return side ?? "Unavailable";
}

type TimedDisplay = TimedState & { lifecycle?: string; remainingRequirement?: string | null };
function TimedDecisionCard({ timed: timedState, decision, now, liveFresh, marketReference, comparison }: {
  timed: TimedState | null; decision: RoundDecision | null; now: number; liveFresh: boolean;
  marketReference?: Props["marketReference"]; comparison?: Props["comparison"];
}) {
  const timed = timedState as TimedDisplay | null;
  const saved: TimedDecision | null = timed?.saved ?? null;
  const gatePolicy = timed?.strategyVersion === TIMED_STRATEGY;
  const isLocked = saved?.status === "LOCKED" && saved.side !== null;
  const stateKind = isLocked ? saved.onTime===false?"failed":"locked"
    : saved?.status === "NO_VALID_INPUT" || saved?.status === "MISSED_DEADLINE" || saved?.status === "DATA_FAILURE" || timed?.persistence === "FAILED" ? "failed"
      : timed?.persistence === "SAVING" ? "saving" : "watching";
  const status = isLocked ? `${saved.side} locked${saved.onTime===false?" · deadline missed":""}`
    : saved?.status === "NO_VALID_INPUT" ? "Recorded · no valid input"
      : saved?.status === "MISSED_DEADLINE" ? "Recorded · deadline missed"
        : saved?.status === "ABSTAINED_NO_QUALIFIED_SIGNAL" ? "Round complete · no qualified signal"
          : saved?.status === "DATA_FAILURE" ? "Round complete · data failure"
        : timed?.persistence === "FAILED" ? "Decision persistence failed"
          : timed?.persistence === "SAVING" ? "Saving decision"
            : timed?.phase === "EVALUATING" ? "Evaluating"
                : timed?.phase === "DEADLINE" ? "Legacy deadline state"
                  : timed?.phase === "EXPIRED" ? "Round expired · no saved decision"
                  : !liveFresh?"Data delayed":"Observing";
  const countdown = gatePolicy && timed?.nextGateAtMs != null ? timed.nextGateAtMs - now : null;
  const savedProbability = saved?.probabilityUp;
  const sideProbability = saved?.side === "UP" ? savedProbability
    : saved?.side === "DOWN" ? saved.probabilityDown : null;
  const liveSide = timed?.liveSide;
  const liveProbability = timed?.liveProbabilityUp;
  const displayedLiveProbability = liveSide === "UP" ? liveProbability
    : liveSide === "DOWN" && liveProbability != null ? decision?.market?.probabilityDown ?? null : null;
  const targetSeconds = decision && timed ? Math.max(1, Math.round((timed.targetAtMs - decision.startMs) / 1000))
    : decision?.intervalMinutes === 15 ? 180 : 60;
  const roundDurationMs = decision ? Math.max(0, decision.expiryMs - decision.startMs) : targetSeconds * 1000;
  const elapsed = decision
    ? Math.max(0, Math.min(roundDurationMs, now - decision.startMs))
    : timed?.elapsedMs ?? saved?.elapsedMs ?? 0;
  const observationProgress = Math.max(0, Math.min(100, elapsed /
    roundDurationMs * 100));
  const probability = liveFresh ? displayedLiveProbability : null;
  const components = timed?.components;
  const sourceAge=decision?.market?.receivedAtMs!=null?Math.max(0,now-decision.market.receivedAtMs):timed?.sourceAgeMs;
  const unmetRequirement = isLocked
    ? "Choice is frozen. Trading authority remains disabled."
    : saved?.status === "ABSTAINED_NO_QUALIFIED_SIGNAL" ? "Round ended without a qualifying signal; no prediction was forced."
      : saved?.status === "DATA_FAILURE" ? "Round ended with insufficient valid data to evaluate a prediction."
        : saved?.status === "MISSED_DEADLINE" ? "The scheduled deadline was missed; no late choice was substituted."
          : saved?.status === "NO_VALID_INPUT" ? "No valid probability input was recorded for this round."
    : timed?.remainingRequirement || (components
      ? components.sameSideMs < components.requiredSameSideMs
        ? `Needs ${requirementDuration(components.requiredSameSideMs - components.sameSideMs)} more same-side stability`
        : components.validCount < components.requiredCount
          ? `Needs ${components.requiredCount - components.validCount} more valid observation${components.requiredCount - components.validCount === 1 ? "" : "s"}`
          : components.probabilityRange !== null && components.probabilityRange > components.maximumRange
            ? `Probability range ${components.probabilityRange.toFixed(3)} exceeds ${components.maximumRange.toFixed(3)}`
            : components.strength < components.requiredStrength
              ? `Directional separation ${components.strength.toFixed(3)} is below ${components.requiredStrength.toFixed(3)}`
              : timed?.blocker?.replaceAll("_", " ") || "No unmet requirement reported"
      : timed?.blocker?.replaceAll("_", " ") || "Waiting for valid same-round observations");
  const referencePrice = marketReference?.price ?? decision?.opportunity?.reference.price ?? null;
  const referenceQuality = marketReference?.quality ?? decision?.opportunity?.reference.status ?? "not reported";
  const referenceSource = marketReference?.source ?? "WaterX round reference";
  const comparePrice = comparison?.price ?? null;
  const comparisonSource = comparison?.source?.trim() || "Not reported";
  const comparisonAge = comparison?.receivedAtMs == null ? null : Math.max(0, now - comparison.receivedAtMs);
  const compactHealth = !liveFresh ? "Quote delayed · frozen choice retained"
    : decision?.componentHealth?.storage === "FAILED" ? "Storage issue · no new saved choice asserted"
      : decision?.componentHealth?.priceFeed !== "AVAILABLE" ? "Price feed delayed · research only"
        : "Data current · read-only research";
  const currentOdds = liveFresh && decision?.market
    ? `UP ${percent(decision.market.probabilityUp)} · DOWN ${percent(decision.market.probabilityDown)}`
    : "Unavailable · current same-round snapshot not fresh";
  const requirementsMet = timed?.requirementsMet ?? (components
    ? Number((timed?.sourceAgeMs ?? Infinity) <= 10_000) + Number(components.strength >= components.requiredStrength) +
      Number(components.sameSideMs >= components.requiredSameSideMs) + Number(components.validCount >= components.requiredCount)
    : 0);
  const nextGateLabel = countdown == null ? timed?.phase === "EXPIRED" ? "Round complete" : "No further gate scheduled"
    : mmss(countdown);
  const elapsedTarget = `${elapsedLabel(elapsed)} / ${mmss(roundDurationMs)}`;

  return <section className="mo-primary-card" aria-label="Authoritative round research state">
    <div className="mo-primary-main">
      <span className="mo-primary-eyebrow">{gatePolicy ? "PROVISIONAL LEAN · SCHEDULED QUALIFICATION" : "ROUND RESEARCH · DECISION STATE"}</span>
      <div className="mo-primary-call">
        <strong className={`mo-timed-status ${stateKind}`} role="status">
          {isLocked ? `LOCKED ${saved.side}` :
            saved?.status === "ABSTAINED_NO_QUALIFIED_SIGNAL" ? "ABSTAINED" :
              saved?.status === "DATA_FAILURE" ? "DATA FAILURE" :
                saved?.status === "NO_VALID_INPUT" ? "NO VALID INPUT" :
                  saved?.status === "MISSED_DEADLINE" ? "MISSED GATE" :
                    liveFresh && liveSide ? `LEANING ${liveSide}` : liveFresh ? "OBSERVING" : "DATA DELAYED"}
        </strong>
        <span className="mo-primary-probability">{percent(isLocked ? sideProbability : probability)}
          <small>{isLocked ? "FROZEN WATERX PUBLIC MARKET PROBABILITY · UNCALIBRATED" : "CURRENT WATERX PUBLIC MARKET PROBABILITY · UNCALIBRATED"}</small>
        </span>
      </div>
      <span className="mo-primary-round">{decision
        ? `${decision.intervalMinutes}m · exact active round${isLocked ? " · immutable public prediction" : ""}`
        : "Awaiting exact-round decision snapshot"}</span>
    </div>
    <div className="mo-market-pair" aria-label="Round reference, current odds and comparison price">
      <div><span className="mo-primary-eyebrow">PRICE TO BEAT · {referenceQuality.toUpperCase()}</span><strong>{usd(referencePrice, 2)}</strong><small>{referenceSource}{!liveFresh && referencePrice != null ? " · retained same-round reference" : ""}</small></div>
      <div><span className="mo-primary-eyebrow">{isLocked ? "CURRENT MARKET ODDS · NOT FROZEN" : "MARKET ODDS · CURRENT ONLY"}</span><strong className="mo-odds-value">{currentOdds}</strong><small>{liveFresh ? "Same-round live snapshot" : "Delayed · withheld as live"}</small></div>
      <div><span className="mo-primary-eyebrow">BTC COMPARISON · {comparisonSource}</span><strong>{usd(comparePrice, 2)}</strong><small>{comparisonAge == null ? "Current comparison unavailable" : `${duration(comparisonAge)} source age`}</small></div>
    </div>
    <div className="mo-primary-metrics">
      <div className="mo-indicator observation">
        <div><span className="mo-indicator-label">CURRENT CONDITIONS · ROUND ELAPSED</span><b>{elapsedTarget}</b></div>
        <div className="mo-progress-track" role="progressbar" aria-label="Round elapsed progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(observationProgress)}><i style={{ transform: `scaleX(${observationProgress / 100})` }} /></div>
      </div>
      <div className="mo-indicator gate-countdown">
        <div><span className="mo-indicator-label">{gatePolicy ? "NEXT SERVER-SCHEDULED GATE" : "NEXT EVALUATION"}</span><b>{gatePolicy ? nextGateLabel : "Legacy schedule"}</b></div>
        <small>{gatePolicy ? timed?.nextGateAtMs == null ? "No further gate before round expiry" : "A check, not a forced choice" : "Historical policy · no gate countdown available"}</small>
      </div>
      <div className="mo-indicator qualification">
        <div><span className="mo-indicator-label">{isLocked ? "QUALIFICATION AT LOCK" : "CURRENT CONDITIONS CHECKLIST"}</span><b>{gatePolicy ? `${isLocked ? 4 : requirementsMet} of 4 requirements` : "Legacy criteria"}</b></div>
        {gatePolicy && <div className="mo-checklist" aria-label={isLocked ? "4 of 4 requirements met at the frozen lock" : `${requirementsMet} of 4 requirements currently met`}>
          <i className={isLocked || requirementsMet>0 && (timed?.sourceAgeMs ?? Infinity) <= 10_000 ? "met" : ""} title="Fresh source" />
          <i className={isLocked || requirementsMet>0 && !!components && components.strength >= components.requiredStrength ? "met" : ""} title="Directional separation" />
          <i className={isLocked || requirementsMet>0 && !!components && components.sameSideMs >= components.requiredSameSideMs ? "met" : ""} title="Same-side persistence" />
          <i className={isLocked || requirementsMet>0 && !!components && components.validCount >= components.requiredCount &&
            (components.trendKind==="FLAT_STABLE"||components.trendKind==="STRENGTHENING") ? "met" : ""} title="Stable or same-side strengthening evidence" />
        </div>}
      </div>
    </div>
    {gatePolicy && <div className={`mo-last-gate ${timed?.lastGate ? timed.lastGate.result.toLowerCase().replaceAll("_", "-") : "not-recorded"}`}>
      <span className="mo-indicator-label">LAST GATE · SERVER-RECORDED</span>
      <b>{timed?.lastGate
        ? `${timed.lastGate.result.replaceAll("_", " ")} · ${stamp(timed.lastGate.scheduledAtMs)}`
        : "No gate result reported for this exact round"}</b>
      <small>{timed?.lastGate ? timed.lastGate.reason.replaceAll("_", " ").toLowerCase() : "Current conditions are not a substitute for a recorded gate result."}</small>
    </div>}
    <p className="mo-requirement"><b>{isLocked ? "FROZEN" : saved ? "ROUND RESULT" : "NEXT REQUIREMENT"}:</b> {unmetRequirement}</p>
    <div className="mo-primary-save">
      <span>{gatePolicy ? "Qualification objective" : "Historical target"} <b>{String(Math.floor(targetSeconds / 60)).padStart(2, "0")}:{String(targetSeconds % 60).padStart(2, "0")}</b></span>
      <span>Until settlement <b>{decision ? mmss(decision.expiryMs - now) : "—:—"}</b></span>
      <span>Execution window <b>{timed?.executionCutoffAtMs == null ? "Unverified · unavailable" : mmss(timed.executionCutoffAtMs - now)}</b></span>
       {saved && <span>Saved elapsed <b>{elapsedLabel(saved.elapsedMs)}</b></span>}
       {isLocked && saved.gateIndex != null && <span>Gate <b>#{saved.gateIndex} · {saved.gateScheduledAtMs == null ? "time unavailable" : stamp(saved.gateScheduledAtMs)}</b></span>}
      <span>Freshness <b>{liveFresh ? `Current · ${duration(sourceAge)}` : "Delayed"}</b></span>
       <span>Research record <b>{saved ? `${stamp(saved.committedAtMs)} · ${saved.status.replaceAll("_", " ")}` : "No committed prediction"}</b></span>
    </div>
    <div className="mo-health-compact" role="status"><b>DATA HEALTH</b> · {compactHealth} · no automatic trading authority.</div>
    <details className="mo-timed-audit">
      <summary>Decision lifecycle, policy and raw evidence</summary>
      <div className="mo-timed">
        <div className="mo-timed-top">
          <div className="mo-timed-title"><span className="mo-label">LIFECYCLE · {timed?.lifecycle ?? timed?.phase ?? "UNKNOWN"}</span><strong className={`mo-timed-status ${stateKind}`}>{status}</strong><small>{decision ? `Round ${decision.roundId} · strategy ${timed?.strategyVersion ?? "not reported"}` : "Exact-round identity unavailable"}</small></div>
       <div className="mo-timed-countdown"><span className="mo-label">{saved ? "COMMIT ACKNOWLEDGEMENT" : gatePolicy ? "NEXT SCHEDULED GATE" : "LEGACY POLICY"}</span><strong>{saved ? saved.onTime === false ? "LATE" : saved.onTime === true ? "ON TIME" : "UNKNOWN" : gatePolicy ? nextGateLabel : "Archived"}</strong></div>
        </div>
        {components && <div className="mo-timed-result">
          <span>Same side: {duration(components.sameSideMs)} / {duration(components.requiredSameSideMs)} · valid observations {components.validCount} / {components.requiredCount}</span>
          <span>Probability range {components.probabilityRange === null ? "unavailable" : components.probabilityRange.toFixed(3)} / max {components.maximumRange.toFixed(3)} · separation {components.strength.toFixed(3)} / {components.requiredStrength.toFixed(3)}</span>
          <span>{gatePolicy ? `${timed?.requirementsMet ?? 0} of 4 qualification requirements currently met · policy source: ${timed?.policySource ?? "experimental market-based policy"}.` : "Legacy evidence thresholds; not a calibrated outcome confidence."}</span>
        </div>}
        {saved && <div className="mo-timed-result">
          <b className="mo-frozen-lock">{saved.side ?? saved.status} · IMMUTABLE RESEARCH RECORD</b>
         <span>{saved.lockReason.replaceAll("_", " ")} · decision ID <code>{saved.id}</code> · observation {saved.observationId ?? "not reported"}{saved.gateIndex == null ? "" : ` · gate ${saved.gateIndex} at ${stamp(saved.gateScheduledAtMs)}`}</span>
          <span>Early blocker: {saved.earlyBlocker.replaceAll("_", " ")}</span>
          <span>Received {stamp(saved.receivedAtMs)} · decision {stamp(saved.decisionAtMs)} · commit {stamp(saved.committedAtMs)} · policy {saved.strategyVersion}</span>
          {saved.operationalFailure && <span className="mo-failure-note">Operational failure: {saved.operationalFailure}</span>}
        </div>}
        {!saved && <div className="mo-timed-blocker"><b>UNMET POLICY REQUIREMENT</b><span>{exactReason(timed?.blocker)}</span>{timed?.persistence === "FAILED" && <span className="mo-failure-note">Persistence failed · {timed.errorClass ?? "error class not reported"}</span>}</div>}
        <div className="mo-timed-safety"><b>RESEARCH ONLY · NO TRADING AUTHORITY</b><span>Automatic execution disabled · order adapter unverified.</span><span>Live odds may change after a frozen choice.</span></div>
      </div>
    </details>
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

export function ManualOpportunity({ view, now, onRetry, refresh, browserReceivedAtMs, marketReference, comparison }: Props) {
  const [minimumWinningProfit, setMinimumWinningProfit] = useState<1 | 2>(1);
  const decision = view.decision;
  const pending = refresh?.pending ?? false;
  const error = refresh?.error ?? "";
  return <section className="manual-opportunity" aria-label="Manual round opportunity" aria-busy={pending}>
    <header className="mo-header">
      <div>
        <span className="mo-kicker">ONE AUTHORITATIVE RESEARCH DECISION · BTC / USD</span>
          <h2>{decision?.timedDecision?.strategyVersion === TIMED_STRATEGY ? "Qualification gates · exact round" : "Round research · exact round"}</h2>
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
    <TimedDecisionCard timed={decision?.timedDecision ?? null} decision={decision} now={now} liveFresh={view.fresh} marketReference={marketReference} comparison={comparison} />
    <details className="mo-benchmark-details">
      <summary>BENCHMARK DISCLOSURE · legacy canonical readiness, reference provenance &amp; diagnostics</summary>
      {(!pending || decision) && <DecisionContent decision={decision} view={view} now={now} browserReceivedAtMs={browserReceivedAtMs}
        minimumWinningProfit={minimumWinningProfit} onMinimumWinningProfitChange={setMinimumWinningProfit} />}
    </details>
    <p className="mo-safety">Research display only · no wallet connection, signing, funded order or in-app submission. Requote after any navigation delay.</p>
  </section>;
}
