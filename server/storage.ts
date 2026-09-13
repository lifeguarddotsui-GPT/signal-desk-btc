import { db } from "./db";
import { markets, outcomes, marketSnapshots, signals, alerts, appSettings } from "../shared/schema";
import type { Market, InsertMarket, Signal, Alert, AppSettings } from "../shared/schema";
import { eq, desc, asc, gte, lt, and, inArray } from "drizzle-orm";

export async function upsertMarket(data: InsertMarket): Promise<Market> {
  const existing = await db.select().from(markets)
    .where(eq(markets.coinbaseMarketId, data.coinbaseMarketId))
    .limit(1);
  if (existing.length > 0) {
    const [updated] = await db.update(markets)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(markets.coinbaseMarketId, data.coinbaseMarketId))
      .returning();
    return updated;
  }
  const [inserted] = await db.insert(markets).values(data).returning();
  return inserted;
}

export async function upsertOutcome(marketId: number, label: string, price: number): Promise<void> {
  const existing = await db.select().from(outcomes)
    .where(and(eq(outcomes.marketId, marketId), eq(outcomes.label, label)))
    .limit(1);
  if (existing.length > 0) {
    await db.update(outcomes)
      .set({ price, impliedProbability: price, updatedAt: new Date() })
      .where(and(eq(outcomes.marketId, marketId), eq(outcomes.label, label)));
  } else {
    await db.insert(outcomes).values({ marketId, label, price, impliedProbability: price });
  }
}

export async function insertSnapshot(data: {
  marketId: number; yesPrice: number; noPrice: number;
  spotPrice?: number; targetPrice?: number; volume?: number; timeRemainingSeconds?: number;
}): Promise<void> {
  await db.insert(marketSnapshots).values(data);
}

// Mark expired crypto markets so they don't clog the active pool
export async function cleanExpiredCryptoMarkets(): Promise<void> {
  const now = new Date();
  await db.update(markets)
    .set({ status: "expired", updatedAt: now })
    .where(and(
      eq(markets.category, "crypto"),
      eq(markets.status, "active"),
      lt(markets.expirationTime, now)
    ));
}

// Mark sports markets as expired when their start time is more than 6 hours in the past
// (generous window to cover live games and fights that run long)
export async function cleanExpiredSportsMarkets(): Promise<void> {
  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6-hour grace
  await db.update(markets)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(
      eq(markets.category, "sports"),
      eq(markets.status, "active"),
      lt(markets.expirationTime, cutoff)
    ));
}

export async function getAllMarkets(category?: string): Promise<Market[]> {
  if (category) {
    return db.select().from(markets)
      .where(and(eq(markets.status, "active"), eq(markets.category, category)))
      .orderBy(desc(markets.volume));
  }
  return db.select().from(markets).where(eq(markets.status, "active")).orderBy(desc(markets.volume));
}

export async function getMarketsWithOutcomes(category?: string): Promise<Array<Market & { yesPrice: number; noPrice: number }>> {
  const marketRows = await getAllMarkets(category);
  const result: Array<Market & { yesPrice: number; noPrice: number }> = [];
  for (const m of marketRows) {
    const outcomeRows = await db.select().from(outcomes).where(eq(outcomes.marketId, m.id));
    const yes = outcomeRows.find(o => o.label === "YES");
    const no = outcomeRows.find(o => o.label === "NO");
    result.push({
      ...m,
      yesPrice: parseFloat(String(yes?.price ?? 0.50)),
      noPrice: parseFloat(String(no?.price ?? 0.50)),
    });
  }
  return result;
}

export async function getTodaySignals() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const signalRows = await db.select().from(signals)
    .where(gte(signals.createdAt, todayStart))
    .orderBy(asc(signals.rankToday));
  const result = [];
  for (const s of signalRows) {
    const [market] = await db.select().from(markets).where(eq(markets.id, s.marketId)).limit(1);
    if (!market) continue;
    const outcomeRows = await db.select().from(outcomes).where(eq(outcomes.marketId, s.marketId));
    const yes = outcomeRows.find(o => o.label === "YES");
    const no = outcomeRows.find(o => o.label === "NO");
    result.push({
      ...s,
      // Drizzle returns decimal/numeric columns as strings — always cast to number for the API
      confidenceScore: parseFloat(String(s.confidenceScore ?? 0)),
      edgeScore: parseFloat(String(s.edgeScore ?? 0)),
      riskScore: parseFloat(String(s.riskScore ?? 5)),
      maxBetPct: parseFloat(String(s.maxBetPct ?? 0)),
      rankToday: Number(s.rankToday ?? 0),
      marketTitle: market.title,
      category: market.category,
      asset: market.asset,
      sport: market.sport,
      yesPrice: parseFloat(String(yes?.price ?? 0.50)),
      noPrice: parseFloat(String(no?.price ?? 0.50)),
      expirationTime: market.expirationTime,
    });
  }
  return result;
}

export async function getSignalById(id: number) {
  const [signal] = await db.select().from(signals).where(eq(signals.id, id)).limit(1);
  if (!signal) return null;
  const [market] = await db.select().from(markets).where(eq(markets.id, signal.marketId)).limit(1);
  if (!market) return null;
  const outcomeRows = await db.select().from(outcomes).where(eq(outcomes.marketId, market.id));
  const yes = outcomeRows.find(o => o.label === "YES");
  const no = outcomeRows.find(o => o.label === "NO");
  return {
    ...signal,
    // Drizzle decimal columns returned as strings — cast all to numbers
    confidenceScore: parseFloat(String(signal.confidenceScore ?? 0)),
    edgeScore: parseFloat(String(signal.edgeScore ?? 0)),
    riskScore: parseFloat(String(signal.riskScore ?? 5)),
    maxBetPct: parseFloat(String(signal.maxBetPct ?? 0)),
    rankToday: Number(signal.rankToday ?? 0),
    market,
    yesPrice: parseFloat(String(yes?.price ?? 0.50)),
    noPrice: parseFloat(String(no?.price ?? 0.50)),
  };
}

// Upsert a signal by marketId+today — preserves the row ID so card links never break
export async function upsertSignalForMarket(data: {
  marketId: number;
  recommendedSide: string;
  confidenceScore: number;
  edgeScore: number;
  riskScore: number;
  reasoning: string;
  supportingDataJson: Record<string, unknown>;
  rankToday: number;
  maxBetPct: number;
}): Promise<Signal> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const existing = await db.select().from(signals)
    .where(and(eq(signals.marketId, data.marketId), gte(signals.createdAt, todayStart)))
    .limit(1);
  if (existing.length > 0) {
    const [updated] = await db.update(signals)
      .set(data)
      .where(eq(signals.id, existing[0].id))
      .returning();
    return updated;
  }
  const [inserted] = await db.insert(signals).values(data).returning();
  return inserted;
}

// Delete today's signals that are NOT in the keepMarketIds set (dropped from top 10)
export async function pruneStaleSignals(keepMarketIds: number[]): Promise<void> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayRows = await db.select({ id: signals.id, marketId: signals.marketId })
    .from(signals).where(gte(signals.createdAt, todayStart));
  const toPrune = todayRows.filter(r => !keepMarketIds.includes(r.marketId));
  if (toPrune.length > 0) {
    const ids = toPrune.map(r => r.id);
    await db.delete(alerts).where(inArray(alerts.signalId, ids));
    await db.delete(signals).where(inArray(signals.id, ids));
  }
}

export async function getRecentAlerts(limit = 20): Promise<Alert[]> {
  return db.select().from(alerts).orderBy(desc(alerts.createdAt)).limit(limit);
}

export async function createAlert(data: { signalId?: number; alertType: string; message: string }): Promise<Alert> {
  const [inserted] = await db.insert(alerts).values({ ...data, sentStatus: "sent" }).returning();
  return inserted;
}

export async function getSettings(): Promise<AppSettings> {
  const rows = await db.select().from(appSettings).limit(1);
  if (rows.length > 0) return rows[0];
  const [created] = await db.insert(appSettings).values({ bankrollAmount: 1000 }).returning();
  return created;
}

export async function updateSettings(data: Partial<{ bankrollAmount: number; emailNotifications: boolean; minConfidenceAlert: number }>): Promise<AppSettings> {
  const current = await getSettings();
  const [updated] = await db.update(appSettings)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(appSettings.id, current.id))
    .returning();
  return updated;
}

export async function getMarketSnapshots(marketId: number, limit = 30) {
  return db.select().from(marketSnapshots)
    .where(eq(marketSnapshots.marketId, marketId))
    .orderBy(desc(marketSnapshots.createdAt))
    .limit(limit);
}
