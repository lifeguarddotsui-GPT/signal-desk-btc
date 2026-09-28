import { MANUAL_TIME_BUDGET_MS } from "./advisor";
import {
  DEFAULT_PAYOUT_QUANTITY_USD,
  MAX_QUOTE_AGE_MS,
  quoteRoundEconomics,
  type RoundEconomics,
} from "./economics";

type MarketKey = { marketId: string; expiryMs: number };
type ReadQuote = (market: MarketKey) => Promise<RoundEconomics>;

function unavailable(
  market: MarketKey, status: RoundEconomics["status"], reason: string, now: number,
  technicalDetail: string | null = null,
): RoundEconomics {
  return {
    status, marketId: market.marketId, expiryMs: market.expiryMs,
    asOf: new Date(now).toISOString(), ageMs: 0,
    sizing: {
      mode: "PAYOUT_QUANTITY", requestedPayoutQuantity: DEFAULT_PAYOUT_QUANTITY_USD,
      totalSpendBudget: null, note: "$5 is gross winning payout quantity, not a total-spend budget.",
    },
    referencePrice: null, referenceAsOf: null, oracleSourceTimes: null,
    assumptions: ["Anonymous estimate only; no account balance or executable fill verified."],
    up: null, down: null, upError: null, downError: null, reason, technicalDetail,
  };
}

/**
 * Deduplicate concurrent anonymous simulations. A result is useful only for
 * its exact market and only while its own source timestamp remains fresh.
 */
export function createEconomicsFeed(read: ReadQuote = quoteRoundEconomics, now = Date.now) {
  let cache: { key: string; receivedAt: number; result: RoundEconomics } | null = null;
  let pending: { key: string; promise: Promise<RoundEconomics> } | null = null;

  async function get(market: MarketKey): Promise<RoundEconomics> {
    const current = now();
    if (typeof market.marketId !== "string" || !/^0x[0-9a-f]{64}$/i.test(market.marketId) ||
        !Number.isSafeInteger(market.expiryMs) || market.expiryMs <= 0 ||
        !Number.isFinite(new Date(market.expiryMs).getTime()))
      return unavailable(market, "INVALID_REQUEST", "The market ID or round expiry is invalid.", current);
    if (market.expiryMs <= current)
      return unavailable(market, "EXPIRED", "The round has expired; no quote is carried into another round.", current);
    if (market.expiryMs - current <= MANUAL_TIME_BUDGET_MS)
      return unavailable(market, "TOO_LATE", "The manual entry window has closed (18 seconds or less remain).", current);

    const key = `${market.marketId}:${market.expiryMs}`;
    const fromCache = (result: RoundEconomics, receivedAt: number) => {
      if (result.marketId !== market.marketId || result.expiryMs !== market.expiryMs)
        return unavailable(market, "ROUND_MISMATCH", "Quote belongs to a different round.", now());
      const sourceTime = Date.parse(result.asOf);
      const currentTime = now();
      const ageMs = currentTime - sourceTime;
      if (!Number.isFinite(sourceTime) || ageMs < 0 || ageMs > MAX_QUOTE_AGE_MS)
        return unavailable(market, "STALE_QUOTE", "Anonymous quote has aged out; waiting for a fresh read.", currentTime,
          `Quote timestamp age is invalid or exceeds ${MAX_QUOTE_AGE_MS}ms.`);
      if (market.expiryMs - currentTime <= MANUAL_TIME_BUDGET_MS)
        return unavailable(market, "TOO_LATE", "The manual entry window closed while the quote was loading.", currentTime);
      // Cache failures briefly to avoid a burst of repeated provider calls.
      return { ...result, ageMs: Math.max(ageMs, Math.max(0, currentTime - receivedAt)) };
    };
    if (cache?.key === key && current - cache.receivedAt < 5_000)
      return fromCache(cache.result, cache.receivedAt);
    if (pending?.key === key) return fromCache(await pending.promise, now());

    const promise = read(market).catch(error => {
      const detail = error instanceof Error ? error.message : String(error);
      return unavailable(market, "PROVIDER_ERROR", "Anonymous quote service is temporarily unavailable; try again shortly.",
        now(), detail.slice(0, 500));
    });
    pending = { key, promise };
    try {
      const result = await promise;
      const receivedAt = now();
      cache = { key, result, receivedAt };
      return fromCache(result, receivedAt);
    } finally {
      if (pending?.promise === promise) pending = null;
    }
  }
  return { get };
}

export const economicsFeed = createEconomicsFeed();