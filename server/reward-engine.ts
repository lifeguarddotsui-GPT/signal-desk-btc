/**
 * Reward Engine — risk-adjusted reward computation.
 *
 * Replaces the simple SUCCESS/FAIL reward model with a multi-component
 * reward that accounts for PnL per risk, execution quality, calibration,
 * regime difficulty, drawdown, and trade discipline.
 *
 * Clamped to [-5, +5] to prevent single outliers from dominating EWMA weights.
 */

export interface RewardInput {
  label: "SUCCESS" | "PARTIAL" | "TIMEOUT" | "FAIL" | "SKIP";
  pnlSui: number | null;
  collateral: number | null;
  riskSui: number | null;
  slippageBps: number | null;
  latencyMs: number | null;
  regime: string;
  tradabilityScore: number | null;
  predictedProbability: number | null;
  drawdownPctBefore: number | null;
  drawdownPctAfter: number | null;
  wasTradeForced: boolean;
  skippedBadTrade?: boolean;
  onChainSuccess?: boolean;
}

export function computeRiskAdjustedReward(input: RewardInput): number {
  let reward = 0;

  // 1. Outcome component
  switch (input.label) {
    case "SUCCESS": reward += 1.4; break;
    case "PARTIAL": reward += 0.5; break;
    case "TIMEOUT": reward -= 0.8; break;
    case "FAIL":    reward -= 1.6; break;
    case "SKIP":    reward += input.skippedBadTrade ? 0.35 : 0; break;
  }

  // 2. PnL per risk — strongest signal of trade quality
  const effectiveRisk = input.riskSui
    ? input.riskSui
    : input.collateral ?? null;

  const pnlPerRisk =
    input.pnlSui != null && effectiveRisk && effectiveRisk > 0
      ? input.pnlSui / effectiveRisk
      : 0;

  reward += clamp(pnlPerRisk * 0.9, -1.5, 1.5);

  // 3. Execution quality — slippage
  if (input.slippageBps != null) {
    if (input.slippageBps < 8)   reward += 0.30;
    else if (input.slippageBps < 20) reward += 0.10;
    else if (input.slippageBps > 100) reward -= 0.70;
    else if (input.slippageBps > 50)  reward -= 0.35;
  }

  // 3b. Execution quality — latency
  if (input.latencyMs != null) {
    if (input.latencyMs < 1500)      reward += 0.20;
    else if (input.latencyMs > 30000) reward -= 0.45;
    else if (input.latencyMs > 10000) reward -= 0.20;
  }

  // 3c. On-chain confirmation bonus
  if (input.onChainSuccess) reward += 0.15;

  // 4. Probability calibration reward/penalty
  if (input.predictedProbability != null) {
    if (input.label === "SUCCESS") {
      reward += (input.predictedProbability - 0.5) * 0.8;
    } else if (input.label === "FAIL") {
      reward -= (input.predictedProbability - 0.5) * 1.2;
    }
  }

  // 5. Regime difficulty adjustment
  if (input.regime === "TREND" && input.label === "SUCCESS")    reward += 0.15;
  if (input.regime === "CHOP_SCALP" && input.label === "FAIL") reward -= 0.20;
  if (input.regime === "VOLATILE" && input.label === "FAIL")   reward -= 0.15;

  // 6. Drawdown penalty — punish trades that increase agent drawdown
  if (
    input.drawdownPctBefore != null &&
    input.drawdownPctAfter != null &&
    input.drawdownPctAfter > input.drawdownPctBefore
  ) {
    const ddIncrease = input.drawdownPctAfter - input.drawdownPctBefore;
    reward -= Math.min(1.2, ddIncrease * 4);
  }

  // 7. Forced trade penalty
  if (input.wasTradeForced) reward -= 0.25;

  return clamp(reward, -5, 5);
}

/**
 * Compatibility shim — converts legacy CloseOutcome fields into RewardInput
 * and computes the risk-adjusted reward.
 */
export function computeRiskAdjustedRewardFromOutcome(params: {
  label: string;
  pnlSui?: number | null;
  collateral?: number | null;
  slippageBps?: number | null;
  latencyMs?: number | null;
  regime?: string;
  tradabilityScore?: number | null;
  predictedProbability?: number | null;
  drawdownPctBefore?: number | null;
  drawdownPctAfter?: number | null;
  closeTxDigest?: string | null;
  onChainSuccess?: boolean;
}): number {
  const validLabels = ["SUCCESS", "PARTIAL", "TIMEOUT", "FAIL", "SKIP"] as const;
  const label = validLabels.includes(params.label as any)
    ? (params.label as RewardInput["label"])
    : "FAIL";

  return computeRiskAdjustedReward({
    label,
    pnlSui: params.pnlSui ?? null,
    collateral: params.collateral ?? null,
    riskSui: params.collateral ?? null,
    slippageBps: params.slippageBps ?? null,
    latencyMs: params.latencyMs ?? null,
    regime: params.regime ?? "UNKNOWN",
    tradabilityScore: params.tradabilityScore ?? null,
    predictedProbability: params.predictedProbability ?? null,
    drawdownPctBefore: params.drawdownPctBefore ?? null,
    drawdownPctAfter: params.drawdownPctAfter ?? null,
    wasTradeForced: false,
    onChainSuccess: params.onChainSuccess ?? false,
  });
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
