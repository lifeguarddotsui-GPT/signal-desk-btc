export type WaterxInterval = 5 | 15;

/** The price-to-beat is the beginning reference WaterX reports, not Chainlink's settlement TWAP. */
export const WATERX_REFERENCE_LABEL = "WATERX-REPORTED BEGINNING REFERENCE";
export const SETTLEMENT_SOURCE_LABEL = "CHAINLINK BTC/USD TWAP · SETTLEMENT";

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