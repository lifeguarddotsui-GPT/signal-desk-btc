/**
 * Performance Tracker — portfolio time-series ledger.
 *
 * Snapshots portfolio value, economic value, PnL, regime, and signal data
 * every 5 minutes. Detects why value is dropping and feeds context to the
 * learning engine so signal thresholds can adapt in real time.
 *
 * Data flow:
 *   reconciler snapshots → portfolio aggregate → performance_log row
 *   + last Triton signal → regime / HTF bias
 *   + learning engine  → win rate & consecutive losses
 *   + loss reason classifier → lossReason string
 */

import { db } from "./db";
import { performanceLog, agents } from "@shared/schema";
import { getAllCachedSnapshots } from "./reconciliation-engine";
import { getLastTritonSignal } from "./market-engine";
import { getRecentAgentPerformance } from "./learning-engine";
import { storage } from "./storage";
import { desc, gte, eq, sql } from "drizzle-orm";

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const RETENTION_DAYS = 7; // keep 7 days of data

let snapshotInterval: ReturnType<typeof setInterval> | null = null;
let lastSnapshot: { portfolioValue: number; economicValue: number; totalPnl: number; ts: number } | null = null;

// ─── loss reason classifier ─────────────────────────────────────────────────

function classifyLossReason(params: {
  regime: string | null;
  htfBias: string | null;
  signalSide: string | null;
  deltaEv5m: number;
  openPositions: number;
  winRate: number;
  consecutiveLosses: number;
  previousEv: number | null;
  netDeposited: number;
  economicValue: number;
}): string | null {
  const reasons: string[] = [];
  const { regime, htfBias, signalSide, deltaEv5m, openPositions, winRate, consecutiveLosses,
    previousEv, netDeposited, economicValue } = params;

  if (deltaEv5m >= 0) return null; // EV growing — no loss reason

  const absDelta = Math.abs(deltaEv5m);

  // ── Spike-recovery artifact suppression ──────────────────────────────────
  // During position open/close transitions, collateral can be double-counted
  // temporarily (e.g., wallet balance + open collateral both included), causing
  // a transient EV spike followed by a large negative delta when it corrects.
  // Detect: previous snapshot was above net deposited by >5% (inflated), and
  // the current EV is now back near or below deposits (recovery). These deltas
  // are accounting artifacts, not real losses — return null to suppress the alert.
  if (previousEv !== null && netDeposited > 0) {
    const prevWasSpiked = previousEv > netDeposited * 1.05;
    const nowNormal = economicValue <= netDeposited * 1.05;
    if (prevWasSpiked && nowNormal) return null;
  }

  // Also suppress if the decline is implausibly large relative to portfolio size
  // (more than 25% of net deposit in a single 5-minute window = artifact, not loss).
  if (netDeposited > 0 && absDelta / netDeposited > 0.25) return null;

  if (consecutiveLosses >= 3) {
    reasons.push(`Consecutive loss streak (${consecutiveLosses})`);
  }

  // Counter-trend trading (e.g., SHORT in BULL HTF)
  if (htfBias && signalSide) {
    const isCounterTrend =
      (signalSide === "SHORT" && htfBias === "BULL") ||
      (signalSide === "LONG" && htfBias === "BEAR");
    if (isCounterTrend) {
      reasons.push(`Counter-trend trade (${signalSide} vs ${htfBias} HTF)`);
    }
  }

  // Range chop
  if (regime === "RANGE" && absDelta > 0.5) {
    reasons.push(`Range chop eating collateral`);
  }

  // Low win rate signal quality
  if (winRate < 0.30) {
    reasons.push(`Low win rate ${(winRate * 100).toFixed(0)}% — poor signal quality`);
  }

  // Overexposed
  if (openPositions >= 3) {
    reasons.push(`Overexposure (${openPositions} concurrent positions)`);
  }

  // Generic fallback — only for sustained, meaningful losses (>1 SUI) with no
  // other identified cause. Kept muted in the UI; not shown as a red alarm.
  if (reasons.length === 0 && absDelta > 1.0) {
    reasons.push(`EV declined ${absDelta.toFixed(2)} SUI (normal market fluctuation)`);
  }

  return reasons.length > 0 ? reasons.slice(0, 2).join("; ") : null;
}

// ─── snapshot writer ─────────────────────────────────────────────────────────

async function takeSnapshot(): Promise<void> {
  try {
    // Aggregate across all agent snapshots
    const snapshots = getAllCachedSnapshots();
    if (snapshots.length === 0) return;

    let portfolioValue = 0;
    let economicValue = 0;
    let netDeposited = 0;
    let totalPnl = 0;
    let openPositions = 0;
    let userWallet = "";

    for (const snap of snapshots) {
      portfolioValue += (snap.settledFundingWallet || 0) + (snap.settledSavingsWallet || 0) + (snap.openCollateral || 0);
      economicValue += snap.economicValue || 0;
      netDeposited += snap.netDeposited || 0;
      totalPnl += snap.totalPnl || 0;
      openPositions += snap.openPositionCount || 0;
    }

    // Get user wallet from first agent
    if (!userWallet) {
      const allAgents = await storage.getAgentsWithSignalAgents();
      if (allAgents.length > 0) {
        userWallet = allAgents[0].walletAddress || "unknown";
      }
    }
    if (!userWallet) return;

    // Get signal context
    const lastSignal = getLastTritonSignal();
    const regime = lastSignal?.regime ?? null;
    const htfBias = lastSignal?.htfBias ?? null;
    const signalScore = lastSignal?.score ?? null;
    const signalSide = lastSignal?.side === "NONE" ? null : (lastSignal?.side ?? null);

    // Get learning engine context
    let winRate: number | null = null;
    let consecutiveLosses = 0;
    let activeAgents = 0;
    try {
      const allAgentsDb = await db.select().from(agents).where(
        sql`${agents.status} IN ('running', 'idle', 'paused', 'recovered')`
      );
      activeAgents = allAgentsDb.length;

      if (allAgentsDb.length > 0) {
        const perfResults = await Promise.all(
          allAgentsDb.map(a => getRecentAgentPerformance(a.id, 20))
        );
        const totalWinRate = perfResults.reduce((s, p) => s + p.recentWinRate, 0);
        winRate = totalWinRate / perfResults.length;
        consecutiveLosses = Math.max(...perfResults.map(p => p.consecutiveLosses));
      }
    } catch {}

    // Compute deltas from last snapshot
    const now = Date.now();
    let deltaPnl5m: number | null = null;
    let deltaEv5m: number | null = null;
    if (lastSnapshot && now - lastSnapshot.ts < 10 * 60 * 1000) {
      deltaPnl5m = totalPnl - lastSnapshot.totalPnl;
      deltaEv5m = economicValue - lastSnapshot.economicValue;
    }

    // Classify loss reason
    const lossReason = classifyLossReason({
      regime,
      htfBias,
      signalSide,
      deltaEv5m: deltaEv5m ?? 0,
      openPositions,
      winRate: winRate ?? 0.5,
      consecutiveLosses,
      previousEv: lastSnapshot?.economicValue ?? null,
      netDeposited,
      economicValue,
    });

    // Insert row
    await db.insert(performanceLog).values({
      userWallet,
      portfolioValue,
      economicValue,
      netDeposited,
      totalPnl,
      winRate,
      openPositions,
      regime,
      htfBias,
      signalScore,
      signalSide,
      activeAgents,
      lossReason,
      deltaPnl5m,
      deltaEv5m,
    });

    // Update last snapshot state
    lastSnapshot = { portfolioValue, economicValue, totalPnl, ts: now };

    if (lossReason) {
      console.log(`[PerfTracker] Snapshot: EV=${economicValue.toFixed(2)} pv=${portfolioValue.toFixed(2)} Δ5m=${deltaEv5m !== null ? deltaEv5m.toFixed(3) : "n/a"} | ${lossReason}`);
    }

    // Cleanup old data
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await db.delete(performanceLog).where(
      sql`${performanceLog.ts} < ${cutoff}`
    );
  } catch (err: any) {
    console.error(`[PerfTracker] Snapshot error: ${err.message?.slice(0, 100)}`);
  }
}

// ─── query helpers ─────────────────────────────────────────────────────────

export interface PerfLogRow {
  id: number;
  ts: string;
  portfolioValue: number;
  economicValue: number | null;
  netDeposited: number;
  totalPnl: number;
  winRate: number | null;
  openPositions: number | null;
  regime: string | null;
  htfBias: string | null;
  signalScore: number | null;
  signalSide: string | null;
  activeAgents: number | null;
  lossReason: string | null;
  deltaPnl5m: number | null;
  deltaEv5m: number | null;
}

export type SnapshotInterval = "5m" | "15m" | "30m" | "1h" | "4h" | "24h";

function intervalToMs(interval: SnapshotInterval): number {
  const map: Record<SnapshotInterval, number> = {
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
  };
  return map[interval];
}

function lookbackForInterval(interval: SnapshotInterval): number {
  // How many hours to look back for each interval
  const map: Record<SnapshotInterval, number> = {
    "5m": 6,    // 6h of 5m data = 72 points
    "15m": 12,  // 12h of 15m data
    "30m": 24,  // 24h of 30m data
    "1h": 48,   // 48h of 1h data
    "4h": 168,  // 7d of 4h data
    "24h": 720, // 30d of daily data
  };
  return map[interval];
}

export async function getPerformanceLogs(interval: SnapshotInterval = "5m"): Promise<PerfLogRow[]> {
  const lookbackHours = lookbackForInterval(interval);
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const intervalMs = intervalToMs(interval);

  const raw = await db.select().from(performanceLog)
    .where(gte(performanceLog.ts, cutoff))
    .orderBy(desc(performanceLog.ts))
    .limit(500);

  if (interval === "5m") {
    // Return raw 5m data
    return raw.map(r => ({
      ...r,
      ts: r.ts.toISOString(),
      portfolioValue: r.portfolioValue ?? 0,
      economicValue: r.economicValue ?? null,
      netDeposited: r.netDeposited ?? 0,
      totalPnl: r.totalPnl ?? 0,
    })).reverse();
  }

  // Bucket into intervals (OHLC-style: keep first + last in each bucket)
  const buckets = new Map<number, typeof raw[0]>();
  for (const row of raw) {
    const bucket = Math.floor(row.ts.getTime() / intervalMs) * intervalMs;
    const existing = buckets.get(bucket);
    // Keep the most recent row per bucket (already sorted desc)
    if (!existing) buckets.set(bucket, row);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([, r]) => ({
      ...r,
      ts: r.ts.toISOString(),
      portfolioValue: r.portfolioValue ?? 0,
      economicValue: r.economicValue ?? null,
      netDeposited: r.netDeposited ?? 0,
      totalPnl: r.totalPnl ?? 0,
    }));
}

export async function getLossAnalysis(): Promise<{
  topLossReasons: Array<{ reason: string; count: number; totalEvLost: number }>;
  regimePerformance: Array<{ regime: string; avgDeltaEv: number; count: number }>;
  worstPeriods: PerfLogRow[];
  recentTrend: "improving" | "declining" | "stable";
  recommendation: string;
}> {
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db.select().from(performanceLog)
    .where(gte(performanceLog.ts, last24h))
    .orderBy(desc(performanceLog.ts))
    .limit(300);

  // Aggregate loss reasons
  const reasonMap = new Map<string, { count: number; totalEvLost: number }>();
  for (const r of rows) {
    if (r.lossReason && (r.deltaEv5m ?? 0) < 0) {
      const key = r.lossReason.split(";")[0].trim();
      const existing = reasonMap.get(key) || { count: 0, totalEvLost: 0 };
      existing.count++;
      existing.totalEvLost += Math.abs(r.deltaEv5m ?? 0);
      reasonMap.set(key, existing);
    }
  }

  // Regime performance
  const regimeMap = new Map<string, { totalDelta: number; count: number }>();
  for (const r of rows) {
    if (r.regime && r.deltaEv5m !== null) {
      const key = r.regime;
      const existing = regimeMap.get(key) || { totalDelta: 0, count: 0 };
      existing.totalDelta += r.deltaEv5m;
      existing.count++;
      regimeMap.set(key, existing);
    }
  }

  // Worst periods
  const worstPeriods = rows
    .filter(r => (r.deltaEv5m ?? 0) < -0.5)
    .sort((a, b) => (a.deltaEv5m ?? 0) - (b.deltaEv5m ?? 0))
    .slice(0, 5)
    .map(r => ({ ...r, ts: r.ts.toISOString() }));

  // Recent trend (last 6 rows vs prior 6)
  const recent6 = rows.slice(0, 6);
  const prior6 = rows.slice(6, 12);
  const recentAvgDelta = recent6.reduce((s, r) => s + (r.deltaEv5m ?? 0), 0) / Math.max(recent6.length, 1);
  const priorAvgDelta = prior6.reduce((s, r) => s + (r.deltaEv5m ?? 0), 0) / Math.max(prior6.length, 1);
  const recentTrend = recentAvgDelta > priorAvgDelta + 0.05 ? "improving"
    : recentAvgDelta < priorAvgDelta - 0.05 ? "declining"
    : "stable";

  // Build recommendation
  const topReason = Array.from(reasonMap.entries())
    .sort(([, a], [, b]) => b.totalEvLost - a.totalEvLost)[0];
  let recommendation = "Monitor signal quality and regime alignment.";
  if (topReason) {
    const [key] = topReason;
    if (key.includes("Counter-trend")) {
      recommendation = "Agents are trading counter-trend. Wait for HTF alignment before opening new positions.";
    } else if (key.includes("Consecutive loss")) {
      recommendation = "Loss streak detected. Agents will attempt counter-direction hedges when signal flips. Consider reviewing regime conditions.";
    } else if (key.includes("Range chop")) {
      recommendation = "Market is ranging. Reduce position size and require stronger ADX (>25) before entries.";
    } else if (key.includes("win rate")) {
      recommendation = "Low win rate. The learning engine is raising score thresholds. Fewer but higher-quality trades expected.";
    } else if (key.includes("Overexposure")) {
      recommendation = "Too many concurrent positions increasing risk. Capital plan should reduce max simultaneous positions.";
    }
  }

  return {
    topLossReasons: Array.from(reasonMap.entries())
      .map(([reason, v]) => ({ reason, ...v }))
      .sort((a, b) => b.totalEvLost - a.totalEvLost)
      .slice(0, 5),
    regimePerformance: Array.from(regimeMap.entries())
      .map(([regime, v]) => ({ regime, avgDeltaEv: v.totalDelta / v.count, count: v.count }))
      .sort((a, b) => b.count - a.count),
    worstPeriods,
    recentTrend,
    recommendation,
  };
}

// ─── service lifecycle ───────────────────────────────────────────────────────

export function startPerformanceTracker(): void {
  if (snapshotInterval) return;
  console.log(`[PerfTracker] Started — snapshotting every ${SNAPSHOT_INTERVAL_MS / 60000}m`);

  // First snapshot after 30s (let reconciler warm up)
  setTimeout(() => {
    takeSnapshot().catch(() => {});
    snapshotInterval = setInterval(() => {
      takeSnapshot().catch(() => {});
    }, SNAPSHOT_INTERVAL_MS);
  }, 30_000);
}

export function stopPerformanceTracker(): void {
  if (snapshotInterval) {
    clearInterval(snapshotInterval);
    snapshotInterval = null;
  }
}

export async function resetPerformanceLog(): Promise<void> {
  await db.delete(performanceLog);
  console.log("[PerfTracker] Performance log cleared — fresh start for new agents");
}
