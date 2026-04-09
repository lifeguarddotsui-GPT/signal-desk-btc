/**
 * Agent Thoughts & Chat Engine
 * Generates real-time human-readable "thinking" summaries per agent,
 * and interprets natural-language chat commands to configure agents.
 */

export interface ThoughtParams {
  regime: string;
  side: string;
  score: number;
  idleMinutes: number;
  openPositions: number;
  winRate: number;
  consecutiveLosses: number;
  mode: string;
  balance: number;
  tradabilityScore: number;
  nudgeActive: boolean;
  threshold: number;
  price: number;
  lastBlockReason?: string;
  volumePressure?: number;
  sentimentRegime?: string;
  btcBias?: string;
}

export interface TradeEntryThoughtParams {
  side: string;
  entryPrice: number;
  stopLossBps: number;
  takeProfitBps?: number | null;
  leverage: number;
  regime: string;
  score: number;
  collateral: number;
  winProbability?: number;
  rr?: number;
  agentMode?: string;
  openedAt?: Date | null;
}

const REGIME_LABELS: Record<string, string> = {
  TREND: "trending",
  RANGE: "ranging",
  CHOP_SCALP: "choppy",
  VOLATILE: "volatile",
  TRANSITION: "transitioning",
  UNKNOWN: "uncertain",
};

export function generateAgentThought(p: ThoughtParams): string {
  const {
    regime, side, score, idleMinutes, openPositions, winRate,
    consecutiveLosses, mode, tradabilityScore, nudgeActive, threshold,
    lastBlockReason, volumePressure, sentimentRegime, btcBias, price
  } = p;

  const gap = Math.max(0, threshold - score);
  const regimeLabel = REGIME_LABELS[regime] || regime.toLowerCase();
  const modeLabel = mode === "PRECISION" ? "cautiously" : mode === "AGGRESSIVE" ? "aggressively" : mode === "NOW" ? "urgently" : "methodically";
  const sideLabel = (side === "LONG" || side === "long") ? "long" : (side === "SHORT" || side === "short") ? "short" : "";
  const btcStr = btcBias && btcBias !== "neutral" ? ` BTC ${btcBias}` : "";
  const sentStr = sentimentRegime && sentimentRegime !== "neutral" ? `, crowd ${sentimentRegime.replace("_", " ")}` : "";
  const priceStr = price > 0 ? `$${price.toFixed(4)}` : "";
  const volPressStr = volumePressure && volumePressure > 10 ? ` Volume target behind — threshold -${volumePressure}pts.` : "";

  // Active position — focus on management
  if (openPositions > 0) {
    if (sideLabel) {
      return trim(`In ${openPositions} ${sideLabel} ${openPositions > 1 ? "positions" : "position"} at ${priceStr}. Monitoring ${regimeLabel} market${btcStr} — watching SL/TP triggers ${modeLabel}.${sentStr ? ` Sentiment: ${sentStr.trim()}.` : ""}`);
    }
    return trim(`Holding ${openPositions} active ${openPositions > 1 ? "positions" : "position"} at ${priceStr}. Watching exit conditions. Market is ${regimeLabel}${btcStr}.`);
  }

  // Human nudge active
  if (nudgeActive) {
    return trim(`Human intuition nudge active — threshold relaxed to ${Math.max(20, threshold - 8)}. Scanning ${regimeLabel} market urgently${btcStr}. Score ${score} vs ${Math.max(20, threshold - 8)} — hunting entry now.`);
  }

  // Volume pressure is very high — agent must trade
  if (volumePressure && volumePressure >= 20) {
    return trim(`Volume target severely behind — urgency mode. Threshold reduced by ${volumePressure}pts to ${threshold}. ${regimeLabel.charAt(0).toUpperCase() + regimeLabel.slice(1)} market, score ${score}${btcStr}. Taking first valid setup.`);
  }

  // Very long idle — urgency — show exact relaxed threshold
  if (idleMinutes > 720) {
    const h = Math.round(idleMinutes / 60);
    return trim(`${h}h idle — threshold force-lowered to ${threshold}. ${regimeLabel.charAt(0).toUpperCase() + regimeLabel.slice(1)} market${btcStr}, score ${score}. Nearly any setup qualifies — must trade.${volPressStr}`);
  }
  if (idleMinutes > 360) {
    const h = Math.round(idleMinutes / 60);
    return trim(`${h}h idle — threshold at ${threshold}. ${regimeLabel.charAt(0).toUpperCase() + regimeLabel.slice(1)} market, score ${score}. ${sideLabel ? `Bias: ${sideLabel}. ` : ""}Actively seeking entry to meet activity targets.${volPressStr}`);
  }
  if (idleMinutes > 120) {
    return trim(`${Math.round(idleMinutes)}min idle — threshold relaxed to ${threshold}. ${regimeLabel.charAt(0).toUpperCase() + regimeLabel.slice(1)} regime${btcStr}, score ${score}. ${gap <= 5 ? "Very close to entry." : `${gap}pts away.`}${volPressStr}`);
  }
  if (idleMinutes > 60) {
    return trim(`${Math.round(idleMinutes)}min idle. ${regimeLabel.charAt(0).toUpperCase() + regimeLabel.slice(1)} market, score ${score}/${threshold}${btcStr}. ${gap <= 8 ? "Close to entry threshold." : `${gap}pts from entry.`}${volPressStr}`);
  }

  // Low tradability
  if (tradabilityScore < 35) {
    return trim(`Market tradability at ${tradabilityScore}/100 — conditions too poor for safe leverage. Conserving capital and waiting for liquidity to improve.${btcStr ? ` BTC: ${btcBias}.` : ""}`);
  }

  // Consecutive losses — reflect whether signal is actually passing or not
  if (consecutiveLosses >= 5) {
    if (score >= threshold) {
      const hedgeDir = sideLabel === "long" ? "short" : sideLabel === "short" ? "long" : "opposing";
      return trim(`${consecutiveLosses} losses in a row. ${regimeLabel} market, score ${score}/${threshold}${btcStr}. Score passing — entering next setup${consecutiveLosses >= 3 && sideLabel ? `, ready to hedge ${hedgeDir} if signal flips` : ""}.`);
    }
    return trim(`${consecutiveLosses} losses in a row — tightening quality filter. ${regimeLabel} market, score ${score}/${threshold}${btcStr}. ${gap}pts from entry — waiting for cleaner setup.`);
  }

  // Very close to entry
  if (gap <= 3 && score > 0) {
    return trim(`Almost there — score ${score}/${threshold}, only ${gap}pts from entry. ${regimeLabel.charAt(0).toUpperCase() + regimeLabel.slice(1)} market${btcStr}. ${sideLabel ? `Leaning ${sideLabel}.` : ""} Waiting for final confirmation.${volPressStr}`);
  }

  if (regime === "TREND") {
    if (sideLabel === "long") {
      return trim(`Bullish TREND — EMA stacked up, momentum building${btcStr}. Score ${score}/${threshold}, ${gap}pts from entry. ${modeLabel.charAt(0).toUpperCase() + modeLabel.slice(1)} looking for the right long entry.${volPressStr}`);
    }
    if (sideLabel === "short") {
      return trim(`Bearish TREND — EMA bearish stack, MACD declining${btcStr}. Score ${score}/${threshold}, ${gap}pts from entry. ${modeLabel.charAt(0).toUpperCase() + modeLabel.slice(1)} watching for short entry.${volPressStr}`);
    }
    return trim(`TREND regime — direction unclear. Waiting for EMA alignment and RSI confirmation${btcStr}. Score ${score}/${threshold}.${volPressStr}`);
  }

  if (regime === "RANGE") {
    return trim(`RANGE market — mean-reversion mode${btcStr}. Need RSI extreme or BB boundary touch. Score ${score}/${threshold}, ${gap}pts from entry.${sentStr ? ` Crowd: ${sentStr.trim()}.` : ""}${volPressStr}`);
  }

  if (regime === "CHOP_SCALP") {
    return trim(`CHOP market — mapping support/resistance zones${btcStr}. Looking for rejection candles + RSI extremes. Score ${score}/${threshold}, ${gap}pts from entry.${volPressStr}`);
  }

  // Low win rate
  if (winRate < 0.30 && winRate > 0) {
    return trim(`Win rate ${(winRate * 100).toFixed(0)}% — tightening quality filter. ${regimeLabel} conditions, score ${score}/${threshold}${btcStr}. Only high-conviction setups.${volPressStr}`);
  }

  // Last block reason
  if (lastBlockReason && lastBlockReason.length > 10) {
    const short = lastBlockReason.replace(/\[.*?\]/g, "").trim().slice(0, 120);
    return trim(`Scanning ${regimeLabel} market${btcStr}. Score ${score}/${threshold}. Last skip: ${short}`);
  }

  return trim(`Scanning ${regimeLabel} market ${modeLabel}${btcStr}. Score ${score}/${threshold} — ${gap}pts from entry. Tradability ${tradabilityScore}/100.${sentStr ? ` Crowd: ${sentStr.trim()}.` : ""}${volPressStr}`);
}

/**
 * Generates a specific 250-char trade entry verbalization showing:
 * - Why this direction (regime + signal context)
 * - Planned SL/TP prices
 * - Risk/reward and probability
 */
export function generateTradeEntryThought(p: TradeEntryThoughtParams): string {
  const side = p.side.toUpperCase() === "LONG" || p.side === "long" ? "long" : "short";
  const dirStr = side === "long" ? "LONG" : "SHORT";
  const regime = p.regime || "UNKNOWN";
  const regimeLabel = REGIME_LABELS[regime] || regime.toLowerCase();

  const slPrice = side === "long"
    ? p.entryPrice * (1 - p.stopLossBps / 10000)
    : p.entryPrice * (1 + p.stopLossBps / 10000);
  const tpPrice = p.takeProfitBps
    ? (side === "long"
        ? p.entryPrice * (1 + p.takeProfitBps / 10000)
        : p.entryPrice * (1 - p.takeProfitBps / 10000))
    : null;

  const probStr = p.winProbability ? `${Math.round(p.winProbability)}% prob.` : "";
  const rrStr = p.rr ? `R/R ${p.rr.toFixed(2)}×.` : "";
  const tpStr = tpPrice ? `TP $${tpPrice.toFixed(4)}` : "dynamic TP";

  // Regime-specific rationale
  let rationale = "";
  if (regime === "TREND") {
    rationale = side === "long"
      ? "EMA bull stack + MACD momentum. Riding the trend."
      : "EMA bear stack + MACD declining. Trend continuation.";
  } else if (regime === "RANGE") {
    rationale = side === "long"
      ? "RSI oversold at range support — mean-reversion bounce."
      : "RSI overbought at range resistance — fading the ceiling.";
  } else if (regime === "CHOP_SCALP") {
    rationale = side === "long"
      ? "Tight scalp off support zone in choppy market."
      : "Short scalp from resistance in choppy market.";
  } else {
    rationale = `${regimeLabel} regime — signal score ${p.score}.`;
  }

  return trim(`${dirStr} $${p.entryPrice.toFixed(4)} | ${rationale} SL $${slPrice.toFixed(4)} | ${tpStr}. ${rrStr} ${probStr} ${p.collateral.toFixed(2)} SUI × ${p.leverage}x.`);
}

function trim(s: string): string {
  return s.slice(0, 275);
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat Command Interpreter — Natural Language Agent Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface RecentTrade {
  side: string;
  entryPrice: number;
  exitPrice?: number;
  pnl?: number;
  closeReason?: string;
  openedAt?: Date | null;
  closedAt?: Date | null;
}

export interface ChatInterpretResult {
  response: string;
  configChange?: {
    field: string;
    value: any;
    label: string;
  };
}

export function interpretAgentChat(
  message: string,
  agentState: {
    name: string;
    mode: string;
    status: string;
    balance: number;
    winRate: number;
    totalTrades: number;
    openPositions: number;
    idleMinutes: number;
    leverage: number;
    stopLossBps: number;
    takeProfitBps?: number;
    consecutiveLosses: number;
    regime: string;
    score: number;
    threshold: number;
    tradabilityScore: number;
    totalPnl?: number;
    recentTrades?: RecentTrade[];
    currentPositions?: Array<{ side: string; entryPrice: number; collateral: number; unrealizedPnl?: number }>;
    sentimentRegime?: string;
    btcBias?: string;
  }
): ChatInterpretResult {
  const msg = message.trim().toLowerCase();
  const a = agentState;
  const slPct = (a.stopLossBps / 100).toFixed(2);
  const tpPct = a.takeProfitBps ? (a.takeProfitBps / 100).toFixed(2) : "auto";
  const idleStr = a.idleMinutes > 120 ? `${Math.round(a.idleMinutes / 60)}h` : a.idleMinutes > 0 ? `${Math.round(a.idleMinutes)}min` : "just traded";
  const winPct = (a.winRate * 100).toFixed(0);
  const gap = Math.max(0, a.threshold - a.score);
  const recentTrades = a.recentTrades || [];
  const lastTrade = recentTrades[recentTrades.length - 1];
  const last5Wins = recentTrades.slice(-5).filter(t => (t.pnl ?? 0) > 0).length;
  const last5Losses = recentTrades.slice(-5).filter(t => (t.pnl ?? 0) <= 0).length;
  const totalPnlStr = a.totalPnl !== undefined
    ? `${a.totalPnl >= 0 ? "+" : ""}${a.totalPnl.toFixed(3)} SUI`
    : "unknown";
  const btcStr = a.btcBias && a.btcBias !== "neutral" ? ` BTC is ${a.btcBias}.` : "";
  const sentStr = a.sentimentRegime && a.sentimentRegime !== "neutral" ? ` Crowd: ${a.sentimentRegime.replace("_", " ")}.` : "";

  // ── Greetings & Personalization ──────────────────────────────────────────────
  if (/\b(hello|hi|hey|greetings|what'?s? up|good morning|good evening|good afternoon|sup)\b/.test(msg)) {
    const timeGreet = new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 18 ? "Good afternoon" : "Good evening";
    const openNote = a.openPositions > 0 ? ` I have ${a.openPositions} position(s) open right now.` : "";
    const moodNote = a.consecutiveLosses >= 3 ? ` Bit of a rough patch — ${a.consecutiveLosses} consecutive losses, but I'm staying disciplined.` : a.winRate > 0.55 ? " Running hot lately." : "";
    return {
      response: `${timeGreet} — I'm ${a.name}.${openNote}${moodNote} Win rate ${winPct}% across ${a.totalTrades} trades. PnL: ${totalPnlStr}. Ask me anything.`,
    };
  }

  // ── Mode changes ─────────────────────────────────────────────────────────────
  if (/\b(be more aggressive|go aggressive|aggressive mode|trade more|trade faster|more trades|increase frequency|trade aggressively)\b/.test(msg)) {
    return {
      response: `Switching to AGGRESSIVE mode. Lower threshold, higher frequency. Current market: ${a.regime.toLowerCase()}. Win rate ${winPct}%, ${a.totalTrades} trades total. Expect more setups — and more volatility in results.`,
      configChange: { field: "signalMode", value: "AGGRESSIVE", label: "Signal mode → AGGRESSIVE" },
    };
  }
  if (/\b(precision|be precise|be cautious|cautious|conservative|careful|slow down|fewer trades|high quality only|quality over quantity)\b/.test(msg)) {
    return {
      response: `Switching to PRECISION mode. Only the cleanest setups from here. Current regime: ${a.regime.toLowerCase()}, tradability ${a.tradabilityScore}/100. Fewer trades, but I'll be more selective about what I take.`,
      configChange: { field: "signalMode", value: "PRECISION", label: "Signal mode → PRECISION" },
    };
  }
  if (/\b(auto mode|automatic|balanced|normal mode|auto|reset mode|default mode)\b/.test(msg)) {
    return {
      response: `Back to AUTO — the balanced default. Adapts well to changing regimes. Score ${a.score}/${a.threshold}, ${a.regime.toLowerCase()} market right now. I'll trade when conditions are right, not when they're marginal.`,
      configChange: { field: "signalMode", value: "AUTO", label: "Signal mode → AUTO" },
    };
  }
  if (/\b(now mode|trade now|force trade|trade immediately|execute now|go now|enter now)\b/.test(msg)) {
    return {
      response: `NOW mode — I'll take the next valid setup immediately. This bypasses most quality filters, so use it sparingly. Score currently ${a.score} vs threshold ${a.threshold}.`,
      configChange: { field: "signalMode", value: "NOW", label: "Signal mode → NOW" },
    };
  }

  // ── Leverage changes ──────────────────────────────────────────────────────────
  const leverageMatch = msg.match(/(?:set |use |change to |update )?leverage (?:to )?(\d+)x?/);
  if (leverageMatch) {
    const lev = parseInt(leverageMatch[1]);
    if (lev >= 2 && lev <= 50) {
      const riskNote = lev >= 30 ? "Very high leverage — strict entry quality required." : lev >= 15 ? "Moderate-high leverage — meaningful exposure per trade." : "Conservative leverage — capital preservation mode.";
      const slImpact = `At ${lev}x with ${slPct}% SL, each trade risks ${(lev * parseFloat(slPct) / 100 * 100).toFixed(1)}% of collateral.`;
      return {
        response: `Leverage → ${lev}x. ${riskNote} ${slImpact} Win rate: ${winPct}%. Think carefully at high leverage — losses compound fast.`,
        configChange: { field: "leverage", value: lev, label: `Leverage → ${lev}x` },
      };
    }
    return { response: `Leverage must be 2x–50x. You tried ${leverageMatch[1]}x. I'm currently at ${a.leverage}x.` };
  }

  // ── Stop-loss changes ──────────────────────────────────────────────────────────
  const slMatch = msg.match(/(?:set |use |change )?stop.?loss (?:to )?(\d+(?:\.\d+)?)\s*(?:bps|%|percent)?/);
  if (slMatch) {
    let val = parseFloat(slMatch[1]);
    if (val < 5) val = Math.round(val * 100);
    if (val >= 10 && val <= 500) {
      const tightNote = val < 25 ? "Very tight — I'll stop out quickly. Good for capital protection, bad for giving trades room to breathe." : val > 100 ? "Wide SL — more room to breathe but bigger losses when they hit." : "Balanced SL range.";
      return {
        response: `Stop-loss → ${val}bps (${(val / 100).toFixed(2)}%). ${tightNote} Was: ${a.stopLossBps}bps. Applies to all new positions.`,
        configChange: { field: "stopLossBps", value: val, label: `Stop-loss → ${val}bps` },
      };
    }
    return { response: `Stop-loss must be 10–500bps. You tried ${val}bps. Current: ${a.stopLossBps}bps.` };
  }

  // ── Take-profit changes ──────────────────────────────────────────────────────────
  const tpMatch = msg.match(/(?:set |use |change )?take.?profit (?:to )?(\d+(?:\.\d+)?)\s*(?:bps|%|percent)?/);
  if (tpMatch) {
    let val = parseFloat(tpMatch[1]);
    if (val < 5) val = Math.round(val * 100);
    if (val >= 10 && val <= 1000) {
      const rrNote = val > a.stopLossBps ? `R/R ${(val / a.stopLossBps).toFixed(2)}× — positive expectancy territory.` : `R/R ${(val / a.stopLossBps).toFixed(2)}× — below 1:1. Win rate needs to be high to be profitable.`;
      return {
        response: `Take-profit → ${val}bps (${(val / 100).toFixed(2)}%). ${rrNote} Was: ${a.takeProfitBps ?? "auto"}bps.`,
        configChange: { field: "takeProfitBps", value: val, label: `Take-profit → ${val}bps` },
      };
    }
    return { response: `Take-profit must be 10–1000bps. You tried ${val}bps. Current: ${a.takeProfitBps ?? "auto"}bps.` };
  }

  // ── Trade analysis & performance queries ─────────────────────────────────────
  if (/\b(why did (you|it) (enter|take|open)|what made (you|it) (enter|take|open)|explain (that |last |the )?(trade|entry|position))\b/.test(msg)) {
    if (lastTrade) {
      const dir = lastTrade.side === "long" || lastTrade.side === "LONG" ? "LONG" : "SHORT";
      const outcome = (lastTrade.pnl ?? 0) > 0 ? `winner (+${lastTrade.pnl?.toFixed(3)} SUI)` : `loser (${lastTrade.pnl?.toFixed(3)} SUI)`;
      const closeStr = lastTrade.closeReason ? ` Closed via ${lastTrade.closeReason}.` : "";
      return {
        response: `Last trade: ${dir} at $${lastTrade.entryPrice.toFixed(4)}, exited $${lastTrade.exitPrice?.toFixed(4) ?? "?"}. ${outcome}.${closeStr} Entry was based on ${a.regime.toLowerCase()} regime signal — ${a.score >= a.threshold ? "score passed threshold" : "anti-idle or nudge override"}.`,
      };
    }
    return {
      response: `I enter when the Triton signal score hits threshold (${a.threshold} for ${a.mode} mode), regime conditions align (${a.regime.toLowerCase()}), and the risk/reward clears 1.2×. If you see a weak-label trade, the anti-idle engine may have lowered the bar to keep me active.`,
    };
  }

  if (/\b(why did (you|it) (close|exit|stop)|why (was|were) (that|it|the) (closed|stopped|exited)|explain (the |that |last )?(close|exit|stop))\b/.test(msg)) {
    if (lastTrade) {
      const reason = lastTrade.closeReason;
      const closeMap: Record<string, string> = {
        "SL": "stop-loss was hit — price moved against the position by more than the configured stop distance",
        "TP": "take-profit target was reached",
        "keeper filled": "the Typus protocol keeper closed the position on-chain",
        "settled stale": "position was settled as stale after inactivity",
        "emergency": "emergency close triggered — anti-liquidation protection kicked in",
        "liquidated": "position was liquidated by the protocol",
      };
      const explain = reason && closeMap[reason] ? closeMap[reason] : reason ? `close reason: ${reason}` : "unknown reason";
      const pnlNote = (lastTrade.pnl ?? 0) < 0 ? ` Loss of ${lastTrade.pnl?.toFixed(3)} SUI.` : ` Gained ${lastTrade.pnl?.toFixed(3)} SUI.`;
      return {
        response: `Last close: ${explain}.${pnlNote} The SL was ${slPct}% from entry at $${lastTrade.entryPrice.toFixed(4)}, which gave a tight buffer at ${a.leverage}x leverage. Wider SL = less stopouts but bigger losses.`,
      };
    }
    return {
      response: `Positions close via: (1) stop-loss hit, (2) take-profit target hit, (3) on-chain keeper fill, (4) emergency anti-liquidation. With ${slPct}% SL at ${a.leverage}x, a ${(a.stopLossBps / 100 / a.leverage * 100).toFixed(2)}% price move against me triggers a stop.`,
    };
  }

  if (/\b(why (are you|did you) (enter|open) (a |the )?(second|2nd|another) (trade|position|short|long)|double (entry|position|short))\b/.test(msg)) {
    return {
      response: `I run a dual-position architecture — I can hold up to 2 simultaneous positions if the signal is strong enough and capital allows. If both positions are same direction, it's because a second signal triggered before the first closed. This is a known risk at tight SL with quick re-entry.`,
    };
  }

  if (/\b(why (are you|were you) (entering|going) short|why short|why (are you|were you) (entering|going) long|why long)\b/.test(msg)) {
    const dir = /short/.test(msg) ? "short" : "long";
    const regimeNote = a.regime === "TREND" ? `TREND regime — EMA stack confirms ${dir} bias.` : a.regime === "RANGE" ? `RANGE regime — mean-reversion from ${dir === "short" ? "resistance" : "support"}.` : `${a.regime.toLowerCase()} regime signal.`;
    return {
      response: `${dir.toUpperCase()} bias from: ${regimeNote}${btcStr}${sentStr} Signal score ${a.score}/${a.threshold}. Triton composite scores MACD, EMA, RSI, BB, HTF across 5m/1h/4h timeframes.`,
    };
  }

  if (/\b(what('s| is) (the |my |your )?(entry|stop.?loss|sl|take.?profit|tp|exit) (price|level|target)|where (is|are) (the |my )?(sl|tp|stop|target))\b/.test(msg)) {
    if (a.currentPositions && a.currentPositions.length > 0) {
      const pos = a.currentPositions[0];
      const side = pos.side?.toLowerCase() === "long" ? "long" : "short";
      const slP = side === "long" ? pos.entryPrice * (1 - a.stopLossBps / 10000) : pos.entryPrice * (1 + a.stopLossBps / 10000);
      const tpP = a.takeProfitBps ? (side === "long" ? pos.entryPrice * (1 + a.takeProfitBps / 10000) : pos.entryPrice * (1 - a.takeProfitBps / 10000)) : null;
      return {
        response: `Position: ${side.toUpperCase()} at $${pos.entryPrice.toFixed(4)}. SL: $${slP.toFixed(4)} (${slPct}%). TP: ${tpP ? `$${tpP.toFixed(4)} (${tpPct}%)` : "dynamic"}. Unrealized PnL: ${pos.unrealizedPnl !== undefined ? `${pos.unrealizedPnl >= 0 ? "+" : ""}${pos.unrealizedPnl.toFixed(3)} SUI` : "calculating..."}`,
      };
    }
    return { response: `No open positions. SL setting: ${slPct}% (${a.stopLossBps}bps). TP: ${tpPct}%. These apply to the next trade. At ${a.leverage}x leverage, SL triggers if price moves ${(a.stopLossBps / 100 / a.leverage).toFixed(2)}% against entry.` };
  }

  if (/\b(how are you doing|how am i doing|performance|stats|give me (a )?summary|full status|my stats|your stats)\b/.test(msg)) {
    const posStr = a.openPositions > 0 ? `${a.openPositions} open position(s)` : "no open positions";
    const consLoss = a.consecutiveLosses > 0 ? ` ${a.consecutiveLosses} consecutive losses.` : "";
    const recentNote = recentTrades.length >= 5 ? ` Last 5: ${last5Wins}W/${last5Losses}L.` : "";
    return {
      response: `${a.name} | ${a.status}. Balance: ${a.balance.toFixed(2)} SUI. PnL: ${totalPnlStr}. ${posStr}. WR: ${winPct}% (${a.totalTrades} trades).${consLoss}${recentNote} Mode: ${a.mode}. Idle: ${idleStr}.`,
    };
  }

  if (/\b(what are you (doing|thinking|planning|working on)|your (plan|strategy|current thought)|what('s| is) your plan|what('s| is) (your|the) (strategy|game plan))\b/.test(msg)) {
    const posNote = a.openPositions > 0 && a.currentPositions?.length
      ? `Managing ${a.openPositions} ${a.currentPositions[0].side.toLowerCase()} position(s) at $${a.currentPositions[0].entryPrice.toFixed(4)}.`
      : "No positions — scanning for setup.";
    return {
      response: `${posNote} ${a.regime} market, tradability ${a.tradabilityScore}/100.${btcStr}${sentStr} Score ${a.score}/${a.threshold} — ${gap === 0 ? "at threshold" : `${gap}pts from entry`}. Mode: ${a.mode}. Idle: ${idleStr}.`,
    };
  }

  if (/\b(what('s| is) the (market|regime|condition|situation)|market (status|update|regime|conditions))\b/.test(msg)) {
    return {
      response: `Regime: ${a.regime}. Tradability: ${a.tradabilityScore}/100. Score: ${a.score}/${a.threshold}${gap > 0 ? ` (${gap}pts from entry)` : " — at threshold"}.${btcStr}${sentStr}${a.consecutiveLosses > 0 ? ` Warning: ${a.consecutiveLosses} consecutive losses.` : ""}`,
    };
  }

  if (/\b(what('s?| is) my (win rate|performance|results)|show (me )?my (stats|performance|results))\b/.test(msg)) {
    const recent = recentTrades.slice(-5);
    const recentWR = recent.length > 0 ? `${recent.filter(t => (t.pnl ?? 0) > 0).length}/${recent.length} last ${recent.length}` : "";
    return {
      response: `Win rate: ${winPct}% (${a.totalTrades} trades). Total PnL: ${totalPnlStr}. Balance: ${a.balance.toFixed(2)} SUI.${recentWR ? ` Recent: ${recentWR}.` : ""} SL: ${slPct}%, TP: ${tpPct}%, leverage: ${a.leverage}x.`,
    };
  }

  if (/\b(why (aren'?t|are you not|haven'?t|didn'?t) (you )?(traded|trading|entered|entering)|why no trades|why idle|why not trading|why haven'?t you traded)\b/.test(msg)) {
    const blockNote = a.score < a.threshold ? `Score ${a.score} is ${gap}pts below threshold ${a.threshold} for ${a.mode} mode.` : "Signal score meets threshold but other conditions not aligned.";
    const tradNote = a.tradabilityScore < 40 ? ` Market tradability ${a.tradabilityScore}/100 — too low.` : "";
    const lossNote = a.consecutiveLosses >= 3 ? ` ${a.consecutiveLosses} consecutive losses — slightly more selective.` : "";
    return {
      response: `${blockNote}${tradNote}${lossNote}${idleStr !== "just traded" ? ` Idle ${idleStr} — threshold progressively relaxing.` : ""} Regime: ${a.regime.toLowerCase()}.${btcStr}`,
    };
  }

  if (/\b(what (does|is) (the |a )?(sl|stop.?loss|tp|take.?profit|regime|score|threshold|leverage|r.?r|rr|risk.?reward) (mean|do|represent|stand for))\b/.test(msg)) {
    if (/sl|stop.?loss/.test(msg)) return { response: `Stop-loss (SL): the price level where I automatically exit to cap the loss. Set to ${slPct}% from entry. At ${a.leverage}x, a ${(a.stopLossBps / 100 / a.leverage).toFixed(2)}% move triggers it. Tighter SL = less loss per trade, but more frequent stops.` };
    if (/tp|take.?profit/.test(msg)) return { response: `Take-profit (TP): the target price where I lock in gains. Currently ${tpPct}% from entry. Actual exit may happen earlier if the signal flips or market conditions worsen.` };
    if (/regime/.test(msg)) return { response: `Regime: the current market character — TREND (directional), RANGE (oscillating), CHOP_SCALP (choppy tight scalp), VOLATILE, or TRANSITION. Each regime uses different scoring criteria. Currently: ${a.regime}.` };
    if (/score|threshold/.test(msg)) return { response: `Signal score: 0–100, computed by Triton across MACD, EMA, RSI, Bollinger Bands, and HTF bias on 5m/1h/4h. Threshold for ${a.mode} mode: ${a.threshold}. Currently at ${a.score}.` };
    if (/r.?r|risk.?reward/.test(msg)) return { response: `Risk/Reward (R/R): ratio of potential gain to potential loss. SL ${slPct}% vs TP ${tpPct}% = R/R ${a.takeProfitBps ? (a.takeProfitBps / a.stopLossBps).toFixed(2) : "dynamic"}×. I require 1.2× minimum to enter.` };
  }

  if (/\b(last trade|recent trade|most recent|previous trade|what happened|recap)\b/.test(msg)) {
    if (lastTrade) {
      const dir = lastTrade.side.toUpperCase();
      const win = (lastTrade.pnl ?? 0) > 0;
      const pnlStr = lastTrade.pnl !== undefined ? `${win ? "+" : ""}${lastTrade.pnl.toFixed(3)} SUI` : "unknown";
      return {
        response: `Last trade: ${dir} at $${lastTrade.entryPrice.toFixed(4)}, exited $${lastTrade.exitPrice?.toFixed(4) ?? "?"}. Result: ${pnlStr}. Close reason: ${lastTrade.closeReason ?? "unknown"}. ${recentTrades.length >= 3 ? `Last 3 trades: ${recentTrades.slice(-3).map(t => (t.pnl ?? 0) > 0 ? "W" : "L").join("")}.` : ""}`,
      };
    }
    return { response: `No completed trades to recap yet. I have ${a.totalTrades} total trades on record. ${a.openPositions > 0 ? `${a.openPositions} position(s) open right now.` : ""}` };
  }

  if (/\b(what('s| is) (the |your |my )?(biggest|worst|best|biggest) (loss|win|trade|mistake)|worst trade|best trade)\b/.test(msg)) {
    if (recentTrades.length > 0) {
      const worst = recentTrades.reduce((a, b) => (a.pnl ?? 0) < (b.pnl ?? 0) ? a : b);
      const best = recentTrades.reduce((a, b) => (a.pnl ?? 0) > (b.pnl ?? 0) ? a : b);
      if (/worst|loss|bad/.test(msg)) return { response: `Worst recent trade: ${worst.side.toUpperCase()} at $${worst.entryPrice.toFixed(4)}, result: ${worst.pnl?.toFixed(3)} SUI. Close reason: ${worst.closeReason ?? "?"}. Win rate historically: ${winPct}%.` };
      return { response: `Best recent trade: ${best.side.toUpperCase()} at $${best.entryPrice.toFixed(4)}, result: ${best.pnl !== undefined ? `+${best.pnl.toFixed(3)}` : "?"} SUI. Close reason: ${best.closeReason ?? "?"}. Leverage: ${a.leverage}x.` };
    }
    return { response: `Not enough trade history to identify best/worst yet. ${a.totalTrades} total trades so far.` };
  }

  if (/\b(am i (profitable|making money|in profit)|are you (profitable|in profit)|total (pnl|profit|loss))\b/.test(msg)) {
    const profitable = (a.totalPnl ?? 0) >= 0;
    return {
      response: `Total PnL: ${totalPnlStr}. ${profitable ? "Currently profitable." : "Currently at a net loss."} Win rate ${winPct}% across ${a.totalTrades} trades. Balance: ${a.balance.toFixed(2)} SUI funding wallet. Keep in mind fees and funding costs affect net PnL.`,
    };
  }

  if (/\b(what can (you|i)|how (do|can) i|help|commands|options|guide|what should i|what do i)\b/.test(msg)) {
    return {
      response: `I understand: "be aggressive/cautious/auto/now", "set leverage 25x", "set stop-loss 40bps", "set take-profit 80bps", "what's the market?", "why aren't you trading?", "explain last trade", "where's my stop?", "last trade recap", "how am I doing?", "am I profitable?"`,
    };
  }

  if (/\b(stop|pause|halt|stop trading|freeze)\b/.test(msg)) {
    return {
      response: `To pause me, use the Pause button in the agent controls — I can't self-pause via chat for safety reasons. I'll stay disciplined and only take above-threshold setups until then. Score: ${a.score}/${a.threshold}.`,
    };
  }

  if (/\b(resume|start|unpause|activate|go|let'?s? go|start trading|come back)\b/.test(msg)) {
    return {
      response: `I'm already scanning for trades in ${a.mode} mode. Score ${a.score}/${a.threshold}, ${a.regime.toLowerCase()} market.${a.openPositions > 0 ? ` Currently managing ${a.openPositions} open position(s).` : ""} If I'm paused, use the Resume button in controls.`,
    };
  }

  if (/\b(how do (i|you) make (money|profit)|is (this|it) profitable|profitability|explain (the )?strategy|how does (it|this) work)\b/.test(msg)) {
    return {
      response: `I trade SUI-USDC perpetuals at ${a.leverage}x leverage. Entry when Triton signal score ≥ ${a.threshold} in ${a.mode} mode. SL at ${slPct}% | TP at ${tpPct}%. Win rate ${winPct}%. The learning engine adapts my parameters based on trade outcomes. PnL: ${totalPnlStr}.`,
    };
  }

  if (/\b(what('s| is) (your |the )?leverage|current leverage|leverage setting|how much leverage)\b/.test(msg)) {
    return { response: `Leverage: ${a.leverage}x. SL: ${slPct}% | TP: ${tpPct}%. Each trade uses ~${(a.balance * 0.2).toFixed(2)} SUI collateral. At ${a.leverage}x, a ${(a.stopLossBps / 100 / a.leverage).toFixed(2)}% move triggers the stop-loss.` };
  }

  if (/\b(what('s| is) (my|your|the) (balance|wallet|funds|capital)|how much (money|sui|capital) (do|have))\b/.test(msg)) {
    return { response: `Funding wallet: ${a.balance.toFixed(4)} SUI.${a.openPositions > 0 ? ` ${a.openPositions} position(s) active — some capital is deployed.` : ""} Total PnL: ${totalPnlStr}.` };
  }

  if (/\b(tighten|loosen|widen) (the )?(stop.?loss|sl|stop)\b/.test(msg)) {
    const direction = /tighten/.test(msg) ? "tighter" : "wider";
    const newBps = /tighten/.test(msg) ? Math.max(15, a.stopLossBps - 10) : Math.min(200, a.stopLossBps + 15);
    return {
      response: `Making SL ${direction}: ${a.stopLossBps}bps → ${newBps}bps (${(newBps / 100).toFixed(2)}%). ${direction === "tighter" ? "Less breathing room but smaller losses when stopped." : "More breathing room but larger losses. Good for choppy markets."}`,
      configChange: { field: "stopLossBps", value: newBps, label: `Stop-loss → ${newBps}bps` },
    };
  }

  if (/\b(what (regime|market|conditions) (is|are) (best|ideal|good) for (you|this|trading)|best (market|conditions|regime) for (you|this))\b/.test(msg)) {
    return {
      response: `I perform best in clear TREND regimes — EMA stack, strong MACD, directional momentum. RANGE is workable if RSI extremes are clean. CHOP is toughest — tight scalps, quick stops. Current: ${a.regime}. Tradability: ${a.tradabilityScore}/100.`,
    };
  }

  if (/\b(why (the )?two|why (are there|do you have) two (positions|trades|shorts|longs)|second position|dual position)\b/.test(msg)) {
    return {
      response: `Dual-position architecture allows up to 2 simultaneous positions when signal strength and capital support it. The second entry is an independent signal — not averaging down. If both hit SL in the same move, that's the main risk of dual-pos.`,
    };
  }

  if (/\b(what is (sui|typus|perpetual|perp)|explain (sui|typus|perpetuals|perps))\b/.test(msg)) {
    return {
      response: `SUI is the native token of the Sui blockchain. I trade SUI-USDC perpetual contracts on Typus Finance — synthetic exposure to SUI price, long or short, with up to ${a.leverage}x leverage. No actual SUI is bought/sold — it's settled in USDC.`,
    };
  }

  // ── Generic / unknown ─────────────────────────────────────────────────────────
  return {
    response: `I'm ${a.name} in ${a.mode} mode — ${a.regime.toLowerCase()} market, score ${a.score}/${a.threshold}${gap > 0 ? ` (${gap}pts from entry)` : ", at entry threshold"}. ${a.openPositions > 0 ? `${a.openPositions} position(s) open.` : "No positions."} Win rate ${winPct}%, PnL ${totalPnlStr}. Try: "explain last trade", "where's my stop?", "why aren't you trading?", or "help".`,
  };
}
