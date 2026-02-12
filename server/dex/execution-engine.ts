import { storage } from "../storage";
import { getAdapter } from "./index";
import type { DexOrderParams, DexOrderResult } from "./types";
import type { Agent, AgentWithSignalAgent } from "../../shared/schema";

const activeExecutions = new Set<string>();
const lastSignalMap = new Map<string, { signal: string; time: number }>();

const SIGNAL_COOLDOWN_MS = 60_000;

export async function executeSignalForAgent(
  agent: AgentWithSignalAgent,
  signal: "long" | "short" | "hold",
  signalScore: string,
  currentPrice: number,
  signalId?: string
): Promise<DexOrderResult | null> {
  if (signal === "hold") return null;
  if (!agent.autoTrade) return null;
  if (agent.status !== "running") return null;
  if (agent.balance <= 0) return null;

  if (activeExecutions.has(agent.id)) {
    return null;
  }

  const lastSig = lastSignalMap.get(agent.id);
  if (lastSig && lastSig.signal === signal && Date.now() - lastSig.time < SIGNAL_COOLDOWN_MS) {
    return null;
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
  lastSignalMap.set(agent.id, { signal, time: Date.now() });

  try {
    const maxPositionValue = agent.maxQty * currentPrice;
    const collateralNeeded = maxPositionValue / agent.leverage;
    const quantity = Math.min(agent.maxQty, (agent.balance * agent.leverage) / currentPrice);

    if (quantity <= 0) {
      return { success: false, error: "Insufficient balance for trade", venue: agent.venue };
    }

    const stopLossPrice = signal === "long"
      ? currentPrice * (1 - agent.stopLossBps / 10000)
      : currentPrice * (1 + agent.stopLossBps / 10000);

    const takeProfitPrice = agent.takeProfitBps
      ? signal === "long"
        ? currentPrice * (1 + agent.takeProfitBps / 10000)
        : currentPrice * (1 - agent.takeProfitBps / 10000)
      : undefined;

    const orderParams: DexOrderParams = {
      agent,
      symbol: "SUI-PERP",
      side: signal,
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
      side: signal,
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

    console.log(`[Execution] Submitting ${signal} order for agent ${agent.name} on ${agent.venue}: qty=${quantity.toFixed(4)} @ $${currentPrice.toFixed(4)}`);

    const result = await adapter.openPosition(orderParams);

    if (result.success && result.txDigest) {
      await storage.updateOrder(order.id, {
        status: "filled",
        txDigest: result.txDigest,
      });

      await storage.createPosition({
        agentId: agent.id,
        symbol: "SUI-PERP",
        side: signal,
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

      console.log(`[Execution] Order filled: ${result.txDigest} for agent ${agent.name}`);
    } else {
      await storage.updateOrder(order.id, {
        status: "failed",
        txDigest: result.txDigest || null,
      });

      console.error(`[Execution] Order failed for agent ${agent.name}: ${result.error}`);
    }

    return result;
  } catch (error: any) {
    console.error(`[Execution] Error for agent ${agent.name}:`, error.message);
    return { success: false, error: error.message, venue: agent.venue };
  } finally {
    activeExecutions.delete(agent.id);
  }
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
    console.error(`[Reconcile] Error for agent ${agent.name}:`, error.message);
  }
}

export async function checkAndClosePositions(agent: Agent, currentPrice: number): Promise<void> {
  const positions = await storage.getPositions(agent.id);
  const adapter = getAdapter(agent.venue);
  if (!adapter) return;

  for (const pos of positions) {
    if (pos.status !== "open") continue;

    const pnlPercent = pos.side === "long"
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

    const shouldClose =
      (agent.stopLossBps && pnlPercent <= -(agent.stopLossBps / 100)) ||
      (agent.takeProfitBps && pnlPercent >= agent.takeProfitBps / 100);

    if (shouldClose) {
      console.log(`[Execution] Closing position for agent ${agent.name}: PnL=${pnlPercent.toFixed(2)}%`);

      const result = await adapter.closePosition({
        agent,
        positionId: pos.id,
        quantity: pos.sizeSui,
        price: currentPrice,
      });

      if (result.success) {
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

        await storage.updateAgent(agent.id, {
          balance: agent.balance + (pos.sizeSui * pos.entryPrice / agent.leverage) + realizedPnl,
          totalPnl: (agent.totalPnl || 0) + realizedPnl,
        });

        console.log(`[Execution] Position closed: PnL=${realizedPnl.toFixed(4)} SUI`);
      }
    }
  }
}
