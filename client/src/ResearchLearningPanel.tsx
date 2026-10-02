import type { ReferenceQuality, ResearchReport, ResearchWindow } from "../../shared/waterx-research";

type Props = { report: ResearchReport | null; interval: 5 | 15; loading: boolean; error: string; retry: () => void };
const n = (v: number | null | undefined, digits = 1) => v == null || !Number.isFinite(v) ? "Not reported" : v.toFixed(digits);
const count = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? "—" : v.toLocaleString();
const score = (v: number | null) => v == null || !Number.isFinite(v) ? "Not scored" : v.toFixed(4);
const metric = (title: string, value: string, detail: string) => <article className="research-stat" key={title}><span>{title}</span><strong>{value}</strong><small>{detail}</small></article>;

type DiscrepancyCohort = {
  cohort: "changed" | "unchanged" | "unavailable";
  referenceQuality: ReferenceQuality;
  n: number;
  accuracyPercent: number | null;
  brier: number | null;
  logLoss: number | null;
};
type WindowWithDiscrepancyAudit = ResearchWindow & { referenceDiscrepancyCohorts?: DiscrepancyCohort[] };

function ForwardShadowEvaluation({ evaluation }: { evaluation: NonNullable<ResearchReport["forwardEvaluation"]> | null }) {
  if (!evaluation) return <section className="research-forward panel"><div className="eyebrow">FORWARD SHADOW EVALUATION</div><h2>Not reported</h2><p>No forward evaluation DTO was returned for this interval.</p></section>;
  const empty = evaluation.status === "empty" && evaluation.recordedN === 0;
  const unavailable = evaluation.status === "unavailable" || evaluation.schemaStatus === "unavailable";
  return <section className="research-forward panel" aria-label="Forward shadow evaluation">
    <div className="learning-section-heading">
      <div><div className="eyebrow">FORWARD SHADOW EVALUATION</div><h2>Same-round scored forecasts</h2></div>
      <span className="research-shadow-badge">SHADOW ONLY · NOT PROMOTED</span>
    </div>
    {empty && <p className="research-forward-empty">No forward shadow forecasts yet (recorded N = 0). Candidate training readiness is reported separately.</p>}
    {unavailable && <p className="research-no-data">{evaluation.reason || "Forward evaluation schema is unavailable; no score is inferred."}</p>}
    <div className="research-forward-counts">
      <span>Recorded <b>{count(evaluation.recordedN)}</b></span>
      <span>Scored <b>{count(evaluation.scoredN)}</b></span>
      <span>Unscored <b>{count(evaluation.unscoredN)}</b></span>
      <span>Disputed excluded <b>{count(evaluation.disputedExcludedN)}</b></span>
    </div>
    <div className="research-forward-table-wrap">
      <table className="research-forward-table">
        <thead><tr><th>Source</th><th>n</th><th>Brier</th><th>Log loss</th><th>Calibration</th></tr></thead>
        <tbody>{([
          ["BluewaterAI candidate", evaluation.candidate],
          ["WaterX market baseline", evaluation.marketBaseline],
        ] as const).map(([label, result]) => <tr key={label}>
          <td>{label}</td><td>{count(result.n)}</td><td>{score(result.brier)}</td><td>{score(result.logLoss)}</td>
          <td>{result.calibration.length ? <details className="research-calibration-details">
            <summary>{result.calibration.length} bins</summary>
            <div>{result.calibration.map((bin, index) => <span key={`${bin.lower}-${bin.upper}-${index}`}>
              {n(bin.lower * 100)}–{n(bin.upper * 100)}% · predicted {n(bin.predictedUpMean * 100)}% · observed {n(bin.observedUpRate * 100)}% · n {count(bin.n)}
            </span>)}</div>
          </details> : "No bins"}
          </td>
        </tr>)}</tbody>
      </table>
    </div>
    {evaluation.reason && !unavailable && <p className="research-forward-reason">{evaluation.reason}</p>}
    <p className="research-forward-foot">This is an offline forward evaluation only; it is not a promoted or displayable serving model. Training readiness and job attempts above are a separate state.</p>
  </section>;
}

function WindowSection({ window }: { window: ResearchWindow }) {
  const discrepancyAudit = (window as WindowWithDiscrepancyAudit).referenceDiscrepancyCohorts;
  return <section className="research-window panel">
    <div className="learning-section-heading"><div><div className="eyebrow">PROSPECTIVE ROUND RESULTS</div><h2>{window.name}</h2></div><span>{count(window.scoredChoices)} scored choices</span></div>
    <div className="research-stats">
      {metric("OBSERVED ROUNDS", count(window.observedRounds), `${count(window.officialChoices)} official · ${count(window.noValidChoice)} no valid choice`)}
      {metric("SCHEDULED CHECKPOINT COVERAGE", window.coveragePercent == null ? "Not reported" : `${n(window.coveragePercent)}%`,
        `${count(window.scheduledCheckpoints)} scheduled · ${count(window.unobservedCheckpoints)} unobserved`)}
      {metric("DIRECTION ACCURACY", window.accuracyPercent == null ? "Not scored" : `${n(window.accuracyPercent)}%`, `${count(window.correct)} correct / ${count(window.scoredChoices)} scored; unresolved excluded`)}
      {metric("VERIFIED SETTLEMENTS", count(window.verifiedSettlements), "Labels accepted by the WaterX verification gate")}
      {metric("ROUND CHOICE BRIER", score(window.brier), "Scored checkpoint choices; source is identified in the ledger")}
      {metric("ROUND CHOICE LOG LOSS", score(window.logLoss), "Scored checkpoint choices; source is identified in the ledger")}
      {metric("WATERX BASELINE", `Brier ${score(window.marketBaselineBrier)}`, `Log loss ${score(window.marketBaselineLogLoss)} · same-round comparison`)}
      {metric("PENDING / DISPUTED", `${count(window.pending)} / ${count(window.disputed)}`, `${count(window.withheld)} withheld; none counted as wins or losses`)}
    </div>
    <div className="research-quality-row" aria-label={`${window.name} reference and data quality`}>
      <span>Reference quality</span><b>{count(window.provisional)} provisional</b><b>{count(window.confirmed)} confirmed</b><b>{count(window.unavailableReference)} unavailable</b>
      <span>Feature coverage failures <b>{count(window.featureCoverageFailures)}</b></span>
      <span>Reference discrepancies <b>{count(window.referenceDiscrepancies)}</b></span>
    </div>
    <div className="research-breakdown-grid">
      <div><h3>Reference-quality cohorts</h3>
        {window.cohorts.length ? window.cohorts.map(cohort => <p key={cohort.referenceQuality}><b>{cohort.referenceQuality}</b><span>n {cohort.n} · accuracy {cohort.accuracyPercent == null ? "not scored" : `${n(cohort.accuracyPercent)}%`} · Brier {score(cohort.brier)} · loss {score(cohort.logLoss)}</span></p>) : <p className="research-no-data">No cohort scores reported.</p>}
      </div>
      <div><h3>Probability calibration</h3>
        {window.calibration.length ? window.calibration.map((bin, i) => <p key={`${bin.lower}-${bin.upper}-${i}`}><b>{n(bin.lower * 100)}–{n(bin.upper * 100)}%</b><span>predicted {n(bin.predictedUpMean * 100)}% · observed {n(bin.observedUpRate * 100)}% · n {count(bin.n)}</span></p>) : <p className="research-no-data">No calibration bins scored.</p>}
      </div>
    </div>
    <div className="research-discrepancy-audit">
      <div className="research-discrepancy-heading"><h3>Reference discrepancy cohorts</h3><span>AFTER-LABEL AUDIT · NOT A PREDICTOR FEATURE</span></div>
      {discrepancyAudit?.length ? <div className="research-discrepancy-grid">
        {(["changed", "unchanged", "unavailable"] as const).map(group => {
          const rows = discrepancyAudit.filter(item => item.cohort === group);
          return <section key={group}><h4>{group} reference</h4>{rows.length ? rows.map((item, index) => <p key={`${item.referenceQuality}-${index}`}>
            <b>{item.referenceQuality}</b><span>n {count(item.n)} · accuracy {item.accuracyPercent == null ? "not scored" : `${n(item.accuracyPercent)}%`} · Brier {score(item.brier)} · log loss {score(item.logLoss)}</span>
          </p>) : <small>No cohort observations reported.</small>}</section>;
        })}
      </div> : <p className="research-no-data">Reference discrepancy subgroup metrics are not reported.</p>}
      <p>Reference changes are grouped after labels become available for data-quality review; they are never used as predictor features.</p>
    </div>
  </section>;
}

export function ResearchLearningPanel({ report, interval, loading, error, retry }: Props) {
  const windows = report?.intervalMinutes === interval ? report.windows : [];
  const job = report?.intervalMinutes === interval ? report.dailyJob : null;
  const reasons = report?.intervalMinutes === interval ? report.noChoiceReasons : [];
  const recentChoices = report?.intervalMinutes === interval
    ? [...(report.recentChoices ?? [])].filter(choice => choice.intervalMinutes === interval)
      .sort((a, b) => b.decisionAtMs - a.decisionAtMs).slice(0, 20)
    : [];
  const forwardEvaluation = report?.intervalMinutes === interval &&
    report.forwardEvaluation?.intervalMinutes === interval && report.forwardEvaluation.shadowOnly === true
    ? report.forwardEvaluation : null;
  if (loading && !report) return <section className="research-loading panel" aria-label="Loading research evidence"><div className="research-skeleton" /><div className="research-skeleton short" /><div className="research-skeleton" /></section>;
  if (error && !report) return <div className="research-error"><strong>Round research could not be loaded</strong><p>{error}</p><button className="quiet-button" onClick={retry}>Retry research report</button></div>;
  if (!report || report.intervalMinutes !== interval || report.schemaStatus === "unavailable") return <section className="research-unavailable panel"><div className="eyebrow">PROSPECTIVE RESEARCH</div><h2>Research evidence unavailable</h2><p>{report?.reason || `No ${interval}-minute research report is available. Metrics are withheld rather than inferred from older model endpoints.`}</p></section>;
  return <section className="research-report" aria-label={`${interval}-minute research learning report`}>
    <div className={`research-report-banner${report.alert.active ? " alert-active" : ""}`}>
      <div><span className="eyebrow">{interval}-MINUTE · ROUND-ISOLATED RESEARCH</span><h2>{report.alert.active ? "Choice coverage alert" : "Prospective evidence, not a promise"}</h2><p>{report.alert.active ? report.alert.reason || "Fresh rounds are arriving while official choices remain absent." : report.note}</p></div>
      <span className="research-schema">{report.schemaStatus === "available" ? "SCHEMA AVAILABLE" : "SCHEMA UNAVAILABLE"} · as of {new Date(report.asOf).toLocaleString()}</span>
    </div>
    <div className="research-window-list">{(["24h", "7d", "lifetime"] as const).map(name => {
      const found = windows.find(item => item.name === name);
      return found ? <WindowSection key={name} window={found} /> : <section className="research-window panel" key={name}><h2>{name}</h2><p className="research-no-data">This window is not present in the API report; no values inferred.</p></section>;
    })}</div>
    <ForwardShadowEvaluation evaluation={forwardEvaluation} />
    <details className="research-ledger">
      <summary><span>Recent round ledger · historical exact-round records</span><b>{recentChoices.length} of up to 20</b></summary>
      {recentChoices.length ? <div className="research-ledger-list">{recentChoices.map((choice, index) => {
        const chosen = choice.state === "FROZEN" ? choice.side ?? "Choice unavailable" : "No valid choice";
        const source = choice.choiceSource === "market_baseline" ? "Market baseline"
          : choice.choiceSource === "bluewaterai_model" ? "BluewaterAI model" : "No official source";
        const status = choice.state === "NO_VALID_CHOICE" ? "No valid choice"
          : choice.settlement.state === "pending" ? "Settlement pending"
            : choice.settlement.state === "correct" ? "Correct"
              : choice.settlement.state === "incorrect" ? "Incorrect"
                : choice.settlement.state === "disputed" ? "Disputed"
                  : choice.settlement.state === "withheld" ? "Withheld"
                    : choice.settlement.state === "not-applicable" ? "Not applicable" : "Settlement not reported";
        return <article className="research-ledger-row" key={`${choice.intervalMinutes}:${choice.roundId}:${choice.decisionAtMs}:${index}`}>
          <div className="research-ledger-direction"><strong>{chosen}</strong><span>{status}</span></div>
          <div className="research-ledger-id" title={choice.roundId}><b>{choice.intervalMinutes}m · {choice.roundId}</b><small>{new Date(choice.decisionAtMs).toLocaleString()} · choice time</small></div>
          <div className="research-ledger-facts"><span>{source}</span><span>Reference: {choice.evidence.reference.quality}</span><span>{choice.modelVersion || "No model version"}</span></div>
          {choice.state === "NO_VALID_CHOICE" && choice.noChoiceReason && <p>{choice.noChoiceCode ? `${choice.noChoiceCode} · ` : ""}{choice.noChoiceReason}</p>}
          {choice.settlement.outcome && <small className="research-ledger-outcome">Verified outcome: {choice.settlement.outcome}</small>}
        </article>;
      })}</div> : <p className="research-no-data">No recent round records reported for this interval.</p>}
    </details>
    <section className="research-support-grid">
      <div className="panel"><div className="learning-section-heading"><div><div className="eyebrow">COVERAGE FAILURES</div><h2>No-choice reasons</h2></div><span>interval-specific</span></div>
        {reasons.length ? <ul className="research-reason-list">{reasons.map(reason => <li key={reason.code}><b>{reason.code}</b><span>{reason.reason}</span><strong>{count(reason.count)}</strong></li>)}</ul> : <p className="research-no-data">No reason counts reported.</p>}
      </div>
      <div className="panel"><div className="learning-section-heading"><div><div className="eyebrow">BOUNDED SHADOW TRAINING</div><h2>Daily job</h2></div><span className={`job-state ${job?.configured ? "" : "not-configured"}`}>{job?.configured ? job.status.replace(/[_-]/g, " ") : "not configured"}</span></div>
        <div className="research-job-grid">
          <span>Mode</span><b>{job?.mode || "Not reported"}</b><span>Guarantees daily execution</span><b>{job ? job.guaranteesDailyExecution ? "Yes" : "No" : "Not reported"}</b>
          <span>Scheduled day / missed</span><b>{job?.scheduledDay || "Not reported"} / {count(job?.missedDays)}</b>
          <span>Started / finished</span><b>{job?.startedAt || "Not reported"} / {job?.finishedAt || "Not reported"}</b>
          <span>Dataset</span><b>{job?.datasetFingerprint || "No fingerprint"} · n {count(job?.datasetCount)}</b>
          <span>Reason / error</span><b>{job?.reason || job?.error || "No detail reported"}</b>
        </div>
        {job?.phases?.length ? <div className="research-phases">{job.phases.map((phase, i) => <span key={`${phase.at}-${i}`}>{phase.status} · {phase.at}</span>)}</div> : <p className="research-no-data">No job phases reported. A missing attempt is not represented as successful training.</p>}
      </div>
    </section>
    <div className="research-report-foot">Direction accuracy is not probability calibration or hypothetical $5 profitability. Labels require verified settlement and exact interval/round matching.</div>
  </section>;
}