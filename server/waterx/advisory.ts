import type { buildWaterxLivePayload } from "./service";
import type { WaterxInterval } from "./types";

type Live = ReturnType<typeof buildWaterxLivePayload>;
type Direction = "up" | "down";
export type AdvisoryState = "UNAVAILABLE" | "OBSERVE" | "WAIT" |
  "FAVORABLE_UP" | "FAVORABLE_DOWN" | "TOO_LATE" | "LOCKED" | "EXPIRED";

const finite = (value: number | null | undefined, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/** Only call with independently verified, fee-adjusted receipt and all-in cost. */
export function calculateVerifiedBinaryNet(
  calibratedProbability: number, netReceiptIfWin: number, totalCost: number,
) {
  if (!finite(calibratedProbability, 0, 1) ||
      !finite(netReceiptIfWin, Number.MIN_VALUE, Number.MAX_VALUE) ||
      !finite(totalCost, 0, Number.MAX_VALUE))
    throw new Error("Binary value inputs must be finite, with a positive net receipt and probability in [0,1].");
  return {
    breakEvenProbability: totalCost / netReceiptIfWin,
    expectedNet: calibratedProbability * netReceiptIfWin - totalCost,
    netProfitIfWin: netReceiptIfWin - totalCost,
    lossIfUnsuccessful: totalCost,
  };
}

/**
 * One read-only, round-matched research snapshot. Nothing in the public
 * market feed establishes a qualified model, executable quote, actual
 * transaction costs, or entry cutoff, so it cannot authorize a value signal.
 */
export function buildWaterxAdvisory(live: Live, interval: WaterxInterval, amount: number, now = Date.now()) {
  if (!finite(amount, 0.01, 10_000))
    throw new Error("amount must be between $0.01 and $10,000.");
  if (!Number.isSafeInteger(now)) throw new Error("Invalid advisory time.");
  const round = live.intervalMinutes === interval ? live.round : null;
  const identity = round ? {
    provider: "WaterX" as const, marketId: round.marketId, marketSlug: round.marketSlug,
    intervalMinutes: interval, roundId: round.id,
    startMs: round.startMs, expiryMs: round.expiryMs,
  } : null;
  const validRound = live.status === "LIVE" && !!round && !!identity?.marketId &&
    Number.isSafeInteger(round.startMs) && Number.isSafeInteger(round.expiryMs) &&
    round.expiryMs - round.startMs === interval * 60_000 &&
    round.startMs <= now && now < round.expiryMs;
  const quoteAtMs = live.odds?.asOf ? Date.parse(live.odds.asOf) : NaN;
  const quoteAgeMs = Number.isFinite(quoteAtMs) ? Math.max(0, now - quoteAtMs) : null;
  const quoteFresh = validRound && quoteAgeMs !== null &&
    quoteAtMs >= round!.startMs && quoteAtMs <= now + 1_000 &&
    quoteAgeMs <= (interval === 5 ? 16_000 : 31_000) &&
    live.odds?.source === "WaterX public market probabilities and odds";
  const locked = validRound && live.availability.odds.status === "locked";
  const side = (direction: Direction) => {
    const availability = live.availability.odds[direction];
    const cents = quoteFresh ? live.odds?.[direction === "up" ? "upPriceCents" : "downPriceCents"] : null;
    const probability = quoteFresh ? live.odds?.[direction] : null;
    const priceAvailable = availability.side === "reported" &&
      availability.price === "reported" && availability.pricePositive &&
      finite(cents, Number.MIN_VALUE, 100);
    // A binary $1/share payout with zero losing payout is a *hypothesis*,
    // not a verified WaterX receipt or executable amount.
    const gross = priceAvailable ? amount / (cents! / 100) : null;
    return {
      direction,
      marketProbability: finite(probability, 0, 1) &&
        availability.probability === "available" ? probability : null,
      calibratedProbability: null,
      quote: {
        source: "WaterX public side price" as const,
        timestampBasis: "app_observed_response" as const,
        asOf: quoteFresh ? live.odds!.asOf : null,
        ageMs: quoteFresh ? quoteAgeMs : null,
        expiresAt: null, executable: false as const,
        priceCents: priceAvailable ? cents : null,
        quantityIfWinIndicative: gross,
        estimatedTotalCost: null,
        estimatedFees: null,
        estimatedPriceImpact: null,
        grossReceiptIfWinIndicative: gross,
        netReceiptIfWin: null,
        netProfitIfWin: null,
        lossIfUnsuccessful: null,
        lossIfUnsuccessfulBeforeFeesIndicative: priceAvailable ? amount : null,
        breakEvenProbability: null,
        breakEvenProbabilityBeforeFeesIndicative: priceAvailable ? cents! / 100 : null,
        estimatedExpectedNetValue: null,
        assumptions: "Indicative $1 per winning share and zero losing payout; fees, voids, refunds, actual quantity and fills are unverified.",
      },
    };
  };
  const up = side("up");
  const down = side("down");
  const hasQuote = up.quote.priceCents !== null || down.quote.priceCents !== null;
  const state: AdvisoryState = !round || !validRound
    ? live.status === "STALE" && /expired/i.test(live.reason) ? "EXPIRED" : "UNAVAILABLE"
    : locked ? "LOCKED" : hasQuote ? "OBSERVE" : "UNAVAILABLE";
  const reasonCodes = state === "EXPIRED" ? ["ROUND_EXPIRED"] :
    !validRound ? [live.status === "UNAVAILABLE" ? "PROVIDER_UNAVAILABLE" : "COLLECTOR_STALLED"] :
    locked ? ["MARKET_LOCKED"] :
    !quoteFresh ? ["QUOTE_EXPIRED_OR_MISMATCHED"] :
    !hasQuote ? ["QUOTE_UNAVAILABLE"] :
    ["MODEL_UNQUALIFIED", "NON_EXECUTABLE_QUOTE", "FEES_UNVERIFIED", "ENTRY_CUTOFF_UNKNOWN",
      ...(!round!.anchorConfirmed ? ["REFERENCE_PROVISIONAL"] : [])];
  return {
    protocol: "waterx-value-advisory-v1" as const,
    generatedAt: new Date(now).toISOString(),
    identity: validRound ? identity : null,
    tradingCutoffMs: null,
    reference: validRound
      ? { price: round!.referencePrice, status: round!.anchorConfirmed ? "reported" : "provisional" }
      : { price: null, status: "unavailable" },
    probability: {
      source: "WaterX market-derived, not an independent forecast" as const,
      version: null, asOf: quoteFresh ? live.odds!.asOf : null,
      qualification: "unvalidated" as const,
      uncertainty: "No validated interval- and horizon-specific model uncertainty bound.",
    },
    amountEnteredUsd: amount,
    sides: { up, down },
    state,
    reasonCodes,
    reason: state === "OBSERVE"
      ? "Current indicative side prices are available, but no qualified model, executable $5 quote, verified costs or entry cutoff supports a favorable-entry signal."
      : state === "LOCKED" ? "WaterX reports this market locked."
      : state === "EXPIRED" ? "Round expired; previous quotes are not eligible."
      : live.reason || "Current round and quote evidence is unavailable.",
    action: "HOLD" as const,
  };
}