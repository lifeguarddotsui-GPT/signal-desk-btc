/** Keep currency arithmetic exact; balances are not equity or trading permission. */
export function usdBalanceLabel(atomic: string, decimals = 6): string {
  if (!/^\d+$/.test(atomic) || !Number.isInteger(decimals) || decimals < 2 || decimals > 18)
    throw new Error("Invalid reported balance");
  const cents = BigInt(atomic) / BigInt(`1${"0".repeat(decimals - 2)}`);
  return `${cents / BigInt(100)}.${(cents % BigInt(100)).toString().padStart(2, "0")}`;
}

export function discoveredAccountSelection(ids: string[], saved: string | null): string | null {
  if (saved && ids.some(id => id.toLowerCase() === saved.toLowerCase())) return saved;
  return ids.length === 1 ? ids[0] : null;
}

export function selectFundingCoins(
  coins: { objectId: string; balance: string }[], amount: string, requested?: string[],
): string[] {
  if (!/^[1-9]\d*$/.test(amount) || BigInt(amount) > BigInt("18446744073709551615"))
    throw new Error("Enter a valid positive funding amount");
  if (coins.some(c => !/^\d+$/.test(c.balance)) ||
      new Set(coins.map(c => c.objectId)).size !== coins.length)
    throw new Error("Wallet coin data could not be verified");
  const owned = new Map(coins.map(c => [c.objectId, c]));
  if (requested && (requested.length < 1 || requested.length > 20 ||
      new Set(requested).size !== requested.length || requested.some(id => !owned.has(id))))
    throw new Error("Funding coins must belong to this wallet and the selected asset");
  const candidates = requested ? requested.map(id => owned.get(id)!) :
    [...coins].sort((a, b) => BigInt(a.balance) > BigInt(b.balance) ? -1 : BigInt(a.balance) < BigInt(b.balance) ? 1 : 0);
  const selected: string[] = [];
  let available = BigInt(0);
  for (const c of candidates.slice(0, 20)) {
    if (BigInt(c.balance) === BigInt(0)) continue;
    selected.push(c.objectId);
    available += BigInt(c.balance);
    if (available >= BigInt(amount)) return selected;
  }
  throw new Error("Not enough available funding coins in this wallet. No transaction prepared.");
}
