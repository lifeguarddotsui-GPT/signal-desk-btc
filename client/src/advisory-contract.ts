import { WATERX_VALUE_POLICY } from "../../shared/waterx-value-policy";
import { dataHealthReason, type WaterxDataHealth } from "../../shared/waterx-data-health";

export type AdvisoryState = "OBSERVE" | "HIGH_LIKELIHOOD" | "FAVORABLE_RISK_REWARD" |
  "UNAVAILABLE" | "LOCKED" | "EXPIRED" | string;

export type AdvisoryQuote = {
  grossReceiptIfWinIndicative?: number | null;
  breakEvenProbabilityBeforeFeesIndicative?: number | null;
  lossIfUnsuccessfulBeforeFeesIndicative?: number | null;
  calibratedProbability?: number | null;
  estimatedExpectedNetValue?: number | null;
  breakEvenProbability?: number | null;
  ageMs?: number | null;
  amountEnteredUsd?: number;
  totalCostUsd?: number | null;
  grossReceiptIfWinUsd?: number | null;
  netReceiptIfWinUsd?: number | null;
  netProfitIfWinUsd?: number | null;
  netReceiptIfLoseUsd?: number | null;
  lossIfUnsuccessfulUsd?: number | null;
  conservativeExpectedNetUsd?: number | null;
  uncertaintyMarginProbability?: number | null;
  expectedNetUncertaintyUsd?: number | null;
};

export type AdvisoryProof = {
  identity?: { marketId?: string; roundId?: string; intervalMinutes?: number; startMs?: number; expiryMs?: number };
  side?: "up" | "down" | string;
  reference?: {
    marketId?: string; roundId?: string; intervalMinutes?: number; startMs?: number; expiryMs?: number;
    sourceName?: string; confirmed?: boolean; price?: number; observedAtMs?: number;
  };
  executionQuote?: {
    kind?: string; quoteId?: string; marketId?: string;
    roundId?: string; intervalMinutes?: number; startMs?: number; expiryMs?: number;
    side?: "up" | "down" | string; amountUsd?: number; executable?: boolean;
    costVerified?: boolean; netReceiptVerified?: boolean; receiptVerified?: boolean;
    simulationVerified?: boolean;
    totalCostUsd?: number; netWinningReceiptUsd?: number; grossWinningReceiptUsd?: number;
    winningFeesUsd?: number; losingGrossReceiptUsd?: number; losingFeesUsd?: number;
    netProfitIfWinUsd?: number; lossIfLoseUsd?: number; conservativeExpectedNetValueUsd?: number;
    feesIncluded?: boolean; minimumsIncluded?: boolean; priceImpactIncluded?: boolean;
    quotedAtMs?: number; expiresAtMs?: number; synthetic?: boolean;
  };
  model?: {
    marketId?: string; roundId?: string; intervalMinutes?: number; side?: string;
    policyId?: string; policyEligibilityEnabled?: boolean;
    status?: string; independent?: boolean; heldoutForwardAccepted?: boolean;
    version?: string; qualifiedSampleCount?: number; evidenceCount?: number; evidenceId?: string;
    calibratedProbability?: number; lowerBoundProbability?: number; uncertaintyMargin?: number;
    calibration?: { method?: string; lowerBoundMethod?: string; verified?: boolean };
    probabilityAtMs?: number;
  };
  timing?: {
    cutoffVerified?: boolean; cutoffSource?: string; cutoffAtMs?: number;
    measuredAtMs?: number; measuredBufferMs?: number; requiredBufferMs?: number;
  };
  hysteresis?: {
    policyId?: string; entryState?: string; entryEvidenceId?: string; entryQuoteId?: string;
    enteredAtMs?: number; validUntilMs?: number;
    entryExpectedNetUsd?: number; entryUncertaintyUsd?: number; entryCalibratedProbability?: number;
    entryLowerBoundProbability?: number; entryNetProfitToCost?: number;
    entryGrossWinningReceiptUsd?: number; entryWinningFeesUsd?: number;
    entryLosingGrossReceiptUsd?: number; entryLosingFeesUsd?: number; entryTotalCostUsd?: number;
    entryQuotedAtMs?: number; entryQuoteExpiresAtMs?: number; entryProbabilityAtMs?: number;
    entryUncertaintyMargin?: number; entryQualifiedSampleCount?: number;
    identity?: { marketId?: string; roundId?: string; intervalMinutes?: number; startMs?: number; expiryMs?: number };
  };
  fixture?: boolean;
};

export type AdvisoryPayload = {
  state: AdvisoryState;
  reason: string;
  dataHealth?: WaterxDataHealth;
  amountEnteredUsd?: number;
  reasonCodes?: string[];
  identity: { marketId?: string; roundId: string; intervalMinutes: number; startMs: number; expiryMs: number } | null;
  sides: { up: { state?: string; reason?: string; quote: AdvisoryQuote }; down: { state?: string; reason?: string; quote: AdvisoryQuote } };
  proof?: { up?: AdvisoryProof | null; down?: AdvisoryProof | null } | null;
};

export type AdvisoryRoundIdentity = {
  marketId?: string;
  roundId: string;
  intervalMinutes: number;
  startMs: number;
  expiryMs: number;
};

export type AdvisoryGateInput = {
  side: "up" | "down";
  advisory: AdvisoryPayload | null;
  expectedIdentity: AdvisoryRoundIdentity | null;
  roundCurrent: boolean;
  quoteCurrent: boolean;
  sideLocked: boolean;
  nowMs: number;
  dataHealth?: WaterxDataHealth;
  fixtureMode?: boolean;
};

export type AdvisoryCardAssessment = {
  state: string;
  classification: "OBSERVE" | "HIGH_LIKELIHOOD" | "FAVORABLE_RISK_REWARD";
  reason: string;
  qualified: boolean;
  quote: AdvisoryQuote | null;
  modelAvailable: boolean;
  quoteAvailable: boolean;
  model: null | {
    calibratedProbability: number; lowerBoundProbability: number; uncertaintyMargin: number;
    sampleCount: number; modelVersion: string; probabilityAtMs: number;
  };
  economics: null | {
    totalCostUsd: number; grossReceiptIfWinUsd: number; netReceiptIfWinUsd: number;
    netProfitIfWinUsd: number; netReceiptIfLoseUsd: number; lossIfUnsuccessfulUsd: number;
    breakEvenProbability: number; conservativeExpectedNetUsd: number | null;
    uncertaintyMarginProbability: number | null; expectedNetUncertaintyUsd: number | null;
  };
  calibratedProbability?: number;
  lowerBoundProbability?: number;
  sampleCount?: number;
  modelVersion?: string;
  probabilityAtMs?: number;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isProbability = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;

/** The client verifies proof and suppresses invalid server states; it never promotes a side. */
export function assessAdvisoryCard(input: AdvisoryGateInput): AdvisoryCardAssessment {
  const { side, advisory } = input;
  const quote = advisory?.sides?.[side]?.quote ?? null;
  const identity = advisory?.identity;
  const expected = input.expectedIdentity;
  const identityMatches = !!identity && !!expected && typeof expected.marketId === "string" &&
    expected.marketId.length > 0 && identity.marketId === expected.marketId &&
    identity.roundId === expected.roundId && identity.intervalMinutes === expected.intervalMinutes &&
    identity.startMs === expected.startMs && identity.expiryMs === expected.expiryMs &&
    expected.expiryMs - expected.startMs === expected.intervalMinutes * 60_000 &&
    expected.startMs <= input.nowMs && input.nowMs < expected.expiryMs;
  const observe = (reason: string, quoteValue = quote, details: Partial<AdvisoryCardAssessment> = {}): AdvisoryCardAssessment => ({
    state: "OBSERVE", classification: "OBSERVE", reason, qualified: false, quote: quoteValue,
    modelAvailable: false, quoteAvailable: false, model: null, economics: null, ...details,
  });
  const health = input.dataHealth ?? advisory?.dataHealth;
  if (health && health.primaryReason !== "CURRENT") return observe(dataHealthReason(health));
  if (!input.roundCurrent || !identityMatches)
    return observe(!input.roundCurrent ? "No verified active round; advisory withheld." : "Advisory identity does not match this round.");
  if (!advisory) return observe("Awaiting a matched advisory snapshot.", null);

  const claimedState = advisory.sides[side].state;
  const sideReason = advisory.sides[side].reason;
  const proof = advisory.proof?.[side];
  const execution = proof?.executionQuote;
  const model = proof?.model;
  const reference = proof?.reference;
  const timing = proof?.timing;
  const now = input.nowMs;
  const referenceValid = !!expected && !!identity && !!reference &&
    reference.marketId === identity.marketId && reference.roundId === expected.roundId &&
    reference.intervalMinutes === expected.intervalMinutes && reference.startMs === expected.startMs &&
    reference.expiryMs === expected.expiryMs &&
    reference.sourceName === "WaterX confirmed round reference" && reference.confirmed === true &&
    finite(reference.price) && reference.price > 0 &&
    finite(reference.observedAtMs) && reference.observedAtMs >= expected.startMs && reference.observedAtMs <= now;
  const quoteValid = !!expected && !!identity && !!execution && proof?.side === side &&
    proof.identity?.marketId === identity.marketId && proof.identity?.roundId === expected.roundId &&
    proof.identity?.intervalMinutes === expected.intervalMinutes && proof.identity?.startMs === expected.startMs &&
    proof.identity?.expiryMs === expected.expiryMs &&
    execution.marketId === identity.marketId && execution.roundId === expected.roundId &&
    (execution.kind === "certified-executable" || execution.kind === "accurate-simulation") &&
    typeof execution.quoteId === "string" && execution.quoteId.trim().length > 0 &&
    advisory.amountEnteredUsd === 5 && execution.intervalMinutes === expected.intervalMinutes &&
    execution.startMs === expected.startMs && execution.expiryMs === expected.expiryMs &&
    execution.side === side && execution.amountUsd === 5 &&
    (execution.kind === "certified-executable" ? execution.executable === true : execution.simulationVerified === true) &&
    execution.costVerified === true && execution.netReceiptVerified === true && execution.receiptVerified === true &&
    execution.feesIncluded === true && execution.minimumsIncluded === true && execution.priceImpactIncluded === true &&
    finite(execution.totalCostUsd) && execution.totalCostUsd === 5 &&
    finite(execution.grossWinningReceiptUsd) && finite(execution.winningFeesUsd) &&
    finite(execution.losingGrossReceiptUsd) && finite(execution.losingFeesUsd) &&
    execution.winningFeesUsd >= 0 && execution.losingFeesUsd >= 0 &&
    execution.grossWinningReceiptUsd >= execution.winningFeesUsd &&
    execution.losingGrossReceiptUsd >= execution.losingFeesUsd &&
    execution.netWinningReceiptUsd === execution.grossWinningReceiptUsd - execution.winningFeesUsd &&
    finite(execution.quotedAtMs) && execution.quotedAtMs >= expected.startMs &&
    execution.quotedAtMs <= now && now - execution.quotedAtMs <= WATERX_VALUE_POLICY.maxQuoteAgeMs &&
    finite(execution.expiresAtMs) && now < execution.expiresAtMs &&
    execution.expiresAtMs <= expected.expiryMs && execution.expiresAtMs > execution.quotedAtMs &&
    (input.fixtureMode ? proof.fixture === true && execution.synthetic === true : proof.fixture !== true && execution.synthetic !== true);
  const modelValid = !!expected && !!identity && !!model &&
    (input.fixtureMode ? proof?.fixture === true : proof?.fixture !== true && execution?.synthetic !== true) &&
    proof?.side === side && proof.identity?.marketId === identity.marketId &&
    proof.identity?.roundId === expected.roundId && proof.identity?.intervalMinutes === expected.intervalMinutes &&
    proof.identity?.startMs === expected.startMs && proof.identity?.expiryMs === expected.expiryMs &&
    model.marketId === identity.marketId && model.roundId === expected.roundId &&
    model.intervalMinutes === expected.intervalMinutes && model.side === side &&
    model.status === "promoted" && model.independent === true && model.heldoutForwardAccepted === true &&
    typeof model.version === "string" && model.version.trim().length > 0 &&
    Number.isInteger(model.qualifiedSampleCount) &&
    (model.qualifiedSampleCount ?? 0) >= WATERX_VALUE_POLICY.minQualifiedSamples &&
    typeof model.evidenceId === "string" && model.evidenceId.trim().length > 0 &&
    isProbability(model.calibratedProbability) && isProbability(model.lowerBoundProbability) &&
    model.lowerBoundProbability <= model.calibratedProbability &&
    finite(model.uncertaintyMargin) && model.uncertaintyMargin >= 0 &&
    model.calibratedProbability - model.lowerBoundProbability + 1e-9 >= model.uncertaintyMargin &&
    model.calibration?.verified === true && typeof model.calibration.method === "string" &&
    model.calibration.method.trim().length > 0 &&
    typeof model.calibration.lowerBoundMethod === "string" && model.calibration.lowerBoundMethod.trim().length > 0 &&
    finite(model.probabilityAtMs) && model.probabilityAtMs >= expected.startMs &&
    model.probabilityAtMs <= now && now - model.probabilityAtMs <= WATERX_VALUE_POLICY.maxProbabilityAgeMs;
  const policyValid = !!model && model.policyId === WATERX_VALUE_POLICY.id &&
    (WATERX_VALUE_POLICY.eligibilityEnabled && model.policyEligibilityEnabled === true ||
      input.fixtureMode === true && proof?.fixture === true && execution?.synthetic === true);
  const timingValid = !!expected && timing?.cutoffVerified === true &&
    typeof timing.cutoffSource === "string" && timing.cutoffSource.trim().length > 0 &&
    finite(timing.cutoffAtMs) && finite(timing.measuredAtMs) && finite(timing.requiredBufferMs) &&
    finite(execution?.quotedAtMs) && timing.cutoffAtMs > now && timing.cutoffAtMs <= expected.expiryMs &&
    timing.measuredAtMs >= execution.quotedAtMs && timing.measuredAtMs <= now &&
    timing.requiredBufferMs >= WATERX_VALUE_POLICY.entryBufferMs &&
    timing.cutoffAtMs - now >= timing.requiredBufferMs &&
    timing.cutoffAtMs - timing.measuredAtMs >= timing.requiredBufferMs &&
    finite(timing.measuredBufferMs) &&
    Math.abs(timing.measuredBufferMs - (timing.cutoffAtMs - timing.measuredAtMs)) <= 1_000;
  const netWin = execution && finite(execution.grossWinningReceiptUsd) && finite(execution.winningFeesUsd)
    ? execution.grossWinningReceiptUsd - execution.winningFeesUsd : NaN;
  const netLose = execution && finite(execution.losingGrossReceiptUsd) && finite(execution.losingFeesUsd)
    ? execution.losingGrossReceiptUsd - execution.losingFeesUsd : NaN;
  const expectedNet = modelValid && execution && finite(netWin) && finite(netLose)
    ? model!.lowerBoundProbability! * netWin + (1 - model!.lowerBoundProbability!) * netLose - execution.totalCostUsd!
    : NaN;
  const uncertaintyUsd = modelValid && finite(netWin) && finite(netLose)
    ? model!.uncertaintyMargin! * Math.abs(netWin - netLose) : NaN;
  const modelDetails = modelValid ? {
    calibratedProbability: model!.calibratedProbability!, lowerBoundProbability: model!.lowerBoundProbability!,
    uncertaintyMargin: model!.uncertaintyMargin!, sampleCount: model!.qualifiedSampleCount!,
    modelVersion: model!.version!, probabilityAtMs: model!.probabilityAtMs!,
  } : null;
  const economics = quoteValid && execution && finite(netWin) && finite(netLose) && netWin > netLose
    ? {
      totalCostUsd: execution.totalCostUsd!, grossReceiptIfWinUsd: execution.grossWinningReceiptUsd!,
      netReceiptIfWinUsd: netWin, netProfitIfWinUsd: netWin - execution.totalCostUsd!,
      netReceiptIfLoseUsd: netLose, lossIfUnsuccessfulUsd: Math.max(0, execution.totalCostUsd! - netLose),
      breakEvenProbability: (execution.totalCostUsd! - netLose) / (netWin - netLose),
      conservativeExpectedNetUsd: modelValid && finite(expectedNet) ? expectedNet : null,
      uncertaintyMarginProbability: modelValid ? model!.uncertaintyMargin! : null,
      expectedNetUncertaintyUsd: modelValid && finite(uncertaintyUsd) ? uncertaintyUsd : null,
    } : null;
  const details: Partial<AdvisoryCardAssessment> = {
    modelAvailable: modelValid, quoteAvailable: quoteValid, model: modelDetails, economics,
    calibratedProbability: modelDetails?.calibratedProbability,
    lowerBoundProbability: modelDetails?.lowerBoundProbability, sampleCount: modelDetails?.sampleCount,
    modelVersion: modelDetails?.modelVersion, probabilityAtMs: modelDetails?.probabilityAtMs,
  };
  const riskRewardRatio = (netWin - 5) / 5;
  const strictEdge = finite(expectedNet) &&
    expectedNet > WATERX_VALUE_POLICY.minimumConservativeEdgeUsd + uncertaintyUsd;
  const hysteresis = proof?.hysteresis;
  const entryNetWin = hysteresis && finite(hysteresis.entryGrossWinningReceiptUsd) &&
    finite(hysteresis.entryWinningFeesUsd)
    ? hysteresis.entryGrossWinningReceiptUsd - hysteresis.entryWinningFeesUsd : NaN;
  const entryNetLose = hysteresis && finite(hysteresis.entryLosingGrossReceiptUsd) &&
    finite(hysteresis.entryLosingFeesUsd)
    ? hysteresis.entryLosingGrossReceiptUsd - hysteresis.entryLosingFeesUsd : NaN;
  const entryExpectedNet = hysteresis && finite(hysteresis.entryLowerBoundProbability) &&
    finite(hysteresis.entryTotalCostUsd) && finite(entryNetWin) && finite(entryNetLose)
    ? hysteresis.entryLowerBoundProbability * entryNetWin +
      (1 - hysteresis.entryLowerBoundProbability) * entryNetLose - hysteresis.entryTotalCostUsd : NaN;
  const entryUncertaintyUsd = hysteresis && finite(hysteresis.entryUncertaintyMargin) &&
    finite(entryNetWin) && finite(entryNetLose)
    ? hysteresis.entryUncertaintyMargin * Math.abs(entryNetWin - entryNetLose) : NaN;
  const hysteresisValid = !!hysteresis && !!hysteresis.identity && !!identity && !!model && !!execution &&
    hysteresis.policyId === WATERX_VALUE_POLICY.id && hysteresis.entryState === claimedState &&
    typeof hysteresis.entryEvidenceId === "string" && hysteresis.entryEvidenceId.trim().length > 0 &&
    typeof hysteresis.entryQuoteId === "string" && hysteresis.entryQuoteId.trim().length > 0 &&
    finite(hysteresis.enteredAtMs) && finite(hysteresis.validUntilMs) &&
    hysteresis.enteredAtMs <= now && now < hysteresis.validUntilMs &&
    hysteresis.validUntilMs === hysteresis.enteredAtMs + WATERX_VALUE_POLICY.hysteresisWindowMs &&
    finite(hysteresis.entryExpectedNetUsd) && finite(hysteresis.entryUncertaintyUsd) &&
    isProbability(hysteresis.entryLowerBoundProbability) &&
    isProbability(hysteresis.entryCalibratedProbability) &&
    hysteresis.entryLowerBoundProbability <= hysteresis.entryCalibratedProbability &&
    finite(hysteresis.entryUncertaintyMargin) && hysteresis.entryUncertaintyMargin >= 0 &&
    hysteresis.entryCalibratedProbability - hysteresis.entryLowerBoundProbability + 1e-9 >= hysteresis.entryUncertaintyMargin &&
    hysteresis.entryExpectedNetUsd === entryExpectedNet && hysteresis.entryUncertaintyUsd === entryUncertaintyUsd &&
    hysteresis.entryExpectedNetUsd > WATERX_VALUE_POLICY.minimumConservativeEdgeUsd + hysteresis.entryUncertaintyUsd &&
    finite(hysteresis.entryLowerBoundProbability) && finite(hysteresis.entryNetProfitToCost) &&
    finite(hysteresis.entryTotalCostUsd) && hysteresis.entryTotalCostUsd === 5 &&
    finite(hysteresis.entryGrossWinningReceiptUsd) && finite(hysteresis.entryWinningFeesUsd) &&
    finite(hysteresis.entryLosingGrossReceiptUsd) && finite(hysteresis.entryLosingFeesUsd) &&
    hysteresis.entryWinningFeesUsd >= 0 && hysteresis.entryLosingFeesUsd >= 0 &&
    hysteresis.entryGrossWinningReceiptUsd >= hysteresis.entryWinningFeesUsd &&
    hysteresis.entryLosingGrossReceiptUsd >= hysteresis.entryLosingFeesUsd &&
    entryNetWin > entryNetLose &&
    finite(hysteresis.entryQuotedAtMs) && finite(hysteresis.entryQuoteExpiresAtMs) &&
    hysteresis.entryQuotedAtMs >= expected!.startMs && hysteresis.entryQuotedAtMs <= hysteresis.enteredAtMs &&
    hysteresis.enteredAtMs < hysteresis.entryQuoteExpiresAtMs &&
    hysteresis.entryQuoteExpiresAtMs <= expected!.expiryMs &&
    hysteresis.enteredAtMs - hysteresis.entryQuotedAtMs <= WATERX_VALUE_POLICY.maxQuoteAgeMs &&
    finite(hysteresis.entryProbabilityAtMs) && hysteresis.entryProbabilityAtMs >= expected!.startMs &&
    hysteresis.entryProbabilityAtMs <= hysteresis.enteredAtMs &&
    hysteresis.enteredAtMs - hysteresis.entryProbabilityAtMs <= WATERX_VALUE_POLICY.maxProbabilityAgeMs &&
    Number.isInteger(hysteresis.entryQualifiedSampleCount) &&
    (hysteresis.entryQualifiedSampleCount ?? 0) >= WATERX_VALUE_POLICY.minQualifiedSamples &&
    Math.abs(hysteresis.entryNetProfitToCost - (entryNetWin - 5) / 5) <= 1e-9 &&
    (claimedState === "HIGH_LIKELIHOOD"
      ? hysteresis.entryLowerBoundProbability >= WATERX_VALUE_POLICY.highLikelihoodLowerBound &&
        hysteresis.entryNetProfitToCost < WATERX_VALUE_POLICY.favorableNetProfitToCost
      : claimedState === "FAVORABLE_RISK_REWARD" &&
        hysteresis.entryLowerBoundProbability >= WATERX_VALUE_POLICY.favorableRiskRewardMinLowerBound &&
        hysteresis.entryNetProfitToCost >= WATERX_VALUE_POLICY.favorableNetProfitToCost) &&
    hysteresis.identity?.marketId === identity.marketId && hysteresis.identity.roundId === expected?.roundId &&
    hysteresis.identity.intervalMinutes === expected?.intervalMinutes &&
    hysteresis.identity.startMs === expected?.startMs && hysteresis.identity.expiryMs === expected?.expiryMs;
  const softEdge = hysteresisValid && finite(expectedNet) &&
    expectedNet > WATERX_VALUE_POLICY.minimumConservativeEdgeUsd -
      WATERX_VALUE_POLICY.hysteresisExitEdgeReductionUsd + uncertaintyUsd;
  const categoryValid = !!model && (claimedState === "HIGH_LIKELIHOOD"
    ? model.lowerBoundProbability! >= WATERX_VALUE_POLICY.highLikelihoodLowerBound &&
      riskRewardRatio < WATERX_VALUE_POLICY.favorableNetProfitToCost
    : claimedState === "FAVORABLE_RISK_REWARD" &&
      model.lowerBoundProbability! >= WATERX_VALUE_POLICY.favorableRiskRewardMinLowerBound &&
      riskRewardRatio >= WATERX_VALUE_POLICY.favorableNetProfitToCost);
  const economicStateMatches = (strictEdge || softEdge) && categoryValid &&
    execution?.netProfitIfWinUsd === netWin - 5 &&
    execution.lossIfLoseUsd === Math.max(0, 5 - netLose) && netWin > netLose &&
    execution.conservativeExpectedNetValueUsd === expectedNet;
  if (input.sideLocked) return observe("This side is locked; no current quote is available.", quote, details);
  if (!referenceValid) return observe("Confirmed round-matched WaterX reference is unavailable.", quote, details);
  if (claimedState !== "HIGH_LIKELIHOOD" && claimedState !== "FAVORABLE_RISK_REWARD")
    return observe(sideReason || advisory.reason || "No server-qualified opportunity state is present.", quote, details);
  if (!quoteValid || !modelValid || !policyValid || !timingValid || !economicStateMatches)
    return observe(!quoteValid ? "No verified, fresh, executable $5 all-in quote with round-matched receipt proof."
      : !modelValid ? "No promoted independent model with sufficient held-out calibration and sample evidence."
        : !policyValid ? "The central threshold policy is experimental and not enabled for live qualification."
          : !timingValid ? "Cutoff proof is missing, expired, or lacks the current remaining-time buffer."
            : "Conservative expected value does not clear the experimental edge policy.", quote, details);
  if (!input.quoteCurrent) return observe("Quote is stale or not verified.", quote, details);
  return {
    state: claimedState, classification: claimedState, reason: advisory.reason, qualified: true, quote,
    modelAvailable: true, quoteAvailable: true, model: modelDetails, economics,
    calibratedProbability: model!.calibratedProbability, lowerBoundProbability: model!.lowerBoundProbability,
    sampleCount: model!.qualifiedSampleCount, modelVersion: model!.version, probabilityAtMs: model!.probabilityAtMs,
  };
}