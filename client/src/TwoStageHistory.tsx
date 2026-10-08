import React, { useEffect, useMemo, useState } from "react";
import type { StageLock, StageStats, TwoStageHistory, TwoStageRoundRow } from "../../shared/two-stage";
import { TWO_STAGE_STRATEGY, PREVIOUS_TWO_STAGE_STRATEGY } from "../../shared/two-stage";

type Interval = "all" | "5" | "15";
type Window = "today" | "24h" | "7d" | "custom";
type StrategyFilter = "current" | "previous" | "all";
type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: TwoStageHistory };

const dateTime = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not recorded" : new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not reported" : `${(value * 100).toFixed(1)}%`;
const duration = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not reported" : `${(Math.max(0, value) / 1000).toFixed(1)}s`;
const money = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not reported" : `$${value.toFixed(2)}`;
const readable = (value: string | null | undefined) => value?.trim() || "Not reported";
type SettlementStatus = "VERIFIED" | "PENDING" | "WITHHELD" | "DISPUTED" | "MISSING" | "IDENTITY_MISMATCH";
type IndependentScore = "CORRECT" | "INCORRECT" | "PENDING" | "WITHHELD" | "DISPUTED" | "NO_LOCK" | "ABSTAINED" | "DATA_FAILURE" | "IDENTITY_MISMATCH" | "OBSERVING";
type ExtendedRound = TwoStageRoundRow & {
  settlementStatus?: SettlementStatus;
  settlementReason?: string | null;
  earlyScore?: IndependentScore;
  confirmationScore?: IndependentScore;
};
type PairedRates = { scoredN: number; earlyAccuracy: number | null; confirmationAccuracy: number | null; agreementN: number; disagreementN: number };
const settlement = (row: TwoStageRoundRow) => {
  const extended = row as ExtendedRound;
  const status = extended.settlementStatus ?? (row.disputed ? "DISPUTED" : "MISSING");
  // A direction is evidence only when the service explicitly marks the settlement VERIFIED.
  const outcome = status === "VERIFIED" ? row.outcome : null;
  return { status, outcome, reason: extended.settlementReason };
};
const settlementLabel = (status: SettlementStatus) => ({
  VERIFIED: "Verified outcome", PENDING: "Settlement pending", WITHHELD: "Outcome withheld",
  DISPUTED: "Outcome disputed", MISSING: "Settlement record missing", IDENTITY_MISMATCH: "Round identity mismatch",
}[status]);
const score = (lock: StageLock | null, row: TwoStageRoundRow, stage: "early" | "confirmation") => {
  const extended = row as ExtendedRound;
  const supplied = stage === "early" ? extended.earlyScore : extended.confirmationScore;
  if (supplied) return supplied.replaceAll("_", " ");
  if (!lock) return "No lock";
  const result = settlement(row);
  if (result.status === "WITHHELD" || result.status === "MISSING" || result.status === "IDENTITY_MISMATCH") return settlementLabel(result.status);
  if (result.status === "DISPUTED" || row.disputed) return "Disputed";
  if (result.status !== "VERIFIED" || result.outcome == null) return "Pending";
  return lock.side === result.outcome ? "Correct" : "Incorrect";
};
const calibration = (value: unknown) => value == null ? "Not reported" : JSON.stringify(value);
const committedHistoryLock = (lock: StageLock | null, stage: "EARLY" | "CONFIRMATION", row: TwoStageRoundRow) => {
  const expectedVersion = row.strategyVersion ?? lock?.strategyVersion;
  if (!lock || lock.stage !== stage || lock.network !== "sui:mainnet" ||
    ![TWO_STAGE_STRATEGY, PREVIOUS_TWO_STAGE_STRATEGY].includes(lock.strategyVersion) ||
    !expectedVersion || lock.strategyVersion !== expectedVersion || lock.shadowOnly !== true ||
    lock.automaticExecutionAllowed !== false || lock.roundId !== row.roundId ||
    lock.startMs !== row.startMs || lock.expiryMs !== row.expiryMs ||
    lock.intervalMinutes !== row.intervalMinutes || lock.marketId !== row.marketId ||
    (lock.commitVerified !== true && (lock.committedAtMs == null || !Number.isFinite(lock.committedAtMs))) ||
    (lock.side !== "UP" && lock.side !== "DOWN") ||
    !Number.isFinite(lock.probabilityUp) || lock.probabilityUp < 0 || lock.probabilityUp > 1) return null;
  return lock;
};

export function StageStatsBlock({ title, stats }: { title: string; stats: StageStats }) {
  const extended = stats as StageStats & { noLockN?: number; abstainedN?: number; dataFailureN?: number; withheldN?: number };
  const unrecorded = extended.noLockN ?? Math.max(0, stats.cohortN - stats.locks);
  return <section className="two-stage-stats" aria-label={`${title} statistics`}>
    <header><h3>{title}</h3><span>INDEPENDENT STAGE RECORD</span></header>
    <div className="two-stage-scoreline" aria-label={`${title}: ${stats.correct} correct, ${stats.incorrect} incorrect, ${unrecorded} unrecorded`}>
      <div><b>{stats.correct}</b><span>CORRECT</span></div>
      <i aria-hidden="true">:</i>
      <div><b>{stats.incorrect}</b><span>INCORRECT</span></div>
      <i aria-hidden="true">:</i>
      <div><b>{unrecorded}</b><span>UNRECORDED</span></div>
    </div>
    <div className="two-stage-accuracy"><span>Accuracy · scored n={stats.scoredN}</span><b>{percent(stats.accuracy)}</b></div>
    <div className="two-stage-stat-grid">
      <div><span>Pending · disputed</span><b>{stats.pending} · {stats.disputed}</b></div>
      <div><span>Locked · stage cohort</span><b>{stats.locks} · {stats.cohortN} · coverage {percent(stats.coverage)}</b></div>
      <div><span>Abstained · data failure</span><b>{extended.abstainedN ?? "Not reported"} · {extended.dataFailureN ?? "Not reported"}</b></div>
      <div><span>Outcome withheld</span><b>{extended.withheldN ?? "Not reported"}</b></div>
      {!!stats.observingN && <div><span>Still observing</span><b>{stats.observingN}</b></div>}
      {!!stats.unclassifiedN && <div><span>Missing cause · not established</span><b>{stats.unclassifiedN}</b></div>}
    </div>
    <details className="two-stage-advanced-stats"><summary>Timing, calibration and research measurements</summary>
      <div className="two-stage-stat-grid">
        <div><span>Lock elapsed · median / p90</span><b>{duration(stats.medianElapsedMs)} / {duration(stats.p90ElapsedMs)}</b></div>
        <div><span>Calibration</span><b>{calibration(stats.calibration)}</b></div>
        {stats.earlyWindows?.map(window => <div key={window.seconds}><span>Locks by {window.seconds}s · locks / cohort n={stats.cohortN}</span><b>{window.locks} / {stats.cohortN} · {percent(window.rate)}</b></div>)}
        <div><span>Brier score</span><b>{stats.brier == null ? "Not reported" : stats.brier.toFixed(4)}</b></div>
        <div><span>Indicative economics · research only</span><b>{stats.indicativeN} indicative · {stats.verifiedQuoteN} verified quotes · not executable evidence</b></div>
        <div><span>Actual trading P/L</span><b>Unavailable · no fills inferred</b></div>
      </div>
    </details>
  </section>;
}

function StageEvidence({ title, lock }: { title: string; lock: StageLock | null }) {
  if (!lock) return <div className="two-stage-fact"><span>{title}</span><b>No committed lock returned</b></div>;
  const economics = lock.economics;
  return <details className="two-stage-stage-evidence">
    <summary>{title} · frozen decision and audit evidence</summary>
    <div className="two-stage-fact"><span>{title} · frozen choice</span><b>{lock.side} · {percent(lock.probabilityUp)} UP / {percent(1 - lock.probabilityUp)} DOWN · {lock.probabilitySource}</b></div>
    <div className="two-stage-fact"><span>{title} · lock timing</span><b>Cutoff {dateTime(lock.evidenceCutoffMs)} · qualified {dateTime(lock.qualifiedAtMs)} · commit acknowledgement {dateTime(lock.committedAtMs)} · elapsed {duration(lock.elapsedMs)} · remaining {duration(lock.remainingMs)}</b></div>
    <div className="two-stage-fact"><span>{title} · provenance</span><b>{lock.network} · {lock.marketId} · {lock.strategyVersion} · {lock.policyVersion} · {lock.featureVersion} · model {lock.modelVersion ?? "not reported"} · calibration {lock.calibrationStatus}</b></div>
    <div className="two-stage-fact"><span>{title} · indicative research economics · not executable / not P&amp;L</span><b>{economics.kind} · collateral {money(economics.collateralUsd)} · hypothetical return if correct {money(economics.totalReturnedIfCorrectUsd)} · hypothetical net if correct {money(economics.netProfitIfCorrectUsd)} · hypothetical loss if incorrect {money(economics.lossIfIncorrectUsd)} · estimated costs {money(economics.totalCostUsd)} · {economics.reason}</b></div>
    {lock.researchPreference && <div className="two-stage-fact"><span>{title} · frozen research preference</span><b>{lock.researchPreference.mode} · collateral {money(lock.researchPreference.collateralUsd)} · minimum return {money(lock.researchPreference.minimumReturnUsd)} · preferred return {money(lock.researchPreference.preferredReturnUsd)} · {lock.valueStatus ?? "value status not reported"}</b></div>}
    {lock.diagnostics && <div className="two-stage-fact"><span>{title} · qualification measurements / thresholds</span><b>{lock.diagnostics.message} · measurements {JSON.stringify(lock.diagnostics.measurements)} · thresholds {JSON.stringify(lock.diagnostics.thresholds)}</b></div>}
    {lock.timing && <div className="two-stage-fact"><span>{title} · processing timeline</span><b>Server received {dateTime(lock.timing.receivedAtMs)} · accepted {dateTime(lock.timing.acceptedAtMs)} · qualified {dateTime(lock.timing.qualifiedAtMs)} · acquisition started {dateTime(lock.timing.acquisitionStartedAtMs)} · acquired {dateTime(lock.timing.acquiredAtMs)} · server commit acknowledgement {dateTime(lock.timing.commitAcknowledgedAtMs)} · projection {dateTime(lock.timing.projectionAtMs)}</b></div>}
    <div className="two-stage-fact"><span>{title} · quote and observations</span><b>Quote {economics.quoteId ?? "not reported"} · age {duration(economics.quoteAgeMs)} · {economics.payoutRule ?? "payout rule not reported"} · observation IDs {lock.observationIds.join(", ") || "none reported"}</b></div>
    <details className="two-stage-evidence"><summary>{title} frozen reference, coverage and features</summary><pre>{JSON.stringify({
      reference: lock.reference, coverage: lock.coverage, features: lock.features,
      economics: lock.economics, captureMode: lock.captureMode, shadowOnly: lock.shadowOnly,
      automaticExecutionAllowed: lock.automaticExecutionAllowed, diagnostics: lock.diagnostics,
      timing: lock.timing, researchPreference: lock.researchPreference, valueStatus: lock.valueStatus,
    }, null, 2)}</pre></details>
  </details>;
}

export function RoundRow({ row }: { row: TwoStageRoundRow }) {
  const early = committedHistoryLock(row.early, "EARLY", row);
  const confirmation = committedHistoryLock(row.confirmation, "CONFIRMATION", row);
  const result = settlement(row);
  const leadTime = early && confirmation && early.committedAtMs != null && confirmation.committedAtMs != null
    ? duration(Math.abs(confirmation.committedAtMs - early.committedAtMs)) : "Not available";
  const earlyScore = score(early, row, "early");
  const confirmationScore = score(confirmation, row, "confirmation");
  const scoreTone = (value: string) => value.toLowerCase().replaceAll(" ", "-");
  const outcomeTone = result.status === "VERIFIED"
    ? (result.outcome === "UP" ? "two-stage-outcome-up" : "two-stage-outcome-down") : "two-stage-outcome-unverified";
  const correctBy = earlyScore.toUpperCase() === "CORRECT" && confirmationScore.toUpperCase() === "CORRECT"
    ? "Both stages" : earlyScore.toUpperCase() === "CORRECT" ? "Early only"
      : confirmationScore.toUpperCase() === "CORRECT" ? "Confirmation only"
        : earlyScore.toUpperCase() === "INCORRECT" && confirmationScore.toUpperCase() === "INCORRECT" ? "Neither stage" : "Not comparable";
  return <article className="two-stage-history-row">
    <details>
      <summary>
        <span className="two-stage-row-round"><b>{new Date(row.startMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</b><small>{new Date(row.startMs).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · BTC {row.intervalMinutes}m</small></span>
        <span className="two-stage-row-stage"><small>EARLY LOCK</small><b>{early?.side ?? "No lock"}</b><em>{earlyScore}</em><small>{dateTime(early?.committedAtMs)}</small></span>
        <span className="two-stage-row-stage"><small>CONFIRMATION</small><b>{confirmation?.side ?? "No lock"}</b><em>{confirmationScore}</em><small>{dateTime(confirmation?.committedAtMs)}</small></span>
        <span className="two-stage-row-relationship"><small>CONGRUENCE</small><b>{early && confirmation ? (early.side === confirmation.side ? "AGREE" : "DISAGREE") : "NO PAIR"}</b><small>{correctBy} correct</small></span>
        <span className={`two-stage-row-outcome ${outcomeTone}`}><small>WATERX FINAL</small><b>{result.status === "VERIFIED" ? readable(result.outcome) : settlementLabel(result.status)}</b><small>{result.status === "VERIFIED" ? "Verified outcome" : "Not scored as final"}</small></span>
      </summary>
      <div className="two-stage-row-details">
        <div className="two-stage-detail-score"><span>Early score</span><b className={`two-stage-score-${scoreTone(earlyScore)}`}>{earlyScore}</b><span>Confirmation score</span><b className={`two-stage-score-${scoreTone(confirmationScore)}`}>{confirmationScore}</b></div>
        <div className="two-stage-fact"><span>Immutable stage timestamps · lead time</span><b>Early committed {dateTime(early?.committedAtMs)} · Confirmation committed {dateTime(confirmation?.committedAtMs)} · separation {leadTime}</b></div>
        <div className="two-stage-fact"><span>Round time</span><b>Started {dateTime(row.startMs)} · expires {dateTime(row.expiryMs)} · {row.intervalMinutes} minute interval</b></div>
        <div className="two-stage-fact"><span>Settlement status · verified outcome</span><b>{settlementLabel(result.status)} · {result.status === "VERIFIED" ? readable(result.outcome) : "Not verified; outcome excluded"}{result.reason ? ` · ${result.reason}` : ""}</b></div>
        {row.settlementEvidence && <div className="two-stage-fact"><span>Verification evidence · incomplete results remain PROVISIONAL / UNVERIFIED</span><pre>{JSON.stringify(row.settlementEvidence,null,2)}</pre></div>}
        <div className="two-stage-fact"><span>Which stage was correct</span><b>{correctBy}</b></div>
        <div className="two-stage-fact"><span>Independent stage records</span><b>Early and Confirmation are separate immutable records; neither replaces the other.</b></div>
        <StageEvidence title="Early Lock" lock={early} />
        <StageEvidence title="Confirmation Lock" lock={confirmation} />
        <div className="two-stage-fact"><span>No-lock reason · Early</span><b>{early ? "Lock recorded" : row.earlyReason || "Not reported"}</b></div>
         <div className="two-stage-fact"><span>No-lock reason · Confirmation</span><b>{confirmation ? "Lock recorded" : row.confirmationReason || "Not reported"} · final classification {row.confirmationCaptureCause ?? "Not reported"} · source incident {row.sourceIncident ? "recorded" : "none reported"}</b></div>
      </div>
    </details>
  </article>;
}

export default function TwoStageHistory() {
  const [interval, setInterval] = useState<Interval>("all");
  const [windowFilter, setWindowFilter] = useState<Window>("today");
  const [strategy, setStrategy] = useState<StrategyFilter>("current");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  const customRange = useMemo(() => {
    if (!customFrom || !customTo) return null;
    const fromDate = new Date(`${customFrom}T00:00:00`);
    const endDate = new Date(`${customTo}T00:00:00`);
    endDate.setDate(endDate.getDate() + 1);
    const fromMs = fromDate.getTime();
    const toMs = endDate.getTime();
    return Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs ? { fromMs, toMs } : null;
  }, [customFrom, customTo]);

  useEffect(() => {
    if (windowFilter === "custom" && !customRange) {
      setLoad({ kind: "error", message: "Choose a valid custom start and end date; the end date is inclusive." });
      return;
    }
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    const params = new URLSearchParams({
      interval, window: windowFilter,
      timezoneOffsetMinutes: String(new Date().getTimezoneOffset()), limit: "100", strategy,
    });
    if (windowFilter === "custom" && customRange) {
      params.set("fromMs", String(customRange.fromMs));
      params.set("toMs", String(customRange.toMs));
    }
    fetch(`/api/waterx/two-stage/history?${params}`, {
      credentials: "include", signal: controller.signal, headers: { Accept: "application/json" },
    }).then(async response => {
      const body = await response.json().catch(() => ({})) as Partial<TwoStageHistory> & { error?: string; reason?: string };
      const validVersion = body.strategyVersion === TWO_STAGE_STRATEGY || body.strategyVersion === PREVIOUS_TWO_STAGE_STRATEGY ||
        (strategy === "all" && body.strategyVersion === "all-versioned-shadow-rounds");
      if (!response.ok || !validVersion || body.shadowOnly !== true ||
        body.activeStrategy !== "waterx-qualification-gates-v3" || !body.cohort ||
        !body.early || !body.confirmation || !body.paired || !Array.isArray(body.rows))
        throw new Error(body.error || body.reason || `Two-stage history unavailable (${response.status}).`);
      if (!controller.signal.aborted) setLoad({ kind: "ready", data: body as TwoStageHistory });
    }).catch(error => {
      if (!controller.signal.aborted) setLoad({ kind: "error", message: error instanceof Error ? error.message : "Two-stage history could not be loaded." });
    });
    return () => controller.abort();
  }, [interval, windowFilter, strategy, customRange, reloadKey]);

  const cohort = load.kind === "ready" ? load.data.cohort : null;
  const paired = load.kind === "ready" ? load.data.paired : null;
  const pairedRates = load.kind === "ready"
    ? (load.data as TwoStageHistory & { pairedRates?: PairedRates }).pairedRates : undefined;
  const pairedRows: [keyof NonNullable<typeof paired>, string][] = [
    ["BOTH_CORRECT", "Both correct"],
    ["EARLY_WRONG_CONFIRMATION_CORRECT", "Early wrong · confirmation correct"],
    ["EARLY_CORRECT_CONFIRMATION_WRONG", "Early correct · confirmation wrong"],
    ["BOTH_WRONG", "Both wrong"],
    ["BOTH_PENDING_OR_DISPUTED", "Both pending or disputed"],
    ["EARLY_ONLY", "Early only"],
    ["CONFIRMATION_ONLY", "Confirmation only"],
    ["NEITHER", "Neither"],
  ];

  return <section className="two-stage-history" aria-labelledby="two-stage-history-title">
    <header className="two-stage-history-heading">
      <div><h2 id="two-stage-history-title">Independent stage performance</h2>
        <p>Prospective predictions · not trades.</p></div>
      {load.kind === "ready" && <div className="two-stage-asof">AS OF · {dateTime(load.data.asOfMs)}<br />SHADOW · {load.data.strategyVersion}</div>}
    </header>
    {load.kind === "ready" && <div className="two-stage-stage-stats"><StageStatsBlock title="Early Lock" stats={load.data.early} /><StageStatsBlock title="Confirmation Lock" stats={load.data.confirmation} /></div>}
    <div className="two-stage-filters">
      <label>Interval<select value={interval} onChange={event => setInterval(event.target.value as Interval)}>
        <option value="all">All intervals</option><option value="5">5 min</option><option value="15">15 min</option>
      </select></label>
      <label>Window<select value={windowFilter} onChange={event => setWindowFilter(event.target.value as Window)}>
        <option value="today">Today · local</option><option value="24h">Last 24 hours</option>
        <option value="7d">Last 7 days</option><option value="custom">Custom range</option>
      </select></label>
      <label>Strategy evidence<select value={strategy} onChange={event => setStrategy(event.target.value as StrategyFilter)}>
        <option value="current">Current · v2</option><option value="previous">Previous · v1</option><option value="all">All versions</option>
      </select></label>
      {windowFilter === "custom" && <div className="two-stage-custom">
        <label>From<input type="date" value={customFrom} onChange={event => setCustomFrom(event.target.value)} /></label>
        <label>Through<input type="date" value={customTo} onChange={event => setCustomTo(event.target.value)} /></label>
      </div>}
    </div>
    {cohort && <p className="two-stage-cohort">{cohort.cohortN} discovered BTC rounds · {cohort.interval === "all" ? "5 + 15 minute" : `${cohort.interval} minute`} · {cohort.window}</p>}
    {load.kind === "loading" && <div className="two-stage-loading" role="status" aria-label="Loading two-stage round history"><i /><i /><i /></div>}
    {load.kind === "error" && <div className="two-stage-error" role="alert"><b>Two-stage history unavailable</b><span>{load.message}</span>
      <button type="button" onClick={() => setReloadKey(value => value + 1)}>Retry</button></div>}
    {load.kind === "ready" && <>
      <section className="two-stage-paired" aria-label="Paired stage outcomes">
        <header><h3>Congruence</h3><span>direction agreement · not correctness</span></header>
        <div className="two-stage-paired-rates">
          <span className="two-stage-paired-sample">Verified paired sample <b>n={pairedRates?.scoredN ?? "Not reported"}</b></span>
          <span>AGREE <b>{pairedRates?.agreementN ?? "Not reported"}</b></span>
          <span>DISAGREE <b>{pairedRates?.disagreementN ?? "Not reported"}</b></span>
          <span>Early / Confirmation accuracy <b>{percent(pairedRates?.earlyAccuracy)} / {percent(pairedRates?.confirmationAccuracy)}</b></span>
        </div>
        <details className="two-stage-paired-breakdown"><summary>Show paired result breakdown</summary>
          <div className="two-stage-paired-grid">{pairedRows.map(([key, label]) => <div key={key}><span>{label}</span><b>{paired?.[key] ?? "Not reported"}</b></div>)}</div>
        </details>
      </section>
       <details className="two-stage-learning"><summary>Capture coverage and provenance</summary>
       <p className="two-stage-denominator">Stage coverage uses {cohort?.cohortN ?? "not reported"} captured exact shadow rounds. Missing records use separately discovered active-strategy rounds since shadow capture began, not inferred time slots.</p>
       <section className="two-stage-data-quality" aria-label="Cohort data completeness">
        <span>Data failure rate · captured cohort n={cohort?.cohortN ?? "not reported"}</span><b>{percent(load.data.dataFailureRate)} · count not returned</b>
        <span>Missing-record coverage · separately discovered rounds</span><b>{percent(load.data.missingRecordRate)} · {load.data.missingRecordDenominator ?? "denominator unavailable"}</b>
        <span>Active-strategy discovered cohort denominator</span><b>{load.data.expectedCohortN ?? "Not reported"}</b>
      </section>
       </details>
      {load.data.breakdown != null && <details className="two-stage-learning two-stage-breakdown"><summary>Measured breakdowns · interval and build</summary>
        <p>Service-reported measurements only; denominators and missing groups are not inferred.</p>
        <pre>{JSON.stringify(load.data.breakdown, null, 2)}</pre>
      </details>}
      {load.data.settlementHealth && <section className="two-stage-paired-stats" aria-label="WaterX settlement health">
        <header><h3>WaterX settlement health</h3><span>Same filtered cohort · {load.data.settlementHealth.cohortN} rounds</span></header>
        <div className="two-stage-stat-grid">
          <div><span>Verified</span><b>{load.data.settlementHealth.verified}</b></div>
          <div><span>Pending</span><b>{load.data.settlementHealth.pending}</b></div>
          <div><span>Disputed</span><b>{load.data.settlementHealth.disputed}</b></div>
          <div><span>Missing</span><b>{load.data.settlementHealth.missing}</b></div>
          <div><span>Provisional / unverified</span><b>{load.data.settlementHealth.unverified}</b></div>
          <div><span>Identity mismatch</span><b>{load.data.settlementHealth.identityMismatch}</b></div>
        </div>
        <details><summary>Why outcomes remain unresolved</summary>
          {load.data.settlementHealth.unresolved.length?<ul>{load.data.settlementHealth.unresolved.map(r=><li key={`${r.intervalMinutes}-${r.roundId}`}>
            {r.intervalMinutes}m · {r.roundId} · {readable(r.status)} — {r.reason}</li>)}</ul>:<p>All settlements in this cohort are verified.</p>}
        </details>
      </section>}
      <div className="two-stage-round-list-heading"><h3>Paired round records</h3><span>{load.data.rows.length} shown{load.data.rowsTruncated ? " · page truncated" : ""}</span></div>
      {load.data.rows.length
        ? <div className="two-stage-round-list">{load.data.rows.map((row, index) => <RoundRow key={`${row.roundId}-${row.startMs}-${index}`} row={row} />)}</div>
        : <div className="two-stage-empty"><b>No discovered rounds in this window</b><p>The service returned no stage records for this cohort. Nothing is inferred for missing rounds.</p></div>}
      <details className="two-stage-learning"><summary>Learning and comparison diagnostics</summary>
        <p>Calibration is shown only where the service reports it. The comparison is not promoted policy evidence.</p>
        <pre>{JSON.stringify({ learning: load.data.learning, comparison: load.data.comparison }, null, 2)}</pre>
      </details>
      <p className="two-stage-footnote">Locks are shadow-only predictions, not orders. Accuracy is not trading P/L; indicative and verified quote evidence is not a fill. No expected missing slots are fabricated.</p>
    </>}
  </section>;
}
