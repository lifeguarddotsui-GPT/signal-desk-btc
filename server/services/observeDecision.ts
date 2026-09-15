export interface ObserveFeatures {
  observedSeconds: number | null;
  netBuyingSui60s: string | null;
  netBuyingSui5m: string | null;
  distinctBuyingWallets5m: number | null;
  independentBuyerGroups5m: number | null;
  volumeSui5m: string | null;
  creatorConcentrationPct: number | null;
  topTenConcentrationPct: number | null;
  hasExecutableBuyQuote: boolean | null;
  hasExecutableFullExitQuote: boolean | null;
  roundTripLossPct: number | null;
  trendScore: number | null;
}

export interface ObservePolicy {
  version: string;
  minimumObservationSeconds: number;
  minimumNetBuyingSui: string;
  minimumDistinctWallets: number;
  minimumIndependentGroups: number;
  minimumVolumeSui: string;
  maximumCreatorConcentrationPct: number;
  maximumTopTenConcentrationPct: number;
  maximumRoundTripLossPct: number;
  minimumTrendScore: number;
}

export interface ObserveDecision {
  action: "HOLD_SUI" | "OBSERVE";
  eligible: false;
  mode: "OBSERVE";
  policyVersion: string;
  rejectionReasons: readonly string[];
  evaluatedAt: string;
}

export const DEFAULT_OBSERVE_POLICY: ObservePolicy = {
  version: "observe-v1",
  minimumObservationSeconds: 120,
  minimumNetBuyingSui: "0",
  minimumDistinctWallets: 15,
  minimumIndependentGroups: 10,
  minimumVolumeSui: "20",
  maximumCreatorConcentrationPct: 10,
  maximumTopTenConcentrationPct: 35,
  maximumRoundTripLossPct: 4,
  minimumTrendScore: 75,
};

function decimalAtLeast(value: string | null, minimum: string): boolean {
  if (value === null || !/^\d+(\.\d+)?$/.test(value) || !/^\d+(\.\d+)?$/.test(minimum)) return false;
  const [vInt, vFrac = ""] = value.split(".");
  const [mInt, mFrac = ""] = minimum.split(".");
  const width = Math.max(vFrac.length, mFrac.length);
  let scale = BigInt(1);
  for (let i = 0; i < width; i++) scale *= BigInt(10);
  const left = BigInt(vInt) * scale + BigInt(vFrac.padEnd(width, "0") || "0");
  const right = BigInt(mInt) * scale + BigInt(mFrac.padEnd(width, "0") || "0");
  return left >= right;
}

/** Pure, deterministic paper-mode gate. Missing critical evidence always blocks. */
export function evaluateObserveDecision(
  features: ObserveFeatures,
  policy: ObservePolicy = DEFAULT_OBSERVE_POLICY,
  now = new Date(),
): ObserveDecision {
  const rejectionReasons: string[] = [];
  if (features.observedSeconds === null || features.observedSeconds < policy.minimumObservationSeconds) rejectionReasons.push("OBSERVATION_WINDOW_INCOMPLETE");
  if (!decimalAtLeast(features.netBuyingSui60s, policy.minimumNetBuyingSui)) rejectionReasons.push("NET_BUYING_60S_UNKNOWN_OR_NONPOSITIVE");
  if (!decimalAtLeast(features.netBuyingSui5m, policy.minimumNetBuyingSui)) rejectionReasons.push("NET_BUYING_5M_UNKNOWN_OR_NONPOSITIVE");
  if (features.distinctBuyingWallets5m === null || features.distinctBuyingWallets5m < policy.minimumDistinctWallets) rejectionReasons.push("BUYER_COUNT_BELOW_MINIMUM_OR_UNKNOWN");
  if (features.independentBuyerGroups5m === null || features.independentBuyerGroups5m < policy.minimumIndependentGroups) rejectionReasons.push("INDEPENDENCE_COVERAGE_BELOW_MINIMUM_OR_UNKNOWN");
  if (!decimalAtLeast(features.volumeSui5m, policy.minimumVolumeSui)) rejectionReasons.push("VOLUME_BELOW_MINIMUM_OR_UNKNOWN");
  if (features.creatorConcentrationPct === null) rejectionReasons.push("CREATOR_CONCENTRATION_UNKNOWN");
  else if (features.creatorConcentrationPct > policy.maximumCreatorConcentrationPct) rejectionReasons.push("CREATOR_CONCENTRATION_TOO_HIGH");
  if (features.topTenConcentrationPct === null) rejectionReasons.push("HOLDER_CONCENTRATION_UNKNOWN");
  else if (features.topTenConcentrationPct > policy.maximumTopTenConcentrationPct) rejectionReasons.push("HOLDER_CONCENTRATION_TOO_HIGH");
  if (features.hasExecutableBuyQuote !== true) rejectionReasons.push("BUY_QUOTE_UNAVAILABLE");
  if (features.hasExecutableFullExitQuote !== true) rejectionReasons.push("FULL_EXIT_QUOTE_UNAVAILABLE");
  if (features.roundTripLossPct === null || features.roundTripLossPct > policy.maximumRoundTripLossPct) rejectionReasons.push("ROUND_TRIP_COST_TOO_HIGH_OR_UNKNOWN");
  if (features.trendScore === null || features.trendScore < policy.minimumTrendScore) rejectionReasons.push("TREND_SCORE_BELOW_THRESHOLD_OR_UNKNOWN");
  return {
    action: "HOLD_SUI",
    eligible: false,
    mode: "OBSERVE",
    policyVersion: policy.version,
    rejectionReasons,
    evaluatedAt: now.toISOString(),
  };
}