import React, { useEffect, useState } from "react";
import type { GateJournal, TimedDecision } from "../../shared/timed-decision";

type Interval = "all" | 5 | 15;
type Strategy = "all" | "waterx-qualification-gates-v3" | "waterx-early-baseline-v2" | "waterx-timed-baseline-v1";
type CohortWindow = "lifetime" | "24h" | "7d" | "20" | "50" | "100";
type ResultStatus = "CORRECT" | "INCORRECT" | "PENDING" | "DISPUTED" | "NO_VALID_INPUT" | "MISSED_DEADLINE" | "ABSTENTION" | "DATA_FAILURE";
type HistoryEntry = TimedDecision & { result?: ResultStatus; verifiedOutcome?: "UP" | "DOWN" | null };
type HistoryMetrics = {
  n: number; onTimeLocks: number; deadlineLocks: number; missed: number; noValidInput: number; settledN: number;
  correct?: number; incorrect?: number; pending?: number; disputed?: number; hitRate?: number | null;
  ratio?: number | string | null; choiceCoverage?: number | null; onTimeCoverage?: number | null; medianElapsedMs?: number | null;
  abstentionRate?: number | null; operationalFailureRate?: number | null;
  deadlineMisses?: number; operationalFailures?: number; operationalCoverage?: number | null;
};
export type TimedHistoryResponse = {
  strategyVersion: string;
  entries: HistoryEntry[];
  metrics: HistoryMetrics;
};
type GateEntry = GateJournal & { intervalMinutes?: 5 | 15; roundId?: string; startMs?: number; expiryMs?: number };
type GateResponse = { strategyVersion: string; entries: GateEntry[]; metrics?: { abstentionRate?: number | null; operationalFailureRate?: number | null } };
type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: TimedHistoryResponse };

const dateTime = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not recorded" : new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not recorded" : `${(value * 100).toFixed(1)}%`;
const duration = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Not recorded" : `${(Math.max(0, value) / 1000).toFixed(1)} sec`;
const shortRound = (id: string) => id.length > 42 ? `${id.slice(0, 22)}…${id.slice(-12)}` : id;
const rate = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "Not reported" : `${(value * 100).toFixed(1)}%`;
const scoreLabel = (entry: HistoryEntry): ResultStatus => entry.result ??
  (entry.status === "NO_VALID_INPUT" ? "NO_VALID_INPUT" : entry.status === "MISSED_DEADLINE" ? "MISSED_DEADLINE"
    : entry.status === "ABSTAINED_NO_QUALIFIED_SIGNAL" ? "ABSTENTION" : entry.status === "DATA_FAILURE" ? "DATA_FAILURE" : "PENDING");
const scoreClass = (status: ResultStatus) => status.toLowerCase().replaceAll("_", "-");

export function TimedDecisionHistoryRecords({ interval, data, visibleEntries }: { interval: Interval; data: TimedHistoryResponse; visibleEntries?: HistoryEntry[] }) {
  const rows = visibleEntries ?? data.entries;
  const metrics = data.metrics;
  const scoredCount = typeof metrics.correct === "number" && typeof metrics.incorrect === "number"
    ? metrics.correct + metrics.incorrect : metrics.settledN;
  const operationalFailures = metrics.operationalFailures ?? metrics.missed;
  return <div className="timed-history-content">
    <div className="timed-history-metrics" aria-label="Selected cohort scoring metrics">
      <div className="score-correct"><span>Correct</span><b>{metrics.correct ?? "Not reported"}</b></div>
      <div className="score-incorrect"><span>Incorrect</span><b>{metrics.incorrect ?? "Not reported"}</b></div>
      <div><span>Scored sample count</span><b>{scoredCount}</b></div>
      <div><span>Hit rate · scored choices</span><b>{rate(metrics.hitRate)}</b></div>
      <div><span>Correct : incorrect</span><b>{metrics.ratio ?? "Not reported"}</b></div>
      <div><span>Choice coverage</span><b>{rate(metrics.choiceCoverage)}</b></div>
      <div><span>On-time coverage</span><b>{rate(metrics.onTimeCoverage)}</b></div>
      <div><span>Median decision elapsed</span><b>{duration(metrics.medianElapsedMs)}</b></div>
      <div><span>Pending</span><b>{metrics.pending ?? "Not reported"}</b></div>
      <div><span>Disputed</span><b>{metrics.disputed ?? "Not reported"}</b></div>
      <div><span>Recorded decisions</span><b>{metrics.n}</b></div>
      <div><span>On-time locks</span><b>{metrics.onTimeLocks}</b></div>
      <div><span>Deadline locks</span><b>{metrics.deadlineLocks}</b></div>
      <div><span>{metrics.deadlineMisses == null ? "Deadline misses · not reported" : "Missed deadlines / late locks"}</span><b>{metrics.deadlineMisses ?? "Not reported"}</b></div>
      <div><span>No valid input</span><b>{metrics.noValidInput}</b></div>
      <div><span>Abstention rate</span><b>{rate(metrics.abstentionRate)}</b></div>
      <div><span>{metrics.operationalFailures == null ? "Operational failures · legacy missed" : "Operational failures"}</span><b>{operationalFailures}</b></div>
      <div><span>Operational coverage</span><b>{rate(metrics.operationalCoverage)}</b></div>
      <div><span>Operational failure rate</span><b>{rate(metrics.operationalFailureRate)}</b></div>
      <div><span>Legacy settled count</span><b>{metrics.settledN}</b></div>
    </div>
    <p className="timed-history-note">Scoring metrics cover the full selected cohort; row limit only controls visible records. Correctness is not trading P/L. Deadline misses include missed gates or late locks; DATA_FAILURE is an operational failure, not a missed deadline. Older reports expose only “missed,” shown here as operational failures rather than inferred deadline misses.</p>
    {!("correct" in metrics) && <p className="timed-history-api-note">The history API has not returned outcome-scoring metrics yet.</p>}
    {rows.length === 0 ? <div className="timed-history-empty">No early-strategy records returned for these filters.</div>
      : <div className="timed-history-rows" aria-label="Early strategy records">
        {rows.map(entry => {
          const displaySideProbability = entry.side === "UP" ? entry.probabilityUp
            : entry.side === "DOWN" ? entry.probabilityDown : null;
          const result = scoreLabel(entry);
          const title = entry.status === "LOCKED" ? `${entry.side} locked`
            : entry.status === "ABSTAINED_NO_QUALIFIED_SIGNAL" ? "Abstained · no qualified signal"
              : entry.status === "DATA_FAILURE" ? "Data failure"
                : entry.status === "NO_VALID_INPUT" ? "No valid input" : "Missed gate";
          return <article className="timed-history-row" key={entry.id} data-decision-id={entry.id}>
            <details>
              <summary>
                <span className="timed-history-interval">{entry.intervalMinutes}m{entry.gateIndex == null ? "" : ` · G${entry.gateIndex}`}</span>
                <span className="timed-history-choice"><b>{title}</b><small>{entry.status === "LOCKED" ? `Frozen ${percent(displaySideProbability)}` : entry.earlyBlocker.replaceAll("_", " ")}</small></span>
                <span className="timed-history-time"><b>{dateTime(entry.startMs)}</b><small>{duration(entry.elapsedMs)} elapsed{entry.gateScheduledAtMs == null ? "" : ` · gate ${dateTime(entry.gateScheduledAtMs)}`}</small></span>
                <span className={`timed-history-status ${scoreClass(result)}`}>{result.replaceAll("_", " ")}</span>
              </summary>
              <div className="timed-history-facts">
                <div><span>Decision ID</span><b>{entry.id}</b></div>
                <div><span>Strategy version</span><b>{entry.strategyVersion}</b></div>
                <div><span>Round ID</span><b title={entry.roundId}>{shortRound(entry.roundId)}</b></div>
                <div><span>Network</span><b>{entry.network}</b></div>
                <div><span>Frozen side</span><b>{entry.side ?? "None"}</b></div>
                <div><span>Frozen probability UP / side</span><b>{percent(entry.probabilityUp)} / {percent(displaySideProbability)}</b></div>
                <div><span>Decision time / elapsed</span><b>{dateTime(entry.decisionAtMs)} / {duration(entry.elapsedMs)}</b></div>
                <div><span>{entry.gateScheduledAtMs == null ? "Historical target / deadline" : "Gate scheduled / acknowledgement deadline"}</span><b>{dateTime(entry.targetAtMs)} / {dateTime(entry.hardDeadlineAtMs)}</b></div>
                {entry.gateIndex != null && <div><span>Gate</span><b>#{entry.gateIndex} · scheduled {dateTime(entry.gateScheduledAtMs)}</b></div>}
                <div><span>Commit acknowledgement</span><b>{dateTime(entry.committedAtMs)}</b></div>
                <div><span>On-time</span><b>{entry.onTime === null ? "Not reported" : entry.onTime ? "Yes" : "No"}</b></div>
                <div><span>Verified outcome</span><b>{entry.verifiedOutcome ?? "Not verified"}</b></div>
                <div><span>Prediction result</span><b className={`timed-history-status ${scoreClass(result)}`}>{result.replaceAll("_", " ")}</b></div>
                 <div><span>Scoring vs delivery</span><b>{entry.status === "ABSTAINED_NO_QUALIFIED_SIGNAL" ? "Intentional abstention · excluded from prediction scoring"
                   : entry.status === "DATA_FAILURE" ? "Operational failure · not an incorrect prediction"
                     : result === "CORRECT" && entry.onTime === false ? "Correct prediction · late operational miss" : entry.onTime === false ? "Operationally late" : "Separate dimensions"}</b></div>
                <div><span>Execution result</span><b>Not reported · research lock is not trade authority</b></div>
                <div><span>Realized P/L</span><b>Not reported</b></div>
                <div><span>Lock reason</span><b>{entry.lockReason.replaceAll("_", " ")}</b></div>
                <div><span>Early blocker</span><b>{entry.earlyBlocker.replaceAll("_", " ")}</b></div>
                <div><span>Observation provenance</span><b>{entry.observationId ?? "Not reported"} · {dateTime(entry.receivedAtMs)}</b></div>
                <div><span>Coverage</span><b>{entry.coverage.n} observations · first {dateTime(entry.coverage.firstAtMs)} · last {dateTime(entry.coverage.lastAtMs)} · max gap {duration(entry.coverage.maxGapMs)}</b></div>
                <div><span>Ambiguous</span><b>{entry.ambiguous ? "Yes · not eligible for automatic execution" : "No"}</b></div>
                <div><span>Automatic execution</span><b>Disabled · adapter unverified</b></div>
                {entry.operationalFailure && <div><span>Operational failure</span><b>{entry.operationalFailure}</b></div>}
              </div>
              <details className="timed-history-evidence"><summary>Frozen evidence</summary><pre>{JSON.stringify(entry.evidence, null, 2)}</pre></details>
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
      const response = await fetch(`/api/waterx/gates?interval=${value}`, {
        credentials: "include", signal: controller.signal, headers: { Accept: "application/json" },
      });
      const body = await response.json().catch(() => ({})) as Partial<GateResponse> & { error?: string };
      if (!response.ok || typeof body.strategyVersion !== "string" || !Array.isArray(body.entries))
        throw new Error(body.error || `Gate journal unavailable (${response.status}).`);
      const journal = body as GateResponse;
      return { ...journal, entries: journal.entries.map(entry => ({ ...entry, intervalMinutes: entry.intervalMinutes ?? value as 5 | 15 })) };
    })).then(responses => {
      if (!controller.signal.aborted) setState({ kind: "ready", data: {
        strategyVersion: responses.map(response => response.strategyVersion).join(" · "),
        entries: responses.flatMap(response => response.entries)
          .filter(entry => interval === "all" || entry.intervalMinutes == null || entry.intervalMinutes === interval)
          .sort((a, b) => b.scheduledAtMs - a.scheduledAtMs),
        metrics: responses.length === 1 ? responses[0].metrics : undefined,
      } });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ kind: "error", message: error instanceof Error ? error.message : "Gate journal could not be loaded." });
    });
    return () => controller.abort();
  }, [interval, reloadKey]);

  return <section className="gate-journal" aria-label="Sequential qualification gate journal">
    <div className="gate-journal-heading"><div><span>PROSPECTIVE CHECKS · NOT INDEPENDENT PREDICTIONS</span><h3>Qualification gate journal</h3></div>
      <small>{state.kind === "ready" ? state.data.strategyVersion : "waterx-qualification-gates-v3"}</small></div>
    <p>Each gate is an observation opportunity within one round. Repeated checks are correlated and are not counted as separate winning rounds.</p>
    {state.kind === "loading" && <div className="timed-history-loading" role="status"><i aria-hidden="true" /><span>Loading gate journal…</span></div>}
    {state.kind === "error" && <div className="timed-history-error" role="alert"><b>Gate journal unavailable</b><span>{state.message}</span><button type="button" onClick={onRetry}>Retry</button></div>}
    {state.kind === "ready" && (state.data.entries.length === 0
      ? <div className="timed-history-empty">No gate journal entries returned for this interval.</div>
      : <div className="gate-journal-rows">{state.data.entries.slice(0, 100).map((gate, index) => <details className="gate-journal-row" key={`${gate.roundId ?? "round"}-${gate.gateIndex}-${gate.scheduledAtMs}-${index}`}>
        <summary><span>G{gate.gateIndex}</span><b>{gate.result.replaceAll("_", " ")}</b><time>{dateTime(gate.scheduledAtMs)}</time></summary>
        <div className="gate-journal-facts">
          <div><span>Round</span><b>{gate.roundId ?? "Not returned"}</b></div>
          <div><span>Elapsed gate</span><b>{gate.startMs == null ? "Not returned" : duration(gate.scheduledAtMs - gate.startMs)}</b></div>
          <div><span>Evaluated / evidence cutoff</span><b>{dateTime(gate.evaluatedAtMs)} / {dateTime(gate.evidenceCutoffMs)}</b></div>
          <div><span>Reason</span><b>{gate.reason.replaceAll("_", " ")}</b></div>
          <div><span>Requirements met</span><b>{gate.requirementsMet} / {gate.requirementsTotal}</b></div>
          <div><span>Market probability UP · uncalibrated</span><b>{percent(gate.probabilityUp)}</b></div>
          <div><span>Policy / source</span><b>{gate.policyVersion} · {gate.source}</b></div>
          <div><span>Observation IDs</span><b>{gate.observationIds.length ? gate.observationIds.join(", ") : "None returned"}</b></div>
          <div><span>Calibration</span><b>{gate.calibrationStatus}</b></div>
          {gate.decisionId && <div><span>Decision ID</span><b>{gate.decisionId}</b></div>}
        </div>
        <details className="timed-history-evidence"><summary>Qualification components</summary><pre>{JSON.stringify(gate.components, null, 2)}</pre></details>
      </details>)}</div>)}
  </section>;
}

export default function TimedDecisionHistory() {
  const [interval, setInterval] = useState<Interval>(5);
  const [strategy, setStrategy] = useState<Strategy>("waterx-qualification-gates-v3");
  const [window, setWindow] = useState<CohortWindow>("lifetime");
  const [limit, setLimit] = useState(50);
  const [resultFilter, setResultFilter] = useState<"all" | ResultStatus>("all");
  const [reloadKey, setReloadKey] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    const query = new URLSearchParams({ interval: String(interval), strategy, window, limit: String(limit) });
    fetch(`/api/waterx/timed-history?${query}`, {
      credentials: "include", signal: controller.signal, headers: { Accept: "application/json" },
    }).then(async response => {
      const body = await response.json().catch(() => ({})) as Partial<TimedHistoryResponse> & { error?: string };
      if (!response.ok || typeof body.strategyVersion !== "string" || !Array.isArray(body.entries) || !body.metrics) {
        throw new Error(body.error || `Early decision history unavailable (${response.status}).`);
      }
      if (!controller.signal.aborted) setLoad({ kind: "ready", data: body as TimedHistoryResponse });
    }).catch(error => {
      if (!controller.signal.aborted) setLoad({ kind: "error", message: error instanceof Error ? error.message : "Early decision history could not be loaded." });
    });
    return () => controller.abort();
  }, [interval, strategy, window, limit, reloadKey]);

  const visibleEntries = load.kind === "ready"
    ? load.data.entries.filter(entry => resultFilter === "all" || scoreLabel(entry) === resultFilter) : [];

  return <section className="timed-history" aria-labelledby="timed-history-title">
    <div className="timed-history-heading">
      <div><span>ROUND OUTCOME SCORECARD · LOCKS, ABSTENTIONS &amp; GATE JOURNAL</span><h2 id="timed-history-title">Timed strategy records</h2></div>
      <div className="timed-history-tabs" role="group" aria-label="History interval">
        {(["all", 5, 15] as const).map(value => <button key={value} type="button" aria-pressed={interval === value} className={interval === value ? "selected" : ""} onClick={() => setInterval(value)}>{value === "all" ? "All" : `${value}m`}</button>)}
      </div>
    </div>
    <div className="timed-history-filters">
      <label>Strategy<select value={strategy} onChange={event => setStrategy(event.target.value as Strategy)}>
      <option value="all">All strategies</option><option value="waterx-qualification-gates-v3">waterx-qualification-gates-v3</option><option value="waterx-early-baseline-v2">waterx-early-baseline-v2</option><option value="waterx-timed-baseline-v1">waterx-timed-baseline-v1 · legacy</option>
      </select></label>
      <label>Cohort<select value={window} onChange={event => setWindow(event.target.value as CohortWindow)}>
        <option value="lifetime">Lifetime</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="20">Last 20</option><option value="50">Last 50</option><option value="100">Last 100</option>
      </select></label>
      <label>Visible rows<select value={limit} onChange={event => setLimit(Number(event.target.value))}>
        {[20, 50, 100, 200].map(value => <option key={value} value={value}>{value} rows</option>)}
      </select></label>
      <label>Result<select value={resultFilter} onChange={event => setResultFilter(event.target.value as "all" | ResultStatus)}>
        <option value="all">All results</option>{(["CORRECT", "INCORRECT", "PENDING", "DISPUTED", "NO_VALID_INPUT", "MISSED_DEADLINE", "ABSTENTION", "DATA_FAILURE"] as const).map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
      </select></label>
    </div>
    <p className="timed-history-strategy">{load.kind === "ready" ? load.data.strategyVersion : strategy === "all" ? "All strategy versions" : strategy} · immutable records stay authoritative through live quote outages.</p>
    {load.kind === "loading" && <div className="timed-history-loading" role="status"><i aria-hidden="true" /><span>Loading {interval === "all" ? "all-interval" : `${interval}-minute`} records…</span></div>}
    {load.kind === "error" && <div className="timed-history-error" role="alert"><b>Early decision history unavailable</b><span>{load.message}</span><button type="button" onClick={() => setReloadKey(key => key + 1)}>Retry</button></div>}
    {load.kind === "ready" && <TimedDecisionHistoryRecords interval={interval} data={load.data} visibleEntries={visibleEntries} />}
    <GateJournalSection interval={interval} reloadKey={reloadKey} onRetry={() => setReloadKey(key => key + 1)} />
  </section>;
}
