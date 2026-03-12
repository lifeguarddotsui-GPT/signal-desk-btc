import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { startMarketEngine, getMarketState, getPriceHistory, getIndicatorHistory, getCandleHistory, getLastSignalResult, getMultiTFCandles, getLastTritonSignal } from "./market-engine";
import { priceBus, getLastPrice } from "./price-service";
import { insertAgentSchema, PROTOCOL_FEE_RATE, PROTOCOL_FEE_ADDRESS } from "@shared/schema";
import { verifyTxDigest, getOnChainBalance, verifyDepositTransfers, resolveNSName } from "./sui-verify";
import { generateAgentWallet, getAdapterStatus, getAdapter } from "./dex";
import { closeAllPositionsForAgent, closePositionForAgent, resetGasSpendTracking, markIntegrityComplete, getPendingUnfilledOrdersForAgent, registerTopoffResume } from "./dex/execution-engine";
import { startExecutorLoop } from "./executor/executor-loop";
import { runStartupIntegrityChecks, startPeriodicBalanceSync, setPeriodicSyncPriceFn, getPendingRecoveryCloses, clearPendingRecoveryCloses } from "./startup-integrity";
import { initRewardWallet, getRewardWalletAddress, getRewardWalletBalance, transferRewardToUser } from "./reward-wallet";
import { startPnlAuditLoop, runPnlAudit } from "./pnl-auditor";

function sanitizeAgent(agent: any) {
  if (!agent) return agent;
  const { agentWallet, ...safe } = agent;
  return safe;
}

function sanitizeAgents(agents: any[]) {
  return agents.map(sanitizeAgent);
}

const chainDerivedCache = new Map<string, { result: ChainDerivedResult; timestamp: number }>();
const CHAIN_DERIVED_CACHE_TTL = 120_000;
const onChainBalanceCache = new Map<string, { sui: number; timestamp: number }>();
const ONCHAIN_BALANCE_CACHE_TTL = 15_000;
const autoCorrectionLastApplied = new Map<string, number>();
const AUTO_CORRECTION_COOLDOWN = 5 * 60 * 1000;

export type CachedOnChainPosition = { positionId: string; side: string; size: number; collateral: number; entryPrice: number };
const onChainPositionsCache = new Map<string, { positions: CachedOnChainPosition[]; totalLocked: number; timestamp: number }>();
const ONCHAIN_POSITIONS_CACHE_TTL = 10_000;

const gasTxCountCache = new Map<string, { count: number; timestamp: number }>();
const GAS_TX_COUNT_CACHE_TTL = 120_000;

const chainOrderScanCache = new Map<string, { orders: Array<{ orderId: string; collateral: number; direction: string; isStopOrder: boolean }>; timestamp: number }>();
const CHAIN_ORDER_SCAN_CACHE_TTL = 15_000;

export function invalidateOnChainPortfolioCache(agentId: string) {
  if ((globalThis as any).__onChainPortfolioCache) {
    (globalThis as any).__onChainPortfolioCache.delete(agentId);
  }
  chainDerivedCache.delete(agentId);
  onChainPositionsCache.delete(agentId);
}

export function setOnChainPositionsCache(agentId: string, positions: CachedOnChainPosition[], totalLocked: number) {
  onChainPositionsCache.set(agentId, { positions, totalLocked, timestamp: Date.now() });
}

function getCachedOnChainPositions(agentId: string): { positions: CachedOnChainPosition[]; totalLocked: number } | null {
  const cached = onChainPositionsCache.get(agentId);
  if (cached && Date.now() - cached.timestamp < ONCHAIN_POSITIONS_CACHE_TTL) {
    return { positions: cached.positions, totalLocked: cached.totalLocked };
  }
  return null;
}

type ChainTrade = {
  openDigest: string;
  closeDigest: string | null;
  collateral: number;
  returned: number;
  pnlSui: number;
  outcome: "win" | "loss" | "liquidated" | "cancelled" | "open";
  openTimestamp: string | null;
  closeTimestamp: string | null;
};

type ChainDerivedResult = {
  tradeCount: number;
  wins: number;
  losses: number;
  liquidations: number;
  winRate: number;
  totalPnl: number;
  realizedGain: number;
  realizedLoss: number;
  gasCosts: number;
  chainTrades: ChainTrade[];
};

async function computeChainDerivedStats(agent: any): Promise<ChainDerivedResult | null> {
  if (!agent.walletAddress) return null;

  const cached = chainDerivedCache.get(agent.id);
  if (cached && Date.now() - cached.timestamp < CHAIN_DERIVED_CACHE_TTL) {
    return cached.result;
  }

  const { suiClient: sc } = await import("./sui-verify");
  const walletAddress = agent.walletAddress;
  const SUI_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
  const normalizeAddr = (a: string) => a.toLowerCase();
  const isSuiCoin = (coinType: string) => coinType === "0x2::sui::SUI" || coinType === SUI_TYPE;

  const transactions: any[] = [];
  let cursor: string | null | undefined = undefined;

  for (let page = 0; page < 5; page++) {
    const fromQuery: any = await sc.queryTransactionBlocks({
      filter: { FromAddress: walletAddress },
      options: { showBalanceChanges: true, showEvents: true, showInput: true, showEffects: true },
      limit: 50, order: "descending" as any,
      ...(cursor ? { cursor } : {}),
    });
    if (fromQuery.data) transactions.push(...fromQuery.data);
    if (!fromQuery.hasNextPage || !fromQuery.nextCursor) break;
    cursor = fromQuery.nextCursor;
  }

  cursor = undefined;
  for (let page = 0; page < 5; page++) {
    const toQuery: any = await sc.queryTransactionBlocks({
      filter: { ToAddress: walletAddress },
      options: { showBalanceChanges: true, showEvents: true, showInput: true, showEffects: true },
      limit: 50, order: "descending" as any,
      ...(cursor ? { cursor } : {}),
    });
    if (toQuery.data) {
      for (const tx of toQuery.data) {
        if (!transactions.find((t: any) => t.digest === tx.digest)) transactions.push(tx);
      }
    }
    if (!toQuery.hasNextPage || !toQuery.nextCursor) break;
    cursor = toQuery.nextCursor;
  }

  let totalGas = 0;
  const orderCreates: Array<{ digest: string; amountSui: number; timestamp: number; relatedOrderId: string | null; relatedPositionId: string | null }> = [];
  const returns: Array<{ digest: string; amountSui: number; timestamp: number; type: "order_cancel" | "close_fill"; relatedOrderId: string | null; relatedPositionId: string | null; linkedPositionId: string | null; hasLiquidateEvent: boolean }> = [];
  const liquidationDigests = new Set<string>();
  const orderIdToPositionId = new Map<string, string>();

  for (const tx of transactions) {
    const status = tx.effects?.status?.status === "success" ? "success" : "failure";
    if (status !== "success") continue;

    const balanceChanges = tx.balanceChanges || [];
    const events = tx.events || [];
    const timestampMs = tx.timestampMs ? Number(tx.timestampMs) : 0;

    const agentSuiChange = balanceChanges
      .filter((bc: any) => bc.owner?.AddressOwner && normalizeAddr(bc.owner.AddressOwner) === normalizeAddr(walletAddress) && isSuiCoin(bc.coinType))
      .reduce((sum: number, bc: any) => sum + Number(bc.amount), 0);

    const amountSui = Math.abs(agentSuiChange) / 1e9;
    const direction = agentSuiChange >= 0 ? "in" : "out";

    const gasUsed = tx.effects?.gasUsed;
    if (gasUsed) {
      const comp = Number(gasUsed.computationCost || 0);
      const stor = Number(gasUsed.storageCost || 0);
      const rebate = Number(gasUsed.storageRebate || 0);
      totalGas += Math.max(0, (comp + stor - rebate)) / 1e9;
    }

    const eventTypes = events.map((e: any) => (e.type || "").split("::").pop() || "");
    const hasCreateOrder = eventTypes.some((t: string) => t.includes("CreateTradingOrderEvent"));
    const hasCancelOrder = eventTypes.some((t: string) => t.includes("CancelTradingOrderEvent"));
    const hasLiquidate = eventTypes.some((t: string) => t.includes("LiquidateEvent"));
    const hasClosePosition = eventTypes.some((t: string) =>
      t.includes("ClosePositionEvent") || t.includes("DecreasePositionEvent") || t.includes("PositionChangeEvent")
    );
    const hasOrderFilled = eventTypes.some((t: string) => t.includes("OrderFilledEvent"));
    const hasRemovePos = eventTypes.some((t: string) => t.includes("RemovePositionEvent"));

    if (hasLiquidate) {
      liquidationDigests.add(tx.digest);
    }

    let relatedOrderId: string | null = null;
    let relatedPositionId: string | null = null;
    let linkedPositionId: string | null = null;
    for (const evt of events) {
      const parsed = (evt as any).parsedJson;
      if (!parsed) continue;
      if (parsed.order_id) relatedOrderId = String(parsed.order_id);
      if (parsed.position_id) relatedPositionId = String(parsed.position_id);
      if (parsed.new_position_id) relatedPositionId = String(parsed.new_position_id);
      if (parsed.linked_position_id) linkedPositionId = String(parsed.linked_position_id);
      if (parsed.order_id && parsed.new_position_id) {
        orderIdToPositionId.set(String(parsed.order_id), String(parsed.new_position_id));
      }
    }

    let type: string = "unknown";

    if (hasCreateOrder) {
      type = "order_create";
    }
    if (hasCancelOrder) {
      type = "order_cancel";
    }
    if ((hasOrderFilled && (hasClosePosition || hasRemovePos)) || hasClosePosition || hasRemovePos) {
      type = "close_fill";
    }
    if (hasLiquidate) {
      type = "close_fill";
    }

    if (type === "order_create" && direction === "out" && amountSui > 0.1) {
      orderCreates.push({ digest: tx.digest, amountSui, timestamp: timestampMs, relatedOrderId, relatedPositionId });
    }

    if (type === "order_cancel" && direction === "in" && amountSui > 0.01) {
      returns.push({ digest: tx.digest, amountSui, timestamp: timestampMs, type: "order_cancel", relatedOrderId, relatedPositionId, linkedPositionId, hasLiquidateEvent: false });
    }

    if (type === "close_fill" && direction === "in" && amountSui > 0.01) {
      returns.push({ digest: tx.digest, amountSui, timestamp: timestampMs, type: "close_fill", relatedOrderId, relatedPositionId, linkedPositionId, hasLiquidateEvent: hasLiquidate });
    }

    if (hasLiquidate && (direction === "out" || amountSui <= 0.01)) {
      returns.push({ digest: tx.digest, amountSui: 0, timestamp: timestampMs, type: "close_fill", relatedOrderId, relatedPositionId, linkedPositionId, hasLiquidateEvent: true });
    }
  }

  orderCreates.sort((a, b) => a.timestamp - b.timestamp);
  returns.sort((a, b) => a.timestamp - b.timestamp);

  let currentlyLockedOnChain = 0;
  let getPositionsSucceeded = false;
  const unfilledOrderIds = new Set<string>();
  try {
    const adapter = getAdapter(agent.venue || "typus");
    if (adapter) {
      const openPositions = await adapter.getPositions(walletAddress);
      getPositionsSucceeded = true;
      for (const pos of openPositions) currentlyLockedOnChain += pos.collateral || 0;
      const walletBal = await getOnChainBalance(walletAddress);
      if (walletBal.sui > 0.1) {
        try {
          const { TypusAdapter } = await import("./dex/typus-adapter");
          if (adapter instanceof TypusAdapter) {
            const { created, unfilled } = await adapter.findAllUnfilledOrderIds(walletAddress);
            for (const oid of unfilled) {
              unfilledOrderIds.add(oid);
              const orderInfo = created.get(oid);
              if (orderInfo && !orderInfo.isReduceOnly && orderInfo.collateral > 0) {
                currentlyLockedOnChain += orderInfo.collateral;
              }
            }
          }
        } catch {}
      }
    }
  } catch {}

  const usedReturns = new Set<string>();
  const orderIdToDigest = new Map<string, string>();
  const posIdToDigest = new Map<string, string>();
  for (const o of orderCreates) {
    if (o.relatedOrderId) orderIdToDigest.set(o.relatedOrderId, o.digest);
    if (o.relatedPositionId) posIdToDigest.set(o.relatedPositionId, o.digest);
    if (o.relatedOrderId) {
      const posId = orderIdToPositionId.get(o.relatedOrderId);
      if (posId) posIdToDigest.set(posId, o.digest);
    }
  }

  const returnsByOpen = new Map<string, typeof returns[0]>();
  for (const ret of returns) {
    const linkedPosId = ret.linkedPositionId;
    if (linkedPosId && posIdToDigest.has(linkedPosId)) {
      const od = posIdToDigest.get(linkedPosId)!;
      if (!returnsByOpen.has(od)) { returnsByOpen.set(od, ret); usedReturns.add(ret.digest); continue; }
    }
    if (ret.relatedOrderId && orderIdToDigest.has(ret.relatedOrderId)) {
      const od = orderIdToDigest.get(ret.relatedOrderId)!;
      if (!returnsByOpen.has(od)) { returnsByOpen.set(od, ret); usedReturns.add(ret.digest); }
    } else if (ret.relatedPositionId && posIdToDigest.has(ret.relatedPositionId)) {
      const od = posIdToDigest.get(ret.relatedPositionId)!;
      if (!returnsByOpen.has(od)) { returnsByOpen.set(od, ret); usedReturns.add(ret.digest); }
    }
  }

  let wins = 0, losses = 0, liquidations = 0, totalPnl = 0, rGain = 0, rLoss = 0;
  const chainTrades: ChainTrade[] = [];
  const unmatchedOrders: typeof orderCreates = [];

  for (const order of orderCreates) {
    let matched = returnsByOpen.get(order.digest);
    if (!matched) {
      const candidates = returns.filter(r => !usedReturns.has(r.digest) && r.timestamp >= order.timestamp);
      const collateralMatches = candidates.filter(r => Math.abs(r.amountSui - order.amountSui) < order.amountSui * 0.5);
      const pool = collateralMatches.length > 0 ? collateralMatches : candidates;
      if (pool.length > 0) {
        matched = pool.reduce((best, r) => (r.timestamp - order.timestamp) < (best.timestamp - order.timestamp) ? r : best);
        usedReturns.add(matched.digest);
      }
    }

    if (matched) {
      const pnl = matched.amountSui - order.amountSui;
      const isCancelReturn = matched.type === "order_cancel" && Math.abs(pnl) < 0.05;
      if (isCancelReturn) {
        chainTrades.push({
          openDigest: order.digest, closeDigest: matched.digest,
          collateral: order.amountSui, returned: matched.amountSui,
          pnlSui: pnl, outcome: "cancelled",
          openTimestamp: order.timestamp ? new Date(order.timestamp).toISOString() : null,
          closeTimestamp: matched.timestamp ? new Date(matched.timestamp).toISOString() : null,
        });
        continue;
      }
      const isLiqEvent = matched.hasLiquidateEvent || liquidationDigests.has(matched.digest);
      if (isLiqEvent) {
        liquidations++;
        totalPnl += pnl;
        rLoss += pnl;
        chainTrades.push({
          openDigest: order.digest, closeDigest: matched.digest,
          collateral: order.amountSui, returned: matched.amountSui,
          pnlSui: pnl, outcome: "liquidated",
          openTimestamp: order.timestamp ? new Date(order.timestamp).toISOString() : null,
          closeTimestamp: matched.timestamp ? new Date(matched.timestamp).toISOString() : null,
        });
      } else {
        totalPnl += pnl;
        if (pnl > 0) { wins++; rGain += pnl; }
        else { losses++; rLoss += pnl; }
        chainTrades.push({
          openDigest: order.digest, closeDigest: matched.digest,
          collateral: order.amountSui, returned: matched.amountSui,
          pnlSui: pnl, outcome: pnl > 0 ? "win" : "loss",
          openTimestamp: order.timestamp ? new Date(order.timestamp).toISOString() : null,
          closeTimestamp: matched.timestamp ? new Date(matched.timestamp).toISOString() : null,
        });
      }
    } else {
      unmatchedOrders.push(order);
    }
  }

  const unusedReturns = returns.filter(r => !usedReturns.has(r.digest));

  unmatchedOrders.sort((a, b) => b.timestamp - a.timestamp);
  for (const order of unmatchedOrders) {
    const hasEnoughLocked = currentlyLockedOnChain >= order.amountSui * 0.5;
    if (hasEnoughLocked) {
      const isPendingOrder = order.relatedOrderId && unfilledOrderIds.has(order.relatedOrderId);
      chainTrades.push({
        openDigest: order.digest, closeDigest: null,
        collateral: order.amountSui, returned: 0,
        pnlSui: 0, outcome: isPendingOrder ? "pending_order" : "open",
        openTimestamp: order.timestamp ? new Date(order.timestamp).toISOString() : null,
        closeTimestamp: null,
      });
      currentlyLockedOnChain = Math.max(0, currentlyLockedOnChain - order.amountSui);
    } else if (!getPositionsSucceeded) {
      chainTrades.push({
        openDigest: order.digest, closeDigest: null,
        collateral: order.amountSui, returned: 0,
        pnlSui: 0, outcome: "open",
        openTimestamp: order.timestamp ? new Date(order.timestamp).toISOString() : null,
        closeTimestamp: null,
      });
    } else {
      const lateMatch = unusedReturns.find(r => !usedReturns.has(r.digest) && r.timestamp >= order.timestamp);
      if (lateMatch) {
        usedReturns.add(lateMatch.digest);
        const pnl = lateMatch.amountSui - order.amountSui;
        const isLiqEvent = lateMatch.hasLiquidateEvent || liquidationDigests.has(lateMatch.digest);
        if (isLiqEvent) { liquidations++; } else if (pnl > 0) { wins++; rGain += pnl; } else { losses++; }
        totalPnl += pnl;
        if (pnl < 0) rLoss += pnl;
        chainTrades.push({
          openDigest: order.digest, closeDigest: lateMatch.digest,
          collateral: order.amountSui, returned: lateMatch.amountSui,
          pnlSui: pnl, outcome: isLiqEvent ? "liquidated" : pnl > 0 ? "win" : "loss",
          openTimestamp: order.timestamp ? new Date(order.timestamp).toISOString() : null,
          closeTimestamp: lateMatch.timestamp ? new Date(lateMatch.timestamp).toISOString() : null,
        });
      } else {
        chainTrades.push({
          openDigest: order.digest, closeDigest: null,
          collateral: order.amountSui, returned: order.amountSui,
          pnlSui: 0, outcome: "cancelled",
          openTimestamp: order.timestamp ? new Date(order.timestamp).toISOString() : null,
          closeTimestamp: null,
        });
      }
    }
  }

  const tradeCount = wins + losses + liquidations;
  const result: ChainDerivedResult = {
    tradeCount,
    wins,
    losses,
    liquidations,
    winRate: tradeCount > 0 ? wins / tradeCount : 0,
    totalPnl: parseFloat(totalPnl.toFixed(6)),
    realizedGain: parseFloat(rGain.toFixed(6)),
    realizedLoss: parseFloat(rLoss.toFixed(6)),
    gasCosts: parseFloat(totalGas.toFixed(6)),
    chainTrades,
  };
  chainDerivedCache.set(agent.id, { result, timestamp: Date.now() });
  return result;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  startMarketEngine().catch(err => {
    console.error("[startup] Market engine init failed:", err.message);
  });
  startExecutorLoop();
  startPnlAuditLoop();

  (async () => {
    try {
      const { initSessionGasFromDb } = await import("./dex/execution-engine");
      const allAgents = await storage.getAllAgents();
      for (const agent of allAgents) {
        if (agent.status === "running" && (agent as any).sessionGasUsed > 0) {
          initSessionGasFromDb(agent.id, (agent as any).sessionGasUsed, agent.balance);
        }
      }
    } catch {}
  })();

  initRewardWallet().catch(err => {
    console.error("[startup] Reward wallet init failed:", err.message);
  });

  runStartupIntegrityChecks().then(async () => {
    const pendingCloses = getPendingRecoveryCloses();
    if (pendingCloses.length > 0) {
      console.log(`[recovery] Processing ${pendingCloses.length} recovered positions that need re-close...`);
      clearPendingRecoveryCloses();

      let currentPrice = 0;
      for (let waitAttempt = 0; waitAttempt < 15 && currentPrice <= 0; waitAttempt++) {
        const lastPrice = getLastPrice();
        currentPrice = lastPrice?.pyth?.price ?? lastPrice?.blended ?? 0;
        if (currentPrice <= 0) {
          console.log(`[recovery] Waiting for price feed... (attempt ${waitAttempt + 1}/15)`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (currentPrice <= 0) {
        console.log(`[recovery] No price available after waiting — positions will be closed by position monitor.`);
      } else {
        for (const { agentId, positionId } of pendingCloses) {
          try {
            const agent = await storage.getAgent(agentId);
            if (!agent) continue;

            console.log(`[recovery] Re-closing recovered position ${positionId} for ${agent.name} at $${currentPrice.toFixed(4)}...`);
            const result = await closePositionForAgent(agent, positionId, currentPrice, false, "recovery");
            if (result.closed) {
              console.log(`[recovery] Successfully re-closed position ${positionId} for ${agent.name}: PnL=${result.pnl?.toFixed(4)}, txDigest=${result.txDigest || 'none'}`);
            } else {
              console.log(`[recovery] Re-close failed for ${agent.name} position ${positionId}: ${result.error || 'unknown'}. Position remains open — will be retried by position monitor.`);
            }
          } catch (err: any) {
            console.log(`[recovery] Error during re-close for position ${positionId}: ${err.message}`);
          }
        }
      }
    }

    markIntegrityComplete();
    console.log("[startup] Integrity checks complete — execution engine and position monitor unblocked.");
  }).catch(err => {
    console.error("[startup] Integrity check failed:", err.message);
    markIntegrityComplete();
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  const broadcast = (type: string, data: any) => {
    const msg = JSON.stringify({ type, data });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  };

  priceBus.on("tick", (tick) => {
    broadcast("price", tick);
  });

  startPeriodicBalanceSync(broadcast);
  setPeriodicSyncPriceFn(getLastPrice);

  const { setPositionMonitorBroadcast } = await import("./position-monitor");
  setPositionMonitorBroadcast(broadcast);

  wss.on("connection", (ws) => {
    const last = getLastPrice();
    if (last) {
      ws.send(JSON.stringify({ type: "price", data: last }));
    }

    storage.getAgentsWithSignalAgents().then((agentsList) => {
      ws.send(JSON.stringify({ type: "agents:init", data: sanitizeAgents(agentsList) }));
    });
  });

  app.get("/api/market", async (_req, res) => {
    try {
      const state = getMarketState();
      res.json({
        id: "live",
        symbol: "SUI-USDC",
        ...state,
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to get market data" });
    }
  });

  app.get("/api/price", (_req, res) => {
    const last = getLastPrice();
    res.json(last ?? null);
  });

  app.get("/api/market/history", async (_req, res) => {
    try {
      res.json(getPriceHistory());
    } catch (e) {
      res.status(500).json({ message: "Failed to get price history" });
    }
  });

  app.get("/api/market/indicators", async (_req, res) => {
    try {
      res.json(getIndicatorHistory());
    } catch (e) {
      res.status(500).json({ message: "Failed to get indicators" });
    }
  });

  app.get("/api/market/candles", async (_req, res) => {
    try {
      res.json(getCandleHistory());
    } catch (e) {
      res.status(500).json({ message: "Failed to get candle data" });
    }
  });

  app.get("/api/market/candles/multi", async (_req, res) => {
    try {
      res.json(getMultiTFCandles());
    } catch (e) {
      res.status(500).json({ message: "Failed to get multi-TF candle data" });
    }
  });

  app.get("/api/signals", async (_req, res) => {
    try {
      const sigs = await storage.getSignals(20);
      res.json(sigs);
    } catch (e) {
      res.status(500).json({ message: "Failed to get signals" });
    }
  });

  app.get("/api/signals/reasoning", (_req, res) => {
    try {
      const result = getLastSignalResult();
      if (!result) {
        return res.json({ available: false });
      }
      const triton = getLastTritonSignal();
      res.json({
        available: true,
        signal: result.signal,
        side: result.side,
        reason: result.reason,
        longScore: result.longScore,
        shortScore: result.shortScore,
        conditions: result.conditions,
        indicators: result.indicators,
        triton: triton ? {
          side: triton.side,
          regime: triton.regime,
          activeMode: triton.activeMode,
          htfBias: triton.htfBias,
          score: triton.score,
          rr: triton.rr,
          sizeMultiplier: triton.sizeMultiplier,
          reasons: triton.reasons,
          entry: triton.entry,
          stop: triton.stop,
          takeProfit: triton.takeProfit,
        } : null,
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to get signal reasoning" });
    }
  });

  app.get("/api/agents", async (_req, res) => {
    try {
      const agentsList = await storage.getAgentsWithSignalAgents();
      res.json(sanitizeAgents(agentsList));
    } catch (e) {
      res.status(500).json({ message: "Failed to get agents" });
    }
  });

  app.get("/api/agents/audit", async (_req, res) => {
    try {
      const allAgents = await storage.getAgents();
      const results: Array<{
        id: string;
        name: string;
        walletAddress: string;
        dbBalance: number;
        onChainBalance: number;
        lockedCollateral: number;
        pendingOrderCollateral: number;
        totalPortfolio: number;
        discrepancy: number;
        openPositions: number;
        status: string;
      }> = [];

      for (const agent of allAgents) {
        if (!agent.walletAddress) continue;

        let onChainSui = 0;
        try {
          const onChain = await getOnChainBalance(agent.walletAddress);
          onChainSui = onChain.sui;
        } catch {}

        const allPositions = await storage.getPositions(agent.id);
        const openPositions = allPositions.filter(p => p.status === "open" || p.status === "pending_open");
        let lockedCollateral = 0;
        for (const pos of openPositions) {
          lockedCollateral += pos.collateral || (pos.sizeSui / agent.leverage);
        }

        const pendingOrders = getPendingUnfilledOrdersForAgent(agent.id);
        const pendingOrderCollateral = pendingOrders.reduce((s, o) => s + o.collateral, 0);

        const totalPortfolio = onChainSui + lockedCollateral + pendingOrderCollateral;
        const discrepancy = Math.abs(agent.balance - totalPortfolio);

        if (discrepancy > 0.001) {
          await storage.updateAgent(agent.id, { balance: totalPortfolio });
          const updated = await storage.getAgent(agent.id);
          if (updated) {
            const { agentWallet, ...safe } = updated;
            broadcast("agent:updated", safe);
          }
        }

        results.push({
          id: agent.id,
          name: agent.name,
          walletAddress: agent.walletAddress,
          dbBalance: agent.balance,
          onChainBalance: onChainSui,
          lockedCollateral,
          pendingOrderCollateral,
          totalPortfolio,
          discrepancy,
          openPositions: openPositions.length,
          status: discrepancy > 0.05 ? "SYNCED" : "OK",
        });
      }

      const totalOnChain = results.reduce((s, r) => s + r.onChainBalance, 0);
      const totalLocked = results.reduce((s, r) => s + r.lockedCollateral, 0);
      const totalPortfolio = results.reduce((s, r) => s + r.totalPortfolio, 0);
      const synced = results.filter(r => r.status === "SYNCED").length;

      res.json({
        timestamp: new Date().toISOString(),
        summary: {
          totalAgents: results.length,
          totalOnChainSui: totalOnChain,
          totalLockedCollateral: totalLocked,
          totalPortfolioValue: totalPortfolio,
          agentsSynced: synced,
        },
        agents: results,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Audit failed" });
    }
  });

  const onChainPortfolioCache = new Map<string, {
    freeSui: number;
    positions: Array<{ positionId: string; side: string; size: number; collateral: number; entryPrice: number }>;
    totalLocked: number;
    timestamp: number;
    source: "on-chain" | "initial-db";
  }>();
  (globalThis as any).__onChainPortfolioCache = onChainPortfolioCache;
  const ONCHAIN_PORTFOLIO_CACHE_TTL = 30_000;

  const portfolioStabilizer = new Map<string, {
    lastPortfolioValue: number;
    lastFreeSui: number;
    lastTotalLocked: number;
    lastPendingOrderCollateral: number;
    timestamp: number;
    settlingCollateral: number;
  }>();
  const PORTFOLIO_STABILITY_WINDOW_MS = 20_000;
  const PORTFOLIO_FLICKER_THRESHOLD_PCT = 0.10;

  app.get("/api/agents/on-chain-portfolio", async (_req, res) => {
    try {
      const allAgents = await storage.getAgents();
      const lastPrice = getLastPrice();
      const liveSuiPrice = lastPrice?.pyth?.price ?? lastPrice?.blended ?? 0;

      const computePnl = (side: string, entryPrice: number, size: number, collateral: number) => {
        if (liveSuiPrice <= 0 || entryPrice <= 0) return 0;
        const rawPnl = side === "long"
          ? (liveSuiPrice - entryPrice) * size / liveSuiPrice
          : (entryPrice - liveSuiPrice) * size / liveSuiPrice;
        return Math.max(-collateral, rawPnl);
      };

      const results: Array<{
        agentId: string;
        name: string;
        freeSui: number;
        positions: Array<{ positionId: string; side: string; size: number; collateral: number; entryPrice: number; markPrice: number; unrealizedPnl: number }>;
        totalLocked: number;
        pendingOrderCollateral: number;
        portfolioValue: number;
        totalUnrealizedPnl: number;
        retainedProfits: number;
        netDeposited: number;
        cached: boolean;
        source: string;
        settlingPositions: Array<{ id: string; side: string; collateral: number; closeState: string }>;
        settlingCollateral: number;
        isStabilized: boolean;
      }> = [];

      const allRewardsForPortfolio = await storage.getRewards();

      for (const agent of allAgents) {
        if (!agent.walletAddress) continue;

        const cached = onChainPortfolioCache.get(agent.id);
        const cacheValid = cached && Date.now() - cached.timestamp < ONCHAIN_PORTFOLIO_CACHE_TTL;

        let freeSui: number;
        let positionData: Array<{ positionId: string; side: string; size: number; collateral: number; entryPrice: number }>;
        let totalLocked: number;
        let source: string;
        let freshFetch = false;

        if (cacheValid) {
          freeSui = cached.freeSui;
          positionData = cached.positions;
          totalLocked = cached.totalLocked;
          source = cached.source;
        } else {
          let rpcBalanceOk = false;
          let rpcPositionsOk = false;
          let fetchedFreeSui = 0;
          let fetchedPositions: Array<{ positionId: string; side: string; size: number; collateral: number; entryPrice: number }> = [];
          let fetchedLocked = 0;

          try {
            const onChain = await getOnChainBalance(agent.walletAddress);
            fetchedFreeSui = onChain.sui;
            rpcBalanceOk = true;
            onChainBalanceCache.set(agent.id, { sui: onChain.sui, timestamp: Date.now() });
          } catch {}

          try {
            const adapter = getAdapter(agent.venue || "typus");
            if (adapter) {
              const rawPositions = await adapter.getPositions(agent.walletAddress);
              const wasRateLimited = (rawPositions as any)?.__rateLimited === true;
              if (!wasRateLimited && rawPositions.length >= 0) {
                rpcPositionsOk = true;
                const allDbPositions = await storage.getPositions(agent.id);
                const dbOpenPositions = allDbPositions.filter(p => p.status === "open" || p.status === "pending_open");
                const dbOpenPosIds = new Set(dbOpenPositions.map(p => p.onChainPositionId).filter(Boolean));
                let phantomCount = 0;

                for (const pos of rawPositions) {
                  const dbMatch = allDbPositions.find(p => p.onChainPositionId === pos.positionId);
                  if (dbMatch && dbMatch.status === "closed") {
                    const posRewards = await storage.getRewardsByPositionId(dbMatch.id);
                    if (posRewards.some(r => r.status !== "voided")) {
                      continue;
                    }
                    const dmAny = dbMatch as any;
                    const hasRealCloseTx = dbMatch.closeTxDigest &&
                      dbMatch.closeTxDigest !== "settled_onchain" &&
                      dbMatch.closeTxDigest !== "position_gone_onchain" &&
                      dbMatch.closeTxDigest !== "closed_externally" &&
                      dbMatch.closeTxDigest !== "cancelled_unfilled" &&
                      dbMatch.closeTxDigest !== "liquidated_onchain" &&
                      !dbMatch.closeTxDigest.startsWith("recovered_") &&
                      !dbMatch.closeTxDigest.startsWith("sim_") &&
                      !dbMatch.closeTxDigest.startsWith("db_");
                    if (hasRealCloseTx) {
                      continue;
                    }
                    const hasProperClose = dmAny.closeState === "closed" && dmAny.closeReason && dbMatch.closedAt;
                    const closedAgo = dbMatch.closedAt ? Date.now() - new Date(dbMatch.closedAt).getTime() : Infinity;
                    if (hasProperClose && closedAgo > 10 * 60 * 1000) {
                      continue;
                    }
                  }

                  if (!dbMatch && !dbOpenPosIds.has(pos.positionId)) {
                    const contentClosedMatch = allDbPositions.find(p =>
                      p.status === "closed" && p.side === pos.side &&
                      Math.abs((p.entryPrice || 0) - (pos.entryPrice || 0)) < 0.001 &&
                      Math.abs(p.sizeSui - (pos.size || 0)) < 1
                    );
                    if (contentClosedMatch) {
                      const ccAgo = contentClosedMatch.closedAt ? Date.now() - new Date(contentClosedMatch.closedAt).getTime() : Infinity;
                      const ccm = contentClosedMatch as any;
                      if ((ccm.closeState === "closed" && ccm.closeReason && contentClosedMatch.closedAt && ccAgo > 5 * 60 * 1000) ||
                          (contentClosedMatch.closeTxDigest && contentClosedMatch.closeTxDigest !== "settled_onchain" && contentClosedMatch.closeTxDigest !== "position_gone_onchain" && !contentClosedMatch.closeTxDigest.startsWith("recovered_") && !contentClosedMatch.closeTxDigest.startsWith("sim_") && !contentClosedMatch.closeTxDigest.startsWith("db_"))) {
                        phantomCount++;
                        continue;
                      }
                    }
                    phantomCount++;
                    continue;
                  }

                  const coll = (dbMatch && dbMatch.status !== "closed") 
                    ? (dbMatch.collateral || (dbMatch.sizeSui / (agent.leverage || 25)))
                    : (pos.collateral || (pos.size / (agent.leverage || 25)));
                  const notionalSize = (dbMatch && dbMatch.status !== "closed") 
                    ? dbMatch.sizeSui 
                    : (coll * (agent.leverage || 25));
                  fetchedPositions.push({ positionId: pos.positionId, side: pos.side, size: notionalSize, collateral: coll, entryPrice: pos.entryPrice });
                  fetchedLocked += coll;
                }

                if (phantomCount > 0) {
                  console.log(`[Portfolio] Agent ${agent.name}: filtered ${phantomCount} phantom on-chain position(s) with no DB match (DB has ${dbOpenPositions.length} open, on-chain scan found ${rawPositions.length})`);
                }

                const matchedOnChainPosIds = new Set(fetchedPositions.map(p => p.positionId));
                const missedDbPositions = dbOpenPositions.filter(p => {
                  if (!p.onChainPositionId) return !fetchedPositions.some(fp =>
                    fp.side === p.side &&
                    Math.abs(fp.entryPrice - p.entryPrice) < 0.001 &&
                    Math.abs(fp.size - p.sizeSui) < 1
                  );
                  return !matchedOnChainPosIds.has(p.onChainPositionId);
                });

                if (missedDbPositions.length > 0) {
                  console.log(`[Portfolio] Agent ${agent.name}: on-chain scan missed ${missedDbPositions.length} DB open position(s) — supplementing from DB`);
                  for (const dbPos of missedDbPositions) {
                    const coll = dbPos.collateral || (dbPos.sizeSui / (agent.leverage || 25));
                    fetchedPositions.push({
                      positionId: dbPos.onChainPositionId || dbPos.id,
                      side: dbPos.side,
                      size: dbPos.sizeSui,
                      collateral: coll,
                      entryPrice: dbPos.entryPrice,
                    });
                    fetchedLocked += coll;
                  }
                }
              }
            }
          } catch {}

          if (rpcBalanceOk && rpcPositionsOk) {
            freeSui = fetchedFreeSui;
            positionData = fetchedPositions;
            totalLocked = fetchedLocked;
            source = "on-chain";
            freshFetch = true;

            onChainPortfolioCache.set(agent.id, { freeSui, positions: positionData, totalLocked, timestamp: Date.now(), source: "on-chain" });
          } else if (cached) {
            freeSui = rpcBalanceOk ? fetchedFreeSui : cached.freeSui;
            positionData = rpcPositionsOk ? fetchedPositions : cached.positions;
            totalLocked = rpcPositionsOk ? fetchedLocked : cached.totalLocked;
            source = cached.source + " (extended)";

            if (rpcBalanceOk) {
              onChainPortfolioCache.set(agent.id, { freeSui, positions: positionData, totalLocked, timestamp: Date.now(), source: cached.source as any });
            } else {
              cached.timestamp = Date.now();
            }
          } else {
            freeSui = rpcBalanceOk ? fetchedFreeSui : Math.max(0, agent.balance);
            if (rpcPositionsOk) {
              positionData = fetchedPositions;
              totalLocked = fetchedLocked;
            } else {
              const dbOpenPositions = await storage.getOpenPositions(agent.id);
              positionData = dbOpenPositions.map(p => ({
                positionId: p.onChainPositionId || p.id,
                side: p.side,
                size: p.sizeSui,
                collateral: p.collateral || (p.sizeSui / (agent.leverage || 25)),
                entryPrice: p.entryPrice,
              }));
              totalLocked = positionData.reduce((s, p) => s + p.collateral, 0);
            }
            source = "initial-db";

            onChainPortfolioCache.set(agent.id, { freeSui, positions: positionData, totalLocked, timestamp: Date.now(), source: "initial-db" });
          }
        }

        let totalUnrealizedPnl = 0;
        const displayPositions = positionData.map(p => {
          const unrealizedPnl = computePnl(p.side, p.entryPrice, p.size, p.collateral);
          totalUnrealizedPnl += unrealizedPnl;
          return { ...p, markPrice: liveSuiPrice, unrealizedPnl };
        });

        const pendingOrders = getPendingUnfilledOrdersForAgent(agent.id);
        const pendingOrderCollateral = pendingOrders.reduce((s, o) => s + o.collateral, 0);

        const allDbPositions = await storage.getPositions(agent.id);
        const settlingPositions = allDbPositions
          .filter(p => {
            if (p.status === "open" && (p.closeState === "close_tx_submitted" || p.closeState === "close_order_working")) return true;
            if (p.status === "pending_open") return true;
            if (p.status === "open" && p.openedAt) {
              const ageMs = Date.now() - new Date(p.openedAt).getTime();
              if (ageMs < 30000) return true;
            }
            return false;
          })
          .map(p => ({
            id: p.id,
            side: p.side,
            collateral: p.collateral || (p.sizeSui / (agent.leverage || 25)),
            closeState: p.closeState || (p.status === "pending_open" ? "opening" : "open_settling"),
          }));
        const settlingCollateral = settlingPositions.reduce((s, p) => s + p.collateral, 0);

        const openSettlingCollateral = settlingPositions
          .filter(p => p.closeState === "opening" || p.closeState === "open_settling")
          .reduce((s, p) => s + p.collateral, 0);

        const rawPortfolioValue = freeSui + totalLocked + pendingOrderCollateral - openSettlingCollateral;
        const cappedRetained = Math.min(agent.retainedProfits || 0, Math.max(0, freeSui));
        const netDeposited = (agent.totalDeposited || 0) - (agent.protocolFeePaid || 0);

        const prev = portfolioStabilizer.get(agent.id);
        let portfolioValue = rawPortfolioValue;
        let isStabilized = false;

        if (prev && rawPortfolioValue > 0 && prev.lastPortfolioValue > 0) {
          const pctChange = Math.abs(rawPortfolioValue - prev.lastPortfolioValue) / prev.lastPortfolioValue;
          const age = Date.now() - prev.timestamp;

          if (pctChange > PORTFOLIO_FLICKER_THRESHOLD_PCT && age < PORTFOLIO_STABILITY_WINDOW_MS && (settlingCollateral > 0 || prev.settlingCollateral > 0)) {
            portfolioValue = prev.lastPortfolioValue;
            isStabilized = true;
          }
        }

        if (!isStabilized) {
          portfolioStabilizer.set(agent.id, {
            lastPortfolioValue: rawPortfolioValue,
            lastFreeSui: freeSui,
            lastTotalLocked: totalLocked,
            lastPendingOrderCollateral: pendingOrderCollateral,
            timestamp: Date.now(),
            settlingCollateral,
          });
        }

        if (freshFetch && (agent.retainedProfits || 0) > freeSui && freeSui > 0) {
          storage.updateAgent(agent.id, { retainedProfits: freeSui }).catch(() => {});
        } else if (freshFetch && (agent.retainedProfits || 0) > 0 && freeSui <= 0.01) {
          storage.updateAgent(agent.id, { retainedProfits: 0 }).catch(() => {});
        }

        const agentClaimedRewardsAmount = allRewardsForPortfolio
          .filter(r => r.agentId === agent.id && r.status === "claimed")
          .reduce((sum, r) => sum + r.amount, 0);

        results.push({
          agentId: agent.id,
          name: agent.name,
          freeSui: isStabilized && prev ? prev.lastFreeSui : freeSui,
          positions: displayPositions,
          totalLocked: isStabilized && prev ? prev.lastTotalLocked : totalLocked,
          pendingOrderCollateral: isStabilized && prev ? prev.lastPendingOrderCollateral : pendingOrderCollateral,
          portfolioValue,
          totalUnrealizedPnl,
          retainedProfits: cappedRetained,
          netDeposited,
          claimedRewards: agentClaimedRewardsAmount,
          cached: cacheValid || false,
          source,
          settlingPositions,
          settlingCollateral,
          isStabilized,
        });
      }

      res.json({
        timestamp: new Date().toISOString(),
        agents: results,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to fetch on-chain portfolio" });
    }
  });

  app.get("/api/agents/:id", async (req, res) => {
    try {
      const agent = await storage.getAgentWithSignalAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      res.json(sanitizeAgent(agent));
    } catch (e) {
      res.status(500).json({ message: "Failed to get agent" });
    }
  });

  app.post("/api/agents/:id/pnl-audit", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      const { auditAgent } = await import("./pnl-auditor");
      await auditAgent(agent as any);
      const updatedPositions = await storage.getPositions(req.params.id);
      const verifiedCount = updatedPositions.filter(p =>
        p.pnlSource === "onchain_verified" || p.pnlSource === "keeper_verified"
      ).length;
      res.json({
        success: true,
        auditedAt: new Date().toISOString(),
        verifiedPositions: verifiedCount,
        totalClosed: updatedPositions.filter(p => p.status === "closed").length,
      });
    } catch (e: any) {
      res.status(500).json({ message: `Audit failed: ${e.message?.slice(0, 100)}` });
    }
  });

  app.get("/api/agents/:id/orders", async (req, res) => {
    try {
      const allOrders = await storage.getOrders(req.params.id);
      res.json(allOrders);
    } catch (e) {
      res.status(500).json({ message: "Failed to get orders" });
    }
  });

  app.get("/api/agents/:id/signals", async (req, res) => {
    try {
      const agentSignals = await storage.getSignalsByAgent(req.params.id, 30);
      res.json(agentSignals);
    } catch (e) {
      res.status(500).json({ message: "Failed to get agent signals" });
    }
  });

  app.get("/api/agents/:id/positions", async (req, res) => {
    try {
      const agent = await storage.getAgentWithSignalAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });

      const agentPositions = await storage.getPositions(req.params.id);
      const verifiedPositions = agentPositions.filter(p => {
        if (p.closeReason === "deleted_bogus_recovery") return false;
        if (p.status === "open" || p.status === "pending_open") return true;
        if (p.status === "closed") {
          // Exclude pure simulation entries (never on-chain) but include everything else.
          // verified flag is an open-TX flag and is never updated at close time — do not filter closed positions by it.
          if (p.txDigest?.startsWith("sim_")) return false;
          return true;
        }
        // pending_submission and other transient states: require a real txDigest
        return !!(p.txDigest && !p.txDigest.startsWith("sim_"));
      });
      const openPositions = verifiedPositions.filter(p => (p.status === "open" || p.status === "pending_open"));

      const lastPrice = getLastPrice();
      const liveSuiPrice = lastPrice?.pyth?.price ?? lastPrice?.blended ?? 0;

      let untrackedOnChainPositions: Array<{ positionId: string; side: string; size: number; collateral: number; entryPrice: number }> = [];
      if (agent.walletAddress) {
        const cached = getCachedOnChainPositions(agent.id);
        const openDbPositionIds = new Set(openPositions.map(p => p.onChainPositionId).filter(Boolean));
        const allDbPositions = await storage.getPositions(req.params.id);
        const allDbPosIds = new Set(allDbPositions.map(p => p.onChainPositionId).filter(Boolean));

        if (cached) {
          for (const ocp of cached.positions) {
            if (!ocp.positionId || openDbPositionIds.has(ocp.positionId)) continue;
            if (!allDbPosIds.has(ocp.positionId)) continue;
            const contentMatch = openPositions.find(p =>
              p.entryPrice > 0 && ocp.entryPrice && ocp.entryPrice > 0 &&
              p.side === ocp.side &&
              Math.abs(p.entryPrice - ocp.entryPrice) < 0.001 &&
              Math.abs(p.sizeSui - (ocp.size || 0)) < 1
            );
            if (contentMatch) continue;
            const closedMatch = allDbPositions.find(p => p.onChainPositionId === ocp.positionId && p.status === "closed");
            if (closedMatch) continue;
            untrackedOnChainPositions.push(ocp);
          }
        } else {
          try {
            const adapter = getAdapter(agent.venue || "typus");
            if (adapter) {
              const onChainPositions = await adapter.getPositions(agent.walletAddress);
              const cachedPositions: CachedOnChainPosition[] = [];
              for (const ocp of onChainPositions) {
                if (!ocp.positionId) continue;

                if (openDbPositionIds.has(ocp.positionId)) {
                  cachedPositions.push({
                    positionId: ocp.positionId, side: ocp.side, size: ocp.size,
                    collateral: ocp.collateral || (ocp.size / (agent.leverage || 25)),
                    entryPrice: ocp.entryPrice || 0,
                  });
                  continue;
                }

                const contentMatch = openPositions.find(p =>
                  p.entryPrice > 0 && ocp.entryPrice && ocp.entryPrice > 0 &&
                  p.side === ocp.side &&
                  Math.abs(p.entryPrice - ocp.entryPrice) < 0.001 &&
                  Math.abs(p.sizeSui - (ocp.size || 0)) < 1
                );
                if (contentMatch) {
                  if (contentMatch.onChainPositionId !== ocp.positionId) {
                    storage.updatePosition(contentMatch.id, { onChainPositionId: ocp.positionId }).catch(() => {});
                  }
                  cachedPositions.push({
                    positionId: ocp.positionId, side: ocp.side, size: ocp.size,
                    collateral: ocp.collateral || (ocp.size / (agent.leverage || 25)),
                    entryPrice: ocp.entryPrice || 0,
                  });
                  continue;
                }

                if (!allDbPosIds.has(ocp.positionId)) continue;
                const closedMatch = allDbPositions.find(p => p.onChainPositionId === ocp.positionId && p.status === "closed");
                if (closedMatch) continue;

                const cp: CachedOnChainPosition = {
                  positionId: ocp.positionId, side: ocp.side, size: ocp.size,
                  collateral: ocp.collateral || (ocp.size / (agent.leverage || 25)),
                  entryPrice: ocp.entryPrice || 0,
                };
                cachedPositions.push(cp);
                untrackedOnChainPositions.push(cp);
              }
              setOnChainPositionsCache(agent.id, cachedPositions, 0);
            }
          } catch {}
        }
      }

      const pendingOrders = getPendingUnfilledOrdersForAgent(req.params.id);

      res.json({
        positions: openPositions,
        untrackedOnChainPositions,
        liveSuiPrice,
        pendingOrders: pendingOrders.map(o => ({ orderId: o.orderId, collateral: o.collateral, direction: o.direction, isStopOrder: false })),
      });
    } catch (e: any) {
      res.status(500).json({ message: "Failed to get positions" });
    }
  });

  app.get("/api/agents/:id/activity", async (req, res) => {
    try {
      const agentOrders = await storage.getOrders(req.params.id);
      const agentPositions = await storage.getPositions(req.params.id);
      const agentSignals = await storage.getSignalsByAgent(req.params.id, 20);
      const agent = await storage.getAgentWithSignalAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });

      const reasoning = getLastSignalResult();

      const isVerifiedTx = (tx: string | null | undefined, verified?: boolean) => tx && !tx.startsWith("sim_") && verified !== false;
      const verifiedOrders = agentOrders.filter(o => isVerifiedTx(o.txDigest, o.verified));
      const verifiedPositions = agentPositions.filter(p => {
        if (p.closeReason === "deleted_bogus_recovery") return false;
        if (p.status === "open" || p.status === "pending_open") return true;
        if (p.status === "closed") {
          // verified flag is the open-TX flag, never updated at close time — do not use it to filter closed positions.
          // Only exclude positions that were pure simulation entries (never on-chain).
          if (p.txDigest?.startsWith("sim_")) return false;
          return true;
        }
        return !!(p.txDigest && !p.txDigest.startsWith("sim_"));
      });

      const openPositions = verifiedPositions.filter(p => (p.status === "open" || p.status === "pending_open"));
      // Use ALL closed positions (not just verified-open ones) for win rate — recovered positions
      // may have verified=false but still represent real completed trades
      const closedPositions = agentPositions.filter(p =>
        p.status === "closed" &&
        p.closeReason !== "deleted_bogus_recovery" &&
        p.closeTxDigest !== "cancelled_unfilled"
      );
      const totalClosed = closedPositions.length;
      const totalWins = closedPositions.filter(p => (p.unrealizedPnl || 0) > 0).length;
      const liveWinRate = totalClosed > 0 ? totalWins / totalClosed : 0;

      // Keeper-verified: actual on-chain balance changes (most accurate)
      const keeperOnChainSettlement = closedPositions
        .filter(p => (p.pnlSource === "keeper_verified" || p.pnlSource === "onchain_verified") && (p.returnedSui ?? 0) > 0)
        .reduce((sum, p) => sum + (p.returnedSui || 0), 0);
      // Comprehensive: for positions without keeper data, estimate from collateral + realized PnL
      const settlementReceived = closedPositions.reduce((sum, p) => {
        if ((p.returnedSui ?? 0) > 0) return sum + p.returnedSui!;
        // Estimate: what the wallet received when this position closed
        const coll = p.collateral || (p.sizeSui / (agent.leverage || 36));
        const pnl = p.unrealizedPnl || 0;
        return sum + Math.max(0, coll + pnl);
      }, 0);
      const collateralDeployed = agentPositions
        .filter(p => p.closeTxDigest !== "cancelled_unfilled" && (p.collateral ?? 0) > 0)
        .reduce((sum, p) => sum + (p.collateral || 0), 0);

      const lastPrice = getLastPrice();
      const liveSuiPrice = lastPrice?.pyth?.price ?? lastPrice?.blended ?? 0;

      let lockedCollateral = 0;
      let totalUnrealizedPnl = 0;
      for (const pos of openPositions) {
        const posCollateral = pos.collateral || (pos.sizeSui / agent.leverage);
        lockedCollateral += posCollateral;
        if (liveSuiPrice > 0 && pos.entryPrice > 0) {
          const rawPnl = pos.side === "long"
            ? (liveSuiPrice - pos.entryPrice) * pos.sizeSui / liveSuiPrice
            : (pos.entryPrice - liveSuiPrice) * pos.sizeSui / liveSuiPrice;
          totalUnrealizedPnl += Math.max(-posCollateral, rawPnl);
        } else {
          totalUnrealizedPnl += pos.unrealizedPnl || 0;
        }
      }

      let untrackedOnChainPositions: Array<{ positionId: string; side: string; size: number; collateral: number; entryPrice: number }> = [];
      if (agent.walletAddress) {
        try {
          const adapter = getAdapter(agent.venue || "typus");
          if (adapter) {
            const onChainPositions = await adapter.getPositions(agent.walletAddress);
            const openDbPositionIds = new Set(openPositions.map(p => p.onChainPositionId).filter(Boolean));
            const allPositions = await storage.getPositions(agent.id);
            const allDbPosIds = new Set(allPositions.map(p => p.onChainPositionId).filter(Boolean));
            let phantomCount = 0;

            for (const ocp of onChainPositions) {
              if (!ocp.positionId) continue;
              if (openDbPositionIds.has(ocp.positionId)) continue;

              if (ocp.entryPrice && ocp.entryPrice > 0) {
                const contentMatch = openPositions.find(p =>
                  p.entryPrice > 0 &&
                  p.side === ocp.side &&
                  Math.abs(p.entryPrice - ocp.entryPrice) < 0.001 &&
                  Math.abs(p.sizeSui - (ocp.size || 0)) < 1
                );
                if (contentMatch) {
                  if (contentMatch.onChainPositionId !== ocp.positionId) {
                    storage.updatePosition(contentMatch.id, { onChainPositionId: ocp.positionId }).catch(() => {});
                  }
                  openDbPositionIds.add(ocp.positionId);
                  continue;
                }
              }

              const posCollateral = ocp.collateral || (ocp.size / (agent.leverage || 25));

              const closedMatch = allPositions.find(p =>
                p.onChainPositionId === ocp.positionId && p.status === "closed"
              );
              if (closedMatch) {
                const posRewards = await storage.getRewardsByPositionId(closedMatch.id);
                const hasReward = posRewards.some(r => r.status !== "voided");
                if (hasReward) {
                  continue;
                }

                const cmAny = closedMatch as any;
                const hasRealCloseTx = closedMatch.closeTxDigest &&
                  closedMatch.closeTxDigest !== "settled_onchain" &&
                  closedMatch.closeTxDigest !== "position_gone_onchain" &&
                  closedMatch.closeTxDigest !== "closed_externally" &&
                  closedMatch.closeTxDigest !== "cancelled_unfilled" &&
                  closedMatch.closeTxDigest !== "liquidated_onchain" &&
                  !closedMatch.closeTxDigest.startsWith("recovered_") &&
                  !closedMatch.closeTxDigest.startsWith("sim_") &&
                  !closedMatch.closeTxDigest.startsWith("db_");
                if (hasRealCloseTx) {
                  continue;
                }

                const isSettledSynthetic = closedMatch.closeTxDigest === "settled_onchain" ||
                  closedMatch.closeTxDigest === "position_gone_onchain";
                const isCancelledButLive = closedMatch.closeTxDigest === "cancelled_unfilled" || isSettledSynthetic;

                if (closedMatch.closedAt) {
                  const closedAgo = Date.now() - new Date(closedMatch.closedAt).getTime();
                  // settled_onchain / position_gone_onchain: these are synthetic close markers
                  // that can be wrong (RPC blip caused false "gone" detection). Allow reopen
                  // after 3 minutes so the position monitor can manage them.
                  // cancelled_unfilled: keep 10-minute cooldown to avoid rapid open/cancel cycles.
                  const cooldownMs = isSettledSynthetic ? 3 * 60 * 1000 : 10 * 60 * 1000;
                  if (closedAgo < cooldownMs) {
                    continue;
                  }
                }

                if (isCancelledButLive && closedMatch.onChainPositionId && agent.walletAddress) {
                  try {
                    const { TypusAdapter: TA } = await import("./dex/typus-adapter");
                    const adapter = getAdapter("typus");
                    if (adapter instanceof TA) {
                      const priorFill = await adapter.checkPriorCloseFilled(agent.walletAddress, closedMatch.onChainPositionId);
                      if (priorFill.filled) {
                        console.log(`[Activity] Position ${closedMatch.onChainPositionId} for ${agent.name} was KEEPER-FILLED (tx: ${priorFill.txDigest}) — NOT re-opening`);
                        if (priorFill.txDigest) {
                          await storage.updatePosition(closedMatch.id, {
                            closeTxDigest: priorFill.txDigest,
                            closeState: "closed",
                          } as any);
                        }
                        continue;
                      }
                    }
                  } catch {}
                }

                const hasProperCloseLifecycle = cmAny.closeState === "closed" && cmAny.closeReason && closedMatch.closedAt;
                if (hasProperCloseLifecycle && !isCancelledButLive) {
                  continue;
                }

                if (closedMatch.closeTxDigest && closedMatch.closedAt && !isCancelledButLive) {
                  const closedAgo = Date.now() - new Date(closedMatch.closedAt).getTime();
                  if (closedAgo > 5 * 60 * 1000) {
                    continue;
                  }
                }

                try {
                  const closeTime = closedMatch.closedAt ? new Date(closedMatch.closedAt).getTime() : 0;
                  if (closeTime > 0) {
                    const closeRewards = posRewards.filter(r =>
                      r.status === "pending" && r.createdAt &&
                      Math.abs(new Date(r.createdAt).getTime() - closeTime) < 10000
                    );
                    for (const r of closeRewards) {
                      await storage.voidReward(r.id);
                      console.log(`[Activity] Voided reward ${r.id} for auto-reopened position ${closedMatch.id.slice(0, 8)}`);
                    }
                  }

                  await storage.updatePosition(closedMatch.id, {
                    status: "open",
                    closeState: "open",
                    markPrice: ocp.entryPrice || closedMatch.entryPrice,
                    unrealizedPnl: 0,
                    closedAt: null,
                    closeTxDigest: null,
                    closeReason: null,
                    verified: true,
                  } as any);
                  openDbPositionIds.add(ocp.positionId);
                  openPositions.push({ ...closedMatch, status: "open", unrealizedPnl: 0 } as any);
                  console.log(`[Activity] AUTO-REOPENED force-settled position ${closedMatch.id.slice(0, 8)} for ${agent.name} (${closedMatch.side} ${closedMatch.sizeSui} SUI, on-chain ID: ${ocp.positionId}) — position monitor will manage it`);
                } catch (reopenErr: any) {
                  console.log(`[Activity] Failed to auto-reopen ${closedMatch.id.slice(0, 8)}: ${reopenErr.message}`);
                }

                lockedCollateral += posCollateral;
                if (liveSuiPrice > 0 && (ocp.entryPrice || closedMatch.entryPrice) > 0) {
                  const ep = ocp.entryPrice || closedMatch.entryPrice;
                  const rawPnl = (ocp.side || closedMatch.side) === "long"
                    ? (liveSuiPrice - ep) * (ocp.size || closedMatch.sizeSui) / liveSuiPrice
                    : (ep - liveSuiPrice) * (ocp.size || closedMatch.sizeSui) / liveSuiPrice;
                  totalUnrealizedPnl += Math.max(-posCollateral, rawPnl);
                }
                continue;
              }

              if (!allDbPosIds.has(ocp.positionId)) {
                const recentlyClosedSameId = allPositions.find(p =>
                  p.onChainPositionId === ocp.positionId &&
                  p.status === "closed" &&
                  p.closedAt &&
                  (Date.now() - new Date(p.closedAt).getTime()) < 10 * 60 * 1000
                );
                if (recentlyClosedSameId) continue;
                phantomCount++;
                continue;
              }

              if (ocp.entryPrice && ocp.entryPrice > 0) {
                const leverage = agent.leverage || 25;
                const correctLiq = ocp.side === "long"
                  ? ocp.entryPrice * (1 - 1 / leverage)
                  : ocp.entryPrice * (1 + 1 / leverage);
                console.log(`[Activity] AUTO-CREATING managed position for ${agent.name}: posId=${ocp.positionId}, side=${ocp.side}, size=${ocp.size?.toFixed(2)}, collateral=${posCollateral.toFixed(4)} SUI, entry=$${ocp.entryPrice.toFixed(4)}`);
                try {
                  const notionalSize = posCollateral * leverage;
                  const newPos = await storage.createPosition({
                    agentId: agent.id,
                    symbol: "SUI-USDC",
                    side: ocp.side || "long",
                    sizeSui: notionalSize,
                    collateral: posCollateral,
                    entryPrice: ocp.entryPrice,
                    markPrice: ocp.entryPrice,
                    unrealizedPnl: 0,
                    liquidationPrice: correctLiq,
                    txDigest: `reopened_${ocp.positionId}`,
                  });
                  await storage.updatePosition(newPos.id, { onChainPositionId: ocp.positionId, verified: true });
                  openPositions.push(newPos as any);
                  openDbPositionIds.add(ocp.positionId);
                  lockedCollateral += posCollateral;
                  if (liveSuiPrice > 0) {
                    const rawPnl = ocp.side === "long"
                      ? (liveSuiPrice - ocp.entryPrice) * ocp.size / liveSuiPrice
                      : (ocp.entryPrice - liveSuiPrice) * ocp.size / liveSuiPrice;
                    totalUnrealizedPnl += Math.max(-posCollateral, rawPnl);
                  }
                } catch (createErr: any) {
                  console.log(`[Activity] Failed to create position: ${createErr.message}`);
                  untrackedOnChainPositions.push({
                    positionId: ocp.positionId,
                    side: ocp.side,
                    size: ocp.size,
                    collateral: posCollateral,
                    entryPrice: ocp.entryPrice,
                  });
                }
              } else {
                untrackedOnChainPositions.push({
                  positionId: ocp.positionId,
                  side: ocp.side,
                  size: ocp.size,
                  collateral: posCollateral,
                  entryPrice: ocp.entryPrice || 0,
                });
                lockedCollateral += posCollateral;
                if (liveSuiPrice > 0 && ocp.entryPrice > 0) {
                  const rawPnl = ocp.side === "long"
                    ? (liveSuiPrice - ocp.entryPrice) * ocp.size / liveSuiPrice
                    : (ocp.entryPrice - liveSuiPrice) * ocp.size / liveSuiPrice;
                  totalUnrealizedPnl += Math.max(-posCollateral, rawPnl);
                }
                console.log(`[Activity] UNTRACKED on-chain position for ${agent.name}: posId=${ocp.positionId}, no entry price — cannot auto-create`);
              }
            }

            if (phantomCount > 0) {
              console.log(`[Activity] Agent ${agent.name}: filtered ${phantomCount} phantom on-chain position(s) with no DB match (DB has ${openPositions.length} open, on-chain scan found ${onChainPositions.length})`);
            }

            const verifiedOnChainForCache: CachedOnChainPosition[] = onChainPositions
              .filter(ocp => ocp.positionId && (openDbPositionIds.has(ocp.positionId) || allDbPosIds.has(ocp.positionId)))
              .map(ocp => ({
                positionId: ocp.positionId,
                side: ocp.side,
                size: ocp.size,
                collateral: ocp.collateral || (ocp.size / (agent.leverage || 25)),
                entryPrice: ocp.entryPrice || 0,
              }));
            setOnChainPositionsCache(agent.id, verifiedOnChainForCache, lockedCollateral);
          }
        } catch (posErr: any) {
          console.log(`[Activity] On-chain position check failed for ${agent.name}: ${posErr.message?.slice(0, 80)}`);
          const cached = getCachedOnChainPositions(agent.id);
          if (cached && cached.totalLocked > lockedCollateral) {
            const openDbPositionIds = new Set(openPositions.map(p => p.onChainPositionId).filter(Boolean));
            for (const cp of cached.positions) {
              if (cp.positionId && !openDbPositionIds.has(cp.positionId)) {
                const posCollateral = cp.collateral || (cp.size / (agent.leverage || 25));
                lockedCollateral += posCollateral;
                untrackedOnChainPositions.push({
                  positionId: cp.positionId,
                  side: cp.side,
                  size: cp.size,
                  collateral: posCollateral,
                  entryPrice: cp.entryPrice || 0,
                });
                if (liveSuiPrice > 0 && cp.entryPrice > 0) {
                  const rawPnl = cp.side === "long"
                    ? (liveSuiPrice - cp.entryPrice) * cp.size / liveSuiPrice
                    : (cp.entryPrice - liveSuiPrice) * cp.size / liveSuiPrice;
                  totalUnrealizedPnl += Math.max(-posCollateral, rawPnl);
                }
              }
            }
            console.log(`[Activity] Using cached on-chain positions for ${agent.name}: ${cached.positions.length} positions, locked=${lockedCollateral.toFixed(4)}`);
          }
        }
      }

      const pendingOrders = getPendingUnfilledOrdersForAgent(req.params.id);
      let chainUnfilledOrders: Array<{ orderId: string; collateral: number; side: string; isStopOrder: boolean }> = [];
      if (agent.walletAddress && pendingOrders.length === 0) {
        const cachedOrderScan = chainOrderScanCache.get(req.params.id);
        if (cachedOrderScan && Date.now() - cachedOrderScan.timestamp < CHAIN_ORDER_SCAN_CACHE_TTL) {
          chainUnfilledOrders = cachedOrderScan.orders.map(o => ({ orderId: o.orderId, collateral: o.collateral, side: o.direction, isStopOrder: o.isStopOrder }));
        } else {
          try {
            const adapter = getAdapter(agent.venue || "typus");
            if (adapter) {
              const { TypusAdapter } = await import("./dex/typus-adapter");
              if (adapter instanceof TypusAdapter) {
                const { created, unfilled } = await adapter.findAllUnfilledOrderIds(agent.walletAddress);
                for (const oid of unfilled) {
                  const info = created.get(oid);
                  if (info && !info.isReduceOnly && info.collateral > 0) {
                    chainUnfilledOrders.push({
                      orderId: oid,
                      collateral: info.collateral,
                      side: info.isLong ? "long" : "short",
                      isStopOrder: info.isStopOrder,
                    });
                  }
                }
                chainOrderScanCache.set(req.params.id, {
                  orders: chainUnfilledOrders.map(o => ({ orderId: o.orderId, collateral: o.collateral, direction: o.side, isStopOrder: o.isStopOrder })),
                  timestamp: Date.now(),
                });
              }
            }
          } catch {}
        }
      }
      const allPendingOrders = pendingOrders.length > 0
        ? pendingOrders.map(o => ({ orderId: o.orderId, collateral: o.collateral, direction: o.direction, ageSeconds: Math.round(o.age / 1000), isStopOrder: false }))
        : chainUnfilledOrders.map(o => ({ orderId: o.orderId, collateral: o.collateral, direction: o.side, ageSeconds: 0, isStopOrder: o.isStopOrder }));
      const pendingOrderCollateral = allPendingOrders.reduce((s, o) => s + o.collateral, 0);

      let onChainWalletSui = Math.max(0, agent.balance - lockedCollateral);
      if (agent.walletAddress) {
        const cachedBal = onChainBalanceCache.get(agent.id);
        if (cachedBal && Date.now() - cachedBal.timestamp < ONCHAIN_BALANCE_CACHE_TTL) {
          onChainWalletSui = cachedBal.sui;
        } else {
          try {
            const onChain = await getOnChainBalance(agent.walletAddress);
            onChainWalletSui = onChain.sui;
            onChainBalanceCache.set(agent.id, { sui: onChain.sui, timestamp: Date.now() });
          } catch (e) {
            if (cachedBal) {
              onChainWalletSui = cachedBal.sui;
            } else {
              onChainWalletSui = Math.max(0, agent.balance - lockedCollateral);
            }
          }
        }
      }

      const portfolioValue = onChainWalletSui + lockedCollateral + pendingOrderCollateral;

      let realizedGain = 0;
      let realizedLoss = 0;
      for (const pos of closedPositions) {
        if (pos.closeTxDigest === "cancelled_unfilled") continue;
        const pnl = pos.unrealizedPnl || 0;
        if (pnl > 0) realizedGain += pnl;
        else realizedLoss += pnl;
      }

      const allRewards = await storage.getRewards();
      const agentRewards = allRewards.filter(r => r.agentId === req.params.id && r.status !== "voided");
      const escrowedRewards = agentRewards.filter(r => r.status === "pending" && r.escrowTxDigest && r.escrowTxDigest !== "pending_escrow").reduce((s, r) => s + r.amount, 0);
      const pendingEscrowRewards = agentRewards.filter(r => r.status === "pending" && r.escrowTxDigest === "pending_escrow").reduce((s, r) => s + r.amount, 0);
      const claimedRewards = agentRewards.filter(r => r.status === "claimed").reduce((s, r) => s + r.amount, 0);
      const pendingRewards = escrowedRewards + pendingEscrowRewards;

      const rewardSharePct = agent.rewardSharePct ?? 50;
      const totalRealizedProfit = realizedGain;
      const totalRewardsAllocated = pendingRewards + claimedRewards;
      // Compute reinvestedAmount from actual closed positions (accurate regardless of retainedProfits DB state)
      const profitRetentionPct = agent.profitRetentionPct ?? 10;
      const reinvestedAmount = Math.min(
        closedPositions
          .filter(p => (p.unrealizedPnl || 0) > 0 && p.closeTxDigest !== "cancelled_unfilled")
          .reduce((sum, p) => sum + (p.unrealizedPnl || 0) * (profitRetentionPct / 100), 0),
        Math.max(0, onChainWalletSui)
      );

      let netDeposited = (agent.totalDeposited || 0) - (agent.protocolFeePaid || 0);
      let totalRealizedPnl = realizedGain + realizedLoss;
      const totalEscrowedRewards = pendingRewards + claimedRewards;

      const dbClosedVerified = closedPositions.length;
      const dbTradeCount = dbClosedVerified;
      let totalTrades = dbTradeCount;

      let chainDerived: ChainDerivedResult | null = null;
      let chainDerivedFresh = false;

      if (agent.walletAddress) {
        try {
          const cacheBeforeCall = chainDerivedCache.get(agent.id);
          const cds = await computeChainDerivedStats(agent);
          if (cds) {
            chainDerived = cds;
            const cacheAfterCall = chainDerivedCache.get(agent.id);
            chainDerivedFresh = !cacheBeforeCall || (cacheAfterCall !== undefined && cacheAfterCall.timestamp > (cacheBeforeCall?.timestamp || 0));
            if (cds.tradeCount > 0 || dbTradeCount === 0) {
              totalTrades = Math.max(dbTradeCount, cds.tradeCount); // never decrease below DB count
              realizedGain = cds.realizedGain;
              realizedLoss = cds.realizedLoss;
              totalRealizedPnl = cds.totalPnl;
            }
          }
        } catch (flowErr: any) {
          const staleCache = chainDerivedCache.get(agent.id);
          if (staleCache) {
            chainDerived = staleCache.result;
            console.log(`[Activity] Chain-derived stats computation failed: ${flowErr.message} — using stale cache (age=${Math.round((Date.now() - staleCache.timestamp) / 1000)}s)`);
            if (chainDerived.tradeCount > 0 || dbTradeCount === 0) {
              totalTrades = Math.max(dbTradeCount, chainDerived.tradeCount); // never decrease below DB count
              realizedGain = chainDerived.realizedGain;
              realizedLoss = chainDerived.realizedLoss;
              totalRealizedPnl = chainDerived.totalPnl;
            }
          } else {
            console.log(`[Activity] Chain-derived stats computation failed: ${flowErr.message} — no cache, falling back to DB position count (${dbTradeCount})`);
            totalTrades = dbTradeCount;
          }
        }
      }

      if (netDeposited < 0.001 && (onChainWalletSui > 0.001 || lockedCollateral > 0.001 || (chainDerived && chainDerived.tradeCount > 0))) {
        const gasForInference = chainDerived?.gasCosts || 0;
        const inferredDeposit = onChainWalletSui + lockedCollateral + pendingOrderCollateral
          + gasForInference + totalEscrowedRewards - totalRealizedPnl;
        if (inferredDeposit > 0.01) {
          netDeposited = Math.round(inferredDeposit * 10000) / 10000;
          const grossDeposit = netDeposited + (agent.protocolFeePaid || 0);
          console.log(`[Activity] Inferred netDeposited for ${agent.name}: ${netDeposited.toFixed(4)} SUI — persisting totalDeposited=${grossDeposit.toFixed(4)} to DB`);
          storage.updateAgent(agent.id, { totalDeposited: grossDeposit }).catch((err: any) => {
            console.log(`[Activity] Failed to persist inferred totalDeposited for ${agent.name}: ${err.message}`);
          });
        }
      }

      const totalGap = Math.max(0, netDeposited - onChainWalletSui - lockedCollateral - pendingOrderCollateral + totalRealizedPnl - totalEscrowedRewards);

      let estimatedGasTxCount = 0;
      const cachedGasTx = gasTxCountCache.get(agent.id);
      if (cachedGasTx && Date.now() - cachedGasTx.timestamp < GAS_TX_COUNT_CACHE_TTL) {
        estimatedGasTxCount = cachedGasTx.count;
      } else {
        try {
          const { suiClient: sc } = await import("./sui-verify");
          const txQuery = await sc.queryTransactionBlocks({
            filter: { FromAddress: agent.walletAddress },
            limit: 50,
            order: "descending" as any,
          });
          estimatedGasTxCount = txQuery?.data?.length || 0;
          gasTxCountCache.set(agent.id, { count: estimatedGasTxCount, timestamp: Date.now() });
        } catch {}
      }
      const maxReasonableGas = Math.max(0.05, estimatedGasTxCount * 0.012);
      const estimatedGas = chainDerived ? chainDerived.gasCosts : Math.min(totalGap, maxReasonableGas);
      const lostCollateral = chainDerived ? Math.max(0, Math.abs(chainDerived.realizedLoss)) : Math.max(0, totalGap - estimatedGas);

      const unrecoveredDetails: Array<{
        type: string;
        amount: number;
        positionId?: string;
        side?: string;
        size?: number;
        onChainId?: string;
        closeTxDigest?: string;
        location?: string;
        recoverable: boolean;
        action?: string;
      }> = [];

      if (lostCollateral > 0.01) {
        const FAKE_DIGESTS = ["closed_externally", "closed_external", "settled_onchain"];
        const forceSettled = closedPositions.filter(p =>
          p.closeTxDigest && FAKE_DIGESTS.includes(p.closeTxDigest)
        );

        if (forceSettled.length > 0 && agent.walletAddress) {
          try {
            const adapter = getAdapter(agent.venue || "typus");
            const openOnChain = adapter ? await adapter.getPositions(agent.walletAddress) : [];

            const matchedOnChainIds = new Set<string>();
            for (const pos of forceSettled) {
              const collateral = pos.collateral || (pos.sizeSui / agent.leverage);
              const posLoss = Math.abs(pos.unrealizedPnl || 0);
              const expectedReturn = Math.max(0, collateral - posLoss);

              if (expectedReturn < 0.01) continue;

              const onChainMatch = openOnChain.find((op: any) => {
                if (matchedOnChainIds.has(op.positionId)) return false;
                if (pos.onChainPositionId && !pos.onChainPositionId.includes("-") && op.positionId === pos.onChainPositionId) return true;
                return op.side === pos.side && Math.abs(op.size - pos.sizeSui) < 1;
              });
              if (onChainMatch) matchedOnChainIds.add(onChainMatch.positionId);

              if (onChainMatch) {
                unrecoveredDetails.push({
                  type: "on_typus",
                  amount: expectedReturn,
                  positionId: pos.id,
                  side: pos.side,
                  size: pos.sizeSui,
                  onChainId: onChainMatch.positionId,
                  closeTxDigest: pos.closeTxDigest || undefined,
                  location: "Typus DEX — position still open on-chain",
                  recoverable: true,
                  action: "Use Verify & Recover to reopen and close properly",
                });
              } else {
                unrecoveredDetails.push({
                  type: "force_settled",
                  amount: expectedReturn,
                  positionId: pos.id,
                  side: pos.side,
                  size: pos.sizeSui,
                  onChainId: pos.onChainPositionId || undefined,
                  closeTxDigest: pos.closeTxDigest || undefined,
                  location: "Position was force-settled — collateral may have been returned or consumed by Typus",
                  recoverable: false,
                  action: "Check SUI Flow for detailed transaction history",
                });
              }
            }
          } catch (detailErr: any) {
            console.log(`[Activity] Unrecovered detail check failed: ${detailErr.message}`);
          }
        }

        if (unrecoveredDetails.length === 0 && lostCollateral > 0.01) {
          unrecoveredDetails.push({
            type: "unknown",
            amount: lostCollateral,
            location: "Unaccounted — check SUI Flow page for full transaction trace",
            recoverable: false,
            action: "Use SUI Flow page to trace all transactions",
          });
        }
      }

      // Always use DB-derived win rate (from actual closed positions) — more reliable than chain scan
      // which can miss trades beyond the 250-tx scan window
      const effectiveWinRate = liveWinRate;

      if (chainDerived && chainDerived.tradeCount > 0 && chainDerivedFresh) {
        const lastCorrected = autoCorrectionLastApplied.get(agent.id) || 0;
        const cooldownElapsed = Date.now() - lastCorrected >= AUTO_CORRECTION_COOLDOWN;

        const portfolioPnl = (portfolioValue + claimedRewards) - netDeposited;
        const dbPnl = agent.totalPnl || 0;
        const pnlDrift = Math.abs(portfolioPnl - dbPnl);
        // Use liveWinRate (DB-based) and totalTrades (max of DB vs chain) for corrections
        if (cooldownElapsed && (pnlDrift > 0.1 || agent.totalTrades !== totalTrades || Math.abs((agent.winRate || 0) - liveWinRate) > 0.05)) {
          try {
            await storage.updateAgent(agent.id, {
              totalPnl: portfolioPnl,
              totalTrades,
              winRate: liveWinRate,
            });
            autoCorrectionLastApplied.set(agent.id, Date.now());
            console.log(`[ActivitySync] Auto-corrected DB for ${agent.name}: totalPnl ${dbPnl.toFixed(4)} → ${portfolioPnl.toFixed(4)} (portfolio=${portfolioValue.toFixed(4)}+claimed=${claimedRewards.toFixed(4)}-net=${netDeposited.toFixed(4)}), trades ${agent.totalTrades} → ${totalTrades}, winRate ${(agent.winRate || 0).toFixed(2)} → ${liveWinRate.toFixed(2)}`);
            agent.totalPnl = portfolioPnl;
            agent.totalTrades = totalTrades;
            agent.winRate = liveWinRate;
          } catch (syncErr: any) {
            console.error(`[ActivitySync] Failed to sync DB for ${agent.name}:`, syncErr.message);
          }
        } else if (!cooldownElapsed) {
          console.log(`[ActivitySync] Skipping auto-correction for ${agent.name}: cooldown not elapsed (${Math.round((AUTO_CORRECTION_COOLDOWN - (Date.now() - lastCorrected)) / 1000)}s remaining)`);
        }

        const cancelledChainTrades = chainDerived.chainTrades.filter(t => t.outcome === "cancelled");
        if (cancelledChainTrades.length > 0) {
          const closedPositions = verifiedPositions.filter((p: any) => p.status === "closed");
          for (const ct of cancelledChainTrades) {
            const matchingPos = closedPositions.find((p: any) =>
              p.txDigest === ct.openDigest ||
              (p.typusOrderId && ct.openDigest && ct.openDigest.includes(p.typusOrderId))
            );
            if (matchingPos && (matchingPos.closeReason === "liquidated" || matchingPos.closeTxDigest === "position_gone_onchain")) {
              try {
                await storage.updatePosition(matchingPos.id, {
                  closeReason: "cancelled",
                  closeTxDigest: "cancelled_unfilled",
                });
                console.log(`[ActivitySync] Fixed false liquidation for ${agent.name} pos ${matchingPos.id}: closeReason liquidated → cancelled (chain shows unfilled order)`);
              } catch (fixErr: any) {
                console.log(`[ActivitySync] Failed to fix position ${matchingPos.id}: ${fixErr.message}`);
              }
            }
          }
        }
      }

      const preCorrectionDbPnlSum = closedPositions
        .filter((p: any) => p.closeTxDigest !== "cancelled_unfilled")
        .reduce((s: number, p: any) => s + (p.unrealizedPnl || 0), 0);

      const closedPosForPnlFix = verifiedPositions.filter((p: any) => p.status === "closed");
      const chainMatchedDigests = new Set<string>();

      if (chainDerived && chainDerived.chainTrades.length > 0) {
        for (const ct of chainDerived.chainTrades) {
          if (ct.outcome === "cancelled") continue;
          const matchPos = closedPosForPnlFix.find((p: any) =>
            p.txDigest === ct.openDigest || p.closeTxDigest === ct.closeDigest
          );
          if (matchPos) {
            chainMatchedDigests.add(matchPos.id);
            if (Math.abs((matchPos.unrealizedPnl || 0) - ct.pnlSui) > 0.05) {
              const posCollateral = matchPos.collateral || (matchPos.sizeSui / (agent.leverage || 36));
              const maxGain = posCollateral * Math.min((agent.leverage || 36) - 1, 10);
              const cappedChainPnl = Math.min(maxGain, Math.max(-posCollateral, ct.pnlSui));
              try {
                await storage.updatePosition(matchPos.id, { unrealizedPnl: cappedChainPnl });
                console.log(`[Activity] PnL corrected for ${agent.name} pos ${matchPos.id}: DB=${(matchPos.unrealizedPnl || 0).toFixed(4)} → chain=${cappedChainPnl.toFixed(4)} SUI`);
                matchPos.unrealizedPnl = cappedChainPnl;
              } catch (fixErr: any) {
                console.log(`[Activity] PnL correction failed for pos ${matchPos.id}: ${fixErr.message}`);
              }
            }
          }
        }
      }

      const settledPositions = closedPosForPnlFix.filter((p: any) =>
        p.closeTxDigest === "settled_onchain" && !chainMatchedDigests.has(p.id)
      );
      let didSettledCorrection = false;

      const correctedClosedPnl = closedPosForPnlFix
        .filter((p: any) => p.closeTxDigest !== "cancelled_unfilled")
        .reduce((s: number, p: any) => s + (p.unrealizedPnl || 0), 0);
      realizedGain = 0;
      realizedLoss = 0;
      for (const p of closedPosForPnlFix) {
        if ((p as any).closeTxDigest === "cancelled_unfilled") continue;
        const pnl = (p as any).unrealizedPnl || 0;
        if (pnl > 0) realizedGain += pnl;
        else realizedLoss += pnl;
      }
      totalRealizedPnl = correctedClosedPnl;

      const serverTotalPnl = correctedClosedPnl + totalUnrealizedPnl - estimatedGas;


      if (chainDerived && chainDerived.liquidations > 0) {
        const dbLiquidations = closedPositions.filter(
          (p: any) => p.closeReason === "liquidated"
        ).length;
        if (dbLiquidations < chainDerived.liquidations) {
          const liqChainTrades = chainDerived.chainTrades.filter(t => t.outcome === "liquidated");
          for (const liqTrade of liqChainTrades) {
            const misclassified = closedPositions.find((p: any) =>
              p.closeReason !== "liquidated" && (
                p.closeTxDigest === liqTrade.closeDigest ||
                p.txDigest === liqTrade.openDigest
              )
            );
            if (misclassified) {
              try {
                await storage.updatePosition(misclassified.id, { closeReason: "liquidated", closeTxDigest: liqTrade.closeDigest || misclassified.closeTxDigest });
                console.log(`[Activity] Corrected DB closeReason for ${agent.name} pos ${misclassified.id}: ${misclassified.closeReason} → liquidated (chain LiquidateEvent confirmed)`);
              } catch (fixErr: any) {
                console.log(`[Activity] Failed to fix position closeReason: ${fixErr.message}`);
              }
            }
          }
        }
      }

      res.json({
        agent: sanitizeAgent(agent),
        orders: verifiedOrders,
        positions: verifiedPositions,
        signals: agentSignals,
        reasoning: reasoning ? {
          signal: reasoning.signal,
          side: reasoning.side,
          reason: reasoning.reason,
          longScore: reasoning.longScore,
          shortScore: reasoning.shortScore,
          conditions: reasoning.conditions,
          indicators: reasoning.indicators,
        } : null,
        liveSuiPrice,
        portfolioValue,
        onChainWalletSui,
        lockedCollateral,
        pendingOrderCollateral,
        pendingOrders: allPendingOrders,
        totalUnrealizedPnl,
        liveWinRate: effectiveWinRate,
        realizedGain,
        realizedLoss,
        pendingRewards,
        claimedRewards,
        reinvestedAmount,
        gasCosts: estimatedGas,
        lostCollateral,
        unrecoveredDetails,
        untrackedOnChainPositions: untrackedOnChainPositions.length > 0 ? untrackedOnChainPositions : undefined,
        chainDerived,
        totalTrades,
        dbTradeCount,
        netDeposited,
        serverTotalPnl,
        retainedProfits: Math.min(agent.retainedProfits || 0, Math.max(0, onChainWalletSui)),
        profitRetentionPct: agent.profitRetentionPct ?? 10,
        settlementReceived,
        keeperOnChainSettlement,
        collateralDeployed,
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to get agent activity" });
    }
  });

  app.get("/api/venues", async (_req, res) => {
    try {
      const venues = getAdapterStatus();
      res.json(venues);
    } catch (e) {
      res.status(500).json({ message: "Failed to get venue status" });
    }
  });

  app.get("/api/venues/:venue/fees", async (req, res) => {
    try {
      const adapter = getAdapter(req.params.venue);
      if (!adapter) return res.status(404).json({ message: "Venue not found" });
      const fees = await adapter.estimateFees({
        agent: { balance: 100 } as any,
        symbol: "SUI-USDC",
        side: "long",
        leverage: 5,
        quantity: 1,
        price: 3.80,
      });
      res.json({ venue: adapter.venue, supported: adapter.supported, fees });
    } catch (e) {
      res.status(500).json({ message: "Failed to estimate fees" });
    }
  });

  app.post("/api/agents", async (req, res) => {
    try {
      const parsed = insertAgentSchema.parse(req.body);

      const minColl = parsed.minCollateral ?? 0.4;
      const maxColl = parsed.maxCollateral ?? 10;
      if (minColl < 0.2) {
        return res.status(400).json({ message: "Minimum collateral must be at least 0.2 SUI" });
      }
      if (maxColl < minColl) {
        return res.status(400).json({ message: "Maximum collateral must be greater than or equal to minimum collateral" });
      }

      if (parsed.userId && parsed.userId !== "default-user") {
        let user = await storage.getUserByWallet(parsed.userId);
        if (!user) {
          user = await storage.createUser({ walletAddress: parsed.userId });
        }
        parsed.userId = user.id;
      } else if (!parsed.userId) {
        const creatorWallet = req.body.creatorWallet as string | undefined;
        if (creatorWallet && creatorWallet.startsWith("0x")) {
          let user = await storage.getUserByWallet(creatorWallet);
          if (!user) {
            user = await storage.createUser({ walletAddress: creatorWallet });
          }
          parsed.userId = user.id;
        }
      }

      const wallet = generateAgentWallet();
      const agentWithSignal = await storage.createAgent({
        ...parsed,
        autoTrade: true,
      }, wallet);
      broadcast("agent:created", sanitizeAgent(agentWithSignal));
      res.status(201).json(sanitizeAgent(agentWithSignal));
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Invalid agent data" });
    }
  });

  app.post("/api/agents/register-wallet", async (req, res) => {
    try {
      const { name, walletAddress } = req.body;
      if (!name || !walletAddress || !walletAddress.startsWith("0x")) {
        return res.status(400).json({ message: "Name and valid wallet address (0x...) required" });
      }

      const existing = await storage.getAgentByWallet(walletAddress);
      if (existing) {
        return res.status(409).json({ message: `Wallet already registered as "${existing.name}"`, agent: sanitizeAgent(existing) });
      }

      const onChain = await getOnChainBalance(walletAddress);
      const agentWithSignal = await storage.createAgent({
        userId: "default-user",
        name,
        venue: "typus",
        leverage: 5,
        maxQty: 1,
        minCollateral: 0.4,
        maxCollateral: 10,
        stopLossBps: 80,
        rewardSharePct: 50,
        autoTrade: false,
        signalMode: "AUTO",
      }, { encryptedPrivateKey: "external_wallet", address: walletAddress });

      if (onChain.sui > 0) {
        await storage.updateAgent(agentWithSignal.id, { balance: onChain.sui });
      }

      console.log(`[register-wallet] Registered "${name}" (${walletAddress.slice(0, 10)}...) — on-chain: ${onChain.sui.toFixed(4)} SUI`);
      broadcast("agent:created", sanitizeAgent(agentWithSignal));
      res.status(201).json(sanitizeAgent(agentWithSignal));
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Registration failed" });
    }
  });

  app.patch("/api/agents/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const walletAddress = req.query.wallet as string || req.body.walletAddress || req.body.wallet;
      const updates = { ...req.body };
      delete updates.autoTrade;
      delete updates.walletAddress;
      delete updates.wallet;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required. Connect your wallet to modify agents." });
      }

      const existingAgent = await storage.getAgent(id);
      if (!existingAgent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === existingAgent.userId;
      const isCreator = existingAgent.walletAddress && existingAgent.walletAddress.toLowerCase() === walletAddress.toLowerCase();

      if (!isOwner && !isCreator) {
        return res.status(403).json({ message: "You can only modify agents you created." });
      }

      if (updates.signalMode !== undefined) {
        const validModes = ["AUTO", "AGGRESSIVE", "PRECISION"];
        if (!validModes.includes(updates.signalMode)) {
          return res.status(400).json({ message: `Invalid signal mode. Must be one of: ${validModes.join(", ")}` });
        }
        console.log(`[ModeToggle] ${existingAgent.name} (${id}): ${existingAgent.signalMode || "AUTO"} → ${updates.signalMode} by ${walletAddress}`);
      }

      if (updates.profitRetentionPct !== undefined) {
        const pct = Number(updates.profitRetentionPct);
        if (isNaN(pct) || pct < 0 || pct > 50) {
          return res.status(400).json({ message: "Profit retention must be between 0% and 50%" });
        }
        updates.profitRetentionPct = pct;
        console.log(`[Settings] ${existingAgent.name}: Profit retention ${existingAgent.profitRetentionPct ?? 10}% → ${pct}% by ${walletAddress}`);
      }

      if (updates.minCollateral !== undefined || updates.maxCollateral !== undefined) {
        const minColl = updates.minCollateral ?? existingAgent.minCollateral ?? 0.4;
        const maxColl = updates.maxCollateral ?? existingAgent.maxCollateral ?? 10;
        if (minColl < 0.2) {
          return res.status(400).json({ message: "Minimum collateral must be at least 0.2 SUI" });
        }
        if (maxColl < minColl) {
          return res.status(400).json({ message: "Maximum collateral must be >= minimum collateral" });
        }
      }

      const agent = await storage.updateAgent(id, updates);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }
      broadcast("agent:updated", sanitizeAgent(agent));
      res.json(sanitizeAgent(agent));
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Failed to update agent" });
    }
  });

  app.delete("/api/agents/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const walletAddress = req.query.wallet as string | undefined;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required. Connect your wallet to delete agents." });
      }

      const agent = await storage.getAgent(id);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === agent.userId;
      const isDefaultUser = agent.userId === "default-user" || !agent.userId;
      const isCreator = agent.walletAddress && agent.walletAddress.toLowerCase() === walletAddress.toLowerCase();

      if (!isOwner && !isCreator && !isDefaultUser) {
        return res.status(403).json({ message: "You can only delete agents you created." });
      }

      const forceDelete = req.query.force === "true";
      const openPositions = await storage.getOpenPositions(id);
      if (openPositions.length > 0) {
        const hasValidWallet = agent.agentWallet && agent.agentWallet.length > 50;

        const simPositions = openPositions.filter(p => !p.txDigest || p.txDigest.startsWith("sim_"));
        const realPositions = openPositions.filter(p => p.txDigest && !p.txDigest.startsWith("sim_"));

        for (const simPos of simPositions) {
          console.log(`[Delete] Force-closing simulation position ${simPos.id} for ${agent.name} (txDigest=${simPos.txDigest || "null"})`);
          await storage.updatePosition(simPos.id, { status: "closed", closeReason: "force_deleted_simulation" });
        }

        if (realPositions.length > 0 && !forceDelete) {
          if (!hasValidWallet) {
            console.log(`[Delete] No valid wallet for ${agent.name} — force-closing ${realPositions.length} positions in DB`);
            for (const pos of realPositions) {
              await storage.updatePosition(pos.id, { status: "closed", closeReason: "force_deleted_no_wallet" });
            }
          } else {
            const { getLastPrice } = await import("./price-service");
            const priceTick = getLastPrice();
            const currentPrice = priceTick?.pyth?.price ?? priceTick?.blended ?? 0;

            if (currentPrice > 0) {
              await storage.updateAgent(id, { status: "paused" });
              console.log(`[Delete] Paused agent ${agent.name} before closing ${realPositions.length} open positions on-chain...`);

              const freshAgent = await storage.getAgent(id);
              const agentForClose = freshAgent || agent;

              const failedCloses: string[] = [];
              for (const pos of realPositions) {
                try {
                  const result = await closePositionForAgent(agentForClose, pos.id, currentPrice, false, "agent-deletion");
                  if (result.closed) {
                    console.log(`[Delete] Closed position ${pos.onChainPositionId || pos.id} on-chain: PnL=${result.pnl?.toFixed(4)}, tx=${result.txDigest || "none"}`);
                  } else {
                    console.log(`[Delete] Failed to close position ${pos.onChainPositionId || pos.id} on-chain: ${result.error}. Force-closing in DB.`);
                    await storage.updatePosition(pos.id, { status: "closed", closeReason: "force_deleted_close_failed" });
                  }
                } catch (closeErr: any) {
                  console.log(`[Delete] Error closing position ${pos.onChainPositionId || pos.id}: ${closeErr.message}. Force-closing in DB.`);
                  await storage.updatePosition(pos.id, { status: "closed", closeReason: "force_deleted_error" });
                }
              }
            } else {
              console.log(`[Delete] No market price for ${agent.name} — force-closing ${realPositions.length} positions in DB`);
              for (const pos of realPositions) {
                await storage.updatePosition(pos.id, { status: "closed", closeReason: "force_deleted_no_price" });
              }
            }
          }
        } else if (realPositions.length > 0 && forceDelete) {
          console.log(`[Delete] Force-delete requested for ${agent.name} — closing ${realPositions.length} positions in DB without on-chain close`);
          for (const pos of realPositions) {
            await storage.updatePosition(pos.id, { status: "closed", closeReason: "force_deleted_by_owner" });
          }
        }
      }

      if (agent.status === "running") {
        await storage.updateAgent(id, { status: "idle" });
      }

      const deleted = await storage.deleteAgent(id);
      if (!deleted) {
        return res.status(404).json({ message: "Agent not found" });
      }
      broadcast("agent:deleted", { id });
      res.json({ message: "Agent deleted" });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to delete agent" });
    }
  });

  app.post("/api/agents/:id/clone", async (req, res) => {
    try {
      const { id } = req.params;
      const { walletAddress, name } = req.body;

      if (!walletAddress || typeof walletAddress !== "string" || !walletAddress.startsWith("0x")) {
        return res.status(401).json({ message: "Connect your SUI wallet to clone an agent." });
      }

      const parentAgent = await storage.getAgent(id);
      if (!parentAgent) {
        return res.status(404).json({ message: "Parent agent not found" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === parentAgent.userId;
      if (!isOwner) {
        return res.status(403).json({ message: "Only the agent owner can clone their strategy." });
      }

      const cloneName = name || `${parentAgent.name} (Clone)`;

      const cloneData = {
        userId: parentAgent.userId,
        name: cloneName,
        venue: parentAgent.venue,
        leverage: parentAgent.leverage,
        maxQty: parentAgent.maxQty,
        stopLossBps: parentAgent.stopLossBps,
        takeProfitBps: parentAgent.takeProfitBps,
        autoTrade: parentAgent.autoTrade,
        rewardSharePct: parentAgent.rewardSharePct,
      };

      const cloneWallet = generateAgentWallet();
      const cloneAgent = await storage.createAgent(cloneData, cloneWallet);

      await storage.updateAgent(cloneAgent.id, {
        isClone: true,
        parentAgentId: parentAgent.id,
      });

      const updated = await storage.getAgentWithSignalAgent(cloneAgent.id);
      broadcast("agent:created", sanitizeAgent(updated));

      res.json({
        success: true,
        agent: sanitizeAgent(updated),
        parentAgent: { id: parentAgent.id, name: parentAgent.name },
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to clone agent" });
    }
  });

  app.post("/api/agents/:id/deposit", async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, txDigest, sender } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid deposit amount" });
      }
      if (!txDigest) {
        return res.status(400).json({ message: "Transaction digest required. Deposits must be verified on-chain." });
      }

      const existingAgent = await storage.getAgent(id);
      if (!existingAgent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      if (!existingAgent.walletAddress) {
        return res.status(400).json({ message: "Agent wallet address not configured" });
      }

      let verifiedCheckpoint: number | undefined;
      let verifiedSender: string | undefined;

      const protocolFee = amount * PROTOCOL_FEE_RATE;
      const netAmount = amount - protocolFee;
      const expectedAgentMist = BigInt(Math.floor(netAmount * 1e9));
      const expectedFeeMist = BigInt(Math.floor(protocolFee * 1e9));

      try {
        const result = await verifyTxDigest(txDigest);
        verifiedCheckpoint = result.checkpoint;
        verifiedSender = result.sender;

        if (!verifiedSender) {
          return res.status(400).json({ message: "Could not determine transaction sender from on-chain data" });
        }

        if (sender && verifiedSender !== sender) {
          return res.status(400).json({ message: "Transaction sender does not match your wallet address" });
        }

        const transferCheck = verifyDepositTransfers(result.balanceChanges, {
          agentWalletAddress: existingAgent.walletAddress,
          protocolFeeAddress: PROTOCOL_FEE_ADDRESS,
          expectedAgentMist,
          expectedFeeMist,
          sender: verifiedSender,
        });

        if (!transferCheck.valid) {
          return res.status(400).json({
            message: `On-chain transfer verification failed: ${transferCheck.reason}`,
          });
        }
      } catch (e: any) {
        const msg = e.message || String(e);
        const is429 = msg.includes("429") || msg.includes("rate limit") || msg.includes("overloaded");
        if (is429) {
          return res.status(503).json({
            message: "RPC is temporarily overloaded. Your transaction was sent on-chain successfully — please wait a minute and try again. Your balance will update automatically.",
          });
        }
        return res.status(400).json({ message: `Transaction verification failed: ${msg}` });
      }

      const agent = await storage.depositToAgent(id, netAmount, txDigest, verifiedCheckpoint);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      await storage.createDeposit({
        agentId: id,
        depositorAddress: verifiedSender || sender || "",
        amount: netAmount,
        grossAmount: amount,
        protocolFee,
        txDigest: txDigest || null,
        verified: true,
        checkpoint: verifiedCheckpoint ?? null,
      }).catch(() => {});

      if (verifiedSender) {
        await storage.createVerifiedTransaction({
          txDigest,
          txType: "deposit",
          agentId: id,
          userId: sender || verifiedSender,
          sender: verifiedSender,
          checkpoint: verifiedCheckpoint ?? null,
          rawData: { amount, protocolFee, netAmount },
        }).catch(() => {});
      }

      onChainPortfolioCache.delete(id);

      broadcast("agent:updated", sanitizeAgent(agent));
      res.json({
        agent: sanitizeAgent(agent),
        deposit: {
          grossAmount: amount,
          protocolFee,
          protocolFeeRate: PROTOCOL_FEE_RATE,
          protocolFeeAddress: PROTOCOL_FEE_ADDRESS,
          netAmount,
          txDigest,
          verified: true,
          checkpoint: verifiedCheckpoint || null,
          sender: verifiedSender || null,
        },
      });
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Failed to deposit" });
    }
  });

  app.post("/api/agents/:id/gas-topoff", async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, txDigest, sender } = req.body;
      if (!amount || amount <= 0 || amount > 5) {
        return res.status(400).json({ message: "Gas top-off amount must be between 0 and 5 SUI" });
      }
      if (!txDigest) {
        return res.status(400).json({ message: "Transaction digest required" });
      }

      const existingAgent = await storage.getAgent(id);
      if (!existingAgent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      let verifiedSender: string | undefined;
      let verifiedCheckpoint: number | undefined;
      let verificationFailed = false;

      const MAX_VERIFY_RETRIES = 3;
      const VERIFY_RETRY_DELAY = 2000;
      for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
        try {
          const result = await verifyTxDigest(txDigest);
          verifiedCheckpoint = result.checkpoint;
          verifiedSender = result.sender;
          break;
        } catch (e: any) {
          const msg = e.message || String(e);
          const is429 = msg.includes("429") || msg.includes("rate limit") || msg.includes("Too Many");
          if (is429 && attempt < MAX_VERIFY_RETRIES) {
            await new Promise(r => setTimeout(r, VERIFY_RETRY_DELAY));
            continue;
          }
          if (is429) {
            console.log(`[GasTopOff] TX verification failed after ${MAX_VERIFY_RETRIES} retries (429) — recording deposit with frontend-provided sender`);
            verifiedSender = sender;
            verificationFailed = true;
            break;
          }
          return res.status(400).json({ message: `Transaction verification failed: ${msg}` });
        }
      }

      if (verifiedSender && sender && verifiedSender !== sender && !verificationFailed) {
        return res.status(400).json({ message: "Transaction sender does not match your wallet" });
      }

      const agent = await storage.depositToAgent(id, amount, txDigest, verifiedCheckpoint);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      await storage.createDeposit({
        agentId: id,
        depositorAddress: verifiedSender || sender || "",
        amount,
        grossAmount: amount,
        protocolFee: 0,
        txDigest: txDigest || null,
        verified: !verificationFailed && !!verifiedSender,
        checkpoint: verifiedCheckpoint ?? null,
      }).catch(() => {});

      if (verifiedSender) {
        await storage.createVerifiedTransaction({
          txDigest,
          txType: "gas-topoff",
          agentId: id,
          userId: sender || verifiedSender,
          sender: verifiedSender,
          checkpoint: verifiedCheckpoint ?? null,
          rawData: { amount, type: "gas-topoff" },
        }).catch(() => {});
      }

      if (agent.status === "paused" && (agent.lastExecutionError?.includes("INSUFFICIENT_GAS") || agent.lastExecutionError?.includes("GAS_BUDGET_EXHAUSTED") || agent.lastExecutionError?.includes("GAS_CAP_BREACHED"))) {
        await storage.updateAgent(id, {
          status: "running",
          lastExecutionError: null,
          lastExecutionAt: new Date(),
          pausedBy: null,
          pausedReason: null,
          estimatedResumeAt: null,
          gasThrottleLevel: null,
        });
        const onChainBal = await getOnChainBalance(existingAgent.agentWallet).catch(() => null);
        const budgetBasis = onChainBal ?? amount;
        registerTopoffResume(id, budgetBasis);
        console.log(`[GasTopOff] Auto-resumed ${existingAgent.name} after gas top-off of ${amount} SUI — 60s recovery cooldown + session budget ${(budgetBasis * 0.6).toFixed(3)} SUI set (basis: ${budgetBasis.toFixed(4)}, source: ${onChainBal !== null ? 'on-chain' : 'topoff-amount'})`);
      }

      onChainPortfolioCache.delete(id);

      broadcast("agent:updated", sanitizeAgent(agent));
      console.log(`[GasTopOff] ${existingAgent.name} received ${amount} SUI gas top-off from ${sender || verifiedSender || "unknown"}`);

      res.json({
        agent: sanitizeAgent(agent),
        topoff: { amount, txDigest, verified: !!verifiedSender },
      });
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Failed to process gas top-off" });
    }
  });

  app.post("/api/agents/:id/withdraw", async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, toAddress, authTxDigest } = req.body;

      if (!authTxDigest || typeof authTxDigest !== "string") {
        return res.status(400).json({ message: "Wallet authorization transaction required. Please approve the transaction in your wallet." });
      }

      if (!toAddress || typeof toAddress !== "string" || !toAddress.startsWith("0x")) {
        return res.status(400).json({ message: "Valid SUI wallet address required" });
      }

      const authResult = await verifyTxDigest(authTxDigest);
      if (!authResult.sender || authResult.sender.toLowerCase() !== toAddress.toLowerCase()) {
        return res.status(403).json({ message: "Authorization transaction sender does not match the withdrawal address. Sign from the correct wallet." });
      }

      const agent = await storage.getAgent(id);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      if (agent.status === "recovered") {
        return res.status(400).json({ message: "Cannot withdraw from a recovered agent - the original signing keys were lost during database reset. The collateral remains on-chain but cannot be moved without the original private key." });
      }

      const user = await storage.getUserByWallet(toAddress);
      const isCreator = user && user.id === agent.userId;
      const agentDeposits = await storage.getDepositsByAgent(id);
      const isDepositor = agentDeposits.some(d => d.depositorAddress.toLowerCase() === toAddress.toLowerCase());
      if (!isCreator && !isDepositor) {
        return res.status(403).json({ message: "Only the agent creator or a depositor can withdraw." });
      }

      if (!agent.agentWallet || !agent.walletAddress) {
        return res.status(400).json({ message: "Agent wallet not configured" });
      }

      const parsedAmount = amount !== undefined && amount !== null ? Number(amount) : null;
      if (parsedAmount !== null && (isNaN(parsedAmount) || parsedAmount <= 0)) {
        return res.status(400).json({ message: "Amount must be a positive number" });
      }

      const onChainBalance = await getOnChainBalance(agent.walletAddress);
      const gasBudget = BigInt(10_000_000);
      const maxOnChainWithdraw = Math.max(0, (Number(onChainBalance.mist) - Number(gasBudget)) / 1e9);

      let withdrawAmount: number;
      if (parsedAmount && parsedAmount > 0) {
        withdrawAmount = parsedAmount;
      } else if (agent.balance > 0) {
        withdrawAmount = agent.balance;
      } else if (maxOnChainWithdraw > 0.001) {
        withdrawAmount = maxOnChainWithdraw;
      } else {
        return res.status(400).json({ message: "No balance available to withdraw" });
      }

      if (withdrawAmount > maxOnChainWithdraw) {
        return res.status(400).json({
          message: `Insufficient on-chain balance. Agent wallet has ${onChainBalance.sui.toFixed(4)} SUI on-chain (${maxOnChainWithdraw.toFixed(4)} withdrawable after gas).`,
        });
      }

      const withdrawMist = BigInt(Math.floor(withdrawAmount * 1e9));

      const { decryptKeypair } = await import("./dex/wallet-manager");
      const { Transaction } = await import("@mysten/sui/transactions");
      const { withWalletLock } = await import("./dex/tx-queue");
      const keypair = decryptKeypair(agent.agentWallet);

      const maxRetries = 3;
      let result: any = null;
      let lastError: string = "";

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          result = await withWalletLock(agent.walletAddress, async () => {
            if (attempt > 0) {
              await new Promise(r => setTimeout(r, 1500));
            }
            const tx = new Transaction();
            tx.setSender(agent.walletAddress);
            tx.setGasBudget(gasBudget);
            const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(withdrawMist)]);
            tx.transferObjects([coin], toAddress);

            const { suiClient: sc } = await import("./sui-verify");
            return sc.signAndExecuteTransaction({
              transaction: tx,
              signer: keypair,
              options: { showEffects: true },
            });
          });
          if (result.effects?.status?.status === "success") break;
          lastError = "Transaction status: " + (result.effects?.status?.status || "unknown");
        } catch (err: any) {
          lastError = err.message || String(err);
          console.log(`[Withdraw] Attempt ${attempt + 1}/${maxRetries} failed: ${lastError.slice(0, 200)}`);
          if (attempt < maxRetries - 1) continue;
        }
      }

      if (!result || result.effects?.status?.status !== "success") {
        return res.status(500).json({ message: `Withdrawal failed after ${maxRetries} attempts: ${lastError.slice(0, 300)}` });
      }

      await storage.updateAgent(id, {
        balance: Math.max(0, agent.balance - withdrawAmount),
      });

      await storage.createVerifiedTransaction({
        txDigest: result.digest,
        txType: "withdraw",
        agentId: id,
        userId: agent.userId,
        sender: agent.walletAddress,
        checkpoint: null,
        rawData: { amount: withdrawAmount, toAddress, authTxDigest },
      }).catch(() => {});

      onChainPortfolioCache.delete(id);

      broadcast("agent:updated", sanitizeAgent(await storage.getAgent(id)));

      res.json({
        txDigest: result.digest,
        amount: withdrawAmount,
        toAddress,
        remainingBalance: Math.max(0, agent.balance - withdrawAmount),
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to withdraw" });
    }
  });

  app.get("/api/agents/:id/on-chain-balance", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      if (!agent.walletAddress) return res.status(400).json({ message: "Agent wallet not configured" });

      const onChain = await getOnChainBalance(agent.walletAddress);
      res.json({
        walletAddress: agent.walletAddress,
        onChainSui: onChain.sui,
        onChainMist: onChain.mist,
        dbBalance: agent.balance,
        mismatch: Math.abs(onChain.sui - agent.balance) > 0.001,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to get on-chain balance" });
    }
  });

  app.post("/api/agents/:id/sync-balance", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      if (!agent.walletAddress) return res.status(400).json({ message: "Agent wallet not configured" });

      const onChain = await getOnChainBalance(agent.walletAddress);

      const positions = await storage.getPositions(agent.id);
      const openPositions = positions.filter(p => (p.status === "open" || p.status === "pending_open"));
      let lockedCollateral = 0;
      for (const pos of openPositions) {
        lockedCollateral += pos.collateral || (pos.sizeSui / agent.leverage);
      }

      const correctedBalance = onChain.sui + lockedCollateral;
      const diff = correctedBalance - agent.balance;

      if (Math.abs(correctedBalance - agent.balance) < 0.001) {
        return res.json({ synced: false, message: "Balances already match", dbBalance: agent.balance, onChainSui: onChain.sui, lockedCollateral });
      }

      const updated = await storage.updateAgent(agent.id, { balance: correctedBalance });

      broadcast("agent:updated", sanitizeAgent(updated));
      res.json({ synced: true, previousBalance: agent.balance, newBalance: correctedBalance, onChainSui: onChain.sui, lockedCollateral, diff });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to sync balance" });
    }
  });

  app.post("/api/agents/:id/resume", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });

      const walletAddress = req.query.wallet as string || req.body.walletAddress;
      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required." });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === agent.userId;
      const isCreator = agent.walletAddress && agent.walletAddress.toLowerCase() === walletAddress.toLowerCase();
      if (!isOwner && !isCreator) {
        return res.status(403).json({ message: "Only the agent owner can resume it." });
      }

      if (agent.status === "running") {
        return res.json({ message: "Agent is already running", agent: sanitizeAgent(agent) });
      }

      resetGasSpendTracking(agent.id);
      registerTopoffResume(agent.id);

      const adapter = getAdapter(agent.venue || "typus");
      if (adapter && typeof (adapter as any).resetCircuitBreaker === "function") {
        (adapter as any).resetCircuitBreaker(agent.id);
      }
      if (adapter && typeof (adapter as any).clearPhantomCache === "function") {
        (adapter as any).clearPhantomCache(agent.walletAddress);
      }

      const updated = await storage.updateAgent(agent.id, {
        status: "running",
        lastExecutionError: null,
        pausedBy: null,
        pausedReason: null,
        estimatedResumeAt: null,
        gasThrottleLevel: null,
      });
      broadcast("agent:updated", sanitizeAgent(updated));
      res.json({ message: "Agent resumed", agent: sanitizeAgent(updated) });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to resume agent" });
    }
  });

  app.post("/api/agents/:id/recalculate-stats", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });

      const allPositions = await storage.getPositions(agent.id);
      const validPositions = allPositions.filter(p =>
        p.closeReason !== "deleted_bogus_recovery" &&
        !p.txDigest?.startsWith("sim_")
      );
      const closedPositions = validPositions.filter(p =>
        p.status === "closed" && p.closeReason !== "cancelled"
      );
      const openPositions = validPositions.filter(p => (p.status === "open" || p.status === "pending_open"));

      let onChainSui: number;
      if (agent.walletAddress) {
        try {
          const onChain = await getOnChainBalance(agent.walletAddress);
          onChainSui = onChain.sui;
        } catch (e: any) {
          return res.status(503).json({ message: "On-chain balance unavailable — please retry" });
        }
      } else {
        return res.status(400).json({ message: "Agent has no wallet address" });
      }

      const lockedCollateral = openPositions.reduce((sum, p) => sum + (p.collateral || p.sizeSui / agent.leverage), 0);
      const onChainTotal = onChainSui + lockedCollateral;

      const netDeposited = (agent.totalDeposited || 0) - (agent.protocolFeePaid || 0);
      const onChainDerivedPnl = onChainTotal - netDeposited;

      let recalcPnl = 0;
      let wins = 0;
      for (const pos of closedPositions) {
        const collateral = pos.collateral || (pos.sizeSui / agent.leverage);
        const cappedPnl = Math.max(-(collateral), pos.unrealizedPnl || 0);
        recalcPnl += cappedPnl;
        if (cappedPnl > 0) wins++;
      }

      const totalTrades = closedPositions.length + openPositions.length;
      const winRate = closedPositions.length > 0 ? wins / closedPositions.length : 0;

      const newBalance = onChainTotal;

      console.log(`[Recalc] ${agent.name}: onChain=${onChainSui.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, total=${onChainTotal.toFixed(4)}, netDeposited=${netDeposited.toFixed(4)}, dbPnl=${recalcPnl.toFixed(4)}, onChainPnl=${onChainDerivedPnl.toFixed(4)}`);

      const updated = await storage.updateAgent(agent.id, {
        totalPnl: onChainDerivedPnl,
        totalTrades,
        winRate,
        balance: newBalance,
      });

      broadcast("agent:updated", sanitizeAgent(updated));
      res.json({
        recalculated: true,
        closedPositions: closedPositions.length,
        openPositions: openPositions.length,
        totalTrades,
        totalPnl: onChainDerivedPnl,
        winRate,
        newBalance,
        previousPnl: agent.totalPnl,
        previousTrades: agent.totalTrades,
        onChainSui,
        lockedCollateral,
        netDeposited,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to recalculate" });
    }
  });

  app.post("/api/agents/:id/recover-orphaned-orders", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      if (!agent.agentWallet) return res.status(400).json({ message: "Agent has no wallet" });

      const adapter = getAdapter(agent.venue || "typus");
      if (!adapter || typeof (adapter as any).scanAndRecoverOrphanedOrders !== "function") {
        return res.status(400).json({ message: "Recovery not supported for this venue" });
      }

      let positionsResolved = 0;
      let forceSettledReopened = 0;
      const positions = await storage.getPositions(agent.id);

      const forceSettled = positions.filter(p =>
        p.status === "closed" && p.closeTxDigest === "settled_onchain" &&
        p.txDigest && !p.txDigest.startsWith("sim_")
      );
      if (forceSettled.length > 0 && agent.walletAddress) {
        const openOnChain = await adapter.getPositions(agent.walletAddress);
        console.log(`[Recovery] ${agent.name}: ${forceSettled.length} force-settled positions, ${openOnChain.length} open on-chain positions`);

        for (const pos of forceSettled) {
          try {
            let onChainMatch = openOnChain.find((op: any) =>
              pos.onChainPositionId && !pos.onChainPositionId.includes("-") &&
              op.positionId === pos.onChainPositionId
            );

            if (!onChainMatch) {
              const { TypusAdapter: TA } = await import("./dex/typus-adapter");
              const { SuiJsonRpcClient: SC } = await import("@mysten/sui/jsonRpc");
              const sc = new SC({ url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" });
              let resolvedId: string | null = null;
              if (pos.txDigest) {
                try {
                  const txData = await sc.getTransactionBlock({ digest: pos.txDigest, options: { showEvents: true } });
                  for (const evt of ((txData as any).events || [])) {
                    const p = (evt as any).parsedJson;
                    if (p && ((evt as any).type || "").includes("OrderFilledEvent") && p.new_position_id) {
                      resolvedId = String(p.new_position_id);
                      break;
                    }
                  }
                } catch {}
              }
              if (!resolvedId) {
                const oid = pos.onChainPositionId || pos.txDigest;
                if (oid) resolvedId = await TA.resolvePositionIdFromOrderId(sc as any, agent.walletAddress, oid);
              }
              if (resolvedId) {
                onChainMatch = openOnChain.find((op: any) => op.positionId === resolvedId) || { positionId: resolvedId } as any;
                await storage.updatePosition(pos.id, { onChainPositionId: resolvedId });
                console.log(`[Recovery] Resolved force-settled position ID: ${pos.id.slice(0, 8)} → ${resolvedId}`);
              } else {
                onChainMatch = openOnChain.find((op: any) => op.side === pos.side && Math.abs(op.size - pos.sizeSui) < 1);
                if (onChainMatch) {
                  await storage.updatePosition(pos.id, { onChainPositionId: onChainMatch.positionId });
                  console.log(`[Recovery] Matched force-settled position by side/size: ${pos.id.slice(0, 8)} → ${onChainMatch.positionId}`);
                }
              }
            }

            if (onChainMatch) {
              const allRewards = await storage.getRewards();
              if (pos.closedAt) {
                const closedTime = new Date(pos.closedAt).getTime();
                const posRewards = allRewards.filter(r =>
                  r.agentId === agent.id && r.status === "pending" && r.createdAt &&
                  Math.abs(new Date(r.createdAt).getTime() - closedTime) < 10000
                );
                for (const r of posRewards) {
                  await storage.voidReward(r.id);
                  console.log(`[Recovery] Voided reward ${r.id} (${r.amount} SUI) for reopened force-settled position`);
                }
              }

              await storage.updatePosition(pos.id, {
                status: "open",
                closeState: "open",
                markPrice: pos.entryPrice,
                unrealizedPnl: 0,
                closedAt: null,
                closeTxDigest: null,
                closeReason: null,
                verified: true,
              } as any);
              forceSettledReopened++;
              console.log(`[Recovery] REOPENED force-settled position ${pos.id.slice(0, 8)} for ${agent.name} (${pos.side} ${pos.sizeSui} SUI) — will be closed on-chain by position monitor`);
            } else {
              console.log(`[Recovery] Force-settled position ${pos.id.slice(0, 8)} not found on-chain — may have been closed/liquidated. Skipping reopen.`);
            }
          } catch (err: any) {
            console.log(`[Recovery] Force-settled recovery failed for ${pos.id.slice(0, 8)}: ${err.message}`);
          }
        }
      }

      const openWithoutId = positions.filter(p => (p.status === "open" || p.status === "pending_open") && (!p.onChainPositionId || p.onChainPositionId.includes("-")));
      if (openWithoutId.length > 0 && agent.walletAddress) {
        const { getThrottledSuiClient: getClient } = await import("./rpc-throttle");
        const client = getClient();
        const { TypusAdapter } = await import("./dex/typus-adapter");
        for (const pos of openWithoutId) {
          try {
            const orderId = pos.onChainPositionId || pos.txDigest;
            if (orderId) {
              const resolvedId = await TypusAdapter.resolvePositionIdFromOrderId(client as any, agent.walletAddress, orderId);
              if (resolvedId) {
                await storage.updatePosition(pos.id, { onChainPositionId: resolvedId });
                positionsResolved++;
                console.log(`[Recovery] Resolved position_id for ${agent.name}: ${pos.id.slice(0, 8)} → ${resolvedId}`);
                continue;
              }
            }
            const openOnChain = await adapter.getPositions(agent.walletAddress);
            if (openOnChain.length > 0) {
              const match = openOnChain.find((op: any) => op.side === pos.side && Math.abs(op.size - pos.sizeSui) < 1);
              if (match && match.positionId) {
                await storage.updatePosition(pos.id, { onChainPositionId: match.positionId });
                positionsResolved++;
                console.log(`[Recovery] Matched position by side/size for ${agent.name}: ${pos.id.slice(0, 8)} → ${match.positionId}`);
              }
            }
          } catch (resolveErr: any) {
            console.log(`[Recovery] Position resolution failed for ${pos.id.slice(0, 8)}: ${resolveErr.message}`);
          }
        }
      }

      const result = await (adapter as any).scanAndRecoverOrphanedOrders(agent.agentWallet, agent.id);

      const updated = await storage.getAgent(agent.id);
      if (updated) broadcast("agent:updated", sanitizeAgent(updated));

      if (forceSettledReopened > 0) {
        try {
          const onChain = await (await import("./sui-verify")).getOnChainBalance(agent.walletAddress!);
          const freshPositions = await storage.getPositions(agent.id);
          const lockedCollateral = freshPositions.filter(p => (p.status === "open" || p.status === "pending_open")).reduce((s, p) => s + (p.collateral || p.sizeSui / agent.leverage), 0);
          const correctedBalance = onChain.sui + lockedCollateral;
          await storage.updateAgent(agent.id, { balance: correctedBalance });
          console.log(`[Recovery] ${agent.name} balance recalculated after reopening ${forceSettledReopened} force-settled positions: ${correctedBalance.toFixed(4)} SUI`);
        } catch (balErr: any) {
          console.log(`[Recovery] Balance recalculation failed: ${balErr.message}`);
        }
      }

      res.json({
        success: true,
        agent: agent.name,
        positionsResolved,
        forceSettledReopened,
        ...result,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Recovery failed" });
    }
  });

  app.post("/api/agents/:id/recalculate-pnl", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      if (!agent.walletAddress) return res.status(400).json({ message: "Agent has no wallet" });

      const positions = await storage.getPositions(agent.id);
      const closedPositions = positions.filter(p => p.status === "closed");
      let corrected = 0;
      const corrections: Array<{ positionId: string; side: string; oldPnl: number; newPnl: number; reason: string }> = [];

      for (const pos of closedPositions) {
        const collateral = pos.collateral || (pos.sizeSui / agent.leverage);
        const storedPnl = pos.unrealizedPnl || 0;
        const exitPrice = pos.markPrice || 0;
        if (exitPrice <= 0 || pos.entryPrice <= 0) continue;

        const pricePnl = pos.side === "long"
          ? (exitPrice - pos.entryPrice) * pos.sizeSui / exitPrice
          : (pos.entryPrice - exitPrice) * pos.sizeSui / exitPrice;
        const maxGainRecalc = collateral * Math.min((agent.leverage || 36) - 1, 10);
        let correctPnl = Math.min(maxGainRecalc, Math.max(-collateral, pricePnl));

        const isSettledOnChain = pos.closeTxDigest === "settled_onchain";
        const isLiqOnChain = pos.closeTxDigest === "liquidated_onchain";
        let needsCorrection = false;
        let reason = "";

        if (isSettledOnChain && (storedPnl > 0) !== (correctPnl > 0)) {
          needsCorrection = true;
          reason = `settled_onchain PnL sign mismatch (gas costs corrupted PnL)`;
        } else if (isSettledOnChain && storedPnl <= -collateral * 0.85 && correctPnl > -collateral * 0.5) {
          needsCorrection = true;
          reason = `settled_onchain full loss but price says otherwise`;
        } else if (isLiqOnChain && (storedPnl > 0) !== (correctPnl > 0)) {
          needsCorrection = true;
          reason = `liquidated_onchain but price contradicts liquidation`;
        } else if (storedPnl < -collateral - 0.01) {
          needsCorrection = true;
          reason = `PnL exceeds collateral (loss)`;
        } else if (storedPnl > collateral * Math.min((agent.leverage || 36) - 1, 10) + 0.01) {
          needsCorrection = true;
          correctPnl = Math.min(collateral * Math.min((agent.leverage || 36) - 1, 10), correctPnl);
          reason = `PnL exceeds max gain cap`;
        }

        if (needsCorrection) {
          console.log(`[RecalcPnL] Agent ${agent.name} pos ${pos.id}: ${storedPnl.toFixed(4)} -> ${correctPnl.toFixed(4)} (${reason})`);
          await storage.updatePosition(pos.id, { unrealizedPnl: correctPnl });
          corrections.push({ positionId: pos.id.slice(0, 8), side: pos.side, oldPnl: storedPnl, newPnl: correctPnl, reason });
          corrected++;
        }
      }

      if (corrected > 0 && agent.walletAddress) {
        const onChain = await getOnChainBalance(agent.walletAddress);
        const openPos = positions.filter(p => (p.status === "open" || p.status === "pending_open"));
        const lockedCollateral = openPos.reduce((s, p) => s + (p.collateral || p.sizeSui / agent.leverage), 0);
        const onChainTotal = onChain.sui + lockedCollateral;

        const deposits = await storage.getDepositsByAgent(agent.id);
        const netDeposited = deposits.reduce((sum: number, d: any) => sum + (d.amount || 0), 0);
        const allRewards = await storage.getRewards();
        const agentRewards = allRewards.filter((r: any) => r.agentId === agent.id && r.status !== "voided");
        const totalRewardsPaid = agentRewards
          .filter((r: any) => r.escrowTxDigest || r.status === "claimed")
          .reduce((sum: number, r: any) => sum + r.amount, 0);
        const impliedTotalPnl = (onChainTotal + totalRewardsPaid) - netDeposited;

        const updatedPositions = await storage.getPositions(agent.id);
        const updatedClosed = updatedPositions.filter(p => p.status === "closed");
        const wins = updatedClosed.filter(p => (p.unrealizedPnl || 0) > 0).length;
        const winRate = updatedClosed.length > 0 ? wins / updatedClosed.length : 0;

        await storage.updateAgent(agent.id, {
          balance: onChainTotal,
          totalPnl: impliedTotalPnl,
          winRate,
        });

        console.log(`[RecalcPnL] Agent ${agent.name}: totalPnl corrected to ${impliedTotalPnl.toFixed(4)}, balance=${onChainTotal.toFixed(4)}`);
      }

      const updated = await storage.getAgent(agent.id);
      if (updated) broadcast("agent:updated", sanitizeAgent(updated));

      res.json({
        success: true,
        agent: agent.name,
        corrected,
        corrections,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Recalculation failed" });
    }
  });

  app.post("/api/agents/:id/refund", async (req, res) => {
    try {
      const { id } = req.params;
      const { toAddress, authTxDigest } = req.body;

      if (!authTxDigest || typeof authTxDigest !== "string") {
        return res.status(400).json({ message: "Wallet authorization transaction required." });
      }
      if (!toAddress || typeof toAddress !== "string" || !toAddress.startsWith("0x")) {
        return res.status(400).json({ message: "Valid SUI wallet address required" });
      }

      const authResult = await verifyTxDigest(authTxDigest);
      if (!authResult.sender || authResult.sender.toLowerCase() !== toAddress.toLowerCase()) {
        return res.status(403).json({ message: "Authorization transaction sender does not match your wallet." });
      }

      const agent = await storage.getAgent(id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      if (!agent.agentWallet || !agent.walletAddress) {
        return res.status(400).json({ message: "Agent wallet not configured" });
      }

      const user = await storage.getUserByWallet(toAddress);
      const isCreator = user && user.id === agent.userId;
      const agentDeposits = await storage.getDepositsByAgent(id);
      const isDepositor = agentDeposits.some(d => d.depositorAddress.toLowerCase() === toAddress.toLowerCase());
      if (!isCreator && !isDepositor) {
        return res.status(403).json({ message: "Only the agent creator or a depositor can request a refund." });
      }

      const onChainBalance = await getOnChainBalance(agent.walletAddress);
      const gasBudget = BigInt(2_000_000);
      const availableMist = BigInt(onChainBalance.mist) - gasBudget;

      if (availableMist <= BigInt(0)) {
        return res.status(400).json({ message: `No refundable balance. Agent wallet has ${onChainBalance.sui.toFixed(6)} SUI on-chain, which is less than the ~0.002 SUI gas fee needed to send a transaction.` });
      }

      const { decryptKeypair } = await import("./dex/wallet-manager");
      const { Transaction } = await import("@mysten/sui/transactions");
      const keypair = decryptKeypair(agent.agentWallet);

      const tx = new Transaction();
      tx.setSender(agent.walletAddress);
      tx.setGasBudget(gasBudget);
      const [coin] = tx.splitCoins(tx.gas, [availableMist]);
      tx.transferObjects([coin], toAddress);

      const { suiClient } = await import("./sui-verify");
      const result = await suiClient.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true },
      });

      if (result.effects?.status?.status !== "success") {
        return res.status(500).json({ message: "On-chain refund transaction failed" });
      }

      const refundedSui = Number(availableMist) / 1e9;

      await storage.updateAgent(id, { balance: 0 });

      await storage.createVerifiedTransaction({
        txDigest: result.digest,
        txType: "refund",
        agentId: id,
        userId: agent.userId,
        sender: agent.walletAddress,
        checkpoint: null,
        rawData: { amount: refundedSui, toAddress, authTxDigest, type: "full_refund" },
      }).catch(() => {});

      broadcast("agent:updated", sanitizeAgent(await storage.getAgent(id)));

      res.json({
        txDigest: result.digest,
        amount: refundedSui,
        toAddress,
        message: `Refunded ${refundedSui.toFixed(4)} SUI to ${toAddress}`,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to process refund" });
    }
  });

  app.post("/api/agents/:id/free-sui", async (req, res) => {
    try {
      const { id } = req.params;
      const walletAddress = req.query.wallet as string || req.body.walletAddress;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required" });
      }

      const agent = await storage.getAgent(id);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === agent.userId;
      if (!isOwner) {
        return res.status(403).json({ message: "Only the agent owner can free SUI." });
      }

      const lastPrice = getLastPrice();
      const currentPrice = lastPrice?.blended || 0;

      let closedCount = 0;
      let totalRealizedPnl = 0;
      let returnedCollateral = 0;

      const openPositions = (await storage.getPositions(id)).filter(p => p.status === "open" || p.status === "pending_open");
      if (openPositions.length > 0) {
        if (currentPrice <= 0) {
          return res.status(400).json({ message: "Cannot determine current market price to close positions" });
        }
        const result = await closeAllPositionsForAgent(agent, currentPrice, true);
        closedCount = result.closed;
        totalRealizedPnl = result.totalPnl;
        returnedCollateral = result.returnedCollateral;
      }

      await storage.updateAgent(id, { status: "idle" });
      const updatedAgent = await storage.getAgent(id);
      broadcast("agent:updated", sanitizeAgent(updatedAgent));

      res.json({
        success: true,
        closedPositions: closedCount,
        totalRealizedPnl,
        returnedCollateral,
        agentStatus: "idle",
        balance: updatedAgent?.balance ?? 0,
        message: closedCount > 0
          ? `Closed ${closedCount} position(s) and stopped agent. Use Remove All to withdraw.`
          : `Agent stopped. Use Remove All to withdraw ${(updatedAgent?.balance ?? 0).toFixed(4)} SUI.`,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to free SUI" });
    }
  });

  app.post("/api/agents/:id/close-all-positions", async (req, res) => {
    try {
      const { id } = req.params;
      const walletAddress = req.query.wallet as string || req.body.walletAddress;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required" });
      }

      const agent = await storage.getAgent(id);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === agent.userId;
      const isCreator = agent.walletAddress && agent.walletAddress.toLowerCase() === walletAddress.toLowerCase();
      const agentDeposits = await storage.getDepositsByAgent(id);
      const isDepositor = agentDeposits.some(d => d.depositorAddress.toLowerCase() === walletAddress.toLowerCase());

      if (!isOwner && !isCreator && !isDepositor) {
        return res.status(403).json({ message: "Only the agent owner or depositor can close all positions." });
      }

      const openPositions = (await storage.getPositions(id)).filter(p => p.status === "open" || p.status === "pending_open");
      if (openPositions.length === 0) {
        return res.json({ success: true, closedPositions: 0, message: "No open positions to close." });
      }

      const lastPrice = getLastPrice();
      const currentPrice = lastPrice?.blended || 0;
      if (currentPrice <= 0) {
        return res.status(400).json({ message: "Cannot determine current market price to close positions" });
      }

      const result = await closeAllPositionsForAgent(agent, currentPrice, true);

      onChainPortfolioCache.delete(id);

      const updatedAgent = await storage.getAgent(id);
      broadcast("agent:updated", sanitizeAgent(updatedAgent));
      broadcast("positions:updated", { agentId: id });

      res.json({
        success: true,
        closedPositions: result.closed,
        totalRealizedPnl: result.totalPnl,
        returnedCollateral: result.returnedCollateral,
        message: result.closed > 0
          ? `Closed ${result.closed} position(s). Agent continues running.`
          : "Close orders submitted — positions will close when filled by the keeper.",
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to close all positions" });
    }
  });

  app.post("/api/agents/:id/remove-collateral", async (req, res) => {
    try {
      const { id } = req.params;
      const { toAddress, authTxDigest } = req.body;

      if (!authTxDigest || typeof authTxDigest !== "string") {
        return res.status(400).json({ message: "Wallet authorization transaction required. Please approve the transaction in your wallet." });
      }

      if (!toAddress || typeof toAddress !== "string" || !toAddress.startsWith("0x")) {
        return res.status(400).json({ message: "Valid SUI wallet address required" });
      }

      const authResult = await verifyTxDigest(authTxDigest);
      if (!authResult.sender || authResult.sender.toLowerCase() !== toAddress.toLowerCase()) {
        return res.status(403).json({ message: "Authorization transaction sender does not match your wallet address. Sign from the correct wallet." });
      }

      const agent = await storage.getAgent(id);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(toAddress);
      const isCreator = user && user.id === agent.userId;
      const agentDeposits = await storage.getDepositsByAgent(id);
      const isDepositor = agentDeposits.some(d => d.depositorAddress.toLowerCase() === toAddress.toLowerCase());
      if (!isCreator && !isDepositor) {
        return res.status(403).json({ message: "Only the agent creator or a depositor can withdraw collateral." });
      }

      const lastPrice = getLastPrice();
      const currentPrice = lastPrice?.blended || 0;
      if (currentPrice <= 0) {
        return res.status(400).json({ message: "Cannot determine current market price" });
      }

      let closedCount = 0;
      let totalRealizedPnl = 0;
      let returnedCollateral = 0;

      const openPositions = (await storage.getPositions(id)).filter(p => (p.status === "open" || p.status === "pending_open"));
      if (openPositions.length > 0) {
        const result = await closeAllPositionsForAgent(agent, currentPrice, true);
        closedCount = result.closed;
        totalRealizedPnl = result.totalPnl;
        returnedCollateral = result.returnedCollateral;
      }

      if (agent.status === "running") {
        await storage.updateAgent(id, { status: "idle" });
      }

      const updatedAgent = await storage.getAgent(id);
      if (!updatedAgent) {
        return res.status(500).json({ message: "Failed to retrieve updated agent" });
      }

      const withdrawBalance = updatedAgent.balance;
      let txDigest: string | null = null;

      if (updatedAgent.agentWallet && updatedAgent.walletAddress) {
        try {
          const onChainBalance = await getOnChainBalance(updatedAgent.walletAddress);
          const gasBudget = BigInt(10_000_000);
          const maxOnChainWithdraw = Math.max(0, (Number(onChainBalance.mist) - Number(gasBudget)) / 1e9);
          const actualWithdrawAmount = Math.min(
            Math.max(withdrawBalance, 0),
            maxOnChainWithdraw
          );
          const transferAmount = actualWithdrawAmount > 0.001 ? actualWithdrawAmount : maxOnChainWithdraw;

          if (transferAmount > 0.001) {
            const withdrawMist = BigInt(Math.floor(transferAmount * 1e9));
            const { decryptKeypair } = await import("./dex/wallet-manager");
            const { Transaction } = await import("@mysten/sui/transactions");
            const keypair = decryptKeypair(updatedAgent.agentWallet);

            const tx = new Transaction();
            tx.setSender(updatedAgent.walletAddress);
            tx.setGasBudget(gasBudget);
            const [coin] = tx.splitCoins(tx.gas, [withdrawMist]);
            tx.transferObjects([coin], toAddress);

            const { suiClient } = await import("./sui-verify");
            const result = await suiClient.signAndExecuteTransaction({
              transaction: tx,
              signer: keypair,
              options: { showEffects: true },
            });

            if (result.effects?.status?.status === "success") {
              txDigest = result.digest;
              const remainingBalance = Math.max(0, withdrawBalance - transferAmount);
              await storage.updateAgent(id, { balance: remainingBalance });
              console.log(`[RemoveCollateral] Transferred ${transferAmount.toFixed(4)} SUI to ${toAddress} for ${updatedAgent.name} (tx: ${result.digest}, remaining: ${remainingBalance.toFixed(4)})`);

              await storage.createVerifiedTransaction({
                txDigest: result.digest,
                txType: "remove_collateral",
                agentId: id,
                userId: updatedAgent.userId,
                sender: updatedAgent.walletAddress,
                checkpoint: null,
                rawData: { amount: transferAmount, toAddress, closedPositions: closedCount },
              }).catch(() => {});
            } else {
              console.error(`[RemoveCollateral] On-chain transfer failed for ${updatedAgent.name}, keeping balance intact`);
            }
          } else {
            console.log(`[RemoveCollateral] No withdrawable balance for ${updatedAgent.name} (on-chain: ${onChainBalance.sui.toFixed(4)} SUI, gas needed)`);
            if (onChainBalance.sui < 0.01) {
              await storage.updateAgent(id, { balance: 0 });
            }
          }
        } catch (withdrawErr: any) {
          console.error(`[RemoveCollateral] Withdraw error for ${updatedAgent.name}: ${withdrawErr.message}, keeping balance intact`);
        }
      } else if (withdrawBalance <= 0) {
        await storage.updateAgent(id, { balance: 0 });
      }

      const finalAgent = await storage.getAgent(id);
      broadcast("agent:updated", sanitizeAgent(finalAgent));

      const withdrawSucceeded = txDigest !== null;
      const finalBalance = (await storage.getAgent(id))?.balance ?? 0;

      res.json({
        success: true,
        closedPositions: closedCount,
        totalRealizedPnl,
        returnedCollateral,
        withdrawnAmount: withdrawSucceeded ? withdrawBalance : 0,
        txDigest,
        agentStatus: "idle",
        remainingBalance: finalBalance,
        withdrawFailed: !withdrawSucceeded && withdrawBalance > 0,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to remove collateral" });
    }
  });

  app.post("/api/agents/:id/close-position/:positionId", async (req, res) => {
    try {
      const { id, positionId } = req.params;
      const walletAddress = req.query.wallet as string || req.body.walletAddress;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required. Connect your wallet." });
      }

      const agent = await storage.getAgent(id);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === agent.userId;
      const isCreator = agent.walletAddress && agent.walletAddress.toLowerCase() === walletAddress.toLowerCase();
      const agentDeposits = await storage.getDepositsByAgent(id);
      const isDepositor = agentDeposits.some(d => d.depositorAddress.toLowerCase() === walletAddress.toLowerCase());

      if (!isOwner && !isCreator && !isDepositor) {
        return res.status(403).json({ message: "Only the agent owner or depositor can close positions." });
      }

      const lastPrice = getLastPrice();
      const currentPrice = lastPrice?.pyth?.price ?? lastPrice?.blended ?? 0;
      if (currentPrice <= 0) {
        return res.status(400).json({ message: "Cannot determine current market price. Try again shortly." });
      }

      const result = await closePositionForAgent(agent, positionId, currentPrice, false, "manual");

      onChainPortfolioCache.delete(id);

      if (!result.closed) {
        let errorMsg = "Position could not be closed on-chain. Please try again.";
        if (result.error?.includes("close_pending")) {
          errorMsg = "Close order submitted on-chain but awaiting Typus keeper fill. This usually completes within 30 seconds — the position will close automatically. Please wait and refresh.";
        } else if (result.error?.includes("INSUFFICIENT_GAS")) {
          errorMsg = "Insufficient gas in agent wallet to close position on-chain. Please deposit more SUI.";
        } else if (result.error?.includes("DRY_RUN_FAILED")) {
          errorMsg = "Close transaction simulation failed — the on-chain contract rejected this close. See chainError for details.";
        } else if (result.error?.includes("oracle")) {
          errorMsg = "Oracle price mismatch — please try again in a few seconds.";
        } else if (result.error?.includes("still on-chain")) {
          errorMsg = "Position exists on-chain but is missing tracking data. Please try again or contact support.";
        } else if (result.error?.includes("too_many_linked_orders")) {
          errorMsg = "Too many unfilled orders linked to this position on Typus. The system is cleaning them up — please try again in 30 seconds.";
        } else if (result.error?.includes("BLOCKED")) {
          errorMsg = result.error;
        } else if (result.error?.includes("close_confirmed_still_open")) {
          errorMsg = "Close transaction succeeded but the position is still visible on-chain. Will retry automatically.";
        }

        const pos = await storage.getPosition(positionId);
        return res.status(400).json({
          message: errorMsg,
          chainError: result.error || null,
          closeState: (pos as any)?.closeState || null,
          closeAttempts: (pos as any)?.closeAttempts || 0,
          positionId: pos?.onChainPositionId || null,
        });
      }

      const updatedAgent = await storage.getAgent(id);
      broadcast("agent:updated", sanitizeAgent(updatedAgent));

      res.json({
        success: true,
        onChain: result.onChain,
        pnl: result.pnl,
        txDigest: result.txDigest || null,
        closedAt: new Date().toISOString(),
        newBalance: updatedAgent?.balance ?? 0,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to close position" });
    }
  });

  app.post("/api/agents/:id/cancel-order/:orderId", async (req, res) => {
    try {
      const { id, orderId } = req.params;
      const walletAddress = req.query.wallet as string || req.body.walletAddress;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required. Connect your wallet." });
      }

      const agent = await storage.getAgent(id);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === agent.userId;
      const isCreator = agent.walletAddress && agent.walletAddress.toLowerCase() === walletAddress.toLowerCase();
      const agentDeposits = await storage.getDepositsByAgent(id);
      const isDepositor = agentDeposits.some(d => d.depositorAddress.toLowerCase() === walletAddress.toLowerCase());

      if (!isOwner && !isCreator && !isDepositor) {
        return res.status(403).json({ message: "Only the agent owner or depositor can cancel orders." });
      }

      if (!agent.agentWallet) {
        return res.status(400).json({ message: "Agent has no encrypted wallet for on-chain operations." });
      }

      const adapter = getAdapter(agent.venue || "typus");
      if (!adapter) {
        return res.status(400).json({ message: "No DEX adapter available." });
      }

      const { TypusAdapter } = await import("./dex/typus-adapter");
      if (!(adapter instanceof TypusAdapter)) {
        return res.status(400).json({ message: "Cancel is only supported for Typus." });
      }

      const result = await adapter.cancelUnfilledOrder(agent.agentWallet, orderId);
      if (result.cancelled) {
        const updatedAgent = await storage.getAgent(id);
        broadcast("agent:updated", sanitizeAgent(updatedAgent));
        res.json({ success: true, txDigest: result.txDigest, collateralReturned: result.collateralReturned });
      } else if (result.error === "order_not_found") {
        res.json({ success: true, alreadyGone: true, message: "Order no longer exists on Typus — it was already filled by the keeper, cancelled, or expired. Collateral has been returned or consumed." });
      } else if (result.error && (result.error.includes("429") || result.error.includes("rate limit"))) {
        res.status(429).json({ message: "SUI RPC rate limited. Please wait a moment and try again." });
      } else {
        res.status(400).json({ message: `Cancel failed: ${result.error}` });
      }
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to cancel order" });
    }
  });

  app.get("/api/wallet/:address/summary", async (req, res) => {
    try {
      const { address } = req.params;
      if (!address || !address.startsWith("0x")) {
        return res.status(400).json({ message: "Invalid SUI address" });
      }

      const walletDeposits = await storage.getDepositsByWallet(address);
      const allDeposits = walletDeposits;

      const allAgents = await storage.getAgents();
      const allRewards = await storage.getRewards();

      const depositedAgentIds = new Set(walletDeposits.map(d => d.agentId));
      const user = await storage.getUserByWallet(address);
      if (user) {
        allAgents.filter(a => a.userId === user.id).forEach(a => depositedAgentIds.add(a.id));
      }

      const myAgentIds = Array.from(depositedAgentIds);

      let totalDepositedGross = 0;
      let totalDepositedNet = 0;
      let totalFeesPaid = 0;
      if (allDeposits.length > 0) {
        for (const d of allDeposits) {
          totalDepositedGross += d.grossAmount;
          totalDepositedNet += d.amount;
          totalFeesPaid += d.protocolFee;
        }
      } else {
        for (const agentId of myAgentIds) {
          const agent = allAgents.find(a => a.id === agentId);
          if (agent) {
            totalDepositedGross += agent.totalDeposited || 0;
            totalDepositedNet += (agent.totalDeposited || 0) - (agent.protocolFeePaid || 0);
            totalFeesPaid += agent.protocolFeePaid || 0;
          }
        }
      }

      let totalLockedCollateral = 0;
      let totalFreeBalance = 0;
      let totalRealizedPnl = 0;
      let totalUnrealizedPnl = 0;
      let openPositionCount = 0;
      let closedPositionCount = 0;
      let settlingCollateral = 0;

      for (const agentId of myAgentIds) {
        const agent = allAgents.find(a => a.id === agentId);
        if (!agent) continue;

        const allPositions = await storage.getPositions(agentId);
        let agentLockedCollateral = 0;
        let agentSettlingCollateral = 0;
        for (const p of allPositions) {
          if ((p.status === "open" || p.status === "pending_open")) {
            const collateral = p.collateral || (p.sizeSui / (agent.leverage || 1));
            const posAgeMs = p.openedAt ? Date.now() - new Date(p.openedAt).getTime() : 0;
            const isSettling = p.status === "pending_open" || posAgeMs < 30000;
            if (isSettling) {
              agentSettlingCollateral += collateral;
              settlingCollateral += collateral;
            }
            agentLockedCollateral += collateral;
            totalLockedCollateral += collateral;
            if (!isSettling) {
              totalUnrealizedPnl += p.unrealizedPnl || 0;
            }
            openPositionCount++;
          } else if (p.status === "closed") {
            closedPositionCount++;
          }
        }

        let agentBalance = Math.max(0, agent.balance);
        if (agent.walletAddress) {
          try {
            const onChain = await getOnChainBalance(agent.walletAddress);
            const verifiedCollateral = agentLockedCollateral - agentSettlingCollateral;
            const onChainTotal = onChain.sui + verifiedCollateral;
            agentBalance = onChainTotal;
          } catch (e) {}
        }
        totalFreeBalance += Math.max(0, agentBalance - agentLockedCollateral);
      }

      const myRewards = allRewards.filter(r => myAgentIds.includes(r.agentId));
      const claimedRewards = myRewards.filter(r => r.status === "claimed");
      const pendingRewards = myRewards.filter(r => r.status === "pending");
      const totalClaimedVerified = claimedRewards.reduce((s, r) => s + r.amount, 0);
      const totalPendingRewards = pendingRewards.reduce((s, r) => s + r.amount, 0);

      const portfolioValue = totalFreeBalance + totalLockedCollateral;
      totalRealizedPnl = (portfolioValue + totalClaimedVerified) - totalDepositedNet;

      res.json({
        wallet: address,
        totalDepositedGross,
        totalDepositedNet,
        totalFeesPaid,
        totalFreeBalance,
        totalLockedCollateral,
        totalRealizedPnl,
        totalUnrealizedPnl,
        totalClaimedVerified,
        totalPendingRewards,
        settlingCollateral,
        verifiedOpenPositions: openPositionCount,
        verifiedClosedPositions: closedPositionCount,
        depositsCount: allDeposits.length,
        claimsCount: claimedRewards.length,
        agentIds: myAgentIds,
        deposits: allDeposits.slice(0, 20).map(d => ({
          agentId: d.agentId,
          amount: d.amount,
          grossAmount: d.grossAmount,
          fee: d.protocolFee,
          txDigest: d.txDigest,
          date: d.createdAt,
        })),
        claims: claimedRewards.slice(0, 20).map(r => ({
          agentId: r.agentId,
          amount: r.amount,
          txDigest: r.txDigest,
          date: r.claimedAt,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to get wallet summary" });
    }
  });

  app.get("/api/balance/:address", async (req, res) => {
    try {
      const { address } = req.params;
      if (!address || !address.startsWith("0x")) {
        return res.status(400).json({ message: "Invalid SUI address" });
      }
      const balance = await getOnChainBalance(address);
      res.json(balance);
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Failed to get balance" });
    }
  });

  app.post("/api/tx/track", async (req, res) => {
    try {
      const { txDigest, type, agentId, userId } = req.body;
      if (!txDigest) {
        return res.status(400).json({ message: "Missing txDigest" });
      }

      const { tx, checkpoint, sender } = await verifyTxDigest(txDigest);

      const record = await storage.createVerifiedTransaction({
        txDigest,
        txType: type || "unknown",
        agentId: agentId || null,
        userId: userId || null,
        checkpoint: checkpoint || null,
        sender: sender || null,
        rawData: tx as any,
      });

      res.json({ ok: true, checkpoint, txDigest, id: record.id });
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Verification failed" });
    }
  });

  app.post("/api/tx/verify", async (req, res) => {
    try {
      const { txDigest } = req.body;
      if (!txDigest) {
        return res.status(400).json({ message: "Missing txDigest" });
      }

      const { checkpoint, sender } = await verifyTxDigest(txDigest);
      res.json({ verified: true, checkpoint, sender });
    } catch (e: any) {
      res.status(400).json({ verified: false, message: e.message || "Verification failed" });
    }
  });

  app.get("/api/learning/stats", async (req, res) => {
    try {
      const { getCloseStats, getQualityMetrics, getCapitalPlan } = await import("./learning-engine");
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;

      const allAgents = await storage.getAgents();
      const agentLookup = new Map<string, { name: string; walletAddress: string | null; status: string; balance: number }>();
      for (const a of allAgents) {
        agentLookup.set(a.id, { name: a.name, walletAddress: a.walletAddress, status: a.status || "stopped", balance: a.balance });
      }

      const activeAgentIds = allAgents.filter(a => a.status === "running").map(a => a.id);
      const stats = await getCloseStats(agentId, agentId ? undefined : activeAgentIds);

      const enrichedRecentOutcomes = stats.recentOutcomes.map((o: any) => {
        const agentInfo = agentLookup.get(o.agentId);
        return {
          ...o,
          agentName: agentInfo?.name || "Unknown",
          walletAddress: agentInfo?.walletAddress || null,
          closeTxDigest: o.closeTxDigest || null,
          onChainPositionId: o.onChainPositionId || null,
        };
      });

      const enrichedAgentBreakdown = (stats.agentBreakdown || []).map((entry: any) => {
        const agentInfo = agentLookup.get(entry.agentId);
        return {
          ...entry,
          agentName: agentInfo?.name || "Unknown",
          walletAddress: agentInfo?.walletAddress || null,
        };
      });

      const qualityMetrics: any[] = [];
      const capitalPlans: any[] = [];
      for (const aid of activeAgentIds) {
        const agentInfo = agentLookup.get(aid);
        try {
          const metrics = await getQualityMetrics(aid);
          qualityMetrics.push({ ...metrics, agentName: agentInfo?.name || "Unknown" });
        } catch {}
        try {
          const openPositions = await storage.getOpenPositions(aid);
          const plan = await getCapitalPlan(aid, agentInfo?.balance || 0, openPositions.length);
          capitalPlans.push({ ...plan, agentName: agentInfo?.name || "Unknown" });
        } catch {}
      }

      res.json({
        ...stats,
        recentOutcomes: enrichedRecentOutcomes,
        agentBreakdown: enrichedAgentBreakdown,
        qualityMetrics,
        capitalPlans,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to get learning stats" });
    }
  });

  app.get("/api/agents/:id/capital-plan", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      const { getCapitalPlan } = await import("./learning-engine");
      const { getGasCapStatus } = await import("./dex/execution-engine");
      const openPositions = await storage.getOpenPositions(agent.id);
      const gasCapStatus = getGasCapStatus(agent.id, agent.totalDeposited || 0);
      const plan = await getCapitalPlan(agent.id, agent.balance, openPositions.length, {
        sessionGasUsed: gasCapStatus.sessionGasUsed,
        effectiveCap: gasCapStatus.effectiveCap,
        utilizationPct: gasCapStatus.utilizationPct,
        breached: gasCapStatus.breached || (agent as any).gasCapBreached || false,
        reason: gasCapStatus.reason || (agent as any).gasCapReason || undefined,
      });
      res.json(plan);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to get capital plan" });
    }
  });

  app.get("/api/agents/:id/quality-metrics", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      const { getQualityMetrics } = await import("./learning-engine");
      const metrics = await getQualityMetrics(agent.id);
      res.json(metrics);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to get quality metrics" });
    }
  });

  app.get("/api/learning/close-health", async (req, res) => {
    try {
      const { getCloseHealthReport, getCloseFailureDiagnostics } = await import("./learning-engine");
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
      if (agentId) {
        const diagnostics = getCloseFailureDiagnostics(agentId);
        res.json(diagnostics || { message: "No close failure data for this agent" });
      } else {
        const report = getCloseHealthReport();
        res.json(report);
      }
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to get close health report" });
    }
  });

  app.get("/api/tx/:digest/inspect", async (req, res) => {
    try {
      const digest = req.params.digest;
      const { suiClient } = await import("./sui-verify");

      const tx = await suiClient.getTransactionBlock({
        digest,
        options: {
          showInput: true,
          showEffects: true,
          showEvents: true,
          showObjectChanges: true,
          showBalanceChanges: true,
        },
      });

      const suiChanges = (tx.balanceChanges ?? [])
        .filter((c: any) => c.coinType === "0x2::sui::SUI" || c.coinType?.includes("::sui::SUI"))
        .map((c: any) => ({
          owner: c.owner?.AddressOwner || c.owner?.ObjectOwner || c.owner,
          amountMist: c.amount,
          amountSui: (Number(c.amount) / 1e9).toFixed(6),
          coinType: c.coinType,
        }));

      const sender = (tx.transaction as any)?.data?.sender;
      const gasOwner = (tx.effects as any)?.gasUsed
        ? sender
        : null;
      const gasUsed = tx.effects?.gasUsed
        ? {
            computationCost: tx.effects.gasUsed.computationCost,
            storageCost: tx.effects.gasUsed.storageCost,
            storageRebate: tx.effects.gasUsed.storageRebate,
            totalMist: String(
              BigInt(tx.effects.gasUsed.computationCost) +
              BigInt(tx.effects.gasUsed.storageCost) -
              BigInt(tx.effects.gasUsed.storageRebate)
            ),
            totalSui: (
              (Number(BigInt(tx.effects.gasUsed.computationCost) +
              BigInt(tx.effects.gasUsed.storageCost) -
              BigInt(tx.effects.gasUsed.storageRebate)) / 1e9)
            ).toFixed(6),
          }
        : null;

      const createdCoins = (tx.objectChanges ?? [])
        .filter((ch: any) => ch.type === "created" && ch.objectType?.includes("Coin<0x2::sui::SUI>"))
        .map((ch: any) => ({
          objectId: ch.objectId,
          owner: (ch.owner as any)?.AddressOwner || (ch.owner as any)?.ObjectOwner || ch.owner,
          objectType: ch.objectType,
        }));

      const events = (tx.events ?? []).map((evt: any) => ({
        type: evt.type?.split("::").slice(-2).join("::") || evt.type,
        fullType: evt.type,
        parsedJson: evt.parsedJson,
      }));

      const statusObj = (tx.effects as any)?.status;
      const errorStr = statusObj?.error || "";
      let errorKind = "UNKNOWN";
      let moveAbort: { module?: string; functionName?: string; code?: string } | undefined;

      if (errorStr) {
        if (errorStr.includes("order_not_found")) errorKind = "ORDER_NOT_FOUND";
        else if (errorStr.includes("position_not_found")) errorKind = "POSITION_NOT_FOUND";
        else if (errorStr.includes("key_not_found") || errorStr.includes("keyed_big_vector")) errorKind = "KEY_NOT_FOUND";
        else if (errorStr.includes("too_many_linked_orders")) errorKind = "TOO_MANY_LINKED_ORDERS";
        else if (errorStr.includes("ObjectNotFound") || errorStr.includes("could not find object")) errorKind = "OBJECT_NOT_FOUND";
        else if (errorStr.includes("version") && (errorStr.includes("mismatch") || errorStr.includes("stale"))) errorKind = "OBJECT_VERSION_STALE";
        else if (errorStr.includes("permission") || errorStr.includes("not authorized") || errorStr.includes("capability")) errorKind = "NOT_AUTHORIZED";
        else if (errorStr.includes("insufficient") && errorStr.includes("gas")) errorKind = "INSUFFICIENT_GAS";
        else if (errorStr.includes("slippage") || errorStr.includes("price")) errorKind = "SLIPPAGE";
        else if (errorStr.includes("already") && (errorStr.includes("closed") || errorStr.includes("finalized"))) errorKind = "ALREADY_CLOSED";

        const abortMatch = errorStr.match(/MoveAbort.*?function_name:\s*Some\("(\w+)"\).*?(\d+)\)/);
        if (abortMatch) {
          moveAbort = { functionName: abortMatch[1], code: abortMatch[2] };
        }
        const moduleMatch = errorStr.match(/module:\s*ModuleId\s*\{[^}]*name:\s*Identifier\("(\w+)"\)/);
        if (moduleMatch && moveAbort) {
          moveAbort.module = moduleMatch[1];
        }
      }

      res.json({
        digest,
        status: statusObj,
        errorKind: statusObj?.status === "failure" ? errorKind : null,
        moveAbort: moveAbort || null,
        sender,
        gasOwner,
        gasUsed,
        suiChanges,
        createdCoins,
        events,
        timestampMs: tx.timestampMs,
      });
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? String(e) });
    }
  });

  app.get("/api/debug/ledger", async (req, res) => {
    try {
      const wallet = req.query.wallet as string;
      const allAgents = await storage.getAgents();
      const allRewards = await storage.getRewards();
      const allFees = await storage.getProtocolFees();
      

      let deposits: any[] = [];
      let agentIds: string[] = [];

      if (wallet) {
        const walletDeposits = await storage.getDepositsByWallet(wallet);
        deposits = walletDeposits;
        const depositedAgentIds = new Set(walletDeposits.map(d => d.agentId));
        const user = await storage.getUserByWallet(wallet);
        if (user) {
          allAgents.filter(a => a.userId === user.id).forEach(a => depositedAgentIds.add(a.id));
        }
        agentIds = Array.from(depositedAgentIds);
      } else {
        agentIds = allAgents.map(a => a.id);
        for (const agentId of agentIds) {
          const agentDeps = await storage.getDepositsByAgent(agentId);
          deposits.push(...agentDeps);
        }
      }

      const myAgents = allAgents.filter(a => agentIds.includes(a.id));
      const myRewards = allRewards.filter(r => agentIds.includes(r.agentId));
      const myFees = allFees.filter(f => agentIds.includes(f.agentId));

      const allOrders: any[] = [];
      const allPositions: any[] = [];
      for (const agentId of agentIds) {
        const orders = await storage.getOrders(agentId);
        const positions = await storage.getPositions(agentId);
        allOrders.push(...orders.map(o => ({ ...o, agentId })));
        allPositions.push(...positions.map(p => ({ ...p, agentId })));
      }

      const recentDigests = [
        ...deposits.filter(d => d.txDigest).map(d => ({ type: "deposit", digest: d.txDigest, date: d.createdAt, amount: d.grossAmount, agentId: d.agentId })),
        ...myRewards.filter(r => r.txDigest).map(r => ({ type: "claim", digest: r.txDigest, date: r.claimedAt, amount: r.amount, agentId: r.agentId })),
        ...allOrders.filter(o => o.txDigest && !o.txDigest.startsWith("sim_")).map(o => ({ type: "order", digest: o.txDigest, date: o.createdAt, amount: null, agentId: o.agentId })),
        ...allPositions.filter(p => p.txDigest && !p.txDigest.startsWith("sim_")).map(p => ({ type: "position", digest: p.txDigest, date: p.openedAt, amount: p.sizeSui, agentId: p.agentId })),
      ].sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        return db - da;
      }).slice(0, 50);

      const totalDeposited = deposits.reduce((s, d) => s + (d.grossAmount || 0), 0);
      const totalFees = deposits.reduce((s, d) => s + (d.protocolFee || 0), 0);
      const totalNetDeposited = deposits.reduce((s, d) => s + (d.amount || 0), 0);
      const totalAgentBalance = myAgents.reduce((s, a) => s + a.balance, 0);
      const pendingRewards = myRewards.filter(r => r.status === "pending").reduce((s, r) => s + r.amount, 0);
      const claimedRewards = myRewards.filter(r => r.status === "claimed" && r.verified).reduce((s, r) => s + r.amount, 0);

      res.json({
        wallet: wallet || "all",
        agents: myAgents.map(a => ({
          id: a.id,
          name: a.name,
          balance: a.balance,
          walletAddress: a.walletAddress,
          status: a.status,
          totalDeposited: a.totalDeposited,
          totalPnl: a.totalPnl,
        })),
        deposits: deposits.map(d => ({
          id: d.id,
          agentId: d.agentId,
          depositorAddress: d.depositorAddress,
          grossAmount: d.grossAmount,
          netAmount: d.amount,
          protocolFee: d.protocolFee,
          txDigest: d.txDigest,
          verified: d.verified,
          checkpoint: d.checkpoint,
          date: d.createdAt,
        })),
        rewards: myRewards.map(r => ({
          id: r.id,
          agentId: r.agentId,
          amount: r.amount,
          status: r.status,
          txDigest: r.txDigest,
          verified: r.verified,
          date: r.status === "claimed" ? r.claimedAt : r.createdAt,
        })),
        recentDigests,
        totals: {
          totalDeposited,
          totalFees,
          totalNetDeposited,
          totalAgentBalance,
          pendingRewards,
          claimedRewards,
          agentCount: myAgents.length,
          depositCount: deposits.length,
          verifiedDepositCount: deposits.filter(d => d.verified).length,
          orderCount: allOrders.filter(o => o.txDigest && !o.txDigest.startsWith("sim_")).length,
          positionCount: allPositions.filter(p => p.txDigest && !p.txDigest.startsWith("sim_")).length,
        },
        feeAddress: PROTOCOL_FEE_ADDRESS,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to get ledger" });
    }
  });

  app.post("/api/debug/trace", async (req, res) => {
    try {
      const { digest } = req.body;
      if (!digest) {
        return res.status(400).json({ message: "Transaction digest required" });
      }

      const result = await verifyTxDigest(digest);

      const suiChanges = (result.balanceChanges || [])
        .filter((bc: any) => bc.coinType === "0x2::sui::SUI" || bc.coinType?.includes("::sui::SUI"))
        .map((bc: any) => ({
          owner: bc.owner?.AddressOwner || bc.owner?.ObjectOwner || "unknown",
          amountMist: bc.amount,
          amountSui: Number(bc.amount) / 1e9,
          direction: Number(bc.amount) < 0 ? "SENT" : "RECEIVED",
        }));

      res.json({
        digest,
        status: "success",
        sender: result.sender,
        checkpoint: result.checkpoint,
        suiChanges,
        isContractCall: false,
        objectsCreated: 0,
      });
    } catch (e: any) {
      res.status(400).json({
        digest: req.body?.digest,
        status: "error",
        error: e.message || "Failed to trace transaction",
      });
    }
  });

  app.get("/api/protocol/info", (_req, res) => {
    let rewardWallet = "";
    try { rewardWallet = getRewardWalletAddress(); } catch {}
    res.json({
      feeRate: PROTOCOL_FEE_RATE,
      feeAddress: PROTOCOL_FEE_ADDRESS,
      rewardWallet,
      poweredBy: "Blue Water Protocol LLC",
      developedBy: "lifeguard.sui",
    });
  });

  app.get("/api/protocol/overview", async (_req, res) => {
    try {
      const fees = await storage.getProtocolFees();
      const allAgents = await storage.getAgents();
      const allRewards = await storage.getRewards();
      const verifiedFees = fees.filter((f) => f.verified && f.txDigest);
      const totalFeesCollected = verifiedFees.reduce((sum, f) => sum + f.amount, 0);
      const totalVerifiedFees = totalFeesCollected;
      const uniqueUsers = new Set(verifiedFees.map((f) => f.userId));
      const uniqueAgents = new Set(verifiedFees.map((f) => f.agentId));
      const verifiedClaimedRewards = allRewards.filter((r) => r.status === "claimed" && r.txDigest && r.verified);
      const totalRewardsPaid = verifiedClaimedRewards.reduce((sum, r) => sum + r.amount, 0);
      const totalRewardsPending = allRewards.filter((r) => r.status === "pending").reduce((sum, r) => sum + r.amount, 0);
      const totalDeposited = allAgents.reduce((sum, a) => sum + (a.totalDeposited || 0), 0);

      let protocolWalletBalance = 0;
      try {
        const protocolBal = await getOnChainBalance(PROTOCOL_FEE_ADDRESS);
        protocolWalletBalance = protocolBal.sui;
      } catch {}

      res.json({
        protocolWallet: PROTOCOL_FEE_ADDRESS,
        protocolWalletBalance,
        feeRate: PROTOCOL_FEE_RATE,
        totalFeesCollected,
        totalVerifiedFees,
        totalDeposited,
        totalRewardsPaid,
        totalRewardsPending,
        uniqueUsers: uniqueUsers.size,
        uniqueAgents: uniqueAgents.size,
        totalAgents: allAgents.length,
        activeAgents: allAgents.filter((a) => a.status === "running").length,
        recentFees: verifiedFees.slice(0, 20),
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to get protocol overview" });
    }
  });

  app.get("/api/leaderboard", async (_req, res) => {
    try {
      const allAgents = await storage.getAgents();
      const allRewards = (await storage.getRewards()).filter(r => r.status !== "voided");
      const allUsers = await storage.getUsers();

      const agentStats = await Promise.all(allAgents.map(async (a) => {
        const agentRewards = allRewards.filter((r) => r.agentId === a.id);
        const totalRewards = agentRewards.reduce((sum, r) => sum + r.amount, 0);
        const claimedRewards = agentRewards.filter((r) => r.status === "claimed").reduce((sum, r) => sum + r.amount, 0);
        const netDeposited = (a.totalDeposited || 0) - (a.protocolFeePaid || 0);

        let freeSui = Math.max(0, a.balance);
        let totalLocked = 0;
        const cachedPortfolio = onChainPortfolioCache.get(a.id);
        if (cachedPortfolio && Date.now() - cachedPortfolio.timestamp < ONCHAIN_PORTFOLIO_CACHE_TTL * 4) {
          freeSui = cachedPortfolio.freeSui;
          totalLocked = cachedPortfolio.totalLocked;
        } else {
          const cachedBal = onChainBalanceCache.get(a.id);
          if (cachedBal && Date.now() - cachedBal.timestamp < ONCHAIN_BALANCE_CACHE_TTL * 4) {
            freeSui = cachedBal.sui;
          }
          const agentPositions = await storage.getPositions(a.id);
          for (const p of agentPositions) {
            if (p.status === "open" || p.status === "pending_open") {
              totalLocked += p.collateral || (p.sizeSui / (a.leverage || 1));
            }
          }
          if (totalLocked > 0) {
            freeSui = Math.max(0, freeSui - totalLocked);
          }
        }
        const portfolioValue = freeSui + totalLocked;
        const portfolioPnl = netDeposited > 0 ? (portfolioValue + claimedRewards) - netDeposited : a.totalPnl;

        return {
          id: a.id,
          name: a.name,
          userId: a.userId,
          venue: a.venue,
          status: a.status,
          balance: a.balance,
          totalPnl: portfolioPnl,
          totalTrades: a.totalTrades,
          winRate: a.winRate,
          totalDeposited: a.totalDeposited,
          totalRewards,
          claimedRewards,
          freeSui,
          portfolioValue,
          createdAt: a.createdAt,
        };
      }));

      const topRewards = [...agentStats].sort((a, b) => b.totalRewards - a.totalRewards);
      const topPnl = [...agentStats].sort((a, b) => b.totalPnl - a.totalPnl);
      const topWinRate = [...agentStats].filter(a => a.totalTrades >= 5).sort((a, b) => b.winRate - a.winRate);
      const topPortfolio = [...agentStats].sort((a, b) => b.portfolioValue - a.portfolioValue);
      const topFreeSui = [...agentStats].sort((a, b) => b.freeSui - a.freeSui);

      const userMap = new Map<string, { walletAddress: string; nsName: string | null; totalRewards: number; claimedRewards: number; agentCount: number; totalPnl: number; totalTrades: number }>();
      for (const agent of allAgents) {
        const user = allUsers.find((u) => u.id === agent.userId);
        const wallet = user?.walletAddress || agent.userId;
        const existing = userMap.get(wallet) || { walletAddress: wallet, nsName: null, totalRewards: 0, claimedRewards: 0, agentCount: 0, totalPnl: 0, totalTrades: 0 };
        const agentRewards = allRewards.filter((r) => r.agentId === agent.id);
        existing.totalRewards += agentRewards.reduce((sum, r) => sum + r.amount, 0);
        existing.claimedRewards += agentRewards.filter((r) => r.status === "claimed").reduce((sum, r) => sum + r.amount, 0);
        existing.agentCount += 1;
        const agentNetDeposited = (agent.totalDeposited || 0) - (agent.protocolFeePaid || 0);
        const agentClaimedRewards = agentRewards.filter((r) => r.status === "claimed").reduce((sum, r) => sum + r.amount, 0);
        const agentStat = agentStats.find(s => s.id === agent.id);
        const agentPortfolioValue = agentStat ? agentStat.portfolioValue : Math.max(0, agent.balance);
        const agentPnl = agentNetDeposited > 0 ? (agentPortfolioValue + agentClaimedRewards) - agentNetDeposited : (agent.totalPnl || 0);
        existing.totalPnl += agentPnl;
        existing.totalTrades += agent.totalTrades || 0;
        userMap.set(wallet, existing);
      }
      const userStats = Array.from(userMap.values()).sort((a, b) => b.totalRewards - a.totalRewards);

      const nsPromises = userStats.map(async (u) => {
        try {
          u.nsName = await resolveNSName(u.walletAddress);
        } catch { /* ignore */ }
        return u;
      });
      await Promise.all(nsPromises);

      res.json({
        agents: agentStats,
        topRewards,
        topPnl,
        topWinRate,
        topPortfolio,
        topFreeSui,
        users: userStats,
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to get leaderboard" });
    }
  });

  app.get("/api/rewards/summary", async (_req, res) => {
    try {
      const allRewards = await storage.getRewards();
      const activeRewards = allRewards.filter((r) => r.status !== "voided");
      const allAgents = await storage.getAgents();
      const { getOnChainBalance } = await import("./sui-verify");

      const claimedRewards = activeRewards.filter((r) => r.status === "claimed");
      const totalClaimed = claimedRewards.reduce((sum, r) => sum + r.amount, 0);

      const retainedPendingRewards = activeRewards.filter((r) => r.status === "pending" && r.escrowTxDigest === "agent_retained");
      const escrowedPendingRewards = activeRewards.filter((r) => r.status === "pending" && r.escrowTxDigest && r.escrowTxDigest !== "agent_retained" && r.escrowTxDigest !== "pending_escrow");
      const pendingEscrowQueue = activeRewards.filter((r) => r.status === "pending" && r.escrowTxDigest === "pending_escrow");

      let rewardWalletEscrowedTotal = 0;
      try {
        const { getRewardWalletBalance: rwBal2 } = await import("./reward-wallet");
        const rwBalance = await rwBal2();
        rewardWalletEscrowedTotal = Math.max(0, rwBalance.sui - 0.01);
      } catch {}

      const GAS_RESERVE = 0.02;
      const agentClaimableBalances: Array<{ agentId: string; agentName: string; claimableBalance: number; totalEarned: number; venue: string; status: string; walletAddress: string; pendingEscrow?: number; escrowedAmount?: number }> = [];

      for (const a of allAgents) {
        const agentLegacyRewards = retainedPendingRewards.filter(r => r.agentId === a.id);
        const agentEscrowedRewards = escrowedPendingRewards.filter(r => r.agentId === a.id);
        const agentPendingEscrow = pendingEscrowQueue.filter(r => r.agentId === a.id);
        const totalPendingRewardAmount = agentLegacyRewards.reduce((sum, r) => sum + r.amount, 0)
          + agentEscrowedRewards.reduce((sum, r) => sum + r.amount, 0)
          + agentPendingEscrow.reduce((sum, r) => sum + r.amount, 0);
        if (totalPendingRewardAmount <= 0) continue;

        let legacyClaimable = 0;
        if (agentLegacyRewards.length > 0 && a.walletAddress) {
          try {
            const cachedBal = onChainBalanceCache.get(a.id);
            let freeSui = 0;
            if (cachedBal && Date.now() - cachedBal.timestamp < ONCHAIN_BALANCE_CACHE_TTL) {
              freeSui = cachedBal.sui;
            } else {
              const bal = await getOnChainBalance(a.walletAddress);
              freeSui = bal.sui;
              onChainBalanceCache.set(a.id, { sui: bal.sui, timestamp: Date.now() });
            }
            const positions = await storage.getPositions(a.id);
            let lockedCollateral = 0;
            for (const p of positions) {
              if (p.status === "open" || p.status === "pending_open") {
                lockedCollateral += p.collateral || (p.sizeSui / (a.leverage || 1));
              }
            }
            const effectiveFreeSui = Math.max(0, freeSui - lockedCollateral - GAS_RESERVE);
            legacyClaimable = Math.min(agentLegacyRewards.reduce((s, r) => s + r.amount, 0), effectiveFreeSui);
          } catch {}
        }

        const escrowedAmount = agentEscrowedRewards.reduce((s, r) => s + r.amount, 0);
        const escrowedClaimable = Math.min(escrowedAmount, rewardWalletEscrowedTotal);
        const pendingEscrowAmt = agentPendingEscrow.reduce((s, r) => s + r.amount, 0);

        // pending_escrow rewards ARE claimable if the agent wallet has free SUI to fund the escrow
        // We compute free SUI once (reusing from legacy calc if already done)
        let pendingEscrowClaimable = 0;
        if (pendingEscrowAmt > 0.001 && a.walletAddress) {
          try {
            const cachedBal = onChainBalanceCache.get(a.id);
            let freeSui = 0;
            if (cachedBal && Date.now() - cachedBal.timestamp < ONCHAIN_BALANCE_CACHE_TTL) {
              freeSui = cachedBal.sui;
            } else {
              const bal = await getOnChainBalance(a.walletAddress);
              freeSui = bal.sui;
              onChainBalanceCache.set(a.id, { sui: bal.sui, timestamp: Date.now() });
            }
            const positions = await storage.getPositions(a.id);
            let lockedCollateral = 0;
            for (const p of positions) {
              if (p.status === "open" || p.status === "pending_open") {
                lockedCollateral += p.collateral || (p.sizeSui / (a.leverage || 1));
              }
            }
            const effectiveFreeSui = Math.max(0, freeSui - lockedCollateral - GAS_RESERVE - legacyClaimable);
            // We can escrow up to effectiveFreeSui from pending_escrow, then immediately claim that amount
            pendingEscrowClaimable = Math.min(pendingEscrowAmt, effectiveFreeSui);
          } catch {}
        }

        const effectiveClaimable = legacyClaimable + escrowedClaimable + pendingEscrowClaimable;

        if (effectiveClaimable > 0.001 || totalPendingRewardAmount > 0) {
          agentClaimableBalances.push({
            agentId: a.id,
            agentName: a.name,
            claimableBalance: Math.max(0, effectiveClaimable),
            totalEarned: totalPendingRewardAmount,
            venue: a.venue,
            status: a.status,
            walletAddress: a.walletAddress,
            pendingEscrow: pendingEscrowAmt > 0.001 ? pendingEscrowAmt : undefined,
            escrowedAmount: escrowedAmount > 0.001 ? escrowedAmount : undefined,
          });
        }

        if (Math.abs((a.ownerClaimableBalance || 0) - effectiveClaimable) > 0.001) {
          storage.updateAgent(a.id, { ownerClaimableBalance: Math.max(0, effectiveClaimable) }).catch(() => {});
        }
      }

      const totalAgentClaimable = agentClaimableBalances.reduce((sum, a) => sum + a.claimableBalance, 0);

      const legacyEscrowedRewards = activeRewards.filter((r) => r.status === "pending" && r.escrowTxDigest && r.escrowTxDigest !== "pending_escrow" && r.escrowTxDigest !== "agent_retained");
      const totalLegacyClaimable = legacyEscrowedRewards.reduce((sum, r) => sum + r.amount, 0);

      const retainedRewards = activeRewards.filter((r) => r.escrowTxDigest === "agent_retained");
      const verifiableRewards = [...legacyEscrowedRewards, ...claimedRewards, ...retainedRewards].sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateB - dateA;
      });

      let rewardWalletOnChainBalance = 0;
      let rewardWalletAddr = "";
      try {
        const { getRewardWalletBalance, getRewardWalletAddress: getRWA } = await import("./reward-wallet");
        rewardWalletAddr = getRWA();
        const rwBal = await getRewardWalletBalance();
        rewardWalletOnChainBalance = rwBal.sui;
      } catch {}

      const liveAgentIds = new Set(allAgents.map(a => a.id));
      const pendingEscrowRewards = activeRewards.filter((r) => r.status === "pending" && r.escrowTxDigest === "pending_escrow" && liveAgentIds.has(r.agentId));
      const totalPendingEscrow = pendingEscrowRewards.reduce((s, r) => s + r.amount, 0);

      const orphanedRewards = activeRewards.filter((r) => r.status === "pending" && !liveAgentIds.has(r.agentId));
      const totalOrphaned = orphanedRewards.reduce((s, r) => s + r.amount, 0);
      const orphanedByAgent = new Map<string, { agentName: string; total: number }>();
      for (const r of orphanedRewards) {
        const ex = orphanedByAgent.get(r.agentId) || { agentName: r.agentName || r.agentId.slice(0, 8), total: 0 };
        ex.total += r.amount;
        orphanedByAgent.set(r.agentId, ex);
      }

      const directlyClaimable = Math.max(0, rewardWalletOnChainBalance - 0.01);

      res.json({
        totalClaimable: totalAgentClaimable,
        totalAgentClaimable,
        totalLegacyClaimable,
        totalClaimed,
        totalEarned: agentClaimableBalances.reduce((sum, a) => sum + (a.totalEarned || a.claimableBalance), 0) + totalLegacyClaimable + totalClaimed,
        agentClaimableBalances,
        legacyEscrowedRewards,
        rewards: verifiableRewards,
        rewardWalletBalance: rewardWalletOnChainBalance,
        rewardWalletAddress: rewardWalletAddr,
        totalPendingEscrow,
        totalOrphaned,
        orphanedByAgent: Array.from(orphanedByAgent.entries()).map(([agentId, v]) => ({ agentId, ...v })),
        directlyClaimable,
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to get rewards" });
    }
  });

  const claimInProgress = new Set<string>();

  app.post("/api/agents/:id/claim-rewards", async (req, res) => {
    try {
      const { id } = req.params;
      const { signature, message: signedMessage, walletAddress } = req.body;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required to claim rewards" });
      }

      if (!signature || !signedMessage) {
        return res.status(400).json({ message: "Wallet signature required" });
      }

      try {
        const { verifyPersonalMessageSignature } = await import("@mysten/sui/verify");
        const messageBytes = new TextEncoder().encode(signedMessage);
        const result = await verifyPersonalMessageSignature(messageBytes, signature);
        if (result.toSuiAddress().toLowerCase() !== walletAddress.toLowerCase()) {
          return res.status(403).json({ message: "Signature does not match wallet address" });
        }
      } catch (verifyErr: any) {
        return res.status(403).json({ message: "Invalid signature: " + (verifyErr?.message || "verification failed") });
      }

      if (!signedMessage.includes(walletAddress)) {
        return res.status(403).json({ message: "Signed message does not match wallet address" });
      }

      const agent = await storage.getAgent(id);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === agent.userId;
      const deposits = await storage.getDepositsByAgent(agent.id);
      const isDepositor = deposits.some(d => d.depositorAddress.toLowerCase() === walletAddress.toLowerCase());
      if (!isOwner && !isDepositor) {
        return res.status(403).json({ message: "Only the agent creator or depositor can claim rewards" });
      }

      if (!agent.agentWallet || !agent.walletAddress) {
        return res.status(400).json({ message: "Agent wallet not configured" });
      }

      const allRewardsForCheck = await storage.getRewards();
      const agentPendingRewards = allRewardsForCheck.filter(r =>
        r.agentId === agent.id && r.status === "pending" &&
        (r.escrowTxDigest === "agent_retained" || r.escrowTxDigest === "pending_escrow" ||
         (r.escrowTxDigest && r.escrowTxDigest !== "agent_retained" && r.escrowTxDigest !== "pending_escrow"))
      );
      const totalPendingRewardAmount = agentPendingRewards.reduce((sum, r) => sum + r.amount, 0);

      if (totalPendingRewardAmount <= 0) {
        return res.status(400).json({ message: "No pending rewards for this agent" });
      }

      const claimKey = `agent_${agent.id}`;
      if (claimInProgress.has(claimKey)) {
        return res.status(409).json({ message: "Claim already in progress for this agent" });
      }
      claimInProgress.add(claimKey);

      try {
        const { getRewardWalletBalance: rwBal, escrowRewardFromAgent, transferRewardToUser: trwu, transferFromAgentWallet } = await import("./reward-wallet");

        const legacyRetainedRewards = agentPendingRewards.filter(r => r.escrowTxDigest === "agent_retained");
        const escrowedRewards = agentPendingRewards.filter(r =>
          r.escrowTxDigest === "pending_escrow" ||
          (r.escrowTxDigest && r.escrowTxDigest !== "agent_retained" && r.escrowTxDigest !== "pending_escrow")
        );
        const pendingEscrowRewards = escrowedRewards.filter(r => r.escrowTxDigest === "pending_escrow");

        for (const reward of pendingEscrowRewards) {
          try {
            const agentBal = await (await import("./sui-verify")).getOnChainBalance(agent.walletAddress);
            if (agentBal.sui >= reward.amount + 0.01) {
              const escrowResult = await escrowRewardFromAgent(agent.agentWallet, agent.walletAddress, reward.amount);
              await storage.updateReward(reward.id, { escrowTxDigest: escrowResult.txDigest });
              reward.escrowTxDigest = escrowResult.txDigest;
              console.log(`[Rewards] On-demand escrow for ${reward.id}: ${reward.amount.toFixed(4)} SUI → reward wallet (tx: ${escrowResult.txDigest})`);
            }
          } catch (escrowErr: any) {
            console.log(`[Rewards] On-demand escrow failed for ${reward.id}: ${escrowErr.message}`);
          }
        }

        const freshlyEscrowed = escrowedRewards.filter(r => r.escrowTxDigest && r.escrowTxDigest !== "pending_escrow");
        const stillPendingEscrow = escrowedRewards.filter(r => r.escrowTxDigest === "pending_escrow");

        let totalTransferred = 0;
        const claimedTxDigests: string[] = [];

        if (freshlyEscrowed.length > 0) {
          const escrowTotal = freshlyEscrowed.reduce((s, r) => s + r.amount, 0);
          try {
            const rwBalance = await rwBal();
            const available = Math.max(0, rwBalance.sui - 0.01);
            const claimable = Math.min(escrowTotal, available);
            if (claimable > 0.001) {
              const tx = await trwu(walletAddress, claimable);
              let claimed = 0;
              const sorted = [...freshlyEscrowed].sort((a, b) => a.amount - b.amount);
              for (const r of sorted) {
                if (claimed + r.amount <= claimable + 0.001) {
                  await storage.claimReward(r.id, tx.txDigest, null);
                  claimed += r.amount;
                }
              }
              totalTransferred += claimable;
              claimedTxDigests.push(tx.txDigest);
              console.log(`[Rewards] Claimed ${claimable.toFixed(4)} SUI from reward wallet for ${agent.name} → ${walletAddress.slice(0, 10)}... (tx: ${tx.txDigest})`);
              await storage.createVerifiedTransaction({
                txDigest: tx.txDigest, txType: "reward_claim", agentId: agent.id, userId: agent.userId,
                sender: getRewardWalletAddress(), checkpoint: null,
                rawData: { amount: claimable, toAddress: walletAddress, type: "reward_claim", fromRewardWallet: true },
              }).catch(() => {});
            }
          } catch (rwErr: any) {
            console.log(`[Rewards] Reward wallet transfer failed: ${rwErr.message}`);
          }
        }

        if (legacyRetainedRewards.length > 0) {
          const legacyTotal = legacyRetainedRewards.reduce((s, r) => s + r.amount, 0);
          try {
            const { getOnChainBalance: gbal } = await import("./sui-verify");
            const agentBalance = await gbal(agent.walletAddress);
            const positions = await storage.getPositions(agent.id);
            let lockedCollateral = 0;
            for (const p of positions) {
              if (p.status === "open" || p.status === "pending_open") {
                lockedCollateral += p.collateral || (p.sizeSui / (agent.leverage || 1));
              }
            }
            const freeSui = Math.max(0, agentBalance.sui - lockedCollateral - 0.02);
            if (freeSui >= 0.001) {
              const legacyClaim = Math.min(legacyTotal, freeSui);
              const legacyTx = await transferFromAgentWallet(agent.agentWallet, agent.walletAddress, walletAddress, legacyClaim);
              let claimed = 0;
              const sorted = [...legacyRetainedRewards].sort((a, b) => a.amount - b.amount);
              for (const r of sorted) {
                if (claimed + r.amount <= legacyClaim + 0.001) {
                  await storage.claimReward(r.id, legacyTx.txDigest, null);
                  claimed += r.amount;
                }
              }
              totalTransferred += legacyClaim;
              claimedTxDigests.push(legacyTx.txDigest);
              console.log(`[Rewards] Legacy claimed ${legacyClaim.toFixed(4)} SUI from ${agent.name} wallet → ${walletAddress.slice(0, 10)}... (tx: ${legacyTx.txDigest})`);
              await storage.createVerifiedTransaction({
                txDigest: legacyTx.txDigest, txType: "reward_claim", agentId: agent.id, userId: agent.userId,
                sender: agent.walletAddress, checkpoint: null,
                rawData: { amount: legacyClaim, toAddress: walletAddress, type: "agent_reward_claim", fromAgentWallet: true },
              }).catch(() => {});
            }
          } catch (legacyErr: any) {
            console.log(`[Rewards] Legacy claim failed for ${agent.name}: ${legacyErr.message}`);
          }
        }

        await storage.updateAgent(agent.id, { ownerClaimableBalance: 0 });

        const stillPendingCount = stillPendingEscrow.length;
        const stillPendingAmt = stillPendingEscrow.reduce((s, r) => s + r.amount, 0);

        if (totalTransferred < 0.001) {
          if (stillPendingCount > 0) {
            return res.status(400).json({
              message: `${stillPendingAmt.toFixed(4)} SUI in rewards pending escrow to reward wallet. Escrow requires sufficient agent balance. Try again after a gas top-off.`,
              code: "REWARDS_PENDING_ESCROW",
            });
          }
          return res.status(400).json({ message: "No rewards available to claim right now." });
        }

        res.json({
          success: true,
          agentId: agent.id,
          agentName: agent.name,
          amount: totalTransferred,
          txDigest: claimedTxDigests[0] || null,
          txDigests: claimedTxDigests,
          ...(stillPendingCount > 0 && { note: `${stillPendingAmt.toFixed(4)} SUI still pending escrow — will be claimable after escrow completes.` }),
        });
      } finally {
        claimInProgress.delete(claimKey);
      }
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      if (errMsg.includes("429") || errMsg.includes("rate limit")) {
        res.status(429).json({ message: "SUI network is busy. Please wait a moment and try again." });
      } else {
        res.status(500).json({ message: e.message || "Failed to claim agent rewards" });
      }
    }
  });

  // Process pending escrow: batch-escrow all pending_escrow rewards for all agents owned by user
  app.post("/api/rewards/process-pending-escrow", async (req, res) => {
    try {
      const walletAddress = req.body.walletAddress as string;
      if (!walletAddress) return res.status(400).json({ message: "walletAddress required" });

      const allAgentsAll = await storage.getAgents();
      // Find agents this wallet has a claim to: agents they deployed (walletAddress matches), or any agent with pending escrow
      // For process-escrow, we need agents that still have keypairs (agentWallet field)
      const allAgents = allAgentsAll.filter(a => a.agentWallet && a.walletAddress);
      if (!allAgents.length) return res.status(404).json({ message: "No agents with active wallets found" });

      const allRewards = await storage.getRewards();
      const { escrowRewardFromAgent } = await import("./reward-wallet");
      const { getOnChainBalance } = await import("./sui-verify");

      let totalEscrowed = 0;
      const results: Array<{ agentName: string; escrowed: number; txDigest: string }> = [];
      const errors: string[] = [];

      for (const agent of allAgents) {
        if (!agent.agentWallet || !agent.walletAddress) continue;

        const agentPendingEscrow = allRewards.filter(r =>
          r.agentId === agent.id && r.status === "pending" && r.escrowTxDigest === "pending_escrow"
        );
        if (!agentPendingEscrow.length) continue;

        const totalNeeded = agentPendingEscrow.reduce((s, r) => s + r.amount, 0);

        try {
          const bal = await getOnChainBalance(agent.walletAddress);
          const positions = await storage.getPositions(agent.id);
          let locked = 0;
          for (const p of positions) {
            if (p.status === "open" || p.status === "pending_open") {
              locked += p.collateral || (p.sizeSui / (agent.leverage || 1));
            }
          }
          const free = Math.max(0, bal.sui - locked - 0.02);
          if (free < 0.001) {
            errors.push(`${agent.name}: insufficient free SUI (${free.toFixed(4)} available, ${totalNeeded.toFixed(4)} needed)`);
            continue;
          }

          const escrowAmt = Math.min(totalNeeded, free);
          const escrowResult = await escrowRewardFromAgent(agent.agentWallet, agent.walletAddress, escrowAmt);

          // Mark processed rewards with the escrow TX digest
          let marked = 0;
          const sorted = [...agentPendingEscrow].sort((a, b) => a.amount - b.amount);
          for (const r of sorted) {
            if (marked + r.amount <= escrowAmt + 0.001) {
              await storage.updateReward(r.id, { escrowTxDigest: escrowResult.txDigest });
              marked += r.amount;
            }
          }

          totalEscrowed += escrowAmt;
          results.push({ agentName: agent.name, escrowed: escrowAmt, txDigest: escrowResult.txDigest });
          console.log(`[Rewards] Batch escrow: ${escrowAmt.toFixed(4)} SUI from ${agent.name} → reward wallet (tx: ${escrowResult.txDigest})`);
        } catch (err: any) {
          errors.push(`${agent.name}: ${err.message}`);
        }
      }

      res.json({
        success: totalEscrowed > 0,
        totalEscrowed,
        results,
        errors: errors.length > 0 ? errors : undefined,
        message: totalEscrowed > 0
          ? `Escrowed ${totalEscrowed.toFixed(4)} SUI to reward wallet. Rewards are now claimable.`
          : "No rewards could be escrowed — agent wallets may not have enough free SUI.",
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to process pending escrow" });
    }
  });

  // Direct claim of reward wallet on-chain balance — bypasses reward records
  // Useful when reward wallet has SUI from escrowed rewards that records don't track perfectly
  app.post("/api/rewards/claim-wallet-balance", async (req, res) => {
    try {
      const { walletAddress } = req.body;
      if (!walletAddress) return res.status(400).json({ message: "walletAddress required" });

      const { getRewardWalletBalance, transferRewardToUser, getRewardWalletAddress } = await import("./reward-wallet");
      const rwBal = await getRewardWalletBalance();
      const available = Math.max(0, rwBal.sui - 0.01);

      if (available < 0.001) {
        return res.status(400).json({
          message: `Reward wallet has ${rwBal.sui.toFixed(4)} SUI on-chain but needs at least 0.011 SUI to cover gas. Nothing to claim.`,
          balance: rwBal.sui,
        });
      }

      const tx = await transferRewardToUser(walletAddress, available);

      // Mark as many pending_escrow orphaned rewards as paid as possible (cleanup)
      const allRewards = await storage.getRewards();
      const orphanableRewards = allRewards.filter(r =>
        r.status === "pending" && r.escrowTxDigest === "pending_escrow"
      );
      let settled = 0;
      const allAgents = await storage.getAgents();
      const agentIds = new Set(allAgents.map(a => a.id));
      for (const r of orphanableRewards) {
        if (!agentIds.has(r.agentId) && settled + r.amount <= available + 0.001) {
          await storage.claimReward(r.id, tx.txDigest, null);
          settled += r.amount;
        }
      }

      console.log(`[Rewards] Direct wallet claim: ${available.toFixed(4)} SUI → ${walletAddress.slice(0, 10)}... (tx: ${tx.txDigest}). Settled ${settled.toFixed(4)} SUI of orphaned reward records.`);

      res.json({
        success: true,
        amount: available,
        txDigest: tx.txDigest,
        orphanedSettled: settled,
        message: `${available.toFixed(4)} SUI transferred from reward wallet to your address.`,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to claim reward wallet balance" });
    }
  });

  // Agent Graveyard — list all deleted agents with preserved keypairs
  app.get("/api/rewards/graveyard", async (_req, res) => {
    try {
      const entries = await storage.getGraveyardEntries();
      const { getOnChainBalance } = await import("./sui-verify");

      const enriched = await Promise.all(entries.map(async (entry) => {
        let onChainBalance = 0;
        try {
          const bal = await getOnChainBalance(entry.walletAddress);
          onChainBalance = bal.sui;
        } catch {}
        return {
          ...entry,
          agentWallet: undefined, // never expose keypair to frontend
          onChainBalance,
          recoverable: onChainBalance > 0.001 && !entry.recoveredAt,
        };
      }));

      const totalRecoverable = enriched.filter(e => e.recoverable).reduce((s, e) => s + e.onChainBalance, 0);

      res.json({ entries: enriched, totalRecoverable });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to get graveyard" });
    }
  });

  // Recover SUI from a specific graveyard wallet to the user's connected wallet
  app.post("/api/rewards/graveyard/:id/recover", async (req, res) => {
    try {
      const { id } = req.params;
      const { walletAddress: toAddress } = req.body;
      if (!toAddress) return res.status(400).json({ message: "walletAddress required" });

      const entry = await storage.getGraveyardEntry(id);
      if (!entry) return res.status(404).json({ message: "Graveyard entry not found" });
      if (entry.recoveredAt) {
        return res.status(400).json({ message: `Already recovered on ${new Date(entry.recoveredAt).toLocaleDateString()}` });
      }
      if (!entry.agentWallet) {
        return res.status(400).json({ message: "No keypair stored for this agent" });
      }

      const { getOnChainBalance } = await import("./sui-verify");
      const bal = await getOnChainBalance(entry.walletAddress);
      const available = Math.max(0, bal.sui - 0.005); // keep 0.005 for gas
      if (available < 0.001) {
        return res.status(400).json({
          message: `Wallet has ${bal.sui.toFixed(4)} SUI — not enough to recover (min 0.006 SUI needed after gas).`,
          balance: bal.sui,
        });
      }

      // Decrypt keypair and transfer to the target address
      const { transferFromAgentWallet } = await import("./reward-wallet");
      const tx = await transferFromAgentWallet(entry.agentWallet, entry.walletAddress, toAddress, available);

      await storage.markGraveyardRecovered(id, tx.txDigest, available);

      // Also settle orphaned reward records for this agent
      const allRewards = await storage.getRewards();
      const agentOrphaned = allRewards.filter(r =>
        r.agentId === entry.originalAgentId && r.status === "pending"
      );
      for (const r of agentOrphaned) {
        await storage.claimReward(r.id, tx.txDigest, null);
      }

      console.log(`[Graveyard] Recovered ${available.toFixed(4)} SUI from ${entry.agentName} (${entry.walletAddress.slice(0, 10)}...) → ${toAddress.slice(0, 10)}... (tx: ${tx.txDigest})`);

      res.json({
        success: true,
        agentName: entry.agentName,
        amount: available,
        txDigest: tx.txDigest,
        settledRewards: agentOrphaned.length,
        message: `${available.toFixed(4)} SUI recovered from ${entry.agentName}`,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to recover graveyard funds" });
    }
  });

  // Summary of orphaned rewards (from deleted agents)
  app.get("/api/rewards/orphaned", async (_req, res) => {
    try {
      const allRewards = await storage.getRewards();
      const allAgents = await storage.getAgents();
      const agentIds = new Set(allAgents.map(a => a.id));

      const orphaned = allRewards.filter(r =>
        r.status === "pending" && !agentIds.has(r.agentId)
      );
      const totalOrphaned = orphaned.reduce((s, r) => s + r.amount, 0);

      // Group by agent name/id for display
      const byAgent = new Map<string, { agentId: string; agentName: string; total: number; count: number; escrowStatus: string }>();
      for (const r of orphaned) {
        const key = r.agentId;
        const existing = byAgent.get(key) || { agentId: r.agentId, agentName: r.agentName || r.agentId.slice(0, 8), total: 0, count: 0, escrowStatus: r.escrowTxDigest || "unknown" };
        existing.total += r.amount;
        existing.count++;
        byAgent.set(key, existing);
      }

      const { getRewardWalletBalance, getRewardWalletAddress } = await import("./reward-wallet");
      const rwBal = await getRewardWalletBalance();
      const rwAddr = getRewardWalletAddress();

      res.json({
        orphanedCount: orphaned.length,
        totalOrphaned,
        byAgent: Array.from(byAgent.values()),
        rewardWalletBalance: rwBal.sui,
        rewardWalletAddress: rwAddr,
        claimableFromWallet: Math.max(0, rwBal.sui - 0.01),
        note: totalOrphaned > 0
          ? "These rewards are from deleted agents. The agent keypairs are no longer available, so funds cannot be transferred from the original agent wallets. However, you can claim whatever is currently in the reward wallet."
          : "No orphaned rewards found.",
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to get orphaned rewards" });
    }
  });

  app.post("/api/rewards/claim-all-agents", async (req, res) => {
    try {
      const { signature, message: signedMessage, walletAddress } = req.body;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required to claim rewards" });
      }

      if (!signature || !signedMessage) {
        return res.status(400).json({ message: "Wallet signature required" });
      }

      try {
        const { verifyPersonalMessageSignature } = await import("@mysten/sui/verify");
        const messageBytes = new TextEncoder().encode(signedMessage);
        const result = await verifyPersonalMessageSignature(messageBytes, signature);
        if (result.toSuiAddress().toLowerCase() !== walletAddress.toLowerCase()) {
          return res.status(403).json({ message: "Signature does not match wallet address" });
        }
      } catch (verifyErr: any) {
        return res.status(403).json({ message: "Invalid signature: " + (verifyErr?.message || "verification failed") });
      }

      if (!signedMessage.includes(walletAddress)) {
        return res.status(403).json({ message: "Signed message does not match wallet address" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      if (!user) {
        return res.status(403).json({ message: "No user found for this wallet" });
      }

      const allAgents = await storage.getAgents();
      const allRewardsForClaim = await storage.getRewards();
      const retainedPendingForClaim = allRewardsForClaim.filter(r => r.status === "pending" && r.escrowTxDigest === "agent_retained");

      const agentsWithPendingRewards = new Map<string, number>();
      for (const r of retainedPendingForClaim) {
        agentsWithPendingRewards.set(r.agentId, (agentsWithPendingRewards.get(r.agentId) || 0) + r.amount);
      }

      const userAgents = allAgents.filter(a => {
        if (a.userId === user.id && (agentsWithPendingRewards.get(a.id) || 0) > 0) return true;
        return false;
      });

      const depositorAgentIds = new Set<string>();
      for (const agent of allAgents) {
        if ((agentsWithPendingRewards.get(agent.id) || 0) > 0 && agent.userId !== user.id) {
          const deposits = await storage.getDepositsByAgent(agent.id);
          if (deposits.some(d => d.depositorAddress.toLowerCase() === walletAddress.toLowerCase())) {
            depositorAgentIds.add(agent.id);
          }
        }
      }
      const depositorAgents = allAgents.filter(a => depositorAgentIds.has(a.id));
      const claimableAgents = [...userAgents, ...depositorAgents];

      if (claimableAgents.length === 0) {
        return res.status(400).json({ message: "No agents with claimable rewards found" });
      }

      const { transferFromAgentWallet } = await import("./reward-wallet");
      const { getOnChainBalance } = await import("./sui-verify");
      const results: Array<{ agentId: string; agentName: string; amount: number; txDigest: string; error?: string }> = [];
      let totalTransferred = 0;

      for (const agent of claimableAgents) {
        const claimKey = `agent_${agent.id}`;
        if (claimInProgress.has(claimKey)) {
          results.push({ agentId: agent.id, agentName: agent.name, amount: 0, txDigest: "", error: "Claim already in progress" });
          continue;
        }

        if (!agent.agentWallet || !agent.walletAddress) continue;

        const agentPendingRewards = retainedPendingForClaim.filter(r => r.agentId === agent.id);
        const totalPendingAmount = agentPendingRewards.reduce((sum, r) => sum + r.amount, 0);
        if (totalPendingAmount <= 0) continue;

        claimInProgress.add(claimKey);
        try {
          const agentBalance = await getOnChainBalance(agent.walletAddress);
          const gasBudgetSui = 0.02;

          const positions = await storage.getPositions(agent.id);
          let lockedCollateral = 0;
          for (const p of positions) {
            if (p.status === "open" || p.status === "pending_open") {
              lockedCollateral += p.collateral || (p.sizeSui / (agent.leverage || 1));
            }
          }

          const freeSui = Math.max(0, agentBalance.sui - lockedCollateral - gasBudgetSui);

          if (freeSui < 0.001) {
            results.push({ agentId: agent.id, agentName: agent.name, amount: 0, txDigest: "", error: `Agent wallet has ${agentBalance.sui.toFixed(4)} SUI (${lockedCollateral.toFixed(4)} locked in positions). Rewards (${totalPendingAmount.toFixed(4)} SUI earned) claimable once positions close.` });
            console.log(`[Rewards] Cannot claim from ${agent.name}: wallet has ${agentBalance.sui.toFixed(4)} SUI, ${lockedCollateral.toFixed(4)} locked. Earned=${totalPendingAmount.toFixed(4)} SUI.`);
            continue;
          }

          const transferAmount = Math.min(totalPendingAmount, freeSui);
          const isPartial = transferAmount < totalPendingAmount - 0.001;

          const transferResult = await transferFromAgentWallet(agent.agentWallet, agent.walletAddress, walletAddress, transferAmount);
          await storage.updateAgent(agent.id, { ownerClaimableBalance: 0 });

          let claimedSoFar = 0;
          const sortedPendingRewards = agentPendingRewards.sort((a: any, b: any) => a.amount - b.amount);
          for (const reward of sortedPendingRewards) {
            if (claimedSoFar + reward.amount <= transferAmount + 0.001) {
              await storage.claimReward(reward.id, transferResult.txDigest, null);
              claimedSoFar += reward.amount;
            }
          }
          if (claimedSoFar < transferAmount - 0.001 && sortedPendingRewards.length > 0) {
            const unclaimed = sortedPendingRewards.filter(r => !claimedSoFar || r.amount > transferAmount - claimedSoFar);
            if (unclaimed.length > 0) {
              await storage.claimReward(unclaimed[0].id, transferResult.txDigest, null);
              claimedSoFar += unclaimed[0].amount;
            }
          }

          await storage.createVerifiedTransaction({
            txDigest: transferResult.txDigest,
            txType: "reward_claim",
            agentId: agent.id,
            userId: agent.userId,
            sender: agent.walletAddress,
            checkpoint: null,
            rawData: { amount: transferAmount, toAddress: walletAddress, type: "agent_reward_claim_all", fromAgentWallet: true, partial: isPartial },
          }).catch(() => {});

          const remainingPending = totalPendingAmount - transferAmount;
          const partialNote = isPartial ? ` (partial: ${transferAmount.toFixed(4)} of ${totalPendingAmount.toFixed(4)} earned — rest not yet backed by free balance)` : "";
          results.push({ agentId: agent.id, agentName: agent.name, amount: transferAmount, txDigest: transferResult.txDigest, ...(isPartial && { error: `Partial claim: ${remainingPending.toFixed(4)} SUI earned but not yet backed by free balance` }) });
          totalTransferred += transferAmount;
          console.log(`[Rewards] Claimed ${transferAmount.toFixed(4)} SUI from ${agent.name} wallet${partialNote}`);
        } catch (err: any) {
          results.push({ agentId: agent.id, agentName: agent.name, amount: totalPendingAmount, txDigest: "", error: err.message });
          console.log(`[Rewards] Failed to claim from ${agent.name}: ${err.message}`);
        } finally {
          claimInProgress.delete(claimKey);
        }
      }

      res.json({
        success: true,
        totalTransferred,
        claimed: results.filter(r => !r.error).length,
        failed: results.filter(r => !!r.error).length,
        results,
      });
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      if (errMsg.includes("429") || errMsg.includes("rate limit")) {
        res.status(429).json({ message: "SUI network is busy. Please wait a moment and try again." });
      } else {
        res.status(500).json({ message: e.message || "Failed to claim rewards" });
      }
    }
  });

  app.post("/api/rewards/:id/claim", async (req, res) => {
    try {
      const { id } = req.params;
      const { txDigest: authTxDigest, signature, message: signedMessage, walletAddress } = req.body;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required to claim rewards" });
      }

      if (signature && signedMessage) {
        try {
          const { verifyPersonalMessageSignature } = await import("@mysten/sui/verify");
          const messageBytes = new TextEncoder().encode(signedMessage);
          const result = await verifyPersonalMessageSignature(messageBytes, signature);
          if (result.toSuiAddress().toLowerCase() !== walletAddress.toLowerCase()) {
            return res.status(403).json({ message: "Signature does not match wallet address" });
          }
        } catch (verifyErr: any) {
          return res.status(403).json({ message: "Invalid signature: " + (verifyErr?.message || "verification failed") });
        }
        if (!signedMessage.includes(walletAddress)) {
          return res.status(403).json({ message: "Signed message does not match wallet address" });
        }
      } else if (authTxDigest) {
        const authResult = await verifyTxDigest(authTxDigest);
        if (!authResult.sender || authResult.sender.toLowerCase() !== walletAddress.toLowerCase()) {
          return res.status(403).json({ message: "Authorization transaction sender does not match your wallet." });
        }
      } else {
        return res.status(400).json({ message: "Wallet signature or authorization transaction required" });
      }

      const allRewards = await storage.getRewards();
      const reward = allRewards.find((r) => r.id === id);
      if (!reward) {
        return res.status(404).json({ message: "Reward not found" });
      }

      if (reward.status === "claimed") {
        return res.status(400).json({ message: "Reward already claimed" });
      }

      if (!reward.escrowTxDigest || reward.escrowTxDigest === "pending_escrow") {
        const agent = await storage.getAgent(reward.agentId);
        if (agent?.agentWallet && agent?.walletAddress) {
          try {
            const { escrowRewardFromAgent } = await import("./reward-wallet");
            const { getOnChainBalance } = await import("./sui-verify");
            const bal = await getOnChainBalance(agent.walletAddress);
            if (bal.sui >= reward.amount + 0.01) {
              const escrowResult = await escrowRewardFromAgent(agent.agentWallet, agent.walletAddress, reward.amount);
              await storage.updateReward(reward.id, { escrowTxDigest: escrowResult.txDigest });
              reward.escrowTxDigest = escrowResult.txDigest;
              console.log(`[Rewards] On-demand escrow succeeded for reward ${reward.id}: ${reward.amount.toFixed(4)} SUI — tx: ${escrowResult.txDigest}`);
            } else {
              console.log(`[Rewards] On-demand escrow skipped for reward ${reward.id}: agent wallet has ${bal.sui.toFixed(4)} SUI, need ${(reward.amount + 0.01).toFixed(4)} SUI`);
            }
          } catch (escrowErr: any) {
            console.log(`[Rewards] On-demand escrow failed for reward ${reward.id}: ${escrowErr.message}`);
          }
        }

        if (!reward.escrowTxDigest || reward.escrowTxDigest === "pending_escrow") {
          return res.status(400).json({ message: "This reward is pending escrow — the agent wallet needs more SUI to transfer the reward. Try again after a gas top-off." });
        }
      }

      const agent = await storage.getAgent(reward.agentId);
      const user = await storage.getUserByWallet(walletAddress);

      if (agent) {
        const isOwner = user && user.id === agent.userId;
        const deposits = await storage.getDepositsByAgent(agent.id);
        const isDepositor = deposits.some(d => d.depositorAddress.toLowerCase() === walletAddress.toLowerCase());
        if (!isOwner && !isDepositor) {
          return res.status(403).json({ message: "Only the agent creator or depositor can claim rewards" });
        }
      } else {
        if (!user || user.id !== reward.userId) {
          return res.status(403).json({ message: "Only the original reward owner can claim rewards for deleted agents" });
        }
      }

      const transferResult = await transferRewardToUser(walletAddress, reward.amount);

      const claimed = await storage.claimReward(id, transferResult.txDigest, null);

      await storage.createVerifiedTransaction({
        txDigest: transferResult.txDigest,
        txType: "reward_claim",
        agentId: reward.agentId,
        userId: reward.userId,
        sender: getRewardWalletAddress(),
        checkpoint: null,
        rawData: { amount: reward.amount, toAddress: walletAddress, authMethod: signature ? "signed_message" : "tx_digest", type: "reward_claim", fromRewardWallet: true },
      }).catch(() => {});

      res.json({ ...claimed, transferTxDigest: transferResult.txDigest, transferredAmount: reward.amount });
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      if (errMsg.includes("429") || errMsg.includes("rate limit") || errMsg.includes("Too Many Requests")) {
        res.status(429).json({ message: "SUI network is busy. Please wait a moment and try again." });
      } else {
        res.status(500).json({ message: e.message || "Failed to claim reward" });
      }
    }
  });

  app.post("/api/rewards/claim-all", async (req, res) => {
    try {
      const { txDigest: authTxDigest, signature, message: signedMessage, walletAddress } = req.body;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required to claim rewards" });
      }

      if (signature && signedMessage) {
        try {
          const { verifyPersonalMessageSignature } = await import("@mysten/sui/verify");
          const messageBytes = new TextEncoder().encode(signedMessage);
          const result = await verifyPersonalMessageSignature(messageBytes, signature);
          if (result.toSuiAddress().toLowerCase() !== walletAddress.toLowerCase()) {
            return res.status(403).json({ message: "Signature does not match wallet address" });
          }
        } catch (verifyErr: any) {
          return res.status(403).json({ message: "Invalid signature: " + (verifyErr?.message || "verification failed") });
        }
        if (!signedMessage.includes(walletAddress)) {
          return res.status(403).json({ message: "Signed message does not match wallet address" });
        }
      } else if (authTxDigest) {
        const authResult = await verifyTxDigest(authTxDigest);
        if (!authResult.sender || authResult.sender.toLowerCase() !== walletAddress.toLowerCase()) {
          return res.status(403).json({ message: "Authorization transaction sender does not match your wallet." });
        }
      } else {
        return res.status(400).json({ message: "Wallet signature or authorization transaction required" });
      }

      const allRewards = await storage.getRewards();
      const pendingRewards = allRewards.filter((r) => r.status === "pending" && r.escrowTxDigest && r.escrowTxDigest !== "pending_escrow");

      if (pendingRewards.length === 0) {
        return res.status(400).json({ message: "No escrowed rewards to claim" });
      }

      const authorizedRewards: typeof pendingRewards = [];
      const user = await storage.getUserByWallet(walletAddress);
      for (const reward of pendingRewards) {
        const agent = await storage.getAgent(reward.agentId);

        if (agent) {
          const isOwner = user && user.id === agent.userId;
          const deposits = await storage.getDepositsByAgent(agent.id);
          const isDepositor = deposits.some(d => d.depositorAddress.toLowerCase() === walletAddress.toLowerCase());
          if (isOwner || isDepositor) {
            authorizedRewards.push(reward);
          }
        } else {
          if (user && user.id === reward.userId) {
            authorizedRewards.push(reward);
          }
        }
      }

      if (authorizedRewards.length === 0) {
        return res.status(403).json({ message: "No rewards found for your wallet" });
      }

      const totalAmount = authorizedRewards.reduce((sum, r) => sum + r.amount, 0);

      const { getRewardWalletBalance } = await import("./reward-wallet");
      const walletBalance = await getRewardWalletBalance();
      const gasBudgetSui = 0.01;
      const availableSui = walletBalance.sui - gasBudgetSui;

      const onlyEscrowedRewards = authorizedRewards.filter(r => !!(r as any).escrowTxDigest);
      const escrowedTotal = onlyEscrowedRewards.reduce((sum, r) => sum + r.amount, 0);

      let claimAmount = Math.min(totalAmount, escrowedTotal);
      if (availableSui < claimAmount) {
        claimAmount = Math.floor(availableSui * 10000) / 10000;
      }
      if (claimAmount <= 0) {
        return res.status(400).json({ message: `Reward wallet balance too low. Available: ${availableSui.toFixed(4)} SUI. Please try again later.` });
      }

      const transferResult = await transferRewardToUser(walletAddress, claimAmount);

      let totalClaimed = 0;
      let remainingToClaim = claimAmount;
      const escrowedOnly = authorizedRewards.filter(r => !!r.escrowTxDigest);
      const sortedRewards = [...escrowedOnly].sort((a, b) => a.amount - b.amount);
      for (const reward of sortedRewards) {
        if (remainingToClaim >= reward.amount - 0.0001) {
          await storage.claimReward(reward.id, transferResult.txDigest, null);
          remainingToClaim -= reward.amount;
          totalClaimed++;
        }
      }

      if (totalClaimed === 0 && claimAmount > 0 && sortedRewards.length > 0) {
        await storage.claimReward(sortedRewards[0].id, transferResult.txDigest, authResult.checkpoint);
        totalClaimed++;
      }

      await storage.createVerifiedTransaction({
        txDigest: transferResult.txDigest,
        txType: "reward_claim",
        agentId: authorizedRewards[0].agentId,
        userId: authorizedRewards[0].userId,
        sender: getRewardWalletAddress(),
        checkpoint: null,
        rawData: { amount: claimAmount, toAddress: walletAddress, authTxDigest, type: "reward_claim_all", rewardCount: totalClaimed, fromRewardWallet: true },
      }).catch(() => {});

      const partialClaim = claimAmount < totalAmount;
      res.json({
        success: true,
        claimed: totalClaimed,
        totalTransferred: claimAmount,
        transferTxDigest: transferResult.txDigest,
        transfers: [{ txDigest: transferResult.txDigest, amount: claimAmount, rewardsClaimed: totalClaimed }],
        ...(partialClaim && { note: `Partial claim: ${claimAmount.toFixed(4)} of ${totalAmount.toFixed(4)} SUI transferred due to reward wallet balance. Remainder stays pending.` }),
      });
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      if (errMsg.includes("429") || errMsg.includes("rate limit") || errMsg.includes("Too Many Requests")) {
        res.status(429).json({ message: "SUI network is busy. Please wait a moment and try again." });
      } else {
        res.status(500).json({ message: e.message || "Failed to claim all rewards" });
      }
    }
  });

  app.post("/api/admin/fix-corrupted-data", async (_req, res) => {
    try {
      const allAgents = await storage.getAgents();
      const allRewards = await storage.getRewards();
      const results: any[] = [];

      for (const agent of allAgents) {
        const positions = await storage.getPositions(agent.id);
        const closedPositions = positions.filter(p => p.status === "closed");

        const bogusPositions = closedPositions.filter(p => p.markPrice !== null && p.markPrice > 1.5);

        if (bogusPositions.length === 0) continue;

        for (const pos of bogusPositions) {
          await storage.updatePosition(pos.id, {
            markPrice: pos.entryPrice,
            unrealizedPnl: 0,
          });
        }

        const agentRewards = allRewards.filter(r => r.agentId === agent.id);
        let voidedCount = 0;
        let resetCount = 0;

        for (const reward of agentRewards) {
          if (reward.amount > 5 && bogusPositions.length > 0) {
            await storage.voidReward(reward.id);
            voidedCount++;
          } else if (reward.status === "claimed" && reward.amount <= 5) {
            const hasRealTransfer = reward.txDigest ?
              (await storage.getVerifiedTransactionByDigest(reward.txDigest))?.txType === "reward_claim" : false;
            if (!hasRealTransfer) {
              await storage.resetRewardToPending(reward.id);
              resetCount++;
            }
          }
        }

        let recalcPnl = 0;
        let wins = 0;
        const freshPositions = await storage.getPositions(agent.id);
        const freshClosed = freshPositions.filter(p => p.status === "closed");
        for (const pos of freshClosed) {
          const collateral = pos.collateral || (pos.sizeSui / agent.leverage);
          const cappedPnl = Math.max(-collateral, pos.unrealizedPnl || 0);
          recalcPnl += cappedPnl;
          if (cappedPnl > 0) wins++;
        }

        const totalTrades = freshPositions.length;
        const winRate = freshClosed.length > 0 ? wins / freshClosed.length : 0;

        await storage.updateAgent(agent.id, {
          totalPnl: recalcPnl,
          totalTrades,
          winRate,
          balance: Math.max(0, agent.balance),
        });

        results.push({
          agentId: agent.id,
          name: agent.name,
          bogusPositionsFixed: bogusPositions.length,
          rewardsVoided: voidedCount,
          rewardsReset: resetCount,
          newPnl: recalcPnl,
          oldPnl: agent.totalPnl,
          newBalance: Math.max(0, agent.balance),
        });
      }

      res.json({ success: true, results });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to fix corrupted data" });
    }
  });

  app.post("/api/admin/backfill-rewards", async (_req, res) => {
    try {
      const allAgents = await storage.getAgents();
      const existingRewards = await storage.getRewards();
      let created = 0;
      let winRatesUpdated = 0;

      for (const agent of allAgents) {
        const allPositions = await storage.getPositions(agent.id);
        const closedPositions = allPositions.filter(p => p.status === "closed");

        if (closedPositions.length === 0) continue;

        const totalClosed = closedPositions.length;
        const totalWins = closedPositions.filter(p => {
          const realizedPnl = p.unrealizedPnl || 0;
          return realizedPnl > 0;
        }).length;
        const newWinRate = totalClosed > 0 ? totalWins / totalClosed : 0;

        if (Math.abs(agent.winRate - newWinRate) > 0.001) {
          await storage.updateAgent(agent.id, { winRate: newWinRate });
          winRatesUpdated++;
        }

        const agentRewards = existingRewards.filter(r => r.agentId === agent.id);
        const profitablePositions = closedPositions.filter(p => (p.unrealizedPnl || 0) > 0);

        if (agentRewards.length >= profitablePositions.length) continue;

        const rewardSharePct = agent.rewardSharePct ?? 50;
        if (rewardSharePct <= 0) continue;

        const existingAmountSet = new Set(agentRewards.map(r => Math.round(r.amount * 10000)));

        for (const pos of profitablePositions) {
          const realizedPnl = pos.unrealizedPnl || 0;
          const rewardAmount = realizedPnl * (rewardSharePct / 100);
          if (rewardAmount <= 0) continue;

          const roundedAmount = Math.round(rewardAmount * 10000);
          if (existingAmountSet.has(roundedAmount)) {
            existingAmountSet.delete(roundedAmount);
            continue;
          }

          await storage.createReward({
            agentId: agent.id,
            userId: agent.userId,
            amount: rewardAmount,
            agentName: agent.name,
          });
          created++;
        }
      }

      res.json({ success: true, rewardsCreated: created, winRatesUpdated });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Backfill failed" });
    }
  });

  app.post("/api/admin/migrate-reward-wallet", async (req, res) => {
    try {
      const { signature, message: signedMessage, walletAddress } = req.body;
      if (!walletAddress || !signature || !signedMessage) {
        return res.status(400).json({ message: "Wallet address, signature, and signed message required" });
      }
      try {
        const { verifyPersonalMessageSignature } = await import("@mysten/sui/verify");
        const messageBytes = new TextEncoder().encode(signedMessage);
        const result = await verifyPersonalMessageSignature(messageBytes, signature);
        if (result.toSuiAddress().toLowerCase() !== walletAddress.toLowerCase()) {
          return res.status(403).json({ message: "Signature does not match wallet address" });
        }
      } catch (verifyErr: any) {
        return res.status(403).json({ message: "Invalid signature" });
      }
      const user = await storage.getUserByWallet(walletAddress);
      if (!user) {
        return res.status(403).json({ message: "Unauthorized" });
      }
      const userAgents = (await storage.getAgents()).filter(a => a.userId === user.id);
      if (userAgents.length === 0) {
        return res.status(403).json({ message: "Unauthorized — no agents found" });
      }

      const { db } = await import("./db");
      const { systemConfig } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const migrationCheck = await db.select().from(systemConfig).where(eq(systemConfig.key, "reward_wallet_migrated"));
      if (migrationCheck.length > 0) {
        return res.status(400).json({ message: "Migration already completed", completedAt: migrationCheck[0].value });
      }

      const allRewards = await storage.getRewards();
      const allAgents = await storage.getAgents();
      const agentMap = new Map(allAgents.map(a => [a.id, a]));
      const results: string[] = [];

      const pendingEscrowRewards = allRewards.filter(r => r.status === "pending" && r.escrowTxDigest === "pending_escrow");
      let convertedCount = 0;
      const agentCredits = new Map<string, number>();

      for (const reward of pendingEscrowRewards) {
        await storage.updateReward(reward.id, { escrowTxDigest: "agent_retained" });
        const current = agentCredits.get(reward.agentId) || 0;
        agentCredits.set(reward.agentId, current + reward.amount);
        convertedCount++;
      }

      for (const [agentId, creditAmount] of agentCredits.entries()) {
        const agent = agentMap.get(agentId);
        if (agent) {
          const currentClaimable = agent.ownerClaimableBalance || 0;
          await storage.updateAgent(agentId, { ownerClaimableBalance: currentClaimable + creditAmount });
          results.push(`Credited ${creditAmount.toFixed(4)} SUI to ${agent.name} ownerClaimableBalance (from ${pendingEscrowRewards.filter(r => r.agentId === agentId).length} pending_escrow rewards)`);
        }
      }

      const voidedWithEscrow = allRewards.filter(r => r.status === "voided" && r.escrowTxDigest && r.escrowTxDigest !== "pending_escrow" && r.escrowTxDigest !== "agent_retained");
      let voidedCredited = 0;
      const voidedCredits = new Map<string, number>();

      for (const reward of voidedWithEscrow) {
        const current = voidedCredits.get(reward.agentId) || 0;
        voidedCredits.set(reward.agentId, current + reward.amount);
      }

      for (const [agentId, creditAmount] of voidedCredits.entries()) {
        const agent = agentMap.get(agentId);
        if (agent) {
          const freshAgent = await storage.getAgent(agentId);
          const currentClaimable = freshAgent?.ownerClaimableBalance || 0;
          await storage.updateAgent(agentId, { ownerClaimableBalance: currentClaimable + creditAmount });
          voidedCredited++;
          results.push(`Credited ${creditAmount.toFixed(4)} SUI to ${agent.name} ownerClaimableBalance (from ${voidedWithEscrow.filter(r => r.agentId === agentId).length} voided rewards stuck in reward wallet)`);
        }
      }

      const pendingWithRealEscrow = allRewards.filter(r => r.status === "pending" && r.escrowTxDigest && r.escrowTxDigest !== "pending_escrow" && r.escrowTxDigest !== "agent_retained");
      results.push(`Legacy escrowed rewards (still in reward wallet): ${pendingWithRealEscrow.length} records, ${pendingWithRealEscrow.reduce((s, r) => s + r.amount, 0).toFixed(4)} SUI — these can still be claimed via legacy endpoint`);

      await db.insert(systemConfig).values({ key: "reward_wallet_migrated", value: new Date().toISOString() }).onConflictDoUpdate({ target: systemConfig.key, set: { value: new Date().toISOString() } });

      res.json({
        success: true,
        convertedPendingEscrow: convertedCount,
        voidedCredited,
        legacyEscrowedRemaining: pendingWithRealEscrow.length,
        details: results,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Migration failed" });
    }
  });

  app.get("/api/bundles", async (_req, res) => {
    try {
      const bundles = await storage.getInstructionBundles();
      const allExecutions = await storage.getBundleExecutions();
      const execMap = new Map(allExecutions.map(e => [e.bundleId, e]));
      const enriched = bundles.map(b => ({
        ...b,
        executionError: execMap.get(b.bundleId)?.error || null,
        executionTxDigest: execMap.get(b.bundleId)?.txDigest || null,
      }));
      res.json(enriched);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/bundles/:agentId/latest", async (req, res) => {
    try {
      const agentId = req.params.agentId;
      const bundles = await storage.getInstructionBundles(agentId);
      const executions = await storage.getBundleExecutions(agentId);
      const execMap = new Map(executions.map(e => [e.bundleId, e]));
      const enriched = bundles.map(b => ({
        ...b,
        executionError: execMap.get(b.bundleId)?.error || null,
        executionTxDigest: execMap.get(b.bundleId)?.txDigest || null,
      }));
      res.json(enriched);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/bundles/executions/:agentId", async (req, res) => {
    try {
      const agentId = req.params.agentId;
      const executions = await storage.getBundleExecutions(agentId);
      res.json(executions);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/recovery/analyze-tx", async (req, res) => {
    try {
      const { txDigest } = req.body;
      if (!txDigest || typeof txDigest !== "string") {
        return res.status(400).json({ message: "txDigest is required" });
      }

      const result = await verifyTxDigest(txDigest);
      const sender = result.sender || "unknown";
      const checkpoint = result.checkpoint;

      const balanceChanges = result.balanceChanges || [];
      const suiChanges = balanceChanges.filter((bc: any) =>
        bc.coinType === "0x2::sui::SUI" || bc.coinType === "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
      );

      const protocolFeeAddr = PROTOCOL_FEE_ADDRESS.toLowerCase();
      const senderAddr = sender.toLowerCase();

      const transfers = suiChanges.map((bc: any) => {
        const owner = bc.owner?.AddressOwner || "unknown";
        const amount = Number(bc.amount) / 1e9;
        let role = "unknown";
        if (owner.toLowerCase() === protocolFeeAddr) role = "protocol_fee";
        else if (owner.toLowerCase() === senderAddr) role = "sender";
        else if (Number(bc.amount) > 0) role = "agent_wallet";
        return { address: owner, amount, role, rawMist: bc.amount };
      });

      const agentTransfer = transfers.find((t: any) => t.role === "agent_wallet");
      const feeTransfer = transfers.find((t: any) => t.role === "protocol_fee");

      let agentBalance = null;
      if (agentTransfer) {
        try {
          const bal = await getOnChainBalance(agentTransfer.address);
          agentBalance = bal.sui;
        } catch {}
      }

      const existingAgent = agentTransfer
        ? await storage.getAgentByWallet(agentTransfer.address).catch(() => null)
        : null;

      const existingDeposit = await storage.getDepositByTxDigest(txDigest).catch(() => null);
      const existingVerified = await storage.getVerifiedTransactionByDigest(txDigest).catch(() => null);

      res.json({
        txDigest,
        status: "success",
        sender,
        checkpoint,
        transfers,
        agentWallet: agentTransfer?.address || null,
        agentWalletBalance: agentBalance,
        protocolFee: feeTransfer?.amount || 0,
        grossDeposit: agentTransfer && feeTransfer ? agentTransfer.amount + feeTransfer.amount : null,
        netDeposit: agentTransfer?.amount || null,
        alreadyTracked: !!existingDeposit || !!existingVerified,
        agentExists: !!existingAgent,
        agentId: existingAgent?.id || null,
        recoverable: !existingDeposit && !!agentTransfer,
      });
    } catch (e: any) {
      res.status(500).json({ message: `Failed to analyze transaction: ${e.message}` });
    }
  });

  app.post("/api/recovery/import-deposit", async (req, res) => {
    try {
      const { txDigest, walletAddress } = req.body;
      if (!txDigest) {
        return res.status(400).json({ message: "txDigest is required" });
      }

      const existingDeposit = await storage.getDepositByTxDigest(txDigest).catch(() => null);
      if (existingDeposit) {
        return res.status(409).json({ message: "This transaction has already been imported", deposit: existingDeposit });
      }

      const existingVerified = await storage.getVerifiedTransactionByDigest(txDigest).catch(() => null);
      if (existingVerified) {
        return res.status(409).json({ message: "This transaction has already been verified and tracked", tx: existingVerified });
      }

      const result = await verifyTxDigest(txDigest);
      const sender = result.sender || "";
      const checkpoint = result.checkpoint;

      if (!sender) {
        return res.status(400).json({ message: "Could not determine sender from on-chain data" });
      }

      const balanceChanges = result.balanceChanges || [];
      const suiChanges = balanceChanges.filter((bc: any) =>
        bc.coinType === "0x2::sui::SUI" || bc.coinType === "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
      );

      const protocolFeeAddr = PROTOCOL_FEE_ADDRESS.toLowerCase();

      const feeChange = suiChanges.find((bc: any) => {
        const owner = ((bc.owner as any)?.AddressOwner || "").toLowerCase();
        return owner === protocolFeeAddr && Number(bc.amount) > 0;
      });

      if (!feeChange) {
        return res.status(400).json({ message: "No protocol fee transfer found - this does not appear to be a Blue Water deposit transaction" });
      }

      const agentChange = suiChanges.find((bc: any) => {
        const owner = ((bc.owner as any)?.AddressOwner || "").toLowerCase();
        return owner !== protocolFeeAddr && owner !== sender.toLowerCase() && Number(bc.amount) > 0;
      });

      if (!agentChange) {
        return res.status(400).json({ message: "No agent wallet transfer found in this transaction" });
      }

      const agentWalletAddr = (agentChange.owner as any)?.AddressOwner || "";
      const netAmount = Number(agentChange.amount) / 1e9;
      const feeAmount = Number(feeChange.amount) / 1e9;
      const grossAmount = netAmount + feeAmount;

      const expectedFeeRate = feeAmount / grossAmount;
      if (Math.abs(expectedFeeRate - PROTOCOL_FEE_RATE) > 0.005) {
        return res.status(400).json({
          message: `Fee rate mismatch: expected ${(PROTOCOL_FEE_RATE * 100).toFixed(1)}% but found ${(expectedFeeRate * 100).toFixed(1)}%. This may not be a Blue Water deposit.`,
        });
      }

      let agent = await storage.getAgentByWallet(agentWalletAddr).catch(() => null);
      let agentId = agent?.id;

      if (!agent && walletAddress) {
        let user = await storage.getUserByWallet(walletAddress);
        if (!user) {
          user = await storage.createUser({ walletAddress });
        }

        agent = await storage.createAgent({
          userId: user.id,
          name: `Recovered-${agentWalletAddr.slice(0, 8)}`,
          venue: "typus",
          leverage: 5,
          maxQty: 1,
          stopLossBps: 80,
          takeProfitBps: 200,
        });

        await storage.updateAgent(agent.id, {
          walletAddress: agentWalletAddr,
          status: "recovered",
        });
        agentId = agent.id;
      }

      if (!agentId) {
        return res.status(400).json({
          message: "Agent not found for this wallet address. Provide your walletAddress to create a recovery agent.",
          agentWallet: agentWalletAddr,
        });
      }

      await storage.depositToAgent(agentId, netAmount, txDigest, checkpoint);

      await storage.createDeposit({
        agentId,
        depositorAddress: sender,
        amount: netAmount,
        grossAmount,
        protocolFee: feeAmount,
        txDigest,
        verified: true,
        checkpoint: checkpoint ?? null,
      }).catch(() => {});

      await storage.createVerifiedTransaction({
        txDigest,
        txType: "deposit_recovery",
        agentId,
        userId: sender,
        sender,
        checkpoint: checkpoint ?? null,
        rawData: { netAmount, feeAmount, grossAmount, recoveredAt: new Date().toISOString() },
      }).catch(() => {});

      if (feeAmount > 0) {
        await storage.createProtocolFee({
          agentId,
          userId: sender,
          amount: feeAmount,
          txDigest,
        }).catch(() => {});
      }

      const updatedAgent = await storage.getAgent(agentId);
      res.json({
        success: true,
        txDigest,
        agentId,
        agentWallet: agentWalletAddr,
        netDeposit: netAmount,
        protocolFee: feeAmount,
        grossAmount,
        sender,
        agentBalance: updatedAgent?.balance || 0,
        recoveredAgent: !agent,
        message: `Successfully recovered deposit of ${grossAmount.toFixed(2)} SUI (${netAmount.toFixed(2)} net + ${feeAmount.toFixed(2)} fee)`,
      });
    } catch (e: any) {
      res.status(500).json({ message: `Recovery failed: ${e.message}` });
    }
  });

  app.post("/api/recovery/by-wallet", async (req, res) => {
    try {
      const { walletAddress } = req.body;
      if (!walletAddress || typeof walletAddress !== "string") {
        return res.status(400).json({ message: "walletAddress is required" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const walletAgents = user ? await storage.getAgents(user.id) : [];

      const recoveryItems: Array<{
        agentId: string;
        agentName: string;
        agentWallet: string;
        dbBalance: number;
        onChainBalance: number;
        difference: number;
        status: string;
        recoverable: boolean;
      }> = [];

      for (const agent of walletAgents) {
        if (!agent.walletAddress) continue;
        try {
          const onChain = await getOnChainBalance(agent.walletAddress);
          const diff = onChain.sui - agent.balance;
          recoveryItems.push({
            agentId: agent.id,
            agentName: agent.name,
            agentWallet: agent.walletAddress,
            dbBalance: agent.balance,
            onChainBalance: onChain.sui,
            difference: diff,
            status: agent.status,
            recoverable: diff > 0.001,
          });
        } catch {
          recoveryItems.push({
            agentId: agent.id,
            agentName: agent.name,
            agentWallet: agent.walletAddress || "",
            dbBalance: agent.balance,
            onChainBalance: -1,
            difference: 0,
            status: agent.status,
            recoverable: false,
          });
        }
      }

      const totalDbBalance = recoveryItems.reduce((s, r) => s + r.dbBalance, 0);
      const totalOnChain = recoveryItems.filter(r => r.onChainBalance >= 0).reduce((s, r) => s + r.onChainBalance, 0);
      const totalRecoverable = recoveryItems.filter(r => r.recoverable).reduce((s, r) => s + r.difference, 0);

      res.json({
        walletAddress,
        agentCount: recoveryItems.length,
        items: recoveryItems,
        totals: {
          dbBalance: totalDbBalance,
          onChainBalance: totalOnChain,
          recoverable: totalRecoverable,
        },
      });
    } catch (e: any) {
      res.status(500).json({ message: `Recovery scan failed: ${e.message}` });
    }
  });

  app.post("/api/recovery/sync-balance", async (req, res) => {
    try {
      const { agentId, walletAddress } = req.body;
      if (!agentId || !walletAddress) {
        return res.status(400).json({ message: "agentId and walletAddress are required" });
      }

      const agent = await storage.getAgent(agentId);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      if (!user || agent.userId !== user.id) {
        const isDefaultUser = user && user.walletAddress === "default-user";
        if (!isDefaultUser) {
          return res.status(403).json({ message: "Only the agent owner can sync balances" });
        }
      }

      if (!agent.walletAddress) {
        return res.status(400).json({ message: "Agent has no wallet address" });
      }

      const onChain = await getOnChainBalance(agent.walletAddress);

      let pendingOrderCollateral = 0;
      try {
        const adapter = getAdapter(agent.venue || "typus");
        if (adapter) {
          const { TypusAdapter } = await import("./dex/typus-adapter");
          if (adapter instanceof TypusAdapter) {
            const { unfilled, created } = await adapter.findAllUnfilledOrderIds(agent.walletAddress);
            for (const oid of unfilled) {
              const orderInfo = created.get(oid);
              if (orderInfo && !orderInfo.isReduceOnly && orderInfo.collateral > 0) {
                pendingOrderCollateral += orderInfo.collateral;
              }
            }
          }
        }
      } catch {}

      let lockedInPositions = 0;
      try {
        const adapter = getAdapter(agent.venue || "typus");
        if (adapter) {
          const openPositions = await adapter.getPositions(agent.walletAddress);
          for (const pos of openPositions) lockedInPositions += pos.collateral || 0;
        }
      } catch {}

      const totalOnChain = onChain.sui + lockedInPositions + pendingOrderCollateral;
      const diff = totalOnChain - agent.balance;

      const deposits = await storage.getDepositsByAgent(agentId);
      const netDeposited = deposits.reduce((sum: number, d: any) => sum + (d.amount || 0), 0);
      const allRewards = await storage.getRewards();
      const agentRewards = allRewards.filter((r: any) => r.agentId === agentId && r.status !== "voided");
      const totalRewardsPaid = agentRewards
        .filter((r: any) => r.escrowTxDigest && r.escrowTxDigest !== "pending_escrow")
        .reduce((sum: number, r: any) => sum + r.amount, 0);
      const impliedTotalPnl = (totalOnChain + totalRewardsPaid) - netDeposited;

      const previousBalance = agent.balance;
      const previousPnl = agent.totalPnl || 0;

      await storage.updateAgent(agentId, {
        balance: totalOnChain,
        totalPnl: impliedTotalPnl,
      });

      console.log(`[Recovery] Balance sync for ${agent.name}: DB balance ${previousBalance.toFixed(4)} → ${totalOnChain.toFixed(4)} SUI (on-chain=${onChain.sui.toFixed(4)}, lockedPositions=${lockedInPositions.toFixed(4)}, pendingOrders=${pendingOrderCollateral.toFixed(4)}), PnL ${previousPnl.toFixed(4)} → ${impliedTotalPnl.toFixed(4)}`);

      res.json({
        success: true,
        agentId,
        agentName: agent.name,
        previousBalance,
        newBalance: totalOnChain,
        balanceDiff: diff,
        previousPnl,
        newPnl: impliedTotalPnl,
        breakdown: {
          onChainWallet: parseFloat(onChain.sui.toFixed(6)),
          lockedInPositions: parseFloat(lockedInPositions.toFixed(6)),
          pendingOrderCollateral: parseFloat(pendingOrderCollateral.toFixed(6)),
          totalOnChain: parseFloat(totalOnChain.toFixed(6)),
          netDeposited: parseFloat(netDeposited.toFixed(6)),
          totalRewardsPaid: parseFloat(totalRewardsPaid.toFixed(6)),
          impliedPnl: parseFloat(impliedTotalPnl.toFixed(6)),
        },
        message: `Synced agent balance: ${previousBalance.toFixed(4)} → ${totalOnChain.toFixed(4)} SUI (${diff >= 0 ? "+" : ""}${diff.toFixed(4)} change), PnL: ${previousPnl.toFixed(4)} → ${impliedTotalPnl.toFixed(4)}`,
      });
    } catch (e: any) {
      res.status(500).json({ message: `Balance sync failed: ${e.message}` });
    }
  });

  const usedWithdrawAuthDigests: Record<string, { wallet: string; usedAt: number }> = {};
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    Object.keys(usedWithdrawAuthDigests).forEach(k => {
      if (usedWithdrawAuthDigests[k].usedAt < cutoff) delete usedWithdrawAuthDigests[k];
    });
  }, 60_000);

  app.post("/api/recovery/withdraw-to-wallet", async (req, res) => {
    try {
      const { agentId, walletAddress, authTxDigest } = req.body;
      if (!agentId || !walletAddress || !authTxDigest) {
        return res.status(400).json({ message: "agentId, walletAddress, and authTxDigest are required" });
      }

      const authResult = await verifyTxDigest(authTxDigest);
      if (!authResult.sender || authResult.sender.toLowerCase() !== walletAddress.toLowerCase()) {
        return res.status(403).json({ message: "Authorization transaction sender does not match your wallet address." });
      }

      const existingUse = usedWithdrawAuthDigests[authTxDigest];
      if (existingUse && existingUse.wallet.toLowerCase() !== walletAddress.toLowerCase()) {
        return res.status(403).json({ message: "Authorization digest already used by a different wallet." });
      }

      if (authResult.timestampMs) {
        const ageMs = Date.now() - authResult.timestampMs;
        if (ageMs > 5 * 60 * 1000) {
          return res.status(403).json({ message: "Authorization transaction is too old (>5 min). Please try again." });
        }
      }

      usedWithdrawAuthDigests[authTxDigest] = { wallet: walletAddress, usedAt: Date.now() };

      const agent = await storage.getAgent(agentId);
      if (!agent) return res.status(404).json({ message: "Agent not found" });

      const user = await storage.getUserByWallet(walletAddress);
      if (!user || agent.userId !== user.id) {
        return res.status(403).json({ message: "Only the agent owner can withdraw" });
      }

      if (!agent.agentWallet || !agent.walletAddress) {
        return res.status(400).json({ message: "Agent wallet not configured" });
      }

      if (agent.status === "recovered") {
        return res.status(400).json({ message: "Cannot withdraw from a recovered agent — the original signing keys were lost." });
      }

      const openPositions = (await storage.getPositions(agentId)).filter(p => (p.status === "open" || p.status === "pending_open"));
      
      // If user wants to "remove all collateral", they need to close positions first.
      // We already have a close-position logic in market-engine or routes.
      // But the user specifically asked to "Make the agent close all order to remove all collateral"
      // This implies we should trigger an emergency close if they try to withdraw and have positions.
      
      if (openPositions.length > 0) {
        const { closePositionForAgent } = await import("./dex/execution-engine");
        const { getLastPrice } = await import("./price-service");
        console.log(`[Withdraw] Emergency closing ${openPositions.length} positions for ${agent.name} to free collateral`);
        
        const priceTick = getLastPrice();
        const currentPrice = priceTick?.pyth?.price ?? priceTick?.blended ?? 0;
        if (currentPrice <= 0) {
          return res.status(500).json({ message: "Cannot close positions: no current price available. Try again shortly." });
        }
        for (const pos of openPositions) {
          try {
            await closePositionForAgent(agent, pos.id, currentPrice, false, "withdrawal");
            console.log(`[Withdraw] Successfully closed position ${pos.id} on-chain`);
          } catch (e: any) {
            console.warn(`[Withdraw] On-chain close failed for position ${pos.id}: ${e.message}. Position remains open — cannot proceed.`);
            return res.status(500).json({ message: `Cannot close position ${pos.id} on-chain: ${e.message}. Withdrawal blocked until all positions are closed.` });
          }
        }
      }

      // Re-fetch balance after closing positions
      const onChainBalance = await getOnChainBalance(agent.walletAddress);
      const gasBudget = BigInt(10_000_000);
      const gasReserveSui = 0.05; // Reduced reserve for total withdrawal
      const availableOnChain = Math.max(0, (Number(onChainBalance.mist) - Number(gasBudget)) / 1e9);
      const maxWithdraw = Math.max(0, availableOnChain - gasReserveSui);

      const withdrawMist = BigInt(Math.floor(maxWithdraw * 1e9));
      const { decryptKeypair } = await import("./dex/wallet-manager");
      const { Transaction } = await import("@mysten/sui/transactions");
      const keypair = decryptKeypair(agent.agentWallet);

      const tx = new Transaction();
      tx.setSender(agent.walletAddress);
      tx.setGasBudget(gasBudget);
      const [coin] = tx.splitCoins(tx.gas, [withdrawMist]);
      tx.transferObjects([coin], walletAddress);

      const { suiClient } = await import("./sui-verify");
      const result = await suiClient.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true },
      });

      if (result.effects?.status?.status !== "success") {
        return res.status(500).json({ message: "On-chain withdrawal transaction failed" });
      }

      const newBalance = Math.max(0, (agent.balance ?? 0) - maxWithdraw);
      await storage.updateAgent(agentId, { balance: newBalance });

      await storage.createVerifiedTransaction({
        txDigest: result.digest,
        txType: "recovery_withdraw",
        agentId,
        userId: agent.userId,
        sender: agent.walletAddress,
        checkpoint: null,
        rawData: { amount: maxWithdraw, toAddress: walletAddress },
      }).catch(() => {});

      broadcast("agent:updated", sanitizeAgent(await storage.getAgent(agentId)));

      res.json({
        success: true,
        txDigest: result.digest,
        amount: maxWithdraw,
        agentName: agent.name,
        message: `Withdrew ${maxWithdraw.toFixed(4)} SUI to your wallet`,
      });
    } catch (e: any) {
      res.status(500).json({ message: `Recovery withdrawal failed: ${e.message}` });
    }
  });

  app.post("/api/admin/cleanup-orphaned-agents", async (req, res) => {
    try {
      const allAgents = await storage.getAgents();
      const orphaned = allAgents.filter(a => a.userId === "default-user" || !a.userId);
      let deleted = 0;
      for (const agent of orphaned) {
        if (agent.status === "running") {
          await storage.updateAgent(agent.id, { status: "idle" });
        }
        await storage.deleteAgent(agent.id);
        deleted++;
      }
      broadcast("agents:refresh", {});
      res.json({ success: true, deleted, agentIds: orphaned.map(a => ({ id: a.id, name: a.name })) });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Cleanup failed" });
    }
  });

  app.post("/api/recovery/close-stuck-positions", async (req, res) => {
    try {
      const { walletAddress } = req.body;
      if (!walletAddress || typeof walletAddress !== "string") {
        return res.status(400).json({ message: "walletAddress is required" });
      }

      const { getThrottledSuiClient: getSuiClient } = await import("./rpc-throttle");
      const suiClient = getSuiClient();

      const toTxs = await suiClient.queryTransactionBlocks({
        filter: { ToAddress: walletAddress },
        options: { showEvents: true, showBalanceChanges: true },
        limit: 50,
        order: "descending" as any,
      });

      const fromTxs = await suiClient.queryTransactionBlocks({
        filter: { FromAddress: walletAddress },
        options: { showEvents: true, showBalanceChanges: true },
        limit: 50,
        order: "descending" as any,
      });

      const openOrderIds = new Map<string, { side: string; collateral: number; size: number; txDigest: string }>();
      const filledOrderIds = new Map<string, { positionId: string; linkedPositionId: string | null }>();
      const closeOrderIds = new Set<string>();

      for (const tx of (fromTxs?.data || [])) {
        for (const evt of ((tx as any).events || [])) {
          const p = (evt as any).parsedJson;
          const t = (evt as any).type || "";
          if (t.includes("CreateTradingOrderEvent") && p) {
            const orderId = String(p.order_id);
            if (p.reduce_only) {
              closeOrderIds.add(orderId);
            } else {
              openOrderIds.set(orderId, {
                side: p.is_long ? "long" : "short",
                collateral: parseInt(p.collateral_amount || "0") / 1e9,
                size: parseInt(p.size || "0") / 1e9,
                txDigest: (tx as any).digest,
              });
            }
          }
        }
      }

      for (const tx of (toTxs?.data || [])) {
        for (const evt of ((tx as any).events || [])) {
          const p = (evt as any).parsedJson;
          const t = (evt as any).type || "";
          if (t.includes("OrderFilledEvent") && p) {
            const orderId = String(p.order_id);
            filledOrderIds.set(orderId, {
              positionId: p.new_position_id ? String(p.new_position_id) : "",
              linkedPositionId: p.linked_position_id ? String(p.linked_position_id) : null,
            });
          }
        }
      }

      const stuckPositions: Array<{
        orderId: string;
        positionId: string;
        side: string;
        collateral: number;
        size: number;
        openTxDigest: string;
        closeFilled: boolean;
      }> = [];

      for (const [orderId, info] of openOrderIds) {
        const fill = filledOrderIds.get(orderId);
        if (!fill) continue;

        let closeFilled = false;
        for (const closeOrderId of closeOrderIds) {
          const closeFill = filledOrderIds.get(closeOrderId);
          if (closeFill && closeFill.linkedPositionId === fill.positionId) {
            closeFilled = true;
            break;
          }
        }

        if (!closeFilled) {
          stuckPositions.push({
            orderId,
            positionId: fill.positionId,
            side: info.side,
            collateral: info.collateral,
            size: info.size,
            openTxDigest: info.txDigest,
            closeFilled: false,
          });
        }
      }

      const balResp = await suiClient.getBalance({ owner: walletAddress, coinType: "0x2::sui::SUI" });
      const onChainBalance = Number(balResp.totalBalance) / 1e9;

      const totalLockedCollateral = stuckPositions.reduce((s, p) => s + p.collateral, 0);

      const agents = await storage.getAgents();
      const matchingAgent = agents.find(a => a.walletAddress === walletAddress);

      if (matchingAgent && stuckPositions.length > 0) {
        for (const stuck of stuckPositions) {
          const existingPositions = await storage.getPositions(matchingAgent.id);
          const existingOpen = existingPositions.find(p =>
            (p.status === "open" || p.status === "pending_open") && p.onChainPositionId === stuck.positionId
          );

          if (!existingOpen) {
            const existingClosed = existingPositions.find(p =>
              p.status === "closed" && p.onChainPositionId === stuck.positionId
            );

            if (existingClosed) {
              await storage.updatePosition(existingClosed.id, {
                status: "open",
                closedAt: null as any,
                closeTxDigest: null as any,
                unrealizedPnl: 0,
              });
              console.log(`[recovery] Reopened stuck position ${stuck.positionId} (order ${stuck.orderId}) for ${matchingAgent.name} — close order was never filled`);
            }
          }
        }

        const freshPositions = await storage.getPositions(matchingAgent.id);
        const openPositions = freshPositions.filter(p => (p.status === "open" || p.status === "pending_open"));
        const lockedCollateral = openPositions.reduce((sum, p) => sum + (p.collateral || p.sizeSui / matchingAgent.leverage), 0);
        const newBalance = onChainBalance + lockedCollateral;

        const closedPositions = freshPositions.filter(p => p.status === "closed");
        const totalPnl = closedPositions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
        const wins = closedPositions.filter(p => (p.unrealizedPnl || 0) > 0).length;
        const winRate = closedPositions.length > 0 ? wins / closedPositions.length : 0;

        await storage.updateAgent(matchingAgent.id, {
          balance: newBalance,
          totalPnl,
          winRate,
        });
      }

      res.json({
        walletAddress,
        onChainBalance,
        totalLockedCollateral,
        stuckPositions,
        agentFound: !!matchingAgent,
        agentName: matchingAgent?.name || null,
        message: stuckPositions.length > 0
          ? `Found ${stuckPositions.length} positions with unfilled close orders. ${totalLockedCollateral.toFixed(4)} SUI still locked on Typus.${matchingAgent ? " Positions reopened in DB for auto-close by position monitor." : " No matching agent found in DB — manual recovery needed."}`
          : "No stuck positions found for this wallet.",
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Recovery analysis failed" });
    }
  });

  app.get("/api/agents/:id/sui-flow", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      if (!agent.walletAddress) return res.status(400).json({ message: "Agent has no wallet address" });

      const { suiClient: sc } = await import("./sui-verify");
      const walletAddress = agent.walletAddress;
      const SUI_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
      const normalizeAddr = (a: string) => a.toLowerCase();

      let rewardWalletAddr: string | null = null;
      try {
        rewardWalletAddr = getRewardWalletAddress();
      } catch {}

      const allOrders = await storage.getOrders(req.params.id);
      const allPositions = await storage.getPositions(req.params.id);
      const allRewards = (await storage.getRewards()).filter(r => r.agentId === req.params.id);
      const allDeposits = await storage.getDepositsByAgent(req.params.id);

      const orderTxDigests = new Set(allOrders.filter(o => o.txDigest).map(o => o.txDigest!));
      const positionOpenTxDigests = new Set(allPositions.filter(p => p.txDigest).map(p => p.txDigest!));
      const FAKE_CLOSE_DIGESTS = new Set(["closed_externally", "closed_external", "settled_onchain", "cancelled_unfilled", "liquidated_onchain"]);
      const positionCloseTxDigests = new Set(allPositions.filter(p => p.closeTxDigest && !FAKE_CLOSE_DIGESTS.has(p.closeTxDigest) && !p.closeTxDigest.startsWith("reopened_") && !p.closeTxDigest.startsWith("recovered_")).map(p => p.closeTxDigest!));
      const rewardEscrowTxDigests = new Set(allRewards.filter(r => r.escrowTxDigest && r.escrowTxDigest !== "pending_escrow").map(r => r.escrowTxDigest!));
      const depositTxDigests = new Set(allDeposits.filter(d => d.txDigest).map(d => d.txDigest!));

      const closedPositions = allPositions.filter(p => p.status === "closed");
      const closeOrderIds = new Set<string>();
      const closePositionIds = new Set<string>();
      const closedPositionTimes: number[] = [];
      const closeOrderTxDigests = new Set<string>();
      const openOrderIds = new Set<string>();
      for (const cp of closedPositions) {
        if (cp.onChainPositionId) closePositionIds.add(cp.onChainPositionId);
        if (cp.closedAt) closedPositionTimes.push(new Date(cp.closedAt).getTime());
        if (cp.typusOrderId) openOrderIds.add(cp.typusOrderId);
        if (cp.lastCloseTx) closeOrderTxDigests.add(cp.lastCloseTx);
      }

      const transactions: any[] = [];
      let cursor: string | null | undefined = undefined;
      const MAX_PAGES = 5;
      const PAGE_SIZE = 50;
      let rpcWarning: string | null = null;

      const queryWithRetry = async (filter: any, cursorVal: any) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return await sc.queryTransactionBlocks({
              filter,
              options: { showBalanceChanges: true, showEvents: true, showInput: true, showEffects: true },
              limit: PAGE_SIZE,
              order: "descending" as any,
              ...(cursorVal ? { cursor: cursorVal } : {}),
            });
          } catch (err: any) {
            const msg = String(err?.message ?? err);
            if ((msg.includes("429") || msg.includes("rate limit") || msg.includes("Too Many Requests")) && attempt < 2) {
              await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
              continue;
            }
            throw err;
          }
        }
        throw new Error("queryTransactionBlocks exhausted retries");
      };

      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const fromQuery: any = await queryWithRetry({ FromAddress: walletAddress }, cursor);
          if (fromQuery.data) {
            for (const tx of fromQuery.data) transactions.push(tx);
          }
          if (!fromQuery.hasNextPage || !fromQuery.nextCursor) break;
          cursor = fromQuery.nextCursor;
        }
      } catch (e: any) {
        rpcWarning = `Outgoing tx fetch failed: ${e.message?.slice(0, 80)}`;
        console.log(`[SuiFlow] ${agent.name}: FromAddress query failed — ${e.message}`);
      }

      try {
        cursor = undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const toQuery: any = await queryWithRetry({ ToAddress: walletAddress }, cursor);
          if (toQuery.data) {
            for (const tx of toQuery.data) {
              if (!transactions.find((t: any) => t.digest === tx.digest)) {
                transactions.push(tx);
              }
            }
          }
          if (!toQuery.hasNextPage || !toQuery.nextCursor) break;
          cursor = toQuery.nextCursor;
        }
      } catch (e: any) {
        rpcWarning = (rpcWarning ? rpcWarning + "; " : "") + `Incoming tx fetch failed: ${e.message?.slice(0, 80)}`;
        console.log(`[SuiFlow] ${agent.name}: ToAddress query failed — ${e.message}`);
      }

      const isSuiCoin = (coinType: string) =>
        coinType === "0x2::sui::SUI" || coinType === SUI_TYPE;

      if (transactions.length === 0) {
        const dbFlowTransactions: any[] = [];
        let dbTotalIn = 0, dbTotalOut = 0, dbTotalGas = 0;

        for (const dep of allDeposits) {
          const amt = dep.amount || 0;
          dbTotalIn += amt;
          dbFlowTransactions.push({
            digest: dep.txDigest || `deposit_${dep.id}`,
            timestamp: dep.createdAt ? new Date(dep.createdAt).toISOString() : null,
            type: "deposit_in",
            amountSui: parseFloat(amt.toFixed(6)),
            gasSui: 0,
            direction: "in",
            status: "success",
            events: [],
            explorerUrl: dep.txDigest ? `https://suiscan.xyz/mainnet/tx/${dep.txDigest}` : "",
          });
        }

        for (const pos of allPositions) {
          if (!pos.txDigest || pos.txDigest.startsWith("sim_") || pos.txDigest.startsWith("reopened_") || pos.txDigest.startsWith("recovered_")) continue;
          const collateral = pos.collateral || (pos.sizeSui / (agent.leverage || 25));

          dbFlowTransactions.push({
            digest: pos.txDigest,
            timestamp: pos.createdAt ? new Date(pos.createdAt).toISOString() : null,
            type: "order_create",
            amountSui: parseFloat(collateral.toFixed(6)),
            gasSui: 0.005,
            direction: "out",
            status: "success",
            events: ["CreateTradingOrderEvent"],
            relatedPositionId: pos.onChainPositionId || pos.id,
            explorerUrl: `https://suiscan.xyz/mainnet/tx/${pos.txDigest}`,
          });
          dbTotalOut += collateral;
          dbTotalGas += 0.005;

          if (pos.status === "closed" && pos.closeTxDigest && !FAKE_CLOSE_DIGESTS.has(pos.closeTxDigest)) {
            const returned = collateral + (pos.unrealizedPnl || 0);
            dbFlowTransactions.push({
              digest: pos.closeTxDigest,
              timestamp: pos.closedAt ? new Date(pos.closedAt).toISOString() : null,
              type: "close_fill",
              amountSui: parseFloat(Math.max(0, returned).toFixed(6)),
              gasSui: 0.005,
              direction: "in",
              status: "success",
              events: ["ClosePositionEvent"],
              relatedPositionId: pos.onChainPositionId || pos.id,
              explorerUrl: `https://suiscan.xyz/mainnet/tx/${pos.closeTxDigest}`,
            });
            dbTotalGas += 0.005;
          }
        }

        dbFlowTransactions.sort((a: any, b: any) => {
          const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return tb - ta;
        });

        const openDbPos = allPositions.filter(p => p.status === "open" || p.status === "pending_open");
        const currentLockedDb = openDbPos.reduce((s, p) => s + (p.collateral || p.sizeSui / (agent.leverage || 25)), 0);
        const closedDbPos = allPositions.filter(p => p.status === "closed" && p.closeReason !== "deleted_bogus_recovery");
        const dbWins = closedDbPos.filter(p => (p.unrealizedPnl || 0) > 0);
        const dbLosses = closedDbPos.filter(p => (p.unrealizedPnl || 0) <= 0);
        const dbTotalPnl = closedDbPos.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
        const dbCumCollateral = closedDbPos.reduce((s, p) => s + (p.collateral || (p.sizeSui / (agent.leverage || 25))), 0);
        const dbCumSettlements = closedDbPos.reduce((s, p) => {
          const coll = p.collateral || (p.sizeSui / (agent.leverage || 25));
          return s + Math.max(0, coll + (p.unrealizedPnl || 0));
        }, 0);

        const dbChainTrades = closedDbPos.map(p => {
          const coll = p.collateral || (p.sizeSui / (agent.leverage || 25));
          const returned = coll + (p.unrealizedPnl || 0);
          return {
            openDigest: p.txDigest || `pos_${p.id}`,
            closeDigest: p.closeTxDigest || null,
            collateral: coll,
            returned: Math.max(0, returned),
            pnlSui: p.unrealizedPnl || 0,
            outcome: (p.closeReason === "liquidated" ? "liquidated" : (p.unrealizedPnl || 0) > 0 ? "win" : "loss") as any,
            openTimestamp: p.createdAt ? new Date(p.createdAt).toISOString() : null,
            closeTimestamp: p.closedAt ? new Date(p.closedAt).toISOString() : null,
            dbPositionMatch: "tracked",
          };
        });

        const cachedBal = onChainBalanceCache.get(agent.id);
        const walletBal = cachedBal ? cachedBal.sui : Math.max(0, agent.balance - currentLockedDb);

        return res.json({
          transactions: dbFlowTransactions,
          summary: {
            totalIn: parseFloat(dbTotalIn.toFixed(6)),
            totalOut: parseFloat(dbTotalOut.toFixed(6)),
            totalGas: parseFloat(dbTotalGas.toFixed(6)),
            totalLocked: parseFloat(dbCumCollateral.toFixed(6)),
            totalReturned: parseFloat(dbCumSettlements.toFixed(6)),
            totalRewards: 0,
            unexplainedGap: 0,
            currentlyLockedOnChain: parseFloat(currentLockedDb.toFixed(6)),
            currentWalletBalance: parseFloat(walletBal.toFixed(6)),
            liquidationLosses: 0,
            tradingLosses: parseFloat(Math.abs(dbLosses.reduce((s, p) => s + (p.unrealizedPnl || 0), 0)).toFixed(6)),
          },
          chainDerivedStats: {
            tradeCount: closedDbPos.length,
            wins: dbWins.length,
            losses: dbLosses.length,
            liquidations: closedDbPos.filter(p => p.closeReason === "liquidated").length,
            winRate: closedDbPos.length > 0 ? parseFloat((dbWins.length / closedDbPos.length).toFixed(4)) : 0,
            totalPnl: parseFloat(dbTotalPnl.toFixed(6)),
            realizedGain: parseFloat(dbWins.reduce((s, p) => s + (p.unrealizedPnl || 0), 0).toFixed(6)),
            realizedLoss: parseFloat(dbLosses.reduce((s, p) => s + (p.unrealizedPnl || 0), 0).toFixed(6)),
            openTrades: openDbPos.length,
            cancelledTrades: 0,
          },
          chainTrades: dbChainTrades,
          dbTradeCount: closedDbPos.length,
          untrackedChainTrades: 0,
          errors: [],
          walletAddress,
          rpcWarning: "On-chain transaction history temporarily unavailable (RPC rate limited). Showing data from local records.",
          dataSource: "database",
        });
      }

      const categorized: any[] = [];
      let totalIn = 0;
      let totalOut = 0;
      let totalGas = 0;
      let totalLocked = 0;
      let totalReturned = 0;
      let totalRewards = 0;

      for (const tx of transactions) {
        const digest = tx.digest;
        const timestampMs = tx.timestampMs ? Number(tx.timestampMs) : null;
        const timestamp = timestampMs ? new Date(timestampMs).toISOString() : null;
        const status = tx.effects?.status?.status === "success" ? "success" : "failure";
        const balanceChanges = tx.balanceChanges || [];
        const events = tx.events || [];
        const sender = tx.transaction?.data?.sender || "";

        const agentSuiChange = balanceChanges
          .filter((bc: any) =>
            bc.owner?.AddressOwner &&
            normalizeAddr(bc.owner.AddressOwner) === normalizeAddr(walletAddress) &&
            isSuiCoin(bc.coinType)
          )
          .reduce((sum: number, bc: any) => sum + Number(bc.amount), 0);

        const amountSui = Math.abs(agentSuiChange) / 1e9;
        const direction = agentSuiChange >= 0 ? "in" : "out";

        const gasUsed = tx.effects?.gasUsed;
        let gasSui = 0;
        if (gasUsed) {
          const comp = Number(gasUsed.computationCost || 0);
          const stor = Number(gasUsed.storageCost || 0);
          const rebate = Number(gasUsed.storageRebate || 0);
          gasSui = Math.max(0, (comp + stor - rebate)) / 1e9;
        }

        const eventTypes = events.map((e: any) => (e.type || "").split("::").pop() || "");
        const hasCreateOrder = eventTypes.some((t: string) => t.includes("CreateTradingOrderEvent"));
        const hasOrderFilled = eventTypes.some((t: string) => t.includes("OrderFilledEvent"));
        const hasCancelOrder = eventTypes.some((t: string) => t.includes("CancelTradingOrderEvent"));
        const hasLiquidate = eventTypes.some((t: string) => t.includes("LiquidateEvent"));
        const hasClosePosition = eventTypes.some((t: string) =>
          t.includes("ClosePositionEvent") || t.includes("DecreasePositionEvent") || t.includes("PositionChangeEvent")
        );
        const hasRemovePos = eventTypes.some((t: string) => t.includes("RemovePositionEvent"));

        let relatedOrderId: string | null = null;
        let relatedPositionId: string | null = null;
        let linkedPositionId: string | null = null;
        let isReduceOnly = false;
        for (const evt of events) {
          const parsed = (evt as any).parsedJson;
          if (!parsed) continue;
          if (parsed.order_id) relatedOrderId = String(parsed.order_id);
          if (parsed.position_id) relatedPositionId = String(parsed.position_id);
          if (parsed.new_position_id) relatedPositionId = String(parsed.new_position_id);
          if (parsed.linked_position_id) linkedPositionId = String(parsed.linked_position_id);
          const evtType = ((evt as any).type || "").split("::").pop() || "";
          if (evtType.includes("CreateTradingOrderEvent") && (parsed.reduce_only || parsed.is_reduce_only)) {
            isReduceOnly = true;
          }
        }

        let type = "unknown_outflow";

        if (depositTxDigests.has(digest)) {
          type = "deposit_in";
        } else if (direction === "in" && normalizeAddr(sender) !== normalizeAddr(walletAddress)) {
          type = "deposit_in";
        }

        if (hasCreateOrder || orderTxDigests.has(digest) || positionOpenTxDigests.has(digest)) {
          type = "order_create";
        }

        if (hasCancelOrder) {
          type = "order_cancel";
        }

        if (hasOrderFilled && (positionCloseTxDigests.has(digest) || hasClosePosition || hasRemovePos)) {
          type = "close_fill";
        } else if (positionCloseTxDigests.has(digest) || hasClosePosition || hasRemovePos) {
          type = "close_fill";
        }

        if (hasLiquidate) {
          type = "close_fill";
        }

        if (type === "order_create" && hasCreateOrder && !hasOrderFilled) {
          const isCloseOrder = isReduceOnly ||
            (linkedPositionId && closePositionIds.has(linkedPositionId)) ||
            closeOrderTxDigests.has(digest);
          if (isCloseOrder) {
            type = "close_order";
          }
        }

        if (type === "order_create" && direction === "in" && hasOrderFilled) {
          type = "close_fill";
        }

        if (type === "order_create" && direction === "in" && !hasOrderFilled) {
          const isCloseOrder = isReduceOnly ||
            (linkedPositionId && closePositionIds.has(linkedPositionId)) ||
            closeOrderTxDigests.has(digest);
          if (isCloseOrder) {
            type = "close_order";
          }
        }

        if (type === "deposit_in" && direction === "in" && normalizeAddr(sender) !== normalizeAddr(walletAddress)) {
          if (hasOrderFilled || hasClosePosition || hasRemovePos) {
            type = "close_fill";
          } else if (timestampMs) {
            const txTime = timestampMs;
            const isKeeperReturn = closedPositionTimes.some(ct =>
              Math.abs(txTime - ct) < 30_000
            );
            if (isKeeperReturn && amountSui > 0.1) {
              type = "close_fill";
            }
          }
        }

        if (rewardEscrowTxDigests.has(digest)) {
          type = "reward_escrow";
        } else if (rewardWalletAddr && direction === "out") {
          const rewardWalletChange = balanceChanges.find((bc: any) =>
            bc.owner?.AddressOwner &&
            normalizeAddr(bc.owner.AddressOwner) === normalizeAddr(rewardWalletAddr!) &&
            isSuiCoin(bc.coinType) &&
            Number(bc.amount) > 0
          );
          if (rewardWalletChange) {
            type = "reward_escrow";
          }
        }

        if (type === "unknown_outflow" && status === "failure" && direction === "out" && amountSui < 0.05) {
          const inputData = JSON.stringify(tx.transaction?.data || "");
          const isTypusCall = inputData.includes("create_trading_order") || inputData.includes("trading");
          if (isTypusCall) {
            type = "failed_close";
          } else {
            type = "gas_spent";
          }
        }

        if (type === "unknown_outflow" && direction === "out" && amountSui < 0.02 && gasSui > 0) {
          type = "gas_spent";
        }

        if (type === "unknown_outflow" && direction === "in") {
          type = "deposit_in";
        }

        switch (type) {
          case "deposit_in":
            totalIn += amountSui;
            break;
          case "order_create":
            if (direction === "out") totalLocked += amountSui;
            totalOut += direction === "out" ? amountSui : 0;
            break;
          case "order_cancel":
            if (direction === "in") totalReturned += amountSui;
            break;
          case "close_order":
            totalOut += direction === "out" ? amountSui : 0;
            break;
          case "close_fill":
            if (direction === "in") totalReturned += amountSui;
            else totalOut += amountSui;
            break;
          case "reward_escrow":
            totalRewards += amountSui;
            totalOut += amountSui;
            break;
          case "failed_close":
            break;
          case "gas_spent":
            break;
          case "unknown_outflow":
            totalOut += amountSui;
            break;
        }

        if (gasSui > 0) {
          totalGas += gasSui;
        }

        categorized.push({
          digest,
          timestamp,
          type,
          amountSui: parseFloat(amountSui.toFixed(6)),
          gasSui: parseFloat(gasSui.toFixed(6)),
          direction,
          status,
          events: eventTypes.filter((t: string) => t.length > 0),
          relatedOrderId,
          relatedPositionId,
          linkedPositionId,
          hasLiquidateEvent: hasLiquidate,
          explorerUrl: `https://suiscan.xyz/mainnet/tx/${digest}`,
        });
      }

      const suiFlowOrderIdToPositionId = new Map<string, string>();
      for (const tx of categorized) {
        if (tx.relatedOrderId && tx.relatedPositionId && tx.events?.includes("OrderFilledEvent")) {
          suiFlowOrderIdToPositionId.set(tx.relatedOrderId, tx.relatedPositionId);
        }
      }

      categorized.sort((a, b) => {
        if (!a.timestamp || !b.timestamp) return 0;
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });

      const errors: string[] = [];

      const failedCancels = categorized.filter(t => t.status === "failure" && t.type === "failed_close");
      const orderCreateTxs = categorized.filter(t => t.type === "order_create" && t.direction === "out");
      const cancelSuccessTxs = categorized.filter(t => t.type === "order_cancel");
      const closeFillTxs = categorized.filter(t => t.type === "close_fill" && t.direction === "in");

      if (orderCreateTxs.length > 0 && closeFillTxs.length === 0 && cancelSuccessTxs.length === 0 && failedCancels.length > 0) {
        const orderAmount = orderCreateTxs.reduce((s, t) => s + t.amountSui, 0);
        const cancelGas = failedCancels.reduce((s, t) => s + t.gasSui, 0);
        errors.push(`LIKELY LIQUIDATION: ${orderAmount.toFixed(4)} SUI sent to Typus, all ${failedCancels.length} cancel attempts failed with order_not_found (order was filled by keeper), but no close was ever submitted. The position was unmanaged and the ${orderAmount.toFixed(4)} SUI collateral was likely consumed by liquidation. An additional ${cancelGas.toFixed(4)} SUI was burned in failed cancel gas.`);
      }

      for (const tx of categorized) {
        if (tx.status === "failure" && tx.type !== "failed_close") {
          errors.push(`TX ${tx.digest.slice(0, 12)}... failed (type: ${tx.type})`);
        }
      }

      if (failedCancels.length > 0) {
        const totalCancelGas = failedCancels.reduce((s, t) => s + t.gasSui, 0);
        errors.push(`${failedCancels.length} cancel attempts failed (order_not_found) — ${totalCancelGas.toFixed(4)} SUI burned in gas. This means the order was already filled by the Typus keeper.`);
      }

      for (const tx of categorized) {
        if (tx.type === "unknown_outflow" && tx.amountSui > 0.01) {
          errors.push(`Unknown outflow of ${tx.amountSui.toFixed(4)} SUI in TX ${tx.digest.slice(0, 12)}...`);
        }
      }

      for (const order of allOrders) {
        if (order.status === "open" && order.txDigest) {
          const matchedPosition = allPositions.find(p =>
            p.txDigest === order.txDigest
          );
          const wasCancelled = categorized.find(t =>
            t.type === "order_cancel" && t.relatedOrderId === order.id
          );
          if (!matchedPosition && !wasCancelled) {
            const collateral = order.qty / order.leverage;
            errors.push(`Order ${order.id.slice(0, 8)}... created with ${collateral.toFixed(4)} SUI collateral but never filled or cancelled`);
          }
        }
      }

      for (const pos of allPositions) {
        if (pos.status === "closed" && pos.closeTxDigest) {
          const closeTx = categorized.find(t => t.digest === pos.closeTxDigest);
          if (closeTx && closeTx.status === "failure") {
            errors.push(`Position close TX failed for position ${pos.id.slice(0, 8)}... — collateral may not be returned`);
          }
        }
      }

      let currentlyLockedOnChain = 0;
      let currentWalletBalance = 0;
      let suiFlowGetPositionsOk = false;
      const suiFlowUnfilledOrderIds = new Set<string>();
      try {
        const onChain = await getOnChainBalance(walletAddress);
        currentWalletBalance = onChain.sui;
        const adapter = getAdapter(agent.venue || "typus");
        if (adapter) {
          const openPositions = await adapter.getPositions(walletAddress);
          suiFlowGetPositionsOk = true;
          for (const pos of openPositions) {
            currentlyLockedOnChain += pos.collateral || 0;
          }
          if (currentWalletBalance > 0.1) {
            try {
              const { TypusAdapter } = await import("./dex/typus-adapter");
              if (adapter instanceof TypusAdapter) {
                const { created, unfilled } = await adapter.findAllUnfilledOrderIds(walletAddress);
                for (const oid of unfilled) {
                  suiFlowUnfilledOrderIds.add(oid);
                  const orderInfo = created.get(oid);
                  if (orderInfo && !orderInfo.isReduceOnly && orderInfo.collateral > 0) {
                    currentlyLockedOnChain += orderInfo.collateral;
                  }
                }
              }
            } catch {}
          }
        }
      } catch {}

      let netBalanceChanges = 0;
      for (const tx of categorized) {
        const signedAmount = tx.direction === "in" ? tx.amountSui : -tx.amountSui;
        netBalanceChanges += signedAmount;
      }

      const actualBalance = currentWalletBalance + currentlyLockedOnChain;
      const unexplainedGap = Math.max(0, netBalanceChanges - actualBalance);

      const significantOrders = orderCreateTxs.filter(t => t.amountSui > 0.1);
      const significantReturns = categorized.filter(t =>
        (t.type === "close_fill" || t.type === "order_cancel") && t.direction === "in" && t.amountSui > 0.01
      );

      const chainTrades: Array<{
        openDigest: string;
        closeDigest: string | null;
        collateral: number;
        returned: number;
        pnlSui: number;
        outcome: "win" | "loss" | "liquidated" | "cancelled" | "open" | "pending_order";
        openTimestamp: string | null;
        closeTimestamp: string | null;
      }> = [];
      const suiFlowUnmatchedOrders: typeof significantOrders = [];

      const chronoOrders = [...significantOrders].sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return ta - tb;
      });
      const chronoReturns = [...significantReturns].sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return ta - tb;
      });

      const usedReturns = new Set<string>();

      const orderIdToOrderDigest = new Map<string, string>();
      const posIdToOrderDigest = new Map<string, string>();
      for (const order of chronoOrders) {
        if (order.relatedOrderId) orderIdToOrderDigest.set(order.relatedOrderId, order.digest);
        if (order.relatedPositionId) posIdToOrderDigest.set(order.relatedPositionId, order.digest);
        if (order.relatedOrderId) {
          const posId = suiFlowOrderIdToPositionId.get(order.relatedOrderId);
          if (posId) posIdToOrderDigest.set(posId, order.digest);
        }
      }

      const returnsByOrderDigest = new Map<string, typeof chronoReturns[0]>();
      for (const ret of chronoReturns) {
        const lnkPosId = ret.linkedPositionId;
        if (lnkPosId && posIdToOrderDigest.has(lnkPosId)) {
          const openDigest = posIdToOrderDigest.get(lnkPosId)!;
          if (!returnsByOrderDigest.has(openDigest)) {
            returnsByOrderDigest.set(openDigest, ret);
            usedReturns.add(ret.digest);
            continue;
          }
        }
        if (ret.relatedOrderId && orderIdToOrderDigest.has(ret.relatedOrderId)) {
          const openDigest = orderIdToOrderDigest.get(ret.relatedOrderId)!;
          if (!returnsByOrderDigest.has(openDigest)) {
            returnsByOrderDigest.set(openDigest, ret);
            usedReturns.add(ret.digest);
          }
        } else if (ret.relatedPositionId && posIdToOrderDigest.has(ret.relatedPositionId)) {
          const openDigest = posIdToOrderDigest.get(ret.relatedPositionId)!;
          if (!returnsByOrderDigest.has(openDigest)) {
            returnsByOrderDigest.set(openDigest, ret);
            usedReturns.add(ret.digest);
          }
        }
      }

      const suiFlowLiqDigests = new Set<string>();
      for (const tx of categorized) {
        if (tx.hasLiquidateEvent) suiFlowLiqDigests.add(tx.digest);
      }

      for (const order of chronoOrders) {
        const orderTime = order.timestamp ? new Date(order.timestamp).getTime() : 0;

        let matchedReturn = returnsByOrderDigest.get(order.digest);

        if (!matchedReturn) {
          matchedReturn = chronoReturns.find(r => {
            if (usedReturns.has(r.digest)) return false;
            const rt = r.timestamp ? new Date(r.timestamp).getTime() : 0;
            return rt >= orderTime;
          });
          if (matchedReturn) usedReturns.add(matchedReturn.digest);
        }

        if (matchedReturn) {
          const pnl = matchedReturn.amountSui - order.amountSui;
          const isCancelReturn = matchedReturn.type === "order_cancel" && Math.abs(matchedReturn.amountSui - order.amountSui) < 0.05;
          const isLiqEvent = matchedReturn.hasLiquidateEvent || suiFlowLiqDigests.has(matchedReturn.digest);
          chainTrades.push({
            openDigest: order.digest,
            closeDigest: matchedReturn.digest,
            collateral: order.amountSui,
            returned: matchedReturn.amountSui,
            pnlSui: pnl,
            outcome: isCancelReturn ? "cancelled" : isLiqEvent ? "liquidated" : pnl > 0 ? "win" : "loss",
            openTimestamp: order.timestamp,
            closeTimestamp: matchedReturn.timestamp,
          });
        } else {
          suiFlowUnmatchedOrders.push(order);
        }
      }

      suiFlowUnmatchedOrders.sort((a: any, b: any) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tb - ta;
      });
      for (const order of suiFlowUnmatchedOrders) {
        const hasEnoughLocked = currentlyLockedOnChain >= order.amountSui * 0.5;
        if (hasEnoughLocked) {
          const isPendingOrder = order.relatedOrderId && suiFlowUnfilledOrderIds.has(order.relatedOrderId);
          chainTrades.push({
            openDigest: order.digest, closeDigest: null,
            collateral: order.amountSui, returned: 0,
            pnlSui: 0, outcome: isPendingOrder ? "pending_order" as any : "open",
            openTimestamp: order.timestamp, closeTimestamp: null,
          });
          currentlyLockedOnChain = Math.max(0, currentlyLockedOnChain - order.amountSui);
        } else if (!suiFlowGetPositionsOk) {
          chainTrades.push({
            openDigest: order.digest, closeDigest: null,
            collateral: order.amountSui, returned: 0,
            pnlSui: 0, outcome: "open",
            openTimestamp: order.timestamp, closeTimestamp: null,
          });
        } else {
          const unusedSuiFlowReturns = chronoReturns.filter(r => !usedReturns.has(r.digest));
          const orderTime = order.timestamp ? new Date(order.timestamp).getTime() : 0;
          const lateMatch = unusedSuiFlowReturns.find(r => {
            const rt = r.timestamp ? new Date(r.timestamp).getTime() : 0;
            return rt >= orderTime;
          });
          if (lateMatch) {
            usedReturns.add(lateMatch.digest);
            const pnl = lateMatch.amountSui - order.amountSui;
            const isLiqEvent = lateMatch.hasLiquidateEvent || suiFlowLiqDigests.has(lateMatch.digest);
            const isCancelReturn = lateMatch.type === "order_cancel" && Math.abs(pnl) < 0.05;
            chainTrades.push({
              openDigest: order.digest, closeDigest: lateMatch.digest,
              collateral: order.amountSui, returned: lateMatch.amountSui,
              pnlSui: isCancelReturn ? 0 : pnl,
              outcome: isCancelReturn ? "cancelled" : isLiqEvent ? "liquidated" : pnl > 0 ? "win" : "loss",
              openTimestamp: order.timestamp, closeTimestamp: lateMatch.timestamp,
            });
          } else {
            chainTrades.push({
              openDigest: order.digest, closeDigest: null,
              collateral: order.amountSui, returned: order.amountSui,
              pnlSui: 0, outcome: "cancelled",
              openTimestamp: order.timestamp, closeTimestamp: null,
            });
          }
        }
      }

      const dbOpenDigests = new Set(allPositions.filter(p => p.txDigest).map(p => p.txDigest!));
      const dbCloseDigests = new Set(allPositions.filter(p => p.closeTxDigest).map(p => p.closeTxDigest!));
      const dbClosedVerifiedCount = allPositions.filter(p =>
        p.status === "closed" &&
        p.txDigest && !p.txDigest.startsWith("sim_") &&
        p.verified !== false &&
        p.closeReason !== "deleted_bogus_recovery"
      ).length;

      const dbClosedForAccounting = allPositions.filter(p =>
        p.status === "closed" &&
        p.closeReason !== "deleted_bogus_recovery"
      );
      const dbCumulativeCollateral = dbClosedForAccounting.reduce((s, p) => {
        return s + (p.collateral || (p.sizeSui / (agent.leverage || 25)));
      }, 0);
      const dbCumulativeSettlements = dbClosedForAccounting.reduce((s, p) => {
        const coll = p.collateral || (p.sizeSui / (agent.leverage || 25));
        const returned = coll + (p.unrealizedPnl || 0);
        return s + Math.max(0, returned);
      }, 0);

      for (const ct of chainTrades) {
        const matchesOpen = dbOpenDigests.has(ct.openDigest);
        const matchesClose = ct.closeDigest ? dbCloseDigests.has(ct.closeDigest) : false;
        (ct as any).dbPositionMatch = matchesOpen || matchesClose ? "tracked" : "untracked";
      }

      const closedChainTrades = chainTrades.filter(t => t.outcome !== "open" && t.outcome !== "cancelled" && t.outcome !== "pending_order");
      const chainTradeCount = closedChainTrades.length;
      const chainWins = closedChainTrades.filter(t => t.outcome === "win").length;
      const chainLiquidations = closedChainTrades.filter(t => t.outcome === "liquidated").length;
      const chainLosses = closedChainTrades.filter(t => t.outcome === "loss").length;
      const chainWinRate = chainTradeCount > 0 ? chainWins / chainTradeCount : 0;
      const chainTotalPnl = closedChainTrades.reduce((s, t) => s + t.pnlSui, 0);

      {
        const dbPnl = agent.totalPnl || 0;
        const pnlDrift = Math.abs(chainTotalPnl - dbPnl);
        if (pnlDrift > 0.1 || agent.totalTrades !== chainTradeCount || Math.abs((agent.winRate || 0) - chainWinRate) > 0.05) {
          try {
            await storage.updateAgent(agent.id, {
              totalPnl: chainTotalPnl,
              totalTrades: chainTradeCount,
              winRate: chainWinRate,
            });
            console.log(`[SuiFlowSync] Auto-corrected DB for ${agent.name}: totalPnl ${dbPnl.toFixed(4)} → ${chainTotalPnl.toFixed(4)}, trades ${agent.totalTrades} → ${chainTradeCount}, winRate ${(agent.winRate || 0).toFixed(2)} → ${chainWinRate.toFixed(2)}`);
          } catch (syncErr: any) {
            console.error(`[SuiFlowSync] Failed to sync DB for ${agent.name}:`, syncErr.message);
          }
        }
      }
      const closeOrderCount = categorized.filter(t => t.type === "close_order" || t.type === "close_fill").length;
      const rewardCount = categorized.filter(t => t.type === "reward_escrow").length;
      if (rewardCount > closeOrderCount && rewardCount > 0) {
        errors.push(`Reward-close mismatch: ${rewardCount} reward escrows but only ${closeOrderCount} close events detected. Some close transactions may have been settled by the Typus keeper and aren't visible in the agent's transaction history.`);
      }

      const chainRealizedGain = closedChainTrades.filter(t => t.pnlSui > 0).reduce((s, t) => s + t.pnlSui, 0);
      const chainRealizedLoss = closedChainTrades.filter(t => t.pnlSui < 0).reduce((s, t) => s + t.pnlSui, 0);

      const liquidationLosses = closedChainTrades
        .filter(t => t.outcome === "liquidated")
        .reduce((s, t) => s + Math.abs(t.pnlSui), 0);

      const tradingLosses = closedChainTrades
        .filter(t => t.outcome === "loss")
        .reduce((s, t) => s + Math.abs(t.pnlSui), 0);

      const cancelledCollateral = chainTrades
        .filter(t => t.outcome === "cancelled")
        .reduce((s, t) => s + t.collateral, 0);

      const adjustedTotalLocked = Math.max(0, totalLocked - cancelledCollateral);

      const lockedDivergence = dbCumulativeCollateral > 0 ? Math.abs(adjustedTotalLocked - dbCumulativeCollateral) / dbCumulativeCollateral : 0;
      const finalTotalLocked = dbCumulativeCollateral > 0 && (lockedDivergence > 0.3 || adjustedTotalLocked < dbCumulativeCollateral * 0.5) ? dbCumulativeCollateral : adjustedTotalLocked;
      const returnedDivergence = dbCumulativeSettlements > 0 ? Math.abs(totalReturned - dbCumulativeSettlements) / dbCumulativeSettlements : 0;
      const finalTotalReturned = dbCumulativeSettlements > 0 && (returnedDivergence > 0.3 || totalReturned > dbCumulativeSettlements * 1.5)
        ? dbCumulativeSettlements : totalReturned;

      const dbNetDeposited = (agent.totalDeposited || 0) - (agent.protocolFeePaid || 0);
      const dbGrossDeposited = agent.totalDeposited || 0;
      const finalTotalIn = Math.max(totalIn, dbNetDeposited);

      const accountedLosses = liquidationLosses + tradingLosses;
      const adjustedGap = Math.max(0, unexplainedGap - accountedLosses);

      res.json({
        transactions: categorized,
        summary: {
          totalIn: parseFloat(finalTotalIn.toFixed(6)),
          totalOut: parseFloat(totalOut.toFixed(6)),
          totalGas: parseFloat(totalGas.toFixed(6)),
          totalLocked: parseFloat(finalTotalLocked.toFixed(6)),
          totalReturned: parseFloat(finalTotalReturned.toFixed(6)),
          totalRewards: parseFloat(totalRewards.toFixed(6)),
          unexplainedGap: parseFloat(adjustedGap.toFixed(6)),
          currentlyLockedOnChain: parseFloat(currentlyLockedOnChain.toFixed(6)),
          currentWalletBalance: parseFloat(currentWalletBalance.toFixed(6)),
          liquidationLosses: parseFloat(liquidationLosses.toFixed(6)),
          tradingLosses: parseFloat(tradingLosses.toFixed(6)),
        },
        chainDerivedStats: {
          tradeCount: chainTradeCount,
          wins: chainWins,
          losses: chainLosses,
          liquidations: chainLiquidations,
          winRate: parseFloat(chainWinRate.toFixed(4)),
          totalPnl: parseFloat(chainTotalPnl.toFixed(6)),
          realizedGain: parseFloat(chainRealizedGain.toFixed(6)),
          realizedLoss: parseFloat(chainRealizedLoss.toFixed(6)),
          openTrades: chainTrades.filter(t => t.outcome === "open").length,
          cancelledTrades: chainTrades.filter(t => t.outcome === "cancelled").length,
        },
        chainTrades,
        dbTradeCount: dbClosedVerifiedCount,
        untrackedChainTrades: chainTrades.filter((t: any) => t.dbPositionMatch === "untracked" && t.outcome !== "cancelled" && t.outcome !== "open" && t.outcome !== "pending_order").length,
        errors,
        walletAddress,
        ...(rpcWarning ? { rpcWarning } : {}),
      });
    } catch (e: any) {
      console.error("[SUI Flow] Error:", e.message);
      res.status(500).json({ message: e.message || "Failed to get SUI flow data" });
    }
  });

  const BLOCKED_PATTERNS = [
    /\.env/i,
    /node_modules/,
    /\.git\//,
    /server\/reward-wallet\.ts/,
    /server\/dex\/wallet-manager\.ts/,
    /server\/dex\/coin-manager\.ts/,
    /\.pem$/,
    /\.key$/,
    /\.secret/,
    /drizzle\.config\.ts/,
    /\.local\//,
    /dist\//,
    /package-lock\.json/,
    /attached_assets\//,
    /reports\//,
    /\.replit$/,
    /replit\.nix$/,
    /server\/index\.ts/,
  ];

  const ALLOWED_DIRECTORIES = [
    "client/src/",
    "client/index.html",
    "shared/",
    "server/",
    "vite.config.ts",
    "tailwind.config.ts",
    "tsconfig.json",
    "replit.md",
  ];

  const SENSITIVE_CONTENT_PATTERNS = [
    /PRIVATE_KEY/i,
    /encryptedPrivateKey/i,
    /SECRET_KEY/i,
    /process\.env\.DATABASE_URL/,
    /mnemonic/i,
    /BEGIN\s+(RSA|EC|DSA|OPENSSH)\s+PRIVATE\s+KEY/i,
    /nacl\.secretbox/i,
    /nacl\.box/i,
    /fromSecretKey/i,
    /wallet.*seed/i,
    /SESSION_SECRET/,
    /API_KEY\s*[=:]/i,
  ];

  const ALLOWED_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".html", ".toml", ".move", ".md",
  ]);

  function isPathBlocked(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, "/");
    return BLOCKED_PATTERNS.some(p => p.test(normalized));
  }

  function isInAllowedDirectory(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, "/");
    return ALLOWED_DIRECTORIES.some(d => normalized.startsWith(d) || normalized === d);
  }

  function isAllowedExtension(filePath: string): boolean {
    const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext);
  }

  function contentHasSensitiveData(content: string): boolean {
    return SENSITIVE_CONTENT_PATTERNS.some(p => p.test(content));
  }

  app.get("/api/code/tree", async (_req, res) => {
    try {
      const { execSync } = await import("child_process");
      const searchDirs = ["client/src", "shared", "server"];
      const topFiles = ["vite.config.ts", "tailwind.config.ts", "tsconfig.json", "replit.md", "client/index.html"];
      const allFiles: string[] = [];
      for (const dir of searchDirs) {
        try {
          const raw = execSync(`find ${dir} -type f 2>/dev/null | sort`, {
            cwd: process.cwd(),
            encoding: "utf-8",
            timeout: 5000,
          });
          if (raw.trim()) allFiles.push(...raw.trim().split("\n"));
        } catch {}
      }
      const fs = await import("fs");
      for (const f of topFiles) {
        if (fs.existsSync(f)) allFiles.push(f);
      }
      const safeFiles = allFiles.filter(f => !isPathBlocked(f) && isAllowedExtension(f));
      res.json(safeFiles);
    } catch (e: any) {
      res.status(500).json({ message: "Failed to list files" });
    }
  });

  app.get("/api/code/file", async (req, res) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) return res.status(400).json({ message: "Missing path parameter" });

      const normalized = filePath.replace(/\\/g, "/");
      if (normalized.includes("..") || normalized.startsWith("/")) {
        return res.status(403).json({ message: "Invalid path" });
      }
      if (isPathBlocked(normalized)) {
        return res.status(403).json({ message: "Access denied" });
      }
      if (!isAllowedExtension(normalized)) {
        return res.status(403).json({ message: "File type not allowed" });
      }
      if (!isInAllowedDirectory(normalized)) {
        return res.status(403).json({ message: "Access denied" });
      }

      const fs = await import("fs/promises");
      const path = await import("path");
      const fullPath = path.join(process.cwd(), normalized);
      const realPath = await fs.realpath(fullPath);
      const cwd = await fs.realpath(process.cwd());
      if (!realPath.startsWith(cwd)) {
        return res.status(403).json({ message: "Access denied" });
      }

      const stat = await fs.stat(fullPath);
      if (stat.size > 500_000) {
        return res.status(413).json({ message: "File too large to display" });
      }

      const content = await fs.readFile(fullPath, "utf-8");
      if (contentHasSensitiveData(content)) {
        return res.status(403).json({ message: "File contains sensitive data" });
      }
      res.json({ path: normalized, content });
    } catch (e: any) {
      if (e.code === "ENOENT") return res.status(404).json({ message: "File not found" });
      res.status(500).json({ message: "Failed to read file" });
    }
  });

  return httpServer;
}
