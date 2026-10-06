import { createHash } from "node:crypto";
import {
  WATERX_RESEARCH_POLICY as POLICY,
  WATERX_RESEARCH_CONFIG as CONFIG,
  type ResearchChoice, type ResearchComparison, type ResearchEvidence,
  type ResearchInterval, type ResearchModelEstimate, type ResearchSide,
} from "../../shared/waterx-research";

export const BASELINE_ARTIFACT_DIGEST = `sha256:${createHash("sha256").update(JSON.stringify({
  algorithm:"waterx-market-probability-baseline",version:POLICY.version,
  side:"UP iff probabilityUp >= probabilityDown",calibration:"none",
})).digest("hex")}`;

export type ResearchObservation = {
  receivedAtMs?:number;
  providerSourceAtMs?:number|null;
  intervalMinutes: ResearchInterval;
  roundId: string;
  startMs: number;
  expiryMs: number;
  anchorPrice: number | null;
  anchorConfirmed: boolean;
  probabilityUp: number | null;
  probabilityDown: number | null;
  observedAt: string;
};
export type ResearchTick = { id: string; sourceAtMs: number; receivedAtMs: number; price: number };
export const unavailableComparison = (reason: string): ResearchComparison => ({
  source: "Coinbase", price: null, sourceAtMs: null, receivedAtMs: null,
  return1m: null, return3m: null, realizedVolatility: null,
  tickCount: 0, coverage: "unavailable", reason,
});

export function checkpointAt(interval: ResearchInterval, expiryMs: number, primaryLockSeconds = CONFIG.primaryLockSeconds[interval]) {
  return expiryMs - primaryLockSeconds * 1000;
}
export function comparisonFeatures(ticks: ResearchTick[], atMs: number, truncated = false): ResearchComparison {
  const start = atMs - POLICY.comparisonLookbackMs;
  const ordered = ticks.filter(t => Number.isFinite(t.price) && t.price > 0 &&
    Number.isFinite(t.sourceAtMs) && Number.isFinite(t.receivedAtMs) &&
    t.sourceAtMs >= start - POLICY.maxComparisonGapMs && t.sourceAtMs <= atMs &&
    t.receivedAtMs <= atMs)
    .sort((a,b) => a.sourceAtMs-b.sourceAtMs || a.id.localeCompare(b.id));
  if (!ordered.length) return unavailableComparison("No source-stamped, app-received Coinbase ticks before the decision.");
  const last = ordered.at(-1)!;
  const first = ordered[0];
  const gaps = ordered.some((t,i) => i > 0 &&
    t.sourceAtMs-ordered[i-1].sourceAtMs > POLICY.maxComparisonGapMs);
  const complete = !truncated && ordered.length >= 2 && first.sourceAtMs <= start + POLICY.maxComparisonGapMs &&
    atMs-last.sourceAtMs <= POLICY.maxComparisonGapMs && !gaps;
  const at = (target: number) => {
    const p = ordered.filter(t => t.sourceAtMs <= target).at(-1);
    return p && target-p.sourceAtMs <= POLICY.maxComparisonGapMs ? p : null;
  };
  const minute = at(atMs-60_000);
  const three = at(start);
  const returns = ordered.slice(1).map((t,i) => Math.log(t.price/ordered[i].price));
  const mean = returns.length ? returns.reduce((a,b)=>a+b,0)/returns.length : 0;
  return {
    source: "Coinbase", price: last.price, sourceAtMs: last.sourceAtMs,
    receivedAtMs: last.receivedAtMs, tickCount: ordered.length,
    return1m: minute ? last.price/minute.price-1 : null,
    return3m: three ? last.price/three.price-1 : null,
    realizedVolatility: returns.length ? Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/returns.length) : null,
    coverage: complete && minute && three ? "complete" : "partial",
    reason: complete && minute && three ? null
      : "Three-minute lookback is incomplete, truncated, stale, or has a source-time gap; baseline research remains possible.",
  };
}
export function researchEvidence(input: ResearchObservation, comparison: ResearchComparison): ResearchEvidence {
  const validReference=input.anchorPrice!==null&&Number.isFinite(input.anchorPrice)&&input.anchorPrice>0;
  return {
    reference: { price: validReference ? input.anchorPrice : null,
      quality: !validReference ? "unavailable" : input.anchorConfirmed ? "confirmed" : "provisional", source: "WaterX",
      appObservedAtMs: Date.parse(input.observedAt) },
    market: { probabilityUp: input.probabilityUp, probabilityDown: input.probabilityDown,
      appObservedAtMs: Date.parse(input.observedAt), timestampKind: "app-observed" },
    comparison,
    qualityFlags: [
      ...(!validReference ? ["REFERENCE_UNAVAILABLE"] : !input.anchorConfirmed ? ["PROVISIONAL_REFERENCE"] : []),
      ...(comparison.coverage !== "complete" ? ["COINBASE_LOOKBACK_INCOMPLETE"] : []),
    ],
    tieBreakApplied: false,
  };
}

/** Model selection is optional; invalid shadow/model input cannot suppress a valid baseline. */
export function freezeResearchDecision(input: ResearchObservation, nowMs: number,
  comparison: ResearchComparison, model?: ResearchModelEstimate & {
    intervalMinutes: ResearchInterval; roundId: string; forwardApproved: boolean;
  }, primaryLockSeconds = CONFIG.primaryLockSeconds[input.intervalMinutes]): ResearchChoice | null {
  if (![5,15].includes(input.intervalMinutes) || !input.roundId?.trim() ||
    !Number.isSafeInteger(input.startMs) || !Number.isSafeInteger(input.expiryMs) ||
    input.expiryMs-input.startMs !== input.intervalMinutes*60_000 ||
    input.startMs % 1000 !== 0 || input.expiryMs % 1000 !== 0)
    throw new Error("Research choice requires an exact valid WaterX identity and cadence.");
  const checkpoint = checkpointAt(input.intervalMinutes,input.expiryMs,primaryLockSeconds);
  if (nowMs < checkpoint) return null;
  const evidence = researchEvidence(input,comparison);
  if (nowMs > checkpoint+POLICY.checkpointGraceMs) evidence.qualityFlags.push("PRIMARY_LOCK_LATE_ACTUAL_TIMING");
  const fail = (code: string, reason: string): ResearchChoice => ({
    intervalMinutes: input.intervalMinutes, roundId: input.roundId, startMs: input.startMs,
    expiryMs: input.expiryMs, checkpointAtMs: checkpoint, decisionAtMs: nowMs,
    state: "NO_VALID_CHOICE", side: null, probabilityUp: null, probabilityDown: null,
    choiceSource: null, modelVersion: null, calibrationVersion: null, policyVersion: POLICY.version,
    noChoiceCode: code, noChoiceReason: reason, evidence,
    settlement: { state: "not-applicable", outcome: null, brier: null, logLoss: null,
      referenceDiscrepancyUsd: null, labelAvailableAt: null },
  });
  if (nowMs >= input.expiryMs)
    return fail("CHECKPOINT_MISSED", "No primary choice was frozen before expiry; expired predictions are never backfilled.");
  const observed = evidence.market.appObservedAtMs;
  if (!Number.isFinite(observed) || observed < input.startMs || observed > nowMs ||
    nowMs-observed > POLICY.maxOddsAgeMs)
    return fail("MARKET_ODDS_NOT_TIMELY", "WaterX odds are missing, future-dated, or older than 10 seconds at the decision.");
  const up = input.probabilityUp, down = input.probabilityDown;
  if (up === null || down === null || !Number.isFinite(up) || !Number.isFinite(down) ||
    up < 0 || up > 1 || down < 0 || down > 1 || Math.abs(up+down-1)>0.000001)
    return fail("MARKET_ODDS_INVALID", "Both fresh WaterX probabilities must be reported and sum to one; a missing side is never invented.");
  const modelValid = model?.status === "available" && model.forwardApproved &&
    model.intervalMinutes === input.intervalMinutes && model.roundId === input.roundId &&
    !!model.modelVersion && !!model.calibrationVersion && model.observedAtMs !== null &&
    model.observedAtMs <= nowMs && nowMs-model.observedAtMs <= POLICY.maxOddsAgeMs &&
    model.probabilityUp !== null && model.probabilityDown !== null &&
    Number.isFinite(model.probabilityUp) && model.probabilityUp >= 0 && model.probabilityUp <= 1 &&
    Number.isFinite(model.probabilityDown) && model.probabilityDown >= 0 && model.probabilityDown <= 1 &&
    Math.abs(model.probabilityUp+model.probabilityDown-1)<0.000001;
  const p = modelValid ? model.probabilityUp! : up;
  const q = modelValid ? model.probabilityDown! : down;
  evidence.tieBreakApplied = p === q;
  const side: ResearchSide = p >= q ? "UP" : "DOWN";
  return {
    intervalMinutes: input.intervalMinutes, roundId: input.roundId, startMs: input.startMs,
    expiryMs: input.expiryMs, checkpointAtMs: checkpoint, decisionAtMs: nowMs, state: "FROZEN",
    side, probabilityUp: p, probabilityDown: q,
    choiceSource: modelValid ? "bluewaterai_model" : "market_baseline",
    modelVersion: modelValid ? model.modelVersion : `market-baseline:${POLICY.version}`,
    calibrationVersion: modelValid ? model.calibrationVersion : null,
    policyVersion: POLICY.version, noChoiceCode: null, noChoiceReason: null,
    evidence:{...evidence,artifactDigest:modelValid ? null : BASELINE_ARTIFACT_DIGEST},
    settlement: { state: "pending", outcome: null, brier: null, logLoss: null,
      referenceDiscrepancyUsd: null, labelAvailableAt: null },
  };
}
export function researchScore(choice: ResearchChoice, outcome: ResearchSide, finalAnchor: number) {
  if (choice.state !== "FROZEN" || choice.probabilityUp === null || choice.evidence.market.probabilityUp === null)
    throw new Error("Only frozen choices with their matched baseline can be scored.");
  const y = outcome === "UP" ? 1 : 0;
  const loss = (p:number) => -Math.log(Math.max(1e-15,Math.min(1-1e-15,y ? p : 1-p)));
  return {
    correct: choice.side === outcome, brier: (choice.probabilityUp-y)**2,
    logLoss: loss(choice.probabilityUp),
    marketBaselineBrier: (choice.evidence.market.probabilityUp-y)**2,
    marketBaselineLogLoss: loss(choice.evidence.market.probabilityUp),
    probabilityBand: Math.min(9,Math.floor(choice.probabilityUp*10)),
    timeRemainingSeconds: (choice.expiryMs-choice.decisionAtMs)/1000,
    referenceQuality: choice.evidence.reference.quality,
    referenceDiscrepancyUsd: choice.evidence.reference.price === null ? null
      : finalAnchor-choice.evidence.reference.price,
  };
}