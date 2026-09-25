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

// A conservative net-edge gate; no signed/executable price means no recommendation.
export function recommendation(input: {
  hasRound: boolean; expiryMs?: number; now: number; referencePrice?: number | null;
  estimatedUp?: number | null; executableUp?: number | null; executableDown?: number | null;
  payoutAfterFees?: number | null; calibratedSamples: number; edgeThreshold: number;
}): { action: "UP" | "DOWN" | "HOLD"; reason: string } {
  if (!input.hasRound || !input.expiryMs || input.expiryMs - input.now <= 8_000)
    return { action: "HOLD", reason: "No verified eligible one-minute round with enough time remaining." };
  if (!input.referencePrice) return { action: "HOLD", reason: "The round's on-chain reference price is not yet available." };
  if (input.estimatedUp == null || input.calibratedSamples < 200)
    return { action: "HOLD", reason: "No calibrated, held-out estimate is available for this round." };
  if (input.executableUp == null || input.executableDown == null || input.payoutAfterFees == null)
    return { action: "HOLD", reason: "Executable prices, payout terms, or fees are unavailable; indicative on-chain probabilities are not purchase quotes." };
  const pUp = input.estimatedUp;
  const up = pUp * input.payoutAfterFees / input.executableUp - 1;
  const down = (1 - pUp) * input.payoutAfterFees / input.executableDown - 1;
  if (Math.max(up, down) <= input.edgeThreshold)
    return { action: "HOLD", reason: "Estimated net edge does not clear the configured threshold." };
  return { action: up > down ? "UP" : "DOWN", reason: "Calibrated edge clears the threshold after verified price, payout, and fee assumptions." };
}

export function hedge(input: {
  sameRound: boolean; quoteFresh: boolean; payoutKnown: boolean;
  stake: number; entryPrice: number; oppositePrice: number; payout: number;
}) {
  if (!input.sameRound || !input.quoteFresh || !input.payoutKnown) return null;
  if (![input.stake,input.entryPrice,input.oppositePrice,input.payout].every(x => Number.isFinite(x) && x > 0)) return null;
  const originalUnits = input.stake / input.entryPrice;
  const hedgeUnits = originalUnits;
  const hedgeCost = hedgeUnits * input.oppositePrice;
  return {
    hedgeCost,
    unhedgedWin: originalUnits * input.payout - input.stake,
    unhedgedLose: -input.stake,
    hedgedUp: originalUnits * input.payout - input.stake - hedgeCost,
    hedgedDown: hedgeUnits * input.payout - input.stake - hedgeCost,
  };
}