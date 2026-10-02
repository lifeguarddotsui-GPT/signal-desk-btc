import type { ResearchChoice, ResearchInterval, ResearchModelEstimate, ResearchReport } from "../../shared/waterx-research";

type Props = {
  report: ResearchReport | null;
  interval: ResearchInterval;
  round: { id: string; startMs: number; expiryMs: number } | null;
  loading?: boolean;
  error?: string;
  fixture?: boolean;
};

const probability = (value: number | null) =>
  value == null || !Number.isFinite(value) || value < 0 || value > 1 ? "—" : `${(value * 100).toFixed(1)}%`;

const time = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "Time not reported"
  : new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC", hour12: false }) + " UTC";

function exactChoice(report: ResearchReport | null, interval: ResearchInterval, round: Props["round"]): ResearchChoice | null {
  if (!report || report.intervalMinutes !== interval || !round || report.currentRound?.id !== round.id ||
      report.currentRound.startMs !== round.startMs || report.currentRound.expiryMs !== round.expiryMs) return null;
  const choice = report.currentChoice;
  if (!choice || choice.intervalMinutes !== interval || choice.roundId !== round.id ||
      choice.startMs !== round.startMs || choice.expiryMs !== round.expiryMs) return null;
  return choice;
}

export function ResearchChoiceCard({ report, interval, round, loading = false, error, fixture = false }: Props) {
  const choice = exactChoice(report, interval, round);
  const reportMatches = report?.intervalMinutes === interval && !!round &&
    report.currentRound?.id === round.id && report.currentRound.startMs === round.startMs && report.currentRound.expiryMs === round.expiryMs;
  const estimate = report?.liveModelEstimate as ResearchModelEstimate | undefined;
  const estimateAt = estimate?.observedAtMs ?? NaN;
  const estimateFresh = Number.isFinite(estimateAt) && estimateAt <= Date.now() + 1_000 && Date.now() - estimateAt <= 10_000;
  const liveEstimate = reportMatches && round && estimate?.status === "available" &&
    estimate.roundId === round.id && estimate.intervalMinutes === interval && estimateFresh ? estimate : null;
  const state = reportMatches ? report?.currentState : null;
  const noChoice = choice?.state === "NO_VALID_CHOICE" || state === "NO_VALID_CHOICE";
  const side = choice?.state === "FROZEN" ? choice.side : null;
  const source = choice?.choiceSource === "market_baseline" ? "Market baseline"
    : choice?.choiceSource === "bluewaterai_model" ? "BluewaterAI model" : null;
  const settlement = choice?.settlement.state;
  const settlementLabel = settlement === "correct" ? "Correct"
    : settlement === "incorrect" ? "Incorrect"
      : settlement === "disputed" ? "Disputed"
        : settlement === "withheld" ? "Withheld"
          : settlement === "pending" ? "Settlement pending" : null;
  const headline = side ?? (noChoice ? "No valid choice" : state === "AWAITING_CHECKPOINT" ? "Awaiting checkpoint"
    : state === "UNAVAILABLE" ? "Research unavailable" : "Awaiting checkpoint");
  const locked = !!choice && choice.state === "FROZEN";
  const resultDetail = source ? `${source} · ${probability(side === "UP" ? choice?.probabilityUp ?? null : choice?.probabilityDown ?? null)}`
    : locked ? `${probability(side === "UP" ? choice?.probabilityUp ?? null : choice?.probabilityDown ?? null)} · choice source not reported`
      : noChoice ? (choice?.noChoiceReason || report?.currentReason || "No timely evidence qualified at the checkpoint.")
        : reportMatches && state === "AWAITING_CHECKPOINT" ? "Waiting for the official checkpoint."
          : reportMatches && state === "UNAVAILABLE" ? (report?.currentReason || "Research report is unavailable.")
            : "No official choice recorded yet.";

  return <section className={`research-choice-card${side === "UP" ? " choice-up" : side === "DOWN" ? " choice-down" : ""}`} aria-label="BluewaterAI round choice">
    <div className="research-choice-main">
      <div className="research-choice-heading">
        <div>
          <span className="research-choice-kicker">ROUND RESEARCH · {interval} MIN</span>
          <h2>BluewaterAI round choice</h2>
        </div>
        <span className={`research-lock${locked ? " is-locked" : ""}`}>{locked ? "LOCKED FOR THIS ROUND" : "NOT LOCKED"}</span>
      </div>
      <div className="research-choice-result" aria-live="polite">
        {loading && !report ? <><span className="research-choice-skeleton" /><small>Loading current-round research</small></>
          : <><strong>{headline}</strong>{noChoice ? <small className="research-choice-result-note is-no-choice"><span className="research-choice-result-full">{resultDetail}</span><span className="research-choice-result-compact">Reason in round details</span></small> : <small className="research-choice-result-note">{resultDetail}</small>}</>}
      </div>
      <div className="research-choice-meta">
        <span><b>Choice time</b>{choice?.state === "FROZEN" ? time(choice.decisionAtMs) : "Not yet recorded"}</span>
        <span><b>Model version</b>{choice?.state === "FROZEN" ? choice.modelVersion ?? (choice.choiceSource === "market_baseline" ? "No model · market baseline" : "Not reported") : "Not yet recorded"}</span>
        <span className="research-round-id"><b>Round</b>{round?.id ?? "No current round identity"}</span>
      </div>
      {settlementLabel && <div className={`research-settlement ${settlement === "correct" ? "is-correct" : settlement === "incorrect" ? "is-incorrect" : ""}`}>
        <strong>{settlementLabel}</strong>
        <span>{choice?.roundId} · {interval}m · {time(choice?.expiryMs)}</span>
        {choice?.settlement.outcome && <span>Verified outcome: {choice.settlement.outcome}</span>}
      </div>}
      {error && <div className="research-inline-error" role="status">Research feed unavailable: {error}</div>}
      {!loading && !error && report?.schemaStatus === "unavailable" && <div className="research-inline-error" role="status">{report.reason || "Research schema is unavailable."}</div>}
      {fixture && <span className="research-fixture-label">SYNTHETIC DEVELOPMENT FIXTURE</span>}
      <p className="research-disclaimer">Research prediction · not an entry recommendation</p>
    </div>
    <div className="research-choice-side">
      <div className="research-checkpoint-snapshot">
        <span className="research-side-label">CHECKPOINT MARKET SNAPSHOT</span>
        {choice?.state === "FROZEN" ? <>
          <strong>UP {probability(choice.evidence.market.probabilityUp)}</strong>
          <strong>DOWN {probability(choice.evidence.market.probabilityDown)}</strong>
          <small>Captured at this choice checkpoint; not the live WaterX odds.</small>
        </> : <small className="research-no-snapshot">Not captured until the choice checkpoint. Live WaterX odds update independently in the market display.</small>}
      </div>
      <div className={`research-live-estimate${liveEstimate ? " is-available" : " is-unavailable"}`}>
        <span className="research-side-label">LIVE MODEL ESTIMATE</span>
        {liveEstimate ? <>
          <strong>UP {probability(liveEstimate.probabilityUp)}</strong>
          <strong>DOWN {probability(liveEstimate.probabilityDown)}</strong>
          <small>{liveEstimate.modelVersion || "Unversioned"} · updating · not the locked choice</small>
        </> : <small>{estimate?.status === "available" ? "Withheld: exact current-round identity or freshness is not proven." : estimate?.reason || "Unavailable · no live model estimate reported."}</small>}
      </div>
    </div>
    <details className="research-choice-audit">
      <summary>Round evidence and checkpoint details</summary>
      <div className="research-choice-audit-grid">
        <span>Exact round ID</span><b className="research-audit-uuid">{round?.id ?? "No current round identity"}</b>
        <span>Checkpoint market snapshot</span><b>{choice?.state === "FROZEN" ? `UP ${probability(choice.evidence.market.probabilityUp)} · DOWN ${probability(choice.evidence.market.probabilityDown)}` : "Not captured before checkpoint"}</b>
        <span>Live model audit</span><b>{liveEstimate ? `${liveEstimate.modelVersion || "Unversioned"} · observed ${time(liveEstimate.observedAtMs)}` : estimate?.status === "available" ? "Withheld because exact round identity, interval, or freshness did not validate." : estimate?.reason || "No live model estimate available for this round."}</b>
        {noChoice && <><span>No-choice reason</span><b>{choice?.noChoiceCode ? `${choice.noChoiceCode} · ` : ""}{choice?.noChoiceReason || report?.currentReason || "No detailed reason reported."}</b></>}
        {choice?.state === "FROZEN" && choice.settlement.outcome && <><span>Verified outcome</span><b>{choice.settlement.outcome}</b></>}
      </div>
    </details>
  </section>;
}