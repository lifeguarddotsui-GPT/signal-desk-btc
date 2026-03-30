/**
 * Capital Mode Service — 3-state capital controller
 *
 * ACCELERATE: Agent is healthy, trading well. Press advantage — larger sizes, more participation.
 * RECUPERATE: Moderate losses or loss cluster. Recover methodically — reduce size, higher quality bar.
 * RESTART:    Hard capital limit breached. Stop new entries, close exposure, archive.
 *
 * Modes are evaluated every 5 minutes and persisted to the agents table.
 * Anti-flapping: minimum 30 minutes in a mode before switching (except hard RESTART).
 */

import { db } from "./db";
import { agents, closeOutcomes, agentCapitalSnapshots } from "@shared/schema";
import { eq, desc, and } from "drizzle-orm";

export type CapitalMode = "ACCELERATE" | "RECUPERATE" | "RESTART";

export interface CapitalModeProfile {
  riskMultiplier: number;
  leverageBias: number;
  minSignalScoreAdj: number;
  maxConcurrentPositions: number;
  allowNewEntries: boolean;
  exitAggression: "defensive" | "balanced" | "offensive";
  label: string;
  color: "emerald" | "amber" | "red";
}

export interface CapitalModeDecision {
  mode: CapitalMode;
  previousMode: CapitalMode;
  changed: boolean;
  reasonTags: string[];
  drawdownPct: number;
  recentPnl5: number;
  recentWinRate5: number;
  recentLossStreak: number;
  currentEquity: number;
  equityPeak: number;
}

const MODE_PROFILES: Record<CapitalMode, CapitalModeProfile> = {
  ACCELERATE: {
    riskMultiplier: 1.20,
    leverageBias: 2,
    minSignalScoreAdj: -3,
    maxConcurrentPositions: 2,
    allowNewEntries: true,
    exitAggression: "offensive",
    label: "Accelerate",
    color: "emerald",
  },
  RECUPERATE: {
    riskMultiplier: 0.65,
    leverageBias: -3,
    minSignalScoreAdj: 5,
    maxConcurrentPositions: 1,
    allowNewEntries: true,
    exitAggression: "balanced",
    label: "Recuperate",
    color: "amber",
  },
  RESTART: {
    riskMultiplier: 0,
    leverageBias: -10,
    minSignalScoreAdj: 999,
    maxConcurrentPositions: 0,
    allowNewEntries: false,
    exitAggression: "defensive",
    label: "Restart",
    color: "red",
  },
};

export function getModeProfile(mode: CapitalMode): CapitalModeProfile {
  return MODE_PROFILES[mode] ?? MODE_PROFILES.RECUPERATE;
}

// Mode thresholds
const ACCELERATE_MAX_DRAWDOWN = 0.025;       // < 2.5% drawdown
const RECUPERATE_MAX_DRAWDOWN = 0.12;        // < 12% drawdown
const RESTART_DRAWDOWN = 0.15;               // >= 15% → hard RESTART
const RESTART_MIN_EQUITY_PCT = 0.60;         // < 60% of starting equity → RESTART
const RESTART_LOSS_STREAK = 8;              // 8+ consecutive losses → RESTART
const MIN_MODE_DURATION_MS = 30 * 60 * 1000; // 30 min anti-flapping

// Track last mode switch time per agent to enforce anti-flapping
const _modeLastSwitchTime = new Map<string, number>();
const _currentMode = new Map<string, CapitalMode>();

export async function evaluateAgentMode(agentId: string): Promise<CapitalModeDecision | null> {
  try {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) return null;

    // Fetch last 10 close outcomes for performance metrics
    const recentOutcomes = await db.select()
      .from(closeOutcomes)
      .where(eq(closeOutcomes.agentId, agentId))
      .orderBy(desc(closeOutcomes.createdAt))
      .limit(10);

    // Compute recent performance metrics
    const last5 = recentOutcomes.slice(0, 5);
    const recentPnl5 = last5.reduce((s, o) => s + (o.pnlSui ?? 0), 0);
    const recentWins5 = last5.filter(o => (o.pnlSui ?? 0) > 0).length;
    const recentWinRate5 = last5.length > 0 ? recentWins5 / last5.length : 0.5;

    // Consecutive loss streak from most recent
    let recentLossStreak = 0;
    for (const o of recentOutcomes) {
      if ((o.pnlSui ?? 0) <= 0) recentLossStreak++;
      else break;
    }

    // Equity tracking
    const currentEquity = agent.balance ?? 0;
    const startingEquity = (agent as any).startingEquity ?? agent.totalDeposited ?? currentEquity;
    const equityPeak = Math.max((agent as any).equityPeak ?? 0, currentEquity);
    const drawdownPct = equityPeak > 0 ? Math.max(0, (equityPeak - currentEquity) / equityPeak) : 0;
    const equityPctOfStart = startingEquity > 0 ? currentEquity / startingEquity : 1.0;

    const previousMode = (_currentMode.get(agentId) ?? (agent as any).capitalMode ?? "RECUPERATE") as CapitalMode;
    const lastSwitchTime = _modeLastSwitchTime.get(agentId) ?? 0;
    const minutesInMode = (Date.now() - lastSwitchTime) / 60000;

    const reasonTags: string[] = [];
    let targetMode: CapitalMode = "RECUPERATE";

    // Hard failure conditions — RESTART
    if (
      drawdownPct >= RESTART_DRAWDOWN ||
      equityPctOfStart <= RESTART_MIN_EQUITY_PCT ||
      recentLossStreak >= RESTART_LOSS_STREAK
    ) {
      if (drawdownPct >= RESTART_DRAWDOWN) reasonTags.push(`drawdown_${(drawdownPct * 100).toFixed(1)}pct_breached`);
      if (equityPctOfStart <= RESTART_MIN_EQUITY_PCT) reasonTags.push(`equity_${(equityPctOfStart * 100).toFixed(0)}pct_of_start`);
      if (recentLossStreak >= RESTART_LOSS_STREAK) reasonTags.push(`loss_streak_${recentLossStreak}`);
      targetMode = "RESTART";
    }
    // Healthy growth conditions — ACCELERATE
    else if (
      drawdownPct <= ACCELERATE_MAX_DRAWDOWN &&
      recentPnl5 > 0 &&
      recentWinRate5 >= 0.60 &&
      currentEquity >= equityPeak * 0.98
    ) {
      reasonTags.push(`low_drawdown_${(drawdownPct * 100).toFixed(1)}pct`);
      reasonTags.push(`positive_pnl_${recentPnl5.toFixed(3)}sui`);
      reasonTags.push(`win_rate_${(recentWinRate5 * 100).toFixed(0)}pct`);
      targetMode = "ACCELERATE";
    }
    // Everything else — RECUPERATE
    else {
      if (drawdownPct > ACCELERATE_MAX_DRAWDOWN) reasonTags.push(`recovering_drawdown_${(drawdownPct * 100).toFixed(1)}pct`);
      if (recentPnl5 <= 0) reasonTags.push(`negative_recent_pnl_${recentPnl5.toFixed(3)}sui`);
      if (recentLossStreak > 2) reasonTags.push(`loss_streak_${recentLossStreak}`);
      targetMode = "RECUPERATE";
    }

    // Anti-flapping: only switch if mode has been stable long enough,
    // unless this is a hard RESTART (always switch immediately).
    const isHardFailure = targetMode === "RESTART";
    const canSwitch = isHardFailure || minutesInMode >= 30 || previousMode === targetMode;

    const finalMode = canSwitch ? targetMode : previousMode;
    const changed = finalMode !== previousMode;

    if (changed) {
      _modeLastSwitchTime.set(agentId, Date.now());
      _currentMode.set(agentId, finalMode);

      // Persist to DB
      await db.update(agents).set({
        capitalMode: finalMode,
        capitalModeUpdatedAt: new Date(),
        equityPeak: equityPeak,
        startingEquity: startingEquity > 0 ? startingEquity : currentEquity,
      } as any).where(eq(agents.id, agentId));

      // Store capital snapshot
      await db.insert(agentCapitalSnapshots).values({
        agentId,
        capitalMode: finalMode,
        currentEquity,
        equityPeak,
        startingEquity: startingEquity > 0 ? startingEquity : currentEquity,
        drawdownPct,
        recentPnl5,
        recentWinRate5,
        recentLossStreak,
        reasonTags: reasonTags.join(","),
      } as any);

      console.log(`[CapitalMode] ${agent.name}: ${previousMode} → ${finalMode} | drawdown=${(drawdownPct*100).toFixed(1)}% pnl5=${recentPnl5.toFixed(3)} wr5=${(recentWinRate5*100).toFixed(0)}% streak=${recentLossStreak} | ${reasonTags.join(", ")}`);
    } else {
      _currentMode.set(agentId, finalMode);
      // Update equity peak even without mode change
      if (equityPeak > ((agent as any).equityPeak ?? 0)) {
        await db.update(agents).set({ equityPeak: equityPeak } as any).where(eq(agents.id, agentId));
      }
    }

    return {
      mode: finalMode,
      previousMode,
      changed,
      reasonTags,
      drawdownPct,
      recentPnl5,
      recentWinRate5,
      recentLossStreak,
      currentEquity,
      equityPeak,
    };
  } catch (err) {
    console.warn(`[CapitalMode] Error evaluating agent ${agentId}: ${err}`);
    return null;
  }
}

/** Get the current capital mode for an agent (from in-memory cache, fallback to DB value). */
export function getAgentCapitalMode(agent: any): CapitalMode {
  return (_currentMode.get(agent.id) ?? agent.capitalMode ?? "RECUPERATE") as CapitalMode;
}

/**
 * Dynamic leverage selection — picks leverage within [min, max] based on:
 * - Signal score (high score → higher leverage)
 * - ATR percentile (high ATR → reduce leverage)
 * - Regime (chop → reduce, trend → allow higher)
 * - Recent loss rate
 * - Capital mode bias
 */
export function selectDynamicLeverage(ctx: {
  signalScore: number;
  atrPercentile: number;
  regime: string;
  recentLossRate: number;
  capitalMode: CapitalMode;
  minLev: number;
  maxLev: number;
  leverageBias: number;
}): { leverage: number; reasonTags: string[] } {
  const { minLev, maxLev, signalScore, atrPercentile, regime, recentLossRate, capitalMode, leverageBias } = ctx;
  const reasonTags: string[] = [];
  let factor = 0.4; // start conservatively

  // Signal quality
  if (signalScore >= 80) { factor += 0.20; reasonTags.push("signal_score_high"); }
  else if (signalScore >= 65) { factor += 0.10; reasonTags.push("signal_score_good"); }
  else if (signalScore < 45) { factor -= 0.20; reasonTags.push("signal_score_low"); }

  // Volatility (ATR percentile)
  if (atrPercentile > 0.80) { factor -= 0.25; reasonTags.push("high_atr_throttle"); }
  else if (atrPercentile > 0.65) { factor -= 0.12; reasonTags.push("elevated_atr"); }
  else if (atrPercentile < 0.30) { factor += 0.10; reasonTags.push("low_atr_boost"); }

  // Regime
  if (regime === "CHOP_SCALP" || regime === "CHOP") { factor -= 0.30; reasonTags.push("chop_regime_throttle"); }
  else if (regime === "TREND") { factor += 0.10; reasonTags.push("trend_regime_boost"); }

  // Recent performance
  if (recentLossRate > 0.60) { factor -= 0.20; reasonTags.push("recent_losses_throttle"); }
  else if (recentLossRate < 0.30) { factor += 0.05; reasonTags.push("recent_wins_boost"); }

  // Hard guards: never use max in chop or high volatility
  if ((regime === "CHOP_SCALP" || regime === "CHOP") && factor > 0.60) {
    factor = 0.60;
    reasonTags.push("chop_max_cap");
  }
  if (atrPercentile > 0.80 && factor > 0.50) {
    factor = 0.50;
    reasonTags.push("atr_max_cap");
  }

  factor = Math.max(0, Math.min(1, factor));
  const rawLeverage = Math.round(minLev + factor * (maxLev - minLev));

  // Apply capital mode bias (integer offset clamped to range)
  const biasedLeverage = Math.min(maxLev, Math.max(minLev, rawLeverage + leverageBias));
  reasonTags.push(`mode_${capitalMode.toLowerCase()}_bias${leverageBias >= 0 ? "+" : ""}${leverageBias}`);

  return { leverage: biasedLeverage, reasonTags };
}

/**
 * Compute contextual reward for a close outcome — richer than raw PnL.
 * Rewards efficient closes (captured most of the favorable move)
 * and penalises large adverse excursions, high slippage, and slow closes.
 */
export function computeContextualReward(x: {
  realizedPnlPct: number;
  maxFavorablePct: number;
  maxAdversePct: number;
  slippageBps: number;
  closeLatencySec: number;
  wasStopLoss: boolean;
  wasForcedClose: boolean;
}): number {
  const efficiency =
    x.maxFavorablePct > 0
      ? x.realizedPnlPct / Math.max(x.maxFavorablePct, 0.0001)
      : 0;

  let reward =
    x.realizedPnlPct * 2.0 +
    efficiency * 0.8 -
    x.maxAdversePct * 0.7 -
    (x.slippageBps / 10000) * 1.5 -
    Math.min(x.closeLatencySec / 300, 1) * 0.2;

  if (x.wasForcedClose) reward -= 0.3;
  if (x.wasStopLoss && x.maxAdversePct > 0.015) reward += 0.1;

  return Math.round(reward * 1000) / 1000;
}

// Evaluate all running agents — called periodically from routes/market engine
let _evaluationRunning = false;
export async function evaluateAllAgentsCapitalMode(): Promise<void> {
  if (_evaluationRunning) return;
  _evaluationRunning = true;
  try {
    const allAgents = await db.select({ id: agents.id, name: agents.name, isRunning: agents.autoTrade }).from(agents);
    for (const agent of allAgents) {
      if (agent.isRunning) {
        await evaluateAgentMode(agent.id);
      }
    }
  } catch (e) {
    console.warn("[CapitalMode] Batch evaluation error:", e);
  } finally {
    _evaluationRunning = false;
  }
}
