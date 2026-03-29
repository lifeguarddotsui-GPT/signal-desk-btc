import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { startMarketEngine, getMarketState, getPriceHistory, getIndicatorHistory, getCandleHistory, getLastSignalResult, getMultiTFCandles, getLastTritonSignal, getAntiIdleScanState } from "./market-engine";
import { priceBus, getLastPrice } from "./price-service";
import { insertAgentSchema, PROTOCOL_FEE_RATE, PROTOCOL_FEE_ADDRESS } from "@shared/schema";
import { verifyTxDigest, getOnChainBalance, verifyDepositTransfers, resolveNSName } from "./sui-verify";
import { generateAgentWallet, getAdapterStatus, getAdapter } from "./dex";
import { closeAllPositionsForAgent, closePositionForAgent, resetGasSpendTracking, markIntegrityComplete, getPendingUnfilledOrdersForAgent, registerTopoffResume, getAgentSkipStatus, getAgentBlockStatus, positionCloseInProgress, positionCloseCooldown, clearStreakCooldown } from "./dex/execution-engine";
import { suiToMist } from "./dex/gas";
import { startExecutorLoop } from "./executor/executor-loop";
import { runStartupIntegrityChecks, startPeriodicBalanceSync, setPeriodicSyncPriceFn, getPendingRecoveryCloses, clearPendingRecoveryCloses } from "./startup-integrity";
import { initRewardWallet, getRewardWalletAddress, getRewardWalletBalance, transferRewardToUser } from "./reward-wallet";
import { startPnlAuditLoop, runPnlAudit } from "./pnl-auditor";
import { startReconciliationEngine, getCachedSnapshot, getAllCachedSnapshots, recordFundFlow, removeFromSnapshotCache } from "./reconciliation-engine";
import { startPortfolioVerifier, getVerifierStatus, getAgentVerification, isPortfolioVerified, runOnDemandVerification, removeAgentFromVerifier } from "./portfolio-verifier";
import { setCommsBroadcast, pushCommEvent, getEvents as getCommsEvents, hydrateAgent as hydrateCommsAgent } from "./comms-engine";
import { MODE_PROFILES } from "./signal-engine";
import { db } from "./db";
import { positions as positionsTable, agents as agentsTable } from "@shared/schema";
import { gte, and, ne } from "drizzle-orm";
import { getSentimentSignal } from "./sentiment-flow-engine";
import { getBtcOverlayContext, getBtcPriceHistory } from "./btc-overlay-engine";
import { getSuiOverlayContext, getSuiPriceHistory } from "./sui-overlay-engine";
import { startPerformanceTracker, getPerformanceLogs, getLossAnalysis, resetPerformanceLog, type SnapshotInterval } from "./performance-tracker";
import { scanPositionsForAgent } from "./position-monitor";
import {
  type CachedOnChainPosition,
  setOnChainPositionsCache,
  getCachedOnChainPositions,
  invalidateOnChainPositionsCache,
} from "./on-chain-cache";

function sanitizeAgent(agent: any) {
  if (!agent) return agent;
  const { agentWallet, savingsWallet, ...safe } = agent;
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

export type { CachedOnChainPosition };

const gasTxCountCache = new Map<string, { count: number; timestamp: number }>();
const GAS_TX_COUNT_CACHE_TTL = 120_000;

const chainOrderScanCache = new Map<string, { orders: Array<{ orderId: string; collateral: number; direction: string; isStopOrder: boolean }>; timestamp: number }>();
const CHAIN_ORDER_SCAN_CACHE_TTL = 15_000;

export function invalidateOnChainPortfolioCache(agentId: string) {
  if ((globalThis as any).__onChainPortfolioCache) {
    (globalThis as any).__onChainPortfolioCache.delete(agentId);
  }
  chainDerivedCache.delete(agentId);
  invalidateOnChainPositionsCache(agentId);
}

export { setOnChainPositionsCache } from "./on-chain-cache";

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
  startReconciliationEngine();

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
  startPortfolioVerifier(storage);
  startPerformanceTracker();

  // Connect portfolio state engine to broadcast
  import("./portfolio-state").then(m => m.portfolioEngine.setBroadcast(broadcast)).catch(() => {});

  // Auto-generate savings wallets for existing agents that don't have one
  (async () => {
    try {
      const allAgents = await storage.getAgents();
      let generated = 0;
      for (const agent of allAgents) {
        if (!agent.savingsWalletAddress && agent.agentWallet && agent.agentWallet !== "external_wallet") {
          const sw = generateAgentWallet();
          await storage.updateAgent(agent.id, {
            savingsWallet: sw.encryptedPrivateKey,
            savingsWalletAddress: sw.address,
          });
          console.log(`[Savings] Auto-generated savings wallet for ${agent.name}: ${sw.address}`);
          generated++;
        }
      }
      if (generated > 0) console.log(`[Savings] Generated savings wallets for ${generated} existing agents`);
    } catch (err: any) {
      console.error("[Savings] Startup wallet generation failed:", err.message);
    }
  })();

  const { setPositionMonitorBroadcast } = await import("./position-monitor");
  setPositionMonitorBroadcast(broadcast);
  setCommsBroadcast(broadcast);

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

  app.get("/api/market/sentiment", (_req, res) => {
    try {
      res.json(getSentimentSignal("SUI-USDC"));
    } catch (e) {
      res.status(500).json({ message: "Failed to get sentiment data" });
    }
  });

  app.get("/api/market/btc-overlay", (_req, res) => {
    try {
      const overlay = getBtcOverlayContext();
      const history = getBtcPriceHistory();
      res.json({ overlay, history });
    } catch (e) {
      res.status(500).json({ message: "Failed to get BTC overlay data" });
    }
  });

  app.get("/api/market/sui-overlay", (_req, res) => {
    try {
      const overlay = getSuiOverlayContext();
      const history = getSuiPriceHistory();
      res.json({ overlay, history });
    } catch (e) {
      res.status(500).json({ message: "Failed to get SUI overlay data" });
    }
  });

  // ── Platform Stats: Total Agent TVL + 24h Agent Trade Volume ─────────────────
  app.get("/api/market/platform-stats", async (_req, res) => {
    try {
      const allAgents = await storage.getAgents();
      const activeAgents = allAgents.filter(a => a.status !== "stopped" && a.status !== "error");
      const runningAgents = allAgents.filter(a => a.status === "running");

      // TVL: sum of all active agent balances (SUI under management)
      const tvlSui = activeAgents.reduce((sum, a) => sum + (a.balance ?? 0), 0);

      // 24h volume: sum of notional (size_sui × entry_price) for positions opened in last 24h
      const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const positions24h = await db
        .select({
          sizeSui: positionsTable.sizeSui,
          entryPrice: positionsTable.entryPrice,
          collateral: positionsTable.collateral,
        })
        .from(positionsTable)
        .where(gte(positionsTable.openedAt, cutoff24h));

      const agentVolume24hSui = positions24h.reduce(
        (sum, p) => sum + (p.sizeSui ?? 0),
        0
      );
      const agentVolume24hNotional = positions24h.reduce(
        (sum, p) => sum + ((p.sizeSui ?? 0) * (p.entryPrice ?? 0)),
        0
      );
      const agentCollateral24h = positions24h.reduce(
        (sum, p) => sum + (p.collateral ?? 0),
        0
      );

      // Open positions collateral (current locked capital — only confirmed on-chain positions)
      const allOpenPositions = await storage.getAllOpenPositions();
      const onChainOpen = allOpenPositions.filter(p => p.status === "open");
      const lockedCollateral = onChainOpen.reduce((sum, p) => sum + (p.collateral ?? 0), 0);
      const pendingCollateral = allOpenPositions
        .filter(p => p.status === "pending_open")
        .reduce((sum, p) => sum + (p.collateral ?? 0), 0);

      res.json({
        tvlSui: parseFloat(tvlSui.toFixed(4)),
        agentVolume24hSui: parseFloat(agentVolume24hSui.toFixed(2)),
        agentVolume24hNotional: parseFloat(agentVolume24hNotional.toFixed(2)),
        agentCollateral24h: parseFloat(agentCollateral24h.toFixed(4)),
        lockedCollateral: parseFloat(lockedCollateral.toFixed(4)),
        pendingCollateral: parseFloat(pendingCollateral.toFixed(4)),
        activeAgentCount: activeAgents.length,
        runningAgentCount: runningAgents.length,
        tradeCount24h: positions24h.length,
      });
    } catch (e: any) {
      res.status(500).json({ message: "Failed to get platform stats", error: e.message });
    }
  });

  // ── Anti-Idle Engine Scanner State ────────────────────────────────────────────
  app.get("/api/market/anti-idle-scan", (_req, res) => {
    try {
      const scan = getAntiIdleScanState();
      if (!scan) {
        return res.json({ available: false });
      }
      res.json({
        available: true,
        trapScan: {
          detected: scan.trapScan.detected,
          side: scan.trapScan.side,
          trapStrength: scan.trapScan.trapStrength,
          reasons: scan.trapScan.reasons.slice(0, 3),
          scannedAt: scan.trapScan.scannedAt,
          readinessPct: Math.min(100, Math.round((scan.trapScan.trapStrength / 60) * 100)),
        },
        microScan: {
          valid: scan.microScan.valid,
          side: scan.microScan.side,
          score: scan.microScan.score,
          reasons: scan.microScan.reasons.slice(0, 3),
          scannedAt: scan.microScan.scannedAt,
          readinessPct: Math.min(100, Math.round((scan.microScan.score / 45) * 100)),
        },
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to get anti-idle scan state" });
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

      let readiness: {
        scoreReadinessPct: number;
        threshold: number;
        score: number;
        rrReadinessPct: number;
        minRr: number;
        currentRr: number;
        regime: string;
        blockingChecks: string[];
      } | null = null;

      if (triton) {
        const mode = triton.activeMode || "AUTO";
        const profile = MODE_PROFILES[mode];
        const threshold = profile.threshold;
        const minRr = 1.3;
        const scoreReadinessPct = Math.min(100, Math.round((triton.score / threshold) * 100));
        const rrReadinessPct = triton.rr > 0 ? Math.min(100, Math.round((triton.rr / minRr) * 100)) : 0;
        const blockingChecks: string[] = [];
        if (triton.side === "NONE") blockingChecks.push("No directional signal — waiting for MACD + price + HTF to align");
        if (triton.score < threshold) blockingChecks.push(`Score ${triton.score} < ${threshold} threshold for ${mode} mode`);
        if (triton.rr > 0 && triton.rr < minRr) blockingChecks.push(`Risk/Reward ${triton.rr.toFixed(2)} < ${minRr}× minimum`);
        if ((triton.side === "LONG" && triton.htfBias === "BEAR") || (triton.side === "SHORT" && triton.htfBias === "BULL")) {
          blockingChecks.push(`Counter-trend blocked: ${triton.side} vs HTF ${triton.htfBias}`);
        }
        readiness = {
          scoreReadinessPct,
          threshold,
          score: triton.score,
          rrReadinessPct,
          minRr,
          currentRr: triton.rr,
          regime: triton.regime,
          blockingChecks,
        };
      }

      res.json({
        available: true,
        signal: result.signal,
        side: result.side,
        reason: result.reason,
        longScore: result.longScore,
        shortScore: result.shortScore,
        conditions: result.conditions,
        indicators: result.indicators,
        readiness,
        triton: triton ? {
          side: triton.side,
          regime: triton.regime,
          activeMode: triton.activeMode,
          htfBias: triton.htfBias,
          score: triton.score,
          scoreBreakdown: triton.scoreBreakdown,
          threshold: triton.threshold,
          rr: triton.rr,
          sizeMultiplier: triton.sizeMultiplier,
          reasons: triton.reasons,
          entry: triton.entry,
          stop: triton.stop,
          takeProfit: triton.takeProfit,
          chopScalp: triton.chopScalp,
          liquidityTrap: triton.liquidityTrap,
          trapStrength: triton.trapStrength,
          microScalp: triton.microScalp,
        } : null,
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to get signal reasoning" });
    }
  });

  app.get("/api/agents", async (req, res) => {
    try {
      // Optional ?wallet= param scopes results to a specific owner wallet
      const walletFilter = req.query.wallet as string | undefined;
      // ownerWallet: deposit-based ownership lookup — works for ALL agents regardless of
      // how userId was stored (UUIDs vs wallet addresses). Finds agents the wallet has
      // deposited into, plus any agents where userId matches (new agents, pre-deposit).
      const ownerWallet = req.query.ownerWallet as string | undefined;

      let agentsList = await storage.getAgentsWithSignalAgents(walletFilter);

      if (ownerWallet === "not-connected") {
        // Sentinel value — no wallet connected. Return empty list immediately.
        res.json([]);
        return;
      }

      if (ownerWallet) {
        // Look up agents that this wallet has deposited into
        const ownerDeposits = await storage.getDepositsByWallet(ownerWallet);
        const ownedAgentIds = new Set(ownerDeposits.map(d => d.agentId));
        // Also resolve the wallet to a user UUID (new agents store userId as UUID not wallet)
        const ownerUser = await storage.getUserByWallet(ownerWallet);
        const ownerUserId = ownerUser?.id;
        // Filter: must have a deposit from this wallet OR have userId === wallet OR userId === UUID
        agentsList = agentsList.filter(a =>
          ownedAgentIds.has(a.id) || a.userId === ownerWallet || (ownerUserId && a.userId === ownerUserId)
        );
      }

      const sanitized = sanitizeAgents(agentsList);
      // Enrich each agent with the in-memory skip status (why it's waiting to trade)
      const enriched = sanitized.map((a: any) => {
        const skip = getAgentSkipStatus(a.id);
        return skip ? { ...a, skipReason: skip.reason, skipReasonAgeMs: skip.ageMs } : a;
      });
      res.json(enriched);
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
    savingsBalance: number;
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

  // Lightweight portfolio state snapshot — returns latest portfolio:tick data for all agents.
  // Used as the initial load fallback; subsequent updates come via WebSocket portfolio:tick events.
  app.get("/api/agents/portfolio-snapshot", async (_req, res) => {
    try {
      const { portfolioEngine } = await import("./portfolio-state");
      const states = portfolioEngine.getAllStates();
      res.json({ agents: states, timestamp: Date.now() });
    } catch {
      res.json({ agents: [], timestamp: Date.now() });
    }
  });

  // Canonical portfolio snapshot — single coherent response combining wallet balances,
  // open position equity, in-transit capital, and claimable rewards.
  // Reads from the already-populated onChainPortfolioCache (refreshed every 10s by balance sync).
  // No live RPC calls unless cache is completely cold.
  let _rwSnapshotCache: { bal: number; ts: number } | undefined;
  // Pending escrowed rewards cache for canonical snapshot — avoid DB hit every 12s poll
  let _pendingEscrowedCache: { rewards: Array<{ agentId: string; amount: number }>; ts: number } | undefined;
  const PENDING_ESCROWED_TTL = 30_000;

  // T002: Dedicated savings balance cache — never goes backwards to 0.
  // Updated whenever a non-zero savings balance is observed from any source.
  // Exposed on globalThis so reconciliation-engine and other modules can read it.
  const _agentSavingsCache = new Map<string, { balance: number; ts: number }>();
  (globalThis as any).__agentSavingsCache = _agentSavingsCache;

  // T002b: Proactive savings fetch cache — ensures savings balance is fetched after server
  // restart even when client hasn't triggered the activity endpoint yet.
  // TTL: 90s so each agent's savings is re-verified at most once per 90 seconds.
  const _agentSavingsFetchCache = new Map<string, { balance: number; ts: number }>();
  const SAVINGS_FETCH_TTL = 30_000;

  // T003b: Proactive funding wallet fetch cache — mirrors savings approach for the funding wallet.
  // TTL: 45s — fills portfolio cache when cold so canonical-snapshot can show "verified" data
  // without waiting for the client to trigger the per-agent activity endpoint.
  const _agentFundingFetchCache = new Map<string, { ts: number }>();
  const FUNDING_FETCH_TTL = 45_000;

  app.get("/api/portfolio/canonical-snapshot", async (req, res) => {
    try {
      const walletFilter = req.query.wallet as string | undefined;
      const ownerWallet = req.query.ownerWallet as string | undefined;
      // Sentinel — no wallet connected. Return zero-value snapshot immediately.
      if (ownerWallet === "not-connected") {
        res.json({ agents: [], totalEconomicValue: 0, netDeposited: 0, totalPnl: null, pnlStatus: "unconfirmed", freshness: "estimated", claimableRewardsValue: 0 });
        return;
      }
      let allAgents = await storage.getAgents(walletFilter);
      // Deposit-based ownership filter — same logic as /api/agents
      if (ownerWallet) {
        const ownerDeposits = await storage.getDepositsByWallet(ownerWallet);
        const ownedAgentIds = new Set(ownerDeposits.map(d => d.agentId));
        const ownerUser = await storage.getUserByWallet(ownerWallet);
        const ownerUserId = ownerUser?.id;
        allAgents = allAgents.filter(a =>
          ownedAgentIds.has(a.id) || a.userId === ownerWallet || (ownerUserId && a.userId === ownerUserId)
        );
      }
      const lastPrice = getLastPrice();
      const liveSuiPrice = lastPrice?.pyth?.price ?? lastPrice?.blended ?? 0;

      // Reward wallet balance (cached 30s to avoid hammering RPC on each poll)
      let _globalRewardWalletBal = 0;
      let rewardsFreshness: "verified" | "estimated" | "stale" = "stale";
      if (_rwSnapshotCache && Date.now() - _rwSnapshotCache.ts < 30_000) {
        _globalRewardWalletBal = Math.max(0, _rwSnapshotCache.bal - 0.01);
        rewardsFreshness = "verified";
      } else {
        try {
          const rwBal = await getRewardWalletBalance();
          _rwSnapshotCache = { bal: rwBal.sui, ts: Date.now() };
          _globalRewardWalletBal = Math.max(0, rwBal.sui - 0.01);
          rewardsFreshness = "verified";
        } catch {
          rewardsFreshness = "stale";
        }
      }

      // For wallet-scoped requests: compute claimableRewardsValue from pending escrowed reward
      // amounts for the wallet's agents. This shows the actual amount the user can claim,
      // regardless of what the global reward wallet currently holds.
      let claimableRewardsValue = _globalRewardWalletBal;
      if (allAgents.length > 0) {
        try {
          // Refresh pending escrow cache at most once every 30s to protect the DB
          if (!_pendingEscrowedCache || Date.now() - _pendingEscrowedCache.ts > PENDING_ESCROWED_TTL) {
            const allRewards = await storage.getRewards();
            _pendingEscrowedCache = {
              rewards: allRewards
                .filter(r =>
                  r.status === "pending" &&
                  r.escrowTxDigest &&
                  r.escrowTxDigest !== "agent_retained" &&
                  r.escrowTxDigest !== "pending_escrow"
                )
                .map(r => ({ agentId: r.agentId, amount: r.amount })),
              ts: Date.now(),
            };
          }
          const agentIdSet = new Set(allAgents.map(a => a.id));
          const agentEscrowed = _pendingEscrowedCache.rewards.filter(r => agentIdSet.has(r.agentId));
          if (agentEscrowed.length > 0) {
            claimableRewardsValue = agentEscrowed.reduce((s, r) => s + r.amount, 0);
            rewardsFreshness = "verified";
          }
        } catch { /* fall back to global wallet balance */ }
      }

      const computePnl = (side: string, entryPrice: number, size: number, collateral: number) => {
        if (liveSuiPrice <= 0 || entryPrice <= 0) return 0;
        const rawPnl = side === "long"
          ? (liveSuiPrice - entryPrice) * size / liveSuiPrice
          : (entryPrice - liveSuiPrice) * size / liveSuiPrice;
        return Math.max(-collateral, rawPnl);
      };

      let totalWalletValue = 0;
      let totalOpenPositionValue = 0;
      let totalInTransitValue = 0;
      let totalPendingSettlementValue = 0;
      let totalNetDeposited = 0;
      let totalRealizedLossesValue = 0;
      let totalOpenPositionCount = 0;
      let walletFreshness: "verified" | "estimated" | "stale" = "verified";
      let positionsFreshness: "verified" | "estimated" | "stale" = "verified";

      const agentSnapshots: Array<{
        agentId: string;
        name: string;
        walletValue: number;
        openPositionValue: number;
        inTransitValue: number;
        pendingSettlementValue: number;
        realizedLossesValue: number;
        portfolioValue: number;
        netDeposited: number;
        freshness: string;
        walletBreakdown: { funding: number; savings: number };
      }> = [];

      for (const agent of allAgents) {
        if (!agent.walletAddress) continue;

        let cached = onChainPortfolioCache.get(agent.id);
        let cacheAge = cached ? Date.now() - cached.timestamp : Infinity;
        let cacheValid = cached && cacheAge < ONCHAIN_PORTFOLIO_CACHE_TTL;

        let freeSui = 0;
        let totalLocked = 0;
        let agentFreshness: "verified" | "estimated" | "stale";

        // T002: Read savings from dedicated cache (never goes backwards).
        // Update dedicated cache whenever a non-zero value is observed from onChainPortfolioCache.
        const cachedSavings = cached?.savingsBalance ?? 0;
        const existingSavingsCache = _agentSavingsCache.get(agent.id);
        if (cachedSavings > 0) {
          _agentSavingsCache.set(agent.id, { balance: cachedSavings, ts: Date.now() });
        }
        let agentSavingsBalance = Math.max(cachedSavings, existingSavingsCache?.balance ?? 0);

        // T002b: Proactive savings fetch — re-verify savings balance from chain whenever TTL
        // expires, regardless of whether current cached value is 0. This ensures savings that
        // accumulated since the last fetch are discovered within SAVINGS_FETCH_TTL seconds.
        if (agent.savingsWalletAddress) {
          const lastFetch = _agentSavingsFetchCache.get(agent.id);
          const shouldFetch = !lastFetch || (Date.now() - lastFetch.ts) > SAVINGS_FETCH_TTL;
          if (shouldFetch) {
            try {
              const savBal = await getOnChainBalance(agent.savingsWalletAddress);
              const fetchedBalance = savBal.sui;
              _agentSavingsFetchCache.set(agent.id, { balance: fetchedBalance, ts: Date.now() });
              // Use the fresh on-chain value directly — don't ratchet, so an emptied savings
              // wallet correctly shows 0.0000 instead of a stale positive balance.
              agentSavingsBalance = fetchedBalance;
              // Only update the ratchet cache when positive (fallback for failed future fetches)
              if (fetchedBalance > 0) {
                _agentSavingsCache.set(agent.id, { balance: fetchedBalance, ts: Date.now() });
              }
              // Patch activity cache so activity endpoint also reflects fresh savings
              const actCached = onChainPortfolioCache.get(agent.id);
              if (actCached) actCached.savingsBalance = agentSavingsBalance;
            } catch {
              // Mark attempted to avoid hammering RPC on every 30s poll during outage
              _agentSavingsFetchCache.set(agent.id, { balance: lastFetch?.balance ?? 0, ts: Date.now() });
            }
          } else if (lastFetch) {
            // Use the last fetched value (may be 0 if wallet was emptied) — avoid ratchet
            agentSavingsBalance = lastFetch.balance;
          }
        }

        if (cacheValid) {
          freeSui = cached.freeSui;
          totalLocked = cached.totalLocked;
          agentFreshness = cacheAge < 15_000 ? "verified" : "estimated";
        } else {
          // T003: Stale fallback — use DB balance for freeSui.
          // T003b: Proactive funding wallet fetch — when portfolio cache is cold (e.g. after
          // server restart), fetch the funding wallet balance directly from chain so the
          // canonical-snapshot can return "verified" freshness without the client having to
          // call the per-agent activity endpoint first.
          // Rate-limited to once per 45s per agent to avoid hammering RPC.
          const lastFundingFetch = _agentFundingFetchCache.get(agent.id);
          const shouldFetchFunding = !lastFundingFetch || (Date.now() - lastFundingFetch.ts) > FUNDING_FETCH_TTL;
          if (shouldFetchFunding) {
            try {
              const onChainFunding = await getOnChainBalance(agent.walletAddress);
              freeSui = onChainFunding.sui;
              // Rebuild totalLocked from DB as best estimate when we don't have on-chain positions
              const dbOpenForLocked = await storage.getPositions(agent.id);
              totalLocked = dbOpenForLocked.filter(p => p.status === "open").reduce((s, p) => s + (p.collateral || 0), 0);
              // Populate portfolio cache so subsequent calls see fresh data
              const existingCached = onChainPortfolioCache.get(agent.id);
              onChainPortfolioCache.set(agent.id, {
                freeSui,
                savingsBalance: existingCached?.savingsBalance ?? agentSavingsBalance,
                positions: existingCached?.positions ?? [],
                totalLocked,
                timestamp: Date.now(),
                source: "on-chain",
              });
              _agentFundingFetchCache.set(agent.id, { ts: Date.now() });
              agentFreshness = "verified";
              // Re-read from cache so the unrealized PnL block uses the fresh data
              // and the stale-path totalLocked accumulator is NOT double-triggered.
              cached = onChainPortfolioCache.get(agent.id);
              cacheAge = 0;
              cacheValid = true;
            } catch {
              // RPC failed — fall back to DB balance, mark as "estimated" (not stale — we have recent DB data)
              freeSui = Math.max(0, agent.balance || 0);
              _agentFundingFetchCache.set(agent.id, { ts: Date.now() });
              agentFreshness = "estimated";
            }
          } else {
            freeSui = Math.max(0, agent.balance || 0);
            agentFreshness = "estimated";
          }
        }

        if (agentFreshness === "stale") walletFreshness = "stale";
        else if (agentFreshness === "estimated" && walletFreshness === "verified") walletFreshness = "estimated";

        // Unrealized PnL from cached positions
        let unrealizedPnl = 0;
        const allDbPositions = await storage.getPositions(agent.id);

        if (liveSuiPrice > 0 && cacheValid) {
          for (const pos of cached.positions) {
            unrealizedPnl += computePnl(pos.side, pos.entryPrice, pos.size, pos.collateral);
          }
          positionsFreshness = agentFreshness === "stale" ? "stale"
            : agentFreshness === "estimated" && positionsFreshness === "verified" ? "estimated"
            : positionsFreshness;
        } else {
          // T003: Stale fallback — compute unrealizedPnl from DB open positions
          positionsFreshness = "stale";
          const dbOpenPositions = allDbPositions.filter(p => p.status === "open");
          for (const p of dbOpenPositions) {
            unrealizedPnl += computePnl(
              p.side || "long",
              (p as any).entryPrice || 0,
              (p as any).sizeSui || 0,
              p.collateral || 0
            );
            // Also reconstruct totalLocked from DB when cache is stale
            totalLocked += p.collateral || 0;
          }
        }

        // Supplement totalLocked from the on-chain positions cache (populated by verifier every 30s
        // and by the activity endpoint on each position poll). This ensures on-chain positions that
        // exist but aren't yet re-opened in the DB still contribute to openPositionValue.
        const separateOnChainCache = getCachedOnChainPositions(agent.id);
        if (separateOnChainCache && separateOnChainCache.totalLocked > totalLocked) {
          totalLocked = separateOnChainCache.totalLocked;
          if (positionsFreshness === "stale") positionsFreshness = "estimated";
        }

        // T005: Pending Settlement — positions whose close TX has been submitted and is settling
        // (collateral leaving the position but not yet arrived in the wallet).
        // IMPORTANT: close_order_working (working stop/limit order) is NOT settling — the position
        // is still open on-chain and collateral is still locked in the protocol. Only include
        // close_tx_submitted where the actual close transaction was broadcast.
        const settlingDbPositions = allDbPositions.filter(p =>
          p.status === "open" &&
          p.closeState === "close_tx_submitted"
        );
        const pendingSettlementValue = settlingDbPositions.reduce((s, p) => s + (p.collateral || 0), 0);

        const pendingOrders = getPendingUnfilledOrdersForAgent(agent.id);
        const pendingOrderCollateral = pendingOrders.reduce((s, o) => s + o.collateral, 0);

        // T004: In Transit — actual wallet→wallet transfers (savings splits, reward claims).
        // Sourced from transfer_jobs table (CREATED + SUBMITTED status).
        const pendingTransferJobs = await storage.getPendingTransferJobs(agent.id);
        // Reconcile: if savings balance is now visible, mark jobs as confirmed
        if (agentSavingsBalance > 0) {
          storage.reconcileTransferJobsBySavingsBalance(agent.id, agentSavingsBalance).catch(() => {});
        }
        const transferJobsInTransit = pendingTransferJobs
          .filter(j => j.status === "CREATED" || j.status === "SUBMITTED")
          .reduce((s, j) => s + (j.amountSui || 0), 0);
        const inTransitValue = transferJobsInTransit + pendingOrderCollateral;

        // ── Deposits-table reconciliation ─────────────────────────────────────
        // Use the deposits table as the authoritative source for totalDeposited.
        // agent.totalDeposited can drift upward from: activity-endpoint inference,
        // double-counting pre-funded wallet balance, or import-deposit operations.
        // The deposits table only ever grows via explicit deposit/import transactions,
        // so its sum is always correct.
        let effectiveTotalDeposited = agent.totalDeposited || 0;
        let effectiveProtocolFeePaid = agent.protocolFeePaid || 0;
        try {
          const agentDeposits = await storage.getDepositsByAgent(agent.id);
          if (agentDeposits.length > 0) {
            const depositsGross = agentDeposits.reduce((s, d) => s + (d.grossAmount || 0), 0);
            const depositsFee = agentDeposits.reduce((s, d) => s + (d.protocolFee || 0), 0);
            if (depositsGross > 0 && Math.abs(depositsGross - effectiveTotalDeposited) > 0.01) {
              // Auto-correct agent.totalDeposited to match deposits table
              storage.updateAgent(agent.id, {
                totalDeposited: depositsGross,
                protocolFeePaid: depositsFee,
              }).catch(() => {});
              console.log(`[Portfolio] Corrected ${agent.name} totalDeposited from deposits table: ${effectiveTotalDeposited.toFixed(4)} → ${depositsGross.toFixed(4)} SUI`);
              effectiveTotalDeposited = depositsGross;
              effectiveProtocolFeePaid = depositsFee;
            }
          }
        } catch (_) { /* non-blocking — fall back to agent record */ }

        // Net deposited — use deposits-table-reconciled values
        const rawNetDeposited = effectiveTotalDeposited - effectiveProtocolFeePaid;
        let netDeposited = Number.isFinite(rawNetDeposited) && rawNetDeposited >= 0 ? rawNetDeposited : 0;

        // walletValue = funding wallet + savings wallet (all settled agent-owned balances)
        const walletValue = freeSui + agentSavingsBalance;
        // Subtract settling collateral from totalLocked — settling positions are already counted
        // in pendingSettlementValue. Including them in BOTH openPositionValue AND pendingSettlementValue
        // would double-count the collateral in agentEconomicValue (inflating PnL during close ops).
        const settlingCollateralInLocked = settlingDbPositions.reduce((s, p) => s + (p.collateral || 0), 0);
        const effectiveLocked = Math.max(0, totalLocked - settlingCollateralInLocked);
        const openPositionValue = effectiveLocked + Math.max(0, unrealizedPnl);

        // F001: Portfolio-derived realized PnL — NEVER trust agent.totalPnl here.
        // agent.totalPnl accumulates per-close price-estimated PnL and can drift badly
        // (overcount losses by 10-20+ SUI vs reality). Portfolio-math is always internally
        // consistent with the displayed economic value and total PnL.
        //
        // Formula derivation:
        //   totalPnl     = economicValue - netDeposited                (ground truth)
        //   unrealizedPnl = mark-to-market on open positions           (already computed)
        //   realizedPnl  = totalPnl - max(0, unrealizedPnl)
        //
        // Note: openPositionValue = totalLocked + max(0, unrealizedPnl), so positive
        // unrealized gains ARE already embedded in economicValue and must be subtracted.
        // Negative unrealized is NOT in economicValue (collateral floor), so it falls
        // into the realized bucket — which is correct since that loss is "already baked in".
        const agentEconomicValue = walletValue + openPositionValue + inTransitValue + pendingSettlementValue;

        // Fresh-agent deposit baseline correction:
        // If an agent has never completed a trade, has no open positions, and totalDeposited
        // is inflated (e.g., from an untracked manual withdrawal or mis-attributed deposit),
        // reset the deposit baseline to the current economic value so that:
        //   • NET DEPOSIT shows the actual SUI currently in the agent
        //   • PnL starts at 0 for a fresh start
        //   • The DB is corrected so this is persistent going forward
        // Guard: only when no positions are open (otherwise mark-to-market would keep resetting).
        const hasOpenPositions = effectiveLocked > 0.001 || pendingSettlementValue > 0.001;
        if ((agent.totalTrades ?? 0) === 0 && !hasOpenPositions && agentEconomicValue > 0.001 && netDeposited > agentEconomicValue + 0.01) {
          const correctedGross = agentEconomicValue + effectiveProtocolFeePaid;
          storage.updateAgent(agent.id, { totalDeposited: correctedGross }).catch(() => {});
          console.log(`[Portfolio] Fresh-agent baseline reset for ${agent.name}: netDeposited ${netDeposited.toFixed(4)} → ${agentEconomicValue.toFixed(4)} SUI (0 closed trades, correcting inflated deposit total)`);
          netDeposited = agentEconomicValue;
        }

        const agentPortfolioTotalPnl = agentEconomicValue - netDeposited;
        const agentRealizedPnl = agentPortfolioTotalPnl - Math.max(0, unrealizedPnl);
        const agentRealizedLossesValue = agentRealizedPnl < 0 ? Math.abs(agentRealizedPnl) : 0;

        // Drift metric: difference between stale agent.totalPnl and portfolio truth.
        // >1 SUI drift = agent.totalPnl is overcounting / undercounting losses.
        const agentDbPnl = agent.totalPnl ?? 0;
        const agentPnlDrift = Math.abs(agentDbPnl - agentPortfolioTotalPnl);

        // Open position count: DB open positions not actively being closed (close_tx_submitted),
        // supplemented by the on-chain verifier count when it shows more positions than the DB.
        // This ensures positions that are real on-chain but not yet re-opened in the DB
        // still register as "open" in the POSITIONS bucket.
        // Only trust the verifier count if it was set within the last 90 seconds (fresh RPC data).
        // Stale verifier state can hold a non-zero positionCount from a previous successful run
        // while the DB has already been updated to reflect the close — causing a phantom position.
        const dbOpenPositionCount = allDbPositions.filter(p =>
          (p.status === "open" || p.status === "pending_open") &&
          p.closeState !== "close_tx_submitted"
        ).length;
        const verifierStateForCount = getAgentVerification(agent.id);
        const verifierAge = verifierStateForCount
          ? Date.now() - new Date(verifierStateForCount.verifiedAt).getTime()
          : Infinity;
        const verifierFresh = verifierAge < 90_000 && verifierStateForCount?.source === "rpc";
        const onChainPositionCount = verifierFresh ? (verifierStateForCount?.positionCount ?? 0) : 0;
        const agentOpenPositionCount = Math.max(dbOpenPositionCount, onChainPositionCount);

        agentSnapshots.push({
          agentId: agent.id,
          name: agent.name,
          walletValue,
          openPositionValue,
          inTransitValue,
          pendingSettlementValue,
          realizedLossesValue: agentRealizedLossesValue,
          unrealizedPnl,
          portfolioTotalPnl: agentPortfolioTotalPnl,
          pnlDrift: agentPnlDrift,
          portfolioValue: walletValue + openPositionValue + inTransitValue + pendingSettlementValue,
          netDeposited,
          freshness: agentFreshness,
          walletBreakdown: { funding: freeSui, savings: agentSavingsBalance },
          openPositionCount: agentOpenPositionCount,
        });

        totalWalletValue += walletValue;
        totalOpenPositionValue += openPositionValue;
        totalInTransitValue += inTransitValue;
        totalPendingSettlementValue += pendingSettlementValue;
        totalNetDeposited += netDeposited;
        totalRealizedLossesValue += agentRealizedLossesValue;
        totalOpenPositionCount += agentOpenPositionCount;
      }

      const overallFreshness: "verified" | "estimated" | "stale" =
        walletFreshness === "stale" || positionsFreshness === "stale" ? "stale"
        : walletFreshness === "estimated" || positionsFreshness === "estimated" ? "estimated"
        : "verified";

      // Economic value = all user-owned value: agent balances + positions + in-transit + claimable rewards.
      // claimableRewardsValue represents confirmed pending rewards the user can withdraw from the reward wallet.
      // These are earned profits (already subtracted from agent wallet at escrow time), so including them
      // in EV gives a complete picture: Portfolio (Funding + Savings + Positions) + Claimable Rewards.
      const totalEconomicValue = totalWalletValue + totalOpenPositionValue + totalInTransitValue + totalPendingSettlementValue + claimableRewardsValue;

      // F001: Portfolio-derived coverage.
      // With portfolio-math realized losses, attributedValue = economicValue + realizedLosses
      // always equals netDeposited (by definition). So coverage reflects data freshness only.
      // coveragePct signals how confident we are in the underlying data, not a capital-tracking gap.
      const netDepositedFinal = Number.isFinite(totalNetDeposited) && totalNetDeposited > 0 ? totalNetDeposited : null;
      // Portfolio-derived total realized losses (consistent with totalPnl)
      const portfolioDerivedTotalPnl = netDepositedFinal !== null ? totalEconomicValue - netDepositedFinal : null;
      const attributedValue = totalEconomicValue + totalRealizedLossesValue;
      // Coverage: capped at 100 — will be ~100% when data is fresh (by construction)
      const coveragePct = netDepositedFinal !== null && netDepositedFinal > 0
        ? Math.min(100, Math.round((attributedValue / netDepositedFinal) * 100))
        : null;
      // Unattributed: structural gap when realized losses are understated vs netDeposited
      // With portfolio-derived losses this should always be 0; kept for legacy UI compatibility.
      const unattributedValue = netDepositedFinal !== null
        ? Math.max(0, netDepositedFinal - attributedValue)
        : null;

      // PnL status: driven by data freshness, not by coverage math.
      // "verified" = on-chain RPC data was successfully fetched this cycle
      // "provisional" = cached/estimated wallet data
      // "unconfirmed" = stale or no live price
      const pnlStatus: "verified" | "provisional" | "unconfirmed" =
        overallFreshness === "stale" || !netDepositedFinal ? "unconfirmed"
        : overallFreshness === "verified" ? "verified"
        : "provisional";

      // Total PnL always shown when we have netDeposited and economicValue (even if provisional)
      const totalPnl = netDepositedFinal !== null && Number.isFinite(totalEconomicValue)
        ? totalEconomicValue - netDepositedFinal
        : null;

      // Invariant check: wallets + positions + transit + claimable rewards == economicValue
      const invariantSum = totalWalletValue + totalOpenPositionValue + totalInTransitValue + totalPendingSettlementValue + claimableRewardsValue;
      const invariantDelta = Math.abs(invariantSum - totalEconomicValue);
      const invariantOk = invariantDelta < 0.001;

      res.json({
        walletValue: totalWalletValue,
        openPositionValue: totalOpenPositionValue,
        openPositionCount: totalOpenPositionCount,
        inTransitValue: totalInTransitValue,
        pendingSettlementValue: totalPendingSettlementValue,
        claimableRewardsValue,
        realizedLossesValue: totalRealizedLossesValue,
        unattributedValue,
        attributedValue,
        coveragePct,
        pnlStatus,
        totalEconomicValue,
        netDeposited: netDepositedFinal,
        totalPnl,
        // F001 diagnostic fields
        portfolioDerivedTotalPnl,
        invariantOk,
        invariantDelta,
        freshness: {
          wallet: walletFreshness,
          positions: positionsFreshness,
          transfers: totalInTransitValue > 0 ? "estimated" : "verified",
          rewards: rewardsFreshness,
          overall: overallFreshness,
        },
        agents: agentSnapshots,
        snapshotAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error("[CanonicalSnapshot]", e);
      res.status(500).json({ error: "snapshot failed" });
    }
  });

  // ── Reconciliation Snapshot APIs ────────────────────────────────────────────
  // Serve pre-computed canonical state from the reconciliation engine.
  // These are always instant (no DB or RPC hits) since data is warm-cached.

  app.get("/api/portfolio/snapshot", async (req, res) => {
    const ownerWallet = req.query.ownerWallet as string | undefined;
    if (ownerWallet === "not-connected") {
      return res.json({ snapshots: [], ready: false, timestamp: Date.now() });
    }
    let all = getAllCachedSnapshots();
    if (all.length === 0) {
      // Cold start — no snapshot yet, return empty
      return res.json({ snapshots: [], ready: false, timestamp: Date.now() });
    }
    // Apply wallet ownership filter when ownerWallet is provided
    if (ownerWallet) {
      try {
        const ownerDeposits = await storage.getDepositsByWallet(ownerWallet);
        const ownedAgentIds = new Set(ownerDeposits.map(d => d.agentId));
        const ownerUser = await storage.getUserByWallet(ownerWallet);
        const ownerUserId = ownerUser?.id;
        const allAgentsForFilter = await storage.getAgents();
        const ownerAgentIds = new Set(
          allAgentsForFilter
            .filter(a => ownedAgentIds.has(a.id) || a.userId === ownerWallet || (ownerUserId && a.userId === ownerUserId))
            .map(a => a.id)
        );
        all = all.filter(snap => ownerAgentIds.has(snap.agentId));
      } catch { /* non-blocking — fall through to unfiltered */ }
    }
    const totalEconomicValue = all.reduce((s, snap) => s + (snap.economicValue || 0), 0);
    const totalOpenCollateral = all.reduce((s, snap) => s + (snap.openCollateral || 0), 0);
    const totalUnrealizedPnl = all.reduce((s, snap) => s + (snap.unrealizedPnl || 0), 0);
    const totalInTransit = all.reduce((s, snap) => s + (snap.inTransit || 0), 0);
    const totalSettlementPending = all.reduce((s, snap) => s + (snap.settlementPending || 0), 0);
    const totalClaimableRewards = all.reduce((s, snap) => s + (snap.claimableRewards || 0), 0);
    const totalSettledBalance = all.reduce((s, snap) => s + (snap.settledBalance || 0), 0);
    const totalNetDeposited = all.reduce((s, snap) => s + (snap.netDeposited || 0), 0);
    const totalPnl = all.reduce((s, snap) => s + (snap.totalPnl || 0), 0);
    const minHealth = all.length > 0 ? Math.min(...all.map(s => s.accountingHealth || 0)) : 100;
    const worstConfidence = all.some(s => s.confidence === "pending") ? "pending"
      : all.some(s => s.confidence === "live") ? "live" : "verified";
    res.json({
      ready: true,
      snapshots: all,
      aggregated: {
        economicValue: totalEconomicValue,
        settledBalance: totalSettledBalance,
        openCollateral: totalOpenCollateral,
        unrealizedPnl: totalUnrealizedPnl,
        inTransit: totalInTransit,
        settlementPending: totalSettlementPending,
        claimableRewards: totalClaimableRewards,
        netDeposited: totalNetDeposited,
        totalPnl,
        accountingHealth: minHealth,
        confidence: worstConfidence,
      },
      timestamp: Date.now(),
    });
  });

  app.get("/api/agents/:id/snapshot", async (req, res) => {
    const cached = getCachedSnapshot(req.params.id);
    if (!cached) {
      // Try to get from DB as fallback
      try {
        const snap = await storage.getPortfolioSnapshot(req.params.id);
        if (snap) return res.json({ ...snap, _source: "db" });
      } catch {}
      return res.status(404).json({ error: "Snapshot not yet computed — reconciler warming up" });
    }
    res.json({ ...cached.snapshot, _source: "cache", _ageMs: Date.now() - cached.computedAt });
  });

  // ── F003: Forensic PnL Audit ─────────────────────────────────────────────
  // Deep bottom-up reconstruction of PnL from raw position records.
  // Invariant checks, gap analysis, and overcounting candidate detection.
  app.get("/api/agents/:id/forensics", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ error: "Agent not found" });

      const allPositions = await storage.getPositions(req.params.id);

      // Categorise positions by status and PnL confidence
      const openPositions = allPositions.filter(p => p.status === "open");
      const closedPositions = allPositions.filter(p => p.status === "closed" || p.status === "cancelled_unfilled");
      const pendingPositions = allPositions.filter(p => p.status === "pending_open" || p.status === "pending_close");

      // Per-position PnL breakdown with confidence scoring
      type PosAudit = {
        id: string;
        side: string | null;
        collateral: number;
        sizeSui: number;
        unrealizedPnl: number;
        closeReason: string | null;
        closeTxDigest: string | null;
        openedAt: string | null;
        closedAt: string | null;
        pnlConfidence: "on-chain" | "synthetic" | "price-estimated" | "cancelled";
        pnlNote: string;
      };

      const closedAudit: PosAudit[] = closedPositions.map(p => {
        const digest = p.closeTxDigest || "";
        const pnl = p.unrealizedPnl ?? 0;
        let confidence: PosAudit["pnlConfidence"];
        let note: string;

        if (p.status === "cancelled_unfilled" || digest.startsWith("cancelled")) {
          confidence = "cancelled";
          note = "Position cancelled before fill — zero PnL";
        } else if (digest.length > 30 && !digest.startsWith("force_") && !digest.startsWith("synth") && !digest.startsWith("position_gone")) {
          confidence = "on-chain";
          note = "PnL from on-chain tx — highest confidence";
        } else if (digest.startsWith("force_") || digest.startsWith("synth") || digest.startsWith("position_gone")) {
          confidence = "synthetic";
          note = "Synthetic close digest — PnL may be estimated";
        } else {
          confidence = "price-estimated";
          note = "Price-based PnL estimate at close time — may drift";
        }

        return {
          id: p.id,
          side: p.side,
          collateral: p.collateral ?? 0,
          sizeSui: p.sizeSui ?? 0,
          unrealizedPnl: pnl,
          closeReason: p.closeReason,
          closeTxDigest: digest,
          openedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
          closedAt: p.closedAt ? new Date(p.closedAt).toISOString() : null,
          pnlConfidence: confidence,
          pnlNote: note,
        };
      });

      // Sum PnL by confidence tier
      const onChainPnl = closedAudit.filter(p => p.pnlConfidence === "on-chain").reduce((s, p) => s + p.unrealizedPnl, 0);
      const syntheticPnl = closedAudit.filter(p => p.pnlConfidence === "synthetic").reduce((s, p) => s + p.unrealizedPnl, 0);
      const estimatedPnl = closedAudit.filter(p => p.pnlConfidence === "price-estimated").reduce((s, p) => s + p.unrealizedPnl, 0);
      const cancelledPnl = closedAudit.filter(p => p.pnlConfidence === "cancelled").reduce((s, p) => s + p.unrealizedPnl, 0);
      const positionSumPnl = onChainPnl + syntheticPnl + estimatedPnl + cancelledPnl;

      // Unrealized from open positions
      const currentPrice = getLastPrice()?.price ?? 0;
      let liveUnrealizedPnl = 0;
      if (currentPrice > 0) {
        liveUnrealizedPnl = openPositions.reduce((sum, p) => {
          if (!p.entryPrice || p.entryPrice === 0) return sum + (p.unrealizedPnl || 0);
          const pnl = p.side === "long"
            ? (currentPrice - p.entryPrice) * p.sizeSui / currentPrice
            : (p.entryPrice - currentPrice) * p.sizeSui / currentPrice;
          const posCollateral = p.collateral || p.sizeSui / (agent.leverage || 25);
          return sum + Math.min(posCollateral * ((agent.leverage || 25) - 1), Math.max(-posCollateral, pnl));
        }, 0);
      } else {
        liveUnrealizedPnl = openPositions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
      }

      // Key diagnostic values
      const netDeposited = (agent.totalDeposited || 0) - (agent.protocolFeePaid || 0);
      const dbPnl = agent.totalPnl ?? 0;
      const dbPnlDriftFromPositions = Math.abs(dbPnl - positionSumPnl);
      const portfolioDerivedPnl = netDeposited > 0 ? (agent.balance || 0) - netDeposited : null;

      // Invariant checks
      const invariants = [
        {
          name: "realizedPnl + unrealizedPnl ≈ totalPnl",
          expected: `${(positionSumPnl + liveUnrealizedPnl).toFixed(4)}`,
          actual: `${dbPnl.toFixed(4)}`,
          ok: Math.abs(positionSumPnl + liveUnrealizedPnl - dbPnl) < 2.0,
          note: "Gap > 2 SUI = double-counting or missing close records",
        },
        {
          name: "cancelled positions have zero PnL",
          expected: "0",
          actual: `${cancelledPnl.toFixed(4)}`,
          ok: Math.abs(cancelledPnl) < 0.01,
          note: "Non-zero PnL on cancelled positions inflates realized losses",
        },
        {
          name: "on-chain positions account for most volume",
          expected: ">50%",
          actual: `${closedAudit.length > 0 ? Math.round(closedAudit.filter(p => p.pnlConfidence === "on-chain").length / closedAudit.length * 100) : 0}%`,
          ok: closedAudit.length === 0 || closedAudit.filter(p => p.pnlConfidence === "on-chain").length / closedAudit.length > 0.5,
          note: "Low on-chain % means most PnL is price-estimated and likely drifted",
        },
      ];

      // Overcounting candidates: duplicate tx digests (same close tx used for multiple positions)
      const digestCounts = new Map<string, number>();
      closedAudit.forEach(p => {
        if (p.closeTxDigest && p.closeTxDigest.length > 30) {
          digestCounts.set(p.closeTxDigest, (digestCounts.get(p.closeTxDigest) || 0) + 1);
        }
      });
      const duplicateDigests = Array.from(digestCounts.entries())
        .filter(([, count]) => count > 1)
        .map(([digest, count]) => ({ digest, count }));

      // ── PnL Gap Explanation ──────────────────────────────────────────────
      // "Position History PnL" (positionSumPnl) vs "Agent DB PnL" (dbPnl) may differ.
      // The gap is EXPECTED because position history only captures price-estimated
      // trade PnL (entry vs exit price). The agent DB totalPnl is computed from
      // on-chain wallet balance changes, which include:
      //   + Funding payments (credited or debited over hold period)
      //   + Keeper settlement incentives
      //   - Trading fees (charged on open and close)
      //   - Liquidation fees (if applicable)
      // A gap of 0.1–0.5 SUI per trade is normal. Gaps >2 SUI per 10 trades suggest
      // funding/fee accounting issues.
      const pnlGapSui = dbPnl - positionSumPnl;
      const tradeCount = agent.totalTrades || closedPositions.filter(p => p.status !== "cancelled_unfilled").length || 1;
      const avgGapPerTrade = pnlGapSui / tradeCount;
      const gapSeverity = Math.abs(pnlGapSui) < 1.0 ? "normal"
        : Math.abs(pnlGapSui) < 5.0 ? "elevated"
        : "high";
      if (gapSeverity !== "normal") {
        console.log(`[PnLForensics] ${agent.name}: PnL gap ${pnlGapSui.toFixed(3)} SUI over ${tradeCount} trades (${avgGapPerTrade.toFixed(3)}/trade) — ${gapSeverity}. Likely sources: funding payments, fees, keeper incentives.`);
      }

      res.json({
        agentId: agent.id,
        agentName: agent.name,
        generatedAt: new Date().toISOString(),
        summary: {
          netDeposited,
          agentDbPnl: dbPnl,
          portfolioDerivedPnl,
          positionSumPnl,
          liveUnrealizedPnl,
          dbPnlDriftFromPositions,
          positionCounts: {
            open: openPositions.length,
            closed: closedPositions.length,
            pending: pendingPositions.length,
          },
        },
        pnlComponentAnalysis: {
          keeperNetPnl: dbPnl,
          positionHistoryPnl: positionSumPnl,
          gapSui: pnlGapSui,
          gapSeverity,
          avgGapPerTrade,
          explanation: "Position history captures price-estimated trade PnL only. Keeper net PnL includes funding payments, trading fees, keeper incentives, and liquidation fees. A gap is expected and normal.",
          likelySources: [
            "Funding rate payments (credited/debited over hold period)",
            "Trading fees on open and close (~0.06% per side)",
            "Keeper settlement incentives",
            "Liquidation fees (if applicable)",
          ],
        },
        pnlByConfidenceTier: {
          onChain: { count: closedAudit.filter(p => p.pnlConfidence === "on-chain").length, totalPnl: onChainPnl },
          synthetic: { count: closedAudit.filter(p => p.pnlConfidence === "synthetic").length, totalPnl: syntheticPnl },
          estimated: { count: closedAudit.filter(p => p.pnlConfidence === "price-estimated").length, totalPnl: estimatedPnl },
          cancelled: { count: closedAudit.filter(p => p.pnlConfidence === "cancelled").length, totalPnl: cancelledPnl },
        },
        invariants,
        duplicateDigests,
        positions: {
          open: openPositions.map(p => {
            const posCollateral = p.collateral || p.sizeSui / (agent.leverage || 25);
            let posLiveUnrealizedPnl = p.unrealizedPnl ?? 0;
            if (currentPrice > 0 && p.entryPrice && p.entryPrice > 0) {
              const rawPnl = p.side === "long"
                ? (currentPrice - p.entryPrice) * p.sizeSui / currentPrice
                : (p.entryPrice - currentPrice) * p.sizeSui / currentPrice;
              posLiveUnrealizedPnl = Math.min(posCollateral * ((agent.leverage || 25) - 1), Math.max(-posCollateral, rawPnl));
            }
            return {
              id: p.id, side: p.side, collateral: posCollateral, sizeSui: p.sizeSui,
              dbUnrealizedPnl: p.unrealizedPnl, liveUnrealizedPnl: posLiveUnrealizedPnl,
              entryPrice: p.entryPrice, currentPrice,
              openedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
            };
          }),
          closed: closedAudit,
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: "Forensic audit failed", detail: e.message });
    }
  });

  app.get("/api/agents/:id/fund-flows", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const flows = await storage.getAgentFundFlows(req.params.id, limit);
      res.json({ flows });
    } catch {
      res.status(500).json({ error: "Failed to fetch fund flows" });
    }
  });

  app.get("/api/agents/:id/comms", async (req, res) => {
    try {
      const { id } = req.params;
      const agent = await storage.getAgent(id);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      const limit = Math.min(parseInt(req.query.limit as string) || 60, 100);
      await hydrateCommsAgent(id);
      const events = getCommsEvents(id, limit);
      res.json({
        events,
        agentId: id,
        fundingWallet: agent.walletAddress,
        savingsWallet: agent.savingsWalletAddress,
        count: events.length,
      });
    } catch (err) {
      console.error("[Comms] Endpoint error:", err);
      res.status(500).json({ error: "Failed to fetch comms" });
    }
  });

  app.get("/api/transfers/in-transit", async (_req, res) => {
    try {
      const jobs = await storage.getAllPendingTransferJobs();
      const inTransit = jobs.filter(j => j.status === "CREATED" || j.status === "SUBMITTED");
      res.json({
        inTransit,
        totalSui: inTransit.reduce((s, j) => s + (j.amountSui || 0), 0),
        count: inTransit.length,
      });
    } catch {
      res.status(500).json({ error: "Failed to fetch in-transit transfers" });
    }
  });

  // ── End Reconciliation Snapshot APIs ────────────────────────────────────────

  app.get("/api/agents/on-chain-portfolio", async (req, res) => {
    try {
      // Accept ownerWallet filter — same deposit-based ownership logic as /api/agents.
      // When provided, only returns data for agents owned by that wallet.
      const ownerWallet = req.query.ownerWallet as string | undefined;
      let allAgents = await storage.getAgents();
      if (ownerWallet && ownerWallet !== "not-connected") {
        const ownerDeposits = await storage.getDepositsByWallet(ownerWallet);
        const ownedAgentIds = new Set(ownerDeposits.map(d => d.agentId));
        const ownerUser = await storage.getUserByWallet(ownerWallet);
        const ownerUserId = ownerUser?.id;
        allAgents = allAgents.filter(a =>
          ownedAgentIds.has(a.id) || a.userId === ownerWallet || (ownerUserId && a.userId === ownerUserId)
        );
      } else if (!ownerWallet || ownerWallet === "not-connected") {
        // No wallet specified or sentinel — return empty agent list to prevent cross-user contamination.
        res.json({ agents: [] });
        return;
      }
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
        claimedRewards: number;
        pendingRewards: number;
        dataVerified: boolean;
        verifiedAt: string | null;
        verificationDiscrepancyPct: number | null;
        savingsBalance: number;
        savingsWalletAddress: string | null;
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
          // Cross-check DB whenever cache has any locked value (not just when positions array is populated).
          // Fixes the case where cached.positions was cleared to [] by a previous cycle but
          // cached.totalLocked still carries the old stale value — the DB check was skipped
          // because `cached.positions.length === 0`, leaving totalLocked positive indefinitely.
          if (cached.positions.length > 0 || cached.totalLocked > 0) {
            const currentDbPositions = await storage.getPositions(agent.id);
            const dbOpenCount = currentDbPositions.filter(p => p.status === "open" || p.status === "pending_open").length;
            if (dbOpenCount === 0) {
              positionData = [];
              totalLocked = 0;
              source = "cache-cleared";
            }
          }
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
                    // Before phantom check: see if an OPEN DB position (without onChainPositionId yet)
                    // content-matches this on-chain position. Two positions with identical entry/size can
                    // be opened simultaneously — don't classify the second one as a phantom of a prior close.
                    const alreadyMatchedInFetch = new Set(fetchedPositions.map(f => f.positionId));
                    const openContentMatch = dbOpenPositions.find(p =>
                      !p.onChainPositionId &&
                      !alreadyMatchedInFetch.has(p.id) &&
                      p.side === pos.side &&
                      Math.abs((p.entryPrice || 0) - (pos.entryPrice || 0)) < 0.001 &&
                      Math.abs(p.sizeSui - (pos.size || 0)) < 1
                    );
                    if (openContentMatch) {
                      // Link the position ID so subsequent fetches match by ID
                      storage.updatePosition(openContentMatch.id, { onChainPositionId: pos.positionId }).catch(() => {});
                      dbOpenPosIds.add(pos.positionId);
                      // Fall through — will be added to fetchedPositions below
                    } else {
                      const contentClosedMatch = allDbPositions.find(p =>
                        p.status === "closed" && p.side === pos.side &&
                        Math.abs((p.entryPrice || 0) - (pos.entryPrice || 0)) < 0.001 &&
                        Math.abs(p.sizeSui - (pos.size || 0)) < 1
                      );
                      if (contentClosedMatch) {
                        const ccAgo = contentClosedMatch.closedAt ? Date.now() - new Date(contentClosedMatch.closedAt).getTime() : Infinity;
                        const ccm = contentClosedMatch as any;
                        const isConfirmedPhantom = (ccm.closeState === "closed" && ccm.closeReason && contentClosedMatch.closedAt && ccAgo > 5 * 60 * 1000) ||
                            (contentClosedMatch.closeTxDigest && contentClosedMatch.closeTxDigest !== "settled_onchain" && contentClosedMatch.closeTxDigest !== "position_gone_onchain" && !contentClosedMatch.closeTxDigest.startsWith("recovered_") && !contentClosedMatch.closeTxDigest.startsWith("sim_") && !contentClosedMatch.closeTxDigest.startsWith("db_"));
                        if (isConfirmedPhantom) {
                          phantomCount++;
                          continue;
                        }
                      }
                      // No confirmed DB match — include as untracked position (will be recovered by verifier)
                    }
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

            onChainPortfolioCache.set(agent.id, { freeSui, savingsBalance: cached?.savingsBalance ?? 0, positions: positionData, totalLocked, timestamp: Date.now(), source: "on-chain" });
          } else if (cached) {
            freeSui = rpcBalanceOk ? fetchedFreeSui : cached.freeSui;
            positionData = rpcPositionsOk ? fetchedPositions : cached.positions;
            totalLocked = rpcPositionsOk ? fetchedLocked : cached.totalLocked;
            source = cached.source + " (extended)";

            if (rpcBalanceOk) {
              onChainPortfolioCache.set(agent.id, { freeSui, savingsBalance: cached.savingsBalance ?? 0, positions: positionData, totalLocked, timestamp: Date.now(), source: cached.source as any });
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

            onChainPortfolioCache.set(agent.id, { freeSui, savingsBalance: onChainPortfolioCache.get(agent.id)?.savingsBalance ?? 0, positions: positionData, totalLocked, timestamp: Date.now(), source: "initial-db" });
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
            // Only close_tx_submitted = actual close TX broadcast = collateral in transit
            // close_order_working = stop/limit order working, position still open on-chain
            if (p.status === "open" && p.closeState === "close_tx_submitted") return true;
            if (p.status === "pending_open") return true;
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

        // Fetch savings wallet balance — use global savings cache first to avoid hammering RPC
        // on every poll and causing inconsistent 0/17 SUI flicker on the verified display.
        // The canonical-snapshot proactive fetch (T002b) maintains this cache at a safe rate.
        let savingsBalance = 0;
        if (agent.savingsWalletAddress) {
          const _savingsCache: Map<string, { balance: number; ts: number }> | undefined =
            (globalThis as any).__agentSavingsCache;
          const cachedEntry = _savingsCache?.get(agent.id);
          const cacheAge = cachedEntry ? Date.now() - cachedEntry.ts : Infinity;
          if (cachedEntry && cachedEntry.balance > 0 && cacheAge < 120_000) {
            // Use cached value (< 2 minutes old) — avoids rate-limit flicker
            savingsBalance = cachedEntry.balance;
          } else {
            // Cache cold or stale — do a fresh fetch and warm the cache
            try {
              const { getOnChainBalance: getSavBal } = await import("./sui-verify");
              const savBal = await getSavBal(agent.savingsWalletAddress);
              savingsBalance = savBal.sui;
              // Cache regardless of whether balance is 0 — prevents stale-positive display
              if (_savingsCache) {
                if (savingsBalance > 0) {
                  _savingsCache.set(agent.id, { balance: savingsBalance, ts: Date.now() });
                }
              }
            } catch { /* use 0 */ }
          }
        }
        // Patch savings into the portfolio cache so canonical snapshot can include it in wallet total
        const _cachedForSavings = onChainPortfolioCache.get(agent.id);
        if (_cachedForSavings) _cachedForSavings.savingsBalance = savingsBalance;

        const rawPortfolioValue = freeSui + totalLocked + pendingOrderCollateral - openSettlingCollateral + savingsBalance;
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

        const agentRewardsForPortfolio = allRewardsForPortfolio.filter(r => r.agentId === agent.id && r.status !== "voided");
        const agentClaimedRewardsAmount = agentRewardsForPortfolio
          .filter(r => r.status === "claimed")
          .reduce((sum, r) => sum + r.amount, 0);
        const agentPendingRewardsAmount = agentRewardsForPortfolio
          .filter(r => r.status === "pending")
          .reduce((sum, r) => sum + r.amount, 0);

        const verification = getAgentVerification(agent.id);
        const dataVerified = isPortfolioVerified(agent.id) &&
          !settlingPositions.some(p => p.closeState === "closing" || p.closeState === "close_pending");

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
          pendingRewards: agentPendingRewardsAmount,
          cached: cacheValid || false,
          source,
          settlingPositions,
          settlingCollateral,
          isStabilized,
          dataVerified,
          verifiedAt: verification?.verifiedAt?.toISOString() ?? null,
          verificationDiscrepancyPct: verification?.discrepancyPct ?? null,
          savingsBalance,
          savingsWalletAddress: agent.savingsWalletAddress ?? null,
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

  app.get("/api/portfolio-verifier/status", (_req, res) => {
    try {
      const status = getVerifierStatus();
      res.json({
        running: status.running,
        startedAt: status.startedAt,
        lastCycleAt: status.lastCycleAt,
        totalCycles: status.totalCycles,
        agents: status.agents.map(a => ({
          agentId: a.agentId,
          agentName: a.agentName,
          verifiedAt: a.verifiedAt,
          portfolioValue: a.portfolioValue,
          freeSui: a.freeSui,
          totalLocked: a.totalLocked,
          positionCount: a.positionCount,
          isConsistent: a.isConsistent,
          discrepancyPct: a.discrepancyPct,
          source: a.source,
          error: a.error,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Verifier unavailable" });
    }
  });

  app.post("/api/portfolio-verifier/verify-now", async (_req, res) => {
    try {
      await runOnDemandVerification();
      res.json({ ok: true, status: getVerifierStatus() });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Verify failed" });
    }
  });

  // Remove a single agent from the verifier's in-memory state (no DB required)
  app.delete("/api/portfolio-verifier/agents/:agentId", (req, res) => {
    const { agentId } = req.params;
    removeAgentFromVerifier(agentId);
    res.json({ ok: true, agentId });
  });

  // ── Performance Tracker ─────────────────────────────────────────────────
  app.get("/api/performance/log", async (req, res) => {
    try {
      const interval = (req.query.interval as SnapshotInterval) || "5m";
      const validIntervals: SnapshotInterval[] = ["5m", "15m", "30m", "1h", "4h", "24h"];
      if (!validIntervals.includes(interval)) {
        return res.status(400).json({ message: "Invalid interval. Use: 5m, 15m, 30m, 1h, 4h, 24h" });
      }
      const rows = await getPerformanceLogs(interval);
      res.json({ interval, count: rows.length, rows });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to fetch performance log" });
    }
  });

  app.get("/api/performance/analysis", async (_req, res) => {
    try {
      const analysis = await getLossAnalysis();
      res.json(analysis);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to fetch loss analysis" });
    }
  });

  app.post("/api/performance/reset", async (_req, res) => {
    try {
      await resetPerformanceLog();
      res.json({ message: "Performance log cleared" });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to reset performance log" });
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
      // Include closing/pending_close so the UI can show positions mid-close (avoids
      // "In Typus: X SUI" with no matching position card visible to the user).
      const ACTIVE_STATUSES_EP = new Set(["open", "pending_open", "closing", "pending_close"]);
      const openPositions = verifiedPositions.filter(p => ACTIVE_STATUSES_EP.has(p.status ?? ""));

      const lastPrice = getLastPrice();
      const liveSuiPrice = lastPrice?.pyth?.price ?? lastPrice?.blended ?? 0;

      let untrackedOnChainPositions: Array<{ positionId: string; side: string; size: number; collateral: number; entryPrice: number }> = [];
      if (agent.walletAddress) {
        const cached = getCachedOnChainPositions(agent.id);
        const openDbPositionIds = new Set(openPositions.map(p => p.onChainPositionId).filter(Boolean));
        const allDbPositions = await storage.getPositions(req.params.id);

        if (cached) {
          for (const ocp of cached.positions) {
            if (!ocp.positionId || openDbPositionIds.has(ocp.positionId)) continue;
            // Content-match: position may lack an on-chain ID in DB but match by side/entry/size
            const contentMatch = openPositions.find(p =>
              p.entryPrice > 0 && ocp.entryPrice && ocp.entryPrice > 0 &&
              p.side === ocp.side &&
              Math.abs(p.entryPrice - ocp.entryPrice) < 0.001 &&
              Math.abs(p.sizeSui - (ocp.size || 0)) < 1
            );
            if (contentMatch) continue;
            // Skip positions already confirmed closed in the DB (by ID or by content)
            const closedMatch = allDbPositions.find(p =>
              p.status === "closed" && (
                p.onChainPositionId === ocp.positionId ||
                (ocp.entryPrice && p.entryPrice && p.side === ocp.side &&
                  Math.abs(p.entryPrice - ocp.entryPrice) < 0.001 &&
                  Math.abs(p.sizeSui - (ocp.size || 0)) < 1)
              )
            );
            if (closedMatch) {
              // If the DB close was synthetic (no real TX), the fresh on-chain cache overrides it —
              // the position IS still on-chain. Show as untracked so users can always see it.
              const d = closedMatch.closeTxDigest || "";
              const isSyntheticDbClose =
                !d ||
                d === "settled_onchain" ||
                d === "position_gone_onchain" ||
                d === "closed_externally" ||
                d === "closed_external" ||
                d === "liquidated_onchain" ||
                d === "cancelled_unfilled" ||
                d.startsWith("recovered_") ||
                d.startsWith("sim_") ||
                d.startsWith("db_");
              if (isSyntheticDbClose) {
                untrackedOnChainPositions.push(ocp);
              }
              continue;
            }
            // Position is on-chain but not tracked as open (or completely absent from DB) — report as untracked
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

                // Skip positions already confirmed closed in the DB
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
      const agentDepositHistory = await storage.getDepositsByAgent(req.params.id).catch(() => []);
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
      // Closed positions for win rate and PnL stats:
      // - Exclude deleted_bogus_recovery (cleanup artifacts, not real trades)
      // - Exclude cancelled_unfilled (order never filled, collateral returned — not a trade)
      // - Exclude sim_ open digests (simulation entries that were never on-chain)
      // - Exclude sim_ close digests (synthetic simulation closes)
      // Recovered positions (recovered_*, reopened_*) ARE included — they represent real trades
      const closedPositions = agentPositions.filter(p =>
        p.status === "closed" &&
        p.closeReason !== "deleted_bogus_recovery" &&
        p.closeTxDigest !== "cancelled_unfilled" &&
        !(p.txDigest?.startsWith("sim_")) &&
        !(p.closeTxDigest?.startsWith("sim_"))
      );
      const totalClosed = closedPositions.length;
      const totalWins = closedPositions.filter(p => (p.unrealizedPnl || 0) > 0).length;
      const liveWinRate = totalClosed > 0 ? totalWins / totalClosed : 0;

      // Daily trade count — positions closed since midnight UTC today
      const todayStartMs = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").getTime();
      const tradesToday = closedPositions.filter(p => {
        const closedTs = p.closedAt ? new Date(p.closedAt as unknown as string).getTime() : 0;
        return closedTs >= todayStartMs;
      }).length;

      // Daily trade target — based on agent mode and market regime
      const signalMode = agent.signalMode || "AUTO";
      const baseTargets: Record<string, number> = { NOW: 15, AGGRESSIVE: 10, AUTO: 6, PRECISION: 3 };
      const baseTarget = baseTargets[signalMode] ?? 6;
      const lastSignalResult = getLastSignalResult();
      const currentRegime: string = (lastSignalResult?.signal as any)?.regime ?? "NEUTRAL";
      const regimeBonus = currentRegime === "TREND" ? 2 : currentRegime === "VOLATILE" ? -1 : 0;
      const winRateAdj = liveWinRate >= 0.40 ? 2 : liveWinRate < 0.20 && totalClosed >= 5 ? -1 : 0;
      const dailyTarget = Math.max(1, baseTarget + regimeBonus + winRateAdj);

      // Keeper-verified: actual on-chain balance changes (most accurate)
      const keeperOnChainSettlement = closedPositions
        .filter(p => (p.pnlSource === "keeper_verified" || p.pnlSource === "onchain_verified") && (p.returnedSui ?? 0) > 0)
        .reduce((sum, p) => sum + (p.returnedSui || 0), 0);

      const SYNTHETIC_DIGESTS = new Set(["settled_onchain", "position_gone_onchain", "closed_externally", "closed_external", "liquidated_onchain", "cancelled_unfilled"]);
      const isSyntheticClose = (p: any) => {
        const d = p.closeTxDigest || "";
        return SYNTHETIC_DIGESTS.has(d) || d.startsWith("recovered_") || d.startsWith("sim_") || d.startsWith("db_");
      };

      // Real chain-verified settlement (returnedSui from actual TX or keeper verification)
      // For synthetic/force-settled positions, use returnedSui if set, else 0 (collateral forfeited)
      const settlementReceived = closedPositions
        .filter(p => p.closeTxDigest !== "cancelled_unfilled")
        .reduce((sum, p) => {
          if ((p.returnedSui ?? 0) > 0) return sum + p.returnedSui!;
          if (isSyntheticClose(p)) {
            // Force-settled by keeper — collateral was forfeited, assume 0 returned unless recorded
            return sum + 0;
          }
          // Real TX but no returnedSui set yet — estimate from collateral + DB pnl
          const coll = p.collateral || (p.sizeSui / (agent.leverage || 36));
          const pnl = p.unrealizedPnl || 0;
          return sum + Math.max(0, coll + pnl);
        }, 0);

      // Force-settled collateral loss (positions closed by keeper/liquidation without returnedSui).
      // Only count positions with explicit collateral recorded in the DB. Using sizeSui/leverage
      // as a fallback inflates the figure by counting cascade closed positions that have collateral=null
      // (we don't know what was actually deployed for those — the gap shows as "Untraced Losses").
      const forceSettledCollateral = closedPositions
        .filter(p => isSyntheticClose(p) && p.closeTxDigest !== "cancelled_unfilled" && (p.collateral ?? 0) > 0)
        .reduce((sum, p) => sum + (p.collateral || 0), 0);
      const forceSettledReturned = closedPositions
        .filter(p => isSyntheticClose(p) && p.closeTxDigest !== "cancelled_unfilled" && (p.returnedSui ?? 0) > 0)
        .reduce((sum, p) => sum + (p.returnedSui || 0), 0);
      const forceSettledLoss = forceSettledCollateral - forceSettledReturned;
      const collateralDeployed = agentPositions
        .filter(p => p.closeTxDigest !== "cancelled_unfilled" && !p.closeTxDigest?.startsWith("cascade_loss_") && (p.collateral ?? 0) > 0)
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
            // Track which DB positions have already been content-matched to an on-chain ID,
            // so duplicate-entry positions (same price/size opened simultaneously) each get
            // their own unique DB ↔ on-chain mapping instead of both mapping to the first DB record.
            const contentMatchedDbIds = new Set<string>();

            for (const ocp of onChainPositions) {
              if (!ocp.positionId) continue;
              if (openDbPositionIds.has(ocp.positionId)) continue;

              if (ocp.entryPrice && ocp.entryPrice > 0) {
                const contentMatch = openPositions.find(p =>
                  !contentMatchedDbIds.has(p.id) &&
                  p.entryPrice > 0 &&
                  p.side === ocp.side &&
                  Math.abs(p.entryPrice - ocp.entryPrice) < 0.001 &&
                  Math.abs(p.sizeSui - (ocp.size || 0)) < 1
                );
                if (contentMatch) {
                  contentMatchedDbIds.add(contentMatch.id);
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
                    // During the cooldown window, show as untracked so users can see the
                    // position exists on-chain — the recovery system will reopen it after cooldown.
                    if (isSettledSynthetic) {
                      untrackedOnChainPositions.push({
                        positionId: ocp.positionId,
                        side: ocp.side,
                        size: ocp.size,
                        collateral: posCollateral,
                        entryPrice: ocp.entryPrice || 0,
                      });
                    }
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
                // Genuinely untracked on-chain position — no DB record at all.
                // Fall through to auto-create / untracked handling below so this
                // position appears in the agent card and is recovered into the DB.
                phantomCount++;
              }

              if (ocp.entryPrice && ocp.entryPrice > 0) {
                // Guard against stale openPositions: re-check allPositions (fetched fresh above)
                // for any ACTIVE record that covers this on-chain position. openDbPositionIds was
                // built at the START of this long-running request and may be up to 30s stale.
                const alreadyActiveInDb = allPositions.some(p =>
                  (p.status === "open" || p.status === "pending_open" || p.status === "closing" || p.status === "pending_close") &&
                  (p.onChainPositionId === ocp.positionId ||
                    // Also content-match: covers the case where onChainPositionId wasn't set yet
                    (p.entryPrice > 0 && ocp.entryPrice > 0 && p.side === ocp.side &&
                      Math.abs(p.entryPrice - ocp.entryPrice) < 0.001 &&
                      Math.abs(p.sizeSui - (ocp.size || 0)) < 1))
                );
                if (alreadyActiveInDb) {
                  console.log(`[Activity] SKIP auto-create for ${agent.name} posId=${ocp.positionId}: already tracked as active in DB (openDbPositionIds was stale)`);
                  lockedCollateral += posCollateral;
                  if (liveSuiPrice > 0 && ocp.entryPrice > 0) {
                    const rawPnl = ocp.side === "long"
                      ? (liveSuiPrice - ocp.entryPrice) * ocp.size / liveSuiPrice
                      : (ocp.entryPrice - liveSuiPrice) * ocp.size / liveSuiPrice;
                    totalUnrealizedPnl += Math.max(-posCollateral, rawPnl);
                  }
                  continue;
                }

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
              console.log(`[Activity] Agent ${agent.name}: auto-recovering ${phantomCount} untracked on-chain position(s) with no DB match (DB has ${openPositions.length} open, on-chain scan found ${onChainPositions.length})`);
            }

            const untrackedPosIds = new Set(untrackedOnChainPositions.map(u => u.positionId).filter(Boolean));
            const verifiedOnChainForCache: CachedOnChainPosition[] = onChainPositions
              .filter(ocp => ocp.positionId && (openDbPositionIds.has(ocp.positionId) || allDbPosIds.has(ocp.positionId) || untrackedPosIds.has(ocp.positionId)))
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

      // Include savings wallet balance in portfolio (savings wallet is part of agent's capital, NOT reward escrow)
      let savingsBalanceActivity = 0;
      if (agent.savingsWalletAddress) {
        try {
          const savBal = await getOnChainBalance(agent.savingsWalletAddress);
          savingsBalanceActivity = savBal.sui;
        } catch { /* use 0 */ }
      }

      const portfolioValue = onChainWalletSui + lockedCollateral + pendingOrderCollateral + savingsBalanceActivity;

      let realizedGain = 0;
      let realizedLoss = 0;
      // Accumulate PnL from cascade_loss synthetic records separately — these represent
      // losses from untracked cascade liquidations and must be preserved even when
      // chain-derived data overrides the standard realizedGain/realizedLoss below.
      let syntheticCascadePnl = 0;
      for (const pos of closedPositions) {
        if (pos.closeTxDigest === "cancelled_unfilled") continue;
        const pnl = pos.unrealizedPnl || 0;
        if (pos.closeTxDigest?.startsWith("cascade_loss_")) {
          syntheticCascadePnl += pnl; // always track separately
        } else {
          if (pnl > 0) realizedGain += pnl;
          else realizedLoss += pnl;
        }
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
      // reinvestedAmount = estimated SUI saved to savings wallet (savingsSplitPct% of each winning trade)
      const savingsSplitPctForCalc = agent.savingsSplitPct ?? 10;
      const reinvestedAmount = Math.min(
        closedPositions
          .filter(p => (p.unrealizedPnl || 0) > 0 && p.closeTxDigest !== "cancelled_unfilled")
          .reduce((sum, p) => sum + (p.unrealizedPnl || 0) * (savingsSplitPctForCalc / 100), 0),
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

      // Always incorporate synthetic cascade losses into accounting — these are NOT visible in
      // chain-derived data since they represent untracked liquidations with no DB records at the time.
      // Add them back after the chain-derived override so they always appear in the accounting.
      if (syntheticCascadePnl < 0) {
        realizedLoss += syntheticCascadePnl;
        totalRealizedPnl += syntheticCascadePnl;
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

      // === Cascade Loss Auto-Reconciliation ===
      // If the accounting shows a large untraced gap (actual on-chain < expected from tracked trades),
      // create a synthetic "cascade_loss" position record to formally attribute the missing funds.
      // SAFETY: Never create cascade records when the portfolio verifier reports untracked on-chain
      // positions — those positions represent real locked collateral, not lost funds.
      // SELF-HEALING: If a cascade record exists but the residual is now ≥ 0 (recovered), delete it.
      const CASCADE_RECONCILE_THRESHOLD = 10.0;
      const existingCascadeRecords = verifiedPositions.filter((p: any) =>
        p.txDigest?.startsWith("cascade_loss_") || p.closeTxDigest?.startsWith("cascade_loss_")
      );
      const existingCascadeRecord = existingCascadeRecords[0];
      // Check if portfolio verifier has untracked on-chain positions for this agent.
      // If so, the "gap" is just untracked collateral — NOT lost capital. Skip reconciliation.
      const verifierStateForCascade = getAgentVerification(agent.id);
      const hasUntrackedOnChainPositions = (verifierStateForCascade?.missingPositions?.length ?? 0) > 0;

      if (chainDerivedFresh && chainDerived && !hasUntrackedOnChainPositions) {
        const verifiedPortfolioForReconcile = onChainWalletSui + lockedCollateral;
        const accountedForReconcile = netDeposited + totalRealizedPnl - estimatedGas - totalEscrowedRewards;
        const cascadeResidual = verifiedPortfolioForReconcile - accountedForReconcile;

        if (existingCascadeRecord && cascadeResidual > -1.0) {
          // Cascade record exists but residual is now near-zero or positive — the losses were
          // incorrectly attributed (e.g., positions were recovered). Delete all cascade records.
          for (const cr of existingCascadeRecords) {
            try {
              await storage.deletePosition(cr.id);
              console.log(`[ActivitySync] CASCADE SELF-HEAL for ${agent.name}: deleted incorrect cascade record ${cr.id} (residual now ${cascadeResidual.toFixed(4)} SUI, losses were not permanent)`);
            } catch (delErr: any) {
              console.log(`[ActivitySync] Failed to delete cascade record ${cr.id}: ${delErr.message}`);
            }
          }
        } else if (!existingCascadeRecord && cascadeResidual < -CASCADE_RECONCILE_THRESHOLD) {
          // No existing cascade record and large negative residual — create one.
          const cascadeLossAmount = Math.abs(cascadeResidual);
          try {
            const now = Date.now();
            const cascadePos = await storage.createPosition({
              agentId: agent.id,
              symbol: "SUI-USDC",
              side: "long",
              sizeSui: 0,
              collateral: cascadeLossAmount,
              entryPrice: 0,
              markPrice: 0,
              unrealizedPnl: -cascadeLossAmount,
              liquidationPrice: 0,
              txDigest: `cascade_loss_${now}`,
            });
            await storage.updatePosition(cascadePos.id, {
              status: "closed",
              closeReason: "cascade_liquidation_reconciled",
              closeTxDigest: `cascade_loss_${now}`,
              closedAt: new Date(),
              returnedSui: 0,
              pnlSource: "reconciled",
            } as any);
            console.log(`[ActivitySync] CASCADE RECONCILIATION for ${agent.name}: ${cascadeLossAmount.toFixed(4)} SUI untraced losses formally attributed as cascade liquidation losses (residual was ${cascadeResidual.toFixed(4)} SUI). Accounting now balanced.`);
          } catch (cascadeErr: any) {
            console.log(`[ActivitySync] Cascade reconciliation failed for ${agent.name}: ${cascadeErr.message}`);
          }
        }
      } else if (existingCascadeRecord && hasUntrackedOnChainPositions) {
        // Cascade record exists but portfolio verifier found untracked on-chain positions.
        // The "losses" are actually still locked as collateral — delete the cascade record.
        for (const cr of existingCascadeRecords) {
          try {
            await storage.deletePosition(cr.id);
            console.log(`[ActivitySync] CASCADE INVALIDATED for ${agent.name}: deleted cascade record ${cr.id} — verifier found ${verifierStateForCascade?.missingPositions?.length} untracked on-chain positions (collateral not lost)`);
          } catch (delErr: any) {
            console.log(`[ActivitySync] Failed to delete cascade record ${cr.id}: ${delErr.message}`);
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
          (ct as any).dbPositionMatch = matchPos ? "tracked" : "untracked";
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
        reasoning: (() => {
          if (!reasoning) return null;
          const triton = getLastTritonSignal();
          let readiness = null;
          if (triton) {
            try {
              const mode = triton.activeMode || "AUTO";
              const profile = MODE_PROFILES[mode];
              const threshold = profile.threshold;
              const minRr = 1.3;
              const scoreReadinessPct = Math.min(100, Math.round((triton.score / threshold) * 100));
              const rrReadinessPct = triton.rr > 0 ? Math.min(100, Math.round((triton.rr / minRr) * 100)) : 0;
              const blockingChecks: string[] = [];
              if (triton.side === "NONE") blockingChecks.push("No directional signal — waiting for MACD + price + HTF to align");
              if (triton.score < threshold) blockingChecks.push(`Score ${triton.score} < ${threshold} threshold for ${mode} mode`);
              if (triton.rr > 0 && triton.rr < minRr) blockingChecks.push(`Risk/Reward ${triton.rr.toFixed(2)} < ${minRr}× minimum`);
              if ((triton.side === "LONG" && triton.htfBias === "BEAR") || (triton.side === "SHORT" && triton.htfBias === "BULL")) {
                blockingChecks.push(`Counter-trend blocked: ${triton.side} vs HTF ${triton.htfBias}`);
              }
              readiness = { scoreReadinessPct, threshold, score: triton.score, rrReadinessPct, minRr, currentRr: triton.rr, regime: triton.regime, blockingChecks };
            } catch {}
          }
          return {
            signal: reasoning.signal,
            side: reasoning.side,
            reason: reasoning.reason,
            longScore: reasoning.longScore,
            shortScore: reasoning.shortScore,
            conditions: reasoning.conditions,
            indicators: reasoning.indicators,
            readiness,
            triton: triton ? { side: triton.side, regime: triton.regime, activeMode: triton.activeMode, htfBias: triton.htfBias, score: triton.score, scoreBreakdown: triton.scoreBreakdown, threshold: triton.threshold, rr: triton.rr, sizeMultiplier: triton.sizeMultiplier, reasons: triton.reasons } : null,
          };
        })(),
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
        tradesToday,
        dailyTarget,
        dbTradeCount,
        netDeposited,
        serverTotalPnl,
        retainedProfits: Math.min(agent.retainedProfits || 0, Math.max(0, onChainWalletSui)),
        profitRetentionPct: agent.profitRetentionPct ?? 10,
        savingsSplitPct: agent.savingsSplitPct ?? 10,
        savingsBalance: savingsBalanceActivity,
        savingsWalletAddress: agent.savingsWalletAddress ?? null,
        settlementReceived,
        keeperOnChainSettlement,
        collateralDeployed,
        forceSettledLoss,
        forceSettledCollateral,
        agentBlocks: {
          ...getAgentBlockStatus(req.params.id),
          skipStatus: getAgentSkipStatus(req.params.id),
        },
        depositHistory: agentDepositHistory.map(d => ({
          id: d.id,
          amount: d.amount,
          grossAmount: d.grossAmount,
          protocolFee: d.protocolFee,
          txDigest: d.txDigest,
          createdAt: d.createdAt,
          verified: d.verified,
        })),
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

      const MAX_ALLOWED_LEVERAGE = 50;
      if (parsed.leverage > MAX_ALLOWED_LEVERAGE) {
        return res.status(400).json({ message: `Leverage cannot exceed ${MAX_ALLOWED_LEVERAGE}x (Typus protocol limit)` });
      }

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

      // Auto-reset performance log when creating a fresh set of agents
      try {
        const existingAgents = await storage.getAgents();
        if (existingAgents.length === 0) {
          await resetPerformanceLog();
        }
      } catch {}

      const agentWithSignal = await storage.createAgent({
        ...parsed,
        autoTrade: true,
      }, wallet);
      // Generate savings wallet immediately after creation
      try {
        const savingsWalletData = generateAgentWallet();
        await storage.updateAgent(agentWithSignal.id, {
          savingsWallet: savingsWalletData.encryptedPrivateKey,
          savingsWalletAddress: savingsWalletData.address,
          savingsSplitPct: 10,
        });
        (agentWithSignal as any).savingsWalletAddress = savingsWalletData.address;
        console.log(`[Savings] Created savings wallet for new agent ${agentWithSignal.name}: ${savingsWalletData.address}`);
      } catch (swErr: any) {
        console.error(`[Savings] Failed to create savings wallet for ${agentWithSignal.name}: ${swErr.message}`);
      }
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

      if (updates.leverage !== undefined && Number(updates.leverage) > 50) {
        return res.status(400).json({ message: "Leverage cannot exceed 50x (Typus protocol limit)" });
      }

      if (updates.signalMode !== undefined) {
        const validModes = ["NOW", "AUTO", "AGGRESSIVE", "PRECISION"];
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

      if (updates.savingsSplitPct !== undefined) {
        const pct = Number(updates.savingsSplitPct);
        if (isNaN(pct) || pct < 0 || pct > 50) {
          return res.status(400).json({ message: "Savings split must be between 0% and 50%" });
        }
        updates.savingsSplitPct = pct;
        console.log(`[Settings] ${existingAgent.name}: Savings split ${existingAgent.savingsSplitPct ?? 10}% → ${pct}% by ${walletAddress}`);
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

      // Force-close any remaining non-closed positions (pending_close, close_requested, etc.)
      // that were not captured by getOpenPositions (which only returns open/pending_open)
      try {
        const allPositions = await storage.getPositions(id);
        const nonClosedStatuses = ["pending_close", "close_requested", "closing", "pending_settlement"];
        const stuckPositions = allPositions.filter(p => nonClosedStatuses.includes(p.status || ""));
        for (const pos of stuckPositions) {
          await storage.updatePosition(pos.id, { status: "closed", closeReason: "force_deleted_stuck" } as any);
          console.log(`[Delete] Force-closed stuck position ${pos.id} (status=${pos.status}) for deleted agent ${agent.name}`);
        }
      } catch (stuckErr: any) {
        console.warn(`[Delete] Could not clean stuck positions for ${agent.name}: ${stuckErr.message}`);
      }

      const deleted = await storage.deleteAgent(id);
      if (!deleted) {
        return res.status(404).json({ message: "Agent not found" });
      }
      removeAgentFromVerifier(id);
      removeFromSnapshotCache(id);
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
      const expectedAgentMist = suiToMist(netAmount);
      const expectedFeeMist = suiToMist(protocolFee);

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
      const { amount, savingsAmount, toAddress, authTxDigest, source } = req.body;
      // source: "funding" (default) | "savings" | "both"
      const withdrawSource: "funding" | "savings" | "both" = source || "funding";

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

      const { decryptKeypair } = await import("./dex/wallet-manager");
      const { Transaction } = await import("@mysten/sui/transactions");
      const { withWalletLock } = await import("./dex/tx-queue");
      const { suiClient: sc } = await import("./sui-verify");
      const gasBudget = BigInt(10_000_000);

      async function executeWithdrawalTx(walletEncrypted: string, walletAddr: string, withdrawSui: number): Promise<{ digest: string }> {
        const keypair = decryptKeypair(walletEncrypted);
        const withdrawMist = suiToMist(withdrawSui);
        const maxRetries = 3;
        let result: any = null;
        let lastError = "";
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            result = await withWalletLock(walletAddr, async () => {
              if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
              const tx = new Transaction();
              tx.setSender(walletAddr);
              tx.setGasBudget(gasBudget);
              const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(withdrawMist)]);
              tx.transferObjects([coin], toAddress);
              return sc.signAndExecuteTransaction({ transaction: tx, signer: keypair, options: { showEffects: true } });
            });
            if (result.effects?.status?.status === "success") break;
            lastError = "Transaction status: " + (result.effects?.status?.status || "unknown");
          } catch (err: any) {
            lastError = err.message || String(err);
            console.log(`[Withdraw] ${walletAddr.slice(0, 10)}... attempt ${attempt + 1}/${maxRetries} failed: ${lastError.slice(0, 200)}`);
            if (attempt < maxRetries - 1) continue;
          }
        }
        if (!result || result.effects?.status?.status !== "success") {
          throw new Error(`Withdrawal from ${walletAddr.slice(0, 10)}... failed after ${maxRetries} attempts: ${lastError.slice(0, 300)}`);
        }
        return { digest: result.digest };
      }

      const results: { source: string; txDigest: string; amount: number }[] = [];

      // --- Funding wallet withdrawal ---
      if (withdrawSource === "funding" || withdrawSource === "both") {
        const parsedAmount = amount !== undefined && amount !== null ? Number(amount) : null;
        if (parsedAmount !== null && (isNaN(parsedAmount) || parsedAmount <= 0)) {
          return res.status(400).json({ message: "Funding amount must be a positive number" });
        }
        const onChainBalance = await getOnChainBalance(agent.walletAddress);
        const maxOnChainWithdraw = Math.max(0, (Number(onChainBalance.mist) - Number(gasBudget)) / 1e9);
        let withdrawAmount: number;
        if (parsedAmount && parsedAmount > 0) {
          withdrawAmount = parsedAmount;
        } else if (maxOnChainWithdraw > 0.001) {
          withdrawAmount = maxOnChainWithdraw;
        } else if (withdrawSource === "funding") {
          return res.status(400).json({ message: "No balance available to withdraw from funding wallet" });
        } else {
          withdrawAmount = 0;
        }
        if (withdrawAmount > 0) {
          if (withdrawAmount > maxOnChainWithdraw) {
            return res.status(400).json({
              message: `Insufficient on-chain balance. Funding wallet has ${onChainBalance.sui.toFixed(4)} SUI (${maxOnChainWithdraw.toFixed(4)} withdrawable after gas).`,
            });
          }
          const r = await executeWithdrawalTx(agent.agentWallet, agent.walletAddress, withdrawAmount);
          results.push({ source: "funding", txDigest: r.digest, amount: withdrawAmount });
          await storage.updateAgent(id, { balance: Math.max(0, agent.balance - withdrawAmount) });
          await storage.createVerifiedTransaction({
            txDigest: r.digest, txType: "withdraw", agentId: id, userId: agent.userId,
            sender: agent.walletAddress, checkpoint: null,
            rawData: { amount: withdrawAmount, toAddress, authTxDigest, source: "funding" },
          }).catch(() => {});
        }
      }

      // --- Savings wallet withdrawal ---
      if (withdrawSource === "savings" || withdrawSource === "both") {
        if (!agent.savingsWallet || !agent.savingsWalletAddress) {
          if (withdrawSource === "savings") {
            return res.status(400).json({ message: "No savings wallet configured for this agent." });
          }
        } else {
          const parsedSavings = savingsAmount !== undefined && savingsAmount !== null ? Number(savingsAmount) : null;
          if (parsedSavings !== null && (isNaN(parsedSavings) || parsedSavings <= 0)) {
            return res.status(400).json({ message: "Savings amount must be a positive number" });
          }
          const savOnChain = await getOnChainBalance(agent.savingsWalletAddress);
          const maxSavWithdraw = Math.max(0, (Number(savOnChain.mist) - Number(gasBudget)) / 1e9);
          let savWithdrawAmount: number;
          if (parsedSavings && parsedSavings > 0) {
            savWithdrawAmount = parsedSavings;
          } else if (maxSavWithdraw > 0.001) {
            savWithdrawAmount = maxSavWithdraw;
          } else if (withdrawSource === "savings") {
            return res.status(400).json({ message: "No balance available to withdraw from savings wallet" });
          } else {
            savWithdrawAmount = 0;
          }
          if (savWithdrawAmount > 0) {
            if (savWithdrawAmount > maxSavWithdraw) {
              return res.status(400).json({
                message: `Insufficient savings balance. Savings wallet has ${savOnChain.sui.toFixed(4)} SUI (${maxSavWithdraw.toFixed(4)} withdrawable after gas).`,
              });
            }
            const r = await executeWithdrawalTx(agent.savingsWallet, agent.savingsWalletAddress, savWithdrawAmount);
            results.push({ source: "savings", txDigest: r.digest, amount: savWithdrawAmount });
            await storage.createVerifiedTransaction({
              txDigest: r.digest, txType: "withdraw", agentId: id, userId: agent.userId,
              sender: agent.savingsWalletAddress, checkpoint: null,
              rawData: { amount: savWithdrawAmount, toAddress, authTxDigest, source: "savings" },
            }).catch(() => {});
          }
        }
      }

      if (results.length === 0) {
        return res.status(400).json({ message: "No funds available to withdraw" });
      }

      onChainPortfolioCache.delete(id);
      broadcast("agent:updated", sanitizeAgent(await storage.getAgent(id)));

      const totalAmount = results.reduce((s, r) => s + r.amount, 0);
      res.json({
        results,
        amount: results.find(r => r.source === "funding")?.amount ?? 0,
        savingsAmount: results.find(r => r.source === "savings")?.amount ?? 0,
        totalAmount,
        txDigest: results[0]?.txDigest,
        toAddress,
        remainingBalance: Math.max(0, agent.balance - (results.find(r => r.source === "funding")?.amount ?? 0)),
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
      let savingsOnChainSui = 0;
      if (agent.savingsWalletAddress) {
        try {
          const savOnChain = await getOnChainBalance(agent.savingsWalletAddress);
          savingsOnChainSui = savOnChain.sui;
        } catch {}
      }
      res.json({
        walletAddress: agent.walletAddress,
        onChainSui: onChain.sui,
        onChainMist: onChain.mist,
        dbBalance: agent.balance,
        mismatch: Math.abs(onChain.sui - agent.balance) > 0.001,
        savingsWalletAddress: agent.savingsWalletAddress ?? null,
        savingsOnChainSui,
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

  app.post("/api/agents/:id/reset-streak", async (req, res) => {
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
        return res.status(403).json({ message: "Only the agent owner can reset the streak." });
      }

      clearStreakCooldown(agent.id);
      console.log(`[API] Streak cooldown cleared for ${agent.name} (${agent.id}) by ${walletAddress.slice(0, 10)}`);
      res.json({ message: `Streak cooldown cleared for ${agent.name}. Agent will resume trading at next signal.` });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to reset streak" });
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

  // Emergency: force-close a specific on-chain position by ID.
  // Creates a minimal DB record and immediately submits the close TX.
  // Use when the normal recovery loop can't track the position (RPC rate limits, side mismatch, etc.)
  app.post("/api/agents/:id/force-close-on-chain-position", async (req, res) => {
    try {
      const { id } = req.params;
      const { onChainPositionId, side, entryPrice, collateral } = req.body as {
        onChainPositionId: string;
        side: "long" | "short";
        entryPrice?: number;
        collateral?: number;
      };

      if (!onChainPositionId || !side) {
        return res.status(400).json({ message: "onChainPositionId and side are required" });
      }

      const agent = await storage.getAgent(id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });

      const lastPrice = getLastPrice();
      const currentPrice = lastPrice?.blended || 0;
      if (currentPrice <= 0) {
        return res.status(400).json({ message: "Cannot determine current market price" });
      }

      // Check if a DB record already exists for this on-chain position ID
      const allPositions = await storage.getPositions(id);
      let existingPos = allPositions.find((p: any) => p.onChainPositionId === onChainPositionId);

      if (existingPos && (existingPos.status === "open" || existingPos.status === "pending_open")) {
        // Already open — ensure side is correct and trigger close
        if (existingPos.side !== side) {
          const leverageVal = agent.leverage || 25;
          const correctLiq = side === "long"
            ? (entryPrice || existingPos.entryPrice) * (1 - 1 / leverageVal)
            : (entryPrice || existingPos.entryPrice) * (1 + 1 / leverageVal);
          await storage.updatePosition(existingPos.id, {
            side,
            liquidationPrice: correctLiq,
            closeAttempts: 0,
            lastCloseTx: null,
            closePendingSince: null,
          });
          existingPos = { ...existingPos, side };
        }
      } else {
        // Create a minimal open DB record so closePositionForAgent can work
        const leverageVal = agent.leverage || 25;
        const coll = collateral || 10;
        const ep = entryPrice || currentPrice;
        const liq = side === "long"
          ? ep * (1 - 1 / leverageVal)
          : ep * (1 + 1 / leverageVal);
        const newPos = await storage.createPosition({
          agentId: id,
          status: "open",
          side,
          entryPrice: ep,
          sizeSui: coll * leverageVal,
          collateral: coll,
          liquidationPrice: liq,
          unrealizedPnl: 0,
          onChainPositionId,
          txDigest: `force_close_${onChainPositionId}`,
          stopLossBps: agent.stopLossBps || 50,
          takeProfitBps: agent.takeProfitBps || 100,
        });
        existingPos = newPos;
        console.log(`[ForceClose] Created DB record ${newPos.id} for on-chain pos ${onChainPositionId} (${side})`);
      }

      console.log(`[ForceClose] Submitting close for ${agent.name} on-chain pos ${onChainPositionId} (side=${side})`);
      const result = await closePositionForAgent(agent, existingPos.id, currentPrice, false, "force_close_admin");

      onChainPortfolioCache.delete(id);
      broadcast("positions:updated", { agentId: id });

      res.json({
        success: result.closed || result.onChain,
        onChainPositionId,
        side,
        txDigest: result.txDigest,
        pnl: result.pnl,
        error: result.error,
        message: result.closed ? "Position closed successfully" : (result.error || "Close submitted"),
      });
    } catch (e: any) {
      console.error(`[ForceClose] Error:`, e);
      res.status(500).json({ message: e.message || "Force-close failed" });
    }
  });

  // On-demand position scan — discovers untracked on-chain positions immediately
  app.post("/api/agents/:id/scan-positions", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await scanPositionsForAgent(id);
      res.json({
        success: true,
        recovered: result.recovered,
        onChainCount: result.onChainCount,
        positions: result.positions,
        message: result.recovered > 0
          ? `Recovered ${result.recovered} position(s) from on-chain`
          : result.onChainCount === 0
            ? "No open positions found on-chain"
            : `${result.onChainCount} position(s) already tracked`,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Scan failed" });
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

        if (closedCount > 0) {
          console.log(`[RemoveCollateral] ${agent.name}: ${closedCount} close orders submitted. Waiting for keeper fills (up to 25s)...`);
          const pollStart = Date.now();
          const maxWaitMs = 25_000;
          const pollIntervalMs = 2_500;
          while (Date.now() - pollStart < maxWaitMs) {
            await new Promise(r => setTimeout(r, pollIntervalMs));
            const stillOpen = (await storage.getPositions(id)).filter(p => p.status === "open" || p.status === "pending_open");
            if (stillOpen.length === 0) {
              console.log(`[RemoveCollateral] ${agent.name}: All positions confirmed closed after ${Math.round((Date.now() - pollStart) / 1000)}s.`);
              break;
            }
          }
        }
      }

      if (agent.status === "running") {
        await storage.updateAgent(id, { status: "idle" });
      }

      const updatedAgent = await storage.getAgent(id);
      if (!updatedAgent) {
        return res.status(500).json({ message: "Failed to retrieve updated agent" });
      }

      onChainPortfolioCache.delete(id);
      await new Promise(r => setTimeout(r, 1500));

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
            const withdrawMist = suiToMist(transferAmount);
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

  app.get("/api/agents/:id/precision-adjustments", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      const { getPrecisionAdjustmentLogs } = await import("./learning-engine");
      const logs = await getPrecisionAdjustmentLogs(agent.id);
      res.json({
        enabled: agent.precisionAdjustmentsEnabled ?? true,
        logs,
        currentConfig: {
          stopLossBps: agent.stopLossBps,
          takeProfitBps: agent.takeProfitBps,
          minCollateral: agent.minCollateral,
          maxCollateral: agent.maxCollateral,
          leverage: agent.leverage,
        },
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to get precision adjustments" });
    }
  });

  app.patch("/api/agents/:id/precision-adjustments", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") return res.status(400).json({ message: "enabled must be a boolean" });
      await storage.updateAgent(agent.id, { precisionAdjustmentsEnabled: enabled });
      res.json({ success: true, enabled });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to update precision adjustments" });
    }
  });

  app.post("/api/agents/:id/precision-adjustments/run", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      const { applyPrecisionAdjustments } = await import("./learning-engine");
      const result = await applyPrecisionAdjustments(agent.id);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to run precision adjustments" });
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
      if (!wallet) {
        return res.status(400).json({ message: "wallet query parameter is required" });
      }
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

  app.get("/api/rewards/summary", async (req, res) => {
    try {
      const allRewards = await storage.getRewards();
      const activeRewards = allRewards.filter((r) => r.status !== "voided");
      const allAgentsRaw = await storage.getAgents();

      // Filter agents by ownerWallet if provided
      const ownerWallet = req.query.ownerWallet as string | undefined;
      let allAgents = allAgentsRaw;
      if (ownerWallet && ownerWallet !== "not-connected") {
        const ownerDeposits = await storage.getDepositsByWallet(ownerWallet);
        const ownedAgentIds = new Set(ownerDeposits.map((d: any) => d.agentId));
        const ownerUser = await storage.getUserByWallet(ownerWallet);
        const ownerUserId = ownerUser?.id;
        allAgents = allAgentsRaw.filter((a: any) =>
          ownedAgentIds.has(a.id) || a.userId === ownerWallet || (ownerUserId && a.userId === ownerUserId)
        );
      }
      const { getOnChainBalance } = await import("./sui-verify");

      // Build a set of agent IDs belonging to this wallet for reward filtering
      const filteredAgentIds = new Set(allAgents.map((a: any) => a.id));
      // When wallet filter is active, scope rewards to that wallet's agents only
      const scopedRewards = ownerWallet && ownerWallet !== "not-connected"
        ? activeRewards.filter((r) => filteredAgentIds.has(r.agentId))
        : activeRewards;

      const claimedRewards = scopedRewards.filter((r) => r.status === "claimed");
      const totalClaimed = claimedRewards.reduce((sum, r) => sum + r.amount, 0);

      const retainedPendingRewards = scopedRewards.filter((r) => r.status === "pending" && r.escrowTxDigest === "agent_retained");
      const escrowedPendingRewards = scopedRewards.filter((r) => r.status === "pending" && r.escrowTxDigest && r.escrowTxDigest !== "agent_retained" && r.escrowTxDigest !== "pending_escrow");
      const pendingEscrowQueue = scopedRewards.filter((r) => r.status === "pending" && r.escrowTxDigest === "pending_escrow");

      let rewardWalletEscrowedTotal = 0;
      let userRewardWalletAddress: string | undefined;
      let userRewardWalletBalance = 0;
      try {
        const { getRewardWalletBalance: rwBal2, getUserRewardWalletBalance } = await import("./reward-wallet");
        const rwBalance = await rwBal2();
        rewardWalletEscrowedTotal = Math.max(0, rwBalance.sui - 0.01);
        // Per-user reward wallet: fetch balance for the specific owner
        if (ownerWallet && ownerWallet !== "not-connected") {
          const uwBal = await getUserRewardWalletBalance(ownerWallet);
          userRewardWalletAddress = uwBal.address;
          userRewardWalletBalance = Math.max(0, uwBal.sui - 0.01);
        }
      } catch {}

      const GAS_RESERVE = 0.02;
      const agentClaimableBalances: Array<{ agentId: string; agentName: string; claimableBalance: number; totalEarned: number; venue: string; status: string; walletAddress: string; pendingEscrow?: number; escrowedAmount?: number; savingsBalance?: number; savingsWalletAddress?: string }> = [];

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
        // Escrowed rewards were already transferred on-chain — they are ALWAYS fully claimable.
        // The reward wallet may temporarily show lower balance due to timing, but the on-chain
        // escrow transaction is the authoritative proof of funds. Never cap to wallet balance.
        const escrowedClaimable = escrowedAmount;
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

        // Savings balance: read from the shared ratchet cache (populated by T002b proactive fetches)
        let savingsBalance: number | undefined;
        let savingsWalletAddress: string | undefined;
        if (a.savingsWalletAddress) {
          savingsWalletAddress = a.savingsWalletAddress;
          const cached = _agentSavingsCache.get(a.id);
          savingsBalance = cached?.balance ?? 0;
        }

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
            savingsBalance: savingsBalance !== undefined && savingsBalance > 0 ? savingsBalance : undefined,
            savingsWalletAddress,
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
      const pendingEscrowRewards = scopedRewards.filter((r) => r.status === "pending" && r.escrowTxDigest === "pending_escrow" && liveAgentIds.has(r.agentId));
      const totalPendingEscrow = pendingEscrowRewards.reduce((s, r) => s + r.amount, 0);

      const orphanedRewards = scopedRewards.filter((r) => r.status === "pending" && !liveAgentIds.has(r.agentId));
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
        // Per-user personal reward wallet (new system — each user's rewards accumulate here)
        userRewardWalletAddress,
        userRewardWalletBalance,
        userRewardWalletClaimable: userRewardWalletBalance,
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
              _pendingEscrowedCache = undefined; // force canonical snapshot to re-read rewards from DB
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
      const { escrowRewardFromAgent, getOrCreateUserRewardWallet } = await import("./reward-wallet");
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
          let batchUserRwAddr: string | undefined;
          try {
            const batchOwnerUser = await storage.getUser(agent.userId);
            if (batchOwnerUser?.walletAddress) {
              const batchUw = await getOrCreateUserRewardWallet(batchOwnerUser.walletAddress);
              batchUserRwAddr = batchUw.address;
            }
          } catch {}
          const escrowResult = await escrowRewardFromAgent(agent.agentWallet, agent.walletAddress, escrowAmt, batchUserRwAddr);

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
          console.log(`[Rewards] Batch escrow: ${escrowAmt.toFixed(4)} SUI from ${agent.name} → ${batchUserRwAddr ? "personal" : "global"} reward wallet (tx: ${escrowResult.txDigest})`);
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

      const { getRewardWalletBalance, transferRewardToUser, getUserRewardWalletBalance, transferFromUserRewardWallet } = await import("./reward-wallet");

      // Try the user's personal reward wallet first (new system)
      const uwBal = await getUserRewardWalletBalance(walletAddress);
      const userAvailable = Math.max(0, uwBal.sui - 0.01);

      let tx: { txDigest: string; amountTransferred: number };
      let available: number;
      let usedPersonalWallet = false;

      if (userAvailable >= 0.001) {
        // Claim from user's personal reward wallet
        tx = await transferFromUserRewardWallet(walletAddress, walletAddress, userAvailable);
        available = userAvailable;
        usedPersonalWallet = true;
      } else {
        // Fall back to global reward wallet (backward compatibility for legacy escrowed rewards)
        const rwBal = await getRewardWalletBalance();
        available = Math.max(0, rwBal.sui - 0.01);
        if (available < 0.001) {
          return res.status(400).json({
            message: `Your personal reward wallet has ${uwBal.sui.toFixed(4)} SUI and the global reward wallet has ${rwBal.sui.toFixed(4)} SUI — both need at least 0.011 SUI to cover gas. Nothing to claim.`,
            balance: uwBal.sui,
            globalBalance: rwBal.sui,
            userRewardWalletAddress: uwBal.address,
          });
        }
        tx = await transferRewardToUser(walletAddress, available);
      }

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

      console.log(`[Rewards] Direct wallet claim (${usedPersonalWallet ? "personal" : "global"}): ${available.toFixed(4)} SUI → ${walletAddress.slice(0, 10)}... (tx: ${tx.txDigest}). Settled ${settled.toFixed(4)} SUI of orphaned reward records.`);

      res.json({
        success: true,
        amount: available,
        txDigest: tx.txDigest,
        orphanedSettled: settled,
        usedPersonalWallet,
        userRewardWalletAddress: uwBal.address,
        message: `${available.toFixed(4)} SUI transferred from your ${usedPersonalWallet ? "personal" : "global"} reward wallet to your address.`,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to claim reward wallet balance" });
    }
  });

  // Agent Graveyard — list deleted agents that had or still have funds to recover
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
          agentWallet: undefined,
          onChainBalance,
          recoverable: onChainBalance > 0.001 && !entry.recoveredAt,
        };
      }));

      // Only show entries that are worth displaying:
      // - still have on-chain funds to recover, OR
      // - already successfully recovered (show for a history record), OR
      // - had balance at deletion (had funds at some point)
      const visible = enriched.filter(e =>
        e.onChainBalance > 0.001 ||
        e.recoveredAt ||
        (e.balanceAtDeletion ?? 0) > 0.001
      );

      const totalRecoverable = visible.filter(e => e.recoverable).reduce((s, e) => s + e.onChainBalance, 0);

      res.json({ entries: visible, totalRecoverable });
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

  // Fix phantom positions and incorrectly-verified close history.
  // Call once to correct production DB records:
  // 1. Reset pnl_source='synthetic' for closed positions with synthetic digests and no returned SUI
  // 2. Mark duplicate open positions (same on_chain_position_id) as cancelled
  app.post("/api/admin/fix-phantom-positions", async (_req, res) => {
    try {
      const SYNTHETIC_MARKERS = [
        "settled_onchain", "position_gone_onchain", "liquidated_onchain",
        "healed-not-onchain", "manual-review-settled", "closed_externally",
        "verified_closed", "retry_close", "cancelled_unfilled",
      ];

      const allAgents = await storage.getAgents();
      const summary: any[] = [];

      for (const agent of allAgents) {
        const allPositions = await storage.getPositions(agent.id);

        // Fix 1: Reset pnl_source for closed positions with synthetic digests and no returned SUI
        let syntheticFixed = 0;
        for (const pos of allPositions.filter(p => p.status === "closed")) {
          const isSyntheticDigest = !pos.closeTxDigest || pos.closeTxDigest.length < 40 ||
            SYNTHETIC_MARKERS.some(m => pos.closeTxDigest === m || pos.closeTxDigest!.startsWith(m));
          const hasNoSuiReturned = !(pos as any).returnedSui || (pos as any).returnedSui <= 0;
          const isWronglyVerified = (pos as any).pnlSource === "onchain_verified" || (pos as any).pnlSource === "keeper_verified";

          if (isSyntheticDigest && hasNoSuiReturned && isWronglyVerified) {
            await storage.updatePosition(pos.id, { pnlSource: "synthetic" } as any);
            syntheticFixed++;
            console.log(`[PhantomFix] Reset pnl_source for ${agent.name} pos ${pos.id.slice(0, 8)}: close_reason=${(pos as any).closeReason} digest=${pos.closeTxDigest}`);
          }
        }

        // Fix 2: Deduplicate open positions by on_chain_position_id
        const openPositions = allPositions.filter(p =>
          ["open", "pending_open", "closing", "pending_close"].includes(p.status) && p.onChainPositionId
        );

        // Group by on_chain_position_id
        const byOnChainId = new Map<string, typeof openPositions>();
        for (const pos of openPositions) {
          if (!pos.onChainPositionId) continue;
          if (!byOnChainId.has(pos.onChainPositionId)) byOnChainId.set(pos.onChainPositionId, []);
          byOnChainId.get(pos.onChainPositionId)!.push(pos);
        }

        let phantomCancelled = 0;
        for (const [onChainId, dupes] of byOnChainId) {
          if (dupes.length <= 1) continue;
          // Keep the one with status "open" and oldest opened_at; cancel the rest
          const statusPriority: Record<string, number> = { open: 0, closing: 1, pending_open: 2, pending_close: 3 };
          dupes.sort((a, b) => (statusPriority[a.status] ?? 9) - (statusPriority[b.status] ?? 9));
          const toKeep = dupes[0];
          for (const phantom of dupes.slice(1)) {
            await storage.updatePosition(phantom.id, {
              status: "closed",
              closeState: "closed",
              closedAt: new Date(),
              closeReason: "phantom_dedup",
              closeTxDigest: "phantom_dedup",
              unrealizedPnl: 0,
              pnlSource: "synthetic",
            } as any);
            phantomCancelled++;
            console.log(`[PhantomFix] Cancelled phantom duplicate for ${agent.name} pos ${phantom.id.slice(0, 8)} (on_chain_id=${onChainId}, kept=${toKeep.id.slice(0, 8)})`);
          }
        }

        if (syntheticFixed > 0 || phantomCancelled > 0) {
          summary.push({ agent: agent.name, syntheticFixed, phantomCancelled });
        }
      }

      res.json({ ok: true, summary, message: `Fixed synthetic verifications and phantom positions` });
    } catch (err: any) {
      console.error("[PhantomFix] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Emergency admin: force-settle a ghost position that is actually gone on-chain.
  // Verifies absence, clears all in-memory locks, and marks DB closed with position_gone_onchain.
  app.post("/api/admin/force-settle-ghost-position", async (req, res) => {
    try {
      const { positionId } = req.body as { positionId: string };
      if (!positionId) return res.status(400).json({ error: "positionId required" });

      // Find the position across all agents
      const allAgents = await storage.getAgents();
      let targetPos: any = null;
      let targetAgent: any = null;
      for (const agent of allAgents) {
        const positions = await storage.getPositions(agent.id);
        const found = positions.find((p: any) => p.id === positionId);
        if (found) { targetPos = found; targetAgent = agent; break; }
      }
      if (!targetPos) return res.status(404).json({ error: "Position not found" });
      if (targetPos.status === "closed") return res.json({ ok: true, message: "Position already closed" });

      // Verify the position is gone on-chain before force-settling
      const onChainPosId = targetPos.onChainPositionId;
      let confirmedGone = false;
      let verifyErr: string | null = null;
      if (onChainPosId && targetAgent.agentWallet) {
        try {
          const adapter = getAdapter(targetAgent.venue);
          const { decryptKeypair } = await import("./wallet-manager");
          const kp = decryptKeypair(targetAgent.agentWallet);
          const walletAddr = kp.toSuiAddress();
          const onChainPositions = await (adapter as any).getPositions(walletAddr);
          const stillLive = onChainPositions && onChainPositions.some((p: any) => String(p.positionId) === String(onChainPosId));
          confirmedGone = !stillLive && onChainPositions !== null;
          if (!confirmedGone) {
            return res.status(409).json({ error: `Position ${onChainPosId} is still present on-chain — cannot force-settle`, onChainPositions });
          }
        } catch (e: any) {
          verifyErr = e.message;
          return res.status(500).json({ error: `On-chain verification failed: ${e.message}` });
        }
      }

      // Clear in-memory locks so the TP/SL monitor stops attempting close
      positionCloseInProgress.delete(positionId);
      positionCloseCooldown.delete(positionId);

      // Compute estimated PnL based on last mark price
      const lastPrice = getLastPrice();
      const markPrice = lastPrice?.blended || targetPos.markPrice || targetPos.entryPrice;
      const rawPnl = targetPos.side === "long"
        ? (markPrice - targetPos.entryPrice) * (targetPos.sizeSui || 0) / markPrice
        : (targetPos.entryPrice - markPrice) * (targetPos.sizeSui || 0) / markPrice;
      const collateral = targetPos.collateral || 0;
      const estimatedPnl = Math.max(-collateral, rawPnl);

      // Mark as closed with synthetic digest
      await storage.updatePosition(positionId, {
        status: "closed",
        closeState: "closed",
        closedAt: new Date(),
        closeReason: "position_gone_onchain",
        closeTxDigest: "position_gone_onchain",
        realizedPnl: estimatedPnl,
        unrealizedPnl: 0,
        pnlSource: "synthetic",
      } as any);

      console.log(`[AdminForceSettle] Marked pos ${positionId.slice(0, 8)} as position_gone_onchain. Locks cleared. estimatedPnl=${estimatedPnl.toFixed(4)} SUI`);

      broadcast("positions:updated", { agentId: targetAgent.id });

      res.json({
        ok: true,
        positionId,
        onChainPositionId: onChainPosId,
        confirmedGone,
        estimatedPnl,
        message: "Position marked as position_gone_onchain. Locks cleared.",
      });
    } catch (err: any) {
      console.error("[AdminForceSettle] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Emergency admin: cancel specific ghost linked orders using EXACT trigger prices.
  // Use when event-scan-based cancel fails. Provide explicit (orderId, triggerPrice) pairs.
  app.post("/api/admin/emergency-cancel-orders", async (req, res) => {
    try {
      const { agentId, positionId, orders } = req.body as {
        agentId: string;
        positionId: string;
        orders: Array<{ orderId: string; triggerPrice: string }>;
      };
      if (!agentId || !positionId || !orders?.length) {
        return res.status(400).json({ error: "agentId, positionId, and orders[] required" });
      }

      const agent = await storage.getAgent(Number(agentId));
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      if (!agent.agentWallet) return res.status(400).json({ error: "Agent has no wallet" });

      const adapter = getAdapter(agent.venue || "typus") as any;
      if (!adapter?.emergencyCancelOrders) {
        return res.status(400).json({ error: "Adapter does not support emergencyCancelOrders" });
      }

      const result = await adapter.emergencyCancelOrders(agent.agentWallet, positionId, orders);
      return res.json({ ok: result.cancelled > 0, ...result });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Emergency admin: correct DB side for a position (long/short) when it was set wrong.
  app.post("/api/admin/fix-position-side", async (req, res) => {
    try {
      const { positionId, side } = req.body as { positionId: string; side: "long" | "short" };
      if (!positionId || !["long", "short"].includes(side)) {
        return res.status(400).json({ error: "positionId and side ('long'|'short') required" });
      }
      const allAgents = await storage.getAgents();
      let found = false;
      for (const agent of allAgents) {
        const positions = await storage.getPositions(agent.id);
        const pos = positions.find((p: any) => p.id === positionId || p.onChainPositionId === positionId);
        if (pos) {
          await storage.updatePosition(pos.id, { side } as any);
          found = true;
          return res.json({ ok: true, positionId: pos.id, onChainPositionId: pos.onChainPositionId, side });
        }
      }
      if (!found) return res.status(404).json({ error: "Position not found" });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || String(err) });
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
      let escrowed = 0;
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

        const rewardSharePct = agent.rewardSharePct ?? 50;
        if (rewardSharePct <= 0) continue;
        if (!agent.agentWallet || !agent.walletAddress) continue;

        // Use positionId-based deduplication — more precise than amount matching
        const rewardedPositionIds = new Set(
          existingRewards
            .filter(r => r.agentId === agent.id && r.positionId)
            .map(r => r.positionId!)
        );

        const profitablePositions = closedPositions.filter(p => (p.unrealizedPnl || 0) > 0);
        // Only positions without a verified on-chain close may have missed rewards
        // (positions with keeper_filled_tracked or real digest should already have rewards)
        const missedPositions = profitablePositions.filter(p => !rewardedPositionIds.has(p.id));

        for (const pos of missedPositions) {
          const realizedPnl = pos.unrealizedPnl || 0;
          const rewardAmount = realizedPnl * (rewardSharePct / 100);
          if (rewardAmount < 0.001) continue;

          try {
            const { reward, alreadyExisted } = await storage.createRewardIdempotent({
              agentId: agent.id,
              userId: agent.userId,
              amount: rewardAmount,
              agentName: agent.name,
              positionId: pos.id,
            });

            if (alreadyExisted) continue;
            created++;
            console.log(`[BackfillRewards] Created missed reward ${rewardAmount.toFixed(4)} SUI for ${agent.name} pos ${pos.id}`);

            // Attempt to escrow immediately
            try {
              await storage.updateReward(reward.id, { escrowTxDigest: "pending_escrow" });
              const { escrowRewardFromAgent } = await import("./reward-wallet");
              const escrowResult = await escrowRewardFromAgent(agent.agentWallet!, agent.walletAddress!, rewardAmount);
              await storage.updateReward(reward.id, { escrowTxDigest: escrowResult.txDigest });
              escrowed++;
              console.log(`[BackfillRewards] Escrowed ${rewardAmount.toFixed(4)} SUI for ${agent.name} → reward wallet (tx: ${escrowResult.txDigest})`);
            } catch (escErr: any) {
              console.log(`[BackfillRewards] Escrow failed for ${agent.name}: ${escErr.message} — pending_escrow retained`);
            }
          } catch (err: any) {
            console.log(`[BackfillRewards] Failed to create reward for pos ${pos.id}: ${err.message}`);
          }
        }
      }

      res.json({ success: true, rewardsCreated: created, escrowed, winRatesUpdated });
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

  // Precision Adjustments — run auto-tuning for all active agents every 30 minutes
  setInterval(async () => {
    try {
      const { applyPrecisionAdjustments } = await import("./learning-engine");
      const allAgents = await storage.getAgents();
      const activeAgents = allAgents.filter((a: any) => a.status === "active" || a.status === "trading" || a.autoTrade);
      for (const agent of activeAgents) {
        if ((agent as any).precisionAdjustmentsEnabled === false) continue;
        try {
          const result = await applyPrecisionAdjustments(agent.id);
          if (result.adjusted && result.changes.length > 0) {
            console.log(`[PrecisionAdjust] ${agent.name} (${agent.id.slice(0, 8)}): applied ${result.changes.length} adjustment(s) — ${result.changes.map(c => `${c.field}: ${c.oldValue} → ${c.newValue}`).join(", ")}`);
          }
        } catch {}
      }
    } catch {}
  }, 30 * 60 * 1000);

  // Idle Agent Audit — runs every 15 minutes, logs agents that have not traded recently.
  // Escalates at 1hr → 2hr → 4hr+ thresholds so idle issues are visible in server logs.
  const _agentIdleAuditLog = new Map<string, { lastLoggedTier: number; loggedAt: number }>();
  setInterval(async () => {
    try {
      const allAgents = await storage.getAgents();
      const runningAgents = allAgents.filter((a: any) => a.status === "running" || a.status === "active" || a.autoTrade);
      const now = Date.now();
      for (const agent of runningAgents) {
        const lastExecMs = (agent as any).lastExecutionAt
          ? new Date((agent as any).lastExecutionAt as string).getTime()
          : null;
        const idleMs = lastExecMs ? now - lastExecMs : null;
        const idleHrs = idleMs ? idleMs / (60 * 60 * 1000) : null;

        let tier = 0;
        if (idleHrs === null || idleHrs >= 4) tier = 3;
        else if (idleHrs >= 2) tier = 2;
        else if (idleHrs >= 1) tier = 1;

        if (tier === 0) {
          _agentIdleAuditLog.delete(agent.id); // reset if agent traded recently
          continue;
        }

        const prev = _agentIdleAuditLog.get(agent.id);
        const LOG_COOLDOWN_MS = 15 * 60 * 1000; // don't repeat same tier more than once per 15 min
        if (!prev || prev.lastLoggedTier < tier || (now - prev.loggedAt) >= LOG_COOLDOWN_MS) {
          const idleLabel = idleHrs === null ? "never traded" : `${idleHrs.toFixed(1)}h`;
          const severity = tier === 3 ? "CRITICAL" : tier === 2 ? "WARN" : "INFO";
          console.log(`[IdleAudit] ${severity}: ${agent.name} (${agent.id.slice(0, 8)}) idle for ${idleLabel} — status=${agent.status} mode=${((agent as any).signalMode) || "AUTO"}`);
          _agentIdleAuditLog.set(agent.id, { lastLoggedTier: tier, loggedAt: now });
        }
      }
    } catch {}
  }, 15 * 60 * 1000);

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

      const withdrawMist = suiToMist(maxWithdraw);
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

      // SAFETY: refuse to delete any agent that has real (non-simulation) open positions.
      // Real positions are identified by a non-null txDigest that doesn't start with "sim_" or "force_close_".
      const blockedAgents: string[] = [];
      const safeToDelete: typeof orphaned = [];
      for (const agent of orphaned) {
        const openPositions = await storage.getOpenPositions(agent.id);
        const realOpen = openPositions.filter(p =>
          p.txDigest &&
          !p.txDigest.startsWith("sim_") &&
          !p.txDigest.startsWith("force_close_") &&
          !p.txDigest.startsWith("purged_") &&
          p.txDigest !== "position_gone_onchain" &&
          p.txDigest !== "settled_onchain"
        );
        if (realOpen.length > 0) {
          blockedAgents.push(`${agent.name} (${realOpen.length} real open position(s))`);
          console.warn(`[Admin] Cleanup blocked: agent "${agent.name}" has ${realOpen.length} real open position(s) — skipping deletion to preserve keypair`);
        } else {
          safeToDelete.push(agent);
        }
      }

      let deleted = 0;
      for (const agent of safeToDelete) {
        if (agent.status === "running") {
          await storage.updateAgent(agent.id, { status: "idle" });
        }
        await storage.deleteAgent(agent.id);
        deleted++;
      }
      broadcast("agents:refresh", {});
      res.json({
        success: true,
        deleted,
        blocked: blockedAgents.length,
        blockedAgents,
        agentIds: safeToDelete.map(a => ({ id: a.id, name: a.name })),
        message: blockedAgents.length > 0
          ? `Deleted ${deleted} agent(s). ${blockedAgents.length} agent(s) were BLOCKED — they have real open positions and must be closed first.`
          : `Deleted ${deleted} agent(s).`,
      });
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
      const savingsWalletAddr: string | null = agent.savingsWalletAddress || null;

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
      let totalSavings = 0;

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

        // Classify savings wallet transfers — profit distributions to agent's savings wallet
        if (type === "unknown_outflow" && savingsWalletAddr && direction === "out") {
          const savingsWalletChange = balanceChanges.find((bc: any) =>
            bc.owner?.AddressOwner &&
            normalizeAddr(bc.owner.AddressOwner) === normalizeAddr(savingsWalletAddr!) &&
            isSuiCoin(bc.coinType) &&
            Number(bc.amount) > 0
          );
          if (savingsWalletChange) {
            type = "savings_transfer";
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
          case "savings_transfer":
            totalSavings += amountSui;
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
      const notes: string[] = [];

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
        // Cancel failures mean orders were already filled by the keeper — expected behavior, not an error
        notes.push(`${failedCancels.length} cancel attempts returned order_not_found (${totalCancelGas.toFixed(4)} SUI in gas) — orders were already filled by the Typus keeper before the cancel reached the chain. This is expected behavior in fast markets.`);
      }

      const unknownOutflows = categorized.filter(t => t.type === "unknown_outflow" && t.amountSui > 0.05);
      for (const tx of unknownOutflows) {
        errors.push(`Unclassified outflow of ${tx.amountSui.toFixed(4)} SUI in TX ${tx.digest.slice(0, 12)}... — may be a cascade trade that was opened on-chain but not tracked in the database`);
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
          totalSavings: parseFloat(totalSavings.toFixed(6)),
          unexplainedGap: parseFloat(adjustedGap.toFixed(6)),
          currentlyLockedOnChain: parseFloat(currentlyLockedOnChain.toFixed(6)),
          currentWalletBalance: parseFloat(currentWalletBalance.toFixed(6)),
          liquidationLosses: parseFloat(liquidationLosses.toFixed(6)),
          tradingLosses: parseFloat(tradingLosses.toFixed(6)),
          savingsWalletAddress: savingsWalletAddr,
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
        notes,
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
    /server\/dex\/execution-engine\.ts/,
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

  // ─── Wallet History: fetch, classify, and summarize on-chain tx ledger ───
  // Cache results per agent for 5 minutes — prevents hammering shared RPC node
  const walletHistoryCache = new Map<string, { data: any; fetchedAt: number; inFlight: boolean }>();
  const WALLET_HISTORY_TTL_MS = 5 * 60 * 1000;

  app.get("/api/agents/:id/wallet-history", async (req, res) => {
    try {
      const agentId = req.params.id;
      const forceRefresh = req.query.refresh === "1";

      // Serve from cache if fresh
      const cached = walletHistoryCache.get(agentId);
      if (cached && !forceRefresh) {
        const age = Date.now() - cached.fetchedAt;
        if (age < WALLET_HISTORY_TTL_MS && !cached.inFlight) {
          return res.json({ ...cached.data, cachedAt: cached.fetchedAt, cacheAgeMs: age });
        }
        // If in-flight, return stale data rather than stacking requests
        if (cached.inFlight && cached.fetchedAt > 0) {
          return res.json({ ...cached.data, cachedAt: cached.fetchedAt, cacheAgeMs: age, stale: true });
        }
      }

      // Mark as in-flight to prevent parallel fetches
      walletHistoryCache.set(agentId, { data: cached?.data ?? {}, fetchedAt: cached?.fetchedAt ?? 0, inFlight: true });

      const agent = await storage.getAgent(agentId);
      if (!agent) { walletHistoryCache.delete(agentId); return res.status(404).json({ message: "Agent not found" }); }
      if (!agent.walletAddress) { walletHistoryCache.delete(agentId); return res.status(400).json({ message: "Agent has no wallet address" }); }

      const { suiClient: sc } = await import("./sui-verify");
      const walletAddress = agent.walletAddress;
      const SUI_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
      const isSuiCoin = (ct: string) => ct === "0x2::sui::SUI" || ct === SUI_TYPE;
      const norm = (a: string) => a.toLowerCase();

      let rewardWalletAddr: string | null = null;
      try { rewardWalletAddr = getRewardWalletAddress(); } catch {}
      const savingsWalletAddr: string | null = agent.savingsWalletAddress || null;

      const allOrders = await storage.getOrders(req.params.id);
      const allPositions = await storage.getPositions(req.params.id);
      const allRewards = (await storage.getRewards()).filter(r => r.agentId === req.params.id);
      const allDeposits = await storage.getDepositsByAgent(req.params.id);

      const FAKE_CLOSE = new Set(["closed_externally", "closed_external", "settled_onchain", "cancelled_unfilled", "liquidated_onchain"]);
      const orderTxDigests = new Set(allOrders.filter(o => o.txDigest).map(o => o.txDigest!));
      const positionOpenDigests = new Set(allPositions.filter(p => p.txDigest).map(p => p.txDigest!));
      const positionCloseDigests = new Set(allPositions.filter(p => p.closeTxDigest && !FAKE_CLOSE.has(p.closeTxDigest) && !p.closeTxDigest.startsWith("reopened_") && !p.closeTxDigest.startsWith("recovered_")).map(p => p.closeTxDigest!));
      const rewardEscrowDigests = new Set(allRewards.filter(r => r.escrowTxDigest && r.escrowTxDigest !== "pending_escrow").map(r => r.escrowTxDigest!));
      const depositDigests = new Set(allDeposits.filter(d => d.txDigest).map(d => d.txDigest!));

      const closedPositions = allPositions.filter(p => p.status === "closed");
      const closePositionIds = new Set(closedPositions.filter(p => p.onChainPositionId).map(p => p.onChainPositionId!));
      const closeOrderTxDigests = new Set(closedPositions.filter(p => p.lastCloseTx).map(p => p.lastCloseTx!));
      const closedPositionTimes = closedPositions.filter(p => p.closedAt).map(p => new Date(p.closedAt!).getTime());

      const fetchPage = async (filter: any) => {
        try {
          // Small delay before each query to avoid burst hitting rate limit
          await new Promise(r => setTimeout(r, 200));
          const r: any = await sc.queryTransactionBlocks({
            filter,
            options: { showBalanceChanges: true, showEvents: true, showInput: true, showEffects: true },
            limit: 50,
            order: "descending" as any,
          });
          return r.data || [];
        } catch { return []; }
      };

      // Sequential (not parallel) to avoid 2 heavy RPC calls at once
      const fromTxs = await fetchPage({ FromAddress: walletAddress });
      await new Promise(r => setTimeout(r, 500));
      const toTxs = await fetchPage({ ToAddress: walletAddress });
      const seen = new Set<string>();
      const rawTxs: any[] = [];
      for (const tx of [...fromTxs, ...toTxs]) {
        if (!seen.has(tx.digest)) { seen.add(tx.digest); rawTxs.push(tx); }
      }
      rawTxs.sort((a, b) => Number(b.timestampMs || 0) - Number(a.timestampMs || 0));

      const entries = rawTxs.map(tx => {
        const digest: string = tx.digest;
        const timestampMs: number = Number(tx.timestampMs || 0);
        const status: string = (tx.effects?.status?.status || "unknown");
        const balanceChanges: any[] = tx.balanceChanges || [];
        const events: any[] = tx.events || [];
        const eventTypes: string[] = events.map((e: any) => String(e.type || ""));

        const gasObj = tx.effects?.gasUsed;
        const gasSui = gasObj
          ? (Number(gasObj.computationCost || 0) + Number(gasObj.storageCost || 0) - Number(gasObj.storageRebate || 0)) / 1e9
          : 0;

        const walletChange = balanceChanges.find((bc: any) =>
          bc.owner?.AddressOwner && norm(bc.owner.AddressOwner) === norm(walletAddress) && isSuiCoin(bc.coinType)
        );
        const walletDelta = walletChange ? Number(walletChange.amount) / 1e9 : 0;
        const direction: "in" | "out" | "self" = walletDelta > 0 ? "in" : walletDelta < 0 ? "out" : "self";
        const amountSui = Math.abs(walletDelta);
        const sender: string = (tx.transaction?.data?.sender || "").toLowerCase();

        const hasCreateOrder = eventTypes.some(t => t.includes("CreateTradingOrderEvent"));
        const hasOrderFilled = eventTypes.some(t => t.includes("OrderFilledEvent") || t.includes("TradingOrderFilledEvent"));
        const hasCancelOrder = eventTypes.some(t => t.includes("CancelTradingOrderEvent"));
        const hasClosePosition = eventTypes.some(t => t.includes("ClosePositionEvent") || t.includes("ForcedCloseEvent"));
        const hasRemovePos = eventTypes.some(t => t.includes("RemovePositionEvent"));
        const hasLiquidate = eventTypes.some(t => t.includes("LiquidateEvent") || t.includes("liquidat"));

        let isReduceOnly = false;
        let linkedPositionId: string | null = null;
        for (const evt of events) {
          const parsed = (evt as any).parsedJson;
          if (!parsed) continue;
          if (parsed.linked_position_id) linkedPositionId = String(parsed.linked_position_id);
          const et = ((evt as any).type || "").split("::").pop() || "";
          if (et.includes("CreateTradingOrderEvent") && (parsed.reduce_only || parsed.is_reduce_only)) isReduceOnly = true;
        }

        let txClass = "unknown";

        if (depositDigests.has(digest) || (direction === "in" && norm(sender) !== norm(walletAddress))) {
          txClass = "deposit_in";
        }
        if (hasCreateOrder || orderTxDigests.has(digest) || positionOpenDigests.has(digest)) {
          txClass = "order_create";
        }
        if (hasCancelOrder) txClass = "order_cancel";
        if (hasOrderFilled && (positionCloseDigests.has(digest) || hasClosePosition || hasRemovePos)) txClass = "close_fill";
        else if (positionCloseDigests.has(digest) || hasClosePosition || hasRemovePos) txClass = "close_fill";
        if (hasLiquidate) txClass = "liquidation";
        if (txClass === "order_create" && hasCreateOrder && !hasOrderFilled) {
          const isClose = isReduceOnly || (linkedPositionId && closePositionIds.has(linkedPositionId)) || closeOrderTxDigests.has(digest);
          if (isClose) txClass = "close_order";
        }
        if (txClass === "order_create" && direction === "in" && hasOrderFilled) txClass = "close_fill";
        if (txClass === "deposit_in" && direction === "in" && norm(sender) !== norm(walletAddress)) {
          if (hasOrderFilled || hasClosePosition || hasRemovePos) txClass = "close_fill";
          else if (closedPositionTimes.some(ct => Math.abs(timestampMs - ct) < 30_000) && amountSui > 0.1) txClass = "close_fill";
        }
        if (rewardEscrowDigests.has(digest)) {
          txClass = "reward_escrow";
        } else if (rewardWalletAddr && direction === "out") {
          const rwChange = balanceChanges.find((bc: any) => bc.owner?.AddressOwner && norm(bc.owner.AddressOwner) === norm(rewardWalletAddr!) && isSuiCoin(bc.coinType) && Number(bc.amount) > 0);
          if (rwChange) txClass = "reward_escrow";
        }
        if ((txClass === "unknown" || txClass === "order_create") && savingsWalletAddr && direction === "out") {
          const swChange = balanceChanges.find((bc: any) => bc.owner?.AddressOwner && norm(bc.owner.AddressOwner) === norm(savingsWalletAddr!) && isSuiCoin(bc.coinType) && Number(bc.amount) > 0);
          if (swChange) txClass = "savings_transfer";
        }
        if (txClass === "unknown" && status === "failure" && direction === "out" && amountSui < 0.05) txClass = "gas_spent";
        if (txClass === "unknown" && direction === "out" && amountSui < 0.02) txClass = "gas_spent";
        if (txClass === "unknown" && direction === "in") txClass = "deposit_in";

        const counterparty = (() => {
          if (direction === "out") {
            const recvChange = balanceChanges.find((bc: any) => bc.owner?.AddressOwner && norm(bc.owner.AddressOwner) !== norm(walletAddress) && isSuiCoin(bc.coinType) && Number(bc.amount) > 0);
            return recvChange?.owner?.AddressOwner || null;
          }
          return sender !== norm(walletAddress) ? sender : null;
        })();

        const summaryMap: Record<string, string> = {
          deposit_in: `Received ${amountSui.toFixed(4)} SUI into the funding wallet.`,
          order_create: `Sent ${amountSui.toFixed(4)} SUI to open a new leveraged position on Typus.`,
          order_cancel: `Cancel order submitted — no SUI moved (${amountSui < 0.001 ? "gas only" : amountSui.toFixed(4) + " SUI returned"}).`,
          close_order: `Close order placed on-chain to exit an existing position.`,
          close_fill: `Position settled — ${amountSui.toFixed(4)} SUI returned to the funding wallet.`,
          liquidation: `Position was liquidated by the protocol. ${amountSui > 0 ? amountSui.toFixed(4) + " SUI returned." : "Full collateral lost."}`,
          reward_escrow: `${amountSui.toFixed(4)} SUI moved to the reward escrow wallet (your claimable rewards).`,
          savings_transfer: `${amountSui.toFixed(4)} SUI moved to the savings wallet as profit distribution.`,
          gas_spent: `Gas-only transaction — ${gasSui.toFixed(5)} SUI burned for protocol interaction.`,
          unknown: `Unclassified transaction — ${amountSui.toFixed(4)} SUI ${direction === "out" ? "sent" : "received"}.`,
        };

        return {
          digest,
          timestampMs,
          timestamp: timestampMs ? new Date(timestampMs).toISOString() : null,
          direction,
          amountSui: parseFloat(amountSui.toFixed(6)),
          gasSui: parseFloat(gasSui.toFixed(6)),
          walletDelta: parseFloat(walletDelta.toFixed(6)),
          txClass,
          status,
          counterparty: counterparty ? `${counterparty.slice(0, 8)}...${counterparty.slice(-4)}` : null,
          counterpartyFull: counterparty,
          aiSummary: summaryMap[txClass] || summaryMap.unknown,
          explorerUrl: `https://suiscan.xyz/mainnet/tx/${digest}`,
        };
      });

      const responseData = {
        agentId,
        walletAddress,
        savingsWalletAddress: savingsWalletAddr,
        totalFetched: entries.length,
        transactions: entries,
      };
      // Store in cache and clear in-flight flag
      walletHistoryCache.set(agentId, { data: responseData, fetchedAt: Date.now(), inFlight: false });
      console.log(`[WalletHistory] ${agent.name}: cached ${entries.length} txs`);
      res.json(responseData);
    } catch (e: any) {
      // Clear in-flight flag on error so next request can retry
      const cached = walletHistoryCache.get(req.params.id);
      if (cached) walletHistoryCache.set(req.params.id, { ...cached, inFlight: false });
      console.error("[WalletHistory] Error:", e.message);
      res.status(500).json({ message: e.message || "Failed to fetch wallet history" });
    }
  });

  return httpServer;
}
