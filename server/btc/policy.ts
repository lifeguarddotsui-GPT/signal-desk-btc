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