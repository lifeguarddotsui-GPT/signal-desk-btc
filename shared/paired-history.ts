/** Paired round projection. No retrospective choice construction or P/L inference. */
export type Direction = "UP" | "DOWN";
export type Score = "CORRECT" | "INCORRECT" | "PENDING" | "DISPUTED" |
  "UNRECORDED" | "ABSTAINED" | "DATA_FAILURE";
export type Congruence = "AGREE" | "DISAGREE" | "NOT_COMPARABLE";
export type PairedWinner = "BOTH_CORRECT" | "EARLY_ONLY_CORRECT" | "CONFIRMATION_ONLY_CORRECT" |
  "BOTH_INCORRECT" | "NOT_COMPARABLE";
export type SettlementStatus = "VERIFIED" | "PENDING" | "DISPUTED" | "WITHHELD" | "NOT_OBSERVED";
export type Stage = {
  side: Direction | null;
  status: string;
  probabilityUp: number | null;
  decisionAtMs: number | null;
  secondsBeforeExpiry: number | null;
  result: Score;
};
export type BenchmarkStage = Stage & { recordStatus: "FROZEN" | "MISSING" | "AMBIGUOUS" | "INVALID" };
export type PairedRow = {
  intervalMinutes: 5 | 15; roundId: string; startMs: number; expiryMs: number;
  early: Stage; confirmation: Stage; benchmark: BenchmarkStage; congruence: Congruence; pairedWinner: PairedWinner;
  outcome: Direction | null; settlement: SettlementStatus;
  diagnostics: { gateCount: number; missedGates: number; waitsForFreshData: number; qualifiedGates: number;
    confirmationCause: string };
};
export type StageSummary = {
  correct: number; incorrect: number; unrecorded: number; pending: number;
  disputed: number; abstained: number; dataFailures: number; locks: number; accuracy: number | null;
};
export const stageScore = (side: Direction | null, status: string, verifiedOutcome: Direction | null,
  disputed: boolean): Score => {
  if (status === "ABSTAINED_NO_QUALIFIED_SIGNAL") return "ABSTAINED";
  if (status === "DATA_FAILURE" || status === "MISSED_DEADLINE" || status === "NO_VALID_INPUT") return "DATA_FAILURE";
  if (status !== "LOCKED" || side === null) return "UNRECORDED";
  if (disputed) return "DISPUTED";
  if (verifiedOutcome === null) return "PENDING";
  return side === verifiedOutcome ? "CORRECT" : "INCORRECT";
};
/** Audit an independently persisted, prospective market-baseline decision.
 * NEVER turn a baseline into a qualified Confirmation Lock. A duplicate or malformed
 * record remains unscored, and no subsequent odds are used to reconstruct a choice. */
export function projectFrozenBenchmark(choices: readonly unknown[], outcome: Direction | null, disputed: boolean,
  roundStartMs: number, roundExpiryMs: number): BenchmarkStage {
  const empty = (recordStatus: BenchmarkStage["recordStatus"]): BenchmarkStage => ({
    side: null, status: "UNRECORDED", probabilityUp: null, decisionAtMs: null,
    secondsBeforeExpiry: null, result: "UNRECORDED", recordStatus
  });
  if (choices.length === 0) return empty("MISSING");
  if (choices.length !== 1) return empty("AMBIGUOUS");
  const c = choices[0];
  if (!c || typeof c !== "object") return empty("INVALID");
  const choice = c as Record<string, unknown>;
  const side = choice.side === "UP" || choice.side === "DOWN" ? choice.side : null;
  const at = choice.decision_at_ms == null ? NaN : Number(choice.decision_at_ms);
  const probability = choice.probability_up == null ? null : Number(choice.probability_up);
  if (choice.state !== "FROZEN" || !side || !Number.isSafeInteger(at) ||
    at < roundStartMs || at >= roundExpiryMs ||
    (probability !== null && (!Number.isFinite(probability) || probability < 0 || probability > 1)))
    return empty("INVALID");
  return { side, status: "LOCKED", probabilityUp: probability, decisionAtMs: at,
    secondsBeforeExpiry: (roundExpiryMs - at) / 1000,
    result: stageScore(side, "LOCKED", outcome, disputed), recordStatus: "FROZEN" };
}

export function comparePaired(early: Stage, confirmation: Stage): { congruence: Congruence; pairedWinner: PairedWinner } {
  if (!early.side || !confirmation.side || early.status !== "LOCKED" || confirmation.status !== "LOCKED")
    return { congruence: "NOT_COMPARABLE", pairedWinner: "NOT_COMPARABLE" };
  const congruence = early.side === confirmation.side ? "AGREE" : "DISAGREE";
  const e = early.result, c = confirmation.result;
  const pairedWinner = (e === "CORRECT" || e === "INCORRECT") && (c === "CORRECT" || c === "INCORRECT")
    ? e === "CORRECT" && c === "CORRECT" ? "BOTH_CORRECT"
      : e === "CORRECT" ? "EARLY_ONLY_CORRECT"
      : c === "CORRECT" ? "CONFIRMATION_ONLY_CORRECT" : "BOTH_INCORRECT"
    : "NOT_COMPARABLE";
  return { congruence, pairedWinner };
}
export function stageSummary(rows: PairedRow[], stage: "early" | "confirmation" | "benchmark"): StageSummary {
  const values = rows.map(row => row[stage]), count = (v: Score) => values.filter(s => s.result === v).length;
  const correct = count("CORRECT"), incorrect = count("INCORRECT");
  const locks = values.filter(s => s.status === "LOCKED" && s.side !== null).length;
  return {
    correct, incorrect, unrecorded: values.length - locks, pending: count("PENDING"),
    disputed: count("DISPUTED"), abstained: count("ABSTAINED"), dataFailures: count("DATA_FAILURE"),
    locks, accuracy: correct + incorrect ? correct / (correct + incorrect) : null
  };
}
export function pairedSummary(rows: PairedRow[]) {
  const early = stageSummary(rows, "early"), confirmation = stageSummary(rows, "confirmation"), benchmark = stageSummary(rows, "benchmark");
  const paired = rows.filter(r => r.congruence !== "NOT_COMPARABLE");
  const scoredPairs = paired.filter(r => r.pairedWinner !== "NOT_COMPARABLE");
  const winners = ["BOTH_CORRECT", "EARLY_ONLY_CORRECT", "CONFIRMATION_ONLY_CORRECT", "BOTH_INCORRECT"] as const;
  return { rounds: rows.length, early, confirmation, benchmark, paired: paired.length,
    scoredPairs: scoredPairs.length,
    agree: paired.filter(r => r.congruence === "AGREE").length,
    disagree: paired.filter(r => r.congruence === "DISAGREE").length,
    winners: Object.fromEntries(winners.map(w => [w, scoredPairs.filter(r => r.pairedWinner === w).length])),
    pendingSettlements: rows.filter(r => r.settlement === "PENDING").length,
    disputedSettlements: rows.filter(r => r.settlement === "DISPUTED").length };
}
