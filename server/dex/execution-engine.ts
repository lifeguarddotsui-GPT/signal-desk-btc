import { storage } from "../storage";
import { getAdapter } from "./index";
import type { DexOrderParams, DexOrderResult } from "./types";
import type { Agent, AgentWithSignalAgent } from "../../shared/schema";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { ensureMinGasReserve, COLLATERAL_GAS_RESERVE_SUI } from "./gas";
import { decryptKeypair } from "./wallet-manager";
import { TypusAdapter } from "./typus-adapter";
import { getLastPrice } from "../price-service";

const SUI_RPC = "https://fullnode.mainnet.sui.io:443";
const suiClient = new SuiJsonRpcClient({ url: SUI_RPC, network: "mainnet" });

const activeExecutions = new Set<string>();
const lastTradeMap = new Map<string, { direction: string; time: number }>();
const oracleMismatchCooldown = new Map<string, number>();
const dailyGasSpend = new Map<string, { totalMist: number; failedTxCount: number; resetAt: number }>();

const TRADE_COOLDOWN_MS = 120_000;
const ORACLE_MISMATCH_COOLDOWN_MS = 5_000;
const MAX_OPEN_POSITIONS_PER_AGENT = 5;
const MAX_DAILY_FAILED_GAS_SUI = 0.05;
const MAX_DAILY_FAILED_TX_COUNT = 10;
const FAILED_TX_GAS_COST_MIST = 3_300_000;

function trackFailedGasSpend(agentId: string): { exceeded: boolean; reason?: string } {
  const now = Date.now();
  let record = dailyGasSpend.get(agentId);

  if (!record || now > record.resetAt) {
    record = { totalMist: 0, failedTxCount: 0, resetAt: now + 24 * 60 * 60 * 1000 };
    dailyGasSpend.set(agentId, record);
  }

  record.totalMist += FAILED_TX_GAS_COST_MIST;
  record.failedTxCount += 1;
  dailyGasSpend.set(agentId, record);

  const totalSui = record.totalMist / 1e9;
  if (totalSui >= MAX_DAILY_FAILED_GAS_SUI) {
    return { exceeded: true, reason: `Daily failed gas spend (${totalSui.toFixed(4)} SUI) exceeds cap (${MAX_DAILY_FAILED_GAS_SUI} SUI). Agent paused to prevent wallet drain.` };
  }
  if (record.failedTxCount >= MAX_DAILY_FAILED_TX_COUNT) {
    return { exceeded: true, reason: `Daily failed tx count (${record.failedTxCount}) exceeds cap (${MAX_DAILY_FAILED_TX_COUNT}). Agent paused.` };
  }
  return { exceeded: false };
}

function resetGasSpendTracking(agentId: string): void {
  dailyGasSpend.delete(agentId);
}

export function getGasSpendStatus(agentId: string): { totalMist: number; failedTxCount: number; maxSui: number; maxCount: number } {
  const record = dailyGasSpend.get(agentId);
  return {
    totalMist: record?.totalMist ?? 0,
    failedTxCount: record?.failedTxCount ?? 0,
    maxSui: MAX_DAILY_FAILED_GAS_SUI,
    maxCount: MAX_DAILY_FAILED_TX_COUNT,
  };
}

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

  if (agent.status !== "running") return null;
  if (agent.balance <= 0) return null;

  if (!isStrongSignal(signal)) {
    return null;
  }

  if (activeExecutions.has(agent.id)) {
    return null;
  }

  const mismatchCooldownUntil = oracleMismatchCooldown.get(agent.id);
  if (mismatchCooldownUntil && Date.now() < mismatchCooldownUntil) {
    return null;
  }

  const lastTrade = lastTradeMap.get(agent.id);
  if (lastTrade && lastTrade.direction === direction && Date.now() - lastTrade.time < TRADE_COOLDOWN_MS) {
    return null;
  }

  const openPositions = await storage.getOpenPositions(agent.id);

  if (openPositions.length >= MAX_OPEN_POSITIONS_PER_AGENT) {
    console.log(`[Execution] Agent ${agent.name} at max positions (${openPositions.length}/${MAX_OPEN_POSITIONS_PER_AGENT})`);
    return null;
  }

  const adapter = getAdapter(agent.venue);
  if (!adapter || !adapter.supported || !adapter.isReady()) {
    return null;
  }

  if (!agent.agentWallet) {
    return null;
  }

  try {
    const keypair = decryptKeypair(agent.agentWallet);
    const walletAddr = keypair.toSuiAddress();
    const gasCheck = await ensureMinGasReserve(suiClient, walletAddr);
    if (!gasCheck.ok) {
      console.log(`[Execution] Skipping ${agent.name}: gas check failed — ${gasCheck.reason}`);
      return null;
    }
  } catch (gasErr: any) {
    console.log(`[Execution] Gas check failed for ${agent.name}: ${gasErr.message}`);
  }

  activeExecutions.add(agent.id);

  try {
    const keypairForBalance = decryptKeypair(agent.agentWallet);
    const walletAddrForBalance = keypairForBalance.toSuiAddress();
    let onChainBalance = agent.balance;
    try {
      const balResp = await suiClient.getBalance({ owner: walletAddrForBalance, coinType: "0x2::sui::SUI" });
      onChainBalance = Number(balResp.totalBalance) / 1e9;
    } catch {}
    const effectiveBalance = Math.min(agent.balance, onChainBalance);

    const GAS_RESERVE_SUI = COLLATERAL_GAS_RESERVE_SUI;
    const SAFETY_MARGIN = 0.90;
    const balanceForTrading = Math.max(0, effectiveBalance - GAS_RESERVE_SUI);
    const availableForTrading = balanceForTrading * SAFETY_MARGIN;
    const collateral = Math.min(agent.maxQty, availableForTrading);
    const quantity = Math.floor(collateral * agent.leverage);

    if (quantity < 10) {
      console.log(`[Execution] Skipping ${agent.name}: insufficient balance for min trade (qty=${quantity.toFixed(2)} SUI < 10 SUI min, collateral=${collateral.toFixed(4)}, onChain=${onChainBalance.toFixed(4)})`);
      return null;
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
      symbol: "SUI-USDC",
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
      const err = validation.reason || "Order validation failed";
      await storage.updateAgent(agent.id, { lastExecutionError: err, lastExecutionAt: new Date() });
      return { success: false, error: err, venue: agent.venue };
    }

    const expectedCollateral = quantity / agent.leverage;
    console.log(`[Execution] Submitting ${direction} order for agent ${agent.name} on ${agent.venue}: qty=${quantity.toFixed(4)} SUI @ $${currentPrice.toFixed(4)} | leverage=${agent.leverage}x | collateral=${expectedCollateral.toFixed(4)} SUI (maxCollateral=${agent.maxQty}) | signal=${signal}`);

    let result: DexOrderResult;
    try {
      result = await adapter.openPosition(orderParams);
    } catch (dexError: any) {
      const err = `DEX error: ${dexError.message}`;
      console.log(`[Execution] DEX call failed for ${agent.name}: ${dexError.message} — no balance spent`);
      await storage.updateAgent(agent.id, { lastExecutionError: err, lastExecutionAt: new Date() });

      if (dexError.message?.includes("oracle_mismatched")) {
        console.log(`[Execution] Oracle mismatch exception for ${agent.name} — applying ${ORACLE_MISMATCH_COOLDOWN_MS}ms cooldown`);
        oracleMismatchCooldown.set(agent.id, Date.now() + ORACLE_MISMATCH_COOLDOWN_MS);
      }

      const spendCheck = trackFailedGasSpend(agent.id);
      if (spendCheck.exceeded) {
        console.log(`[SpendCap] Auto-pausing agent ${agent.name}: ${spendCheck.reason}`);
        await storage.updateAgent(agent.id, { status: "paused", lastExecutionError: `SPEND_CAP: ${spendCheck.reason}` });
      }

      if (adapter instanceof TypusAdapter) {
        const cbStatus = adapter.getCircuitBreakerStatus(agent.id);
        if (cbStatus.tripped) {
          console.log(`[CircuitBreaker] Agent ${agent.name} hit ${cbStatus.count} consecutive failures — auto-cooldown ${cbStatus.cooldownRemaining}s remaining`);
          await storage.updateAgent(agent.id, { lastExecutionError: `CIRCUIT_BREAKER: cooldown ${cbStatus.cooldownRemaining}s — ${cbStatus.lastError}` });
        }
      }

      return { success: false, error: err, venue: agent.venue };
    }

    if (!result.success) {
      const errorStr = result.error || "Unknown error";
      console.log(`[Execution] DEX returned error for ${agent.name}: ${errorStr} — no balance spent`);
      await storage.updateAgent(agent.id, { lastExecutionError: errorStr, lastExecutionAt: new Date() });

      if (errorStr.includes("oracle_mismatched")) {
        console.log(`[Execution] Oracle mismatch for ${agent.name} — applying ${ORACLE_MISMATCH_COOLDOWN_MS}ms cooldown before retry`);
        oracleMismatchCooldown.set(agent.id, Date.now() + ORACLE_MISMATCH_COOLDOWN_MS);
      }

      const spendCheck = trackFailedGasSpend(agent.id);
      if (spendCheck.exceeded) {
        console.log(`[SpendCap] Auto-pausing agent ${agent.name}: ${spendCheck.reason}`);
        await storage.updateAgent(agent.id, { status: "paused", lastExecutionError: `SPEND_CAP: ${spendCheck.reason}` });
      }

      if (adapter instanceof TypusAdapter) {
        const cbStatus = adapter.getCircuitBreakerStatus(agent.id);
        if (cbStatus.tripped) {
          console.log(`[CircuitBreaker] Agent ${agent.name} hit ${cbStatus.count} consecutive failures — auto-cooldown ${cbStatus.cooldownRemaining}s remaining`);
          await storage.updateAgent(agent.id, { lastExecutionError: `CIRCUIT_BREAKER: cooldown ${cbStatus.cooldownRemaining}s — ${cbStatus.lastError}` });
        }
      }

      return { success: false, error: errorStr, venue: agent.venue };
    }

    if (!result.txDigest || result.txDigest.startsWith("sim_")) {
      const err = "No valid on-chain transaction";
      console.log(`[Execution] No valid on-chain txDigest for ${agent.name} — no balance spent`);
      await storage.updateAgent(agent.id, { lastExecutionError: err, lastExecutionAt: new Date() });
      return { success: false, error: err, venue: agent.venue };
    }

    const fees = await adapter.estimateFees(orderParams);

    const order = await storage.createOrder({
      agentId: agent.id,
      signalId: signalId || null,
      symbol: "SUI-USDC",
      side: direction,
      type: "market",
      leverage: agent.leverage,
      qty: quantity,
      price: currentPrice,
      entryPrice: currentPrice,
      stopLossPrice,
      takeProfitPrice,
      venue: agent.venue,
      txDigest: result.txDigest,
    });

    await storage.updateOrder(order.id, { status: "filled" });

    const position = await storage.createPosition({
      agentId: agent.id,
      symbol: "SUI-USDC",
      side: direction,
      sizeSui: quantity,
      entryPrice: currentPrice,
      markPrice: currentPrice,
      unrealizedPnl: 0,
      liquidationPrice: stopLossPrice,
      txDigest: result.txDigest,
    });

    // If adapter returned an on-chain positionId, update the position
    if (result.positionId) {
      await storage.updatePosition(position.id, { 
        id: result.positionId, // This might be dangerous if id is used as PK elsewhere, but shared/schema says id is varchar primary key
        verified: true 
      });
    } else {
      await storage.updatePosition(position.id, { verified: true });
    }

    const usedCollateral = quantity / agent.leverage + fees.total;
    await storage.updateAgent(agent.id, {
      balance: Math.max(0, agent.balance - usedCollateral),
      totalTrades: (agent.totalTrades || 0) + 1,
      lastExecutionError: null,
      lastExecutionAt: new Date(),
    });

    lastTradeMap.set(agent.id, { direction, time: Date.now() });
    resetGasSpendTracking(agent.id);
    oracleMismatchCooldown.delete(agent.id);

    console.log(`[Execution][LIVE] Order filled: ${result.txDigest} for agent ${agent.name} (${direction} ${quantity.toFixed(4)} SUI @ $${currentPrice.toFixed(4)})`);

    return result;
  } catch (error: any) {
    console.error(`[Execution] Error for agent ${agent.name}:`, error.message);
    return { success: false, error: error.message, venue: agent.venue };
  } finally {
    activeExecutions.delete(agent.id);
  }
}

export async function closePositionForAgent(agent: Agent, positionId: string, currentPrice: number, allowDbFallback = false): Promise<{ closed: boolean; onChain: boolean; pnl: number }> {
  const pos = (await storage.getPositions(agent.id)).find(p => p.id === positionId);
  if (!pos || pos.status !== "open") return { closed: false, onChain: false, pnl: 0 };

  const adapter = getAdapter(agent.venue);
  let onChainSuccess = false;
  let closeTxDigest: string | null = null;

  if (adapter) {
    try {
      const result = await adapter.closePosition({
        agent,
        positionId: pos.id,
        side: pos.side as "long" | "short",
        quantity: pos.sizeSui,
        price: currentPrice,
      });

      if (result.success && result.txDigest && !result.txDigest.startsWith("sim_")) {
        onChainSuccess = true;
        closeTxDigest = result.txDigest;
      } else {
        console.log(`[Execution] DEX close returned no valid txDigest for ${agent.name}: ${result.error || "no digest"}`);
      }
    } catch (err: any) {
      console.log(`[Execution] DEX close failed for ${agent.name}: ${err.message}`);
    }
  }

  if (!onChainSuccess && !allowDbFallback) {
    console.log(`[Execution] Close rejected for ${agent.name} position ${positionId} — no DB fallback allowed`);
    return { closed: false, onChain: false, pnl: 0 };
  }

  const collateral = pos.sizeSui / agent.leverage;
  let realizedPnl = pos.side === "long"
    ? (currentPrice - pos.entryPrice) * pos.sizeSui
    : (pos.entryPrice - currentPrice) * pos.sizeSui;

  if (realizedPnl < -collateral) {
    console.log(`[Execution] Capping loss at collateral: raw PnL=${realizedPnl.toFixed(4)}, collateral=${collateral.toFixed(4)}`);
    realizedPnl = -collateral;
  }

  await storage.updatePosition(pos.id, {
    status: "closed",
    markPrice: currentPrice,
    unrealizedPnl: realizedPnl,
    closedAt: new Date(),
    txDigest: closeTxDigest || pos.txDigest,
  });

  const isWin = realizedPnl > 0;

  const freshAgent = await storage.getAgent(agent.id);
  const currentBalance = freshAgent ? freshAgent.balance : agent.balance;

  const allPositions = await storage.getPositions(agent.id);
  const closedPositions = allPositions.filter(p => p.status === "closed");
  const totalClosed = closedPositions.length;
  const totalWins = closedPositions.filter(p => (p.unrealizedPnl || 0) > 0).length;
  const newWinRate = totalClosed > 0 ? totalWins / totalClosed : 0;

  const rewardSharePct = agent.rewardSharePct ?? 50;
  let rewardAmount = 0;
  let returnToBalance: number;

  if (isWin && rewardSharePct > 0) {
    rewardAmount = realizedPnl * (rewardSharePct / 100);
    const reinvestAmount = realizedPnl - rewardAmount;
    returnToBalance = collateral + reinvestAmount;
  } else if (isWin) {
    returnToBalance = collateral + realizedPnl;
  } else {
    returnToBalance = Math.max(0, collateral + realizedPnl);
  }

  const newBalance = Math.max(0, currentBalance + returnToBalance);
  await storage.updateAgent(agent.id, {
    balance: newBalance,
    totalPnl: (agent.totalPnl || 0) + realizedPnl,
    winRate: newWinRate,
  });

  if (rewardAmount > 0) {
    try {
      await storage.createReward({
        agentId: agent.id,
        userId: agent.userId,
        amount: rewardAmount,
      });
      console.log(`[Rewards] Created ${rewardAmount.toFixed(4)} SUI reward for ${agent.name} (${rewardSharePct}% of ${realizedPnl.toFixed(4)} profit)`);
    } catch (err: any) {
      console.error(`[Rewards] Failed to create reward: ${err.message}`);
    }
  }

  const pnlPct = pos.side === "long"
    ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

  const method = onChainSuccess ? "on-chain" : "DB-fallback";
  console.log(`[Execution] Position closed (${method}) for ${agent.name}: ${pos.side} ${pos.sizeSui.toFixed(4)} SUI, PnL=${realizedPnl.toFixed(4)} SUI (${pnlPct.toFixed(2)}%), WinRate=${(newWinRate * 100).toFixed(0)}%`);

  return { closed: true, onChain: onChainSuccess, pnl: realizedPnl };
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

export async function closeAllPositionsForAgent(agent: Agent, currentPrice: number, userInitiated = false): Promise<{ closed: number; failed: number; totalPnl: number; returnedCollateral: number }> {
  const positions = await storage.getPositions(agent.id);
  const openPositions = positions.filter(p => p.status === "open");

  let totalPnl = 0;
  let returnedCollateral = 0;
  let closedCount = 0;
  let failedCount = 0;

  for (const pos of openPositions) {
    const result = await closePositionForAgent(agent, pos.id, currentPrice, false);
    if (result.closed) {
      closedCount++;
      totalPnl += result.pnl;
      returnedCollateral += pos.sizeSui / agent.leverage;
    } else {
      failedCount++;
      console.log(`[Execution] Failed to close position ${pos.id} on-chain for ${agent.name} (${pos.side} ${pos.sizeSui} SUI) — position may be liquidated or already closed on DEX`);

      if (userInitiated) {
        let positionExistsOnChain = true;
        const adapter = getAdapter(agent.venue);
        if (adapter && agent.agentWallet) {
          try {
            const onChainPositions = await adapter.getPositions(agent.agentWallet);
            const matching = onChainPositions.find(
              (p) => p.side === pos.side && Math.abs(p.entryPrice - pos.entryPrice) < 0.01
            );
            positionExistsOnChain = !!matching;
          } catch (err: any) {
            console.log(`[Execution] Could not verify on-chain position state: ${err.message} — assuming liquidated`);
            positionExistsOnChain = false;
          }
        }

        if (!positionExistsOnChain) {
          const collateral = pos.sizeSui / agent.leverage;
          console.log(`[Execution] Position ${pos.id} NOT found on-chain — confirmed liquidated, recording loss of -${collateral.toFixed(4)} SUI`);
          await storage.updatePosition(pos.id, {
            status: "closed",
            markPrice: currentPrice,
            unrealizedPnl: -collateral,
            closedAt: new Date(),
          });
          await storage.updateAgent(agent.id, {
            totalPnl: (agent.totalPnl || 0) + (-collateral),
          });
          closedCount++;
          totalPnl += -collateral;
        } else {
          console.log(`[Execution] Position ${pos.id} still exists on-chain but close failed — will retry later`);
        }
      }
    }
  }

  return { closed: closedCount, failed: failedCount, totalPnl, returnedCollateral };
}

const PRICE_SANITY_MAX_DEVIATION = 0.50;

function isPriceSane(price: number): boolean {
  if (price <= 0) return false;

  const lastTick = getLastPrice();
  if (!lastTick || !lastTick.pyth) {
    console.log(`[PriceSanity] REJECTED: no fresh Pyth oracle price available — using stale/fallback data is unsafe for SL/TP`);
    return false;
  }

  const pythPrice = lastTick.pyth.price;
  if (pythPrice <= 0) return false;

  const deviation = Math.abs(price - pythPrice) / pythPrice;
  if (deviation > PRICE_SANITY_MAX_DEVIATION) {
    console.log(`[PriceSanity] REJECTED: blended=$${price.toFixed(4)} deviates ${(deviation * 100).toFixed(1)}% from pyth=$${pythPrice.toFixed(4)}`);
    return false;
  }

  return true;
}

export async function checkAndClosePositions(agent: Agent, currentPrice: number): Promise<void> {
  const freshAgent = await storage.getAgent(agent.id);
  if (!freshAgent) return;
  const agentConfig = freshAgent;

  const positions = await storage.getPositions(agent.id);
  const openPositions = positions.filter(p => p.status === "open");
  if (openPositions.length === 0) return;

  if (!isPriceSane(currentPrice)) {
    console.log(`[Execution] Skipping ALL SL/TP checks for ${agentConfig.name}: price $${currentPrice.toFixed(4)} failed sanity check — positions remain open`);
    return;
  }

  for (const pos of openPositions) {
    const pnlPercent = pos.side === "long"
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

    const slBps = agentConfig.stopLossBps || 80;
    const tpBps = agentConfig.takeProfitBps;

    const shouldStopLoss = pnlPercent <= -(slBps / 100);
    const shouldTakeProfit = tpBps != null && tpBps > 0 && pnlPercent >= tpBps / 100;

    if (shouldStopLoss || shouldTakeProfit) {
      const reason = shouldStopLoss ? "stop-loss" : "take-profit";
      console.log(`[Execution] Closing position for agent ${agentConfig.name} (${reason}): PnL=${pnlPercent.toFixed(2)}%, SL=${slBps}bps, TP=${tpBps ?? "off"}bps — REQUIRES on-chain confirmation`);
      const result = await closePositionForAgent(agentConfig, pos.id, currentPrice, false);
      if (!result.closed) {
        console.log(`[Execution] On-chain ${reason} close FAILED for ${agentConfig.name} position ${pos.id} — position remains open, will retry next tick`);
      }
      continue;
    }

    const rawUnrealizedPnl = pos.side === "long"
      ? (currentPrice - pos.entryPrice) * pos.sizeSui
      : (pos.entryPrice - currentPrice) * pos.sizeSui;
    const posCollateral = pos.sizeSui / agentConfig.leverage;
    await storage.updatePosition(pos.id, {
      markPrice: currentPrice,
      unrealizedPnl: Math.max(-posCollateral, rawUnrealizedPnl),
    });
  }
}
