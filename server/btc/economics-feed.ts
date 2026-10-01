import { MANUAL_TIME_BUDGET_MS } from "./advisor";
import {
  DEFAULT_SPEND_BUDGET_USD,
  MAX_QUOTE_AGE_MS,
  quoteRoundEconomics,
  type RoundEconomics,
  type SizingRequest,
} from "./economics";

type MarketKey = { marketId: string; expiryMs: number };
type ReadQuote = (market: MarketKey & { sizing?: SizingRequest }) => Promise<RoundEconomics>;

function unavailable(
  market: MarketKey, sizing: SizingRequest, status: RoundEconomics["status"], reason: string, now: number,
  technicalDetail: string | null = null,
): RoundEconomics {
  return {
    status, marketId: market.marketId, expiryMs: market.expiryMs,
    asOf: new Date(now).toISOString(), ageMs: 0,
    sizingMode: sizing.mode,
    totalSpendBudget: sizing.mode === "SPEND_BUDGET"
      ? sizing.spendBudget ?? DEFAULT_SPEND_BUDGET_USD : null,
    unspentBudget: sizing.mode === "SPEND_BUDGET" ? { up: null, down: null } : null,
    networkGas: { status: "UNKNOWN", included: false },
    sizing: sizing.mode === "SPEND_BUDGET"
      ? { mode: "SPEND_BUDGET", requestedPayoutQuantity: null,
        totalSpendBudget: sizing.spendBudget ?? DEFAULT_SPEND_BUDGET_USD,
        upUnspentBudget: null, downUnspentBudget: null,
        note: "Each side is independently sized within the requested all-in USDC spend budget." }
      : { mode: "PAYOUT_QUANTITY", requestedPayoutQuantity: sizing.payoutQuantity,
        totalSpendBudget: null, upUnspentBudget: null, downUnspentBudget: null,
        note: "Quantity is gross winning payout; all-in cost is quoted separately." },
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

  async function get(market: MarketKey, sizing: SizingRequest = {
    mode: "SPEND_BUDGET", spendBudget: DEFAULT_SPEND_BUDGET_USD,
  }): Promise<RoundEconomics> {
    const current = now();
    const sizingKey = sizing.mode === "SPEND_BUDGET"
      ? `SPEND_BUDGET:${sizing.spendBudget ?? DEFAULT_SPEND_BUDGET_USD}`
      : `PAYOUT_QUANTITY:${sizing.payoutQuantity}`;
    if (typeof market.marketId !== "string" || !/^0x[0-9a-f]{64}$/i.test(market.marketId) ||
        !Number.isSafeInteger(market.expiryMs) || market.expiryMs <= 0 ||
        !Number.isFinite(new Date(market.expiryMs).getTime()))
      return unavailable(market, sizing, "INVALID_REQUEST", "The market ID or round expiry is invalid.", current);
    if (market.expiryMs <= current)
      return unavailable(market, sizing, "EXPIRED", "The round has expired; no quote is carried into another round.", current);
    if (market.expiryMs - current <= MANUAL_TIME_BUDGET_MS)
      return unavailable(market, sizing, "TOO_LATE", "The manual entry window has closed (18 seconds or less remain).", current);

    const key = `${market.marketId}:${market.expiryMs}:${sizingKey}`;
    const fromCache = (result: RoundEconomics, receivedAt: number) => {
      if (result.marketId !== market.marketId || result.expiryMs !== market.expiryMs)
        return unavailable(market, sizing, "ROUND_MISMATCH", "Quote belongs to a different round.", now());
      const sourceTime = Date.parse(result.asOf);
      const currentTime = now();
      const ageMs = currentTime - sourceTime;
      if (!Number.isFinite(sourceTime) || ageMs < 0 || ageMs > MAX_QUOTE_AGE_MS)
        return unavailable(market, sizing, "STALE_QUOTE", "Anonymous quote has aged out; waiting for a fresh read.", currentTime,
          `Quote timestamp age is invalid or exceeds ${MAX_QUOTE_AGE_MS}ms.`);
      if (market.expiryMs - currentTime <= MANUAL_TIME_BUDGET_MS)
        return unavailable(market, sizing, "TOO_LATE", "The manual entry window closed while the quote was loading.", currentTime);
      // Cache failures briefly to avoid a burst of repeated provider calls.
      return { ...result, ageMs: Math.max(ageMs, Math.max(0, currentTime - receivedAt)) };
    };
    if (cache?.key === key && current - cache.receivedAt < 5_000)
      return fromCache(cache.result, cache.receivedAt);
    if (pending?.key === key) return fromCache(await pending.promise, now());

    const promise = read({ ...market, sizing }).catch(error => {
      const detail = error instanceof Error ? error.message : String(error);
      return unavailable(market, sizing, "PROVIDER_ERROR", "Anonymous quote service is temporarily unavailable; try again shortly.",
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