/**
 * Feature Store — centralizes feature assembly for the win probability model,
 * risk management agent, and continuous evaluator.
 *
 * Reads from market-engine + performance snapshots + close_outcomes.
 * All consumers use the same feature snapshot for consistency.
 */

import { db } from "./db";
import { eq, desc } from "drizzle-orm";
import { closeOutcomes, agentCapitalSnapshots } from "@shared/schema";
import { getMarketState, getLastTritonSignal } from "./market-engine";

export interface MarketFeatureSnapshot {
  timestamp: number;
  price: number;
  regime: string;
  tradabilityScore: number;
  rsi: number | null;
  connorsRsi: number | null;
  macdHist: number | null;
  emaSpread: number | null;
  atrPercentile: number | null;
  volumeRatio: number | null;
  mtfAlignmentScore: number;
  slippageEstimateBps: number | null;
  oracleFreshnessMs: number | null;
  sentimentScore: number | null;
  eventRiskScore: number | null;
  side: "long" | "short" | null;
  recentWinRate: number;
  recentAvgPnl: number;
  consecutiveLosses: number;
  drawdownPct: number;
  capitalMode: string;
  sampleCount: number;
}

const featureCache = new Map<string, { snapshot: MarketFeatureSnapshot; ts: number }>();
const CACHE_TTL_MS = 8000; // 8-second cache — market ticks every 5s

export async function getLatestFeaturesForAgent(
  agentId: string,
  side: "long" | "short" | null = null
): Promise<MarketFeatureSnapshot> {
  const cacheKey = `${agentId}:${side}`;
  const cached = featureCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.snapshot;
  }

  const [marketState, tritonSignal, recentOutcomes, capitalSnap] = await Promise.allSettled([
    Promise.resolve(getMarketState()),
    Promise.resolve(getLastTritonSignal()),
    db.select().from(closeOutcomes)
      .where(eq(closeOutcomes.agentId, agentId))
      .orderBy(desc(closeOutcomes.createdAt))
      .limit(50),
    db.select().from(agentCapitalSnapshots)
      .where(eq(agentCapitalSnapshots.agentId, agentId))
      .orderBy(desc(agentCapitalSnapshots.createdAt))
      .limit(1),
  ]);

  const market = marketState.status === "fulfilled" ? marketState.value : null;
  const signal = tritonSignal.status === "fulfilled" ? tritonSignal.value : null;
  const outcomes = recentOutcomes.status === "fulfilled" ? recentOutcomes.value : [];
  const capSnap = capitalSnap.status === "fulfilled" && capitalSnap.value.length > 0
    ? capitalSnap.value[0]
    : null;

  const recentWins = outcomes.filter(o => o.label === "SUCCESS").length;
  const recentWinRate = outcomes.length > 0 ? recentWins / outcomes.length : 0.5;
  const recentAvgPnl = outcomes.length > 0
    ? outcomes.reduce((sum, o) => sum + (o.pnlSui ?? 0), 0) / outcomes.length
    : 0;

  let consecutiveLosses = 0;
  for (const o of outcomes) {
    if (o.label === "FAIL" || o.label === "TIMEOUT") consecutiveLosses++;
    else break;
  }

  const drawdownPct = capSnap?.drawdownPct ?? 0;
  const capitalMode = capSnap?.capitalMode ?? "ACCELERATE";

  const regime = signal?.regime ?? market?.signal?.regime ?? "UNKNOWN";
  const tradabilityScore = (market as any)?.tradabilityScore ?? 50;

  const mtfAlignmentScore = computeMTFAlignment(signal);

  const slippageEstimateBps = estimateSlippage(outcomes);

  const snapshot: MarketFeatureSnapshot = {
    timestamp: Date.now(),
    price: market?.price ?? 0,
    regime,
    tradabilityScore,
    rsi: signal?.rsi ?? null,
    connorsRsi: signal?.connorsRsi ?? null,
    macdHist: signal?.macdHist ?? null,
    emaSpread: signal?.emaSpread ?? null,
    atrPercentile: null,
    volumeRatio: signal?.volumeRatio ?? null,
    mtfAlignmentScore,
    slippageEstimateBps,
    oracleFreshnessMs: market?.oracleFreshnessMs ?? null,
    sentimentScore: null,
    eventRiskScore: null,
    side,
    recentWinRate,
    recentAvgPnl,
    consecutiveLosses,
    drawdownPct,
    capitalMode,
    sampleCount: outcomes.length,
  };

  featureCache.set(cacheKey, { snapshot, ts: Date.now() });
  return snapshot;
}

function computeMTFAlignment(signal: any): number {
  if (!signal) return 0.5;
  let agreements = 0;
  let total = 0;

  const htfBias = signal.htfBias;
  const side = signal.side?.toLowerCase();
  if (htfBias && side) {
    total++;
    if ((side === "long" && htfBias === "BULL") || (side === "short" && htfBias === "BEAR")) {
      agreements++;
    }
  }

  if (signal.ema7 && signal.ema30 && signal.price) {
    total++;
    const emaAlign = signal.side === "LONG"
      ? signal.ema7 > signal.ema30
      : signal.ema7 < signal.ema30;
    if (emaAlign) agreements++;
  }

  if (signal.macdHist !== undefined && signal.macdHist !== null) {
    total++;
    const macdAlign = signal.side === "LONG" ? signal.macdHist > 0 : signal.macdHist < 0;
    if (macdAlign) agreements++;
  }

  return total > 0 ? agreements / total : 0.5;
}

function estimateSlippage(outcomes: any[]): number | null {
  const recent = outcomes.slice(0, 10).filter(o => o.slippageBps != null);
  if (recent.length === 0) return null;
  const avg = recent.reduce((s, o) => s + (o.slippageBps ?? 0), 0) / recent.length;
  return avg;
}

export function invalidateFeatureCache(agentId: string): void {
  for (const key of featureCache.keys()) {
    if (key.startsWith(agentId)) featureCache.delete(key);
  }
}
