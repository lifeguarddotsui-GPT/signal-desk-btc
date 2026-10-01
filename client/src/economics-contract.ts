/** Do not carry a quote across a user-selected sizing-mode change. */
export function quoteMatchesSizingMode(
  response: { sizing?: { mode?: string } | null; sizingMode?: string } | null,
  selected: "budget" | "payout",
): boolean {
  const expected = selected === "budget" ? "SPEND_BUDGET" : "PAYOUT_QUANTITY";
  return response?.sizing?.mode === expected && response.sizingMode === expected;
}