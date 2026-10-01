import { ArrowDownRight, ArrowUpRight, ShieldAlert, ShieldCheck } from "lucide-react";
import { assessAdvisoryCard, type AdvisoryPayload, type AdvisoryRoundIdentity } from "./advisory-contract";

type Props = {
  advisory: AdvisoryPayload | null;
  expectedIdentity: AdvisoryRoundIdentity | null;
  roundCurrent: boolean;
  quoteCurrent: boolean;
  locked: { up: boolean; down: boolean };
  nowMs: number;
  fixtureName?: string | null;
  marketOdds: {
    up: string; down: string; current: boolean; source: string; asOf?: string;
    upPrice?: string; downPrice?: string;
  };
};

type AssessmentUi = {
  classification?: string;
  modelAvailable?: boolean;
  quoteAvailable?: boolean;
  model?: {
    calibratedProbability?: number;
    lowerBoundProbability?: number;
    uncertaintyMargin?: number;
    sampleCount?: number;
    modelVersion?: string;
    probabilityAtMs?: number;
  } | null;
  economics?: {
    totalCostUsd?: number;
    grossReceiptIfWinUsd?: number;
    netProfitIfWinUsd?: number;
    lossIfUnsuccessfulUsd?: number;
    conservativeExpectedNetUsd?: number | null;
  } | null;
  calibratedProbability?: number | null;
  lowerBoundProbability?: number | null;
  reliability?: number | string | null;
  reliabilityPercent?: number | null;
  sampleCount?: number | null;
  modelVersion?: string | null;
  probabilityAtMs?: number | null;
};
type ProofModelUi = AssessmentUi & {
  evidenceCount?: number;
  qualifiedSampleCount?: number;
  version?: string;
  probabilityAtMs?: number;
  uncertaintyMargin?: number;
  uncertaintyLow?: number;
  uncertaintyHigh?: number;
};
type ProofQuoteUi = {
  totalCostUsd?: number;
  costVerified?: boolean;
  quotedAtMs?: number;
  ageMs?: number;
  grossWinningReceiptUsd?: number;
  netProfitIfWinUsd?: number;
  lossIfLoseUsd?: number;
  lossIfUnsuccessfulUsd?: number;
  conservativeExpectedNetValueUsd?: number;
};
const validNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const dollars = (value: unknown) => validNumber(value)
  ? `${value < 0 ? "−" : ""}$${Math.abs(value).toFixed(2)}` : "Withheld";
const exactStateLabel = (value: string) => value === "HIGH_LIKELIHOOD"
  ? "HIGH LIKELIHOOD" : value === "FAVORABLE_RISK_REWARD" ? "FAVORABLE RISK / REWARD" : "OBSERVE";
const age = (ms: number | undefined, now: number) => validNumber(ms) && ms <= now && ms >= 0
  ? `${Math.floor((now - ms) / 1000)}s ago` : "Withheld";
const observedAge = (stamp: string | undefined, now: number) => {
  if (!stamp) return "age not reported";
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? `${Math.max(0, Math.floor((now - ms) / 1000))}s ago` : "timestamp unavailable";
};
const percent = (value: unknown) => validNumber(value) && value >= 0 && value <= 1
  ? `${(value * 100).toFixed(1)}%` : "Withheld";

export function AdvisoryCards({ advisory, expectedIdentity, roundCurrent, quoteCurrent, locked, nowMs, fixtureName, marketOdds }: Props) {
  return <section className="advisory-desk" aria-label="UP and DOWN opportunity assessments">
    <div className="advisory-heading">
      <div><span className="eyebrow">READ-ONLY ASSESSMENT</span><h2>Side assessments</h2></div>
      <span className="advisory-no-orders">NO EXECUTION</span>
    </div>
    <p className="assessment-source">WaterX market odds · {marketOdds.current ? `${marketOdds.source} · observed ${observedAge(marketOdds.asOf, nowMs)}` : "not current"}</p>
    {fixtureName && <div className="advisory-fixture-tag">DEVELOPMENT FIXTURE · {fixtureName.toUpperCase().replaceAll("-", " ")}</div>}
    <div className="advisory-card-list">
      {(["up", "down"] as const).map(side => {
        const assessment = assessAdvisoryCard({
          side, advisory, expectedIdentity, roundCurrent, quoteCurrent,
          sideLocked: locked[side], nowMs, fixtureMode: !!fixtureName,
        });
        const ui = assessment as typeof assessment & AssessmentUi;
        const state = ["OBSERVE", "HIGH_LIKELIHOOD", "FAVORABLE_RISK_REWARD"].includes(assessment.state)
          ? assessment.state : "OBSERVE";
        const isQualifiedState = assessment.qualified && state !== "OBSERVE";
        const presentedState = isQualifiedState ? state : "OBSERVE";
        const modelAvailable = ui.modelAvailable === true;
        const quoteAvailable = ui.quoteAvailable === true;
        const proof = advisory?.proof?.[side];
        const verifiedModel = ui.model;
        const verifiedEconomics = ui.economics;
        const model = (proof?.model ?? {}) as NonNullable<typeof proof>["model"] & ProofModelUi;
        const execution = (proof?.executionQuote ?? {}) as NonNullable<typeof proof>["executionQuote"] & ProofQuoteUi;
        const modelProbability = modelAvailable
          ? ui.calibratedProbability ?? verifiedModel?.calibratedProbability ?? model.calibratedProbability : null;
        const lowerBound = modelAvailable
          ? ui.lowerBoundProbability ?? verifiedModel?.lowerBoundProbability ?? model.lowerBoundProbability : null;
        const samples = modelAvailable ? validNumber(ui.sampleCount) ? ui.sampleCount
          : validNumber(verifiedModel?.sampleCount) ? verifiedModel.sampleCount
            : validNumber(model.qualifiedSampleCount) ? model.qualifiedSampleCount
            : validNumber(model.evidenceCount) ? model.evidenceCount : null : null;
        const reliability = validNumber(ui.reliabilityPercent) ? `${ui.reliabilityPercent.toFixed(1)}%`
          : validNumber(ui.reliability) ? `${(ui.reliability <= 1 ? ui.reliability * 100 : ui.reliability).toFixed(1)}%`
            : typeof ui.reliability === "string" ? ui.reliability : "Withheld";
        const Icon = side === "up" ? ArrowUpRight : ArrowDownRight;
        const StatusIcon = isQualifiedState ? ShieldCheck : ShieldAlert;
        const className = presentedState === "FAVORABLE_RISK_REWARD" ? "favorable-risk-reward"
          : presentedState === "HIGH_LIKELIHOOD" ? "high-likelihood" : "observe";
        const modelVersion = ui.modelVersion ?? verifiedModel?.modelVersion ?? model.version;
        const uncertaintyMargin = verifiedModel?.uncertaintyMargin ?? model.uncertaintyMargin;
        const uncertainty = modelAvailable && validNumber(uncertaintyMargin) && uncertaintyMargin >= 0
          ? `±${(uncertaintyMargin * 100).toFixed(1)} pp` : "Withheld";
        const probabilityAge = modelAvailable
          ? age(validNumber(ui.probabilityAtMs) ? ui.probabilityAtMs
            : verifiedModel?.probabilityAtMs ?? model.probabilityAtMs, nowMs) : "Withheld";
        const quoteAge = quoteAvailable
          ? age(execution.quotedAtMs, nowMs)
          : "Withheld";
        const economicsAvailable = quoteAvailable && !!verifiedEconomics;
        return <article key={side} className={`advisory-card ${side} ${className}`} data-classification={presentedState}
          aria-label={`${side.toUpperCase()} assessment: ${exactStateLabel(presentedState)}`}>
          <div className="advisory-card-top">
            <span className="advisory-direction"><Icon size={17} aria-hidden="true" />{side.toUpperCase()}</span>
            <span className={`advisory-state-chip ${isQualifiedState ? "qualified" : ""}`}>
              <StatusIcon size={13} aria-hidden="true" />{exactStateLabel(presentedState)}
            </span>
          </div>
          <div className="assessment-main">
            <span className="assessment-probability"><small>BLUEWATERAI CALIBRATED</small><b>{percent(modelProbability)}</b></span>
            <span className="assessment-market"><small>WATERX MARKET</small><b>{marketOdds.current ? marketOdds[side] : "Unavailable"}</b><em>{marketOdds.current ? `${side === "up" ? marketOdds.upPrice : marketOdds.downPrice} side price` : "Side price unavailable"}</em></span>
          </div>
          {isQualifiedState && <p className="assessment-position-note">{presentedState === "HIGH_LIKELIHOOD" ? "High likelihood · modest return" : "Favorable risk/reward"}</p>}
          <div className="assessment-metadata">
            <span>Model <b>{modelAvailable && modelVersion ? modelVersion : "Withheld"}</b></span>
            <span>Probability age <b>{probabilityAge}</b></span>
            <span>Reliability <b>{modelAvailable ? reliability : "Withheld"}</b></span>
            <span>Conservative lower bound <b>{percent(lowerBound)}</b></span>
            <span>Probability uncertainty <b>{modelAvailable ? uncertainty : "Withheld"}</b></span>
            <span>Qualified samples <b>{modelAvailable && samples != null ? samples.toLocaleString() : "Withheld"}</b></span>
          </div>
          <p className="advisory-reason"><ShieldAlert size={13} aria-hidden="true" />{assessment.reason || advisory?.reason || "No independently verified assessment; observe."}</p>
          <div className="assessment-economics" aria-label={`${side.toUpperCase()} verified $5 economics`}>
            <span>All-in cost <b>{economicsAvailable ? dollars(verifiedEconomics.totalCostUsd) : "Withheld"}</b></span>
            <span>Gross receipt if win <b>{economicsAvailable ? dollars(verifiedEconomics.grossReceiptIfWinUsd) : "Withheld"}</b></span>
            <span>Net profit if win <b>{economicsAvailable ? dollars(verifiedEconomics.netProfitIfWinUsd) : "Withheld"}</b></span>
            <span>Loss if wrong <b>{economicsAvailable ? dollars(verifiedEconomics.lossIfUnsuccessfulUsd) : "Withheld"}</b></span>
            <span>Conservative expected net <b>{economicsAvailable ? dollars(verifiedEconomics.conservativeExpectedNetUsd) : "Withheld"}</b></span>
            <span>Quote age <b>{quoteAge}</b></span>
          </div>
        </article>;
      })}
    </div>
    <p className="advisory-footnote">Market odds are not model probabilities. Coinbase is comparison data only.</p>
  </section>;
}