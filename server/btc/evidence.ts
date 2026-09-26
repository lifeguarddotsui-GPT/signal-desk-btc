type PricePoint = { at: number; price: number };

export function evidenceContext(input: {
  now: number;
  hasRound: boolean;
  referencePrice: number | null;
  indicativeUp: number | null;
  comparisonPrice: number | null;
  points: PricePoint[];
  promotedModel: boolean;
}) {
  const points = input.points.filter(p => Number.isFinite(p.price) && Number.isFinite(p.at) &&
    p.at <= input.now && p.at >= input.now - 5 * 60_000).sort((a, b) => a.at - b.at);
  const recent = points.slice(-3);
  const continuous = recent.length === 3 && input.now - recent[2].at <= 20_000 &&
    recent[2].at - recent[1].at <= 20_000 && recent[1].at - recent[0].at <= 20_000;
  const factors = [
    { label: "Active on-chain round and reference", passed: input.hasRound && input.referencePrice !== null, points: 25 },
    { label: "Current on-chain indicative board", passed: input.indicativeUp !== null, points: 25 },
    { label: "Fresh comparison tick (not oracle)", passed: input.comparisonPrice !== null, points: 10 },
    { label: "Recent comparison samples without a gap", passed: continuous, points: 15 },
    { label: "Independently validated, promoted forecast", passed: input.promotedModel, points: 25 },
  ];
  const score = factors.reduce((total, factor) => total + (factor.passed ? factor.points : 0), 0);
  const p = input.indicativeUp;
  const marketTilt = p === null ? "UNAVAILABLE" : p >= .55 ? "UP" : p <= .45 ? "DOWN" : "BALANCED";
  return {
    evidence: {
      label: "Input check completeness", score, maxScore: 100,
      checksPassed: factors.filter(factor => factor.passed).length, checksTotal: factors.length,
      meaning: "Five input checks; points are policy-defined availability weights, not statistically measured accuracy. This is not a calibrated prediction, chance of winning, or trade confidence.",
      factors,
    },
    decisionSupport: {
      marketTilt,
      indicativeUp: p,
      comparisonDistance: input.referencePrice !== null && input.comparisonPrice !== null ?
        input.comparisonPrice - input.referencePrice : null,
      comparisonChange: points.length >= 2 ? points[points.length - 1].price - points[0].price : null,
      comparisonWindowSeconds: points.length >= 2 ? Math.round((points[points.length - 1].at - points[0].at) / 1000) : null,
      comparisonSampleCount: points.length,
      comparisonHasGaps: points.some((point, index) => index > 0 && point.at - points[index - 1].at > 30_000),
      caveat: "Board tilt is an indicative on-chain probability, not a forecast or executable quote. Coinbase comparison is not the DeepBook settlement oracle. HOLD remains in force.",
    },
  };
}