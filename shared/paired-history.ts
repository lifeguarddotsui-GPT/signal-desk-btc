/** Paired round projection. No retrospective choice construction or P/L inference. */
export type Direction = "UP" | "DOWN";
export type Score = "CORRECT" | "INCORRECT" | "PENDING" | "DISPUTED" |
  "UNRECORDED" | "ABSTAINED" | "DATA_FAILURE";
export type Congruence = "AGREE" | "DISAGREE" | "NOT_COMPARABLE";
export type PairedWinner = "BOTH_CORRECT" | "EARLY_ONLY_CORRECT" | "CONFIRMATION_ONLY_CORRECT" |
  "BOTH_INCORRECT" | "NOT_COMPARABLE";
export type Stage = {
  side: Direction | null;
  status: string;
  probabilityUp: number | null;
  decisionAtMs: number | null;
  secondsBeforeExpiry: number | null;
  result: Score;
};
export type PairedRow = {
  intervalMinutes: 5 | 15; roundId: string; startMs: number; expiryMs: number;
  early: Stage; confirmation: Stage; congruence: Congruence; pairedWinner: PairedWinner;
  outcome: Direction | null; settlement: "VERIFIED" | "PENDING" | "DISPUTED";
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
  if (status === "DATA_FAILURE") return "DATA_FAILURE";
  if (status !== "LOCKED" || side === null) return "UNRECORDED";
  if (disputed) return "DISPUTED";
  if (verifiedOutcome === null) return "PENDING";
  return side === verifiedOutcome ? "CORRECT" : "INCORRECT";
};
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
export function stageSummary(rows: PairedRow[], stage: "early" | "confirmation"): StageSummary {
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
  const early = stageSummary(rows, "early"), confirmation = stageSummary(rows, "confirmation");
  const paired = rows.filter(r => r.congruence !== "NOT_COMPARABLE");
  const scoredPairs = paired.filter(r => r.pairedWinner !== "NOT_COMPARABLE");
  const winners = ["BOTH_CORRECT", "EARLY_ONLY_CORRECT", "CONFIRMATION_ONLY_CORRECT", "BOTH_INCORRECT"] as const;
  return { rounds: rows.length, early, confirmation, paired: paired.length,
    scoredPairs: scoredPairs.length,
    agree: paired.filter(r => r.congruence === "AGREE").length,
    disagree: paired.filter(r => r.congruence === "DISAGREE").length,
    winners: Object.fromEntries(winners.map(w => [w, scoredPairs.filter(r => r.pairedWinner === w).length])),
    pendingSettlements: rows.filter(r => r.settlement === "PENDING").length,
    disputedSettlements: rows.filter(r => r.settlement === "DISPUTED").length };
}
