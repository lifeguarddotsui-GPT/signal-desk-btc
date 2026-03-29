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
}

const REGIME_LABELS: Record<string, string> = {
  TREND: "trending",
  RANGE: "ranging",
  CHOP_SCALP: "choppy",
  UNKNOWN: "uncertain",
};

export function generateAgentThought(p: ThoughtParams): string {
  const {
    regime, side, score, idleMinutes, openPositions, winRate,
    consecutiveLosses, mode, tradabilityScore, nudgeActive, threshold, lastBlockReason
  } = p;

  const gap = Math.max(0, threshold - score);
  const regimeLabel = REGIME_LABELS[regime] || regime.toLowerCase();
  const modeLabel = mode === "PRECISION" ? "cautiously" : mode === "AGGRESSIVE" ? "aggressively" : mode === "NOW" ? "urgently" : "methodically";

  // Active position — focus on management
  if (openPositions > 0) {
    const sideLabel = (side === "LONG" || side === "long") ? "long" : (side === "SHORT" || side === "short") ? "short" : "";
    if (sideLabel) {
      return trim(`In ${openPositions} ${sideLabel} ${openPositions > 1 ? "positions" : "position"}. Monitoring ${regimeLabel} market — watching SL/TP triggers ${modeLabel}.`);
    }
    return trim(`Holding ${openPositions} active ${openPositions > 1 ? "positions" : "position"}. Watching exit conditions. Market is ${regimeLabel}.`);
  }

  // Human nudge active
  if (nudgeActive) {
    return trim(`Human intuition nudge active — threshold relaxed. Scanning ${regimeLabel} market urgently. Score ${score} vs ${Math.max(30, threshold - 8)} — hunting entry.`);
  }

  // Consecutive losses — be cautious
  if (consecutiveLosses >= 4) {
    return trim(`${consecutiveLosses} losses in a row — threshold tightened. Not forcing trades. Waiting for a truly clean signal before deploying capital.`);
  }
  if (consecutiveLosses >= 3) {
    return trim(`3 consecutive losses — raising the bar. ${regimeLabel.charAt(0).toUpperCase() + regimeLabel.slice(1)} conditions, score ${score}/${threshold}. Next entry must be high conviction.`);
  }

  // Very long idle — urgency
  if (idleMinutes > 480) {
    const h = Math.round(idleMinutes / 60);
    return trim(`${h}h idle — threshold relaxed to ${threshold}. ${regimeLabel.charAt(0).toUpperCase() + regimeLabel.slice(1)} market, score ${score}. Micro-scalp mode active — any clean setup will do.`);
  }
  if (idleMinutes > 240) {
    return trim(`4h+ idle in ${regimeLabel} market. Score ${score}/${threshold} — threshold progressively relaxed. Scanning for micro-scalp and range setups ${modeLabel}.`);
  }
  if (idleMinutes > 90) {
    return trim(`${Math.round(idleMinutes)}min idle — micro-scalp scanner active. ${regimeLabel.charAt(0).toUpperCase() + regimeLabel.slice(1)} regime, score ${score}/${threshold}. ${gap <= 5 ? "Nearly at threshold — close to entry." : `${gap}pts from entry.`}`);
  }

  // Low tradability
  if (tradabilityScore < 35) {
    return trim(`Market tradability at ${tradabilityScore}/100 — not ideal for trading. Conserving capital and waiting for better conditions.`);
  }

  // Very close to entry
  if (gap <= 3 && score > 0) {
    return trim(`Score ${score} vs threshold ${threshold} — practically at entry! ${regimeLabel.charAt(0).toUpperCase() + regimeLabel.slice(1)} bias: ${side || "neutral"}. Waiting for final confirmation.`);
  }
  if (gap <= 8 && score > 0) {
    return trim(`Nearly there — score ${score}/${threshold}. ${regimeLabel.charAt(0).toUpperCase() + regimeLabel.slice(1)} regime, ${side || "neutral"} bias. ${modeLabel.charAt(0).toUpperCase() + modeLabel.slice(1)} building conviction.`);
  }

  // Regime-specific thoughts
  if (regime === "TREND") {
    if (side === "LONG" || side === "long") {
      return trim(`Bullish TREND detected. EMA stacked, momentum building — score ${score}/${threshold}. ${gap}pts from entry. ${modeLabel.charAt(0).toUpperCase() + modeLabel.slice(1)} waiting for pullback confirmation.`);
    }
    if (side === "SHORT" || side === "short") {
      return trim(`Bearish TREND detected. EMA bearish stack, MACD falling — score ${score}/${threshold}. ${gap}pts from entry. ${modeLabel.charAt(0).toUpperCase() + modeLabel.slice(1)} watching for short entry.`);
    }
    return trim(`TREND regime active but direction unclear. Waiting for EMA alignment and RSI confirmation before committing capital.`);
  }

  if (regime === "RANGE") {
    return trim(`RANGE market — mean-reversion mode. Need RSI extreme or BB boundary touch. Score ${score}/${threshold}, ${gap}pts from entry.`);
  }

  if (regime === "CHOP_SCALP") {
    return trim(`CHOP market. Mapping support/resistance zones — looking for rejection candles and RSI extremes. Score ${score}/${threshold}.`);
  }

  // Low win rate
  if (winRate < 0.35 && winRate > 0) {
    return trim(`Win rate ${(winRate * 100).toFixed(0)}% — focusing on quality. ${regimeLabel} conditions, score ${score}/${threshold}. Not forcing sub-optimal setups.`);
  }

  // Generic fallback
  if (lastBlockReason && lastBlockReason.length > 10) {
    const short = lastBlockReason.replace(/\[.*?\]/g, "").trim().slice(0, 100);
    return trim(`Analysing ${regimeLabel} market. Score ${score}/${threshold}. Block: ${short}`);
  }

  return trim(`Scanning ${regimeLabel} market ${modeLabel}. Score ${score}/${threshold} — ${gap}pts from entry. Tradability: ${tradabilityScore}/100.`);
}

function trim(s: string): string {
  return s.slice(0, 250);
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat Command Interpreter
// ─────────────────────────────────────────────────────────────────────────────

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
  }
): ChatInterpretResult {
  const msg = message.trim().toLowerCase();
  const a = agentState;

  // ── Mode changes ─────────────────────────────────────────────────────────────
  if (/\b(be more aggressive|go aggressive|aggressive mode|trade more|trade faster|more trades)\b/.test(msg)) {
    return {
      response: `Switching to AGGRESSIVE mode. I'll lower my entry threshold and take more setups with less filtering. Current market: ${a.regime.toLowerCase()}. Win rate ${(a.winRate * 100).toFixed(0)}% — trade count will increase.`,
      configChange: { field: "signalMode", value: "AGGRESSIVE", label: "Signal mode → AGGRESSIVE" },
    };
  }
  if (/\b(precision|be precise|be cautious|cautious|conservative|careful|slow down|fewer trades)\b/.test(msg)) {
    return {
      response: `Switching to PRECISION mode. I'll only take the highest-confidence setups and ignore marginal signals. Fewer trades, but better quality. Good call in a ${a.regime.toLowerCase()} market.`,
      configChange: { field: "signalMode", value: "PRECISION", label: "Signal mode → PRECISION" },
    };
  }
  if (/\b(auto mode|automatic|balanced|normal mode)\b/.test(msg)) {
    return {
      response: `Back to AUTO mode — balanced approach. I'll trade when conditions are good without being too selective or too reckless. Works well across all regimes.`,
      configChange: { field: "signalMode", value: "AUTO", label: "Signal mode → AUTO" },
    };
  }
  if (/\b(now mode|trade now|force trade|immediate)\b/.test(msg)) {
    return {
      response: `NOW mode activated. I'll attempt to place a trade on the very next signal regardless of score. Use sparingly — this overrides my quality filters.`,
      configChange: { field: "signalMode", value: "NOW", label: "Signal mode → NOW" },
    };
  }

  // ── Leverage changes ─────────────────────────────────────────────────────────
  const leverageMatch = msg.match(/(?:set )?leverage (?:to )?(\d+)x?/);
  if (leverageMatch) {
    const lev = parseInt(leverageMatch[1]);
    if (lev >= 2 && lev <= 50) {
      return {
        response: `Updating leverage to ${lev}x. ${lev > 20 ? "High leverage — I'll be extra strict on entry quality to protect collateral." : lev <= 5 ? "Conservative leverage — good for capital preservation." : "Moderate leverage — balanced risk/reward."}`,
        configChange: { field: "leverage", value: lev, label: `Leverage → ${lev}x` },
      };
    }
    return { response: `Leverage must be between 2x and 50x (Typus protocol limit). Current: ${a.leverage}x.` };
  }

  // ── Status / info queries ────────────────────────────────────────────────────
  if (/\b(how are you|how am i doing|performance|stats|status)\b/.test(msg)) {
    const winPct = (a.winRate * 100).toFixed(0);
    const idleStr = a.idleMinutes > 120 ? `${Math.round(a.idleMinutes / 60)}h idle` : a.idleMinutes > 0 ? `${Math.round(a.idleMinutes)}min idle` : "just traded";
    return {
      response: `I'm ${a.status}. ${a.balance.toFixed(2)} SUI in wallet, ${a.openPositions} open position(s). Win rate: ${winPct}% across ${a.totalTrades} trades. Currently ${idleStr}. Mode: ${a.mode}.`,
    };
  }

  if (/\b(what are you (doing|thinking|planning)|your (plan|strategy|thought))\b/.test(msg)) {
    const gap = Math.max(0, a.threshold - a.score);
    return {
      response: `${a.regime} market, tradability ${a.tradabilityScore}/100. Signal score ${a.score}/${a.threshold} — ${gap === 0 ? "at threshold, searching for entry" : `${gap}pts from entry`}. ${a.openPositions > 0 ? `Managing ${a.openPositions} open position(s).` : "No open positions — scanning for setup."}`,
    };
  }

  if (/\b(what('s| is) the (market|regime|condition))\b/.test(msg)) {
    return {
      response: `Current regime: ${a.regime}. Tradability: ${a.tradabilityScore}/100. Signal score: ${a.score}/${a.threshold}. ${a.consecutiveLosses > 0 ? `Note: ${a.consecutiveLosses} consecutive losses — threshold is higher than usual.` : ""}`,
    };
  }

  if (/\b(stop|pause|halt)\b/.test(msg)) {
    return {
      response: `I can't self-pause from chat — use the Pause button in the agent controls. I'll keep my hands steady and only trade on high-conviction setups in the meantime.`,
    };
  }

  if (/\b(hello|hi|hey|greetings)\b/.test(msg)) {
    return {
      response: `Hey. I'm ${a.name} — watching the ${a.regime.toLowerCase()} market. Score ${a.score}/${a.threshold}, ${a.openPositions} open position(s). What would you like to adjust?`,
    };
  }

  if (/\b(help|commands|options|what can (you|i))\b/.test(msg)) {
    return {
      response: `You can tell me: "be aggressive", "be cautious", "auto mode", "set leverage 20x", "what are you doing?", "how are you doing?", "what's the market?", or nudge me with the button above.`,
    };
  }

  // ── Generic / unknown ────────────────────────────────────────────────────────
  const gap2 = Math.max(0, a.threshold - a.score);
  return {
    response: `Understood. I'm in ${a.mode} mode, watching a ${a.regime.toLowerCase()} market. Score ${a.score}/${a.threshold}${gap2 > 0 ? ` (${gap2}pts from entry)` : " — at threshold"}. ${a.openPositions > 0 ? `${a.openPositions} position(s) open.` : "No positions open."} Let me know if you want to adjust my settings.`,
  };
}
