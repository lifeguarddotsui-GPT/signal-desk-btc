import * as React from "react";
import type { BluewaterForecast, BluewaterReport } from "../../shared/bluewater-research";
import { captureRateLabel } from "../../shared/bluewater-display";

type Interval = 5 | 15;
type RoundIdentity = { id: string; startMs: number; expiryMs: number } | null;
type Props = {
  report: BluewaterReport | null;
  interval: Interval;
  round?: RoundIdentity;
  loading: boolean;
  error: string;
  retry: () => void;
  compact?: boolean;
};

const count = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "Not reported" : value.toLocaleString();
const percent = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "Not reported" : `${(value * 100).toFixed(1)}%`;
const score = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "Not scored" : value.toFixed(4);
const time = (value: string | null | undefined) => {
  if (!value) return "Not reported";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Timestamp unavailable";
};
const safeValue = (value: unknown) => {
  if (value == null) return "Not reported";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return "Not reported"; }
};

function exactChampionForecast(report: BluewaterReport | null, interval: Interval, round: RoundIdentity): BluewaterForecast | null {
  const champion = report?.champion;
  const forecast = report?.currentForecast;
  if (!report || report.intervalMinutes !== interval || report.status !== "QUALIFIED" || report.qualifiedCalibration !== true || !champion || !forecast ||
      forecast.forecastStatus !== "CHAMPION" || forecast.intervalMinutes !== interval ||
      !round || forecast.roundId !== round.id || forecast.startMs !== round.startMs || forecast.expiryMs !== round.expiryMs ||
      forecast.artifactId !== champion.artifactId || forecast.modelFamily !== champion.modelFamily ||
      forecast.modelVersion !== champion.modelVersion) return null;
  return forecast;
}

function StatusCard({ report, interval, round }: { report: BluewaterReport | null; interval: Interval; round: RoundIdentity }) {
  const matchingForecast = exactChampionForecast(report, interval, round);
  const hasChampion = report?.intervalMinutes === interval && report.champion !== null;
  const modelStatus = report?.intervalMinutes !== interval ? "Awaiting interval-matched report"
    : !hasChampion ? "NOT YET QUALIFIED"
      : report?.qualifiedCalibration && report.status === "QUALIFIED" ? "QUALIFIED · FROZEN CHAMPION"
        : report?.status === "SHADOW" ? "SHADOW · RESEARCH ONLY"
          : report?.status === "INSUFFICIENT" ? "INSUFFICIENT EVIDENCE"
            : "COLLECTING EVIDENCE";
  return <section className="bluewater-status panel" aria-label="Bluewater model status">
    <div className="bluewater-status-head">
      <div><span className="eyebrow">BLUEWATER MODEL · {interval} MIN · RESEARCH ONLY</span><h2>Model evidence status</h2></div>
      <span className={`bluewater-state${matchingForecast ? " is-qualified" : ""}`}>{modelStatus}</span>
    </div>
    {hasChampion ? <div className="bluewater-model-identity">
      <span>Champion artifact <b>{report!.champion!.artifactId}</b></span>
      <span>Family / version <b>{report!.champion!.modelFamily} · {report!.champion!.modelVersion}</b></span>
    </div> : <p className="bluewater-hold">No qualified Bluewater probability is available. Shadow forecasts, if present, remain research observations and are not a serving model.</p>}
    {matchingForecast ? <div className="bluewater-probability" aria-label="Frozen Bluewater champion forecast">
      <div><span>FROZEN RAW PROBABILITY · UP</span><strong>{percent(matchingForecast.rawProbabilityUp)}</strong></div>
      <div><span>FROZEN CALIBRATED PROBABILITY · UP</span><strong>{percent(matchingForecast.calibratedProbabilityUp)}</strong></div>
      <small>{matchingForecast.chosenSide} · exact round {matchingForecast.roundId} · {matchingForecast.modelFamily} {matchingForecast.modelVersion} · artifact {matchingForecast.artifactId}</small>
    </div> : report?.intervalMinutes === interval && report.currentForecast?.forecastStatus === "SHADOW" ?
      <p className="bluewater-shadow-note">SHADOW FORECAST · RESEARCH ONLY · not a qualified Bluewater probability.</p>
      : <p className="bluewater-shadow-note">No exact current-round CHAMPION forecast is available; probabilities are withheld.</p>}
    <p className="bluewater-separation">WaterX Market Baseline is a separate market observation, not an independent AI model and never a substitute for Bluewater.</p>
  </section>;
}

function Funnel({ row }: { row: BluewaterReport["funnels"][number] }) {
  const stages: [string, number][] = [
    ["Discovered", row.discovered], ["Valid observations", row.validObservations], ["Watching", row.watching],
    ["Canonical choices", row.canonicalChoices], ["On-time choices", row.onTimeChoices], ["Late choices", row.lateChoices],
    ["Missing choices", row.missingChoices], ["Verified settlements", row.verifiedSettlements],
    ["Scored choices", row.scoredChoices], ["Training eligible", row.trainingEligible],
    ["Withdrawn / disputed", row.withdrawnDisputed], ["Rich-feature choices", row.richFeatureChoices],
    ["Model forecast rounds", row.modelForecastRounds], ["Model forecasts", row.modelForecasts],
  ];
  const rates: [string, number | null][] = [
    ["Canonical capture", row.rates.canonicalCapture], ["On-time capture", row.rates.onTimeCapture],
    ["Settlement completion", row.rates.settlementCompletion], ["Scoring completion", row.rates.scoringCompletion],
    ["Rich-feature coverage", row.rates.richFeatureCoverage], ["Model forecast coverage", row.rates.modelForecastCoverage],
  ];
  return <section className="bluewater-funnel">
    <div className="bluewater-subhead"><h3>Capture funnel · {row.window}</h3><span>{row.since} → {row.through}</span></div>
    <p className="bluewater-scope">{row.discoveryScope} · {count(row.knownPublishedRounds)} known published rounds / {count(row.theoreticalTimeSlots)} theoretical time slots · expected exact rounds: {row.expectedExactRounds == null ? "unknown" : count(row.expectedExactRounds)}</p>
    <div className="bluewater-count-grid">{stages.map(([label, value]) => <span key={label}>{label}<b>{count(value)}</b></span>)}</div>
    <div className="bluewater-rate-grid">{rates.map(([label, value]) => <span key={label}>{label}<b>{captureRateLabel(value)}</b></span>)}</div>
  </section>;
}

function Comparison({ row }: { row: BluewaterReport["comparisons"][number] }) {
  return <article className="bluewater-comparison">
    <div><b>{row.artifactId}</b><small>{row.modelFamily} · matched n {count(row.matchedN)}</small></div>
    <span>Bluewater candidate <b>Brier {score(row.candidate.brier)} · log loss {score(row.candidate.logLoss)}</b></span>
    <span>WaterX Market Baseline <b>Brier {score(row.baseline.brier)} · log loss {score(row.baseline.logLoss)}</b></span>
    <span>Paired Brier difference <b>{row.pairedBrierDifference ? `${score(row.pairedBrierDifference.mean)} · 95% ${score(row.pairedBrierDifference.lower95)} to ${score(row.pairedBrierDifference.upper95)}` : "Not reported"}</b></span>
  </article>;
}

export function BluewaterResearchPanel({ report, interval, round = null, loading, error, retry, compact = false }: Props) {
  const matchedReport = report?.intervalMinutes === interval ? report : null;
  if (loading && !matchedReport) return <section className="bluewater-loading panel" aria-label="Loading Bluewater research"><span /><span /><span /></section>;
  if (error && !matchedReport) return <section className="bluewater-error panel" role="status"><strong>Bluewater research report unavailable</strong><p>{error}</p><button className="quiet-button" onClick={retry}>Retry Bluewater report</button></section>;
  if (!matchedReport) return <section className="bluewater-empty panel"><div className="eyebrow">BLUEWATER MODEL · {interval} MIN</div><h2>NOT YET QUALIFIED</h2><p>No interval-matched report is available. No model probability is inferred from WaterX odds or another endpoint.</p></section>;
  if (matchedReport.schemaStatus === "unavailable") return <section className="bluewater-empty panel"><div className="eyebrow">BLUEWATER MODEL · {interval} MIN</div><h2>Research evidence unavailable</h2><p>{matchedReport.reason || "The Bluewater report schema is unavailable; model claims are withheld."}</p><button className="quiet-button" onClick={retry}>Retry Bluewater report</button></section>;

  return <div className={`bluewater-report${compact ? " is-compact" : ""}`} aria-label={`${interval}-minute Bluewater research report`}>
    <StatusCard report={matchedReport} interval={interval} round={round} />
    {error && <div className="bluewater-refresh-warning" role="status"><span>Refresh failed · showing the last interval-matched report. Current forecast remains withheld unless exact round identity is current.</span><button className="quiet-button" onClick={retry}>Retry</button></div>}
    {!compact && <section className="bluewater-learning panel">
      <div className="bluewater-status-head"><div><span className="eyebrow">AUDITABLE PROBABILITY EVIDENCE</span><h2>Learning record</h2></div><span className="bluewater-asof">As of {time(matchedReport.asOf)}</span></div>
      <div className="bluewater-training">
        <span>Canonical training <b>{count(matchedReport.training.canonical)}</b></span>
        <span>Rich-feature training <b>{count(matchedReport.training.rich)}</b></span>
        <span>Last daily research run <b>{time(matchedReport.training.lastDailyRun)}</b></span>
        <span>Champion ID <b>{matchedReport.champion?.artifactId || "None"}</b></span>
        <span>Challenger IDs <b>{matchedReport.challengers.length ? matchedReport.challengers.map(item => `${item.artifactId} (${item.modelFamily} · ${item.modelVersion})`).join(" · ") : "None reported"}</b></span>
      </div>
      {matchedReport.funnels.length ? matchedReport.funnels.map((row, i) => <Funnel key={`${row.window}:${row.since}:${i}`} row={row} />)
        : <p className="bluewater-empty-note">No capture funnel windows reported; missing counts are not interpreted as zero.</p>}
      <section className="bluewater-comparisons">
        <h3>Matched model comparison</h3>
        {matchedReport.comparisons.length ? matchedReport.comparisons.map(row => <Comparison key={row.artifactId} row={row} />)
          : <p className="bluewater-empty-note">No matched Brier or log-loss comparison is reported.</p>}
      </section>
      <section className="bluewater-research-notes">
        <div><h3>Research run</h3><p>{time(matchedReport.research.lastRun)} · {matchedReport.research.mode}</p>
          {matchedReport.research.hypotheses.length ? <ul>{matchedReport.research.hypotheses.map((item, i) => <li key={`${item.hypothesis}:${i}`}><b>{item.hypothesis}</b><span>{item.reason}</span><small>Experiment design: {safeValue(item.experiment)}</small></li>)}</ul> : <p className="bluewater-empty-note">No hypotheses reported.</p>}
        </div>
        <div><h3>Experiment results</h3>
          {matchedReport.research.experiments.length ? <ul>{matchedReport.research.experiments.map(item => <li key={item.id}><b>{item.kind} · {item.status}</b><span>{time(item.createdAt)} · {item.id}</span><small>Result: {safeValue(item.result)}</small></li>)}</ul> : <p className="bluewater-empty-note">No experiment results reported.</p>}
        </div>
      </section>
      <section className="bluewater-promotion">
        <h3>Promotion review · advisory only</h3><p>Automatic promotion: no · Eligible: {matchedReport.promotion.eligible ? "reported eligible" : "not eligible"}</p>
        {matchedReport.promotion.reasons.length ? <ul>{matchedReport.promotion.reasons.map((reason, i) => <li key={`${reason}:${i}`}>{reason}</li>)}</ul> : <p className="bluewater-empty-note">No promotion reasons reported; no promotion action is available here.</p>}
      </section>
      <section className="bluewater-mistakes">
        <h3>Descriptive mistake observations</h3>
        {matchedReport.mistakes.length ? <div className="bluewater-mistake-list">{matchedReport.mistakes.map((item, i) => <article key={`${item.roundId}:${item.artifactId}:${i}`}>
          <b>{item.roundId}</b><span>{item.side} · {percent(item.probability)} · lock {count(item.lockSeconds)}s · {count(item.secondsBeforeExpiry)}s before expiry</span>
          <small>WaterX Market Baseline UP {percent(item.baselineProbabilityUp)} · confidence {item.confidenceBucket} · volatility {item.volatilityBucket} · distance {item.distanceBucket} · reversal {item.reversal == null ? "not reported" : item.reversal ? "yes" : "no"}</small>
          <small>Features: {Object.entries(item.features).map(([key, value]) => `${key} ${value == null ? "not reported" : value}`).join(" · ") || "None reported"}</small>
        </article>)}</div> : <p className="bluewater-empty-note">No descriptive mistakes reported. No error pattern is inferred.</p>}
      </section>
      {matchedReport.limitations.length > 0 && <p className="bluewater-limitations">{matchedReport.limitations.join(" · ")}</p>}
      <p className="bluewater-disclaimer">Development research only. Probability evaluation is descriptive evidence, not a guarantee, trade signal, or claim of profitability.</p>
    </section>}
  </div>;
}