import React, { useEffect, useState } from "react";
import type { TimedDecision } from "../../shared/timed-decision";

type Interval = "all" | 5 | 15;
type Strategy = "all" | "waterx-early-baseline-v2" | "waterx-timed-baseline-v1";
type CohortWindow = "lifetime" | "24h" | "7d" | "20" | "50" | "100";
type ResultStatus = "CORRECT" | "INCORRECT" | "PENDING" | "DISPUTED" | "NO_VALID_INPUT" | "MISSED_DEADLINE";
type HistoryEntry = TimedDecision & { result?: ResultStatus; verifiedOutcome?: "UP" | "DOWN" | null };
type HistoryMetrics = {
  n: number; onTimeLocks: number; deadlineLocks: number; missed: number; noValidInput: number; settledN: number;
  correct?: number; incorrect?: number; pending?: number; disputed?: number; hitRate?: number | null;
  ratio?: number | string | null; choiceCoverage?: number | null; onTimeCoverage?: number | null; medianElapsedMs?: number | null;
};
export type TimedHistoryResponse = {
  strategyVersion: string;
  entries: HistoryEntry[];
  metrics: HistoryMetrics;
};
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
  (entry.status === "NO_VALID_INPUT" ? "NO_VALID_INPUT" : entry.status === "MISSED_DEADLINE" ? "MISSED_DEADLINE" : "PENDING");
const scoreClass = (status: ResultStatus) => status.toLowerCase().replaceAll("_", "-");

export function TimedDecisionHistoryRecords({ interval, data, visibleEntries }: { interval: Interval; data: TimedHistoryResponse; visibleEntries?: HistoryEntry[] }) {
  const rows = visibleEntries ?? data.entries;
  const metrics = data.metrics;
  const scoredCount = typeof metrics.correct === "number" && typeof metrics.incorrect === "number"
    ? metrics.correct + metrics.incorrect : metrics.settledN;
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
      <div><span>Missed deadlines</span><b>{metrics.missed}</b></div>
      <div><span>No valid input</span><b>{metrics.noValidInput}</b></div>
      <div><span>Legacy settled count</span><b>{metrics.settledN}</b></div>
    </div>
    <p className="timed-history-note">Scoring metrics cover the full selected cohort; row limit only controls visible records. Correctness is not trading P/L. A late correct prediction remains an operational miss.</p>
    {!("correct" in metrics) && <p className="timed-history-api-note">The history API has not returned outcome-scoring metrics yet.</p>}
    {rows.length === 0 ? <div className="timed-history-empty">No early-strategy records returned for these filters.</div>
      : <div className="timed-history-rows" aria-label="Early strategy records">
        {rows.map(entry => {
          const displaySideProbability = entry.side === "UP" ? entry.probabilityUp
            : entry.side === "DOWN" ? entry.probabilityDown : null;
          const result = scoreLabel(entry);
          const title = entry.status === "LOCKED" ? `${entry.side} locked`
            : entry.status === "NO_VALID_INPUT" ? "No valid input" : "Missed deadline";
          return <article className="timed-history-row" key={entry.id} data-decision-id={entry.id}>
            <details>
              <summary>
                <span className="timed-history-interval">{entry.intervalMinutes}m</span>
                <span className="timed-history-choice"><b>{title}</b><small>{entry.status === "LOCKED" ? `Frozen ${percent(displaySideProbability)}` : entry.earlyBlocker.replaceAll("_", " ")}</small></span>
                <span className="timed-history-time"><b>{dateTime(entry.startMs)}</b><small>{duration(entry.elapsedMs)} elapsed</small></span>
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
                <div><span>Target / hard deadline</span><b>{dateTime(entry.targetAtMs)} / {dateTime(entry.hardDeadlineAtMs)}</b></div>
                <div><span>Commit acknowledgement</span><b>{dateTime(entry.committedAtMs)}</b></div>
                <div><span>On-time</span><b>{entry.onTime === null ? "Not reported" : entry.onTime ? "Yes" : "No"}</b></div>
                <div><span>Verified outcome</span><b>{entry.verifiedOutcome ?? "Not verified"}</b></div>
                <div><span>Prediction result</span><b className={`timed-history-status ${scoreClass(result)}`}>{result.replaceAll("_", " ")}</b></div>
                <div><span>Scoring vs delivery</span><b>{result === "CORRECT" && entry.onTime === false ? "Correct prediction · late operational miss" : entry.onTime === false ? "Operationally late" : "Separate dimensions"}</b></div>
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

export default function TimedDecisionHistory() {
  const [interval, setInterval] = useState<Interval>(5);
  const [strategy, setStrategy] = useState<Strategy>("all");
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
      <div><span>EARLY OUTCOME SCORECARD · ORIGINAL DECISION IMMUTABLE</span><h2 id="timed-history-title">Early decision records</h2></div>
      <div className="timed-history-tabs" role="group" aria-label="History interval">
        {(["all", 5, 15] as const).map(value => <button key={value} type="button" aria-pressed={interval === value} className={interval === value ? "selected" : ""} onClick={() => setInterval(value)}>{value === "all" ? "All" : `${value}m`}</button>)}
      </div>
    </div>
    <div className="timed-history-filters">
      <label>Strategy<select value={strategy} onChange={event => setStrategy(event.target.value as Strategy)}>
        <option value="all">All strategies</option><option value="waterx-early-baseline-v2">waterx-early-baseline-v2</option><option value="waterx-timed-baseline-v1">waterx-timed-baseline-v1 · legacy</option>
      </select></label>
      <label>Cohort<select value={window} onChange={event => setWindow(event.target.value as CohortWindow)}>
        <option value="lifetime">Lifetime</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="20">Last 20</option><option value="50">Last 50</option><option value="100">Last 100</option>
      </select></label>
      <label>Visible rows<select value={limit} onChange={event => setLimit(Number(event.target.value))}>
        {[20, 50, 100, 200].map(value => <option key={value} value={value}>{value} rows</option>)}
      </select></label>
      <label>Result<select value={resultFilter} onChange={event => setResultFilter(event.target.value as "all" | ResultStatus)}>
        <option value="all">All results</option>{(["CORRECT", "INCORRECT", "PENDING", "DISPUTED", "NO_VALID_INPUT", "MISSED_DEADLINE"] as const).map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
      </select></label>
    </div>
    <p className="timed-history-strategy">{load.kind === "ready" ? load.data.strategyVersion : strategy === "all" ? "All strategy versions" : strategy} · immutable records stay authoritative through live quote outages.</p>
    {load.kind === "loading" && <div className="timed-history-loading" role="status"><i aria-hidden="true" /><span>Loading {interval === "all" ? "all-interval" : `${interval}-minute`} records…</span></div>}
    {load.kind === "error" && <div className="timed-history-error" role="alert"><b>Early decision history unavailable</b><span>{load.message}</span><button type="button" onClick={() => setReloadKey(key => key + 1)}>Retry</button></div>}
    {load.kind === "ready" && <TimedDecisionHistoryRecords interval={interval} data={load.data} visibleEntries={visibleEntries} />}
  </section>;
}
