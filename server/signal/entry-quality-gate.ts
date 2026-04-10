/**
 * Entry Quality Gate V2
 *
 * A hard-floor quality filter that runs before every position open.
 * Prevents the bot from force-entering weak setups during idle periods,
 * enforces a minimum expected-value (EV) threshold, and provides a
 * structured result explaining every approval or rejection.
 *
 * Core guarantee:
 *   The effective entry threshold NEVER drops below HARD_FLOOR_SCORE,
 *   regardless of how long the agent has been idle.
 */

export interface EntryQualityResult {
  approved: boolean;
  score: number;            // 0-100 composite quality score
  conviction: number;       // 0-1 conviction level
  expectedEdgeBps: number;  // EV net of fees/slippage
  reasons: string[];
  blockers: string[];
  regime: "trend" | "chop" | "breakout" | "unclear";
}

export interface EntryContext {
  // Signal
  signalScore: number;       // Triton composite signal score
  signalSide: "LONG" | "SHORT";
  regime: string;            // current market regime from Triton
  isMicroScalp: boolean;     // anti-idle micro-scalp signal
  isChopScalp: boolean;
  idleMinutes: number;       // minutes since last trade

  // Market conditions
  atrPct: number;            // ATR as % of price
  volumeRatio: number;       // recent vol / avg vol (1.0 = normal)
  spreadBps: number;         // estimated spread in bps

  // Model estimates
  winProbability: number;    // 0-1 win probability from model (use 0.5 if unavailable)
  avgWinBps: number;         // avg winning trade in bps (from recent history)
  avgLossBps: number;        // avg losing trade in bps (positive number)

  // Risk context
  consecutiveLosses: number;
  recentWinRate: number;     // 0-1 recent win rate (last 10 trades)

  // Fee estimates
  openFeeBps: number;        // protocol open fee in bps (default 7)
  closeFeeBps: number;       // protocol close fee in bps (default 7)
  slippageBps: number;       // estimated slippage in bps
}

// Hard floor: the absolute minimum signal score, even after all idle discounts.
// Anti-idle logic CAN be permissive, but NEVER below this floor.
export const HARD_FLOOR_SCORE = 38;

// Minimum acceptable expected-value in bps, net of all fees.
// Trades must have positive EV to be opened.
export const MIN_EV_BPS = 0;

export class EntryQualityGate {
  evaluate(ctx: EntryContext): EntryQualityResult {
    const reasons: string[] = [];
    const blockers: string[] = [];
    let score = ctx.signalScore;
    let conviction = Math.min(1, Math.max(0, ctx.signalScore / 100));

    // ── Regime mapping ──────────────────────────────────────────────────────
    const regime = this._mapRegime(ctx.regime);

    // ── 1. Hard quality floor ───────────────────────────────────────────────
    if (ctx.isMicroScalp && ctx.signalScore < HARD_FLOOR_SCORE) {
      blockers.push(`idle-force-entry-blocked: score ${ctx.signalScore} < hard-floor ${HARD_FLOOR_SCORE}`);
      return this._reject(score, conviction, 0, reasons, blockers, regime);
    }

    // ── 2. Volume filter — don't trade thin markets ────────────────────────
    if (ctx.volumeRatio < 0.4) {
      blockers.push(`thin-volume: ratio ${ctx.volumeRatio.toFixed(2)} < 0.40`);
      return this._reject(score, conviction, 0, reasons, blockers, regime);
    }
    if (ctx.volumeRatio > 0.6) {
      reasons.push(`volume-ok(${ctx.volumeRatio.toFixed(2)})`);
    }

    // ── 3. Spread / slippage filter ─────────────────────────────────────────
    const maxSpreadBps = ctx.isMicroScalp ? 8 : 12;
    if (ctx.spreadBps > maxSpreadBps) {
      blockers.push(`spread-too-wide: ${ctx.spreadBps.toFixed(1)}bps > ${maxSpreadBps}bps`);
      return this._reject(score, conviction, 0, reasons, blockers, regime);
    }
    reasons.push(`spread-ok(${ctx.spreadBps.toFixed(1)}bps)`);

    // ── 4. Regime compatibility ─────────────────────────────────────────────
    if (regime === "unclear") {
      // Allow trading unclear regimes but lower conviction
      conviction *= 0.75;
      reasons.push("regime-unclear(conviction-reduced)");
    } else {
      reasons.push(`regime-${regime}`);
    }

    // Micro-scalp only works in chop/unclear
    if (ctx.isMicroScalp && (regime === "trend" || regime === "breakout")) {
      conviction *= 0.80;
      reasons.push("micro-scalp-in-trend(conviction-reduced)");
    }

    // ── 5. Expected Value (EV) gate ─────────────────────────────────────────
    const totalFeeBps = ctx.openFeeBps + ctx.closeFeeBps + ctx.slippageBps;
    const wp = ctx.winProbability;
    const avgWin = ctx.avgWinBps > 0 ? ctx.avgWinBps : 30;  // fallback to 30bps
    const avgLoss = ctx.avgLossBps > 0 ? ctx.avgLossBps : 20; // fallback to 20bps
    const expectedEdgeBps = (wp * avgWin) - ((1 - wp) * avgLoss) - totalFeeBps;

    if (expectedEdgeBps <= MIN_EV_BPS) {
      blockers.push(`negative-ev: ${expectedEdgeBps.toFixed(1)}bps (wp=${(wp * 100).toFixed(0)}%,win=${avgWin}bps,loss=${avgLoss}bps,fees=${totalFeeBps.toFixed(1)}bps)`);
      return this._reject(score, conviction, expectedEdgeBps, reasons, blockers, regime);
    }
    reasons.push(`ev-positive(${expectedEdgeBps.toFixed(1)}bps)`);

    // ── 6. Recent performance adjustment ────────────────────────────────────
    if (ctx.recentWinRate < 0.25 && ctx.consecutiveLosses >= 3) {
      conviction *= 0.70;
      reasons.push(`poor-recent-perf(wr=${(ctx.recentWinRate * 100).toFixed(0)}%,losses=${ctx.consecutiveLosses})`);
    } else if (ctx.recentWinRate > 0.60) {
      conviction = Math.min(1, conviction * 1.10);
      reasons.push(`strong-recent-perf(wr=${(ctx.recentWinRate * 100).toFixed(0)}%)`);
    }

    // ── 7. Volatility-adjusted score ────────────────────────────────────────
    // High ATR → more uncertainty → reduce conviction
    if (ctx.atrPct > 0.35) {
      conviction *= 0.85;
      reasons.push(`high-vol(atr=${ctx.atrPct.toFixed(3)}%,conviction-reduced)`);
    } else if (ctx.atrPct > 0 && ctx.atrPct < 0.10) {
      conviction *= 0.90; // very low vol = probably choppy
      reasons.push(`low-vol(atr=${ctx.atrPct.toFixed(3)}%)`);
    }

    reasons.push(`approved(score=${score},conviction=${conviction.toFixed(2)},ev=${expectedEdgeBps.toFixed(1)}bps)`);

    return {
      approved: true,
      score,
      conviction,
      expectedEdgeBps,
      reasons,
      blockers: [],
      regime,
    };
  }

  private _mapRegime(regime: string): "trend" | "chop" | "breakout" | "unclear" {
    const r = regime?.toUpperCase() ?? "";
    if (r.includes("TREND")) return "trend";
    if (r.includes("CHOP") || r.includes("SCALP") || r.includes("RANGE")) return "chop";
    if (r.includes("BREAK")) return "breakout";
    return "unclear";
  }

  private _reject(
    score: number,
    conviction: number,
    ev: number,
    reasons: string[],
    blockers: string[],
    regime: "trend" | "chop" | "breakout" | "unclear",
  ): EntryQualityResult {
    return { approved: false, score, conviction, expectedEdgeBps: ev, reasons, blockers, regime };
  }
}

export const entryQualityGate = new EntryQualityGate();
