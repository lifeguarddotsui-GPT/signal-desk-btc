import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

type Interval = 5 | 15;
type Entry = {
  id?: string;
  roundId?: string;
  startMs?: number;
  intervalMinutes?: number;
  strategyVersion?: string;
  side?: "UP" | "DOWN" | null;
  status?: string;
  elapsedMs?: number;
  probabilityUp?: number | null;
  probabilityDown?: number | null;
  evidence?: Record<string, unknown>;
  result?: string;
  verifiedOutcome?: string | null;
  operationalFailure?: string | null;
};
type Metrics = {
  n?: number; cohortN?: number; onTimeLocks?: number; missed?: number; missingRecords?: number;
  settledN?: number; correct?: number; incorrect?: number; pending?: number; disputed?: number; hitRate?: number|null;
  abstained?: number; dataFailures?: number; operationalFailures?: number; operationalCoverage?: number | null;
  choiceCoverage?: number | null; sourceUnavailableGates?: number; noQualifiedSignalGates?: number;
  schedulerMissedGates?: number; deadlineMisses?: number;
  operationalBreakdown?: { gates?: { sourceUnavailable?: number; noQualifiedSignal?: number; schedulerMissedGate?: number } };
};
type HistoryPayload = {
  strategyVersion?: string;
  entries?: Entry[];
  metrics?: Metrics;
  qualification?: string;
  error?: string;
};
type Props = { interval: Interval };

const CURRENT_STRATEGY = "waterx-qualification-gates-v3";
const PREVIOUS_STRATEGY = "waterx-early-baseline-v2";
const count = (value: number | undefined) => Number.isFinite(value) ? String(value) : "—";
const pct = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`;
const elapsed = (value: number | undefined) => {
  if (value == null || !Number.isFinite(value)) return "—";
  const seconds = Math.max(0, Math.round(value / 1000));
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};
const roundTime = (value?: number) => value == null || !Number.isFinite(value)
  ? "Round time unavailable" : new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
const marketProbability = (entry: Entry) => {
  const up = entry.probabilityUp;
  const down = entry.probabilityDown ?? (up == null ? null : 1 - up);
  if (up == null || down == null || !Number.isFinite(up) || !Number.isFinite(down)) return "Unavailable";
  const evidence = entry.evidence;
  const semantics = evidence?.probabilitySemantics;
  const source = typeof semantics === "string" && semantics.toLowerCase().includes("market")
    ? "WaterX market baseline" : "frozen source not specified";
  return `UP ${(up * 100).toFixed(1)}% · DOWN ${(down * 100).toFixed(1)}% · ${source}`;
};
const resultClass = (result?: string) => (result ?? "pending").toLowerCase().replaceAll("_", "-");

async function loadHistory(interval: Interval, strategy: string, signal: AbortSignal): Promise<HistoryPayload> {
  const query = new URLSearchParams({ interval: String(interval), strategy });
  const response = await fetch(`/api/waterx/timed-history?${query.toString()}`, { signal });
  const data = await response.json().catch(() => ({})) as HistoryPayload;
  if (!response.ok) throw new Error(data.error || `History unavailable (${response.status})`);
  return data;
}

export default function TimedStrategyHistory({ interval }: Props) {
  const [current, setCurrent] = useState<HistoryPayload | null>(null);
  const [older, setOlder] = useState<HistoryPayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError("");
    Promise.allSettled([
      loadHistory(interval, CURRENT_STRATEGY, controller.signal),
      loadHistory(interval, PREVIOUS_STRATEGY, controller.signal),
    ]).then(([primary, benchmark]) => {
      if (!active) return;
      if (primary.status === "fulfilled") setCurrent(primary.value);
      else setCurrent(null);
      if (benchmark.status === "fulfilled") setOlder(benchmark.value);
      else setOlder(null);
      const failures = [
        primary.status === "rejected" ? `Current strategy: ${primary.reason instanceof Error ? primary.reason.message : "unavailable"}` : "",
        benchmark.status === "rejected" ? `Earlier benchmark: ${benchmark.reason instanceof Error ? benchmark.reason.message : "unavailable"}` : "",
      ].filter(Boolean);
      setError(failures.join(" · "));
      setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [interval, retry]);

  return <TimedStrategyHistoryView interval={interval} current={current} older={older}
    loading={loading} error={error} onRetry={()=>setRetry(value=>value+1)} />;
}

export function TimedStrategyHistoryView({interval,current,older,loading=false,error="",onRetry}:{
  interval:Interval;current:HistoryPayload|null;older:HistoryPayload|null;
  loading?:boolean;error?:string;onRetry?:()=>void;
}){
  const entries = (current?.entries ?? []).filter(entry => entry.strategyVersion === CURRENT_STRATEGY);
  const oldEntries = (older?.entries ?? []).filter(entry => entry.strategyVersion !== CURRENT_STRATEGY);
  const metrics = current?.metrics;

  return <section className="timed-history-panel" aria-labelledby="timed-history-title" aria-busy={loading}>
    <header className="timed-research-heading">
      <div><span className="research-eyebrow">PROSPECTIVE LOCK RECORD</span><h2 id="timed-history-title">Timed strategy history</h2>
        <p>Exact {interval}m rounds · {CURRENT_STRATEGY}. Results update only from verified, undisputed settlements.</p></div>
      <button type="button" className="research-retry" onClick={onRetry} aria-label="Refresh timed strategy history"><RefreshCw size={14} /> Refresh</button>
    </header>
    {loading && !current ? <div className="research-skeleton" aria-label="Loading timed strategy history"><i /><i /><i /></div> :
      error && !current ? <div className="research-error" role="status">{error}<button type="button" onClick={onRetry}>Retry</button></div> :
        <>
          {error && <p className="research-inline-error" role="status">{error}</p>}
          <div className="history-operational-strip" aria-label="Operational coverage and abstentions">
            <div><span>Operational coverage</span><strong>{pct(metrics?.operationalCoverage)}</strong></div>
            <div><span>Decision coverage</span><strong>{pct(metrics?.choiceCoverage)}</strong></div>
            <div><span>Abstentions</span><strong>{count(metrics?.abstained)}</strong></div>
            <div><span>Data failures</span><strong>{count(metrics?.dataFailures)}</strong></div>
            <div><span>Missed deadlines / late locks</span><strong>{count(metrics?.deadlineMisses)}</strong></div>
            <div><span>Gate misses</span><strong>{count(metrics?.operationalBreakdown?.gates?.schedulerMissedGate ?? metrics?.schedulerMissedGates)}</strong></div>
          </div>
          <div className="history-scoring-line">
            <span>Verified locks scored</span><strong>{count(metrics?.settledN)}</strong>
            <span>Correct</span><strong>{count(metrics?.correct)}</strong>
            <span>Incorrect</span><strong>{count(metrics?.incorrect)}</strong>
            <span>Pending</span><strong>{count(metrics?.pending)}</strong>
            <span>Disputed</span><strong>{count(metrics?.disputed)}</strong>
            <span>Hit rate · verified correct / incorrect only</span><strong>{pct(metrics?.hitRate)}</strong>
          </div>
          {entries.length ? <div className="history-entry-list">
            {entries.map((entry, index) => <article className="history-entry" key={entry.id ?? `${entry.roundId ?? "round"}-${entry.startMs ?? index}`}>
              <div className="history-entry-main">
                <span className="history-round-time">{roundTime(entry.startMs)}</span>
                <strong className={`history-side${entry.side ? ` side-${entry.side.toLowerCase()}` : ""}`}>{entry.side ?? entry.status?.replaceAll("_", " ") ?? "NO SAVED SIDE"}</strong>
                <span className={`history-result ${resultClass(entry.result)}`}>{entry.result ?? "PENDING"}</span>
              </div>
              <div className="history-entry-meta">
                <span>Elapsed <b>{elapsed(entry.elapsedMs)}</b></span>
                <span>Frozen <b>{marketProbability(entry)}</b></span>
                <span>Model <b>{typeof entry.evidence?.modelVersion === "string" ? entry.evidence.modelVersion : "Market baseline · no trained model"}</b></span>
                <span>Strategy <b>{entry.strategyVersion ?? CURRENT_STRATEGY}</b></span>
              </div>
              {entry.operationalFailure && <small className="history-operational-warning">Operational exception: {entry.operationalFailure.replaceAll("_", " ")}</small>}
            </article>)}
          </div> : <div className="research-empty"><strong>No current-strategy locks are recorded for this interval.</strong><p>Empty history is not evidence of successful or failed predictions.</p></div>}
          <details className="history-old-benchmarks">
            <summary>Earlier strategy benchmark · separate cohort</summary>
            <p>{PREVIOUS_STRATEGY} is shown separately and is not combined with current-strategy results.</p>
            {oldEntries.length ? <div className="history-entry-list">
              {oldEntries.map((entry, index) => <article className="history-entry old" key={entry.id ?? `${entry.roundId ?? "old"}-${entry.startMs ?? index}`}>
                <div className="history-entry-main"><span className="history-round-time">{roundTime(entry.startMs)}</span>
                  <strong className="history-side">{entry.side ?? entry.status?.replaceAll("_", " ") ?? "NO SAVED SIDE"}</strong>
                  <span className={`history-result ${resultClass(entry.result)}`}>{entry.result ?? "PENDING"}</span></div>
                <div className="history-entry-meta"><span>Elapsed <b>{elapsed(entry.elapsedMs)}</b></span><span>Frozen <b>{marketProbability(entry)}</b></span><span>Model <b>{typeof entry.evidence?.modelVersion === "string" ? entry.evidence.modelVersion : "Not reported"}</b></span><span>Strategy <b>{entry.strategyVersion ?? "Earlier policy"}</b></span></div>
              </article>)}
            </div> : <div className="research-empty compact"><strong>No earlier benchmark entries returned.</strong></div>}
          </details>
          <p className="research-footnote">{current?.qualification ?? "Coverage describes discovered strategy rounds, not all WaterX rounds. Prediction correctness is not trading profitability or authority."}</p>
        </>}
  </section>;
}
