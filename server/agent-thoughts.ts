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
  if (gap <= 2 && score > 0) {
    return trim(`Score ${score} vs threshold ${threshold} — at the wire! ${regimeLabel.charAt(0).toUpperCase() + regimeLabel.slice(1)} market${btcStr}${sentStr}. ${sideLabel ? `Bias: ${sideLabel}.` : ""} Final confirmation scan.`);
  }
  if (gap <= 7 && score > 0) {
    return trim(`Nearly there — score ${score}/${threshold}. ${regimeLabel.charAt(0).toUpperCase() + regimeLabel.slice(1)} regime${btcStr}, ${sideLabel ? `${sideLabel} bias. ` : ""}${modeLabel.charAt(0).toUpperCase() + modeLabel.slice(1)} building conviction.${sentStr ? ` Crowd: ${sentStr.trim()}.` : ""}`);
  }

  // Regime-specific detailed thoughts
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

function trim(s: string): string {
  return s.slice(0, 275);
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat Command Interpreter — Natural Language Agent Configuration
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
  const slPct = (a.stopLossBps / 100).toFixed(2);
  const tpPct = a.takeProfitBps ? (a.takeProfitBps / 100).toFixed(2) : "auto";
  const idleStr = a.idleMinutes > 120 ? `${Math.round(a.idleMinutes / 60)}h` : a.idleMinutes > 0 ? `${Math.round(a.idleMinutes)}min` : "just traded";
  const winPct = (a.winRate * 100).toFixed(0);
  const gap = Math.max(0, a.threshold - a.score);

  // ── Mode changes ─────────────────────────────────────────────────────────────
  if (/\b(be more aggressive|go aggressive|aggressive mode|trade more|trade faster|more trades|increase frequency|trade aggressively)\b/.test(msg)) {
    return {
      response: `Switching to AGGRESSIVE mode. I'll use a lower entry threshold and take more setups with less filtering. Current market: ${a.regime.toLowerCase()}. Win rate ${winPct}%, ${a.totalTrades} trades so far — trade frequency will increase significantly.`,
      configChange: { field: "signalMode", value: "AGGRESSIVE", label: "Signal mode → AGGRESSIVE" },
    };
  }
  if (/\b(precision|be precise|be cautious|cautious|conservative|careful|slow down|fewer trades|high quality only|quality over quantity)\b/.test(msg)) {
    return {
      response: `Switching to PRECISION mode. I'll only take the highest-confidence setups and skip marginal signals. This is the most selective mode — fewer trades but higher quality. Current regime: ${a.regime.toLowerCase()}, tradability ${a.tradabilityScore}/100.`,
      configChange: { field: "signalMode", value: "PRECISION", label: "Signal mode → PRECISION" },
    };
  }
  if (/\b(auto mode|automatic|balanced|normal mode|auto|reset mode|default mode)\b/.test(msg)) {
    return {
      response: `Back to AUTO mode — the balanced default. I'll trade when conditions are good without being over-selective or reckless. Adapts well to all regimes. Score ${a.score}/${a.threshold}, ${a.regime.toLowerCase()} market right now.`,
      configChange: { field: "signalMode", value: "AUTO", label: "Signal mode → AUTO" },
    };
  }
  if (/\b(now mode|trade now|force trade|trade immediately|execute now|go now|enter now)\b/.test(msg)) {
    return {
      response: `NOW mode activated. I'll attempt to place a trade on the very next valid signal, bypassing most quality filters. Use sparingly — this overrides my safety checks. I'll return to AUTO after this session.`,
      configChange: { field: "signalMode", value: "NOW", label: "Signal mode → NOW" },
    };
  }

  // ── Leverage changes ─────────────────────────────────────────────────────────
  const leverageMatch = msg.match(/(?:set |use |change to |update )?leverage (?:to )?(\d+)x?/);
  if (leverageMatch) {
    const lev = parseInt(leverageMatch[1]);
    if (lev >= 2 && lev <= 50) {
      const riskNote = lev >= 30 ? "Very high leverage — I'll be especially strict on entry quality to protect collateral." : lev >= 15 ? "Moderate-high leverage — each trade has meaningful size." : "Conservative leverage — good for capital preservation.";
      return {
        response: `Setting leverage to ${lev}x. ${riskNote} Current win rate: ${winPct}%, SL: ${slPct}%, TP: ${tpPct}%.`,
        configChange: { field: "leverage", value: lev, label: `Leverage → ${lev}x` },
      };
    }
    return { response: `Leverage must be 2x–50x (Typus protocol limit). You tried ${leverageMatch[1]}x. Current: ${a.leverage}x.` };
  }

  // ── Stop-loss changes ─────────────────────────────────────────────────────────
  const slMatch = msg.match(/(?:set |use |change )?stop.?loss (?:to )?(\d+(?:\.\d+)?)\s*(?:bps|%|percent)?/);
  if (slMatch) {
    let val = parseFloat(slMatch[1]);
    // If >= 5, likely bps; if < 5, likely % — convert to bps
    if (val < 5) val = Math.round(val * 100);
    if (val >= 10 && val <= 500) {
      return {
        response: `Setting stop-loss to ${val}bps (${(val / 100).toFixed(2)}%). Smaller SL = tighter risk but more frequent stop-outs. Current: ${a.stopLossBps}bps.`,
        configChange: { field: "stopLossBps", value: val, label: `Stop-loss → ${val}bps` },
      };
    }
    return { response: `Stop-loss must be 10–500bps. You tried ${val}bps. Current: ${a.stopLossBps}bps.` };
  }

  // ── Take-profit changes ─────────────────────────────────────────────────────────
  const tpMatch = msg.match(/(?:set |use |change )?take.?profit (?:to )?(\d+(?:\.\d+)?)\s*(?:bps|%|percent)?/);
  if (tpMatch) {
    let val = parseFloat(tpMatch[1]);
    if (val < 5) val = Math.round(val * 100);
    if (val >= 10 && val <= 1000) {
      return {
        response: `Setting take-profit to ${val}bps (${(val / 100).toFixed(2)}%). Higher TP = bigger wins when they hit, but hits less often. Current: ${a.takeProfitBps ?? "auto"}bps.`,
        configChange: { field: "takeProfitBps", value: val, label: `Take-profit → ${val}bps` },
      };
    }
    return { response: `Take-profit must be 10–1000bps. You tried ${val}bps. Current: ${a.takeProfitBps ?? "auto"}bps.` };
  }

  // ── Status / info queries ────────────────────────────────────────────────────
  if (/\b(how are you doing|how am i doing|performance|stats|give me (a )?summary|full status|my stats|your stats)\b/.test(msg)) {
    const posStr = a.openPositions > 0 ? `${a.openPositions} open position(s)` : "no open positions";
    const consLoss = a.consecutiveLosses > 0 ? ` ${a.consecutiveLosses} consecutive losses.` : "";
    return {
      response: `Status: ${a.status}. Balance: ${a.balance.toFixed(2)} SUI. ${posStr}. Win rate: ${winPct}% across ${a.totalTrades} trades.${consLoss} Mode: ${a.mode}. Idle: ${idleStr}. Signal: ${a.score}/${a.threshold} (${a.regime.toLowerCase()}).`,
    };
  }

  if (/\b(what are you (doing|thinking|planning|working on)|your (plan|strategy|current thought)|what('s| is) your plan)\b/.test(msg)) {
    return {
      response: `${a.regime} market, tradability ${a.tradabilityScore}/100. Score ${a.score}/${a.threshold} — ${gap === 0 ? "at threshold, searching for entry" : `${gap}pts from entry`}. ${a.openPositions > 0 ? `Managing ${a.openPositions} open position(s).` : "No positions — scanning for setup."} ${idleStr} idle. Mode: ${a.mode}.`,
    };
  }

  if (/\b(what('s| is) the (market|regime|condition|situation)|market (status|update|regime))\b/.test(msg)) {
    return {
      response: `Regime: ${a.regime}. Tradability: ${a.tradabilityScore}/100. Signal score: ${a.score}/${a.threshold}. ${gap > 0 ? `${gap}pts from entry threshold.` : "At threshold."} ${a.consecutiveLosses > 0 ? `Note: ${a.consecutiveLosses} consecutive losses.` : ""}`,
    };
  }

  if (/\b(what's? my (win rate|performance|results)|show (me )?my (stats|performance|results))\b/.test(msg)) {
    return {
      response: `Win rate: ${winPct}% across ${a.totalTrades} trades. Balance: ${a.balance.toFixed(2)} SUI. ${a.consecutiveLosses > 0 ? `Current: ${a.consecutiveLosses} consecutive losses.` : "No current loss streak."} Stop-loss: ${slPct}%, take-profit: ${tpPct}%, leverage: ${a.leverage}x.`,
    };
  }

  if (/\b(why (aren't|are you not|haven't|didn't|haven't you) (you )?(traded|trading|entered|entering)|why no trades|why idle|why not trading)\b/.test(msg)) {
    const blockNote = a.score < a.threshold ? `Score ${a.score} is ${gap}pts below threshold ${a.threshold}.` : "Signal score meets threshold.";
    return {
      response: `${blockNote} Market: ${a.regime.toLowerCase()}, tradability ${a.tradabilityScore}/100. ${a.idleMinutes > 30 ? `I've been idle ${idleStr} — threshold is progressively relaxing.` : ""} ${a.consecutiveLosses >= 3 ? `Also: ${a.consecutiveLosses} consecutive losses — slightly more selective right now.` : ""}`,
    };
  }

  if (/\b(stop|pause|halt|stop trading)\b/.test(msg)) {
    return {
      response: `I can't self-pause from chat — use the Pause button in the agent controls. In the meantime, I'll stay disciplined and only take above-threshold setups. Current score: ${a.score}/${a.threshold}.`,
    };
  }

  if (/\b(resume|start|unpause|activate|go|let'?s? go|start trading)\b/.test(msg)) {
    return {
      response: `I'm already scanning for trades in ${a.mode} mode. Score ${a.score}/${a.threshold}, ${a.regime.toLowerCase()} market. ${gap > 0 ? `${gap}pts from entry.` : "At threshold."} If I'm paused, use the Resume button in the controls.`,
    };
  }

  if (/\b(hello|hi|hey|greetings|what'?s? up|good morning|good evening)\b/.test(msg)) {
    return {
      response: `Hey — I'm ${a.name}. Currently in ${a.mode} mode, watching a ${a.regime.toLowerCase()} market. Score ${a.score}/${a.threshold}, ${a.openPositions} open position(s). Win rate ${winPct}% across ${a.totalTrades} trades. What do you need?`,
    };
  }

  if (/\b(help|commands|options|what can (you|i)|how (do|can) i|what should i|guide)\b/.test(msg)) {
    return {
      response: `You can ask me: "be aggressive", "be cautious", "auto mode", "now mode", "set leverage 25x", "set stop-loss 40bps", "set take-profit 80bps", "what's the market?", "how are you doing?", "why aren't you trading?", "what are you thinking?" — or nudge me with the button above.`,
    };
  }

  if (/\b(how do (i|you) make (money|profit)|is (this|it) profitable|are you profitable|making money)\b/.test(msg)) {
    return {
      response: `Win rate ${winPct}% across ${a.totalTrades} trades. ${a.balance.toFixed(2)} SUI in funding wallet. I use ${a.leverage}x leverage with ${slPct}% stop-loss and ${tpPct}% take-profit. Profitability depends on win rate × avg win/loss ratio, which the learning engine is optimising over time.`,
    };
  }

  if (/\b(what('s| is) (your |the )?leverage|current leverage|leverage setting)\b/.test(msg)) {
    return { response: `Current leverage: ${a.leverage}x. Stop-loss: ${slPct}%, take-profit: ${tpPct}%. To change it, say "set leverage 20x".` };
  }

  if (/\b(what('s| is) (my|your|the) (balance|wallet|funds)|how much (money|sui|capital))\b/.test(msg)) {
    return { response: `Funding wallet balance: ${a.balance.toFixed(4)} SUI. ${a.openPositions > 0 ? `${a.openPositions} open position(s) currently deployed.` : "No open positions."}` };
  }

  // ── Generic / unknown ────────────────────────────────────────────────────────
  return {
    response: `I'm ${a.name} in ${a.mode} mode, watching a ${a.regime.toLowerCase()} market. Score ${a.score}/${a.threshold}${gap > 0 ? ` (${gap}pts from entry)` : " — at threshold"}. ${a.openPositions > 0 ? `${a.openPositions} position(s) open.` : "No positions."} Ask me to change mode, leverage, stop-loss, or take-profit — or ask "help" for all commands.`,
  };
}
