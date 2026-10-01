/**
 * Central experimental policy for server and client proof validation.
 * Thresholds are not validated/promoted policy and live eligibility remains off.
 */
export const WATERX_VALUE_POLICY = {
  id: "waterx-value-policy-v1",
  status: "experimental-unvalidated",
  eligibilityEnabled: false,
  minQualifiedSamples: 100,
  maxProbabilityAgeMs: 10_000,
  maxQuoteAgeMs: 10_000,
  minimumConservativeEdgeUsd: 0.05,
  hysteresisExitEdgeReductionUsd: 0.02,
  hysteresisWindowMs: 5_000,
  highLikelihoodLowerBound: 0.8,
  favorableRiskRewardMinLowerBound: 0.55,
  favorableNetProfitToCost: 1,
  entryBufferMs: 10_000,
} as const;

export type WaterxSideState = "OBSERVE" | "HIGH_LIKELIHOOD" | "FAVORABLE_RISK_REWARD";