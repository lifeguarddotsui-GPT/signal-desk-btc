import * as React from "react";
import { RefreshCw } from "lucide-react";
import type { RoundDecision } from "../../shared/round-decision";
import type { AtomicDecisionView } from "./live-decision-contract";
import type { AdvisoryPayload } from "./advisory-contract";
import { EventChallengerPanel } from "./EventChallengerPanel";
import type { TwoStageProjection, StageLock, LockStage } from "../../shared/two-stage";
import { TWO_STAGE_STRATEGY } from "../../shared/two-stage";

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
  economics?: AdvisoryPayload | null;
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
const twoStageTime = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "time unavailable" : `${Math.max(0, Math.round(value / 1000))}s elapsed`;
const elapsedClock = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "time unavailable" : clock(Math.floor(value / 1000)*1000) ?? "time unavailable";
const stageReason = (reason: string | undefined, persistence: string | undefined, diagnostics?: { message: string }) => {
  if (persistence === "FAILED") return "Storage unavailable";
  if (persistence === "UNKNOWN") return "Commit state unknown · reconciling";
  if (persistence === "SAVING") return "Saving decision";
  if (reason === "CONFIRMATION_POLICY_NOT_QUALIFIED") return "Confirmation model not available";
  if (diagnostics?.message?.trim()) return diagnostics.message;
  if (reason === "NO_QUALIFYING_EARLY_VALUE" || reason === "ENTRY_TERMS_UNAVAILABLE") return "No qualifying early opportunity";
  if (reason === "WAITING_FOR_FRESH_DATA" || reason === "SOURCE_STALE") return "Fresh odds unavailable";
  if (reason === "WAITING_FOR_ADDITIONAL_EVIDENCE") return "Building additional evidence";
  if (reason === "ROUND_EXPIRED") return "Round complete · no qualifying lock";
  if (reason === "SAME_SIDE_PERSISTENCE_INCOMPLETE" || reason === "STABILITY_WINDOW_INCOMPLETE" ||
      reason === "DIRECTIONAL_SEPARATION_BELOW_POLICY" || reason === "NO_VALID_PROBABILITY_INPUT") return "Building evidence";
  const normalized = reason?.replaceAll("_", " ").trim();
  if (normalized && !["conditions satisfied", "locked"].includes(normalized.toLowerCase())) return normalized;
  return reason === "CONDITIONS_SATISFIED" ? "Qualified · awaiting durable commit" : "Building evidence";
};

function TwoStageDeskRows({ projection, round, interval, now }: {
  projection: TwoStageProjection | null | undefined;
  round: RoundIdentity | null;
  interval: Interval;
  now: number;
}) {
  const exact = !!projection && !!round &&
    projection.roundId === round.id && projection.startMs === round.startMs &&
    projection.expiryMs === round.expiryMs && projection.intervalMinutes === interval &&
    projection.strategyVersion === TWO_STAGE_STRATEGY && projection.shadowOnly === true &&
    projection.automaticExecutionAllowed === false;
  const candidate = exact ? projection : null;
  const localObservedAt=React.useMemo(()=>now,[projection]);
  const getLock = (stage: LockStage): StageLock | null => {
    const state = stage === "EARLY" ? candidate?.early : candidate?.confirmation;
    const lock = state?.lock;
    if (!candidate || state?.persistence !== "COMMITTED" || !lock || lock.stage !== stage ||
      lock.network !== "sui:mainnet" || lock.roundId !== candidate.roundId ||
      lock.startMs !== candidate.startMs || lock.expiryMs !== candidate.expiryMs ||
      lock.intervalMinutes !== candidate.intervalMinutes || lock.strategyVersion !== TWO_STAGE_STRATEGY ||
      lock.marketId !== candidate.marketId || lock.shadowOnly !== true ||
      lock.automaticExecutionAllowed !== false || (lock.commitVerified !== true && lock.committedAtMs == null)) return null;
    return lock;
  };
  const early = getLock("EARLY");
  const confirmation = getLock("CONFIRMATION");
  const relationship = early && confirmation
    ? early.side === confirmation.side ? "Agrees with Early Lock" : "Changed direction"
    : early ? "No confirmation" : confirmation ? "No early decision" : null;
  const displayStage = (title: string, stage: LockStage, lock: StageLock | null) => {
    const state = candidate ? stage === "EARLY" ? candidate.early : candidate.confirmation : null;
    const description = lock
      ? `${lock.side} · ${twoStageTime(lock.elapsedMs)} · ${lock.probabilitySource}`
      : !projection ? "Building evidence · two-stage projection unavailable"
        : !candidate ? "Building evidence · projection does not match this round and interval"
      : stageReason(state?.reason, state?.persistence, state?.diagnostics);
    const economics = lock?.economics;
    const returnText = economics?.totalReturnedIfCorrectUsd != null &&
      Number.isFinite(economics.totalReturnedIfCorrectUsd) && Number.isFinite(economics.collateralUsd)
      ? `${economics.kind === "VERIFIED_QUOTE" ? "Verified" : "Indicative"} $${economics.collateralUsd.toFixed(2)} collateral · $${economics.totalReturnedIfCorrectUsd.toFixed(2)} total return if correct`
      : "Indicative return unavailable";
    const qualifiedMs = lock?.committedAtMs!=null&&candidate?lock.committedAtMs-candidate.startMs:null;
    const remainingMs = lock?.committedAtMs!=null&&candidate?Math.max(0,candidate.expiryMs-lock.committedAtMs):null;
    const status = lock?.valueStatus === "BELOW_PREFERRED" ? "Below preferred return"
      : lock?.valueStatus === "UNAVAILABLE" ? "Entry return unavailable"
        : lock ? "Research lock committed" : description;
    return <div className={`two-stage-desk-row${lock ? " committed" : ""}${stage === "EARLY" ? " early-primary" : " confirmation-secondary"}`} key={stage} data-stage={stage.toLowerCase()}>
      <span className="two-stage-row-label">{title}</span>
      <strong>{lock ? lock.side : status}</strong>
      {lock && <small className="two-stage-lock-timing">{lock.committedAtMs==null?"Commit verified · acknowledgement time unknown":`Locked at ${elapsedClock(qualifiedMs)} · ${clock(remainingMs)??"time unavailable"} remaining`}</small>}
      {lock && <small className="two-stage-lock-return">{returnText}{lock.valueStatus === "BELOW_PREFERRED" ? " · Below preferred return" : ""}</small>}
      {lock && <small>{lock.calibrationStatus==="QUALIFIED"?"Stage-selected calibrated forecast":"Market-derived evidence · uncalibrated"} · frozen {percent(lock.probabilityUp)} UP / {percent(1 - lock.probabilityUp)} DOWN</small>}
    </div>;
  };
  return <section className="two-stage-desk" aria-label="Two-stage shadow research">
    <div className="two-stage-desk-heading"><span>EXPERIMENTAL · SHADOW RESEARCH</span><b>Not activated · no order authority</b></div>
    {displayStage("EARLY LOCK", "EARLY", early)}
    {displayStage("CONFIRMATION LOCK", "CONFIRMATION", confirmation)}
    <p className="two-stage-relationship">{relationship ?? (candidate
      ? "No stage lock committed"
      : "Relationship unavailable until exact-round evidence is reported")}</p>
    {candidate && <details className="two-stage-diagnostics">
      <summary>Two-stage diagnostics</summary>
      <div><span>Strategy / market</span><b>{candidate.strategyVersion} · {candidate.marketId}</b></div>
      <div><span>Settlement rule</span><b>{JSON.stringify(candidate.settlementRule)}</b></div>
      <div><span>Price features</span><b>{JSON.stringify(candidate.priceFeatures)}</b></div>
      {candidate.researchPreference && <div><span>Frozen research mode</span><b>{candidate.researchPreference.mode} · collateral {usd(candidate.researchPreference.collateralUsd)} · minimum return {usd(candidate.researchPreference.minimumReturnUsd)} · preferred return {usd(candidate.researchPreference.preferredReturnUsd)}. Research display only; does not change trading settings or execution eligibility.</b></div>}
      {candidate.policyRegistry != null && <div><span>Policy registry</span><b>{JSON.stringify(candidate.policyRegistry)}</b></div>}
      <div><span>Browser snapshot timing</span><b>Local UI first observed {time(localObservedAt)}. Browser/server clock synchronization is unverified; this is not a verified network-latency measurement.</b></div>
      {([["EARLY", candidate.early, early], ["CONFIRMATION", candidate.confirmation, confirmation]] as const).map(([name, state, lock]) =>
        <div className="two-stage-diagnostic-lock" key={name}><span>{name} diagnostics</span><b>{lock
          ? `Source ${lock.probabilitySource} · Calibration ${lock.calibrationStatus==="QUALIFIED"?"qualified":"unqualified"} · ${lock.modelVersion??"no qualified model"} · Frozen research preference · ${lock.researchPreference?.mode.toLowerCase()??"not reported"} · ${JSON.stringify(lock.researchPreference??{})} · Policy ${lock.policyVersion} · feature ${lock.featureVersion} · cutoff ${time(lock.evidenceCutoffMs)} · qualified ${time(lock.qualifiedAtMs)} · committed ${time(lock.committedAtMs)} · model ${lock.modelVersion ?? "not reported"} · calibration ${lock.calibrationStatus} · observations ${lock.observationIds.join(", ") || "none reported"} · economics ${JSON.stringify(lock.economics)} · diagnostics ${JSON.stringify(lock.diagnostics ?? state.diagnostics ?? {})} · timing ${JSON.stringify(lock.timing ?? state.timing ?? {})}`
          : `${state.persistence} · ${stageReason(state.reason, state.persistence, state.diagnostics)} · measurements ${JSON.stringify(state.diagnostics?.measurements ?? {})} · thresholds ${JSON.stringify(state.diagnostics?.thresholds ?? {})} · timing ${JSON.stringify(state.timing ?? {})}`}</b></div>)}
      <p>Frozen stage evidence is separate from current market odds and current purchase terms. Every stage is shadow-only.</p>
    </details>}
  </section>;
}

export function ManualOpportunity({
  view, now, interval = view.decision?.intervalMinutes ?? 5, round, onIntervalChange, onRetry, refresh,
  marketReference, comparison, fixtureName, children, economics,
}: Props) {
  const [compactPrices,setCompactPrices]=React.useState(()=>typeof window!=="undefined"&&window.matchMedia("(max-width: 900px)").matches);
  const [pricesExpanded,setPricesExpanded]=React.useState(false);
  const [researchDisplay,setResearchDisplay]=React.useState<"benchmark"|"event">("benchmark");
  React.useEffect(()=>{
    const media=window.matchMedia("(max-width: 900px)");
    const update=()=>setCompactPrices(media.matches);
    update();media.addEventListener("change",update);
    return ()=>media.removeEventListener("change",update);
  },[]);
  const decision = view.decision;
  const twoStageProjection = (decision as (RoundDecision & { twoStage?: TwoStageProjection | null }) | null)?.twoStage;
  const exactRound = round !== undefined ? round : (decision ? { id: decision.roundId, startMs: decision.startMs, expiryMs: decision.expiryMs } : null);
  const exactDecision = identityMatches(decision, exactRound) && decision?.intervalMinutes === interval ? decision : null;
  const exactFresh = !!exactDecision && view.fresh;
  const timed = exactDecision?.timedDecision ?? null;
  const health = view.dataHealth ?? exactDecision?.dataHealth;
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
  const saving = !!exactDecision && !locked && (timed?.persistence === "SAVING" || view.persistenceState === "WRITING" || view.persistenceState === "QUEUED");
  const state = fixtureLocked ? "LOCKED UP"
    : locked ? `LOCKED ${savedSide}`
      : saving ? "SAVING"
        : roundComplete ? "ROUND COMPLETE"
          : currentSide ? `LEANING ${currentSide}` : "WATCHING";
  const blocker = waitingForOdds ? "Waiting for WaterX odds."
    : !exactDecision ? "Waiting for an exact active-round snapshot."
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
  const frozenDown = saved?.probabilityDown ?? null;
  const opportunity=exactDecision?.opportunity;
  const purchase=exactFresh&&odds&&opportunity?.receivedAtMs===odds.receivedAtMs?opportunity.purchase:null;
  const cents=(value:number|null|undefined)=>value!=null&&Number.isFinite(value)&&value>0&&value<=100?`${value.toFixed(2).replace(/\.00$/,"")}¢`:null;
  const upAsk=purchase?.up.status==="reported"?cents(purchase.up.askCents):null;
  const downAsk=purchase?.down.status==="reported"?cents(purchase.down.askCents):null;
  const economicsMatch=!!economics&&economics.amountEnteredUsd===5&&!!exactRound&&
    economics.identity?.roundId===exactRound.id&&economics.identity.startMs===exactRound.startMs&&
    economics.identity.expiryMs===exactRound.expiryMs&&economics.identity.intervalMinutes===interval&&exactFresh;
  const indicative=economicsMatch?(["up","down"] as const).flatMap(side=>{
    const quote=economics!.sides[side]?.quote;
    const receipt=quote?.grossReceiptIfWinIndicative;
    return typeof receipt==="number"&&Number.isFinite(receipt)&&receipt>0?
      [{side,receipt}]:[];
  }):[];
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

  return <section className={`manual-opportunity compact-decision${children ? " has-chart" : ""}${locked ? " is-locked" : ""}`} aria-label="Exact-round research state" aria-busy={loading}>
    <div className="desk-primary-card">
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
      <h3 className="desk-section-title">WaterX market</h3>
      <div className="desk-probability probability-up"><span>UP</span><strong>{odds ? percent(odds.probabilityUp) : "—"}</strong></div>
      <div className="desk-probability probability-down"><span>DOWN</span><strong>{odds ? percent(odds.probabilityDown) : "—"}</strong></div>
      <div className="desk-probability-source">
        <small>{odds ? `WaterX · ${Math.max(0,Math.floor((now-odds.receivedAtMs)/1000))}s ago · app observed` : "WaterX · no current probability receipt"}</small>
      </div>
      {purchase&&(upAsk||downAsk)&&<div className="desk-purchase-prices"><span>Purchase price (not probability)</span><b>UP {upAsk??"Not reported"} · DOWN {downAsk??"Not reported"}</b></div>}
    </div>

    <TwoStageDeskRows projection={twoStageProjection} round={exactRound} interval={interval} now={now} />
    {locked && <div className="desk-frozen-evidence">
      <span>Frozen lock · {savedSide} · active benchmark</span>
      <strong>UP {percent(frozenUp)} <i>·</i> DOWN {percent(frozenDown)}</strong>
      <small>{savedSource} · saved {time(saved?.committedAtMs ?? saved?.decisionAtMs)} · {clock(exactRound!.expiryMs-(saved?.committedAtMs??saved?.decisionAtMs??exactRound!.expiryMs))} before close</small>
    </div>}

    <div className={`desk-decision-card${locked ? " locked" : ""}`}>
      <h3 className="desk-section-title">Bluewater decision <span className="desk-active-policy">ACTIVE · 30-SECOND BENCHMARK</span></h3>
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
        {locked && <div className="desk-next-evaluation"><span>Benchmark saved choice</span><strong>{time(saved?.committedAtMs ?? saved?.decisionAtMs)}</strong></div>}
        {!locked && <div className="desk-checklist" aria-label={waitingForOdds?"Not evaluated: missing odds":`Qualification progress: ${requirementMet ?? "—"} of ${requirementsTotal} conditions met`}>
          {!waitingForOdds&&qualified.map((met, index) => <span key={index} className={met ? "met" : ""} title={["Fresh input", "Directional strength", "Same-side persistence", "Stable evidence"][index]} />)}
          <small>{waitingForOdds?"Not evaluated: missing odds":requirementMet == null ? "Qualification" : `${requirementMet} of ${requirementsTotal} conditions`}</small>
        </div>}
      </div>
      <div className={`desk-data-health${exactFresh ? " current" : ""}`}>
        <span>MARKET DATA</span><b>{health?.probabilities.status?.replaceAll("_", " ") ?? (exactFresh ? "CURRENT" : "UNAVAILABLE")}</b>
      </div>
      {waitingForOdds&&locked&&<p className="desk-odds-notice" role="status">Waiting for WaterX odds.</p>}
      {fixtureName && <span className="desk-fixture-indicator">Development visual fixture · {fixtureName.replaceAll("-", " ")}</span>}
    </div>
    {indicative.length>0&&<details className="desk-economics"><summary>$5 economics · indicative only</summary>
      <p>Before fees, minimums and price impact. Not an executable quote or expected profit.</p>
      {indicative.map(row=><p key={row.side}>{row.side.toUpperCase()} · indicative gross winning receipt {usd(row.receipt)}</p>)}
    </details>}
    </div>

    <details className="desk-price-details" open={!compactPrices||pricesExpanded}
      onToggle={event=>{if(compactPrices)setPricesExpanded(event.currentTarget.open);}}>
    <summary>BTC, reference and price difference</summary>
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
    </details>
    {children&&<div className="desk-chart-slot">{children}</div>}
    <details className="desk-details">
      <summary>Details</summary>
      <div className="desk-policy-choice">
        <span>Research-policy display · display only</span>
        <div role="group" aria-label="Research policy display">
          <button type="button" aria-pressed={researchDisplay==="benchmark"} onClick={()=>setResearchDisplay("benchmark")}>30-second benchmark · active</button>
          <button type="button" aria-pressed={researchDisplay==="event"} onClick={()=>setResearchDisplay("event")}>Event challenger · shadow</button>
        </div>
      </div>
      {researchDisplay==="event" && <EventChallengerPanel
        projection={exactDecision?.eventChallenger}
        round={exactRound}
        now={now}
      />}
      <div className="desk-details-grid">
        <span>Live odds source</span><b>{odds ? "WaterX market" : "Unavailable; no trained-model fallback"}</b>
        <span>Data condition</span><b>{health?.primaryReason?.replaceAll("_", " ") ?? (view.fresh ? "Current" : "Waiting for snapshot")}</b>
        <span>Saved round choice</span><b>{saved ? `${savedSide ?? "No side"} · immutable · ${time(saved.committedAtMs ?? saved.decisionAtMs)}` : fixtureLocked ? "Synthetic visual lock · not saved" : "No saved choice reported"}</b>
        {saved && <><span>Frozen probability</span><b>{savedSource} · UP {percent(frozenUp)} · DOWN {percent(frozenDown)}</b></>}
        <span>Exact round</span><b>{exactRound?.id ?? "Not available"}</b>
        <span>Strategy</span><b>{exactDecision ? view.strategyVersion ?? exactDecision.policyVersion : "Not reported"}</b>
        <span>Timed blocker</span><b>{timed?.blocker?.replaceAll("_", " ") ?? "Not reported"}</b>
        {timed?.lastGate && <><span>Last gate</span><b>{timed.lastGate.result.replaceAll("_", " ")} · {time(timed.lastGate.scheduledAtMs)}</b></>}
        {nextGateAtMs != null && <><span>Next benchmark gate</span><b>{time(nextGateAtMs)}</b></>}
        <span>30-second benchmark countdown</span><b>{nextGateAtMs == null ? "No further scheduled checkpoint" : `${clock(nextGateAtMs - now) ?? "Not scheduled"} · scheduled benchmark evaluation only; not a challenger lock deadline`}</b>
        {staleSameRound && <><span>Last same-round odds</span><b>Stale · UP {percent(stale.up)} · DOWN {percent(stale.down)} · observed {time(stale.receivedAtMs)}</b></>}
        <span>Snapshot revision</span><b>{!exactDecision || view.snapshotVersion == null ? "Not available" : `v${view.snapshotVersion} · ${time(view.componentTimestamps.snapshotPublishedAtMs)}`}</b>
      </div>
      <p className="desk-detail-note">This is read-only market research, not a forecast or trading instruction. Comparison price does not determine WaterX settlement. Automatic execution is disabled.</p>
    </details>
  </section>;
}
