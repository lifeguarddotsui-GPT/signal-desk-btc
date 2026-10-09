import {dataHealthReason} from "../../shared/waterx-data-health";
import type { buildWaterxLivePayload } from "./service";
import type { WaterxInterval } from "./types";
import { WATERX_VALUE_POLICY, type WaterxSideState } from "../../shared/waterx-value-policy";

type Live = ReturnType<typeof buildWaterxLivePayload>;
export { WATERX_VALUE_POLICY } from "../../shared/waterx-value-policy";
type Direction = "up" | "down";
const hysteresisStates = new Map<string, {
  state: WaterxSideState; interval: number; roundId: string; expiryMs: number;
  enteredAtMs: number; entryEvidenceId: string; entryQuoteId: string;
  entryExpectedNetUsd: number; entryUncertaintyUsd: number; entryLowerBoundProbability: number;
  entryCalibratedProbability: number; entryNetProfitToCost: number;
  entryGrossWinningReceiptUsd: number; entryWinningFeesUsd: number;
  entryLosingGrossReceiptUsd: number; entryLosingFeesUsd: number; entryTotalCostUsd: number;
  entryQuotedAtMs: number; entryQuoteExpiresAtMs: number; entryProbabilityAtMs: number;
  entryUncertaintyMargin: number; entryQualifiedSampleCount: number;
}>();

export type WaterxEvidence = {
  identity: { marketId: string; roundId: string; intervalMinutes: number; startMs: number; expiryMs: number };
  side: Direction;
  reference: {
    marketId: string; roundId: string; intervalMinutes: number; startMs: number; expiryMs: number;
    sourceName: "WaterX confirmed round reference"; confirmed: boolean; price: number; observedAtMs: number;
  };
  quote: {
    kind: "certified-executable" | "accurate-simulation";
    amountUsd: number;
    allInCostUsd: number;
    grossWinningReceiptUsd: number;
    winningFeesUsd: number;
    losingGrossReceiptUsd: number;
    losingFeesUsd: number;
    feesIncluded: boolean;
    minimumsIncluded: boolean;
    priceImpactIncluded: boolean;
    receiptVerified: boolean;
    executable?: boolean;
    simulationVerified?: boolean;
    quoteId: string;
    quotedAtMs: number;
    expiresAtMs: number;
    synthetic?: boolean;
  };
  model: {
    marketId: string;
    roundId: string;
    intervalMinutes: number;
    side: Direction;
    policyId: string;
    policyEligibilityEnabled: boolean;
    status: "promoted" | "shadow";
    independent: boolean;
    heldoutForwardAccepted: boolean;
    version: string;
    evidenceId: string;
    qualifiedSampleCount: number;
    calibratedProbability: number;
    lowerBoundProbability: number;
    uncertaintyMargin: number;
    calibration: { method: string; lowerBoundMethod: string; verified: boolean };
    probabilityAtMs: number;
  };
  timing: { cutoffVerified: boolean; cutoffSource: string; cutoffAtMs: number; measuredAtMs: number; requiredBufferMs: number };
  fixture?: boolean;
};

export type WaterxEconomics = {
  totalCostUsd: number;
  grossReceiptIfWinUsd: number;
  netReceiptIfWinUsd: number;
  netProfitIfWinUsd: number;
  netReceiptIfLoseUsd: number;
  lossIfUnsuccessfulUsd: number;
  breakEvenProbability: number;
  conservativeExpectedNetUsd: number;
  uncertaintyMarginProbability: number;
  expectedNetUncertaintyUsd: number;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const probability = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;

/** Pure, conservative assessment. A model flag alone is insufficient: all
 * round, quote, cost, calibration, forward-evaluation and timing evidence is checked. */
export function assessWaterxEvidence(
  evidence: WaterxEvidence,
  expected: WaterxEvidence["identity"],
  nowMs: number,
  fixtureMode = false,
): { state: WaterxSideState; reason: string; economics: WaterxEconomics | null } {
  const { quote, model, timing, identity, reference } = evidence;
  const identityValid = identity.marketId === expected.marketId && identity.roundId === expected.roundId &&
    identity.intervalMinutes === expected.intervalMinutes && identity.startMs === expected.startMs &&
    identity.expiryMs === expected.expiryMs && identity.expiryMs - identity.startMs === identity.intervalMinutes * 60_000 &&
    identity.startMs <= nowMs && nowMs < identity.expiryMs;
  if (!identityValid) return { state: "OBSERVE", reason: "Evidence does not match the active market round.", economics: null };
  if (reference.marketId !== expected.marketId || reference.roundId !== expected.roundId ||
      reference.intervalMinutes !== expected.intervalMinutes || reference.startMs !== expected.startMs ||
      reference.expiryMs !== expected.expiryMs || reference.sourceName !== "WaterX confirmed round reference" ||
      reference.confirmed !== true || !finite(reference.price) || reference.price <= 0 ||
      !finite(reference.observedAtMs) || reference.observedAtMs < expected.startMs ||
      reference.observedAtMs > nowMs)
    return { state: "OBSERVE", reason: "Confirmed round-matched WaterX reference is unavailable.", economics: null };
  if ((evidence.fixture === true || quote.synthetic === true) && !fixtureMode ||
      fixtureMode && (evidence.fixture !== true || quote.synthetic !== true))
    return { state: "OBSERVE", reason: "Synthetic evidence is permitted only in an explicit test fixture.", economics: null };
  if (!quote.quoteId || !["certified-executable", "accurate-simulation"].includes(quote.kind) ||
      (quote.kind === "certified-executable" ? quote.executable !== true : quote.simulationVerified !== true) ||
      quote.amountUsd !== 5 || quote.allInCostUsd !== 5 || quote.feesIncluded !== true ||
      quote.minimumsIncluded !== true || quote.priceImpactIncluded !== true || quote.receiptVerified !== true ||
      !finite(quote.grossWinningReceiptUsd) || quote.grossWinningReceiptUsd < 0 ||
      !finite(quote.winningFeesUsd) || quote.winningFeesUsd < 0 ||
      !finite(quote.losingGrossReceiptUsd) || quote.losingGrossReceiptUsd < 0 ||
      !finite(quote.losingFeesUsd) || quote.losingFeesUsd < 0 ||
      !finite(quote.quotedAtMs) || quote.quotedAtMs < expected.startMs ||
      !finite(quote.expiresAtMs) || quote.expiresAtMs <= quote.quotedAtMs ||
      quote.quotedAtMs > nowMs || nowMs >= quote.expiresAtMs || quote.expiresAtMs > expected.expiryMs ||
      nowMs - quote.quotedAtMs > WATERX_VALUE_POLICY.maxQuoteAgeMs)
    return { state: "OBSERVE", reason: "No fresh, verified, round-matched $5 all-in quote and receipt proof.", economics: null };
  if (model.marketId !== expected.marketId || model.roundId !== expected.roundId ||
      model.intervalMinutes !== expected.intervalMinutes || model.side !== evidence.side ||
      model.policyId !== WATERX_VALUE_POLICY.id ||
      (!model.policyEligibilityEnabled && !(fixtureMode && evidence.fixture === true)) ||
      model.status !== "promoted" || !model.independent || !model.heldoutForwardAccepted ||
      !model.version?.trim() || !model.evidenceId?.trim() ||
      !Number.isInteger(model.qualifiedSampleCount) || model.qualifiedSampleCount < WATERX_VALUE_POLICY.minQualifiedSamples ||
      !model.calibration.verified || !model.calibration.method?.trim() || !model.calibration.lowerBoundMethod?.trim() ||
      !probability(model.calibratedProbability) || !probability(model.lowerBoundProbability) ||
      model.lowerBoundProbability > model.calibratedProbability ||
      !finite(model.uncertaintyMargin) || model.uncertaintyMargin < 0 ||
      model.calibratedProbability - model.lowerBoundProbability + 1e-9 < model.uncertaintyMargin ||
       !finite(model.probabilityAtMs) || model.probabilityAtMs < expected.startMs || model.probabilityAtMs > nowMs ||
      nowMs - model.probabilityAtMs > WATERX_VALUE_POLICY.maxProbabilityAgeMs)
    return { state: "OBSERVE", reason: "No fresh promoted independent model with sufficient held-out calibration evidence.", economics: null };
  if (!timing.cutoffVerified || !timing.cutoffSource?.trim() || !finite(timing.cutoffAtMs) ||
      !finite(timing.measuredAtMs) || !finite(timing.requiredBufferMs) ||
       timing.cutoffAtMs <= nowMs || timing.cutoffAtMs > expected.expiryMs ||
      timing.measuredAtMs < quote.quotedAtMs || timing.measuredAtMs > nowMs ||
       timing.requiredBufferMs < WATERX_VALUE_POLICY.entryBufferMs ||
       timing.cutoffAtMs - nowMs < timing.requiredBufferMs ||
       timing.cutoffAtMs - timing.measuredAtMs < timing.requiredBufferMs)
    return { state: "OBSERVE", reason: "Entry cutoff is unverified, passed, or lacks its measured safety buffer.", economics: null };

  const netWin = quote.grossWinningReceiptUsd - quote.winningFeesUsd;
  const netLose = quote.losingGrossReceiptUsd - quote.losingFeesUsd;
  if (netWin < 0 || netLose < 0 || netWin <= netLose)
    return { state: "OBSERVE", reason: "Verified win and loss receipts do not establish a positive binary reward.", economics: null };
  const p = model.lowerBoundProbability;
  const conservativeExpectedNetUsd = p * netWin + (1 - p) * netLose - quote.allInCostUsd;
  const expectedNetUncertaintyUsd = model.uncertaintyMargin * Math.abs(netWin - netLose);
  const economics: WaterxEconomics = {
    totalCostUsd: quote.allInCostUsd, grossReceiptIfWinUsd: quote.grossWinningReceiptUsd,
    netReceiptIfWinUsd: netWin, netProfitIfWinUsd: netWin - quote.allInCostUsd,
    netReceiptIfLoseUsd: netLose, lossIfUnsuccessfulUsd: Math.max(0, quote.allInCostUsd - netLose),
    breakEvenProbability: (quote.allInCostUsd - netLose) / (netWin - netLose),
    conservativeExpectedNetUsd, uncertaintyMarginProbability: model.uncertaintyMargin, expectedNetUncertaintyUsd,
  };
  if (!WATERX_VALUE_POLICY.eligibilityEnabled && !fixtureMode)
    return { state: "OBSERVE", reason: "The centralized opportunity policy is experimental and not enabled for live qualification.", economics };
  if (!(conservativeExpectedNetUsd > WATERX_VALUE_POLICY.minimumConservativeEdgeUsd + expectedNetUncertaintyUsd))
    return { state: "OBSERVE", reason: "Conservative expected value does not clear costs and measured uncertainty.", economics };
  const ratio = economics.netProfitIfWinUsd / economics.totalCostUsd;
  if (ratio >= WATERX_VALUE_POLICY.favorableNetProfitToCost &&
      p < WATERX_VALUE_POLICY.favorableRiskRewardMinLowerBound)
    return { state: "OBSERVE", reason: "Conservative probability lower bound is below the experimental favorable-value threshold.", economics };
  return {
    state: p >= WATERX_VALUE_POLICY.highLikelihoodLowerBound && ratio < WATERX_VALUE_POLICY.favorableNetProfitToCost
      ? "HIGH_LIKELIHOOD" : ratio >= WATERX_VALUE_POLICY.favorableNetProfitToCost
        ? "FAVORABLE_RISK_REWARD" : "OBSERVE",
    reason: "Promoted model, held-out calibration and verified $5 economics passed the experimental policy.",
    economics,
  };
}

/** Hysteresis is limited to the soft positive-edge threshold. The ordinary
 * assessment runs first, so stale proof, rollover, shadow models, or cutoff
 * failures can never inherit a prior glow. */
export function assessWaterxEvidenceWithHysteresis(
  evidence: WaterxEvidence,
  expected: WaterxEvidence["identity"],
  nowMs: number,
  fixtureMode = false,
  claimedPreviousState?: WaterxSideState,
): ReturnType<typeof assessWaterxEvidence> & { hysteresis?: WaterxHysteresisAttestation } {
  hysteresisStates.forEach((old, oldKey) => {
    if (old.expiryMs <= nowMs || nowMs >= old.enteredAtMs + WATERX_VALUE_POLICY.hysteresisWindowMs)
      hysteresisStates.delete(oldKey);
  });
  const assessment = assessWaterxEvidence(evidence, expected, nowMs, fixtureMode);
  const key = `${expected.marketId}:${expected.intervalMinutes}:${expected.roundId}:${expected.startMs}:${expected.expiryMs}:${evidence.side}`;
  if (assessment.state !== "OBSERVE") {
    hysteresisStates.set(key, {
      state: assessment.state, interval: expected.intervalMinutes, roundId: expected.roundId,
      expiryMs: expected.expiryMs, enteredAtMs: nowMs,
      entryEvidenceId: evidence.model.evidenceId, entryQuoteId: evidence.quote.quoteId,
      entryExpectedNetUsd: assessment.economics!.conservativeExpectedNetUsd,
      entryUncertaintyUsd: assessment.economics!.expectedNetUncertaintyUsd,
      entryLowerBoundProbability: evidence.model.lowerBoundProbability,
      entryCalibratedProbability: evidence.model.calibratedProbability,
      entryNetProfitToCost: assessment.economics!.netProfitIfWinUsd / assessment.economics!.totalCostUsd,
      entryGrossWinningReceiptUsd: evidence.quote.grossWinningReceiptUsd,
      entryWinningFeesUsd: evidence.quote.winningFeesUsd,
      entryLosingGrossReceiptUsd: evidence.quote.losingGrossReceiptUsd,
      entryLosingFeesUsd: evidence.quote.losingFeesUsd,
      entryTotalCostUsd: evidence.quote.allInCostUsd,
      entryQuotedAtMs: evidence.quote.quotedAtMs,
      entryQuoteExpiresAtMs: evidence.quote.expiresAtMs,
      entryProbabilityAtMs: evidence.model.probabilityAtMs,
      entryUncertaintyMargin: evidence.model.uncertaintyMargin,
      entryQualifiedSampleCount: evidence.model.qualifiedSampleCount,
    });
    return assessment;
  }
  const previous = hysteresisStates.get(key);
  const quote = evidence.quote;
  const netWin = quote.grossWinningReceiptUsd - quote.winningFeesUsd;
  const netLose = quote.losingGrossReceiptUsd - quote.losingFeesUsd;
  const ratio = (netWin - quote.allInCostUsd) / quote.allInCostUsd;
  const categoryStillMatches = previous?.state === "HIGH_LIKELIHOOD"
    ? evidence.model.lowerBoundProbability >= WATERX_VALUE_POLICY.highLikelihoodLowerBound &&
      ratio < WATERX_VALUE_POLICY.favorableNetProfitToCost
    : previous?.state === "FAVORABLE_RISK_REWARD"
      ? evidence.model.lowerBoundProbability >= WATERX_VALUE_POLICY.favorableRiskRewardMinLowerBound &&
        ratio >= WATERX_VALUE_POLICY.favorableNetProfitToCost
      : false;
  const validUntilMs = previous ? previous.enteredAtMs + WATERX_VALUE_POLICY.hysteresisWindowMs : 0;
  if (!previous || previous.interval !== expected.intervalMinutes || previous.roundId !== expected.roundId ||
      previous.expiryMs !== expected.expiryMs || nowMs >= expected.expiryMs ||
      nowMs >= validUntilMs || assessment.reason !== "Conservative expected value does not clear costs and measured uncertainty." ||
      !assessment.economics || !categoryStillMatches ||
      (claimedPreviousState !== undefined && claimedPreviousState !== previous.state) ||
      !(assessment.economics.conservativeExpectedNetUsd >
        WATERX_VALUE_POLICY.minimumConservativeEdgeUsd - WATERX_VALUE_POLICY.hysteresisExitEdgeReductionUsd +
         assessment.economics.expectedNetUncertaintyUsd)) {
    hysteresisStates.delete(key);
    return assessment;
  }
  return {
    ...assessment, state: previous.state,
    reason: "Retained briefly inside the experimental soft-edge hysteresis band.",
    hysteresis: {
      policyId: WATERX_VALUE_POLICY.id, entryState: previous.state,
      entryEvidenceId: previous.entryEvidenceId, entryQuoteId: previous.entryQuoteId,
      entryExpectedNetUsd: previous.entryExpectedNetUsd, entryUncertaintyUsd: previous.entryUncertaintyUsd,
      entryLowerBoundProbability: previous.entryLowerBoundProbability,
      entryCalibratedProbability: previous.entryCalibratedProbability,
      entryNetProfitToCost: previous.entryNetProfitToCost,
      entryGrossWinningReceiptUsd: previous.entryGrossWinningReceiptUsd,
      entryWinningFeesUsd: previous.entryWinningFeesUsd,
      entryLosingGrossReceiptUsd: previous.entryLosingGrossReceiptUsd,
      entryLosingFeesUsd: previous.entryLosingFeesUsd,
      entryTotalCostUsd: previous.entryTotalCostUsd,
      entryQuotedAtMs: previous.entryQuotedAtMs, entryQuoteExpiresAtMs: previous.entryQuoteExpiresAtMs,
      entryProbabilityAtMs: previous.entryProbabilityAtMs,
      entryUncertaintyMargin: previous.entryUncertaintyMargin,
      entryQualifiedSampleCount: previous.entryQualifiedSampleCount,
      enteredAtMs: previous.enteredAtMs, validUntilMs,
      identity: { marketId: expected.marketId, roundId: expected.roundId,
        intervalMinutes: expected.intervalMinutes, startMs: expected.startMs, expiryMs: expected.expiryMs },
    },
  };
}

export type WaterxHysteresisAttestation = {
  policyId: string;
  entryState: WaterxSideState;
  entryEvidenceId: string;
  entryQuoteId: string;
  enteredAtMs: number;
  validUntilMs: number;
  entryExpectedNetUsd: number;
  entryUncertaintyUsd: number;
  entryLowerBoundProbability: number;
  entryCalibratedProbability: number;
  entryNetProfitToCost: number;
  entryGrossWinningReceiptUsd: number;
  entryWinningFeesUsd: number;
  entryLosingGrossReceiptUsd: number;
  entryLosingFeesUsd: number;
  entryTotalCostUsd: number;
  entryQuotedAtMs: number;
  entryQuoteExpiresAtMs: number;
  entryProbabilityAtMs: number;
  entryUncertaintyMargin: number;
  entryQualifiedSampleCount: number;
  identity: WaterxEvidence["identity"];
};

/** Kept as pure arithmetic helper for independently verified binary outcomes. */
export function calculateVerifiedBinaryNet(calibratedProbability: number, netReceiptIfWin: number, totalCost: number) {
  if (!probability(calibratedProbability) || !finite(netReceiptIfWin) || netReceiptIfWin <= 0 ||
      !finite(totalCost) || totalCost < 0)
    throw new Error("Binary value inputs must be finite, with a positive net receipt and probability in [0,1].");
  return {
    breakEvenProbability: totalCost / netReceiptIfWin,
    expectedNet: calibratedProbability * netReceiptIfWin - totalCost,
    netProfitIfWin: netReceiptIfWin - totalCost,
    lossIfUnsuccessful: totalCost,
  };
}

/** One read-only research snapshot. Public WaterX prices are indicative only. */
export function buildWaterxAdvisory(live: Live, interval: WaterxInterval, amount: number, now = Date.now()) {
  if (!finite(amount) || amount !== 5)
    throw new Error("WaterX advisory economics are fixed to exactly $5 total spend per selected side.");
  if (!Number.isSafeInteger(now)) throw new Error("Invalid advisory time.");
  const round = live.intervalMinutes === interval ? live.round : null;
  const identity = round ? {
    provider: "WaterX" as const, marketId: round.marketId, marketSlug: round.marketSlug,
    intervalMinutes: interval, roundId: round.id, startMs: round.startMs, expiryMs: round.expiryMs,
  } : null;
  const validRound = live.status === "LIVE" && !!round && !!identity?.marketId &&
    Number.isSafeInteger(round.startMs) && Number.isSafeInteger(round.expiryMs) &&
    round.expiryMs - round.startMs === interval * 60_000 && round.startMs <= now && now < round.expiryMs;
  const priceReceipt=live.odds?.priceAsOf??live.odds?.asOf;
  const quoteAtMs = priceReceipt ? Date.parse(priceReceipt) : NaN;
  const quoteAgeMs = Number.isFinite(quoteAtMs) ? Math.max(0, now - quoteAtMs) : null;
  const quoteFresh = validRound && quoteAgeMs !== null && quoteAtMs >= round!.startMs &&
    quoteAtMs <= now + 1_000 && quoteAgeMs <= (interval === 5 ? 16_000 : 31_000) &&
    live.odds?.source === "WaterX public market probabilities and odds";
  const locked = validRound && live.availability.odds.status === "locked";
  const side = (direction: Direction) => {
    const availability = live.availability.odds[direction];
    const cents = quoteFresh ? live.odds?.[direction === "up" ? "upPriceCents" : "downPriceCents"] : null;
    const marketProbability = quoteFresh ? live.odds?.[direction] : null;
    const priceAvailable = availability.side === "reported" && availability.price === "reported" &&
      availability.pricePositive && finite(cents) && cents > 0 && cents <= 100;
    const gross = priceAvailable ? 5 / (cents! / 100) : null;
    const reason = !validRound ? "No verified active WaterX round."
      : live.dataHealth && live.dataHealth.primaryReason!=="CURRENT" ? dataHealthReason(live.dataHealth)
      : locked ? "WaterX reports this side locked."
        : !quoteFresh ? "Indicative WaterX side price is stale or mismatched."
          : !priceAvailable ? availability.side === "locked" ? "WaterX reports this side locked."
            : availability.price !== "reported" ? `WaterX ${direction.toUpperCase()} indicative side price was not reported.`
              : "WaterX indicative side price is invalid or nonpositive."
          : "No promoted model or verified all-in $5 quote supports an opportunity.";
    return {
      direction, state: "OBSERVE" as const, reason,
      marketProbability: probability(marketProbability) && availability.probability === "available" ? marketProbability : null,
      calibratedProbability: null,
      quote: {
        source: "WaterX public side price" as const, timestampBasis: "app_observed_response" as const,
        asOf: quoteFresh ? live.odds!.asOf : null, ageMs: quoteFresh ? quoteAgeMs : null,
        expiresAt: null, executable: false as const, priceCents: priceAvailable ? cents : null,
        amountEnteredUsd: 5 as const, quantityIfWinIndicative: gross,
        estimatedTotalCost: null, estimatedFees: null, estimatedPriceImpact: null,
        grossReceiptIfWinIndicative: gross, netReceiptIfWin: null, netProfitIfWin: null,
        lossIfUnsuccessful: null, lossIfUnsuccessfulBeforeFeesIndicative: priceAvailable ? 5 : null,
        breakEvenProbability: null, breakEvenProbabilityBeforeFeesIndicative: priceAvailable ? cents! / 100 : null,
        estimatedExpectedNetValue: null, conservativeExpectedNetUsd: null, uncertaintyMargin: null,
        assumptions: "Indicative payout only. No verified executable/simulatable $5 quote, costs, receipts, promoted model, or cutoff proof.",
      },
    };
  };
  const up = side("up"), down = side("down");
  const hasQuote = up.quote.priceCents !== null || down.quote.priceCents !== null;
  const state = !round || !validRound
    ? live.status === "STALE" && /expired/i.test(live.reason) ? "EXPIRED" : "UNAVAILABLE"
    : locked ? "LOCKED" : "OBSERVE";
  const reasonCodes = state === "EXPIRED" ? ["ROUND_EXPIRED"] :
    !validRound ? [live.status === "UNAVAILABLE" ? "PROVIDER_UNAVAILABLE" : "COLLECTOR_STALLED"] :
    locked ? ["MARKET_LOCKED"] : !quoteFresh ? ["QUOTE_EXPIRED_OR_MISMATCHED"] :
    !hasQuote ? ["QUOTE_UNAVAILABLE"] :
    ["POLICY_UNVALIDATED", "MODEL_NOT_PROMOTED", "INDICATIVE_QUOTE", "FEES_UNVERIFIED", "ALL_IN_COST_UNVERIFIED", "ENTRY_CUTOFF_UNKNOWN"];
  return {
    protocol: "waterx-value-advisory-v1" as const, generatedAt: new Date(now).toISOString(),
    identity: validRound ? identity : null, tradingCutoffMs: null,
    reference: validRound ? { price: round!.referencePrice, status: round!.anchorConfirmed ? "reported" : "provisional" }
      : { price: null, status: "unavailable" },
    probability: { source: "WaterX market-derived, not an independent forecast" as const, version: null,
      asOf: quoteFresh ? live.odds!.asOf : null, qualification: "unvalidated" as const,
      uncertainty: "No promoted model or validated interval- and horizon-specific uncertainty bound." },
    amountEnteredUsd: 5 as const, requestedAmountUsd: amount, sides: { up, down }, state, reasonCodes,
    reason: state === "OBSERVE"
      ? "Observe: public side prices are indicative; no promoted model or verified all-in $5 quote supports a value state."
      : state === "LOCKED" ? "WaterX reports this market locked."
      : state === "EXPIRED" ? "Round expired; previous quotes are not eligible."
      : live.reason || "Current round and quote evidence is unavailable.",
    action: "HOLD" as const,
  };
}