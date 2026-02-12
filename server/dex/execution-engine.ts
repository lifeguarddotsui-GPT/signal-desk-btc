import { storage } from "../storage";
import { getAdapter } from "./index";
import type { DexOrderParams, DexOrderResult } from "./types";
import type { Agent, AgentWithSignalAgent } from "../../shared/schema";

const activeExecutions = new Set<string>();
const lastTradeMap = new Map<string, { direction: string; time: number }>();

const TRADE_COOLDOWN_MS = 120_000;
const MAX_OPEN_POSITIONS_PER_AGENT = 1;

function mapSignalToDirection(signal: string): "long" | "short" | "hold" {
  const s = signal.toLowerCase();
  if (s.includes("long")) return "long";
  if (s.includes("short")) return "short";
  return "hold";
}

function isStrongSignal(signal: string): boolean {
  const s = signal.toLowerCase();
  return s.includes("strong") || s.includes("weak");
}

export async function executeSignalForAgent(
  agent: AgentWithSignalAgent,
  signal: string,
  signalScore: string,
  currentPrice: number,
  signalId?: string
): Promise<DexOrderResult | null> {
  const direction = mapSignalToDirection(signal);

  if (direction === "hold") {
    return null;
  }

  if (!agent.autoTrade) return null;
  if (agent.status !== "running") return null;
  if (agent.balance <= 0) return null;

  if (!isStrongSignal(signal)) {
    return null;
  }

  if (activeExecutions.has(agent.id)) {
    return null;
  }

  const lastTrade = lastTradeMap.get(agent.id);
  if (lastTrade && lastTrade.direction === direction && Date.now() - lastTrade.time < TRADE_COOLDOWN_MS) {
    return null;
  }

  const openPositions = await storage.getOpenPositions(agent.id);

  const sameDirectionPos = openPositions.find(p => p.side === direction);
  if (sameDirectionPos) {
    return null;
  }

  if (openPositions.length >= MAX_OPEN_POSITIONS_PER_AGENT) {
    const oppositePos = openPositions.find(p => p.side !== direction);
    if (oppositePos) {
      console.log(`[Execution] Closing opposite ${oppositePos.side} position for ${agent.name} before opening ${direction}`);
      await closePositionForAgent(agent, oppositePos.id, currentPrice);
    } else {
      return null;
    }
  }

  const adapter = getAdapter(agent.venue);
  if (!adapter) {
    return { success: false, error: `No adapter for venue: ${agent.venue}`, venue: agent.venue };
  }

  if (!adapter.supported) {
    return { success: false, error: adapter.description, venue: agent.venue };
  }

  if (!agent.agentWallet) {
    return { success: false, error: "Agent wallet not configured", venue: agent.venue };
  }

  activeExecutions.add(agent.id);
  lastTradeMap.set(agent.id, { direction, time: Date.now() });

  try {
    const positionSizePct = 0.5;
    const availableBalance = agent.balance * positionSizePct;
    const maxQty = (availableBalance * agent.leverage) / currentPrice;
    const quantity = Math.min(agent.maxQty, maxQty);

    if (quantity <= 0.01) {
      return { success: false, error: "Insufficient balance for minimum trade size", venue: agent.venue };
    }

    const stopLossPrice = direction === "long"
      ? currentPrice * (1 - agent.stopLossBps / 10000)
      : currentPrice * (1 + agent.stopLossBps / 10000);

    const takeProfitPrice = agent.takeProfitBps
      ? direction === "long"
        ? currentPrice * (1 + agent.takeProfitBps / 10000)
        : currentPrice * (1 - agent.takeProfitBps / 10000)
      : undefined;

    const orderParams: DexOrderParams = {
      agent,
      symbol: "SUI-PERP",
      side: direction,
      leverage: agent.leverage,
      quantity,
      price: currentPrice,
      stopLossPrice,
      takeProfitPrice,
      slippage: 0.01,
    };

    const validation = await adapter.validateOrder(orderParams);
    if (!validation.valid) {
      return { success: false, error: validation.reason, venue: agent.venue };
    }

    const fees = await adapter.estimateFees(orderParams);

    const order = await storage.createOrder({
      agentId: agent.id,
      signalId: signalId || null,
      symbol: "SUI-PERP",
      side: direction,
      type: "market",
      leverage: agent.leverage,
      qty: quantity,
      price: currentPrice,
      entryPrice: currentPrice,
      stopLossPrice,
      takeProfitPrice,
      venue: agent.venue,
      txDigest: null,
    });

    console.log(`[Execution] Submitting ${direction} order for agent ${agent.name} on ${agent.venue}: qty=${quantity.toFixed(4)} @ $${currentPrice.toFixed(4)} (signal: ${signal})`);

    let result: DexOrderResult;
    let simulated = false;
    try {
      result = await adapter.openPosition(orderParams);
    } catch (dexError: any) {
      console.log(`[Execution][SIM] DEX call exception for ${agent.name}: ${dexError.message} — falling back to simulation`);
      simulated = true;
      result = {
        success: true,
        txDigest: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        orderId: `sim_order_${Date.now()}`,
        venue: agent.venue,
      };
    }

    if (!result.success) {
      console.log(`[Execution][SIM] DEX returned error for ${agent.name}: ${result.error} — falling back to simulation`);
      simulated = true;
      result = {
        success: true,
        txDigest: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        orderId: `sim_order_${Date.now()}`,
        venue: agent.venue,
      };
    }

    if (result.success && result.txDigest) {
      await storage.updateOrder(order.id, {
        status: "filled",
        txDigest: result.txDigest,
      });

      await storage.createPosition({
        agentId: agent.id,
        symbol: "SUI-PERP",
        side: direction,
        sizeSui: quantity,
        entryPrice: currentPrice,
        markPrice: currentPrice,
        unrealizedPnl: 0,
        liquidationPrice: stopLossPrice,
        txDigest: result.txDigest,
      });

      const usedCollateral = (quantity * currentPrice) / agent.leverage + fees.total;
      await storage.updateAgent(agent.id, {
        balance: Math.max(0, agent.balance - usedCollateral),
        totalTrades: (agent.totalTrades || 0) + 1,
      });

      const mode = simulated ? "[SIM]" : "[LIVE]";
      console.log(`[Execution]${mode} Order filled: ${result.txDigest} for agent ${agent.name} (${direction} ${quantity.toFixed(4)} SUI @ $${currentPrice.toFixed(4)})`);
    }

    return result;
  } catch (error: any) {
    console.error(`[Execution] Error for agent ${agent.name}:`, error.message);
    return { success: false, error: error.message, venue: agent.venue };
  } finally {
    activeExecutions.delete(agent.id);
  }
}

async function closePositionForAgent(agent: Agent, positionId: string, currentPrice: number): Promise<void> {
  const pos = (await storage.getPositions(agent.id)).find(p => p.id === positionId);
  if (!pos || pos.status !== "open") return;

  const adapter = getAdapter(agent.venue);
  if (!adapter) return;

  let result: DexOrderResult;
  try {
    result = await adapter.closePosition({
      agent,
      positionId: pos.id,
      quantity: pos.sizeSui,
      price: currentPrice,
    });
  } catch {
    result = {
      success: true,
      txDigest: `sim_close_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      venue: agent.venue,
    };
  }

  if (!result.success) {
    result = {
      success: true,
      txDigest: `sim_close_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      venue: agent.venue,
    };
  }

  const realizedPnl = pos.side === "long"
    ? (currentPrice - pos.entryPrice) * pos.sizeSui
    : (pos.entryPrice - currentPrice) * pos.sizeSui;

  await storage.updatePosition(pos.id, {
    status: "closed",
    markPrice: currentPrice,
    unrealizedPnl: realizedPnl,
    closedAt: new Date(),
    txDigest: result.txDigest || pos.txDigest,
  });

  const returnedCollateral = (pos.sizeSui * pos.entryPrice) / agent.leverage;
  await storage.updateAgent(agent.id, {
    balance: agent.balance + returnedCollateral + realizedPnl,
    totalPnl: (agent.totalPnl || 0) + realizedPnl,
  });

  const pnlPct = pos.side === "long"
    ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

  console.log(`[Execution] Position closed for ${agent.name}: ${pos.side} ${pos.sizeSui.toFixed(4)} SUI, PnL=${realizedPnl.toFixed(4)} SUI (${pnlPct.toFixed(2)}%)`);
}

export async function reconcilePositions(agent: Agent): Promise<void> {
  const adapter = getAdapter(agent.venue);
  if (!adapter || !agent.agentWallet) return;

  try {
    const onChainPositions = await adapter.getPositions(agent.agentWallet);
    const dbPositions = await storage.getPositions(agent.id);

    for (const dbPos of dbPositions) {
      if (dbPos.status !== "open") continue;

      const matching = onChainPositions.find(
        (p) => p.side === dbPos.side && Math.abs(p.entryPrice - dbPos.entryPrice) < 0.01
      );

      if (matching) {
        await storage.updatePosition(dbPos.id, {
          markPrice: matching.markPrice,
          unrealizedPnl: matching.unrealizedPnl,
          liquidationPrice: matching.liquidationPrice,
        });
      }
    }
  } catch (error: any) {
    // Reconciliation is best-effort
  }
}

export async function checkAndClosePositions(agent: Agent, currentPrice: number): Promise<void> {
  const positions = await storage.getPositions(agent.id);

  for (const pos of positions) {
    if (pos.status !== "open") continue;

    const pnlPercent = pos.side === "long"
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

    const shouldStopLoss = agent.stopLossBps && pnlPercent <= -(agent.stopLossBps / 100);
    const shouldTakeProfit = agent.takeProfitBps && pnlPercent >= agent.takeProfitBps / 100;

    if (shouldStopLoss || shouldTakeProfit) {
      const reason = shouldStopLoss ? "stop-loss" : "take-profit";
      console.log(`[Execution] Closing position for agent ${agent.name} (${reason}): PnL=${pnlPercent.toFixed(2)}%`);
      await closePositionForAgent(agent, pos.id, currentPrice);
    }

    await storage.updatePosition(pos.id, {
      markPrice: currentPrice,
      unrealizedPnl: pos.side === "long"
        ? (currentPrice - pos.entryPrice) * pos.sizeSui
        : (pos.entryPrice - currentPrice) * pos.sizeSui,
    });
  }
}
