import { ArrowDownRight, ArrowUpRight, ShieldAlert } from "lucide-react";
import { assessAdvisoryCard, type AdvisoryPayload, type AdvisoryRoundIdentity } from "./advisory-contract";

type Props = {
  advisory: AdvisoryPayload | null;
  expectedIdentity: AdvisoryRoundIdentity | null;
  roundCurrent: boolean;
  quoteCurrent: boolean;
  locked: { up: boolean; down: boolean };
  nowMs: number;
  fixtureName?: string | null;
};

const probability = (value?: number | null) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
  ? `${(value * 100).toFixed(1)}%` : "Not validated";
const money = (value?: number | null) => typeof value === "number" && Number.isFinite(value)
  ? `${value < 0 ? "−" : "+"}$${Math.abs(value).toFixed(2)}` : "Not validated";

export function AdvisoryCards({ advisory, expectedIdentity, roundCurrent, quoteCurrent, locked, nowMs, fixtureName }: Props) {
  return <section className="advisory-desk" aria-label="UP and DOWN advisory assessments">
    <div className="advisory-heading">
      <div><span className="eyebrow">READ-ONLY RESEARCH</span><h2>Side assessments</h2></div>
      <span className="advisory-no-orders">NO EXECUTION</span>
    </div>
    {fixtureName && <div className="advisory-fixture-tag">DEVELOPMENT FIXTURE · {fixtureName.toUpperCase().replaceAll("-", " ")}</div>}
    <div className="advisory-card-list">
      {(["up", "down"] as const).map(side => {
        const assessment = assessAdvisoryCard({
          side, advisory, expectedIdentity, roundCurrent, quoteCurrent,
          sideLocked: locked[side], nowMs, fixtureMode: !!fixtureName,
        });
        const proof = advisory?.proof?.[side];
        const bound = proof?.model?.lowerBoundProbability;
        const netAtBound = typeof bound === "number" && typeof proof?.executionQuote?.netWinningReceiptUsd === "number" && typeof proof.executionQuote.totalCostUsd === "number"
          ? bound * proof.executionQuote.netWinningReceiptUsd - proof.executionQuote.totalCostUsd : null;
        const Icon = side === "up" ? ArrowUpRight : ArrowDownRight;
        return <article key={side} className={`advisory-card ${side}${assessment.qualified ? " qualified" : ""}`} aria-label={`${side.toUpperCase()} assessment: ${assessment.state}`}>
          <div className="advisory-card-top">
            <span className="advisory-direction"><Icon size={17} strokeWidth={2} />{side.toUpperCase()}</span>
            <span className={`advisory-state-chip${assessment.qualified ? " qualified" : ""}`}>{assessment.state.replaceAll("_", " ")}</span>
          </div>
          <p className="advisory-reason"><ShieldAlert size={13} aria-hidden="true" />{assessment.reason}</p>
          <div className="advisory-values">
            <span><small>PROBABILITY LOWER BOUND</small><b>{assessment.qualified ? probability(bound) : "Withheld"}</b></span>
            <span><small>NET AT LOWER BOUND · $5</small><b>{assessment.qualified ? money(netAtBound) : "Withheld"}</b></span>
          </div>
        </article>;
      })}
    </div>
    <p className="advisory-footnote">Directional color identifies the side, not its value. A highlight requires validated, fresh, round-matched evidence.</p>
  </section>;
}