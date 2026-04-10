/**
 * Exit Engine V2 — Adaptive, profit-protective position exit logic.
 *
 * Evaluates every open position each monitor cycle and returns an ExitAction.
 * The calling code (execution-engine.ts) executes the action.
 *
 * Decision priority (evaluated in order):
 *   1. Hard safety checks       → FULL_CLOSE urgency:high
 *   2. Break-even upgrade       → MOVE_STOP
 *   3. Partial take profit      → PARTIAL_CLOSE
 *   4. ATR/stepped trailing     → MOVE_STOP
 *   5. Momentum-fade exit       → FULL_CLOSE urgency:normal
 *   6. Max-hold-time exit       → FULL_CLOSE or PARTIAL_CLOSE
 *   7. HOLD
 */

import { emaSeries, rsi as rsiCalc } from "../../shared/indicators";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ExitAction =
  | { type: "HOLD"; reason: string }
  | { type: "MOVE_STOP"; newStopPct: number; reason: string }
  | { type: "PARTIAL_CLOSE"; sizePct: number; reason: string }
  | { type: "FULL_CLOSE"; reason: string; urgency: "normal" | "high" };

/** Mutable per-position state tracked in memory (matches peakPnlTracker) */
export interface PeakTracker {
  peakPnlPct: number;
  breakEvenLocked: boolean;
  trailingSLPct: number;
  lastPnlPct: number;
  consecutiveDeclineTicks: number;
  partialTaken?: boolean;
  lastTrailStepPct?: number;   // pnl level at which trail was last stepped
  breakevenActivated?: boolean;
  trailingActivated?: boolean;
}

export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: number;
}

export interface ExitContext {
  position: {
    id: string;
    side: string;
    entryPrice: number;
    openedAt: Date | string | null;
    collateral: number | null;
    sizeSui: number;
    partialCloseCount?: number | null;
    breakevenActivated?: boolean | null;
    trailingActivated?: boolean | null;
  };
  pnlPercent: number;
  tracker: PeakTracker;
  currentPrice: number;
  liveAtrPct: number;   // ATR as % of price (e.g. 0.18 for 0.18%)
  liveAdx: number;
  regime: string;
  slHardBps: number;   // agent's hard stop-loss in bps
  tpHardBps: number;
  leverageMultiplier: number;
  collateralLossPct: number;
  candles5m: Candle[];
  agentConfig: { name: string; [key: string]: any };
  isStuck?: boolean;         // close-queue flagged this position as stuck
  oracleFresh?: boolean;     // false = oracle may be stale
}

export interface ExitConfig {
  // Break-even
  breakEvenTriggerBps: number;  // profit % to activate → 35bps = 0.35%
  breakEvenCushionPct: number;  // floor to lock in (after fees) → 0.12%

  // Partial TP
  partialTpTriggerBps: number;  // profit % to take partial → 55bps = 0.55%
  partialTpSizePct: number;     // fraction of position to close → 0.45

  // Trailing stop
  atrTrailMult: number;         // ATR multiplier for trail distance
  minTrailBps: number;          // minimum trail distance in bps
  chopTrailBps: number;         // trail distance in chop regime (bps)
  trailStepBps: number;         // PnL step before tightening trail

  // Momentum fade
  fastEmaPeriod: number;
  slowEmaPeriod: number;
  rsiMomentumLevel: number;     // RSI level for longs; (100-this) for shorts

  // Max hold
  maxHoldScalpMs: number;
  maxHoldIntradayMs: number;
}

export const DEFAULT_EXIT_CONFIG: ExitConfig = {
  breakEvenTriggerBps: 35,
  breakEvenCushionPct: 0.12,

  partialTpTriggerBps: 55,
  partialTpSizePct: 0.45,

  atrTrailMult: 1.2,
  minTrailBps: 12,
  chopTrailBps: 16,
  trailStepBps: 20,

  fastEmaPeriod: 8,
  slowEmaPeriod: 21,
  rsiMomentumLevel: 45,

  maxHoldScalpMs: 25 * 60 * 1000,   // 25 min
  maxHoldIntradayMs: 3 * 60 * 60 * 1000, // 3 hr
};

// ─────────────────────────────────────────────────────────────────────────────
// Exit Engine
// ─────────────────────────────────────────────────────────────────────────────

export class ExitEngine {
  private config: ExitConfig;

  constructor(config: Partial<ExitConfig> = {}) {
    this.config = { ...DEFAULT_EXIT_CONFIG, ...config };
  }

  evaluate(ctx: ExitContext): ExitAction {
    const { position, pnlPercent, tracker, candles5m, agentConfig } = ctx;
    const posName = `${agentConfig.name}/${position.id.slice(-6)}`;

    // ── 1. Hard Safety Checks ───────────────────────────────────────────────
    const safety = this._hardSafety(ctx);
    if (safety) {
      console.log(`[ExitEngine] ${posName}: HARD_SAFETY → ${safety.reason}`);
      return safety;
    }

    // ── 2. Break-even upgrade ───────────────────────────────────────────────
    const beAction = this._checkBreakeven(ctx);
    if (beAction.type === "MOVE_STOP") {
      console.log(`[ExitEngine] ${posName}: BREAKEVEN → stop moved to ${beAction.newStopPct.toFixed(3)}%`);
      tracker.breakEvenLocked = true;
      tracker.breakevenActivated = true;
      return beAction;
    }

    // ── 3. Partial Take Profit ──────────────────────────────────────────────
    const partialAction = this._checkPartialTP(ctx);
    if (partialAction.type === "PARTIAL_CLOSE") {
      console.log(`[ExitEngine] ${posName}: PARTIAL_TP → close ${(ctx.position.partialCloseCount ?? 0) === 0 ? "first" : "additional"} ${Math.round(this.config.partialTpSizePct * 100)}% at +${pnlPercent.toFixed(3)}%`);
      tracker.partialTaken = true;
      return partialAction;
    }

    // ── 4. ATR/Stepped Trailing Stop ────────────────────────────────────────
    const trailAction = this._checkTrailing(ctx);
    if (trailAction.type === "MOVE_STOP") {
      tracker.trailingActivated = true;
      return trailAction;
    }

    // ── 5. Momentum-fade exit ────────────────────────────────────────────────
    if (candles5m.length >= 30 && pnlPercent > 0) {
      const fadeAction = this._checkMomentumFade(ctx);
      if (fadeAction.type === "FULL_CLOSE") {
        console.log(`[ExitEngine] ${posName}: MOMENTUM_FADE → ${fadeAction.reason} at +${pnlPercent.toFixed(3)}%`);
        return fadeAction;
      }
    }

    // ── 6. Max-hold-time exit ────────────────────────────────────────────────
    const maxHoldAction = this._checkMaxHold(ctx);
    if (maxHoldAction.type !== "HOLD") {
      console.log(`[ExitEngine] ${posName}: MAX_HOLD → ${maxHoldAction.reason}`);
      return maxHoldAction;
    }

    return { type: "HOLD", reason: "no-exit-condition" };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _hardSafety(ctx: ExitContext): ExitAction | null {
    const { collateralLossPct, leverageMultiplier, isStuck, oracleFresh, pnlPercent } = ctx;

    // Stuck in close queue and now marked urgent
    if (isStuck) {
      return { type: "FULL_CLOSE", reason: "close-queue-stuck-escalation", urgency: "high" };
    }

    // Oracle stale + in loss → emergency close to prevent worse fill
    if (oracleFresh === false && pnlPercent < -0.10) {
      return { type: "FULL_CLOSE", reason: "oracle-stale-loss-emergency", urgency: "high" };
    }

    // Near-liquidation emergency (collateral loss ≥ 85% of what liquidation would be)
    const liquidationLossPct = (1 / leverageMultiplier) * 100;
    if (collateralLossPct >= liquidationLossPct * 0.80) {
      return { type: "FULL_CLOSE", reason: `near-liquidation(${collateralLossPct.toFixed(1)}%)`, urgency: "high" };
    }

    return null;
  }

  private _checkBreakeven(ctx: ExitContext): ExitAction {
    const { pnlPercent, tracker } = ctx;
    const { breakEvenTriggerBps, breakEvenCushionPct } = this.config;

    // Already locked
    if (tracker.breakEvenLocked || tracker.breakevenActivated) {
      return { type: "HOLD", reason: "breakeven-already-locked" };
    }

    const triggerPct = breakEvenTriggerBps / 100;
    if (pnlPercent >= triggerPct) {
      const newStopPct = breakEvenCushionPct; // +0.12% floor (covers protocol fees)
      // Only upgrade if it's actually better than current stop
      if (newStopPct > tracker.trailingSLPct) {
        return { type: "MOVE_STOP", newStopPct, reason: `breakeven-upgrade(pnl=${pnlPercent.toFixed(3)}%,trigger=${triggerPct.toFixed(3)}%)` };
      }
    }

    return { type: "HOLD", reason: "breakeven-not-triggered" };
  }

  private _checkPartialTP(ctx: ExitContext): ExitAction {
    const { pnlPercent, position } = ctx;
    const { partialTpTriggerBps, partialTpSizePct } = this.config;

    // Only take first partial close (one per position lifetime for now)
    const partialCount = position.partialCloseCount ?? 0;
    if (partialCount > 0) {
      return { type: "HOLD", reason: "partial-already-taken" };
    }

    const triggerPct = partialTpTriggerBps / 100;
    if (pnlPercent >= triggerPct) {
      return {
        type: "PARTIAL_CLOSE",
        sizePct: partialTpSizePct,
        reason: `partial-tp(pnl=${pnlPercent.toFixed(3)}%,trigger=${triggerPct.toFixed(3)}%,size=${Math.round(partialTpSizePct * 100)}%)`
      };
    }

    return { type: "HOLD", reason: "partial-tp-not-triggered" };
  }

  private _checkTrailing(ctx: ExitContext): ExitAction {
    const { pnlPercent, tracker, liveAtrPct, liveAdx, regime } = ctx;
    const { atrTrailMult, minTrailBps, chopTrailBps, trailStepBps } = this.config;

    if (pnlPercent <= 0) return { type: "HOLD", reason: "trailing-not-in-profit" };

    // Determine trail distance based on regime
    const isTrend = liveAdx > 22 && (regime === "TRENDING" || regime === "BREAKOUT");
    let trailDistancePct: number;

    if (isTrend && liveAtrPct > 0) {
      // ATR-based trail in trend — wider, lets winners breathe
      const atrBasedBps = liveAtrPct * 100 * atrTrailMult;
      trailDistancePct = Math.max(minTrailBps, atrBasedBps) / 100;
    } else {
      // Fixed trail in chop — tighter, captures mean-reversion profit
      trailDistancePct = chopTrailBps / 100;
    }

    // Stepped update: only tighten trail after each +20bps of favorable move
    const stepPct = trailStepBps / 100;
    const lastStep = tracker.lastTrailStepPct ?? 0;
    const stepsMoved = Math.floor((pnlPercent - lastStep) / stepPct);
    if (stepsMoved <= 0 && tracker.trailingActivated) {
      return { type: "HOLD", reason: `trailing-waiting-for-step(next=${(lastStep + stepPct).toFixed(3)}%)` };
    }

    // Compute new stop = peak - trail distance
    const newStopPct = pnlPercent - trailDistancePct;

    // Monotonic: NEVER loosen stop
    if (newStopPct <= tracker.trailingSLPct) {
      return { type: "HOLD", reason: `trailing-stop-unchanged(current=${tracker.trailingSLPct.toFixed(3)}%)` };
    }

    // Update step checkpoint
    tracker.lastTrailStepPct = lastStep + stepsMoved * stepPct;

    const trailType = isTrend ? `atr(${liveAtrPct.toFixed(3)}%×${atrTrailMult})` : `chop(${chopTrailBps}bps)`;
    return {
      type: "MOVE_STOP",
      newStopPct,
      reason: `trail-${trailType}(pnl=${pnlPercent.toFixed(3)}%,dist=${trailDistancePct.toFixed(3)}%)`
    };
  }

  private _checkMomentumFade(ctx: ExitContext): ExitAction {
    const { position, pnlPercent, candles5m } = ctx;
    const { fastEmaPeriod, slowEmaPeriod, rsiMomentumLevel } = this.config;
    const isLong = position.side === "long";

    if (candles5m.length < slowEmaPeriod + 5) {
      return { type: "HOLD", reason: "momentum-insufficient-candles" };
    }

    const closes = candles5m.map(c => c.c);

    // EMA crossover signal
    const fastEmas = emaSeries(closes, fastEmaPeriod);
    const slowEmas = emaSeries(closes, slowEmaPeriod);
    const fastNow = fastEmas[fastEmas.length - 1];
    const fastPrev = fastEmas[fastEmas.length - 2] ?? fastNow;
    const slowNow = slowEmas[slowEmas.length - 1];

    // Long: bearish if fast EMA crossed below slow EMA
    // Short: bearish if fast EMA crossed above slow EMA
    const emaCrossedAgainst = isLong
      ? (fastPrev >= slowEmas[slowEmas.length - 2] && fastNow < slowNow)
      : (fastPrev <= slowEmas[slowEmas.length - 2] && fastNow > slowNow);

    // RSI momentum check
    const currentRsi = closes.length >= 15 ? rsiCalc(closes) : 50;
    const rsiWeakForLong = isLong && currentRsi < rsiMomentumLevel;
    const rsiWeakForShort = !isLong && currentRsi > (100 - rsiMomentumLevel);
    const rsiWeak = rsiWeakForLong || rsiWeakForShort;

    // Need both EMA cross AND RSI weakness to exit on momentum fade
    // (single indicator is too noisy for exits)
    if (emaCrossedAgainst && rsiWeak && pnlPercent > 0.10) {
      return {
        type: "FULL_CLOSE",
        reason: `momentum-fade(ema-cross,rsi=${currentRsi.toFixed(0)},pnl=${pnlPercent.toFixed(3)}%)`,
        urgency: "normal"
      };
    }

    return { type: "HOLD", reason: `momentum-ok(rsi=${currentRsi.toFixed(0)},ema-cross=${emaCrossedAgainst})` };
  }

  private _checkMaxHold(ctx: ExitContext): ExitAction {
    const { position, pnlPercent } = ctx;
    const { maxHoldScalpMs, maxHoldIntradayMs } = this.config;

    if (!position.openedAt) return { type: "HOLD", reason: "no-open-time" };
    const ageMs = Date.now() - new Date(position.openedAt).getTime();

    // Scalp window: 25 min
    if (ageMs >= maxHoldScalpMs) {
      if (pnlPercent > 0.05) {
        // Positive but not fully closed — take the profit
        return {
          type: "FULL_CLOSE",
          reason: `max-hold-scalp(${(ageMs / 60000).toFixed(0)}min,pnl=+${pnlPercent.toFixed(3)}%)`,
          urgency: "normal"
        };
      }
    }

    // Intraday window: 3 hr
    if (ageMs >= maxHoldIntradayMs) {
      if (pnlPercent > 0) {
        return {
          type: "FULL_CLOSE",
          reason: `max-hold-intraday(${(ageMs / 3600000).toFixed(1)}h,pnl=+${pnlPercent.toFixed(3)}%)`,
          urgency: "normal"
        };
      } else {
        // Negative at 3hr — force close to free capital
        return {
          type: "FULL_CLOSE",
          reason: `max-hold-intraday-loss(${(ageMs / 3600000).toFixed(1)}h,pnl=${pnlPercent.toFixed(3)}%)`,
          urgency: "normal"
        };
      }
    }

    return { type: "HOLD", reason: `hold(age=${(ageMs / 60000).toFixed(0)}min)` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton instance
// ─────────────────────────────────────────────────────────────────────────────
export const exitEngine = new ExitEngine(DEFAULT_EXIT_CONFIG);
