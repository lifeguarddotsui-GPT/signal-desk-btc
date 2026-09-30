export type AdvisoryState =
  | "FAVORABLE_UP" | "FAVORABLE_DOWN" | "WAIT" | "HOLD" | "OBSERVE"
  | "UNAVAILABLE" | string;

export type AdvisoryQuote = {
  grossReceiptIfWinIndicative?: number | null;
  breakEvenProbabilityBeforeFeesIndicative?: number | null;
  lossIfUnsuccessfulBeforeFeesIndicative?: number | null;
  calibratedProbability?: number | null;
  estimatedExpectedNetValue?: number | null;
  breakEvenProbability?: number | null;
  ageMs?: number | null;
};

export type AdvisoryProof = {
  executionQuote?: {
    roundId?: string;
    intervalMinutes?: number;
    startMs?: number;
    expiryMs?: number;
    side?: "up" | "down" | string;
    amountUsd?: number;
    executable?: boolean;
    costVerified?: boolean;
    netReceiptVerified?: boolean;
    totalCostUsd?: number;
    netWinningReceiptUsd?: number;
    quotedAtMs?: number;
    expiresAtMs?: number;
    synthetic?: boolean;
  };
  model?: {
    qualified?: boolean;
    evidenceCount?: number;
    evidenceId?: string;
    calibratedProbability?: number;
    lowerBoundProbability?: number;
  };
  timing?: {
    cutoffVerified?: boolean;
    cutoffSource?: string;
    cutoffAtMs?: number;
    measuredAtMs?: number;
    measuredBufferMs?: number;
    requiredBufferMs?: number;
  };
};

export type AdvisoryPayload = {
  state: AdvisoryState;
  reason: string;
  amountEnteredUsd?: number;
  reasonCodes?: string[];
  identity: { roundId: string; intervalMinutes: number; startMs: number; expiryMs: number } | null;
  sides: { up: { quote: AdvisoryQuote }; down: { quote: AdvisoryQuote } };
  proof?: { up?: AdvisoryProof | null; down?: AdvisoryProof | null } | null;
};

export type AdvisoryRoundIdentity = {
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
  fixtureMode?: boolean;
};

export type AdvisoryCardAssessment = {
  state: string;
  reason: string;
  qualified: boolean;
  quote: AdvisoryQuote | null;
};

/** A direction is not a value judgment: only calibrated, current, identity-matched
 * favorable states can qualify for the restrained highlight. */
export function assessAdvisoryCard(input: AdvisoryGateInput): AdvisoryCardAssessment {
  const { side, advisory } = input;
  const quote = advisory?.sides?.[side]?.quote ?? null;
  const identity = advisory?.identity;
  const expected = input.expectedIdentity;
  const identityMatches = !!identity && !!expected &&
    identity.roundId === expected.roundId &&
    identity.intervalMinutes === expected.intervalMinutes &&
    identity.startMs === expected.startMs &&
    identity.expiryMs === expected.expiryMs;
  const favorable = advisory?.state === (side === "up" ? "FAVORABLE_UP" : "FAVORABLE_DOWN");
  if (!input.roundCurrent || !identityMatches)
    return { state: advisory?.state ?? "UNAVAILABLE", reason: !input.roundCurrent ? "No verified active round; advisory withheld." : "Advisory identity does not match this round.", qualified: false, quote };
  if (!advisory)
    return { state: "UNAVAILABLE", reason: "Awaiting a matched advisory snapshot.", qualified: false, quote: null };
  if (!input.quoteCurrent)
    return { state: advisory.state, reason: "Quote is stale or not verified; values withheld.", qualified: false, quote };
  if (input.sideLocked)
    return { state: advisory.state, reason: "This side is locked; no current quote is available.", qualified: false, quote };
  if (!favorable)
    return { state: advisory.state, reason: advisory.reason || "No favorable entry is validated.", qualified: false, quote };
  const proof = advisory.proof?.[side];
  const execution = proof?.executionQuote;
  const model = proof?.model;
  const timing = proof?.timing;
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const now = input.nowMs;
  const maxRoundIdentity = expected?.expiryMs;
  const quoteValid = execution?.roundId === expected?.roundId &&
    advisory.amountEnteredUsd === 5 &&
    execution.intervalMinutes === expected?.intervalMinutes &&
    execution.startMs === expected?.startMs &&
    execution.expiryMs === expected?.expiryMs &&
    execution.side === side && execution.amountUsd === 5 &&
    execution.executable === true && execution.costVerified === true &&
    execution.netReceiptVerified === true &&
    finite(execution.totalCostUsd) && execution.totalCostUsd > 0 &&
    finite(execution.netWinningReceiptUsd) && execution.netWinningReceiptUsd > execution.totalCostUsd &&
    finite(execution.quotedAtMs) && finite(execution.expiresAtMs) &&
    execution.quotedAtMs >= (expected?.startMs ?? Infinity) &&
    execution.quotedAtMs <= now && now < execution.expiresAtMs &&
    execution.expiresAtMs <= (expected?.expiryMs ?? -Infinity) &&
    execution.expiresAtMs > execution.quotedAtMs &&
    (input.fixtureMode ? execution.synthetic === true : execution.synthetic !== true);
  const modelValid = model?.qualified === true &&
    Number.isInteger(model.evidenceCount) && (model.evidenceCount ?? 0) > 0 &&
    typeof model.evidenceId === "string" && model.evidenceId.trim().length > 0 &&
    finite(model.calibratedProbability) && model.calibratedProbability >= 0 && model.calibratedProbability <= 1 &&
    finite(model.lowerBoundProbability) && model.lowerBoundProbability >= 0 &&
    model.lowerBoundProbability <= model.calibratedProbability && model.lowerBoundProbability <= 1;
  const timingValid = finite(now) && finite(maxRoundIdentity) &&
    timing?.cutoffVerified === true && typeof timing.cutoffSource === "string" && timing.cutoffSource.trim().length > 0 &&
    finite(timing?.cutoffAtMs) && finite(timing?.measuredAtMs) &&
    finite(timing?.measuredBufferMs) && finite(timing?.requiredBufferMs) &&
    finite(execution?.quotedAtMs) &&
    timing.cutoffAtMs > now && timing.cutoffAtMs <= maxRoundIdentity &&
    timing.measuredAtMs >= execution.quotedAtMs && timing.measuredAtMs <= now &&
    timing.measuredBufferMs >= timing.requiredBufferMs &&
    timing.requiredBufferMs >= 0 &&
    Math.abs(timing.measuredBufferMs - (timing.cutoffAtMs - timing.measuredAtMs)) <= 1_000;
  const economicallyPositive = quoteValid && modelValid &&
    model.lowerBoundProbability! * execution.netWinningReceiptUsd! > execution.totalCostUsd!;
  if (!quoteValid || !modelValid || !timingValid || !economicallyPositive)
    return { state: advisory.state, reason: !quoteValid ? "No verified, executable $5 quote with an unexpired, round-matched net-cost proof."
      : !modelValid ? "Model is not qualified or lacks a positive evidence-based probability lower bound."
        : !timingValid ? "Cutoff proof is missing, expired, or lacks the measured timing buffer."
          : "Evidence-based lower bound does not clear verified total cost.", qualified: false, quote };
  return { state: advisory.state, reason: advisory.reason, qualified: true, quote };
}