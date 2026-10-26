import type { ValueAudit } from "../../shared/waterx-ev-evidence";

function money(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "Not verified" :
    `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}
function pct(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "Not verified" : `${(100 * value).toFixed(1)}%`;
}

/** Research-only: NEVER compute a recommendation from indicative side odds. */
export function WaterxValueEvidencePanel({ audit }: { audit: ValueAudit | null }) {
  return <section className="bluewater-promotion panel" aria-label="Five-dollar position profitability evidence">
    <div className="bluewater-status-head">
      <div><span className="eyebrow">NET EDGE · $5 POSITION</span><h3>Profitability validation</h3></div>
      <strong>NO TRADE · UNVERIFIED EDGE</strong>
    </div>
    <p>Forecast accuracy and Brier score do not establish a tradeable edge. The current WaterX market price is not an independent win-probability estimate, and an indicative payout is not an executable quote.</p>
    {!audit ? <>
      <p className="bluewater-hold"><strong>No complete quote-matched profitability audit is available.</strong> Live net EV, break-even thresholds after fees, actual fillability and realized P&amp;L cannot be verified from research forecasts alone.</p>
      <p>Next proof required: save every decision (including NO TRADE), round-matched executable $5 receipts and fees, independently calibrated probabilities, verified WaterX settlements, and actual accepted fills. Compare against later unseen rounds and correlation-aware uncertainty.</p>
    </> : <>
      <div className="bluewater-training">
        <span>All captured opportunities <b>{audit.captured}</b></span>
        <span>NO TRADE recorded <b>{audit.noTradeCaptured}</b></span>
        <span>Signaled opportunities <b>{audit.signaled}</b></span>
        <span>Matched quotes + official outcomes <b>{audit.matchedVerifiedQuoteAndOutcome}</b></span>
        <span>Unmatched or invalid signals <b>{audit.missingOrInvalidEvidence}</b></span>
        <span>Duplicate identities <b>{audit.duplicateRoundKeys}</b></span>
        <span>Historical win rate <b>{pct(audit.observedWinRate)}</b></span>
        <span>Wilson 95% lower · iid assumption <b>{pct(audit.wilson95AssumingIndependent?.lower ?? null)}</b></span>
        <span>Average quoted break-even <b>{pct(audit.meanQuoteBreakEvenProbability)}</b></span>
        <span>Mean model-implied EV at quote <b>{money(audit.meanModelExpectedNetUsd)}</b></span>
        <span>Quote-matched counterfactual net <b>{money(audit.quoteMatchedCounterfactualNetUsd)}</b></span>
      </div>
      <p className="bluewater-hold">Quote-matched returns are simulated and do not prove a fill. These aggregates are research diagnostics, not a claim of profitability.</p>
      <ul>{audit.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>
    </>}
    <p className="bluewater-disclaimer">The $1–$2 target is profit on a winning $5 position, not the expected profit per prediction. Actual expected profit must account for the full losing stake and complete execution costs. No trading authority is granted here.</p>
  </section>;
}
