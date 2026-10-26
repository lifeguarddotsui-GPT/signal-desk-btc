/**
 * Read-only $5 WaterX profitability research. Nothing in this module can
 * qualify a live order or promote a model. A quote is NOT evidence of a fill.
 *
 * Receipt convention: allInCost includes entry charges; gross receipts less
 * receipt-side fees are paid out on settlement. Network expense is separate
 * and must be explicitly known (zero is valid only if verified).
 */
export type Side = "UP" | "DOWN";
export type AuditDecision = Side | "NO_TRADE";
export type VerifiableQuote = Readonly<{
  roundKey: string;
  quoteId: string;
  kind: "EXECUTABLE" | "INDICATIVE";
  quotedAtMs: number;
  expiresAtMs: number;
  allInCostUsd: number;
  grossWinningReceiptUsd: number;
  winningReceiptFeesUsd: number;
  grossLosingReceiptUsd: number;
  losingReceiptFeesUsd: number;
  networkCostUsd: number | null;
  feesVerified: boolean;
  receiptVerified: boolean;
}>;
export type ValueEvidenceRow = Readonly<{
  roundKey: string;
  intervalMinutes: 5 | 15;
  startMs: number;
  expiryMs: number;
  decisionAtMs: number;
  decision: AuditDecision;
  modelProbabilityForDecision: number | null;
  independentModel: boolean;
  quote: VerifiableQuote | null;
  settlement: null | Readonly<{
    outcome: Side;
    source: "WATERX_VERIFIED" | "UNVERIFIED";
    disputed: boolean;
    observedAtMs: number;
  }>;
}>;
export type BinaryValue = Readonly<{
  allInCostUsd: number;
  winNetProfitUsd: number;
  lossNetProfitUsd: number;
  breakEvenProbability: number;
  expectedNetUsd: number;
  profitPerWinningFiveUsd: number | null;
}>;

function validNonnegative(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}
function validProbability(x: unknown): x is number {
  return validNonnegative(x) && x <= 1;
}

/** Uses verified receipts, not quoted probability / share price as forecast.
 * Returns null rather than treating unknown gas or fees as free. */
export function binaryValue(
  quote: Pick<VerifiableQuote, "allInCostUsd" | "grossWinningReceiptUsd" |
    "winningReceiptFeesUsd" | "grossLosingReceiptUsd" |
    "losingReceiptFeesUsd" | "networkCostUsd" | "feesVerified" | "receiptVerified">,
  probability: number,
): BinaryValue | null {
  if (!validProbability(probability) || !quote.feesVerified || !quote.receiptVerified ||
    ![quote.allInCostUsd, quote.grossWinningReceiptUsd, quote.winningReceiptFeesUsd,
      quote.grossLosingReceiptUsd, quote.losingReceiptFeesUsd, quote.networkCostUsd]
      .every(validNonnegative) || quote.allInCostUsd <= 0 ||
      quote.winningReceiptFeesUsd > quote.grossWinningReceiptUsd ||
      quote.losingReceiptFeesUsd > quote.grossLosingReceiptUsd) return null;
  const cost = quote.allInCostUsd + quote.networkCostUsd!;
  const winReceipt = quote.grossWinningReceiptUsd - quote.winningReceiptFeesUsd;
  const loseReceipt = quote.grossLosingReceiptUsd - quote.losingReceiptFeesUsd;
  if (!Number.isFinite(cost) || cost <= 0 || winReceipt <= loseReceipt ||
    !Number.isFinite(winReceipt) || !Number.isFinite(loseReceipt)) return null;
  const winNetProfitUsd = winReceipt - cost;
  const lossNetProfitUsd = loseReceipt - cost;
  const breakEvenProbability = -lossNetProfitUsd / (winNetProfitUsd - lossNetProfitUsd);
  return {
    allInCostUsd: cost, winNetProfitUsd, lossNetProfitUsd, breakEvenProbability,
    expectedNetUsd: probability * winNetProfitUsd + (1 - probability) * lossNetProfitUsd,
    profitPerWinningFiveUsd: Math.abs(cost - 5) < 1e-9 ? winNetProfitUsd : null,
  };
}

/** Two-sided 95% Wilson interval (iid Bernoulli assumption). Report alongside
 * correlation caveat; never use it by itself to authorize a trade. */
export function wilson95(wins: number, attempts: number): {
  lower: number; upper: number;
} | null {
  if (!Number.isSafeInteger(wins) || !Number.isSafeInteger(attempts) ||
      attempts <= 0 || wins < 0 || wins > attempts) return null;
  const z = 1.959963984540054;
  const p = wins / attempts, z2 = z * z;
  const denominator = 1 + z2 / attempts;
  const center = (p + z2 / (2 * attempts)) / denominator;
  const radius = z / denominator *
    Math.sqrt(p * (1 - p) / attempts + z2 / (4 * attempts * attempts));
  return { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) };
}

export type ValueAudit = Readonly<{
  verdict: "NO_TRADE_RESEARCH_ONLY";
  captured: number;
  noTradeCaptured: number;
  signaled: number;
  matchedVerifiedQuoteAndOutcome: number;
  missingOrInvalidEvidence: number;
  duplicateRoundKeys: number;
  wins: number;
  losses: number;
  observedWinRate: number | null;
  wilson95AssumingIndependent: { lower: number; upper: number } | null;
  meanPredictedProbability: number | null;
  brierForChosenSide: number | null;
  quoteMatchedCounterfactualNetUsd: number | null;
  meanModelExpectedNetUsd: number | null;
  meanQuoteBreakEvenProbability: number | null;
  hypotheticalTargetWinProfitCount: number;
  reasons: string[];
}>;

/** Point-in-time cohort audit. Every signal, missed quote, bad settlement,
 * and NO_TRADE decision remains in the denominator. No selection by winners.
 * The P&L is counterfactual at the recorded quote, NEVER realized or fillable P&L.
 */
export function auditWaterxValueCohort(rows: readonly ValueEvidenceRow[]): ValueAudit {
  let noTradeCaptured = 0, signaled = 0, matched = 0, wins = 0;
  let duplicateRoundKeys = 0, net = 0, ev = 0, brier = 0, probabilitySum = 0;
  let breakEvenSum = 0, target = 0;
  const seen = new Set<string>();
  const reasons = new Set<string>();
  for (const row of rows) {
    if (!row.roundKey || seen.has(row.roundKey)) {
      duplicateRoundKeys++;
      reasons.add("Duplicate or empty round identity; duplicate signals are excluded.");
      continue;
    }
    seen.add(row.roundKey);
    if (row.decision === "NO_TRADE") { noTradeCaptured++; continue; }
    signaled++;
    if (!["UP", "DOWN"].includes(row.decision) ||
      ![5, 15].includes(row.intervalMinutes) ||
      ![row.startMs, row.expiryMs, row.decisionAtMs].every(Number.isSafeInteger) ||
      row.expiryMs - row.startMs !== row.intervalMinutes * 60_000 ||
      row.decisionAtMs < row.startMs || row.decisionAtMs >= row.expiryMs ||
      !validProbability(row.modelProbabilityForDecision) || !row.independentModel) {
      reasons.add("Missing qualified independent decision-time probability or valid round identity.");
      continue;
    }
    const q = row.quote, s = row.settlement;
    if (!q || q.roundKey !== row.roundKey || !q.quoteId ||
      q.kind !== "EXECUTABLE" || q.quotedAtMs > row.decisionAtMs ||
      q.quotedAtMs < row.startMs || row.decisionAtMs - q.quotedAtMs > 10_000 ||
      row.decisionAtMs >= q.expiresAtMs || q.expiresAtMs > row.expiryMs ||
      row.expiryMs - row.decisionAtMs < 10_000 ||
      !s || s.source !== "WATERX_VERIFIED" || s.disputed ||
      !Number.isFinite(s.observedAtMs) || s.observedAtMs < row.expiryMs) {
      reasons.add("A fresh executable quote, cutoff proof or verified undisputed WaterX settlement is missing.");
      continue;
    }
    const value = binaryValue(q, row.modelProbabilityForDecision!);
    if (!value || value.allInCostUsd > 5.001 ||
      value.allInCostUsd < 4.999 || !Number.isFinite(value.breakEvenProbability) ||
      value.breakEvenProbability < 0 || value.breakEvenProbability > 1) {
      reasons.add("The complete, independently priced $5 receipt/fee economics are missing or invalid.");
      continue;
    }
    const hit = row.decision === s.outcome;
    matched++;
    wins += Number(hit);
    net += hit ? value.winNetProfitUsd : value.lossNetProfitUsd;
    ev += value.expectedNetUsd;
    brier += (row.modelProbabilityForDecision! - Number(hit)) ** 2;
    probabilitySum += row.modelProbabilityForDecision!;
    breakEvenSum += value.breakEvenProbability;
    if (value.winNetProfitUsd >= 1 && value.winNetProfitUsd <= 2) target++;
  }
  if (!matched) reasons.add("No verified quote-matched, settled, independent-model signals.");
  if (matched < 300) reasons.add("Fewer than 300 matched signals; uncertainty remains substantial.");
  if (matched !== signaled) reasons.add("Some captured signals lack complete matched evidence; they cannot be silently dropped.");
  if (duplicateRoundKeys) reasons.add("Duplicate rounds require investigation before inference.");
  reasons.add("Quote-matched counterfactuals do not prove fillability, execution latency or realized profit.");
  reasons.add("Wilson intervals assume independent comparable rounds; autocorrelation needs block-based evaluation.");
  return {
    verdict: "NO_TRADE_RESEARCH_ONLY", captured: rows.length, noTradeCaptured, signaled,
    matchedVerifiedQuoteAndOutcome: matched, missingOrInvalidEvidence: signaled - matched,
    duplicateRoundKeys, wins, losses: matched - wins, observedWinRate: matched ? wins / matched : null,
    wilson95AssumingIndependent: wilson95(wins, matched),
    meanPredictedProbability: matched ? probabilitySum / matched : null,
    brierForChosenSide: matched ? brier / matched : null,
    quoteMatchedCounterfactualNetUsd: matched ? net : null,
    meanModelExpectedNetUsd: matched ? ev / matched : null,
    meanQuoteBreakEvenProbability: matched ? breakEvenSum / matched : null,
    hypotheticalTargetWinProfitCount: target,
    reasons: Array.from(reasons),
  };
}
