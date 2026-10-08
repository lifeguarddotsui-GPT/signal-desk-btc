/** WaterX BTC mainnet round identity. Strategy versions are separate cohorts,
 * not different provider rounds. Never join by a nearby timestamp alone. */
export type WaterxRoundIdentity = {
  intervalMinutes: 5 | 15; roundId: string; startMs: number; expiryMs: number;
};
export function canonicalWaterxRoundKey(round: WaterxRoundIdentity): string {
  if (![5, 15].includes(round.intervalMinutes) || !round.roundId ||
      !Number.isSafeInteger(round.startMs) || !Number.isSafeInteger(round.expiryMs) ||
      round.startMs < 0 || round.expiryMs - round.startMs !== round.intervalMinutes * 60_000)
    throw new Error("WATERX_INVALID_ROUND_IDENTITY");
  return JSON.stringify(["sui:mainnet", "WaterX:BTC", round.intervalMinutes,
    round.roundId, round.startMs, round.expiryMs]);
}
export function sameWaterxRound(left: WaterxRoundIdentity, right: WaterxRoundIdentity): boolean {
  try { return canonicalWaterxRoundKey(left) === canonicalWaterxRoundKey(right); }
  catch { return false; }
}
export type SettlementStatus = "VERIFIED" | "PENDING" | "WITHHELD" | "DISPUTED" | "MISSING" | "IDENTITY_MISMATCH";
export type StageScore = "CORRECT" | "INCORRECT" | "PENDING" | "WITHHELD" | "DISPUTED" |
  "NO_LOCK" | "ABSTAINED" | "DATA_FAILURE" | "IDENTITY_MISMATCH" | "OBSERVING";
export function stageScore(input: {
  side: "UP" | "DOWN" | null; outcome: "UP" | "DOWN" | null;
  settlementStatus: SettlementStatus; reason: string; dataFailure: boolean;
}): StageScore {
  if (!input.side) {
    // A recovered source incident is not the terminal cause of an abstention.
    if (/POLICY_NOT_QUALIFIED|ABSTAIN|BELOW_POLICY|PERSISTENCE_INCOMPLETE|STABILITY_WINDOW|ADDITIONAL_EVIDENCE|NO_QUALIFYING|NO_QUALIFIED_LOCK|NO_QUALIFIED_SIGNAL|CALIBRATED_DIRECTION_CONFLICT/.test(input.reason) &&
        !/DATABASE|DATA_UNAVAILABLE|STALE|FRESH_DATA|COMMIT/.test(input.reason))
      return "ABSTAINED";
    if (input.dataFailure || /MISSED_DEADLINE|MISSING.*ASSESSMENT|DATABASE|STALE|FRESH_DATA|COMMIT|NO_VALID_INPUT|SERVICE_INTERRUPTED|SCHEDULER_FAILURE|INSUFFICIENT_PRICE_COVERAGE/.test(input.reason))
      return "DATA_FAILURE";
    if (/POLICY_NOT_QUALIFIED|ABSTAIN|BELOW_POLICY|PERSISTENCE_INCOMPLETE|STABILITY_WINDOW/.test(input.reason))
      return "ABSTAINED";
    return "NO_LOCK";
  }
  if (input.settlementStatus === "VERIFIED" && input.outcome)
    return input.side === input.outcome ? "CORRECT" : "INCORRECT";
  if (input.settlementStatus === "DISPUTED") return "DISPUTED";
  if (input.settlementStatus === "WITHHELD") return "WITHHELD";
  if (input.settlementStatus === "IDENTITY_MISMATCH") return "IDENTITY_MISMATCH";
  return "PENDING";
}
