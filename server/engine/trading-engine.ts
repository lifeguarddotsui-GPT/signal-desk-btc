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

export type { EngineState };

const regimeFilter = new RegimeFilter();
const breakoutStrategy = new BreakoutStrategy();
const riskManager = new RiskManager();
const positionManager = new PositionManager();
const executionService = new ExecutionService();
export const journal = new TradeJournal();

const STATE_KEY = "breakout_engine";

let inMemoryState: EngineState | null = null;
let lastScanDecision: { regime: any; decision: any; atTs: number } | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;

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

export async function tick(
  candles: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>,
  nowTs = Date.now(),
): Promise<void> {
  const state = await loadState();

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
  const lastPrice = priceTick.price;

  if (candles.length < Math.max(tradingConfig.atrLookbackBars + 2, tradingConfig.breakoutLookbackBars + 2, tradingConfig.volumeLookbackBars + 2)) {
    state.lastScanTs = nowTs;
    await saveState(state);
    return;
  }

  if (state.currentTradeId) {
    await manageOpenPosition(state, lastPrice, nowTs, candles);
    return;
  }

  const regime = regimeFilter.evaluate(candles, lastPrice);
  const decision = breakoutStrategy.decide(lastPrice, regime);
  lastScanDecision = { regime, decision, atTs: nowTs };

  state.lastScanTs = nowTs;

  if (!decision.shouldTrade) {
    await saveState(state);
    return;
  }

  const riskDecision = riskManager.canOpenNewTrade(state, nowTs);
  if (!riskDecision.allowed) {
    console.log(`[Engine] Risk gate blocked: ${riskDecision.reason}`);
    await saveState(state);
    return;
  }

  const agentRow = await getActiveAgent();
  if (!agentRow) {
    console.log("[Engine] No active auto-trade agent found — skipping tick");
    await saveState(state);
    return;
  }

  console.log(`[Engine] Breakout signal: ${decision.side.toUpperCase()} | atr_ratio=${regime.atrRatio.toFixed(2)} vol_ratio=${regime.volumeRatio.toFixed(2)} trend=${regime.trendBias} | entry=$${lastPrice.toFixed(4)} breakout=$${decision.breakoutLevel.toFixed(4)}`);

  const openResult = await executionService.openMarketPosition({
    agentRow,
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

  const priceExit = positionManager.shouldCloseForPrice(position, lastPrice);
  const timeExit = positionManager.shouldCloseForTime(position, nowTs);
  const exitReason = priceExit ?? timeExit;

  if (!exitReason) {
    state.lastScanTs = nowTs;
    await saveState(state);
    return;
  }

  const agentRow = await getActiveAgent();
  if (!agentRow) {
    state.lastError = "no_active_agent_for_close";
    state.lastScanTs = nowTs;
    await saveState(state);
    return;
  }

  console.log(`[Engine] Closing position ${position.id} — reason: ${exitReason} | price=$${lastPrice.toFixed(4)}`);

  const closeResult = await executionService.closeMarketPosition(agentRow, position.id);
  if (!closeResult.success || !closeResult.exitPrice) {
    state.lastError = closeResult.error ?? "close_failed";
    console.log(`[Engine] Close failed: ${state.lastError}`);
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
  state.lastScanTs = nowTs;

  await journal.recordClosed(closedTrade, agentRow.id, agentRow.userId);
  await saveState(state);

  console.log(`[Engine] CLOSED ${position.side.toUpperCase()} @ $${exitPrice.toFixed(4)} | PnL=${pnlSui.toFixed(4)} SUI (${pnlBps.toFixed(1)}bps) | ${win ? "WIN" : "LOSS"} | reason=${exitReason} | consec_losses=${state.consecutiveLosses}`);
}

export function startTradingEngine(
  getCandlesFn: () => Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>,
): void {
  if (tickInterval) return;
  console.log("[Engine] Breakout Trading Engine started — scanning every 5s");
  tickInterval = setInterval(async () => {
    try {
      const candles = getCandlesFn();
      await tick(candles);
    } catch (err: any) {
      console.error(`[Engine] Tick error: ${err?.message ?? err}`);
    }
  }, 5000);
}

export function stopTradingEngine(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}
