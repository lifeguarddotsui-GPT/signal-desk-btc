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

type AssessmentExtension = {
  classification?: string;
  sampleCount?: number | null;
  reliability?: number | string | null;
  reliabilityPercent?: number | null;
  reliabilitySampleCount?: number | null;
};
const validNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const dollars = (value: unknown) => validNumber(value)
  ? `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "Withheld";
const readable = (value: string) => value.toLowerCase().replaceAll("_", " ");
const age = (ms: number | undefined, now: number) => validNumber(ms) && ms <= now && ms >= 0
  ? `${Math.floor((now - ms) / 1000)}s` : "Withheld";
const observedAge = (stamp: string | undefined, now: number) => {
  if (!stamp) return "age not reported";
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? `${Math.max(0, Math.floor((now - ms) / 1000))}s ago` : "timestamp unavailable";
};

export function AdvisoryCards({ advisory, expectedIdentity, roundCurrent, quoteCurrent, locked, nowMs, fixtureName, marketOdds }: Props) {
  return <section className="advisory-desk" aria-label="UP and DOWN opportunity assessments">
    <div className="advisory-heading">
      <div><span className="eyebrow">READ-ONLY ASSESSMENT</span><h2>Opportunity check</h2></div>
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
        const extended = assessment as typeof assessment & AssessmentExtension;
        const classification = ["ASYMMETRIC_VALUE", "HIGH_LIKELIHOOD_VALUE", "OBSERVE"].includes(extended.classification || "")
          ? extended.classification! : "OBSERVE";
        const valued = assessment.qualified && classification !== "OBSERVE";
        const presentedClassification = valued ? classification : "OBSERVE";
        const proof = advisory?.proof?.[side];
        const execution = proof?.executionQuote;
        const model = proof?.model;
        const Icon = side === "up" ? ArrowUpRight : ArrowDownRight;
        const StatusIcon = valued ? ShieldCheck : ShieldAlert;
        const samples = validNumber(extended.sampleCount) ? extended.sampleCount
          : validNumber(extended.reliabilitySampleCount) ? extended.reliabilitySampleCount
            : validNumber(model?.evidenceCount) ? model.evidenceCount : null;
        const reliability = validNumber(extended.reliabilityPercent) ? `${extended.reliabilityPercent.toFixed(1)}%`
          : validNumber(extended.reliability) ? `${(extended.reliability <= 1 ? extended.reliability * 100 : extended.reliability).toFixed(1)}%`
            : typeof extended.reliability === "string" ? extended.reliability : "Withheld";
        const quoteAge = valued && validNumber(execution?.quotedAtMs) ? age(execution.quotedAtMs, nowMs) : "Withheld";
        return <article key={side} className={`advisory-card ${side} classification-${presentedClassification.toLowerCase()}`} aria-label={`${side.toUpperCase()} assessment: ${readable(presentedClassification)}`}>
          <div className="advisory-card-top">
            <span className="advisory-direction"><Icon size={17} aria-hidden="true" />{side.toUpperCase()}</span>
            <span className={`advisory-state-chip ${presentedClassification === "OBSERVE" ? "" : "qualified"}`}>
              <StatusIcon size={13} aria-hidden="true" />{readable(presentedClassification)}
            </span>
          </div>
          <div className="assessment-values">
            <span><small>WATERX MARKET</small><b>{marketOdds.current ? marketOdds[side] : "Unavailable"}</b><em>{marketOdds.current ? `${side === "up" ? marketOdds.upPrice : marketOdds.downPrice} side price` : "Side price unavailable"}</em></span>
            <span><small>MODEL RELIABILITY</small><b>{reliability}</b></span>
            <span><small>QUALIFIED SAMPLES</small><b>{samples == null ? "Withheld" : samples.toLocaleString()}</b></span>
          </div>
          <p className="advisory-reason"><ShieldAlert size={13} aria-hidden="true" />{assessment.reason || advisory?.reason || "No independently verified classification; observe."}</p>
          <div className="assessment-proof" aria-label={`${side.toUpperCase()} verified quote details`}>
            <span>Verified $5 cost <b>{valued ? dollars(execution?.totalCostUsd) : "Withheld"}</b></span>
            <span>Net winning receipt <b>{valued ? dollars(execution?.netWinningReceiptUsd) : "Withheld"}</b></span>
            <span>Verified quote age <b>{quoteAge}</b></span>
          </div>
        </article>;
      })}
    </div>
    <p className="advisory-footnote">WaterX probabilities describe the market, not BluewaterAI’s forecast. Coinbase is a comparison only; settlement uses the WaterX reference and Chainlink TWAP.</p>
  </section>;
}