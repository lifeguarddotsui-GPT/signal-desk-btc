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
    p.at <= input.now && p.at >= input.now - 5 * 60_000);
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
      label: "Evidence quality", score, maxScore: 100,
      meaning: "Checks availability and freshness only. It is not a calibrated prediction, chance of winning, or trade confidence.",
      factors,
    },
    decisionSupport: {
      marketTilt,
      indicativeUp: p,
      comparisonDistance: input.referencePrice !== null && input.comparisonPrice !== null ?
        input.comparisonPrice - input.referencePrice : null,
      comparisonChange: points.length >= 2 ? points[points.length - 1].price - points[0].price : null,
      caveat: "Board tilt is an indicative on-chain probability, not a forecast or executable quote. Coinbase comparison is not the DeepBook settlement oracle. HOLD remains in force.",
    },
  };
}