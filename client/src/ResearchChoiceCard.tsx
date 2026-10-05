import * as React from "react";
import { LockKeyhole } from "lucide-react";
import type { ResearchChoice, ResearchInterval, ResearchModelEstimate, ResearchReport, ResearchSide } from "../../shared/waterx-research";

type Lifecycle = {
  state: "WATCHING" | "LEANING" | "FINAL_CHOICE" | "RESULT" | "NO_VALID_DATA";
  side: ResearchSide | null;
  result: "CORRECT" | "INCORRECT" | null;
  occurredAt: string | null;
  primaryLockSeconds: number;
  outcome?: ResearchSide | null;
};
type LiveProbabilities = {
  probabilityUp: number | null;
  probabilityDown: number | null;
  observedAt: string | null;
  source: string;
  fresh: boolean;
};
type ReportWithLifecycle = ResearchReport & {
  lifecycle?: Lifecycle;
  liveProbabilities?: LiveProbabilities;
};
type Props = {
  report: ResearchReport | null;
  interval: ResearchInterval;
  round: { id: string; startMs: number; expiryMs: number } | null;
  loading?: boolean;
  error?: string;
  fixture?: boolean;
  marketOdds?: { up: string; down: string; current: boolean; source: string; asOf?: string };
};

const probability = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) || value < 0 || value > 1 ? "—" : `${(value * 100).toFixed(1)}%`;
const time = (value: number | string | null | undefined) => value == null || !Number.isFinite(typeof value === "number" ? value : Date.parse(value))
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

export function ResearchChoiceCard({ report, interval, round, loading = false, error, fixture = false, marketOdds }: Props) {
  const choice = exactChoice(report, interval, round);
  const reportMatches = report?.intervalMinutes === interval && !!round &&
    report.currentRound?.id === round.id && report.currentRound.startMs === round.startMs && report.currentRound.expiryMs === round.expiryMs;
  const typedReport = report as ReportWithLifecycle | null;
  const estimate = report?.liveModelEstimate as ResearchModelEstimate | undefined;
  const estimateAt = estimate?.observedAtMs ?? NaN;
  const estimateFresh = Number.isFinite(estimateAt) && estimateAt <= Date.now() + 1_000 && Date.now() - estimateAt <= 10_000;
  const liveEstimate = reportMatches && round && estimate?.status === "available" &&
    estimate.roundId === round.id && estimate.intervalMinutes === interval && estimateFresh ? estimate : null;
  const reportedLifecycle = reportMatches ? typedReport?.lifecycle : undefined;
  const legacyNoChoice = choice?.state === "NO_VALID_CHOICE" || (reportMatches && report?.currentState === "NO_VALID_CHOICE");
  const frozen = choice?.state === "FROZEN" && choice.side !== null;
  const legacyResult = choice?.settlement.state === "correct" ? "CORRECT"
    : choice?.settlement.state === "incorrect" ? "INCORRECT" : null;
  const lifecycleState = reportedLifecycle?.state ??
    (legacyNoChoice ? "NO_VALID_DATA" : legacyResult ? "RESULT" : frozen ? "FINAL_CHOICE" : "WATCHING");
  const result = reportedLifecycle?.result ?? legacyResult;
  const outcome = reportedLifecycle?.outcome ?? choice?.settlement.outcome ?? null;
  const finalSide = frozen ? choice?.side ?? null : reportedLifecycle?.side ?? null;
  const locked = lifecycleState === "FINAL_CHOICE" || lifecycleState === "RESULT" || frozen;
  const noChoice = !frozen && (lifecycleState === "NO_VALID_DATA" || legacyNoChoice);
  const lean = reportedLifecycle?.state === "LEANING" ? reportedLifecycle.side : null;
  const explicitLifecycle = !!reportedLifecycle;
  const headline = noChoice ? "NO VALID DATA"
    : result && outcome ? `${result} · VERIFIED OUTCOME: ${outcome}`
      : lifecycleState === "RESULT" ? "RESULT: settlement not verified"
      : locked && finalSide ? `FINAL CHOICE: ${finalSide}`
        : lifecycleState === "LEANING" ? lean ? `LEANING ${lean}` : "LEANING"
          : "WATCHING";
  const choiceProbability = finalSide === "UP" ? choice?.probabilityUp ?? null : finalSide === "DOWN" ? choice?.probabilityDown ?? null : null;
  const resultDetail = result && outcome ? `Verified outcome ${outcome} · immutable choice ${finalSide ?? choice?.side ?? "not reported"}`
    : locked && finalSide ? `${probability(choiceProbability)} · frozen prediction; cannot change`
      : noChoice ? choice?.noChoiceReason || report?.currentReason || "No timely evidence qualified. No direction is fabricated."
        : lean ? "Current lean only · may change before the lock point."
          : lifecycleState === "LEANING" ? "The preferred direction is not reported; no side is inferred."
          : lifecycleState === "RESULT" ? "A verified settlement result is not available. The frozen prediction remains unchanged."
          : reportedLifecycle?.state === "WATCHING" ? "Live probabilities move throughout this round; no official prediction is locked yet."
            : reportMatches && report?.currentState === "AWAITING_CHECKPOINT" ? "Watching for the predefined round checkpoint."
            : reportMatches && report?.currentState === "UNAVAILABLE" ? report.currentReason || "Research report unavailable."
              : "Live probabilities move throughout this round; no official prediction is locked yet.";
  const source = choice?.choiceSource === "market_baseline" ? "WaterX Market Baseline"
    : choice?.choiceSource === "bluewaterai_model" ? "BluewaterAI model" : null;
  const settlement = choice?.settlement.state;
  const settlementLabel = settlement === "correct" ? "CORRECT"
    : settlement === "incorrect" ? "INCORRECT"
      : settlement === "disputed" ? "Disputed"
        : settlement === "withheld" ? "Withheld"
          : settlement === "pending" ? "Settlement pending" : null;
  const mostRecentVerifiedResult = report?.intervalMinutes === interval
    ? (report.recentChoices ?? [])
      .filter(item => item.intervalMinutes === interval && item.roundId !== round?.id &&
        item.state === "FROZEN" && item.side !== null &&
        (item.settlement.state === "correct" || item.settlement.state === "incorrect") &&
        item.settlement.outcome !== null)
      .sort((a, b) => b.decisionAtMs - a.decisionAtMs)[0] ?? null
    : null;
  const reportedLive = reportMatches ? typedReport?.liveProbabilities : undefined;
  const liveAtMs = reportedLive?.observedAt ? Date.parse(reportedLive.observedAt) : NaN;
  const liveFresh = !!reportedLive?.fresh && Number.isFinite(liveAtMs) && liveAtMs <= Date.now() + 1_000 && Date.now() - liveAtMs <= 15_000;
  const liveUp = liveFresh ? reportedLive?.probabilityUp : null;
  const liveDown = liveFresh ? reportedLive?.probabilityDown : null;
  const hasReportedOdds = liveUp != null || liveDown != null;
  const oddsAreCurrent = hasReportedOdds || marketOdds?.current === true;
  const oddsUp = hasReportedOdds ? probability(liveUp) : marketOdds?.current ? marketOdds.up : "Unavailable";
  const oddsDown = hasReportedOdds ? probability(liveDown) : marketOdds?.current ? marketOdds.down : "Unavailable";
  const oddsSource = hasReportedOdds ? reportedLive?.source || "Source not reported" : marketOdds?.source || "WaterX";
  const oddsTime = hasReportedOdds ? time(reportedLive?.observedAt) : time(marketOdds?.asOf);
  const lockSeconds = reportedLifecycle?.primaryLockSeconds ?? report?.policy?.checkpointSecondsBeforeClose?.[interval] ?? null;
  const stageIndex = lifecycleState === "RESULT" ? 3 : locked ? 2 : lifecycleState === "LEANING" ? 1 : 0;
  const resultVerified = lifecycleState === "RESULT" && !!result && !!outcome;

  return <section className={`research-choice-card${locked ? " is-final" : ""}${finalSide === "UP" ? " choice-up" : finalSide === "DOWN" ? " choice-down" : ""}`} aria-label="BluewaterAI round choice">
    <div className="research-choice-main">
      <div className="research-choice-heading">
        <div>
          <span className="research-choice-kicker">ROUND RESEARCH · {interval} MIN</span>
          <h2>One immutable prediction per round</h2>
        </div>
        <span className={`research-lock${locked ? " is-locked" : ""}`}>{locked ? <><LockKeyhole size={12} aria-hidden="true" /> LOCKED</> : "NOT LOCKED"}</span>
      </div>
      <ol className="research-lifecycle" aria-label="Prediction lifecycle">
        {(["WATCHING", "LEANING", "FINAL CHOICE", "RESULT"] as const).map((stage, index) =>
          <li key={stage} className={index === stageIndex ? "is-current" : index < stageIndex ? "is-complete" : ""}>
            <span>{index + 1}</span>{stage}
          </li>)}
      </ol>
      <div className={`research-choice-result${resultVerified ? " is-result" : ""}`} aria-live="polite">
        {loading && !report ? <><span className="research-choice-skeleton" /><small>Loading current-round research</small></>
          : <><strong>{headline}</strong><small>{resultDetail}</small></>}
      </div>
      {locked && <p className="research-immutable-note">Frozen before settlement · this prediction cannot change</p>}
      <div className="research-choice-meta">
        <span><b>Choice time</b>{frozen ? time(choice?.decisionAtMs) : reportedLifecycle?.occurredAt ? time(reportedLifecycle.occurredAt) : "Not yet recorded"}</span>
        <span><b>Research source</b>{source || (frozen ? "Source not reported" : "Not yet recorded")}</span>
        <span><b>Model version</b>{frozen ? choice?.modelVersion ?? (choice?.choiceSource === "market_baseline" ? "No model · WaterX Market Baseline" : "Not reported") : "Not yet recorded"}</span>
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
      <p className="research-disclaimer">Research prediction · separate from the read-only $5 entry assessment</p>
      {mostRecentVerifiedResult && <details className={`research-previous-result ${mostRecentVerifiedResult.settlement.state === "correct" ? "is-correct" : "is-incorrect"}`}>
        <summary>
          <span>MOST RECENT VERIFIED ROUND RESULT · HISTORICAL</span>
          <strong>{mostRecentVerifiedResult.settlement.state === "correct" ? "CORRECT" : "INCORRECT"} · {mostRecentVerifiedResult.settlement.outcome} settled</strong>
        </summary>
        <div className="research-previous-result-facts">
          <span>Exact round ID<b>{mostRecentVerifiedResult.roundId}</b></span>
          <span>Frozen choice<b>{mostRecentVerifiedResult.side}</b></span>
          <span>Verified outcome<b>{mostRecentVerifiedResult.settlement.outcome}</b></span>
          <span>Choice time<b>{time(mostRecentVerifiedResult.decisionAtMs)}</b></span>
        </div>
        <small>Prior round record only · not the current round choice.</small>
      </details>}
    </div>
    <div className="research-choice-side">
      <div className={`research-live-market${oddsAreCurrent ? " is-current" : " is-unavailable"}`}>
        <span className="research-side-label">LIVE WATERX MARKET · NOT THE FROZEN CHOICE</span>
        <div><b>UP {oddsUp}</b><b>DOWN {oddsDown}</b></div>
        <small>{oddsAreCurrent ? `${oddsSource} · observed ${oddsTime}` : "Unavailable · latest quote is not verified fresh"}{reportedLive && !liveFresh && !marketOdds?.current ? " · stale or freshness unverified" : ""}</small>
      </div>
      <div className="research-checkpoint-snapshot">
        <span className="research-side-label">CHECKPOINT MARKET SNAPSHOT</span>
        {frozen ? <>
          <strong>UP {probability(choice?.evidence.market.probabilityUp)}</strong>
          <strong>DOWN {probability(choice?.evidence.market.probabilityDown)}</strong>
          <small>Captured at lock; distinct from current live WaterX odds.</small>
        </> : <small className="research-no-snapshot">Captured only when a choice is locked.</small>}
      </div>
      <div className={`research-live-estimate${liveEstimate ? " is-available" : " is-unavailable"}`}>
        <span className="research-side-label">LIVE MODEL ESTIMATE</span>
        {liveEstimate ? <>
          <strong>UP {probability(liveEstimate.probabilityUp)}</strong>
          <strong>DOWN {probability(liveEstimate.probabilityDown)}</strong>
          <small>{liveEstimate.modelVersion || "Unversioned"} · {time(liveEstimate.observedAtMs)} · not the locked choice</small>
        </> : <small>{estimate?.status === "available" ? "Withheld: exact current-round identity or freshness is not proven." : estimate?.reason || "Unavailable · no live model estimate reported."}</small>}
      </div>
    </div>
    <details className="research-choice-audit">
      <summary>Round evidence and checkpoint details</summary>
      <div className="research-choice-audit-grid">
        <span>Exact round ID</span><b className="research-audit-uuid">{round?.id ?? "No current round identity"}</b>
        <span>Lifecycle source</span><b>{explicitLifecycle ? `Backend lifecycle · ${reportedLifecycle?.state}` : "Compatible state inferred from exact-round legacy record"}</b>
        <span>Primary lock horizon</span><b>{lockSeconds == null ? "Not reported" : `${lockSeconds}s before expiry`}</b>
        <span>Live market quote</span><b>{oddsAreCurrent ? `${oddsSource} · observed ${oddsTime}` : "Unavailable or stale"}</b>
        <span>Checkpoint market snapshot</span><b>{frozen ? `UP ${probability(choice?.evidence.market.probabilityUp)} · DOWN ${probability(choice?.evidence.market.probabilityDown)}` : "Not captured before checkpoint"}</b>
        <span>Live model audit</span><b>{liveEstimate ? `${liveEstimate.modelVersion || "Unversioned"} · observed ${time(liveEstimate.observedAtMs)}` : estimate?.status === "available" ? "Withheld because exact round identity, interval, or freshness did not validate." : estimate?.reason || "No live model estimate available for this round."}</b>
        {noChoice && <><span>No-choice reason</span><b>{choice?.noChoiceCode ? `${choice.noChoiceCode} · ` : ""}{choice?.noChoiceReason || report?.currentReason || "No detailed reason reported."}</b></>}
        {resultVerified && <><span>Verified outcome</span><b>{outcome}</b></>}
      </div>
    </details>
  </section>;
}