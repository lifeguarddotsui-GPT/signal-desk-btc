export type Advisor = {
  bias: "UP BIAS" | "DOWN BIAS" | "BALANCED" | "WAITING FOR DATA";
  source: "Market-derived bias" | "Model-derived bias" | null;
  explanation: string;
  reliability: "Unrated" | "Limited" | "Moderate" | "Strong";
  tradeValue: "ECONOMICS UNAVAILABLE" | "TOO LATE";
  tradeReason: string;
};

type Probability = { up: number; down: number; asOf: string };
type Inputs = {
  now: number;
  expiryMs: number | null;
  roundStartMs: number | null;
  indicative: Probability | null;
  validatedForecast?: (Probability & { reliability: "Limited" | "Moderate" | "Strong" }) | null;
};

// Presentation policy, not a backtested trading threshold. No estimate of edge
// can be inferred from its distance from 50%, or from the market's own price.
export const NEUTRAL_BAND = { lower: 0.45, upper: 0.55 } as const;
export const MANUAL_TIME_BUDGET_MS = 18_000;
// Conservative, unvalidated operator budget: reaction 4s + wallet approval 6s
// + expected submission/confirmation 5s + a 3s buffer. Never auto-trade on it.
export const MANUAL_TIME_BUDGET_REASON =
  "Less than 18 seconds remain (4s reaction + 6s wallet approval + 5s submission/confirmation + 3s buffer; conservative planning assumptions, not measured guarantees).";

function validProbability(p: Probability | null, now: number, startMs: number, maxAge: number): p is Probability {
  if (!p || !Number.isFinite(p.up) || !Number.isFinite(p.down) ||
    p.up < 0 || p.up > 1 || p.down < 0 || p.down > 1 ||
    Math.abs(p.up + p.down - 1) > 0.002) return false;
  const asOf = Date.parse(p.asOf);
  return Number.isFinite(asOf) && asOf >= startMs && asOf <= now && now - asOf < maxAge;
}

export function advisorForLive(input: Inputs): Advisor {
  const { now, expiryMs, roundStartMs } = input;
  const active = expiryMs !== null && roundStartMs !== null &&
    Number.isSafeInteger(expiryMs) && Number.isSafeInteger(roundStartMs) &&
    roundStartMs <= now && expiryMs > now;
  const model = active && validProbability(input.validatedForecast ?? null, now, roundStartMs!, 14_000)
    ? input.validatedForecast! : null;
  const market = active && validProbability(input.indicative, now, roundStartMs!, 14_000)
    ? input.indicative : null;
  const selected = model ?? market;
  const source = model ? "Model-derived bias" : market ? "Market-derived bias" : null;
  const bias = !selected ? "WAITING FOR DATA"
    : selected.up > NEUTRAL_BAND.upper ? "UP BIAS"
    : selected.up < NEUTRAL_BAND.lower ? "DOWN BIAS" : "BALANCED";
  const explanation = !selected ? "Waiting for fresh round-matched probabilities."
    : bias === "BALANCED"
      ? `${model ? "Validated model" : "DeepBook market"} is within the 45–55% neutral band; independent trade edge unverified.`
      : `${model ? "Validated model" : "DeepBook market"} favors ${bias === "UP BIAS" ? "UP" : "DOWN"}; independent trade edge unverified.`;
  const tooLate = active && expiryMs! - now <= MANUAL_TIME_BUDGET_MS;
  return {
    bias, source, explanation, reliability: model?.reliability ?? "Unrated",
    tradeValue: tooLate ? "TOO LATE" : "ECONOMICS UNAVAILABLE",
    tradeReason: tooLate ? MANUAL_TIME_BUDGET_REASON :
      "No verified executable quote, payout, fees, and independently qualified estimate are available; a market probability is not a demonstrated edge.",
  };
}