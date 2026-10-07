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
const score = (lock: StageLock | null, row: TwoStageRoundRow) => !lock ? "No lock"
  : row.disputed ? "Disputed" : row.outcome == null ? "Pending"
    : lock.side === row.outcome ? "Correct" : "Incorrect";
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
  const scored = stats.scoredN;
  const ratio = `${stats.correct} : ${stats.incorrect}`;
  return <section className="two-stage-stats" aria-label={`${title} statistics`}>
    <header><h3>{title}</h3><span>stage-specific cohort</span></header>
    <div className="two-stage-stat-grid">
      <div><span>Correct : incorrect</span><b>{ratio}</b></div>
      <div><span>Accuracy · scored n={scored}</span><b>{percent(stats.accuracy)}</b></div>
      <div><span>Pending / disputed</span><b>{stats.pending} / {stats.disputed}</b></div>
      <div><span>Decision coverage · locks / cohort</span><b>{stats.locks} / {stats.cohortN} · {percent(stats.coverage)}</b></div>
      <div><span>Lock elapsed · median / p90</span><b>{duration(stats.medianElapsedMs)} / {duration(stats.p90ElapsedMs)}</b></div>
      <div><span>Calibration</span><b>{calibration(stats.calibration)}</b></div>
      {stats.earlyWindows?.map(window => <div key={window.seconds}><span>Locks by {window.seconds}s · locks / cohort n={stats.cohortN}</span><b>{window.locks} / {stats.cohortN} · {percent(window.rate)}</b></div>)}
      <div><span>Brier score</span><b>{stats.brier == null ? "Not reported" : stats.brier.toFixed(4)}</b></div>
      <div><span>Entry-economics evidence</span><b>{stats.indicativeN} indicative · {stats.verifiedQuoteN} verified quotes</b></div>
      <div><span>Actual trading P/L</span><b>{stats.actualTradingPnl == null ? "Unavailable · no fills inferred" : money(stats.actualTradingPnl)}</b></div>
    </div>
  </section>;
}

function StageEvidence({ title, lock }: { title: string; lock: StageLock | null }) {
  if (!lock) return <div className="two-stage-fact"><span>{title}</span><b>No committed lock returned</b></div>;
  const economics = lock.economics;
  return <>
    <div className="two-stage-fact"><span>{title} · frozen choice</span><b>{lock.side} · {percent(lock.probabilityUp)} UP / {percent(1 - lock.probabilityUp)} DOWN · {lock.probabilitySource}</b></div>
    <div className="two-stage-fact"><span>{title} · lock timing</span><b>Cutoff {dateTime(lock.evidenceCutoffMs)} · qualified {dateTime(lock.qualifiedAtMs)} · commit acknowledgement {dateTime(lock.committedAtMs)} · elapsed {duration(lock.elapsedMs)} · remaining {duration(lock.remainingMs)}</b></div>
    <div className="two-stage-fact"><span>{title} · provenance</span><b>{lock.network} · {lock.marketId} · {lock.strategyVersion} · {lock.policyVersion} · {lock.featureVersion} · model {lock.modelVersion ?? "not reported"} · calibration {lock.calibrationStatus}</b></div>
    <div className="two-stage-fact"><span>{title} · economics</span><b>{economics.kind} · collateral {money(economics.collateralUsd)} · return if correct {money(economics.totalReturnedIfCorrectUsd)} · net if correct {money(economics.netProfitIfCorrectUsd)} · loss if incorrect {money(economics.lossIfIncorrectUsd)} · costs {money(economics.totalCostUsd)} · {economics.reason}</b></div>
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
  </>;
}

export function RoundRow({ row }: { row: TwoStageRoundRow }) {
  const early = committedHistoryLock(row.early, "EARLY", row);
  const confirmation = committedHistoryLock(row.confirmation, "CONFIRMATION", row);
  const stageSummary = (lock: StageLock | null) => lock
    ? `${lock.side} · ${duration(lock.elapsedMs)}` : "No lock";
  return <article className="two-stage-history-row">
    <details>
      <summary>
        <span className="two-stage-row-round"><b>{dateTime(row.startMs)}</b><small>{row.intervalMinutes}m · {row.roundId}</small></span>
        <span><b>{stageSummary(early)}</b><small>Early Lock</small></span>
        <span><b>{stageSummary(confirmation)}</b><small>Confirmation Lock</small></span>
        <span className="two-stage-row-relationship">{row.relationship}</span>
        <span className="two-stage-row-outcome">{row.disputed ? "Disputed" : row.outcome ?? "Pending"}</span>
      </summary>
      <div className="two-stage-row-details">
        <div className="two-stage-detail-score"><span>Early score</span><b>{score(early, row)}</b><span>Confirmation score</span><b>{score(confirmation, row)}</b></div>
        <div className="two-stage-fact"><span>Exact round</span><b>{row.roundId} · {row.marketId} · {row.intervalMinutes}m · {dateTime(row.startMs)} → {dateTime(row.expiryMs)}</b></div>
        <div className="two-stage-fact"><span>Relationship and verified outcome</span><b>{row.relationship} · {row.disputed ? "Disputed; excluded from accuracy" : readable(row.outcome)}</b></div>
        <StageEvidence title="Early Lock" lock={early} />
        <StageEvidence title="Confirmation Lock" lock={confirmation} />
        <div className="two-stage-fact"><span>Round diagnostics</span><b>Early: {row.earlyReason || "not reported"} · Confirmation: {row.confirmationReason || "not reported"} · data failure {row.dataFailure ? "yes" : "no"}</b></div>
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
      const validVersion = body.strategyVersion === TWO_STAGE_STRATEGY || body.strategyVersion === PREVIOUS_TWO_STAGE_STRATEGY;
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
      <div><span>PROSPECTIVE SHADOW RECORD · NOT TRADES</span><h2 id="two-stage-history-title">Early + Confirmation history</h2>
        <p>Two immutable stage records per round. The active research strategy remains waterx-qualification-gates-v3.</p></div>
      {load.kind === "ready" && <div className="two-stage-asof">AS OF · {dateTime(load.data.asOfMs)}<br />SHADOW · {load.data.strategyVersion}</div>}
    </header>
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
    {cohort && <p className="two-stage-cohort">COHORT · {cohort.interval} · {cohort.window} · {cohort.cohortN} discovered rounds · {cohort.denominator} · offset {cohort.timezoneOffsetMinutes} min</p>}
    {load.kind === "loading" && <div className="two-stage-loading" role="status" aria-label="Loading two-stage round history"><i /><i /><i /></div>}
    {load.kind === "error" && <div className="two-stage-error" role="alert"><b>Two-stage history unavailable</b><span>{load.message}</span>
      <button type="button" onClick={() => setReloadKey(value => value + 1)}>Retry</button></div>}
    {load.kind === "ready" && <>
      <p className="two-stage-denominator">Stage coverage uses {cohort?.cohortN ?? "not reported"} captured exact shadow rounds. Missing records use separately discovered active-strategy rounds since shadow capture began, not inferred time slots.</p>
      <div className="two-stage-stage-stats"><StageStatsBlock title="Early Lock" stats={load.data.early} /><StageStatsBlock title="Confirmation Lock" stats={load.data.confirmation} /></div>
      <section className="two-stage-paired" aria-label="Paired stage outcomes">
        <header><h3>Paired outcomes</h3><span>round counts · not independent predictions</span></header>
        <div className="two-stage-paired-grid">{pairedRows.map(([key, label]) => <div key={key}><span>{label}</span><b>{paired?.[key] ?? "Not reported"}</b></div>)}</div>
      </section>
      <section className="two-stage-data-quality" aria-label="Cohort data completeness">
        <span>Data failure rate · discovered cohort n={cohort?.cohortN ?? "not reported"}</span><b>{percent(load.data.dataFailureRate)} · count not returned</b>
        <span>Missing-record rate · active discovered rounds n={load.data.expectedCohortN ?? "not reported"}</span><b>{percent(load.data.missingRecordRate)} · {load.data.missingRecordDenominator ?? "denominator unavailable"}</b>
        <span>Active-strategy discovered cohort denominator</span><b>{load.data.expectedCohortN ?? "Not reported"}</b>
      </section>
      {load.data.breakdown != null && <details className="two-stage-learning two-stage-breakdown"><summary>Measured breakdowns · interval and build</summary>
        <p>Service-reported measurements only; denominators and missing groups are not inferred.</p>
        <pre>{JSON.stringify(load.data.breakdown, null, 2)}</pre>
      </details>}
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
