import React, { useEffect, useMemo, useState } from "react";
import type { GateJournal, TimedDecision } from "../../shared/timed-decision";
if(typeof document!=="undefined")void import("./agent.css");

type Interval = "all" | 5 | 15;
type Strategy = "all" | string;
type CohortWindow = "today" | "24h" | "7d" | "custom";
type Deployment = "all" | "current" | "unknown" | string;
type ResultStatus = "CORRECT" | "INCORRECT" | "PENDING" | "DISPUTED" | "NO_VALID_INPUT" | "MISSED_DEADLINE" | "ABSTENTION" | "DATA_FAILURE" | "MISSING_RECORD";
type EntryEconomics = {
  kind: "INDICATIVE" | "VERIFIED_QUOTE" | "UNAVAILABLE";
  collateralUsd?: number | null;
  totalReturnedIfCorrectUsd?: number | null;
  netProfitIfCorrectUsd?: number | null;
  expectedNetUsd?: number | null;
  reason?: string | null;
  actualFill?: { collateralUsd?: number | null; totalReturnedIfCorrectUsd?: number | null; netProfitUsd?: number | null; filledAtMs?: number | null } | null;
};
type HistoryEntry = TimedDecision & {
  result?: ResultStatus;
  verifiedOutcome?: "UP" | "DOWN" | null;
  operationalReasons?: string[];
  entryEconomics?: EntryEconomics;
  deploymentId?: string | null;
  buildId?: string | null;
};
type HistoryMetrics = {
  n?: number; onTimeLocks?: number; deadlineLocks?: number; missed?: number; noValidInput?: number; settledN?: number;
  correct?: number; incorrect?: number; pending?: number; disputed?: number; hitRate?: number | null;
  ratio?: number | string | null; choiceCoverage?: number | null; onTimeCoverage?: number | null; medianElapsedMs?: number | null;
  cohortN?: number | null; locks?: number | null; dataFailures?: number | null; missingRecords?: number | null;
  dataFailureRate?: number | null; missingRecordRate?: number | null; p90ElapsedMs?: number | null;
  discoveredMissingRecordRate?: number | null;
  expectedCohortN?: number | null; expectedCohortStatus?: string;
  topLevelOutcomes?: Partial<Record<ResultStatus, number>>;
  operationalBreakdown?: {
    sourceUnavailable?: number; noQualifiedSignal?: number; schedulerMissedGate?: number; persistenceFailure?: number;
    gates?: { sourceUnavailable?: number; noQualifiedSignal?: number; schedulerMissedGate?: number };
  };
  [key: string]: unknown;
};
export type TimedHistoryResponse = {
  strategyVersion: string;
  entries: HistoryEntry[];
  metrics: HistoryMetrics;
  provenance?: { deploymentOptions?: { value: string; label: string }[]; denominator?: string; expectedSlotsVerified?: boolean };
};
type GateEntry = GateJournal & { intervalMinutes?: 5 | 15; roundId?: string; startMs?: number; expiryMs?: number };
type GateResponse = { strategyVersion: string; entries: GateEntry[]; metrics?: { abstentionRate?: number | null; operationalFailureRate?: number | null } };
type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: TimedHistoryResponse };

const dateTime = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not recorded" : new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not independently verified" : `${(value * 100).toFixed(1)}%`;
const duration = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not reported" : `${(Math.max(0, value) / 1000).toFixed(1)} sec`;
const currency = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not reported" : `$${value.toFixed(2)}`;
const shortRound = (id: string) => id.length > 42 ? `${id.slice(0, 22)}…${id.slice(-12)}` : id;
const scoreLabel = (entry: HistoryEntry): ResultStatus => entry.result ??
  (entry.status === "NO_VALID_INPUT" ? "NO_VALID_INPUT" : entry.status === "MISSED_DEADLINE" ? "MISSED_DEADLINE"
    : entry.status === "ABSTAINED_NO_QUALIFIED_SIGNAL" ? "ABSTENTION" : entry.status === "DATA_FAILURE" ? "DATA_FAILURE" : "PENDING");
const scoreClass = (status: ResultStatus) => status.toLowerCase().replaceAll("_", "-");
const topOutcomeLabels: ResultStatus[] = ["CORRECT", "INCORRECT", "PENDING", "DISPUTED", "ABSTENTION", "DATA_FAILURE", "NO_VALID_INPUT", "MISSED_DEADLINE", "MISSING_RECORD"];
const outcomeCount = (metrics: HistoryMetrics, key: ResultStatus) => metrics.topLevelOutcomes?.[key] ?? "Not reported";

function economyLabel(economics?: EntryEconomics) {
  if (!economics || economics.kind === "UNAVAILABLE") return "Unavailable";
  if (economics.actualFill) return `Actual fill · collateral ${currency(economics.actualFill.collateralUsd)} · net if correct ${currency(economics.actualFill.netProfitUsd)}`;
  const label = economics.kind === "INDICATIVE" ? "Indicative" : "Verified quote";
  return `${label} · collateral ${currency(economics.collateralUsd)} · return if correct ${currency(economics.totalReturnedIfCorrectUsd)} · net ${currency(economics.netProfitIfCorrectUsd)}`;
}

export function TimedDecisionHistoryRecords({ interval, data, visibleEntries }: { interval: Interval; data: TimedHistoryResponse; visibleEntries?: HistoryEntry[] }) {
  const rows = visibleEntries ?? data.entries;
  const metrics = data.metrics;
  const correct = metrics.correct ?? metrics.topLevelOutcomes?.CORRECT ?? null;
  const incorrect = metrics.incorrect ?? metrics.topLevelOutcomes?.INCORRECT ?? null;
  const scored = typeof correct === "number" && typeof incorrect === "number" ? correct + incorrect : null;
  const accuracy = scored && typeof correct === "number" ? `${((correct / scored) * 100).toFixed(1)}%` : scored === 0 ? "Not scored" : percent(metrics.hitRate ?? null);
  const cohort = metrics.cohortN ?? null;
  const locks = metrics.locks ?? null;
  const coverage = cohort != null && locks != null ? `${locks} / ${cohort} · ${cohort ? ((locks / cohort) * 100).toFixed(1) : "—"}%` : "Not reported";
  const dataFailures = metrics.dataFailures ?? null;
  const failureSummary = cohort != null && dataFailures != null ? `${dataFailures} / ${cohort} · ${cohort ? ((dataFailures / cohort) * 100).toFixed(1) : "—"}%` : "Not reported";
  const missing = metrics.missingRecords ?? null;
  const missingSummary = missing == null ? "Not reported" : `${missing} / ${cohort == null ? "discovered rounds not reported" : cohort} discovered · ${percent(metrics.discoveredMissingRecordRate ?? null)} of discovered known rounds`;
  const expectedSlots = data.provenance?.expectedSlotsVerified === true && metrics.expectedCohortN != null
    ? String(metrics.expectedCohortN) : "not independently verified";

  return <div className="timed-history-content">
    <div className="timed-history-summary" aria-label="Selected cohort summary">
      <div className="timed-history-primary"><span>Correct : Incorrect</span><b>{correct ?? "—"} : {incorrect ?? "—"}</b></div>
      <div><span>Accuracy · scored n={scored ?? "—"}</span><b>{accuracy}</b></div>
      <div><span>Decision coverage · locks / cohort</span><b>{coverage}</b></div>
      <div><span>Data failures / cohort</span><b>{failureSummary}</b></div>
      <div><span>Missing / discovered cohort</span><b>{missingSummary}</b></div>
      <div><span>Lock time · median / p90</span><b>{duration(metrics.medianElapsedMs ?? null)} / {duration(metrics.p90ElapsedMs ?? null)}</b></div>
    </div>
    <p className="timed-history-denominator">Coverage denominator: {cohort == null ? "discovered strategy rounds not reported" : `${cohort} discovered strategy rounds`}. Missing-record rate is among discovered known rounds only; expected slots: {expectedSlots}. {data.provenance?.denominator ?? "Denominator not reported."}</p>
    <details className="timed-history-diagnostics">
      <summary>Details · outcome reconciliation and diagnostics</summary>
      <div className="timed-history-metrics" aria-label="Mutually exclusive top-level round outcomes">
        {topOutcomeLabels.map(outcome => <div key={outcome}><span>{outcome.replaceAll("_", " ")}</span><b>{outcomeCount(metrics, outcome)}</b></div>)}
      </div>
      <p>Top-level outcome totals are mutually exclusive. Pending and disputed rounds are excluded from accuracy. Legitimate abstentions are not incorrect choices or data failures.</p>
      {metrics.operationalBreakdown && <section className="timed-operational-breakdown">
        <h4>Overlapping diagnostics · counts may overlap</h4>
        <div className="timed-history-metrics">
          <div><span>Source unavailable</span><b>{metrics.operationalBreakdown.sourceUnavailable ?? "Not reported"}</b></div>
          <div><span>No qualified signal</span><b>{metrics.operationalBreakdown.noQualifiedSignal ?? "Not reported"}</b></div>
          <div><span>Scheduler missed gate</span><b>{metrics.operationalBreakdown.schedulerMissedGate ?? "Not reported"}</b></div>
          <div><span>Persistence failure</span><b>{metrics.operationalBreakdown.persistenceFailure ?? "Not reported"}</b></div>
        </div>
        {metrics.operationalBreakdown.gates && <div className="timed-history-metrics" aria-label="Overlapping gate diagnostics">
          <div><span>Gate source unavailable · overlap</span><b>{metrics.operationalBreakdown.gates.sourceUnavailable ?? "Not reported"}</b></div>
          <div><span>Gate no qualified signal · overlap</span><b>{metrics.operationalBreakdown.gates.noQualifiedSignal ?? "Not reported"}</b></div>
          <div><span>Gate scheduler missed · overlap</span><b>{metrics.operationalBreakdown.gates.schedulerMissedGate ?? "Not reported"}</b></div>
        </div>}
      </section>}
    </details>
    <p className="timed-history-note">Correctness is not trading P/L. An indicative estimate is not an executable quote or a fill. Historical locks without orders have no actual trading return.</p>
    {rows.length === 0 ? <div className="timed-history-empty">No round records returned for these filters.</div>
      : <div className="timed-history-rows" aria-label="Timed strategy records">
        {rows.map(entry => {
          const result = scoreLabel(entry);
          const title = entry.status === "LOCKED" ? entry.side ?? "Locked"
            : entry.status === "ABSTAINED_NO_QUALIFIED_SIGNAL" ? "Abstained"
              : entry.status.replaceAll("_", " ");
          const elapsed = duration(entry.elapsedMs);
          const estimate = economyLabel(entry.entryEconomics);
          return <article className="timed-history-row" key={entry.id} data-decision-id={entry.id}>
            <details>
              <summary>
                <span className="timed-history-time"><b>{dateTime(entry.startMs)}</b><small>Round start</small></span>
                <span className="timed-history-interval">{entry.intervalMinutes}m</span>
                <span className="timed-history-choice"><b>{title}</b><small>{entry.status === "LOCKED" ? "Frozen prediction" : entry.earlyBlocker.replaceAll("_", " ")}</small></span>
                <span className="timed-history-time"><b>{elapsed}</b><small>Lock elapsed</small></span>
                <span className={`timed-history-status ${scoreClass(result)}`}>{result.replaceAll("_", " ")}</span>
                <span className="timed-history-economics">{estimate}</span>
              </summary>
              <div className="timed-history-facts">
                <div><span>Decision ID</span><b>{entry.id}</b></div><div><span>Strategy version</span><b>{entry.strategyVersion}</b></div>
                <div><span>Round ID</span><b title={entry.roundId}>{shortRound(entry.roundId)}</b></div><div><span>Deployment</span><b>{entry.deploymentId ?? entry.buildId ?? "Unknown historical provenance"}</b></div>
                <div><span>Round time / interval</span><b>{dateTime(entry.startMs)} · {entry.intervalMinutes} minutes</b></div><div><span>Frozen side / outcome</span><b>{entry.side ?? "No side"} · verified outcome {entry.verifiedOutcome ?? "not verified"}</b></div>
                <div><span>Lock elapsed</span><b>{elapsed}</b></div><div><span>Lock time</span><b>{dateTime(entry.decisionAtMs)}</b></div>
                <div><span>Entry estimate or actual fill</span><b>{estimate}{entry.entryEconomics?.reason ? ` · ${entry.entryEconomics.reason}` : ""}</b></div>
                <div><span>Expected net</span><b>{entry.entryEconomics?.expectedNetUsd == null ? "Not available · no calibrated probability reported" : currency(entry.entryEconomics.expectedNetUsd)}</b></div>
                <div><span>Prediction result</span><b className={`timed-history-status ${scoreClass(result)}`}>{result.replaceAll("_", " ")}</b></div>
                <div><span>Scoring vs delivery</span><b>{entry.status === "ABSTAINED_NO_QUALIFIED_SIGNAL" ? "Intentional abstention · excluded from accuracy" : entry.status === "DATA_FAILURE" ? "Data failure · not an incorrect prediction" : entry.result === "CORRECT" && entry.onTime === false ? "Correct prediction · late operational delivery" : entry.onTime === false ? "Late operational delivery · prediction correctness remains separate" : "Separate dimensions"}</b></div>
                <div><span>Execution / realized P&amp;L</span><b>Not inferred from a lock; actual fills only when reported</b></div>
                <div><span>Commit acknowledgement</span><b>{dateTime(entry.committedAtMs)}</b></div>
                <div><span>Evidence / source observation</span><b>{entry.observationId ?? "Not reported"} · {dateTime(entry.receivedAtMs)}</b></div>
                <div><span>Coverage</span><b>{entry.coverage.n} observations · first {dateTime(entry.coverage.firstAtMs)} · last {dateTime(entry.coverage.lastAtMs)} · max gap {duration(entry.coverage.maxGapMs)}</b></div>
                <div><span>Lock reason / blocker</span><b>{entry.lockReason.replaceAll("_", " ")} · {entry.earlyBlocker.replaceAll("_", " ")}</b></div>
              {entry.operationalReasons && <div><span>Operational reasons · overlapping</span><b>{entry.operationalReasons.length ? entry.operationalReasons.map(reason => reason.replaceAll("_", " ")).join(" · ") : "None reported"}</b></div>}
                <div><span>Automatic execution</span><b>Disabled · no live order submission from this record</b></div>
              </div>
              <details className="timed-history-evidence"><summary>Frozen evidence and settlement detail</summary><pre>{JSON.stringify({ evidence: entry.evidence, verifiedOutcome: entry.verifiedOutcome, economics: entry.entryEconomics }, null, 2)}</pre></details>
            </details>
          </article>;
        })}
      </div>}
  </div>;
}

function GateJournalSection({ interval, reloadKey, onRetry }: { interval: Interval; reloadKey: number; onRetry: () => void }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: GateResponse }>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    const intervals = interval === "all" ? [5, 15] as const : [interval] as const;
    Promise.all(intervals.map(async value => {
      const response = await fetch(`/api/waterx/gates?interval=${value}`, { credentials: "include", signal: controller.signal, headers: { Accept: "application/json" } });
      const body = await response.json().catch(() => ({})) as Partial<GateResponse> & { error?: string };
      if (!response.ok || typeof body.strategyVersion !== "string" || !Array.isArray(body.entries)) throw new Error(body.error || `Gate journal unavailable (${response.status}).`);
      const journal = body as GateResponse;
      return { ...journal, entries: journal.entries.map(entry => ({ ...entry, intervalMinutes: entry.intervalMinutes ?? value as 5 | 15 })) };
    })).then(responses => {
      if (!controller.signal.aborted) setState({ kind: "ready", data: {
        strategyVersion: responses.map(response => response.strategyVersion).join(" · "),
        entries: responses.flatMap(response => response.entries).filter(entry => interval === "all" || entry.intervalMinutes == null || entry.intervalMinutes === interval).sort((a, b) => b.scheduledAtMs - a.scheduledAtMs),
        metrics: responses.length === 1 ? responses[0].metrics : undefined,
      } });
    }).catch(error => { if (!controller.signal.aborted) setState({ kind: "error", message: error instanceof Error ? error.message : "Gate journal could not be loaded." }); });
    return () => controller.abort();
  }, [interval, reloadKey]);
  return <section className="gate-journal" aria-label="Sequential qualification gate journal">
    <div className="gate-journal-heading"><div><span>PROSPECTIVE CHECKS · NOT INDEPENDENT PREDICTIONS</span><h3>Qualification gate journal</h3></div><small>{state.kind === "ready" ? state.data.strategyVersion : "waterx-qualification-gates-v3"}</small></div>
    <p>Each gate is an observation opportunity within one round. Repeated checks are correlated and are not counted as separate winning rounds.</p>
    {state.kind === "loading" && <div className="timed-history-loading" role="status"><i aria-hidden="true" /><span>Loading gate journal…</span></div>}
    {state.kind === "error" && <div className="timed-history-error" role="alert"><b>Gate journal unavailable</b><span>{state.message}</span><button type="button" onClick={onRetry}>Retry</button></div>}
    {state.kind === "ready" && (state.data.entries.length === 0 ? <div className="timed-history-empty">No gate journal entries returned for this interval.</div>
      : <div className="gate-journal-rows">{state.data.entries.slice(0, 100).map((gate, index) => <details className="gate-journal-row" key={`${gate.roundId ?? "round"}-${gate.gateIndex}-${gate.scheduledAtMs}-${index}`}>
        <summary><span>G{gate.gateIndex}</span><b>{gate.result.replaceAll("_", " ")}</b><time>{dateTime(gate.scheduledAtMs)}</time></summary>
        <div className="gate-journal-facts"><div><span>Round</span><b>{gate.roundId ?? "Not returned"}</b></div><div><span>Elapsed gate</span><b>{gate.startMs == null ? "Not returned" : duration(gate.scheduledAtMs - gate.startMs)}</b></div>
          <div><span>Evaluated / evidence cutoff</span><b>{dateTime(gate.evaluatedAtMs)} / {dateTime(gate.evidenceCutoffMs)}</b></div><div><span>Reason</span><b>{gate.reason.replaceAll("_", " ")}</b></div>
          <div><span>Requirements met</span><b>{gate.requirementsMet} / {gate.requirementsTotal}</b></div><div><span>Market probability UP · uncalibrated</span><b>{gate.probabilityUp == null ? "Not reported" : `${(gate.probabilityUp * 100).toFixed(1)}%`}</b></div>
          <div><span>Policy / source</span><b>{gate.policyVersion} · {gate.source}</b></div><div><span>Observation IDs</span><b>{gate.observationIds.length ? gate.observationIds.join(", ") : "None returned"}</b></div><div><span>Calibration</span><b>{gate.calibrationStatus}</b></div>
          {gate.decisionId && <div><span>Decision ID</span><b>{gate.decisionId}</b></div>}</div>
        <details className="timed-history-evidence"><summary>Qualification components</summary><pre>{JSON.stringify(gate.components, null, 2)}</pre></details>
      </details>)}</div>)}
  </section>;
}

export default function TimedDecisionHistory() {
  const [gateAuditOpen,setGateAuditOpen]=useState(false);
  const [interval, setInterval] = useState<Interval>(5);
  const [strategy, setStrategy] = useState<Strategy>("waterx-qualification-gates-v3");
  const [window, setWindow] = useState<CohortWindow>("today");
  const [deployment, setDeployment] = useState<Deployment>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [limit, setLimit] = useState(100);
  const [resultFilter, setResultFilter] = useState<"all" | ResultStatus>("all");
  const [reloadKey, setReloadKey] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  const customRange = useMemo(() => {
    if (!customFrom || !customTo) return null;
    const from = new Date(`${customFrom}T00:00:00`).getTime();
    const endDate = new Date(`${customTo}T00:00:00`);
    endDate.setDate(endDate.getDate() + 1);
    const to = endDate.getTime();
    return Number.isFinite(from) && Number.isFinite(to) && from < to ? { fromMs: from, toMs: to } : null;
  }, [customFrom, customTo]);

  useEffect(() => {
    if (window === "custom" && !customRange) { setLoad({ kind: "error", message: "Choose a valid custom start and end date; the end date is inclusive." }); return; }
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    const params = new URLSearchParams({ interval: String(interval), strategy, window, deployment, limit: String(limit), timezoneOffsetMinutes: String(new Date().getTimezoneOffset()) });
    if (window === "custom" && customRange) { params.set("fromMs", String(customRange.fromMs)); params.set("toMs", String(customRange.toMs)); }
    fetch(`/api/waterx/timed-history?${params}`, { credentials: "include", signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async response => {
        const body = await response.json().catch(() => ({})) as Partial<TimedHistoryResponse> & { error?: string };
        if (!response.ok || typeof body.strategyVersion !== "string" || !Array.isArray(body.entries) || !body.metrics) throw new Error(body.error || `Round history unavailable (${response.status}).`);
        if (!controller.signal.aborted) setLoad({ kind: "ready", data: body as TimedHistoryResponse });
      }).catch(error => { if (!controller.signal.aborted) setLoad({ kind: "error", message: error instanceof Error ? error.message : "Round history could not be loaded." }); });
    return () => controller.abort();
  }, [interval, strategy, window, deployment, limit, customRange, reloadKey]);

  const visibleEntries = load.kind === "ready" ? load.data.entries.filter(entry => resultFilter === "all" || scoreLabel(entry) === resultFilter) : [];
  const deployments = load.kind === "ready" ? load.data.provenance?.deploymentOptions ?? [] : [];
  return <section className="timed-history" aria-labelledby="timed-history-title">
    <div className="timed-history-heading"><div><span>FROZEN BTC ROUND PREDICTIONS · NOT TRADES</span><h2 id="timed-history-title">Round history</h2></div>
      <div className="timed-history-tabs" role="group" aria-label="History interval">{(["all", 5, 15] as const).map(value => <button key={value} type="button" aria-pressed={interval === value} className={interval === value ? "selected" : ""} onClick={() => setInterval(value)}>{value === "all" ? "All" : `${value}m`}</button>)}</div>
    </div>
    <div className="timed-history-filters">
      <label>Strategy<select value={strategy} onChange={event => setStrategy(event.target.value)}><option value="all">All strategies</option><option value="waterx-qualification-gates-v3">waterx-qualification-gates-v3 · active</option><option value="waterx-event-lock-v1">waterx-event-lock-v1 · shadow challenger</option><option value="waterx-early-baseline-v2">waterx-early-baseline-v2</option><option value="waterx-timed-baseline-v1">waterx-timed-baseline-v1 · legacy</option></select></label>
      <label>Window<select value={window} onChange={event => setWindow(event.target.value as CohortWindow)}><option value="today">Today · local time</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="custom">Custom dates</option></select></label>
      <label>Deployment<select value={deployment} onChange={event => setDeployment(event.target.value)}><option value="all">All deployments</option><option value="current">Current deployment</option><option value="unknown">Unknown historical provenance</option>{deployments.filter(item => !["all", "current", "unknown"].includes(item.value)).map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label>Rows<select value={limit} onChange={event => setLimit(Number(event.target.value))}>{[50, 100, 200].map(value => <option key={value} value={value}>{value} rows</option>)}</select></label>
      <label>Result<select value={resultFilter} onChange={event => setResultFilter(event.target.value as "all" | ResultStatus)}><option value="all">All results</option>{(["CORRECT", "INCORRECT", "PENDING", "DISPUTED", "ABSTENTION", "DATA_FAILURE", "NO_VALID_INPUT", "MISSED_DEADLINE", "MISSING_RECORD"] as const).map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
      {window === "custom" && <div className="timed-history-custom"><label>From<input type="date" value={customFrom} onChange={event => setCustomFrom(event.target.value)} /></label><label>Through<input type="date" value={customTo} onChange={event => setCustomTo(event.target.value)} /></label></div>}
    </div>
    <p className="timed-history-strategy">{load.kind === "ready" ? load.data.strategyVersion : strategy === "all" ? "All strategy versions" : strategy} · deployment {deployment} · window {window}</p>
    {load.kind === "loading" && <div className="timed-history-loading" role="status"><i aria-hidden="true" /><span>Loading round records…</span></div>}
    {load.kind === "error" && <div className="timed-history-error" role="alert"><b>Round history unavailable</b><span>{load.message}</span><button type="button" onClick={() => setReloadKey(key => key + 1)}>Retry</button></div>}
    {load.kind === "ready" && <TimedDecisionHistoryRecords interval={interval} data={load.data} visibleEntries={visibleEntries} />}
    <details className="timed-history-diagnostics" onToggle={event=>setGateAuditOpen(event.currentTarget.open)}>
      <summary>Full gate journal · overlapping diagnostics</summary>
      {gateAuditOpen&&<GateJournalSection interval={interval} reloadKey={reloadKey} onRetry={() => setReloadKey(key => key + 1)} />}
    </details>
  </section>;
}
