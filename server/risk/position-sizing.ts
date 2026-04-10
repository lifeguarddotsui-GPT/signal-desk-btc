/**
 * Position Sizing & Leverage Controller V2
 *
 * Replaces ad-hoc collateral sizing with a risk-budget driven framework.
 * Key properties:
 *  - Sizes from a fixed % risk budget per trade, not arbitrary collateral
 *  - Scales leverage DOWN automatically in high volatility
 *  - Scales leverage DOWN automatically during drawdowns
 *  - Always preserves a capital reserve (never fully deploys)
 *  - Scales position size by conviction score
 */

export interface PositionSizingContext {
  // Account state
  agentBalance: number;       // total agent wallet balance in SUI
  lockedCollateral: number;   // SUI already committed to open positions
  depositedSui: number;       // original deposit (for drawdown calc)
  equityPeak: number;         // highest balance seen (for drawdown calc)

  // Per-trade parameters
  stopLossBps: number;        // dynamic SL distance in bps (e.g. 50)
  takeProfitBps: number;      // dynamic TP distance in bps (e.g. 100)
  conviction: number;         // 0-1 model conviction
  leverage: number;           // agent's configured leverage
  maxLeverage: number;        // absolute max leverage cap

  // Market conditions
  atrPct: number;             // ATR as % of price
  targetVolPct: number;       // reference "normal" volatility (default 0.18%)
  regime: string;

  // Agent constraints
  minCollateral: number;      // minimum trade collateral (SUI)
  maxCollateral: number;      // maximum trade collateral (SUI)
  maxConcurrentPositions: number;
  openPositionCount: number;

  // Performance
  rollingDrawdownPct: number; // rolling drawdown % from peak
  consecutiveLosses: number;
}

export interface SizeDecision {
  collateral: number;
  leverage: number;
  notional: number;
  riskPctOfEquity: number;
  reasons: string[];
  blocked: boolean;
  blockReason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration defaults
// ─────────────────────────────────────────────────────────────────────────────

export interface SizingConfig {
  // Risk budget per trade (% of total equity)
  baseRiskPct: number;       // standard risk per trade: 0.75%
  highConvRiskPct: number;   // high conviction (>0.75): 1.00%
  lowConvRiskPct: number;    // low conviction (<0.40): 0.40%

  // Capital reserve — never deploy below this
  reservePct: number;        // keep 30% of free balance as reserve

  // Volatility adjustment
  targetVolPct: number;      // reference ATR% for normal market (0.18%)
  volAdjClampLow: number;    // minimum vol adjustment factor (0.50)
  volAdjClampHigh: number;   // maximum vol adjustment factor (1.20)

  // Drawdown protection
  drawdownCutLevel1Pct: number;  // 5% drawdown → cut leverage
  drawdownCutLevel2Pct: number;  // 12% drawdown → severe cuts
  drawdownCutLevel3Pct: number;  // 20% drawdown → survival mode
}

const DEFAULT_SIZING_CONFIG: SizingConfig = {
  baseRiskPct: 0.0075,
  highConvRiskPct: 0.010,
  lowConvRiskPct: 0.004,

  reservePct: 0.30,

  targetVolPct: 0.18,
  volAdjClampLow: 0.50,
  volAdjClampHigh: 1.20,

  drawdownCutLevel1Pct: 5,
  drawdownCutLevel2Pct: 12,
  drawdownCutLevel3Pct: 20,
};

// ─────────────────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────────────────

export class PositionSizingEngine {
  private cfg: SizingConfig;

  constructor(config: Partial<SizingConfig> = {}) {
    this.cfg = { ...DEFAULT_SIZING_CONFIG, ...config };
  }

  decide(ctx: PositionSizingContext): SizeDecision {
    const reasons: string[] = [];
    const {
      agentBalance, lockedCollateral, equityPeak,
      stopLossBps, conviction, leverage, maxLeverage,
      atrPct, targetVolPct, regime,
      minCollateral, maxCollateral,
      rollingDrawdownPct, consecutiveLosses,
      openPositionCount, maxConcurrentPositions,
    } = ctx;

    // ── Drawdown protection — apply before anything else ────────────────────
    let leverageCap = maxLeverage;
    let riskMultiplier = 1.0;

    if (rollingDrawdownPct >= this.cfg.drawdownCutLevel3Pct) {
      // Survival mode: extreme capital preservation
      leverageCap = Math.min(leverageCap, 3);
      riskMultiplier = 0.25;
      reasons.push(`survival-mode(dd=${rollingDrawdownPct.toFixed(1)}%)`);
    } else if (rollingDrawdownPct >= this.cfg.drawdownCutLevel2Pct) {
      leverageCap = Math.min(leverageCap, 5);
      riskMultiplier = 0.50;
      reasons.push(`heavy-drawdown(dd=${rollingDrawdownPct.toFixed(1)}%)`);
    } else if (rollingDrawdownPct >= this.cfg.drawdownCutLevel1Pct) {
      leverageCap = Math.min(leverageCap, Math.floor(leverage * 0.70));
      riskMultiplier = 0.75;
      reasons.push(`moderate-drawdown(dd=${rollingDrawdownPct.toFixed(1)}%)`);
    }

    // Consecutive losses also reduce size
    if (consecutiveLosses >= 5) {
      riskMultiplier *= 0.75;
      reasons.push(`loss-streak(${consecutiveLosses}×,size-0.75x)`);
    } else if (consecutiveLosses >= 3) {
      riskMultiplier *= 0.90;
      reasons.push(`loss-streak(${consecutiveLosses}×,size-0.90x)`);
    }

    // ── Usable equity — subtract locked collateral and reserve ───────────────
    const freeBalance = agentBalance - lockedCollateral;
    const reserveTarget = agentBalance * this.cfg.reservePct;
    const usableEquity = Math.max(0, freeBalance - reserveTarget);

    if (usableEquity <= 0) {
      return this._block(`reserve-breached(free=${freeBalance.toFixed(3)},reserve=${reserveTarget.toFixed(3)})`, ctx);
    }

    // ── Risk budget ──────────────────────────────────────────────────────────
    let riskPct = this.cfg.baseRiskPct;
    if (conviction >= 0.75) {
      riskPct = this.cfg.highConvRiskPct;
      reasons.push(`high-conviction(${conviction.toFixed(2)},risk=${(riskPct * 100).toFixed(2)}%)`);
    } else if (conviction < 0.40) {
      riskPct = this.cfg.lowConvRiskPct;
      reasons.push(`low-conviction(${conviction.toFixed(2)},risk=${(riskPct * 100).toFixed(2)}%)`);
    }
    riskPct *= riskMultiplier;

    const riskBudget = agentBalance * riskPct;

    // ── Volatility adjustment ────────────────────────────────────────────────
    const refVol = targetVolPct ?? this.cfg.targetVolPct;
    let volAdj = 1.0;
    if (atrPct > 0 && refVol > 0) {
      volAdj = clamp(refVol / atrPct, this.cfg.volAdjClampLow, this.cfg.volAdjClampHigh);
      reasons.push(`vol-adj(atr=${atrPct.toFixed(3)}%,ref=${refVol.toFixed(3)}%,adj=${volAdj.toFixed(2)}x)`);
    }

    // ── Conviction sizing multiplier ─────────────────────────────────────────
    const convMult = clamp(0.5 + conviction, 0.5, 1.25);

    // ── Compute notional from risk budget ────────────────────────────────────
    // If SL is 50bps = 0.50%, and we risk R SUI, then: R = notional × SL%
    // → notional = R / SL%
    const stopPct = stopLossBps / 10000;
    if (stopPct <= 0) {
      return this._block("zero-stop-distance", ctx);
    }

    let notional = (riskBudget / stopPct) * volAdj * convMult;

    // ── Leverage & collateral derivation ────────────────────────────────────
    // Reduce leverage in high volatility
    let effectiveLeverage = Math.min(leverage, leverageCap);
    if (atrPct > 0.25) {
      // ATR > 0.25% → reduce leverage by 30%
      effectiveLeverage = Math.max(2, Math.floor(effectiveLeverage * 0.70));
      reasons.push(`vol-lev-cut(atr=${atrPct.toFixed(3)}%,lev=${effectiveLeverage}x)`);
    } else if (atrPct > 0.18) {
      effectiveLeverage = Math.max(2, Math.floor(effectiveLeverage * 0.85));
      reasons.push(`vol-lev-trim(atr=${atrPct.toFixed(3)}%,lev=${effectiveLeverage}x)`);
    }

    // In chop regimes, cap leverage lower
    const regimeUpper = regime?.toUpperCase() ?? "";
    if (regimeUpper.includes("CHOP") || regimeUpper.includes("SCALP")) {
      effectiveLeverage = Math.min(effectiveLeverage, Math.floor(maxLeverage * 0.55));
      reasons.push(`chop-lev-cap(${effectiveLeverage}x)`);
    }

    const collateral = notional / effectiveLeverage;

    // ── Clamp to [min, max] collateral bounds ────────────────────────────────
    let finalCollateral = clamp(collateral, minCollateral, maxCollateral);

    // Also clamp by usable equity
    finalCollateral = Math.min(finalCollateral, usableEquity);

    if (finalCollateral < minCollateral) {
      return this._block(`below-min-collateral(${finalCollateral.toFixed(4)}<${minCollateral})`, ctx);
    }

    const finalNotional = finalCollateral * effectiveLeverage;
    const finalRiskPct = (finalCollateral * (stopLossBps / 100)) / agentBalance * 100;

    reasons.push(`size(coll=${finalCollateral.toFixed(4)}SUI,lev=${effectiveLeverage}x,notional=${finalNotional.toFixed(3)}SUI)`);

    return {
      collateral: finalCollateral,
      leverage: effectiveLeverage,
      notional: finalNotional,
      riskPctOfEquity: finalRiskPct,
      reasons,
      blocked: false,
    };
  }

  private _block(reason: string, ctx: PositionSizingContext): SizeDecision {
    return {
      collateral: 0,
      leverage: 0,
      notional: 0,
      riskPctOfEquity: 0,
      reasons: [],
      blocked: true,
      blockReason: reason,
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export const positionSizingEngine = new PositionSizingEngine();
