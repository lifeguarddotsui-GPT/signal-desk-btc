import { storage } from "../storage";
import { getAdapter } from "./index";
import type { DexOrderParams, DexOrderResult } from "./types";
import type { Agent, AgentWithSignalAgent } from "../../shared/schema";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { ensureMinGasReserve, COLLATERAL_GAS_RESERVE_SUI, GAS_PER_CLOSE_SUI } from "./gas";
import { decryptKeypair } from "./wallet-manager";
import { TypusAdapter } from "./typus-adapter";
import { getLastPrice } from "../price-service";
import { createBundle, type Action, type RiskParams } from "../../shared/bundle";

const SUI_RPC = "https://fullnode.mainnet.sui.io:443";
const suiClient = new SuiJsonRpcClient({ url: SUI_RPC, network: "mainnet" });

const activeExecutions = new Set<string>();
const lastTradeMap = new Map<string, { direction: string; time: number }>();
const oracleMismatchCooldown = new Map<string, number>();
const dailyGasSpend = new Map<string, { totalMist: number; failedTxCount: number; resetAt: number }>();
const reconciliationInProgress = new Set<string>();
const positionCloseInProgress = new Set<string>();

const TRADE_COOLDOWN_MS = 30_000;
const ORACLE_MISMATCH_COOLDOWN_MS = 5_000;
const MAX_OPEN_POSITIONS_PER_AGENT = 5;
const MAX_COLLATERAL_LOSS_PCT = 25;
const EMERGENCY_COLLATERAL_LOSS_PCT = 35;
const MAX_CLOSE_RETRIES = 6;
const RETRY_DELAYS_MS = [100, 200, 300, 500, 800];
const SKIP_BUNDLE_COOLDOWN_MS = 300_000;
const lastSkipBundleTime = new Map<string, number>();
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

export function resetGasSpendTracking(agentId: string): void {
  dailyGasSpend.delete(agentId);
}

function scheduleReconciliation(agentId: string, agentName: string, walletAddress: string): void {
  if (reconciliationInProgress.has(agentId)) return;

  setTimeout(async () => {
    if (reconciliationInProgress.has(agentId)) return;
    reconciliationInProgress.add(agentId);
    try {
      const allPos = await storage.getPositions(agentId);
      const openPos = allPos.filter(p => p.status === "open");
      if (openPos.length > 0) return;

      const agentOpenCloses = allPos.filter(p => positionCloseInProgress.has(p.id));
      if (agentOpenCloses.length > 0) {
        console.log(`[BalanceSync] Reconciliation deferred for ${agentName}: ${agentOpenCloses.length} position close(s) still in progress`);
        reconciliationInProgress.delete(agentId);
        setTimeout(() => scheduleReconciliation(agentId, agentName, walletAddress), 2000);
        return;
      }

      const agentNow = await storage.getAgent(agentId);
      if (!agentNow) return;

      const { getOnChainBalance } = await import("../sui-verify");
      const onChainNow = await getOnChainBalance(walletAddress);
      const currentOnChainBalance = onChainNow.sui;

      const netDeposited = (agentNow.totalDeposited || 0) - (agentNow.protocolFeePaid || 0);
      const reconciledPnl = currentOnChainBalance - netDeposited;
      const currentTotalPnl = agentNow.totalPnl || 0;

      if (Math.abs(reconciledPnl - currentTotalPnl) > 0.5) {
        console.log(`[BalanceSync] PnL RECONCILIATION for ${agentName}: current totalPnl=${currentTotalPnl.toFixed(4)} vs on-chain-derived=${reconciledPnl.toFixed(4)} SUI (onChain=${currentOnChainBalance.toFixed(4)}, netDeposit=${netDeposited.toFixed(4)}). Using on-chain truth.`);

        await storage.updateAgent(agentId, {
          balance: currentOnChainBalance,
          totalPnl: reconciledPnl,
        });

        const closedPos = allPos.filter(p => p.status === "closed");
        const currentPnlSum = closedPos.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
        if (Math.abs(currentPnlSum - reconciledPnl) > 0.5 && closedPos.length > 0) {
          const adjustment = reconciledPnl - currentPnlSum;
          const totalCollateral = closedPos.reduce((s, p) => s + (p.sizeSui / (agentNow?.leverage || 32)), 0);
          for (const p of closedPos) {
            const posCollateral = p.sizeSui / (agentNow?.leverage || 32);
            const weight = totalCollateral > 0 ? posCollateral / totalCollateral : 1 / closedPos.length;
            const posAdj = adjustment * weight;
            const corrected = (p.unrealizedPnl || 0) + posAdj;
            await storage.updatePosition(p.id, { unrealizedPnl: corrected });
          }
          console.log(`[BalanceSync] Distributed PnL adjustment of ${adjustment.toFixed(4)} SUI across ${closedPos.length} closed positions (proportional to collateral)`);
        }
      }
    } catch (err: any) {
      console.log(`[BalanceSync] Reconciliation failed for ${agentName}: ${err.message}`);
    } finally {
      reconciliationInProgress.delete(agentId);
    }
  }, 500);
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
      const msg = `Gas check failed: ${gasCheck.reason}`;
      console.log(`[Execution] Skipping ${agent.name}: ${msg}`);
      await storage.updateAgent(agent.id, { lastExecutionError: msg, lastExecutionAt: new Date() });
      return { success: false, error: msg, venue: agent.venue };
    }
  } catch (gasErr: any) {
    console.log(`[Execution] Gas check failed for ${agent.name}: ${gasErr.message}`);
  }

  activeExecutions.add(agent.id);

  try {
    const keypairForBalance = decryptKeypair(agent.agentWallet);
    const walletAddrForBalance = keypairForBalance.toSuiAddress();
    let onChainBalance: number;
    let balanceFetchedFromChain = false;
    try {
      const balResp = await suiClient.getBalance({ owner: walletAddrForBalance, coinType: "0x2::sui::SUI" });
      onChainBalance = Number(balResp.totalBalance) / 1e9;
      balanceFetchedFromChain = true;
    } catch (balErr: any) {
      console.log(`[Execution] RPC balance fetch failed for ${agent.name}: ${balErr.message}. Skipping trade to prevent sizing errors.`);
      await storage.updateAgent(agent.id, { lastExecutionError: "RPC balance unavailable — retrying next cycle", lastExecutionAt: new Date() });
      return null;
    }

    const lockedCollateral = openPositions.reduce((sum, p) => sum + (p.sizeSui / agent.leverage), 0);
    const onChainTotal = onChainBalance + lockedCollateral;

    let effectiveBalance: number;
    if (Math.abs(agent.balance - onChainTotal) > 0.1) {
      console.log(`[Execution] Balance sync for ${agent.name}: DB=${agent.balance.toFixed(4)}, onChain=${onChainBalance.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, corrected=${onChainTotal.toFixed(4)}`);
      await storage.updateAgent(agent.id, { balance: onChainTotal });
      effectiveBalance = onChainTotal;
    } else {
      effectiveBalance = Math.min(agent.balance, onChainTotal);
    }

    const positionsAfterOpen = openPositions.length + 1;
    const dynamicGasReserve = COLLATERAL_GAS_RESERVE_SUI + (positionsAfterOpen * GAS_PER_CLOSE_SUI);
    console.log(`[Execution] Gas reserve for ${agent.name}: base=${COLLATERAL_GAS_RESERVE_SUI} + ${positionsAfterOpen} closes × ${GAS_PER_CLOSE_SUI} = ${dynamicGasReserve.toFixed(4)} SUI, free on-chain=${onChainBalance.toFixed(4)} SUI`);
    const SAFETY_MARGIN = 0.90;
    const freeForTrading = Math.max(0, onChainBalance - dynamicGasReserve);
    const availableForTrading = freeForTrading * SAFETY_MARGIN;
    const ABSOLUTE_MIN_COLLATERAL = 4.0;
    const minColl = Math.max(agent.minCollateral ?? ABSOLUTE_MIN_COLLATERAL, ABSOLUTE_MIN_COLLATERAL);
    const maxColl = agent.maxCollateral ?? agent.maxQty;
    const collateral = Math.min(maxColl, availableForTrading);
    const quantity = Math.floor(collateral * agent.leverage);

    if (collateral < minColl) {
      const msg = `Insufficient free balance for min ${minColl.toFixed(1)} SUI collateral: ${availableForTrading.toFixed(2)} SUI available (on-chain=${onChainBalance.toFixed(2)} SUI, gas reserve=${dynamicGasReserve.toFixed(2)} SUI)`;
      console.log(`[Execution] Skipping ${agent.name}: ${msg}`);
      await storage.updateAgent(agent.id, { lastExecutionError: msg, lastExecutionAt: new Date() });
      const lastSkip = lastSkipBundleTime.get(agent.id) || 0;
      if (Date.now() - lastSkip > SKIP_BUNDLE_COOLDOWN_MS) {
        lastSkipBundleTime.set(agent.id, Date.now());
        return { success: false, error: msg, venue: agent.venue };
      }
      return null;
    }

    if (quantity < 10) {
      const msg = `Insufficient balance for min trade (qty=${quantity.toFixed(2)} SUI < 10 SUI min, collateral=${collateral.toFixed(4)})`;
      console.log(`[Execution] Skipping ${agent.name}: ${msg}`);
      await storage.updateAgent(agent.id, { lastExecutionError: msg, lastExecutionAt: new Date() });
      const lastSkip = lastSkipBundleTime.get(agent.id) || 0;
      if (Date.now() - lastSkip > SKIP_BUNDLE_COOLDOWN_MS) {
        lastSkipBundleTime.set(agent.id, Date.now());
        return { success: false, error: msg, venue: agent.venue };
      }
      return null;
    }

    let effectiveSlBps = agent.stopLossBps;
    const slCollateralLossPct = (effectiveSlBps / 10000) * 100 * agent.leverage;
    if (slCollateralLossPct > MAX_COLLATERAL_LOSS_PCT) {
      const cappedSlBps = Math.floor((MAX_COLLATERAL_LOSS_PCT / (100 * agent.leverage)) * 10000);
      console.log(`[Execution] SL auto-tightened for ${agent.name}: ${effectiveSlBps}bps would lose ${slCollateralLossPct.toFixed(1)}% collateral at ${agent.leverage}x → capped to ${cappedSlBps}bps (${MAX_COLLATERAL_LOSS_PCT}% max collateral loss)`);
      effectiveSlBps = cappedSlBps;
    }

    const stopLossPrice = direction === "long"
      ? currentPrice * (1 - effectiveSlBps / 10000)
      : currentPrice * (1 + effectiveSlBps / 10000);

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
      openPositionCount: openPositions.length,
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

    const typusLiquidationPrice = direction === "long"
      ? currentPrice * (1 - 1 / agent.leverage)
      : currentPrice * (1 + 1 / agent.leverage);

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

    console.log(`[Execution] Position protection for ${agent.name}: effectiveSL=$${stopLossPrice.toFixed(4)} (${effectiveSlBps}bps), typusLiquidation=$${typusLiquidationPrice.toFixed(4)}, maxCollateralLoss=${MAX_COLLATERAL_LOSS_PCT}%, buffer=${Math.abs(((stopLossPrice - typusLiquidationPrice) / currentPrice) * 100).toFixed(2)}% price`);

    if (result.positionId) {
      await storage.updatePosition(position.id, { 
        onChainPositionId: result.positionId,
        verified: true 
      });
      console.log(`[Execution] Stored on-chain position ID: ${result.positionId} for DB position ${position.id}`);
    } else {
      await storage.updatePosition(position.id, { verified: true });
      console.log(`[Execution] WARNING: No on-chain positionId captured for ${agent.name} — close may fail`);
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

export async function closePositionForAgent(agent: Agent, positionId: string, currentPrice: number, allowDbFallback = false): Promise<{ closed: boolean; onChain: boolean; pnl: number; txDigest?: string; error?: string }> {
  const pos = (await storage.getPositions(agent.id)).find(p => p.id === positionId);
  if (!pos || pos.status !== "open") return { closed: false, onChain: false, pnl: 0 };

  const adapter = getAdapter(agent.venue);
  let onChainSuccess = false;
  let closeTxDigest: string | null = null;
  let closeError: string | null = null;
  let positionAlreadySettled = false;
  let preCloseOnChainBalance: number | null = null;

  if (adapter && agent.agentWallet) {
    try {
      const keypair = decryptKeypair(agent.agentWallet);
      const walletAddr = keypair.toSuiAddress();

      try {
        const balResp = await suiClient.getBalance({ owner: walletAddr, coinType: "0x2::sui::SUI" });
        preCloseOnChainBalance = Number(balResp.totalBalance) / 1e9;
      } catch {}

      const gasCheck = await ensureMinGasReserve(suiClient, walletAddr);
      if (!gasCheck.ok) {
        closeError = `INSUFFICIENT_GAS: ${gasCheck.reason}`;
        console.log(`[Execution] Close skipped for ${agent.name}: ${closeError}`);
        return { closed: false, onChain: false, pnl: 0, error: closeError };
      }
    } catch (gasErr: any) {
      closeError = `INSUFFICIENT_GAS: ${gasErr.message}`;
      console.log(`[Execution] Gas check failed for close ${agent.name}: ${gasErr.message}`);
      return { closed: false, onChain: false, pnl: 0, error: closeError };
    }

    const closeId = pos.onChainPositionId || pos.id;
    console.log(`[Execution] Closing position for ${agent.name}: dbId=${pos.id}, onChainId=${pos.onChainPositionId || "NONE"}, using=${closeId}`);
    try {
      const result = await adapter.closePosition({
        agent,
        positionId: closeId,
        side: pos.side as "long" | "short",
        quantity: pos.sizeSui,
        price: currentPrice,
      });

      if (result.success && result.txDigest && !result.txDigest.startsWith("sim_")) {
        onChainSuccess = true;
        closeTxDigest = result.txDigest;
        console.log(`[Execution] DEX close SUCCESS for ${agent.name}: tx=${result.txDigest}`);
      } else {
        closeError = result.error || "close failed — unknown reason";
        console.log(`[Execution] DEX close returned no valid txDigest for ${agent.name}: ${closeError}`);
      }
    } catch (err: any) {
      closeError = err.message || "close failed — unknown reason";
      console.log(`[Execution] DEX close failed for ${agent.name}: ${err.message}`);
    }
  }

  positionAlreadySettled = !!(closeError && (closeError.includes("key_not_found") || closeError.includes("keyed_big_vector")));

  if (positionAlreadySettled) {
    console.log(`[Execution] Position ${positionId} for ${agent.name} already settled on-chain (${closeError}). Closing in DB with on-chain-verified PnL.`);
    const adapterForReset = getAdapter(agent.venue);
    if (adapterForReset && 'resetCircuitBreaker' in adapterForReset) {
      (adapterForReset as any).resetCircuitBreaker(agent.id);
      console.log(`[Execution] Circuit breaker reset for ${agent.name} after settled position cleanup`);
    }
    resetGasSpendTracking(agent.id);
    console.log(`[Execution] Gas spend tracking reset for ${agent.name} after settled position cleanup — agent can resume trading`);
  }

  if (!onChainSuccess && !positionAlreadySettled) {
    if (allowDbFallback) {
      console.log(`[Execution] On-chain close failed for ${agent.name}, using DB fallback (allowDbFallback=true): ${closeError}`);
    } else {
      console.log(`[Execution] Close rejected for ${agent.name} position ${positionId} — on-chain close failed: ${closeError}`);
      return { closed: false, onChain: false, pnl: 0, error: closeError || "on-chain close failed — position may still be on DEX" };
    }
  }

  const collateral = pos.sizeSui / agent.leverage;
  let realizedPnl: number;
  const closeMethod = onChainSuccess ? "on-chain" : (positionAlreadySettled ? "liquidated" : "DB-fallback");

  if (positionAlreadySettled) {
    realizedPnl = -collateral;
    console.log(`[Execution] LIQUIDATED position for ${agent.name}: ${pos.side} size=${pos.sizeSui}, collateral=${collateral.toFixed(4)} SUI lost (Typus settled — full collateral loss). Post-close reconciliation will verify against on-chain.`);
  } else if (onChainSuccess) {
    realizedPnl = pos.side === "long"
      ? (currentPrice - pos.entryPrice) * pos.sizeSui / currentPrice
      : (pos.entryPrice - currentPrice) * pos.sizeSui / currentPrice;

    if (realizedPnl < -collateral) {
      console.log(`[Execution] Capping loss at collateral: raw PnL=${realizedPnl.toFixed(4)} SUI, collateral=${collateral.toFixed(4)} SUI`);
      realizedPnl = -collateral;
    }
  } else {
    realizedPnl = pos.side === "long"
      ? (currentPrice - pos.entryPrice) * pos.sizeSui / currentPrice
      : (pos.entryPrice - currentPrice) * pos.sizeSui / currentPrice;
    realizedPnl = Math.max(-collateral, realizedPnl);
  }

  console.log(`[Execution] PnL calculated (${closeMethod}): ${pos.side} entry=${pos.entryPrice}, close=${currentPrice}, size=${pos.sizeSui}, PnL=${realizedPnl.toFixed(4)} SUI`);

  const finalCloseTxDigest = closeTxDigest || (positionAlreadySettled ? "liquidated_onchain" : null);

  await storage.updatePosition(pos.id, {
    status: "closed",
    markPrice: currentPrice,
    unrealizedPnl: realizedPnl,
    closedAt: new Date(),
    closeTxDigest: finalCloseTxDigest,
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
  let finalBalance: number;

  if (!onChainSuccess && !positionAlreadySettled) {
    finalBalance = Math.max(0, currentBalance);
    if (agent.walletAddress) {
      try {
        const { getOnChainBalance } = await import("../sui-verify");
        const onChain = await getOnChainBalance(agent.walletAddress);
        const remainingOpenPositions = allPositions.filter(p => p.id !== pos.id && p.status === "open");
        const lockedCollateral = remainingOpenPositions.reduce((sum, p) => sum + p.sizeSui / agent.leverage, 0);
        const onChainTotal = onChain.sui + lockedCollateral;
        console.log(`[BalanceSync] DB-fallback close for ${agent.name}: on-chain=${onChain.sui.toFixed(4)} + locked=${lockedCollateral.toFixed(4)} (${remainingOpenPositions.length} open positions) = ${onChainTotal.toFixed(4)} SUI`);
        finalBalance = onChainTotal;
      } catch (syncErr: any) {
        console.log(`[BalanceSync] Failed to sync after DB-fallback close: ${syncErr.message}`);
      }
    }
    console.log(`[Execution] DB-fallback close for ${agent.name}: PnL NOT added to totalPnl (no on-chain settlement). Position marked closed in DB only.`);
  } else {
    if (agent.walletAddress) {
      try {
        const { getOnChainBalance } = await import("../sui-verify");
        const remainingOpenPositions = allPositions.filter(p => p.id !== pos.id && p.status === "open");
        const lockedCollateral = remainingOpenPositions.reduce((sum, p) => sum + p.sizeSui / agent.leverage, 0);
        const expectedReturn = collateral + realizedPnl;

        await new Promise(resolve => setTimeout(resolve, 1500));

        let onChain = await getOnChainBalance(agent.walletAddress);
        let onChainTotal = onChain.sui + lockedCollateral;

        const preCloseOnChain = currentBalance - lockedCollateral;
        if (onChainSuccess && expectedReturn > 0.5 && onChain.sui < preCloseOnChain + expectedReturn * 0.5) {
          console.log(`[BalanceSync] Waiting for settlement for ${agent.name}: expected ~${(preCloseOnChain + expectedReturn).toFixed(4)} SUI, got ${onChain.sui.toFixed(4)} — retrying in 3s...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          onChain = await getOnChainBalance(agent.walletAddress);
          onChainTotal = onChain.sui + lockedCollateral;
        }

        console.log(`[BalanceSync] After close for ${agent.name}: on-chain=${onChain.sui.toFixed(4)} + locked=${lockedCollateral.toFixed(4)} (${remainingOpenPositions.length} open positions) = ${onChainTotal.toFixed(4)} SUI`);
        finalBalance = onChainTotal;
      } catch (syncErr: any) {
        console.log(`[BalanceSync] Failed to sync after close: ${syncErr.message}, using fallback balance calculation`);
        finalBalance = Math.max(0, currentBalance + realizedPnl);
      }
    } else {
      finalBalance = Math.max(0, currentBalance + realizedPnl);
    }

    if (isWin && rewardSharePct > 0 && !positionAlreadySettled) {
      rewardAmount = realizedPnl * (rewardSharePct / 100);
      console.log(`[Execution] Profitable close: PnL=${realizedPnl.toFixed(4)}, reward=${rewardAmount.toFixed(4)}`);
    }
    if (positionAlreadySettled) {
      console.log(`[Execution] No reward for liquidated position — full collateral loss`);
    }
  }

  const pnlDelta = (onChainSuccess || positionAlreadySettled) ? realizedPnl : 0;

  await storage.atomicUpdateAgentAfterClose(agent.id, pnlDelta, finalBalance, newWinRate);

  if ((onChainSuccess || positionAlreadySettled) && agent.walletAddress) {
    scheduleReconciliation(agent.id, agent.name, agent.walletAddress);
  }

  if (rewardAmount > 0) {
    try {
      let escrowTxDigest: string | undefined;
      if (agent.agentWallet && agent.walletAddress) {
        try {
          const { escrowRewardFromAgent } = await import("../reward-wallet");
          const escrowResult = await escrowRewardFromAgent(agent.agentWallet, agent.walletAddress, rewardAmount);
          escrowTxDigest = escrowResult.txDigest;
        } catch (escrowErr: any) {
          console.log(`[Rewards] Escrow transfer failed for ${agent.name}: ${escrowErr.message} — reward still created but not escrowed`);
        }
      }
      const reward = await storage.createReward({
        agentId: agent.id,
        userId: agent.userId,
        amount: rewardAmount,
      });
      if (escrowTxDigest) {
        await storage.updateReward(reward.id, { escrowTxDigest });
      }
      console.log(`[Rewards] Created ${rewardAmount.toFixed(4)} SUI reward for ${agent.name} (${rewardSharePct}% of ${realizedPnl.toFixed(4)} profit)${escrowTxDigest ? ` — escrowed to reward wallet` : ""}`);
    } catch (err: any) {
      console.error(`[Rewards] Failed to create reward: ${err.message}`);
    }
  }

  const pnlPct = pos.side === "long"
    ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

  lastTradeMap.delete(agent.id);

  console.log(`[Execution] Position closed (${closeMethod}) for ${agent.name}: ${pos.side} ${pos.sizeSui.toFixed(4)} SUI, PnL=${realizedPnl.toFixed(4)} SUI (${pnlPct.toFixed(2)}%), balance=${finalBalance.toFixed(4)}, WinRate=${(newWinRate * 100).toFixed(0)}%`);

  return { closed: true, onChain: onChainSuccess, pnl: realizedPnl, txDigest: closeTxDigest || undefined };
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
      console.log(`[Execution] Failed to close position ${pos.id} on-chain for ${agent.name} (${pos.side} ${pos.sizeSui} SUI): ${result.error}`);
    }
  }

  return { closed: closedCount, failed: failedCount, totalPnl, returnedCollateral };
}

const lastCloseBundleEmit = new Map<string, number>();
const CLOSE_BUNDLE_THROTTLE_MS = 60_000;

const PRICE_SANITY_MAX_DEVIATION = 0.50;

function isPriceSane(price: number): boolean {
  if (price <= 0) return false;

  const lastTick = getLastPrice();
  if (!lastTick) {
    console.log(`[PriceSanity] REJECTED: no price tick available at all`);
    return false;
  }

  if (!lastTick.pyth) {
    const ageMs = Date.now() - lastTick.ts;
    if (ageMs > 60_000) {
      console.log(`[PriceSanity] REJECTED: no pyth data and tick is ${(ageMs / 1000).toFixed(0)}s old`);
      return false;
    }
    return true;
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
    console.log(`[TP/SL] Skipping checks for ${agentConfig.name}: price $${currentPrice.toFixed(4)} failed sanity`);
    return;
  }

  const slBps = agentConfig.stopLossBps || 80;
  const tpBps = agentConfig.takeProfitBps;
  const slThreshold = slBps / 100;
  const tpThreshold = tpBps ? tpBps / 100 : null;

  const leverageMultiplier = agentConfig.leverage || 1;
  const liquidationPricePct = (1 / leverageMultiplier) * 100;

  const slCollateralLossPct = slThreshold * leverageMultiplier;
  let effectiveSLThreshold = slThreshold;
  if (slCollateralLossPct > MAX_COLLATERAL_LOSS_PCT) {
    effectiveSLThreshold = MAX_COLLATERAL_LOSS_PCT / leverageMultiplier;
    console.log(`[TP/SL] SL auto-tightened for ${agentConfig.name}: configured SL=${slThreshold.toFixed(2)}% (${slCollateralLossPct.toFixed(1)}% collateral loss) exceeds ${MAX_COLLATERAL_LOSS_PCT}% cap → effective SL=${effectiveSLThreshold.toFixed(3)}% (${MAX_COLLATERAL_LOSS_PCT}% collateral loss) at ${leverageMultiplier}x leverage`);
  }

  const positionsToClose: Array<{ pos: any; reason: string; pnlPercent: number; collateralLossPct: number; priority: number }> = [];
  const positionsToUpdate: Array<{ pos: any; unrealizedPnl: number }> = [];

  for (const pos of openPositions) {
    const pnlPercent = pos.side === "long"
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

    const collateralLossPct = pnlPercent < 0 ? Math.abs(pnlPercent) * leverageMultiplier : 0;

    const shouldStopLoss = pnlPercent <= -effectiveSLThreshold;
    const shouldTakeProfit = tpThreshold !== null && pnlPercent >= tpThreshold;
    const maxCollateralBreached = collateralLossPct >= MAX_COLLATERAL_LOSS_PCT;
    const emergencyClose = collateralLossPct >= EMERGENCY_COLLATERAL_LOSS_PCT;

    if (shouldStopLoss || shouldTakeProfit || maxCollateralBreached || emergencyClose) {
      let reason: string;
      let priority: number;
      if (emergencyClose) {
        reason = "emergency-liquidation-prevent";
        priority = 0;
      } else if (maxCollateralBreached && !shouldStopLoss) {
        reason = "max-collateral-loss";
        priority = 1;
      } else if (shouldStopLoss) {
        reason = "stop-loss";
        priority = 2;
      } else {
        reason = "take-profit";
        priority = 3;
      }

      positionsToClose.push({ pos, reason, pnlPercent, collateralLossPct, priority });
    } else {
      const rawUnrealizedPnl = pos.side === "long"
        ? (currentPrice - pos.entryPrice) * pos.sizeSui / currentPrice
        : (pos.entryPrice - currentPrice) * pos.sizeSui / currentPrice;
      const posCollateral = pos.sizeSui / agentConfig.leverage;
      positionsToUpdate.push({ pos, unrealizedPnl: Math.max(-posCollateral, rawUnrealizedPnl) });
    }
  }

  const updatePromises = positionsToUpdate.map(({ pos, unrealizedPnl }) =>
    storage.updatePosition(pos.id, { markPrice: currentPrice, unrealizedPnl }).catch(() => {})
  );
  if (updatePromises.length > 0) {
    await Promise.allSettled(updatePromises);
  }

  if (positionsToClose.length === 0) return;

  positionsToClose.sort((a, b) => a.priority - b.priority);

  for (const { pos, reason, pnlPercent, collateralLossPct } of positionsToClose) {
    if (positionCloseInProgress.has(pos.id)) {
      continue;
    }
    positionCloseInProgress.add(pos.id);

    (async () => {
      try {
        console.log(`[TP/SL] TRIGGERING ${reason} for ${agentConfig.name}: ${pos.side} ${pos.sizeSui.toFixed(2)} SUI @ entry=$${pos.entryPrice.toFixed(4)}, mark=$${currentPrice.toFixed(4)}, PnL=${pnlPercent.toFixed(3)}% (collateral loss ${collateralLossPct.toFixed(1)}%), effectiveSL=${effectiveSLThreshold.toFixed(3)}%, lev=${leverageMultiplier}x, liq@=${liquidationPricePct.toFixed(1)}%, maxCollLoss=${MAX_COLLATERAL_LOSS_PCT}%, onChainId=${pos.onChainPositionId || "NONE"}`);

        let result = await closePositionForAgent(agentConfig, pos.id, currentPrice, false);

        for (let retry = 0; retry < MAX_CLOSE_RETRIES - 1 && !result.closed; retry++) {
          const delay = RETRY_DELAYS_MS[retry] || 800;
          console.log(`[TP/SL] ${reason} attempt ${retry + 1} FAILED for ${agentConfig.name} pos ${pos.id} — retrying in ${delay}ms (${retry + 2}/${MAX_CLOSE_RETRIES})...`);
          await new Promise(r => setTimeout(r, delay));

          const freshPrice = getLastPrice();
          const retryPrice = freshPrice?.blended || currentPrice;
          result = await closePositionForAgent(agentConfig, pos.id, retryPrice, false);
        }

        if (!result.closed) {
          console.log(`[TP/SL] ${reason} close FAILED for ${agentConfig.name} pos ${pos.id} after ${MAX_CLOSE_RETRIES} attempts — will retry next tick. Error: ${result.error}`);
          await storage.updateAgent(agent.id, {
            lastExecutionError: `${reason.toUpperCase()} CLOSE FAILED after ${MAX_CLOSE_RETRIES} attempts: ${result.error || "on-chain close rejected"} — retrying every tick`,
            lastExecutionAt: new Date(),
          });
        } else {
          console.log(`[TP/SL] ${reason} close SUCCESS for ${agentConfig.name}: PnL=${result.pnl.toFixed(4)} SUI, onChain=${result.onChain}, tx=${result.txDigest || "none"}`);
          await storage.updateAgent(agent.id, {
            lastExecutionError: null,
            lastExecutionAt: new Date(),
          });
        }

        const bundleKey = `${agent.id}:${pos.id}`;
        const lastEmit = lastCloseBundleEmit.get(bundleKey) || 0;
        const now = Date.now();
        if (result.closed || now - lastEmit > CLOSE_BUNDLE_THROTTLE_MS) {
          lastCloseBundleEmit.set(bundleKey, now);
          if (result.closed) lastCloseBundleEmit.delete(bundleKey);
          try {
            await emitCloseBundleForTPSL(agentConfig, pos, reason, currentPrice, result);
          } catch (bundleErr: any) {
            console.error(`[Bundle] Close bundle emit error: ${bundleErr.message}`);
          }
        }
      } catch (err: any) {
        console.error(`[TP/SL] Unhandled error closing ${reason} for ${agentConfig.name} pos ${pos.id}: ${err.message}`);
      } finally {
        positionCloseInProgress.delete(pos.id);
      }
    })();
  }
}

async function emitCloseBundleForTPSL(
  agent: Agent,
  pos: any,
  reason: string,
  currentPrice: number,
  result: { closed: boolean; onChain: boolean; pnl: number; txDigest?: string; error?: string }
): Promise<void> {
  const venue = "TYPUS_PERPS";
  const notionalUsd = pos.sizeSui * currentPrice;

  const actions: Action[] = [
    {
      type: "CLOSE",
      venue: venue as any,
      market: "SUI-USDC",
      pct: 1,
    },
  ];

  const risk: RiskParams = {
    maxNotionalUsd: pos.sizeSui * currentPrice,
    maxLeverage: agent.leverage,
    maxDailyLossUsd: agent.balance * currentPrice * 0.1,
  };

  const user = agent.walletAddress || agent.agentWallet || "";

  const bundle = createBundle({
    agentId: agent.id,
    user,
    actions,
    risk,
  });

  const isVerified = result.closed && result.onChain && result.txDigest && !result.txDigest.startsWith("sim_");
  const bundleStatus = isVerified ? "recorded" : "rejected";

  await storage.createInstructionBundle({
    bundleId: bundle.bundleId,
    agentId: agent.id,
    userAddress: user,
    vaultId: bundle.vaultId || null,
    tradeCapId: bundle.tradeCapId || null,
    actions: bundle.actions as any,
    risk: bundle.risk as any,
    expiresAtMs: bundle.expiresAtMs,
    signature: null,
    status: bundleStatus,
  });

  await storage.createBundleExecution({
    bundleId: bundle.bundleId,
    agentId: agent.id,
    status: bundleStatus,
    txDigest: isVerified ? result.txDigest! : null,
    venue: venue as string,
    actionsExecuted: isVerified ? 1 : 0,
    actionsFailed: isVerified ? 0 : 1,
    error: result.closed ? null : (result.error || `${reason} close failed — on-chain transaction rejected`),
  });
}
