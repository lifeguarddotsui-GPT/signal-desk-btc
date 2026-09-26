export type Outcome = "UP" | "DOWN";
export type Labeled = { id: string; expiryMs: number; outcome: Outcome; up: number };

export function evaluateBaseline(rows: Labeled[], probability: (row: Labeled) => number) {
  if (!rows.length) return null;
  let brier = 0, logLoss = 0;
  for (const row of rows) {
    const p = probability(row);
    if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error("Invalid historic probability");
    const y = row.outcome === "UP" ? 1 : 0;
    brier += (p - y) ** 2;
    logLoss -= y * Math.log(Math.max(1e-12, p)) + (1 - y) * Math.log(Math.max(1e-12, 1 - p));
  }
  return { brier: brier / rows.length, logLoss: logLoss / rows.length, count: rows.length };
}

export function strictWalkForward(rows: Labeled[], train = 100, calibration = 50, test = 50) {
  const ordered = [...rows].sort((a, b) => a.expiryMs - b.expiryMs);
  const unique = ordered.filter((row, index) => index === 0 ||
    row.id !== ordered[index - 1].id && row.expiryMs > ordered[index - 1].expiryMs);
  if (unique.length < train + calibration + test) return null;
  const trainRows = unique.slice(0, train), calibrateRows = unique.slice(train, train + calibration);
  const heldOut = unique.slice(train + calibration);
  if (trainRows.at(-1)!.expiryMs >= calibrateRows[0].expiryMs ||
    calibrateRows.at(-1)!.expiryMs >= heldOut[0].expiryMs) throw new Error("Overlapping evaluation windows");
  return { train: trainRows, calibrate: calibrateRows, test: heldOut };
}

export type DecisionInput = {
  hasRound: boolean; expiryMs?: number; now: number; referencePrice?: number | null;
  estimatedUp?: number | null; executableUp?: number | null; executableDown?: number | null;
  payoutAfterFees?: number | null; calibratedSamples: number; edgeThreshold: number;
  roundAsOf?: string | null; modelAsOf?: string | null; quoteAsOf?: string | null;
};

// This audit and the action are computed from the same gates. An unknown input never passes.
export function recommendation(input: DecisionInput) {
  const roundReady = input.hasRound && input.expiryMs != null && input.expiryMs - input.now > 8_000;
  const referenceReady = input.referencePrice != null && Number.isFinite(input.referencePrice) && input.referencePrice > 0;
  const modelReady = input.estimatedUp != null && Number.isFinite(input.estimatedUp) &&
    input.estimatedUp >= 0 && input.estimatedUp <= 1 && input.calibratedSamples >= 200;
  const economicsReady = input.executableUp != null && Number.isFinite(input.executableUp) && input.executableUp > 0 &&
    input.executableDown != null && Number.isFinite(input.executableDown) && input.executableDown > 0 &&
    input.payoutAfterFees != null && Number.isFinite(input.payoutAfterFees) && input.payoutAfterFees > 0;
  const eligibleForEdge = roundReady && referenceReady && modelReady && economicsReady;
  const pUp = input.estimatedUp ?? 0;
  const up = eligibleForEdge ? pUp * input.payoutAfterFees! / input.executableUp! - 1 : null;
  const down = eligibleForEdge ? (1 - pUp) * input.payoutAfterFees! / input.executableDown! - 1 : null;
  const edgeReady = up !== null && down !== null && Math.max(up, down) > input.edgeThreshold;
  const checks = [
    {
      id: "round", label: "Eligible round and time", status: roundReady ? "PASS" : "BLOCKED",
      observed: input.hasRound && input.expiryMs != null
        ? `${Math.max(0, (input.expiryMs - input.now) / 1_000).toFixed(1)}s remaining` : "No verified active round",
      required: "Verified one-minute round with more than 8s remaining",
      source: "On-chain market read", asOf: input.roundAsOf ?? null,
      explanation: "An expired, paused, stale, or too-late round cannot produce a trade suggestion.",
    },
    {
      id: "reference", label: "Settlement reference", status: referenceReady && roundReady ? "PASS" : "BLOCKED",
      observed: referenceReady && roundReady ? input.referencePrice!.toFixed(2) : "Unavailable for an eligible round",
      required: "Positive on-chain round reference", source: "DeepBook market state",
      asOf: roundReady ? input.roundAsOf ?? null : null,
      explanation: "Coinbase comparison is not the settlement oracle and cannot replace this reference.",
    },
    {
      id: "model", label: "Validated forecast", status: modelReady ? "PASS" : "BLOCKED",
      observed: modelReady ? `${(input.estimatedUp! * 100).toFixed(1)}% model UP · ${input.calibratedSamples} calibrated samples`
        : `No promoted calibrated forecast · ${input.calibratedSamples} / 200 qualifying samples`,
      required: "Promoted held-out calibrated forecast with at least 200 qualifying samples",
      source: "Independent model evaluation", asOf: input.modelAsOf ?? null,
      explanation: "Indicative board odds and Coinbase movement are not calibrated model predictions.",
    },
    {
      id: "economics", label: "Executable economics", status: economicsReady ? "PASS" : "BLOCKED",
      observed: economicsReady ? `UP ${input.executableUp!.toFixed(4)} · DOWN ${input.executableDown!.toFixed(4)} · net payout ${input.payoutAfterFees!.toFixed(4)}`
        : "Executable UP/DOWN prices or net payout and fees unavailable",
      required: "Verified executable prices, payout and fee terms",
      source: "Executable order route and verified contract terms", asOf: input.quoteAsOf ?? null,
      explanation: "On-chain indicative odds are not a fill price. No return or hedge can be calculated from them.",
    },
    {
      id: "edge", label: "Net edge", status: !eligibleForEdge ? "NOT_EVALUATED" : edgeReady ? "PASS" : "BLOCKED",
      observed: !eligibleForEdge ? "Not calculated: prerequisite inputs missing"
        : `Best net edge ${(Math.max(up!, down!) * 100).toFixed(2)}%`,
      required: `Greater than ${(input.edgeThreshold * 100).toFixed(1)}% after verified terms`,
      source: "Conservative net-return rule", asOf: eligibleForEdge ? new Date(input.now).toISOString() : null,
      explanation: "A price direction or a high board probability alone is not a profitable trade.",
    },
  ] as const;
  const audit = {
    evaluatedAt: new Date(input.now).toISOString(),
    policy: { minRemainingSeconds: 8, minCalibratedSamples: 200, minNetEdge: input.edgeThreshold },
    checks,
    summary: edgeReady ? "All five decision checks passed." :
      `HOLD: ${checks.filter(check => check.status === "BLOCKED").map(check => check.label).join(", ")}. ` +
      (!eligibleForEdge ? "Net edge cannot be evaluated." : "Net edge does not clear the threshold."),
  };
  if (!roundReady) return { action: "HOLD" as const, reason: "No verified eligible one-minute round with enough time remaining.", audit };
  if (!referenceReady) return { action: "HOLD" as const, reason: "The round's on-chain reference price is not yet available.", audit };
  if (!modelReady) return { action: "HOLD" as const, reason: "No calibrated, held-out estimate is available for this round.", audit };
  if (!economicsReady) return { action: "HOLD" as const, reason: "Executable prices, payout terms, or fees are unavailable; indicative on-chain probabilities are not purchase quotes.", audit };
  if (!edgeReady) return { action: "HOLD" as const, reason: "Estimated net edge does not clear the configured threshold.", audit };
  return { action: up! > down! ? "UP" as const : "DOWN" as const,
    reason: "Calibrated edge clears the threshold after verified price, payout, and fee assumptions.", audit };
}
