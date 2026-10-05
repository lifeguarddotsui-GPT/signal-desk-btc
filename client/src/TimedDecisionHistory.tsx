import React, { useEffect, useState } from "react";
import type { TimedDecision } from "../../shared/timed-decision";

type Interval = 5 | 15;
export type TimedHistoryResponse = {
  strategyVersion: string;
  entries: TimedDecision[];
  metrics: { n: number; onTimeLocks: number; deadlineLocks: number; missed: number; noValidInput: number; settledN: number };
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

export function TimedDecisionHistoryRecords({ interval, data }: { interval: Interval; data: TimedHistoryResponse }) {
  return <div className="timed-history-content">
    <div className="timed-history-metrics" aria-label={`${interval}-minute early strategy history metrics`}>
      <div><span>Recorded decisions</span><b>{data.metrics.n}</b></div>
      <div><span>On-time locks</span><b>{data.metrics.onTimeLocks}</b></div>
      <div><span>Deadline locks</span><b>{data.metrics.deadlineLocks}</b></div>
      <div><span>Missed deadlines</span><b>{data.metrics.missed}</b></div>
      <div><span>No valid input</span><b>{data.metrics.noValidInput}</b></div>
      <div><span>Settled count reported</span><b>{data.metrics.settledN}</b></div>
    </div>
    <p className="timed-history-note">Early-decision records are shown as frozen research events. No hit rate, training advantage, order, or return is inferred from these counts; the later canonical benchmark below is a separate strategy.</p>
    {data.entries.length === 0 ? <div className="timed-history-empty">No early-strategy records returned for this interval.</div>
      : <div className="timed-history-rows" aria-label={`${interval}-minute early strategy records`}>
        {data.entries.map(entry => {
          const displaySideProbability = entry.side === "UP" ? entry.probabilityUp
            : entry.side === "DOWN" ? entry.probabilityDown : null;
          const title = entry.status === "LOCKED" ? `${entry.side} locked`
            : entry.status === "NO_VALID_INPUT" ? "No valid input" : "Missed deadline";
          return <article className="timed-history-row" key={entry.id} data-decision-id={entry.id}>
            <details>
              <summary>
                <span className="timed-history-interval">{entry.intervalMinutes}m</span>
                <span className="timed-history-choice"><b>{title}</b><small>{entry.status === "LOCKED" ? `Frozen ${percent(displaySideProbability)}` : entry.earlyBlocker.replaceAll("_", " ")}</small></span>
                <span className="timed-history-time"><b>{dateTime(entry.startMs)}</b><small>{duration(entry.elapsedMs)} elapsed</small></span>
                <span className={`timed-history-status ${entry.status.toLowerCase()}`}>{entry.status.replaceAll("_", " ")}</span>
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
  const [reloadKey, setReloadKey] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    fetch(`/api/waterx/timed-history?interval=${interval}&limit=50`, {
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
  }, [interval, reloadKey]);

  return <section className="timed-history" aria-labelledby="timed-history-title">
    <div className="timed-history-heading">
      <div><span>WATERX TIMED BASELINE · EARLY STRATEGY</span><h2 id="timed-history-title">Early decision records</h2></div>
      <div className="timed-history-tabs" role="group" aria-label="Early strategy history interval">
        {([5, 15] as const).map(value => <button key={value} type="button" aria-pressed={interval === value} className={interval === value ? "selected" : ""} onClick={() => setInterval(value)}>{value}m</button>)}
      </div>
    </div>
    <p className="timed-history-strategy">{load.kind === "ready" ? load.data.strategyVersion : "waterx-timed-baseline-v1"} · absolute round-start target and hard deadlines. Saved records remain authoritative through live quote outages.</p>
    {load.kind === "loading" && <div className="timed-history-loading" role="status">Loading {interval}-minute early records…</div>}
    {load.kind === "error" && <div className="timed-history-error" role="alert"><b>Early decision history unavailable</b><span>{load.message}</span><button type="button" onClick={() => setReloadKey(key => key + 1)}>Retry</button></div>}
    {load.kind === "ready" && <TimedDecisionHistoryRecords interval={interval} data={load.data} />}
  </section>;
}
