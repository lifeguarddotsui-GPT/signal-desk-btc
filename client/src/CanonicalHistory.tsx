import React, { useEffect, useState } from "react";
import "./beta-interface.css";
import TimedDecisionHistory from "./TimedDecisionHistory";
import TimedStrategyHistory from "./TimedStrategyHistory";
import TwoStageHistory from "./TwoStageHistory";

type IntervalFilter = "all" | "5" | "15";
type WindowFilter = "lifetime" | "100" | "50" | "20" | "24h" | "7d";
type SourceFilter = "baseline" | "bluewater";
type CanonicalRow = {
  intervalMinutes: number;
  roundId: string;
  startMs: number;
  expiryMs: number;
  side: string | null;
  probability: number | null;
  source: string;
  modelVersion: string | null;
  lockAtMs: number | null;
  secondsBeforeExpiry: number | null;
  outcome: string | null;
  verificationState: string;
  result: "CORRECT" | "INCORRECT" | "PENDING" | "WITHDRAWN-DISPUTED" | "NO CHOICE";
  noChoiceReason: string | null;
  artifactDigest: string | null;
  evidence: object | null;
  orderStatus: "NOT_AVAILABLE";
  collateralSpent: null;
  receipt: null;
  realizedPnl: null;
};
type CanonicalResponse = {
  status: "ok";
  asOfMs: number;
  source: SourceFilter;
  cohort: {interval:"all"|"5"|"15";window:"lifetime"|"100"|"50"|"20"|"24h"|"7d";source:"baseline"|"bluewater"};
  summary: {
    correct: number;
    incorrect: number;
    pending: number;
    withdrawn: number;
    noChoice: number;
    scored: number;
    hitRate: number | null;
    ratio: string;
    coverage: number | null;
    total: number;
  };
  rows: CanonicalRow[];
  rowsTruncated: boolean;
  totalRows: number;
};
type CanonicalUnavailable = { status: "unavailable" | "error" | "UNAVAILABLE"; reason?: string };
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; data: CanonicalResponse };

const intervalOptions: { value: IntervalFilter; label: string }[] = [
  { value: "all", label: "All intervals" },
  { value: "5", label: "5 min" },
  { value: "15", label: "15 min" },
];
const windowOptions: { value: WindowFilter; label: string }[] = [
  { value: "lifetime", label: "Lifetime" },
  { value: "100", label: "Last 100" },
  { value: "50", label: "Last 50" },
  { value: "20", label: "Last 20" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
];
const dateTime = (value: number | null) =>
  value == null || !Number.isFinite(value)
    ? "Not recorded"
    : new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const metric = (value: number | null, digits = 1) =>
  value == null || !Number.isFinite(value) ? "Not reported" : `${(value * 100).toFixed(digits)}%`;
const readable = (value: string | null | undefined) => value?.trim() || "Not recorded";
const shortRound = (id: string) => id.length > 34 ? `${id.slice(0, 18)}…${id.slice(-10)}` : id;

export function LegacyCanonicalHistory() {
  const [interval, setInterval] = useState<IntervalFilter>("all");
  const [windowFilter, setWindowFilter] = useState<WindowFilter>("lifetime");
  const [source, setSource] = useState<SourceFilter>("baseline");
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ interval, window: windowFilter, source });
    setLoad({ kind: "loading" });
    fetch(`/api/waterx/canonical-history?${params.toString()}`, {
      credentials: "include",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    }).then(async response => {
      const body = await response.json().catch(() => ({})) as CanonicalResponse | CanonicalUnavailable;
      if (!response.ok || body.status !== "ok") {
        const unavailableReason = "reason" in body ? body.reason : undefined;
        const reason = typeof unavailableReason === "string" && unavailableReason.trim()
          ? unavailableReason
          : `Canonical history is unavailable (request returned ${response.status}).`;
        setLoad({ kind: "unavailable", message: reason });
        return;
      }
      setLoad({ kind: "ready", data: body as CanonicalResponse });
    }).catch(error => {
      if (!controller.signal.aborted) {
        setLoad({ kind: "error", message: error instanceof Error ? error.message : "History could not be loaded." });
      }
    });
    return () => controller.abort();
  }, [interval, windowFilter, source, reloadKey]);

  const summary = load.kind === "ready" ? load.data.summary : null;
  const baseline = source === "baseline";
  const sourceName = baseline ? "WaterX market baseline" : "Bluewater champion";

  return <main className="canonical-history">
    <header className="history-heading">
      <div>
        <div className="history-eyebrow">BLUEWATERAI / CANONICAL RECORD</div>
        <h1>Research history</h1>
        <p>Frozen round choices are scored only against verified WaterX outcomes. Prediction correctness is separate from wallet orders and returns.</p>
      </div>
      {load.kind === "ready" && <span className="history-cohort">
        COHORT · {load.data.cohort.interval === "all" ? "ALL" : `${load.data.cohort.interval} MIN`} · {load.data.cohort.window === "lifetime" ? "Lifetime" : ["100","50","20"].includes(load.data.cohort.window) ? `Last ${load.data.cohort.window}` : load.data.cohort.window} <br />
        AS OF · {dateTime(load.data.asOfMs)}
      </span>}
    </header>

    <section className="history-controls" aria-label="History filters">
      <div className="history-filter">
        <label htmlFor="history-interval">Interval</label>
        <select id="history-interval" value={interval} onChange={event => setInterval(event.target.value as IntervalFilter)}>
          {intervalOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <div className="history-filter">
        <label htmlFor="history-window">Cohort window</label>
        <select id="history-window" value={windowFilter} onChange={event => setWindowFilter(event.target.value as WindowFilter)}>
          {windowOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <div className="history-filter source-filter">
        <label htmlFor="history-source">Evidence source</label>
        <select id="history-source" value={source} onChange={event => setSource(event.target.value as SourceFilter)}>
          <option value="bluewater">Bluewater champion</option>
          <option value="baseline">WaterX market baseline</option>
        </select>
      </div>
    </section>

    <TimedStrategyHistory interval={interval === "15" ? 15 : 5} />
    {interval === "all" && <TimedStrategyHistory interval={15} />}
    <details className="history-old-benchmarks">
      <summary>Full gate audit and historical strategy filters</summary>
      <TimedDecisionHistory />
    </details>

    <p className="history-source-note">
      {baseline
        ? "Frozen WaterX market-baseline choices at the primary checkpoint, shown separately from Bluewater. These are market observations, not Bluewater predictions."
        : "Frozen Bluewater CHAMPION choice at the primary checkpoint only. Unqualified shadow predictions never fill a missing choice; absent champion rows remain NO CHOICE coverage failures."}
    </p>

    {load.kind === "loading" && <div className="history-skeleton" role="status" aria-label="Loading canonical history" />}
    {load.kind === "error" && <div className="history-message" role="alert">
      <strong>History request failed</strong>{load.message}
      <button className="history-retry" type="button" onClick={() => setReloadKey(key => key + 1)}>Retry</button>
    </div>}
    {load.kind === "unavailable" && <div className="history-message" role="status">
      <strong>No verified statistics available</strong>{load.message}
      <p>The selected cohort is unavailable. No sample rows or performance figures are substituted.</p>
      <button className="history-retry" type="button" onClick={() => setReloadKey(key => key + 1)}>Check again</button>
    </div>}

    {summary && load.kind === "ready" && <>
      <section className="history-stats" aria-label="Selected cohort statistics">
        <div className="history-stat"><span className="history-label">Correct</span><b>{summary.correct}</b></div>
        <div className="history-stat"><span className="history-label">Incorrect</span><b>{summary.incorrect}</b></div>
        <div className="history-stat"><span className="history-label">Pending</span><b>{summary.pending}</b></div>
        <div className="history-stat"><span className="history-label">Withdrawn / disputed</span><b>{summary.withdrawn}</b></div>
        <div className="history-stat"><span className="history-label">No choice</span><b>{summary.noChoice}</b></div>
        <div className="history-stat"><span className="history-label">Verified scored</span><b>{summary.scored}</b></div>
        <div className="history-stat"><span className="history-label">Correct : incorrect</span><b>{summary.ratio || "Not reported"}</b></div>
        <div className="history-stat"><span className="history-label">Hit rate</span><b>{metric(summary.hitRate)}</b><small>Correct ÷ (correct + incorrect)</small></div>
        <div className="history-stat"><span className="history-label">Choice coverage</span><b>{metric(summary.coverage)}</b><small>{summary.total} cohort rounds</small></div>
      </section>

      <div className="history-section-title">
        <h2>Round records</h2>
        <span>{load.data.rows.length} SHOWN · {load.data.totalRows} TOTAL</span>
      </div>

      {load.data.rows.length
        ? <section className="history-rows" aria-label="Canonical round records">
          {load.data.rows.map((row, index) => {
            const resultClass = row.result.toLowerCase().replaceAll(" ", "-");
            const missingChoice = row.result === "NO CHOICE" || row.side == null;
            const frozenChoice = missingChoice ? (baseline ? "No baseline choice recorded" : "No champion choice recorded") : readable(row.side);
            const lockLead = row.secondsBeforeExpiry == null ? "Not recorded" : `${row.secondsBeforeExpiry.toFixed(1)}s`;
            return <article className="history-row" key={`${row.intervalMinutes}-${row.roundId}-${index}`}>
              <details className="history-row-details">
                <summary className="history-row-summary">
                  <span className="history-interval">{row.intervalMinutes}m</span>
                  <span className="history-round-time"><b>{new Date(row.startMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</b><small>{new Date(row.startMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</small></span>
                  <span className="history-frozen"><b>{frozenChoice}</b><small>{missingChoice ? "Frozen choice" : `${metric(row.probability)} probability`}</small></span>
                  <span className={`history-result ${resultClass}`}>{row.result}</span>
                  <span className="history-lead"><b>{lockLead}</b><small>lock lead</small></span>
                  <span className="history-expand-label">Details</span>
                </summary>
                <div className="history-detail-body">
                  <div className="history-row-top">
                    <div className="history-round">
                      <strong>BTC · {row.intervalMinutes} MIN · ROUND</strong>
                      <span title={row.roundId}>{shortRound(row.roundId)}</span>
                    </div>
                    <span className="history-result-source">{sourceName}</span>
                  </div>
                  <div className="history-facts">
                    <div className="history-fact"><span className="history-label">Round start</span><b>{dateTime(row.startMs)}</b></div>
                    <div className="history-fact"><span className="history-label">Round expiry</span><b>{dateTime(row.expiryMs)}</b></div>
                    <div className="history-fact"><span className="history-label">Frozen choice</span><b>{missingChoice ? (baseline ? "No baseline choice recorded" : "No champion choice recorded") : readable(row.side)}</b></div>
                    <div className="history-fact"><span className="history-label">Frozen probability</span><b>{metric(row.probability)}</b></div>
                    <div className="history-fact"><span className="history-label">Source / model</span><b>{missingChoice ? (baseline ? "No baseline choice recorded" : "No champion choice recorded") : `${row.source}${row.modelVersion ? ` · ${row.modelVersion}` : ""}`}</b></div>
                    <div className="history-fact"><span className="history-label">Lock timestamp</span><b>{dateTime(row.lockAtMs)}</b></div>
                    <div className="history-fact"><span className="history-label">Lock before expiry</span><b>{row.secondsBeforeExpiry == null ? "Not recorded" : `${row.secondsBeforeExpiry.toFixed(1)} seconds`}</b></div>
                    <div className="history-fact"><span className="history-label">Verified outcome</span><b>{readable(row.outcome)}</b></div>
                    <div className="history-fact"><span className="history-label">Verification</span><b>{row.verificationState}</b></div>
                    <div className="history-fact"><span className="history-label">Artifact digest</span><b>{readable(row.artifactDigest)}</b></div>
                    {row.noChoiceReason && <div className="history-fact"><span className="history-label">No-choice reason</span><b>{row.noChoiceReason}</b></div>}
                  </div>
                  <div className="history-trade">Order {row.orderStatus.replaceAll("_", " ")} · No verified order, collateral, receipt, or realized P/L is available for this history record.</div>
                  <details className="history-evidence"><summary>Recorded evidence</summary>
                    {row.evidence ? <pre>{JSON.stringify(row.evidence, null, 2)}</pre> : <p>No evidence object was returned for this row.</p>}
                  </details>
                </div>
              </details>
            </article>;
          })}
        </section>
        : <div className="history-message">
          <strong>No canonical rows in this selected window</strong>
          The service returned no records for this cohort. No missing choices or historical trades are inferred.
        </div>}
      {load.data.rowsTruncated && <p className="history-footnote">
        Showing the service’s bounded {load.data.rows.length}-row page. Cohort statistics above cover all {load.data.totalRows} selected records.
      </p>}
      <p className="history-footnote">
        Withdrawn or disputed outcomes are excluded from active accuracy scoring. Order, collateral, receipt, and realized P/L fields are unavailable in this projection; no trade results are implied.
      </p>
    </>}
  </main>;
}

export default function CanonicalHistory(){
  const [archiveOpen,setArchiveOpen]=useState(false);
  const [priorArchiveOpen,setPriorArchiveOpen]=useState(false);
  return <main className="canonical-history">
    <header className="history-heading"><div>
      <div className="history-eyebrow">BLUEWATERAI / IMMUTABLE RESEARCH RECORD</div>
      <h1>Round history</h1>
      <p>Compare frozen choices with verified outcomes. Entry estimates are not fills or trading profit.</p>
    </div></header>
    <TwoStageHistory/>
    <details className="history-old-benchmarks" onToggle={event=>setPriorArchiveOpen(event.currentTarget.open)}>
      <summary>Prior-strategy archive · qualification benchmark and earlier strategies</summary>
      {priorArchiveOpen&&<TimedDecisionHistory/>}
    </details>
    <details className="history-old-benchmarks" onToggle={event=>setArchiveOpen(event.currentTarget.open)}>
      <summary>Legacy checkpoint archive · separate cohorts</summary>
      {archiveOpen&&<LegacyCanonicalHistory/>}
    </details>
  </main>;
}