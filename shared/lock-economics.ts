/** Economic evidence is independent of market probability and order authority. */
export const VALUE_EVIDENCE_VERSION = "waterx-entry-value-v1";
export type ValuePreference = { collateralUsd: number; minimumReturnUsd: number; preferredReturnUsd: number };
export const defaultValuePreference: ValuePreference = { collateralUsd: 5, minimumReturnUsd: 6, preferredReturnUsd: 7 };
export function validateValuePreference(p: ValuePreference): ValuePreference {
  if (![p.collateralUsd, p.minimumReturnUsd, p.preferredReturnUsd].every(Number.isFinite) ||
    p.collateralUsd <= 0 || p.minimumReturnUsd <= p.collateralUsd || p.preferredReturnUsd < p.minimumReturnUsd)
    throw new Error("Review positive collateral and return preferences; preferred return is not a maximum.");
  return { ...p };
}
export type VerifiedEntryQuote = {
  verified: true; fullSize: true; network: "sui:mainnet";
  roundId: string; marketId: string; side: "UP" | "DOWN"; quoteId: string;
  quotedAtMs: number; expiresAtMs: number; executionCutoffAtMs: number;
  collateralUsd: number; feesUsd: number; totalEntryCostUsd: number;
  shares: string; payoutRule: string; returnedIfCorrectUsd: number; returnedIfIncorrectUsd: number;
  gasSui: number; gasUsd: number; gasValuationBasis: string;
  partialFill: "FILL_OR_KILL"; limitsEnforced: true;
  maxSpendUsd: number; minimumShares: string; maximumPrice: number;
};
export type QualifiedForecast = { status: "QUALIFIED"; probability: number; modelVersion: string; calibrationVersion: string; source: "INDEPENDENT_MODEL" };
export type EntryEconomics = {
  version: typeof VALUE_EVIDENCE_VERSION; kind: "INDICATIVE" | "VERIFIED_QUOTE" | "UNAVAILABLE";
  collateralUsd: number; totalReturnedIfCorrectUsd: number | null;
  netProfitIfCorrectUsd: number | null; lossIfIncorrectUsd: number | null;
  totalCostUsd: number | null; feesUsd: number | null; gasSui: number | null; gasUsd: number | null;
  gasValuationBasis: string | null; shares: string | null; payoutRule: string | null;
  quoteId: string | null; quoteAgeMs: number | null; quoteExpiresAtMs: number | null;
  partialFill: string | null; limits: { maxSpendUsd: number; minimumShares: string; maximumPrice: number } | null;
  expectedNetUsd: number | null; forecast: QualifiedForecast | null;
  preferenceMet: boolean | null; preference: ValuePreference;
  executionEligible: false; reason: string;
};
export function entryEconomics(input: {
  roundId: string; marketId: string; side: "UP" | "DOWN"; nowMs: number;
  askCents?: number | null; quote?: VerifiedEntryQuote | null; forecast?: QualifiedForecast | null;
  preference?: ValuePreference;
}): EntryEconomics {
  const p = validateValuePreference(input.preference ?? defaultValuePreference);
  const base: EntryEconomics = { version: VALUE_EVIDENCE_VERSION, kind: "UNAVAILABLE", collateralUsd: p.collateralUsd,
    totalReturnedIfCorrectUsd: null, netProfitIfCorrectUsd: null, lossIfIncorrectUsd: null, totalCostUsd: null,
    feesUsd: null, gasSui: null, gasUsd: null, gasValuationBasis: null, shares: null, payoutRule: null,
    quoteId: null, quoteAgeMs: null, quoteExpiresAtMs: null, partialFill: null, limits: null,
    expectedNetUsd: null, forecast: null, preferenceMet: null, preference: p, executionEligible: false,
    reason: "Full-size purchase terms, fees, gas and execution limits are unverified." };
  const q = input.quote;
  if (!q) {
    if (typeof input.askCents === "number" && Number.isFinite(input.askCents) && input.askCents > 0 && input.askCents <= 100) {
      const gross = p.collateralUsd / (input.askCents / 100);
      return { ...base, kind: "INDICATIVE", totalReturnedIfCorrectUsd: gross,
        payoutRule: "Illustration only: $1 per share on a win, zero recovery on loss; protocol terms unverified.",
        reason: "Indicative ask-based gross return before unknown fees/gas. No full-size fill, independent confidence, positive edge or trading P/L is claimed." };
    }
    return base;
  }
  const quantities = [q.collateralUsd, q.feesUsd, q.totalEntryCostUsd, q.returnedIfCorrectUsd,
    q.returnedIfIncorrectUsd, q.gasSui, q.gasUsd, q.maxSpendUsd, q.maximumPrice];
  if (q.verified !== true || q.fullSize !== true || q.network !== "sui:mainnet" ||
    q.roundId !== input.roundId || q.marketId !== input.marketId || q.side !== input.side ||
    !q.quoteId || !q.payoutRule || !q.gasValuationBasis ||
    !quantities.every(v => Number.isFinite(v) && v >= 0) ||
    q.collateralUsd !== p.collateralUsd || q.totalEntryCostUsd <= 0 || q.returnedIfCorrectUsd <= 0 ||
    Math.abs(q.totalEntryCostUsd - q.collateralUsd - q.feesUsd) > 1e-8 ||
    q.totalEntryCostUsd > q.maxSpendUsd || q.returnedIfIncorrectUsd > q.totalEntryCostUsd + q.gasUsd ||
    !/^[1-9]\d*$/.test(q.shares) || !/^[1-9]\d*$/.test(q.minimumShares) ||
    BigInt(q.shares) < BigInt(q.minimumShares) || q.maximumPrice <= 0 || q.maximumPrice > 1 ||
    q.partialFill !== "FILL_OR_KILL" || q.limitsEnforced !== true ||
    ![q.quotedAtMs, q.expiresAtMs, q.executionCutoffAtMs, input.nowMs].every(Number.isSafeInteger) ||
    q.quotedAtMs > input.nowMs || input.nowMs - q.quotedAtMs > 10_000 ||
    q.expiresAtMs <= input.nowMs || q.executionCutoffAtMs <= input.nowMs)
    return { ...base, reason: "Quote identity, full size, accounting, freshness, payout or enforceable execution limits failed verification." };
  const f = input.forecast;
  const qualified = f?.status === "QUALIFIED" && f.source === "INDEPENDENT_MODEL" &&
    !!f.modelVersion && !!f.calibrationVersion && Number.isFinite(f.probability) && f.probability >= 0 && f.probability <= 1;
  // totalEntryCost already contains fees. Gas is added once, not again as a fee.
  const cost = q.totalEntryCostUsd + q.gasUsd;
  return { ...base, kind: "VERIFIED_QUOTE", totalCostUsd: cost, feesUsd: q.feesUsd,
    gasSui: q.gasSui, gasUsd: q.gasUsd, gasValuationBasis: q.gasValuationBasis,
    shares: q.shares, payoutRule: q.payoutRule, totalReturnedIfCorrectUsd: q.returnedIfCorrectUsd,
    netProfitIfCorrectUsd: q.returnedIfCorrectUsd - cost, lossIfIncorrectUsd: cost - q.returnedIfIncorrectUsd,
    quoteId: q.quoteId, quoteAgeMs: input.nowMs - q.quotedAtMs, quoteExpiresAtMs: q.expiresAtMs,
    partialFill: q.partialFill, limits: { maxSpendUsd: q.maxSpendUsd, minimumShares: q.minimumShares, maximumPrice: q.maximumPrice },
    forecast: qualified ? f! : null,
    expectedNetUsd: qualified ? f!.probability * q.returnedIfCorrectUsd + (1 - f!.probability) * q.returnedIfIncorrectUsd - cost : null,
    preferenceMet: q.returnedIfCorrectUsd >= p.minimumReturnUsd,
    reason: qualified ? "Quote-adjusted model estimate; refresh and reverify before execution. This research record grants no order authority."
      : "Full-size quote verified; model-derived expected value is unavailable until independent calibration qualifies." };
}
/** Recompute from frozen decision-time terms, never today's price or later odds. */
export function economicEvidenceFromFeatures(features: Record<string, unknown> | undefined,
  roundId: string, side: "UP" | "DOWN", atMs: number): EntryEconomics {
  const purchase = features?.[side === "UP" ? "purchaseUp" : "purchaseDown"] as { status?: string; askCents?: number } | undefined;
  return entryEconomics({ roundId, marketId: String(features?.marketId ?? ""), side, nowMs: atMs,
    preference:features?.researchValuePreference as ValuePreference|undefined,
    askCents: purchase?.status === "reported" ? purchase.askCents : null,
    quote:features?.executableQuote as VerifiedEntryQuote|null|undefined,
    forecast:features?.qualifiedForecast as QualifiedForecast|null|undefined });
}
export function frozenEntryFeatures(evidence:Record<string,unknown>,observationId:string|null,decisionAtMs:number){
  const direct=evidence.latestFeatures??evidence.features;
  if(direct&&typeof direct==="object"&&!Array.isArray(direct))return direct as Record<string,unknown>;
  // Older event locks already froze the source observations. Reuse only the
  // selected receipt and its proven availability, not a later price change.
  const observations=Array.isArray(evidence.observations)?evidence.observations:[];
  const selected=observations.find(o=>o?.id===observationId&&Number.isSafeInteger(o.availableAtMs)&&
    Number.isSafeInteger(o.receivedAtMs)&&o.receivedAtMs<=o.availableAtMs&&o.availableAtMs<=decisionAtMs);
  return selected?.features as Record<string,unknown>|undefined;
}
