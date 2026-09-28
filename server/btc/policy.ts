export type SettlementClassification = {
  outcome: "UP" | "DOWN" | "UNKNOWN";
  quality: "VERIFIED_SETTLEMENT" | "MISSING_REFERENCE" | "EQUALITY_RULE_UNVERIFIED";
};

// The SDK supplies a settled numeric price, but contract equality/void rules
// are not independently verified. Never force an equal price into DOWN.
export function classifySettlement(price: number, reference: number | null): SettlementClassification {
  if (!Number.isFinite(price) || price <= 0 ||
    (reference !== null && (!Number.isFinite(reference) || reference <= 0)))
    throw new Error("Invalid settlement or reference price");
  if (reference === null) return { outcome: "UNKNOWN", quality: "MISSING_REFERENCE" };
  if (price === reference) return { outcome: "UNKNOWN", quality: "EQUALITY_RULE_UNVERIFIED" };
  return { outcome: price > reference ? "UP" : "DOWN", quality: "VERIFIED_SETTLEMENT" };
}

export function primaryDecisionWindow(observedMs: number, expiryMs: number): boolean {
  if (!Number.isSafeInteger(expiryMs) || !Number.isFinite(observedMs)) return false;
  const seconds = (expiryMs - observedMs) / 1000;
  return seconds >= 30 && seconds <= 45;
}

export function isCurrentUnexpiredRound(
  expectedId: string,
  expectedExpiryMs: number,
  current: { id: string; expiryMs: number } | null,
  nowMs: number,
): boolean {
  return current !== null &&
    current.id === expectedId &&
    current.expiryMs === expectedExpiryMs &&
    Number.isSafeInteger(current.expiryMs) &&
    Number.isFinite(nowMs) &&
    current.expiryMs > nowMs;
}

export const PRIMARY_CAPTURE_RETRY_MS = 2_500;
export const PRIMARY_CAPTURE_START_REMAINING_MS = 44_000;
export const STANDARD_SNAPSHOT_BUCKET_MS = 15_000;
export const PRIMARY_SNAPSHOT_BUCKET_MS = 3_000;

/**
 * Reconstructible, round-expiry-based capture schedule. The first targeted
 * read begins inside the unchanged 45–30s scoring horizon; retries continue
 * only while a read can still finish in that horizon.
 */
export function nextPrimaryCaptureDelayMs(expiryMs: number, nowMs: number): number | null {
  if (!Number.isSafeInteger(expiryMs) || !Number.isFinite(nowMs)) return null;
  const remainingMs = expiryMs - nowMs;
  if (remainingMs > 45_000)
    return Math.max(0, remainingMs - PRIMARY_CAPTURE_START_REMAINING_MS);
  if (remainingMs <= 30_000) return null;
  return Math.max(0, Math.min(PRIMARY_CAPTURE_RETRY_MS, remainingMs - 30_000));
}

export function snapshotBucketWidthMs(observedMs: number, expiryMs: number): number {
  return primaryDecisionWindow(observedMs, expiryMs)
    ? PRIMARY_SNAPSHOT_BUCKET_MS : STANDARD_SNAPSHOT_BUCKET_MS;
}

export function probabilityLoss(probabilityUp: number, outcome: "UP" | "DOWN") {
  if (!Number.isFinite(probabilityUp) || probabilityUp < 0 || probabilityUp > 1)
    throw new Error("Probability must be between zero and one");
  const target = outcome === "UP" ? 1 : 0;
  const probabilityOfOutcome = outcome === "UP" ? probabilityUp : 1 - probabilityUp;
  return {
    brier: (probabilityUp - target) ** 2,
    logLoss: -Math.log(Math.max(1e-9, probabilityOfOutcome)),
  };
}