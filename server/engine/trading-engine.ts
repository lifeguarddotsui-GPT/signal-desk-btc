import { tradingConfig } from "./trading-config";
import { RegimeFilter } from "./regime-filter";
import { BreakoutStrategy } from "./breakout-strategy";
import { RiskManager } from "./risk-manager";
import { PositionManager } from "./position-manager";
import { ExecutionService } from "./execution-service";
import { TradeJournal } from "./trade-journal";
import type { EngineState, TradeRecord } from "./types";
import { db } from "../db";
import { engineState as engineStateTable, agents, breakoutTrades } from "../../shared/schema";
import { eq, and } from "drizzle-orm";
import { getLastPrice } from "../price-service";
import { getThrottledSuiClient } from "../rpc-throttle";

const GAS_RESERVE_SUI = 0.1;

async function fetchOnChainBalance(walletAddress: string): Promise<number> {
  try {
    const suiClient = getThrottledSuiClient();
    const bal = await suiClient.getBalance({ owner: walletAddress, coinType: "0x2::sui::SUI" });
    return Number(BigInt(bal.totalBalance)) / 1_000_000_000;
  } catch {
    return 0;
  }
}

export type { EngineState };

const regimeFilter = new RegimeFilter();
const breakoutStrategy = new BreakoutStrategy();
const riskManager = new RiskManager();
const positionManager = new PositionManager();
const executionService = new ExecutionService();
export { executionService };
export const journal = new TradeJournal();

const STATE_KEY = "breakout_engine";

let inMemoryState: EngineState | null = null;
let lastScanDecision: { regime: any; decision: any; atTs: number } | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;

async function loadState(): Promise<EngineState> {
  if (inMemoryState) return inMemoryState;
  const rows = await db.select().from(engineStateTable).where(eq(engineStateTable.key, STATE_KEY));
  if (rows.length && rows[0].stateJson) {
    inMemoryState = rows[0].stateJson as EngineState;
    return inMemoryState;
  }
  const initial: EngineState = {
    isEnabled: tradingConfig.enabled,
    lastScanTs: null,
    cooldownUntilTs: null,
    currentTradeId: null,
    consecutiveLosses: 0,
    dailyRealizedPnlSui: 0,
    dailyResetTs: null,
  };
  inMemoryState = initial;
  return initial;
}

async function saveState(state: EngineState): Promise<void> {
  inMemoryState = state;
  await db.insert(engineStateTable)
    .values({ key: STATE_KEY, stateJson: state })
    .onConflictDoUpdate({ target: engineStateTable.key, set: { stateJson: state } });
}

async function getActiveAgent(): Promise<any | null> {
  const rows = await db.select().from(agents)
    .where(and(eq(agents.autoTrade, true), eq(agents.status, "active")))
    .limit(1);
  return rows[0] ?? null;
}

function isMidnightPast(resetTs: number | null): boolean {
  if (!resetTs) return true;
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return resetTs < midnight.getTime();
}

export function getLastScanDecision() {
  return lastScanDecision;
}

export async function getEngineState(): Promise<EngineState> {
  return loadState();
}

export async function setEngineEnabled(enabled: boolean): Promise<void> {
  const state = await loadState();
  state.isEnabled = enabled;
  tradingConfig.enabled = enabled;
  await saveState(state);
}

/** Clear the currentTradeId from engine state (used after force-close to unblock engine) */
export async function clearCurrentTrade(): Promise<void> {
  const state = await loadState();
  state.currentTradeId = null;
  state.pendingCloseReason = undefined;
  state.lastError = undefined;
  await saveState(state);
  console.log("[Engine] currentTradeId cleared by force-close");
}

/** Reset daily counters (consecutive losses + daily PnL) — used when user wants to unblock after risk gates */
export async function resetDailyCounters(): Promise<void> {
  const state = await loadState();
  state.consecutiveLosses = 0;
  state.dailyRealizedPnlSui = 0;
  state.dailyResetTs = Date.now();
  state.blockReason = undefined;
  state.lastError = undefined;
  await saveState(state);
  console.log("[Engine] Daily counters reset by user");
}

export async function tick(
  candles: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>,
  nowTs = Date.now(),
): Promise<void> {
  const state = await loadState();

  // ── Always manage any open position FIRST, even if engine is stopped ─────
  // Stopping the engine must never leave a position stranded with no exit path.
  if (state.currentTradeId) {
    const priceTick = getLastPrice();
    const lastPrice = priceTick?.blended ?? priceTick?.pyth?.price;
    if (lastPrice) {
      await manageOpenPosition(state, lastPrice, nowTs, candles);
    }
    return;
  }

  if (!state.isEnabled || !tradingConfig.enabled) return;

  if (isMidnightPast(state.dailyResetTs)) {
    state.dailyRealizedPnlSui = 0;
    state.dailyResetTs = nowTs;
    console.log("[Engine] Daily PnL counter reset for new day");
  }

  const priceTick = getLastPrice();
  if (!priceTick) {
    state.lastScanTs = nowTs;
    await saveState(state);
    return;
  }
  const lastPrice = priceTick.blended ?? priceTick.pyth?.price;
  if (!lastPrice) {
    state.lastScanTs = nowTs;
    await saveState(state);
    return;
  }

  if (candles.length < Math.max(tradingConfig.atrLookbackBars + 2, tradingConfig.breakoutLookbackBars + 2, tradingConfig.volumeLookbackBars + 2)) {
    state.lastScanTs = nowTs;
    await saveState(state);
    return;
  }

  const regime = regimeFilter.evaluate(candles, lastPrice);
  const decision = breakoutStrategy.decide(lastPrice, regime);
  lastScanDecision = { regime, decision, atTs: nowTs };

  state.lastScanTs = nowTs;

  if (!decision.shouldTrade) {
    if ("reason" in decision) {
      console.log(`[Engine] BLOCKED — ${decision.reason} | price=$${lastPrice.toFixed(4)} hi=$${regime.recentHigh.toFixed(4)} lo=$${regime.recentLow.toFixed(4)}`);
    }
    await saveState(state);
    return;
  }

  const agentRow = await getActiveAgent();
  if (!agentRow) {
    console.log("[Engine] No active auto-trade agent found — skipping tick");
    state.blockReason = "no_active_agent";
    await saveState(state);
    return;
  }

  const agentSettings = {
    leverage: agentRow.leverage ?? tradingConfig.leverage,
    minCollateral: agentRow.minCollateral ?? tradingConfig.minCollateralSui,
    maxCollateral: agentRow.maxCollateral ?? tradingConfig.maxCollateralSui,
    takeProfitBps: agentRow.takeProfitBps ?? tradingConfig.takeProfitBps,
    stopLossBps: agentRow.stopLossBps ?? tradingConfig.stopLossBps,
  };

  const riskDecision = riskManager.canOpenNewTrade(state, nowTs, agentSettings);
  if (!riskDecision.allowed) {
    const reason = riskDecision.reason;
    console.log(`[Engine] Risk gate blocked: ${reason}`);
    state.blockReason = reason;
    state.lastScanTs = nowTs;
    await saveState(state);
    return;
  }

  state.blockReason = undefined;

  const onChainBalance = agentRow.walletAddress
    ? await fetchOnChainBalance(agentRow.walletAddress)
    : 0;

  const minNeeded = riskDecision.collateralSui + GAS_RESERVE_SUI;
  if (onChainBalance < minNeeded) {
    const msg = `insufficient_balance(${onChainBalance.toFixed(4)}<${minNeeded.toFixed(2)})`;
    console.log(`[Engine] Insufficient on-chain balance: ${onChainBalance.toFixed(4)} SUI (need ≥ ${minNeeded.toFixed(2)} SUI for collateral + gas)`);
    state.blockReason = msg;
    state.lastScanTs = nowTs;
    await saveState(state);
    return;
  }

  const patchedAgent = { ...agentRow, balance: onChainBalance };

  if (state.lastError?.includes("balance") || state.lastError?.includes("no_price")) {
    state.lastError = undefined;
  }

  console.log(`[Engine] Breakout signal: ${decision.side.toUpperCase()} | atr_ratio=${regime.atrRatio.toFixed(2)} vol_ratio=${regime.volumeRatio.toFixed(2)} trend=${regime.trendBias} | entry=$${lastPrice.toFixed(4)} breakout=$${decision.breakoutLevel.toFixed(4)} collateral=${riskDecision.collateralSui.toFixed(2)} SUI @ ${riskDecision.leverage}x`);

  const openResult = await executionService.openMarketPosition({
    agentRow: patchedAgent,
    side: decision.side,
    collateralSui: riskDecision.collateralSui,
    leverage: riskDecision.leverage,
  });

  if (!openResult.success || !openResult.entryPrice || !openResult.positionId) {
    state.lastError = openResult.error ?? "open_failed";
    console.log(`[Engine] Open failed: ${state.lastError}`);
    await saveState(state);
    return;
  }

  const exits = riskManager.computeExitPrices(
    openResult.entryPrice,
    decision.side,
    riskDecision.takeProfitBps,
    riskDecision.stopLossBps,
  );

  const trade: TradeRecord = {
    id: openResult.positionId,
    symbol: "SUI-PERP",
    side: decision.side,
    status: "open",
    entryReason: decision.entryReason,
    entryTs: nowTs,
    entryPrice: openResult.entryPrice,
    leverage: riskDecision.leverage,
    collateralSui: riskDecision.collateralSui,
    takeProfitPrice: exits.takeProfitPrice,
    stopLossPrice: exits.stopLossPrice,
    atrRatioAtEntry: regime.atrRatio,
    volumeRatioAtEntry: regime.volumeRatio,
    trendBiasAtEntry: regime.trendBias,
    breakoutLevel: decision.breakoutLevel,
  };

  state.currentTradeId = trade.id;
  state.lastError = undefined;
  await journal.recordOpened(trade, agentRow.id);
  await saveState(state);

  console.log(`[Engine] OPENED ${trade.side.toUpperCase()} @ $${trade.entryPrice.toFixed(4)} | TP=$${exits.takeProfitPrice.toFixed(4)} SL=$${exits.stopLossPrice.toFixed(4)} | collateral=${trade.collateralSui} SUI @ ${trade.leverage}x`);
}

async function manageOpenPosition(
  state: EngineState,
  lastPrice: number,
  nowTs: number,
  candles: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>,
): Promise<void> {
  if (!state.currentTradeId) return;

  const rows = await db.select().from(breakoutTrades)
    .where(eq(breakoutTrades.id, state.currentTradeId));

  if (!rows.length) {
    console.log(`[Engine] Current trade ${state.currentTradeId} not found in DB — clearing state`);
    state.currentTradeId = null;
    state.pendingCloseReason = undefined;
    state.lastScanTs = nowTs;
    await saveState(state);
    return;
  }

  const row = rows[0];
  const position: TradeRecord = {
    id: row.id,
    symbol: row.symbol,
    side: row.side as "long" | "short",
    status: row.status as "open",
    entryReason: row.entryReason as "breakout_long" | "breakout_short",
    entryTs: row.entryTs,
    entryPrice: row.entryPrice,
    leverage: row.leverage,
    collateralSui: row.collateralSui,
    takeProfitPrice: row.takeProfitPrice,
    stopLossPrice: row.stopLossPrice,
    atrRatioAtEntry: row.atrRatioAtEntry,
    volumeRatioAtEntry: row.volumeRatioAtEntry,
    trendBiasAtEntry: row.trendBiasAtEntry as "bullish" | "bearish" | "neutral",
    breakoutLevel: row.breakoutLevel,
  };

  // ── Determine exit reason ──────────────────────────────────────────────────
  // If pendingCloseReason is already set (from a previous failed close attempt),
  // keep using it — do NOT re-evaluate conditions. This ensures we keep retrying
  // even if price has reverted past the original SL/TP trigger level.
  const priceExit = positionManager.shouldCloseForPrice(position, lastPrice);
  const timeExit = positionManager.shouldCloseForTime(position, nowTs);
  const freshReason = priceExit ?? timeExit;

  const exitReason = (state.pendingCloseReason as any) ?? freshReason;

  if (!exitReason) {
    state.lastScanTs = nowTs;
    await saveState(state);
    return;
  }

  // Persist close intent before attempting — survives failed close attempts
  if (!state.pendingCloseReason) {
    state.pendingCloseReason = exitReason;
    await saveState(state);
  }

  // ── Critical: look up agent by the trade's agentId, NOT by active status ──
  // The agent may be deactivated/paused, but we must still close the position.
  const tradeAgentId = row.agentId;
  if (!tradeAgentId) {
    state.lastError = "no_agent_id_on_trade";
    state.lastScanTs = nowTs;
    await saveState(state);
    return;
  }
  const agentRows = await db.select().from(agents).where(eq(agents.id, tradeAgentId));
  const agentRow = agentRows[0] ?? null;
  if (!agentRow) {
    state.lastError = "agent_not_found_for_close";
    state.lastScanTs = nowTs;
    await saveState(state);
    return;
  }

  console.log(`[Engine] Closing position ${position.id} — reason: ${exitReason} | price=$${lastPrice.toFixed(4)}`);

  const closeResult = await executionService.closeMarketPosition(agentRow, position.id, {
    side: position.side,
    collateralSui: position.collateralSui,
  });
  if (!closeResult.success || !closeResult.exitPrice) {
    state.lastError = closeResult.error ?? "close_failed";
    console.log(`[Engine] Close failed (will retry): ${state.lastError}`);
    state.lastScanTs = nowTs;
    await saveState(state);
    return;
  }

  const exitPrice = closeResult.exitPrice;
  const pnlRaw = position.side === "long"
    ? exitPrice - position.entryPrice
    : position.entryPrice - exitPrice;
  const pnlBps = (pnlRaw / position.entryPrice) * 10000;
  const pnlSui = position.collateralSui * position.leverage * (pnlBps / 10000);
  const win = pnlSui > 0;

  const closedTrade: TradeRecord = {
    ...position,
    status: "closed",
    exitReason,
    exitTs: nowTs,
    exitPrice,
    pnlBps,
    pnlSui,
    win,
  };

  state.dailyRealizedPnlSui += pnlSui;
  state.consecutiveLosses = win ? 0 : state.consecutiveLosses + 1;
  state.cooldownUntilTs = nowTs + tradingConfig.cooldownSeconds * 1000;
  state.currentTradeId = null;
  state.pendingCloseReason = undefined;
  state.lastError = undefined;
  state.lastScanTs = nowTs;

  await journal.recordClosed(closedTrade, agentRow.id, agentRow.userId, agentRow.rewardSharePct);
  await saveState(state);

  console.log(`[Engine] CLOSED ${position.side.toUpperCase()} @ $${exitPrice.toFixed(4)} | PnL=${pnlSui.toFixed(4)} SUI (${pnlBps.toFixed(1)}bps) | ${win ? "WIN" : "LOSS"} | reason=${exitReason} | consec_losses=${state.consecutiveLosses}`);
}

// ── Manual close (called from API, bypasses tick) ────────────────────────────
export async function manualClosePosition(agentId: string): Promise<{
  success: boolean; error?: string; exitPrice?: number; pnlSui?: number;
}> {
  const state = await loadState();

  // Find the open trade — first from engine state, then fallback to DB lookup by agentId
  let rows;
  if (state.currentTradeId) {
    rows = await db.select().from(breakoutTrades).where(eq(breakoutTrades.id, state.currentTradeId));
    if (!rows.length || rows[0].status !== "open") {
      state.currentTradeId = null;
      state.pendingCloseReason = undefined;
      await saveState(state);
      rows = [];
    }
  }
  if (!rows || !rows.length) {
    // Fallback: find any open trade belonging to this agent in DB
    rows = await db.select().from(breakoutTrades)
      .where(and(eq(breakoutTrades.agentId, agentId), eq(breakoutTrades.status, "open")))
      .limit(1);
  }
  if (!rows.length) return { success: false, error: "no_open_position" };

  const row = rows[0];
  if (row.agentId && row.agentId !== agentId) {
    return { success: false, error: "not_your_position" };
  }

  const agentRows = await db.select().from(agents).where(eq(agents.id, agentId));
  const agentRow = agentRows[0];
  if (!agentRow) return { success: false, error: "agent_not_found" };

  // ── Execute on-chain close FIRST ──────────────────────────────────────────
  // Pass side/collateral hints so the service can find the real on-chain position
  // even if the stored positionId doesn't match (orderId vs positionId confusion).
  const closeResult = await executionService.closeMarketPosition(agentRow, row.id, {
    side: row.side as "long" | "short",
    collateralSui: row.collateralSui,
  });
  if (!closeResult.success || !closeResult.exitPrice) {
    return { success: false, error: closeResult.error ?? "close_failed" };
  }

  const nowTs = Date.now();
  const exitPrice = closeResult.exitPrice;
  const pnlRaw = row.side === "long" ? exitPrice - row.entryPrice : row.entryPrice - exitPrice;
  const pnlBps = (pnlRaw / row.entryPrice) * 10000;
  const pnlSui = row.collateralSui * row.leverage * (pnlBps / 10000);
  const win = pnlSui > 0;

  const closedTrade: TradeRecord = {
    id: row.id,
    symbol: row.symbol,
    side: row.side as "long" | "short",
    status: "closed",
    entryReason: row.entryReason as "breakout_long" | "breakout_short",
    exitReason: "manual_close",
    entryTs: row.entryTs,
    exitTs: nowTs,
    entryPrice: row.entryPrice,
    exitPrice,
    leverage: row.leverage,
    collateralSui: row.collateralSui,
    takeProfitPrice: row.takeProfitPrice,
    stopLossPrice: row.stopLossPrice,
    atrRatioAtEntry: row.atrRatioAtEntry,
    volumeRatioAtEntry: row.volumeRatioAtEntry,
    trendBiasAtEntry: row.trendBiasAtEntry as "bullish" | "bearish" | "neutral",
    breakoutLevel: row.breakoutLevel,
    pnlBps,
    pnlSui,
    win,
  };

  state.dailyRealizedPnlSui += pnlSui;
  state.consecutiveLosses = win ? 0 : state.consecutiveLosses + 1;
  state.cooldownUntilTs = nowTs + tradingConfig.cooldownSeconds * 1000;
  state.currentTradeId = null;
  state.pendingCloseReason = undefined;
  state.lastError = undefined;
  state.lastScanTs = nowTs;

  await journal.recordClosed(closedTrade, agentId, agentRow?.userId ?? undefined, agentRow?.rewardSharePct);
  await saveState(state);

  console.log(`[Engine] MANUAL CLOSE ${row.side.toUpperCase()} @ $${exitPrice.toFixed(4)} | PnL=${pnlSui.toFixed(4)} SUI`);
  return { success: true, exitPrice, pnlSui };
}

/** Reconcile engine state vs DB on startup — re-sync lost currentTradeId or clear stale ones */
async function reconcileStateOnStartup(): Promise<void> {
  const state = await loadState();
  if (state.currentTradeId) {
    // Verify the trade is still open in DB
    const rows = await db.select().from(breakoutTrades)
      .where(eq(breakoutTrades.id, state.currentTradeId));
    if (!rows.length || rows[0].status !== "open") {
      console.log(`[Engine] Startup: clearing stale currentTradeId (${state.currentTradeId}) — not open in DB`);
      state.currentTradeId = null;
      state.pendingCloseReason = undefined;
      await saveState(state);
    } else {
      console.log(`[Engine] Startup: tracking open position ${state.currentTradeId}`);
    }
  } else {
    // Look for any open trade in DB — re-sync if found
    const openRows = await db.select().from(breakoutTrades)
      .where(eq(breakoutTrades.status, "open"))
      .limit(1);
    if (openRows.length) {
      console.log(`[Engine] Startup: re-syncing lost currentTradeId ${openRows[0].id} from DB`);
      state.currentTradeId = openRows[0].id;
      state.pendingCloseReason = state.pendingCloseReason ?? undefined;
      await saveState(state);
    }
  }
}

export function startTradingEngine(
  getCandlesFn: () => Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>,
): void {
  if (tickInterval) return;
  console.log("[Engine] Breakout Trading Engine started — scanning every 5s");
  reconcileStateOnStartup().catch(err =>
    console.error("[Engine] Startup reconciliation error:", err?.message ?? err)
  );
  tickInterval = setInterval(async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      const candles = getCandlesFn();
      await tick(candles);
    } catch (err: any) {
      console.error(`[Engine] Tick error: ${err?.message ?? err}`);
    } finally {
      tickRunning = false;
    }
  }, 5000);
}

export function stopTradingEngine(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}
