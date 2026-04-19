import { db } from "../db";
import { breakoutTrades } from "../../shared/schema";
import { eq, desc } from "drizzle-orm";
import type { TradeRecord } from "./types";

export class TradeJournal {
  async recordOpened(trade: TradeRecord): Promise<void> {
    await db.insert(breakoutTrades).values({
      id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      status: trade.status,
      entryReason: trade.entryReason,
      entryTs: trade.entryTs,
      entryPrice: trade.entryPrice,
      leverage: trade.leverage,
      collateralSui: trade.collateralSui,
      takeProfitPrice: trade.takeProfitPrice,
      stopLossPrice: trade.stopLossPrice,
      atrRatioAtEntry: trade.atrRatioAtEntry,
      volumeRatioAtEntry: trade.volumeRatioAtEntry,
      trendBiasAtEntry: trade.trendBiasAtEntry,
      breakoutLevel: trade.breakoutLevel,
    });
  }

  async recordClosed(trade: TradeRecord): Promise<void> {
    await db.update(breakoutTrades)
      .set({
        status: trade.status,
        exitReason: trade.exitReason,
        exitTs: trade.exitTs,
        exitPrice: trade.exitPrice,
        pnlSui: trade.pnlSui,
        pnlBps: trade.pnlBps,
        win: trade.win,
      })
      .where(eq(breakoutTrades.id, trade.id));
  }

  async getRecent(limit = 50): Promise<TradeRecord[]> {
    const rows = await db.select().from(breakoutTrades)
      .orderBy(desc(breakoutTrades.entryTs))
      .limit(limit);
    return rows.map(r => ({
      id: r.id,
      symbol: r.symbol,
      side: r.side as TradeRecord["side"],
      status: r.status as TradeRecord["status"],
      entryReason: r.entryReason as TradeRecord["entryReason"],
      exitReason: r.exitReason as TradeRecord["exitReason"] | undefined,
      entryTs: r.entryTs,
      exitTs: r.exitTs ?? undefined,
      entryPrice: r.entryPrice,
      exitPrice: r.exitPrice ?? undefined,
      leverage: r.leverage,
      collateralSui: r.collateralSui,
      takeProfitPrice: r.takeProfitPrice,
      stopLossPrice: r.stopLossPrice,
      pnlSui: r.pnlSui ?? undefined,
      pnlBps: r.pnlBps ?? undefined,
      win: r.win ?? undefined,
      atrRatioAtEntry: r.atrRatioAtEntry,
      volumeRatioAtEntry: r.volumeRatioAtEntry,
      trendBiasAtEntry: r.trendBiasAtEntry as TradeRecord["trendBiasAtEntry"],
      breakoutLevel: r.breakoutLevel,
    }));
  }

  async summarize(limit = 100): Promise<{
    total: number;
    wins: number;
    losses: number;
    winRate: number;
    pnlSui: number;
    avgWinner: number;
    avgLoser: number;
  }> {
    const trades = await this.getRecent(limit);
    const closed = trades.filter(t => t.status === "closed" && typeof t.win === "boolean");
    const wins = closed.filter(t => t.win);
    const losses = closed.filter(t => !t.win);
    const pnlSui = closed.reduce((s, t) => s + (t.pnlSui ?? 0), 0);
    const avgWinner = wins.length ? wins.reduce((s, t) => s + (t.pnlSui ?? 0), 0) / wins.length : 0;
    const avgLoser = losses.length ? losses.reduce((s, t) => s + (t.pnlSui ?? 0), 0) / losses.length : 0;
    return {
      total: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? wins.length / closed.length : 0,
      pnlSui,
      avgWinner,
      avgLoser,
    };
  }
}
