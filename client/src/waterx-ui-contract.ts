export type WaterxInterval = 5 | 15;

/** The price-to-beat is the beginning reference WaterX reports, not Chainlink's settlement TWAP. */
export const WATERX_REFERENCE_LABEL = "WATERX-REPORTED BEGINNING REFERENCE";
export const SETTLEMENT_SOURCE_LABEL = "CHAINLINK BTC/USD TWAP · SETTLEMENT";

export type WaterxDisplayOdds = {
  up?: number | null;
  down?: number | null;
  upPriceCents?: number | null;
  downPriceCents?: number | null;
  asOf?: string | null;
  source?: string | null;
  roundId?: string | null;
};

export type WaterxSideDisplayAvailability = {
  probability?: string;
  price?: string;
  pricePositive?: boolean;
  side?: string;
};

export type WaterxOddsDisplayAvailability = {
  status?: string;
  up?: WaterxSideDisplayAvailability;
  down?: WaterxSideDisplayAvailability;
};

export type WaterxOddsDisplaySelection = {
  status: "unavailable" | "withheld" | "locked" | "partial" | "current";
  fresh: boolean;
  current: boolean;
  lockedPair: boolean;
  partial: boolean;
  up: { probability: number | null; priceCents: number | null; locked: boolean; grossAvailable: boolean };
  down: { probability: number | null; priceCents: number | null; locked: boolean; grossAvailable: boolean };
};

/**
 * Only a fresh positive WaterX-reported reference for the active round can
 * anchor distance or the live chart. Null and zero are not prices to beat.
 */
export function selectWaterxReference(
  roundCurrent: boolean,
  referencePrice: unknown,
  availabilityStatus?: string,
): number | null {
  return roundCurrent && availabilityStatus !== "unavailable" &&
    typeof referencePrice === "number" && Number.isFinite(referencePrice) && referencePrice > 0
    ? referencePrice
    : null;
}

export function selectWaterxPriceDistance(input: {
  referencePrice: number | null;
  comparisonFresh: boolean;
  comparisonPrice?: number | null;
  comparisonAtMs: number;
  roundStartMs?: number | null;
}): { distance: number; percent: number } | null {
  const { referencePrice, comparisonPrice, comparisonAtMs, roundStartMs } = input;
  if (referencePrice == null || !Number.isFinite(referencePrice) || referencePrice <= 0 ||
      !input.comparisonFresh || typeof comparisonPrice !== "number" ||
      !Number.isFinite(comparisonPrice) || comparisonPrice <= 0 ||
      !Number.isFinite(comparisonAtMs) || typeof roundStartMs !== "number" ||
      !Number.isFinite(roundStartMs) || comparisonAtMs < roundStartMs) return null;
  const distance = comparisonPrice - referencePrice;
  return { distance, percent: distance / referencePrice * 100 };
}

/** Select independently trustworthy market fields without using truthiness for numeric zero. */
export function selectWaterxOddsDisplay(input: {
  snapshotCurrent: boolean;
  roundCurrent: boolean;
  requestedInterval: WaterxInterval;
  responseInterval?: unknown;
  roundId?: string | null;
  roundStartMs?: number | null;
  serverNowMs: number;
  odds?: WaterxDisplayOdds | null;
  availability?: WaterxOddsDisplayAvailability;
}): WaterxOddsDisplaySelection {
  const unavailableSide = { probability: null, priceCents: null, locked: false, grossAvailable: false };
  const unavailable = (status: "unavailable" | "withheld" = "unavailable"): WaterxOddsDisplaySelection => ({
    status, fresh: false, current: false, lockedPair: false, partial: false,
    up: unavailableSide, down: unavailableSide,
  });

  const { odds, availability } = input;
  // Market probability can be absent even while a same-round side price is
  // present. Do not make indicative receipt arithmetic depend on probability.
  const hasReportedPrice = (availability?.up?.price === "reported" && odds?.upPriceCents != null) ||
    (availability?.down?.price === "reported" && odds?.downPriceCents != null);
  if (!odds || (availability?.status === "unavailable" && !hasReportedPrice))
    return unavailable("unavailable");

  const asOfMs = odds.asOf ? Date.parse(odds.asOf) : NaN;
  const intervalMatches = input.responseInterval === input.requestedInterval;
  const identityMatches = odds.roundId == null || odds.roundId === input.roundId;
  const startMs = input.roundStartMs;
  const timeMatches = Number.isFinite(asOfMs) && Number.isFinite(input.serverNowMs) &&
    asOfMs <= input.serverNowMs + 1_000 &&
    input.serverNowMs - asOfMs <= 14_000 &&
    typeof startMs === "number" && Number.isFinite(startMs) && asOfMs >= startMs;
  const fresh = input.snapshotCurrent && input.roundCurrent && intervalMatches &&
    identityMatches && timeMatches && isWaterxMarketSource(odds.source);
  if (!fresh) return unavailable("withheld");

  const selectSide = (
    probability: number | null | undefined,
    priceCents: number | null | undefined,
    sideAvailability: WaterxSideDisplayAvailability | undefined,
  ) => {
    const sideMissing = sideAvailability?.side === "unavailable";
    const probabilityAvailable = !sideMissing && sideAvailability?.probability !== "unavailable" &&
      typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1;
    const priceAvailable = !sideMissing && sideAvailability?.price !== "unavailable" &&
      typeof priceCents === "number" && Number.isFinite(priceCents) && priceCents >= 0 && priceCents <= 100;
    const selectedPrice = priceAvailable ? priceCents! : null;
    const locked = sideAvailability?.side === "locked" || selectedPrice === 0;
    return {
      probability: probabilityAvailable ? probability! : null,
      priceCents: selectedPrice,
      locked,
      // WaterX side prices describe a market quote for this same active round.
      // The separate WaterX beginning reference is not an input to payout math.
      grossAvailable: !locked &&
        typeof selectedPrice === "number" && selectedPrice > 0 &&
        sideAvailability?.pricePositive !== false,
    };
  };

  const up = selectSide(odds.up, odds.upPriceCents, availability?.up);
  const down = selectSide(odds.down, odds.downPriceCents, availability?.down);
  const lockedPair = availability?.status === "locked" || (up.locked && down.locked);
  const partial = !lockedPair && (
    availability?.status === "partial" ||
    up.locked || down.locked ||
    up.probability == null || down.probability == null ||
    up.priceCents == null || down.priceCents == null
  );
  const current = !lockedPair;
  return {
    status: lockedPair ? "locked" : partial ? "partial" : "current",
    fresh: true,
    current,
    lockedPair,
    partial,
    up: { ...up, grossAvailable: up.grossAvailable && current },
    down: { ...down, grossAvailable: down.grossAvailable && current },
  };
}

export function isActiveWaterxRound(
  responseInterval: unknown,
  requestedInterval: WaterxInterval,
  startMs: number,
  expiryMs: number,
  nowMs: number,
): boolean {
  return responseInterval === requestedInterval &&
    Number.isFinite(startMs) &&
    Number.isFinite(expiryMs) &&
    Number.isFinite(nowMs) &&
    nowMs >= startMs &&
    nowMs < expiryMs;
}

/** Both the browser receipt and the server snapshot must be fresh enough for live presentation. */
export function isFreshWaterxSnapshot(
  receivedAtMs: number,
  serverTime: string | number | null | undefined,
  nowMs: number,
  toleranceMs: number,
): boolean {
  const serverMs = typeof serverTime === "number"
    ? serverTime
    : typeof serverTime === "string" ? Date.parse(serverTime) : NaN;
  const receivedAge = nowMs - receivedAtMs;
  const serverAge = nowMs - serverMs;
  return [receivedAtMs, serverMs, nowMs, toleranceMs].every(Number.isFinite) &&
    toleranceMs > 0 &&
    receivedAge >= -1_000 && receivedAge <= toleranceMs &&
    serverAge >= -2_000 && serverAge <= toleranceMs;
}

export type TimestampedPrice = { at: number; price: number | null; gap?: boolean; reason?: string };

/** Stable chart identity is based on observation content, never archive/stream origin or array position. */
export function stablePricePointKey(point: TimestampedPrice): string {
  return `${point.at}:${point.price == null || point.gap ? "gap" : point.price}`;
}

export function mergePricePoints<T extends TimestampedPrice>(...sources: readonly (readonly T[])[]): T[] {
  const merged = new Map<string, T>();
  for (const source of sources) {
    for (const point of source) merged.set(stablePricePointKey(point), { ...merged.get(stablePricePointKey(point)), ...point });
  }
  return Array.from(merged.values()).sort((a, b) => a.at - b.at);
}

export function sseReconnectUrl(path: string, cursor: string): string {
  if (!cursor) return path;
  return `${path}${path.includes("?") ? "&" : "?"}lastEventId=${encodeURIComponent(cursor)}`;
}

export function resetSseCursor(lastEventId: string): string {
  return /^\d+$/.test(lastEventId) ? lastEventId : "";
}

/** Gross one-side arithmetic only: amount divided by the represented decimal odds. */
export function indicativeGross(amount: number, sidePriceCents: number): number | null {
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(sidePriceCents) || sidePriceCents <= 0 || sidePriceCents > 100) return null;
  return amount / (sidePriceCents / 100);
}

/** Preserve explicit gaps and break a price path when consecutive samples exceed the feed tolerance. */
export function insertTimestampGaps<T extends TimestampedPrice>(
  points: readonly T[],
  toleranceMs: number,
): T[] {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const result: T[] = [];
  let previous: T | null = null;
  for (const point of sorted) {
    if (point.gap || point.price == null) {
      result.push(point);
      previous = null;
      continue;
    }
    if (previous && point.at - previous.at > toleranceMs) {
      result.push({
        ...point,
        at: previous.at + Math.floor((point.at - previous.at) / 2),
        price: null,
        gap: true,
        reason: "Timestamp separation exceeded the live-feed tolerance.",
      } as T);
    }
    result.push(point);
    previous = point;
  }
  return result;
}

export function isCoinbaseSource(source: string | null | undefined): boolean {
  return typeof source === "string" && /coinbase/i.test(source);
}

export function isWaterxMarketSource(source: string | null | undefined): boolean {
  return typeof source === "string" && /waterx|market/i.test(source);
}