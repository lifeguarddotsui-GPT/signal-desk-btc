export type CachedOnChainPosition = {
  positionId: string;
  side: string;
  size: number;
  collateral: number;
  entryPrice: number;
};

const onChainPositionsCache = new Map<string, {
  positions: CachedOnChainPosition[];
  totalLocked: number;
  timestamp: number;
}>();

// 45s TTL: long enough to survive a 10s RPC cooldown window, short enough to stay fresh.
const ONCHAIN_POSITIONS_CACHE_TTL = 45_000;

export function setOnChainPositionsCache(
  agentId: string,
  positions: CachedOnChainPosition[],
  totalLocked: number,
): void {
  onChainPositionsCache.set(agentId, { positions, totalLocked, timestamp: Date.now() });
}

export function getCachedOnChainPositions(
  agentId: string,
): { positions: CachedOnChainPosition[]; totalLocked: number } | null {
  const cached = onChainPositionsCache.get(agentId);
  if (cached && Date.now() - cached.timestamp < ONCHAIN_POSITIONS_CACHE_TTL) {
    return { positions: cached.positions, totalLocked: cached.totalLocked };
  }
  return null;
}

export function invalidateOnChainPositionsCache(agentId: string): void {
  onChainPositionsCache.delete(agentId);
}
