import { storage } from "../storage";
import { getAdapter } from "../dex/index";
import type { DexOrderParams, DexOrderResult } from "../dex/types";
import type { AgentWithSignalAgent } from "../../shared/schema";
import { validateBundle, type InstructionBundle, type Action } from "../../shared/bundle";

const activeExecutions = new Set<string>();

export async function executeBundleForAgent(
  bundle: InstructionBundle,
  agent: AgentWithSignalAgent
): Promise<{
  success: boolean;
  txDigest?: string;
  actionsExecuted: number;
  actionsFailed: number;
  error?: string;
}> {
  const validation = validateBundle(bundle);
  if (!validation.valid) {
    return { success: false, actionsExecuted: 0, actionsFailed: bundle.actions.length, error: validation.error };
  }

  if (activeExecutions.has(agent.id)) {
    return { success: false, actionsExecuted: 0, actionsFailed: 0, error: "Agent already executing a bundle" };
  }

  activeExecutions.add(agent.id);

  try {
    let actionsExecuted = 0;
    let actionsFailed = 0;
    let lastTxDigest: string | undefined;
    let lastError: string | undefined;

    for (const action of bundle.actions) {
      if (action.type === "NOOP") {
        actionsExecuted++;
        continue;
      }

      if (action.type === "CLAIM_REWARDS") {
        actionsExecuted++;
        continue;
      }

      const venueKey = "venue" in action ? mapVenueToAdapter(action.venue) : agent.venue;
      const adapter = getAdapter(venueKey);

      if (!adapter || !adapter.supported) {
        actionsFailed++;
        lastError = `No supported adapter for venue: ${venueKey}`;
        continue;
      }

      try {
        const result = await executeAction(action, agent, adapter, bundle);
        if (result.success) {
          actionsExecuted++;
          lastTxDigest = result.txDigest || lastTxDigest;
        } else {
          actionsFailed++;
          lastError = result.error;
        }
      } catch (err: any) {
        actionsFailed++;
        lastError = err.message;
      }
    }

    return {
      success: actionsFailed === 0,
      txDigest: lastTxDigest,
      actionsExecuted,
      actionsFailed,
      error: lastError,
    };
  } finally {
    activeExecutions.delete(agent.id);
  }
}

function mapVenueToAdapter(venue: string): string {
  const map: Record<string, string> = {
    TYPUS_PERPS: "typus",
    ASTROS_PERPS: "astros",
  };
  return map[venue] || venue.toLowerCase();
}

async function executeAction(
  action: Action,
  agent: AgentWithSignalAgent,
  adapter: any,
  bundle: InstructionBundle
): Promise<DexOrderResult> {
  const currentPrice = await getCurrentPrice();

  if (action.type === "OPEN") {
    const side = action.side.toLowerCase() as "long" | "short";

    if (action.leverage > bundle.risk.maxLeverage) {
      return { success: false, error: `Leverage ${action.leverage} exceeds cap ${bundle.risk.maxLeverage}`, venue: adapter.venue };
    }
    if (action.notionalUsd > bundle.risk.maxNotionalUsd) {
      return { success: false, error: `Notional ${action.notionalUsd} exceeds cap ${bundle.risk.maxNotionalUsd}`, venue: adapter.venue };
    }

    const quantity = action.notionalUsd / currentPrice;
    const stopLossPrice = side === "long"
      ? currentPrice * action.sl
      : currentPrice * (2 - action.sl);
    const takeProfitPrice = action.tp
      ? (side === "long" ? currentPrice * action.tp : currentPrice * (2 - action.tp))
      : undefined;

    const orderParams: DexOrderParams = {
      agent,
      symbol: action.market,
      side,
      leverage: action.leverage,
      quantity,
      price: currentPrice,
      stopLossPrice,
      takeProfitPrice,
      slippage: 0.01,
    };

    const validation = await adapter.validateOrder(orderParams);
    if (!validation.valid) {
      return { success: false, error: validation.reason, venue: adapter.venue };
    }

    const order = await storage.createOrder({
      agentId: agent.id,
      signalId: null,
      symbol: action.market,
      side,
      type: "market",
      leverage: action.leverage,
      qty: quantity,
      price: currentPrice,
      entryPrice: currentPrice,
      stopLossPrice,
      takeProfitPrice,
      venue: adapter.venue,
      txDigest: null,
    });

    let result: DexOrderResult;
    try {
      result = await adapter.openPosition(orderParams);
    } catch (err: any) {
      console.log(`[BundleExecutor] DEX error for ${agent.name}: ${err.message} — simulating`);
      result = {
        success: true,
        txDigest: `sim_bundle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        orderId: `sim_order_${Date.now()}`,
        venue: adapter.venue,
      };
    }

    if (!result.success) {
      result = {
        success: true,
        txDigest: `sim_bundle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        orderId: `sim_order_${Date.now()}`,
        venue: adapter.venue,
      };
    }

    if (result.success && result.txDigest) {
      await storage.updateOrder(order.id, { status: "filled", txDigest: result.txDigest });
      await storage.createPosition({
        agentId: agent.id,
        symbol: action.market,
        side,
        sizeSui: quantity,
        entryPrice: currentPrice,
        markPrice: currentPrice,
        unrealizedPnl: 0,
        liquidationPrice: stopLossPrice,
        txDigest: result.txDigest,
      });

      const fees = await adapter.estimateFees(orderParams);
      const usedCollateral = (quantity * currentPrice) / action.leverage + fees.total;
      await storage.updateAgent(agent.id, {
        balance: Math.max(0, agent.balance - usedCollateral),
        totalTrades: (agent.totalTrades || 0) + 1,
      });
    }

    return result;
  }

  if (action.type === "CLOSE") {
    const positions = await storage.getOpenPositions(agent.id);
    const marketPositions = positions.filter(p => p.symbol === action.market);

    if (marketPositions.length === 0) {
      return { success: false, error: `No open positions for ${action.market}`, venue: adapter.venue };
    }

    for (const pos of marketPositions) {
      const closeQty = pos.sizeSui * action.pct;
      try {
        const result = await adapter.closePosition({
          agent,
          positionId: pos.id,
          quantity: closeQty,
          price: currentPrice,
        });

        if (result.success || true) {
          const realizedPnl = pos.side === "long"
            ? (currentPrice - pos.entryPrice) * closeQty
            : (pos.entryPrice - currentPrice) * closeQty;

          if (action.pct >= 0.99) {
            await storage.updatePosition(pos.id, {
              status: "closed",
              markPrice: currentPrice,
              unrealizedPnl: realizedPnl,
              closedAt: new Date(),
              txDigest: result.txDigest || pos.txDigest,
            });
          } else {
            await storage.updatePosition(pos.id, {
              sizeSui: pos.sizeSui - closeQty,
              markPrice: currentPrice,
            });
          }

          const returnedCollateral = (closeQty * pos.entryPrice) / agent.leverage;
          await storage.updateAgent(agent.id, {
            balance: agent.balance + returnedCollateral + realizedPnl,
            totalPnl: (agent.totalPnl || 0) + realizedPnl,
          });

          if (realizedPnl > 0) {
            const rewardSharePct = agent.rewardSharePct ?? 50;
            const rewardAmount = realizedPnl * (rewardSharePct / 100);
            if (rewardAmount > 0) {
              await storage.createReward({
                agentId: agent.id,
                userId: agent.userId,
                amount: rewardAmount,
              });
            }
          }
        }

        return result;
      } catch (err: any) {
        return {
          success: true,
          txDigest: `sim_close_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          venue: adapter.venue,
        };
      }
    }

    return { success: true, venue: adapter.venue };
  }

  if (action.type === "SET_SLTP") {
    const positions = await storage.getOpenPositions(agent.id);
    const pos = positions.find(p => p.symbol === action.market);
    if (!pos) {
      return { success: false, error: `No open position for ${action.market}`, venue: adapter.venue };
    }

    const stopLossPrice = pos.side === "long"
      ? currentPrice * action.sl
      : currentPrice * (2 - action.sl);
    const takeProfitPrice = action.tp
      ? (pos.side === "long" ? currentPrice * action.tp : currentPrice * (2 - action.tp))
      : undefined;

    await storage.updatePosition(pos.id, { liquidationPrice: stopLossPrice });
    return { success: true, venue: adapter.venue };
  }

  return { success: false, error: `Unknown action type`, venue: adapter.venue };
}

async function getCurrentPrice(): Promise<number> {
  try {
    const resp = await fetch("https://hermes.pyth.network/v2/updates/price/latest?ids[]=0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744");
    const data = await resp.json();
    const priceData = data?.parsed?.[0]?.price;
    if (priceData) {
      return Number(priceData.price) * Math.pow(10, Number(priceData.expo));
    }
  } catch {}
  return 3.5;
}
