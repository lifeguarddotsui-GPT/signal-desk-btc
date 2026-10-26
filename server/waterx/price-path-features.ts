/**
 * Point-in-time chart-path research FEATURES ONLY.
 *
 * Coinbase/comparison price path versus a confirmed WaterX round anchor.
 * This is NOT the Chainlink settlement TWAP and cannot establish the winner.
 * Features must be compared by forward ablation against a no-path baseline.
 */
export type PointInTimePrice = Readonly<{
  sourceAtMs: number;
  receivedAtMs: number;
  price: number;
}>;
export type PathFeatures = Readonly<{
  source: "COINBASE_PROXY_VS_WATERX_ANCHOR";
  windowSeconds: number;
  greenSeconds: number;
  redSeconds: number;
  greenFraction: number;
  redFraction: number;
  greenAreaBpsSeconds: number;
  redAreaBpsSeconds: number;
  signedAreaBpsSeconds: number;
  averageSignedDistanceBps: number;
  sampleCount: number;
  windowEndAtMs: number;
  sourceAgeMs: number;
}>;
export type PathResult = Readonly<{ features: PathFeatures | null; reason: string | null }>;

const fail = (reason: string): PathResult => ({ features: null, reason });
const finite = (v: number) => Number.isFinite(v);

/** Interpolates observed proxy prices between source-stamped ticks. Any
 * incomplete, stale, overlapping or late-received path returns unavailable.
 * Never fill gaps with a synthetic price or post-decision observation.
 */
export function measureWaterxPricePath(input: {
  decisionAtMs: number;
  anchorPrice: number | null;
  anchorConfirmed: boolean;
  ticks: readonly PointInTimePrice[];
  windowSeconds?: number;
  maxGapMs?: number;
}): PathResult {
  const { decisionAtMs, anchorPrice, anchorConfirmed } = input;
  const seconds = input.windowSeconds ?? 60;
  const maxGapMs = input.maxGapMs ?? 10_000;
  if (!finite(decisionAtMs) || !Number.isInteger(decisionAtMs) ||
      !anchorConfirmed || anchorPrice === null || !finite(anchorPrice) || anchorPrice <= 0 ||
      !finite(seconds) || seconds < 15 || seconds > 180 ||
      !Number.isInteger(maxGapMs) || maxGapMs <= 0 || maxGapMs > 15_000)
    return fail("Confirmed WaterX anchor, valid point-in-time clock and bounded lookback are required.");
  if (!Array.isArray(input.ticks) || input.ticks.length < 2)
    return fail("Insufficient price path samples.");
  // End at the latest actually observed tick, never fill an unavailable final
  // segment by extrapolating into the decision instant.
  const candidates = input.ticks.filter(t =>
    t.sourceAtMs >= decisionAtMs - seconds * 1000 - 2 * maxGapMs &&
    t.sourceAtMs <= decisionAtMs).sort((a,b) => a.sourceAtMs - b.sourceAtMs);
  const endAtMs = candidates.at(-1)?.sourceAtMs;
  if (endAtMs === undefined || decisionAtMs - endAtMs > maxGapMs)
    return fail("No sufficiently fresh comparison tick at decision time.");
  const from = endAtMs - seconds * 1000;
  // Reject future-received data rather than rewriting its provenance.
  const sorted = candidates.filter(t => t.sourceAtMs >= from - maxGapMs);
  if (sorted.some(t => !finite(t.sourceAtMs) || !finite(t.receivedAtMs) ||
        !finite(t.price) || t.price <= 0 || t.sourceAtMs > t.receivedAtMs ||
        t.receivedAtMs > decisionAtMs)) return fail("An invalid or post-decision tick contaminates the feature path.");
  if (sorted.length < 2 || sorted[0].sourceAtMs > from ||
      sorted[0].sourceAtMs < from - maxGapMs ||
      sorted.at(-1)!.sourceAtMs !== endAtMs ||
      sorted.some((tick,i) => i>0 &&
        (tick.sourceAtMs <= sorted[i-1].sourceAtMs ||
         tick.sourceAtMs - sorted[i-1].sourceAtMs > maxGapMs)))
    return fail("Path has an uncovered boundary, duplicate timestamp or observation gap.");
  const priced = (price: number) => (price / anchorPrice - 1) * 10_000;
  const samples = [{ sourceAtMs: from, price: sorted[0].sourceAtMs === from
    ? sorted[0].price
    : (() => {
        const next = sorted.find(t => t.sourceAtMs > from);
        if (!next || next.sourceAtMs - sorted[0].sourceAtMs > maxGapMs)
          return NaN;
        const fraction = (from - sorted[0].sourceAtMs) / (next.sourceAtMs - sorted[0].sourceAtMs);
        return sorted[0].price + (next.price - sorted[0].price) * fraction;
      })() }, ...sorted.filter(t=>t.sourceAtMs>from)];
  if (!finite(samples[0].price)) return fail("The start-of-window proxy price cannot be interpolated.");
  let greenSeconds = 0, redSeconds = 0, greenArea = 0, redArea = 0;
  const add = (a:number,b:number,duration:number) => {
    const area = (a+b)*0.5*duration;
    if (a >= 0 && b >= 0) { greenArea += area; if (a+b>0)greenSeconds+=duration; }
    else if (a <= 0 && b <= 0) { redArea -= area; if (a+b<0)redSeconds+=duration; }
    else {
      // Split a crossing exactly where the line intersects the reference.
      const crossing = duration * Math.abs(a) / (Math.abs(a) + Math.abs(b));
      add(a,0,crossing); add(0,b,duration-crossing);
    }
  };
  for (let i=1;i<samples.length;i++) {
    const a=samples[i-1], b=samples[i];
    add(priced(a.price),priced(b.price),(b.sourceAtMs-a.sourceAtMs)/1000);
  }
  const area = greenArea - redArea;
  return { reason:null, features:{
    source:"COINBASE_PROXY_VS_WATERX_ANCHOR",windowSeconds:seconds,
    greenSeconds,redSeconds,greenFraction:greenSeconds/seconds,redFraction:redSeconds/seconds,
    greenAreaBpsSeconds:greenArea,redAreaBpsSeconds:redArea,
    signedAreaBpsSeconds:area,averageSignedDistanceBps:area/seconds,
    sampleCount:sorted.length,windowEndAtMs:endAtMs,sourceAgeMs:decisionAtMs-endAtMs,
  }};
}
