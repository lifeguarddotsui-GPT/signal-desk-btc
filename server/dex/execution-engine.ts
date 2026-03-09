import { storage } from "../storage";
import { getAdapter } from "./index";
import type { DexOrderParams, DexOrderResult } from "./types";
import type { Agent, AgentWithSignalAgent } from "../../shared/schema";
import { ensureMinGasReserve, COLLATERAL_GAS_RESERVE_SUI, GAS_PER_CLOSE_SUI, MIN_EXECUTABLE_GAS_SUI, isRateLimitError, buildMergeAllSuiCoinsTx, MAX_COLLATERAL_UTILIZATION, MIN_FREE_SUI_FLOOR, LOW_BALANCE_REWARD_SKIP_THRESHOLD } from "./gas";
import { decryptKeypair } from "./wallet-manager";
import { TypusAdapter } from "./typus-adapter";
import { getLastPrice } from "../price-service";
import { getMultiTFCandles } from "../market-engine";
import { createBundle, type Action, type RiskParams } from "../../shared/bundle";
import type { TradeSignal } from "../signal-engine";
import { MODE_PROFILES } from "../signal-engine";
import { adx as adxLast, atr as atrLast } from "../../shared/indicators";
import { logCloseOutcome, getEntryFeedback, getRecentAgentPerformance, logCloseFailure, logCloseSuccess, getPositionClosePreEmptiveActions, getAgentCompetitiveScore, getCapitalPlan, type CapitalPlan } from "../learning-engine";
import { getThrottledSuiClient } from "../rpc-throttle";

const suiClient = getThrottledSuiClient();

const activeExecutions = new Set<string>();
const lastTradeMap = new Map<string, { direction: string; time: number }>();
const oracleMismatchCooldown = new Map<string, number>();
const dailyGasSpend = new Map<string, { totalMist: number; failedTxCount: number; resetAt: number }>();
const reconciliationInProgress = new Set<string>();
const positionCloseInProgress = new Map<string, number>();
const positionCloseCooldown = new Map<string, number>();
const pendingCloseOrders = new Map<string, { orderId?: string; txDigest?: string; setAt: number }>();
const positionReopenCounts = new Map<string, number>();
const CLOSE_COOLDOWN_MS = 3_000;
const EMERGENCY_CLOSE_COOLDOWN_MS = 800;
const PENDING_CLOSE_MAX_AGE_MS = 20_000;
const CLOSE_PENDING_TTL_MS = 8_000;
const MIN_CLOSE_RETRY_GAP_MS = 1_500;
const MAX_CLOSE_ATTEMPTS_TOTAL = 12;
const CLOSE_IN_PROGRESS_TIMEOUT_MS = 15_000;
const EMERGENCY_FORCE_SETTLE_TIMEOUT_MS = 45_000;
const emergencyDetectedAt = new Map<string, number>();
const EMERGENCY_CLOSE_GAS_BUFFER_SUI = 0.003;

const positionCloseGasSpend = new Map<string, { totalMist: number; attempts: number; firstAttemptAt: number }>();
const MAX_CLOSE_GAS_PER_POSITION_SUI = 0.25;
const MAX_CLOSE_ATTEMPTS_PER_POSITION = 12;

const HARD_GAS_FLOOR_SUI = 0.03;
const LOW_GAS_THRESHOLD_SUI = 0.5;
const LOW_GAS_MAX_RETRIES = 1;
const agentLastTopoffResumeAt = new Map<string, number>();
const TOPOFF_RECOVERY_COOLDOWN_MS = 60_000;

const agentSessionGasBudget = new Map<string, { initialBalance: number; spent: number; startedAt: number }>();

const ABSOLUTE_SESSION_GAS_CAP_SUI = 5.0;
const GAS_TO_DEPOSIT_RATIO_CAP = 0.50;
const GAS_CAP_CHECK_INTERVAL_MS = 30_000;
const SESSION_RESET_INTERVAL_MS = 6 * 60 * 60 * 1000;
const GAS_PER_OPERATION_ESTIMATE = 0.025;
const agentLastGasCapCheck = new Map<string, number>();

export type GasThrottleLevel = "normal" | "conserving" | "closes_only" | "emergency_only" | "paused";

export interface GasCapStatus {
  breached: boolean;
  throttleLevel: GasThrottleLevel;
  sessionGasUsed: number;
  absoluteCap: number;
  depositRatioCap: number;
  effectiveCap: number;
  utilizationPct: number;
  reason?: string;
  sessionAgeMs: number;
}

function maybeResetSession(agentId: string): void {
  const session = agentSessionGasBudget.get(agentId);
  if (!session) return;
  const age = Date.now() - session.startedAt;
  if (age >= SESSION_RESET_INTERVAL_MS) {
    console.log(`[GasCap] Session reset for agent ${agentId.slice(0, 8)}: was ${session.spent.toFixed(4)} SUI over ${(age / 3600000).toFixed(1)}h — resetting to 0`);
    session.spent = 0;
    session.startedAt = Date.now();
  }
}

export function getGasCapStatus(agentId: string, totalDeposited: number): GasCapStatus {
  maybeResetSession(agentId);

  const session = agentSessionGasBudget.get(agentId);
  const sessionGasUsed = session?.spent || 0;
  const sessionAgeMs = session ? Date.now() - session.startedAt : 0;
  const depositRatioCap = totalDeposited > 0 ? totalDeposited * GAS_TO_DEPOSIT_RATIO_CAP : ABSOLUTE_SESSION_GAS_CAP_SUI;
  const effectiveCap = Math.min(ABSOLUTE_SESSION_GAS_CAP_SUI, depositRatioCap);
  const utilizationPct = effectiveCap > 0 ? (sessionGasUsed / effectiveCap) * 100 : 0;

  let breached = false;
  let reason: string | undefined;
  let throttleLevel: GasThrottleLevel = "normal";

  if (sessionGasUsed >= effectiveCap) {
    breached = true;
    throttleLevel = "paused";
    reason = `GAS_BUDGET_EXHAUSTED: Spent ${sessionGasUsed.toFixed(3)} SUI — budget limit reached (${effectiveCap.toFixed(3)} SUI cap). Will auto-reset in ${Math.max(0, Math.ceil((SESSION_RESET_INTERVAL_MS - sessionAgeMs) / 3600000))}h.`;
  } else if (utilizationPct >= 90) {
    throttleLevel = "emergency_only";
    reason = `Gas at ${utilizationPct.toFixed(0)}% — emergency closes only`;
  } else if (utilizationPct >= 75) {
    throttleLevel = "closes_only";
    reason = `Gas at ${utilizationPct.toFixed(0)}% — closes only, no new positions`;
  } else if (utilizationPct >= 60) {
    throttleLevel = "conserving";
    reason = `Gas at ${utilizationPct.toFixed(0)}% — conserving, high-quality signals only`;
  }

  return { breached, throttleLevel, sessionGasUsed, absoluteCap: ABSOLUTE_SESSION_GAS_CAP_SUI, depositRatioCap, effectiveCap, utilizationPct, reason, sessionAgeMs };
}

export function getThrottleLevel(agentId: string, totalDeposited: number): GasThrottleLevel {
  return getGasCapStatus(agentId, totalDeposited).throttleLevel;
}

async function checkAndEnforceGasCap(agent: Agent): Promise<boolean> {
  const now = Date.now();
  const lastCheck = agentLastGasCapCheck.get(agent.id) || 0;
  if (now - lastCheck < GAS_CAP_CHECK_INTERVAL_MS) return false;
  agentLastGasCapCheck.set(agent.id, now);

  const status = getGasCapStatus(agent.id, agent.totalDeposited || 0);

  if (status.throttleLevel !== "normal" && status.throttleLevel !== "paused") {
    storage.updateAgent(agent.id, {
      gasThrottleLevel: status.throttleLevel,
      lastExecutionError: status.reason || null,
      lastExecutionAt: new Date(),
    }).catch(() => {});
  }

  if (!status.breached) return false;

  const estimatedResumeAt = new Date(Date.now() + Math.max(0, SESSION_RESET_INTERVAL_MS - status.sessionAgeMs));

  console.log(`[GasCap] ${agent.name}: GAS CAP BREACHED — ${status.reason}. Pausing agent. Auto-resume estimated at ${estimatedResumeAt.toISOString()}`);

  await storage.updateAgent(agent.id, {
    status: "paused",
    gasCapBreached: true,
    gasCapBreachedAt: new Date(),
    gasCapReason: status.reason || "Gas cap exceeded",
    sessionGasUsed: status.sessionGasUsed,
    lastExecutionError: `GAS_BUDGET_EXHAUSTED: ${status.reason}`,
    lastExecutionAt: new Date(),
    pausedBy: "system",
    pausedReason: status.reason || "Gas budget exhausted",
    estimatedResumeAt,
    gasThrottleLevel: "paused",
  });

  return true;
}

function trackSessionGasSpend(agentId: string, gasSui: number): void {
  let session = agentSessionGasBudget.get(agentId);
  if (!session) {
    session = { initialBalance: gasSui * 20, spent: 0, startedAt: Date.now() };
    agentSessionGasBudget.set(agentId, session);
  }
  session.spent += gasSui;
}

async function trackActualGasFromTx(agentId: string, txDigest: string): Promise<void> {
  try {
    const suiClient = getThrottledSuiClient();
    const txResult = await suiClient.getTransactionBlock({
      digest: txDigest,
      options: { showEffects: true },
    });
    const gasUsed = txResult.effects?.gasUsed;
    if (gasUsed) {
      const totalGasMist =
        Number(gasUsed.computationCost || 0) +
        Number(gasUsed.storageCost || 0) -
        Number(gasUsed.storageRebate || 0);
      const actualGasSui = Math.max(0, totalGasMist / 1e9);
      if (actualGasSui > 0 && actualGasSui < 1.0) {
        const session = agentSessionGasBudget.get(agentId);
        if (session) {
          const overshoot = actualGasSui - GAS_PER_OPERATION_ESTIMATE;
          if (overshoot > 0.001) {
            session.spent += overshoot;
          }
        }
      }
    }
  } catch {}
}

const lastGasDbPersist = new Map<string, number>();
const GAS_DB_PERSIST_INTERVAL_MS = 10_000;

function persistSessionGasToDb(agentId: string): void {
  const now = Date.now();
  const lastPersist = lastGasDbPersist.get(agentId) || 0;
  if (now - lastPersist < GAS_DB_PERSIST_INTERVAL_MS) return;
  lastGasDbPersist.set(agentId, now);

  const session = agentSessionGasBudget.get(agentId);
  if (!session) return;

  storage.updateAgent(agentId, { sessionGasUsed: session.spent }).catch(() => {});
}

export function initSessionGasFromDb(agentId: string, sessionGasUsed: number, balance: number): void {
  if (!agentSessionGasBudget.has(agentId) && sessionGasUsed > 0) {
    agentSessionGasBudget.set(agentId, {
      initialBalance: balance + sessionGasUsed,
      spent: sessionGasUsed,
      startedAt: Date.now(),
    });
  }
}

const positionCloseBackoff = new Map<string, { failCount: number; nextAttemptAt: number }>();
const CLOSE_BACKOFF_SCHEDULE_MS = [60_000, 120_000, 300_000, 600_000];

const agentLastCloseTick = new Map<string, number>();
const LOW_GAS_TICK_INTERVAL_MS = 30_000;

const manualCloseInProgress = new Set<string>();
const rewardCreationInProgress = new Set<string>();

const agentOnChainPosCache = new Map<string, { positions: any[]; timestamp: number }>();
const AGENT_ONCHAIN_POS_CACHE_TTL = 5_000;

const peakPnlTracker = new Map<string, { peakPnlPct: number; breakEvenLocked: boolean; trailingSLPct: number }>();
const TRAILING_ACTIVATION_PCT = 0.25;
const TRAILING_DISTANCE_PCT = 0.20;
const BREAKEVEN_ACTIVATION_PCT = 0.12;
const POSITION_AGE_TIGHTEN_MS = 3 * 60 * 1000;
const POSITION_AGE_TIGHTEN_FACTOR = 0.70;

function trackCloseGasSpend(positionId: string, gasMist: number = 50_000_000): { exceeded: boolean; reason?: string } {
  let record = positionCloseGasSpend.get(positionId);
  if (!record) {
    record = { totalMist: 0, attempts: 0, firstAttemptAt: Date.now() };
  }
  record.totalMist += gasMist;
  record.attempts += 1;
  positionCloseGasSpend.set(positionId, record);

  const totalSui = record.totalMist / 1e9;
  if (totalSui >= MAX_CLOSE_GAS_PER_POSITION_SUI) {
    return { exceeded: true, reason: `CLOSE_GAS_CAP: Total gas spent on closing position ${positionId} (${totalSui.toFixed(4)} SUI across ${record.attempts} attempts) exceeds cap (${MAX_CLOSE_GAS_PER_POSITION_SUI} SUI). Force-settling from on-chain state.` };
  }
  if (record.attempts >= MAX_CLOSE_ATTEMPTS_PER_POSITION) {
    return { exceeded: true, reason: `CLOSE_ATTEMPT_CAP: ${record.attempts} close attempts for position ${positionId} (${totalSui.toFixed(4)} SUI gas) exceeds limit (${MAX_CLOSE_ATTEMPTS_PER_POSITION}). Force-settling from on-chain state.` };
  }
  return { exceeded: false };
}

function clearCloseGasTracking(positionId: string): void {
  positionCloseGasSpend.delete(positionId);
  peakPnlTracker.delete(positionId);
}

export function registerTopoffResume(agentId: string, walletBalance?: number): void {
  agentLastTopoffResumeAt.set(agentId, Date.now());
  agentLastGasCapCheck.delete(agentId);
  if (walletBalance && walletBalance > 0) {
    agentSessionGasBudget.set(agentId, { initialBalance: walletBalance, spent: 0, startedAt: Date.now() });
  }
  agentLastCloseTick.delete(agentId);
  storage.updateAgent(agentId, {
    gasCapBreached: false,
    gasCapBreachedAt: null,
    gasCapReason: null,
    sessionGasUsed: 0,
    pausedBy: null,
    pausedReason: null,
    estimatedResumeAt: null,
    gasThrottleLevel: null,
  }).catch(() => {});
  storage.getOpenPositions(agentId).then(positions => {
    for (const p of positions) {
      positionCloseBackoff.delete(p.id);
    }
  }).catch(() => {});
}

export function clearCloseGasTrackingExternal(positionId: string): void {
  positionCloseGasSpend.delete(positionId);
  peakPnlTracker.delete(positionId);
}

function getCloseGasSpent(positionId: string): { totalSui: number; attempts: number } {
  const record = positionCloseGasSpend.get(positionId);
  if (!record) return { totalSui: 0, attempts: 0 };
  return { totalSui: record.totalMist / 1e9, attempts: record.attempts };
}

async function getCloseState(pos: any): Promise<{ closeState: string; closeAttempts: number; lastCloseTx: string | null; closePendingSince: Date | null }> {
  return {
    closeState: pos.closeState || "open",
    closeAttempts: pos.closeAttempts || 0,
    lastCloseTx: pos.lastCloseTx || null,
    closePendingSince: pos.closePendingSince || null,
  };
}

export async function updateCloseState(posId: string, updates: { closeState?: string; closeAttempts?: number; lastCloseTx?: string | null; closePendingSince?: Date | null }): Promise<void> {
  await storage.updatePosition(posId, updates);
}

function isClosePending(cs: { closeState: string; closePendingSince: Date | null }): boolean {
  if (cs.closeState !== "close_order_working" && cs.closeState !== "close_tx_submitted") return false;
  if (!cs.closePendingSince) return false;
  const pendingAge = Date.now() - new Date(cs.closePendingSince).getTime();
  return pendingAge < CLOSE_PENDING_TTL_MS;
}

function closePendingAge(cs: { closePendingSince: Date | null }): number {
  if (!cs.closePendingSince) return 0;
  return Date.now() - new Date(cs.closePendingSince).getTime();
}

interface PendingUnfilledOrder {
  agentId: string;
  agentName: string;
  agentWallet: any;
  orderId: string;
  txDigest: string;
  price: number;
  direction: string;
  quantity: number;
  leverage: number;
  stopLossPrice: number;
  takeProfitPrice?: number;
  submittedAt: number;
  cancelAttempts: number;
}
const pendingUnfilledOrders = new Map<string, PendingUnfilledOrder>();
const UNFILLED_ORDER_CANCEL_INTERVAL_MS = 45_000;
const UNFILLED_ORDER_MAX_AGE_MS = 600_000;
const UNFILLED_ORDER_MAX_CANCEL_ATTEMPTS = 10;

interface PendingPositionResolution {
  dbPositionId: string;
  agentId: string;
  agentName: string;
  walletAddress: string;
  orderId: string;
  createdAt: number;
  attempts: number;
}
const pendingPositionResolutions = new Map<string, PendingPositionResolution>();
const POSITION_RESOLUTION_MAX_ATTEMPTS = 20;
const POSITION_RESOLUTION_INTERVAL_MS = 15_000;

interface PendingDigestReconciliation {
  dbPositionId: string;
  agentId: string;
  agentName: string;
  walletAddress: string;
  txDigest: string;
  createdAt: number;
  attempts: number;
}
const pendingDigestReconciliations = new Map<string, PendingDigestReconciliation>();
const DIGEST_RECONCILIATION_MAX_ATTEMPTS = 10;

function trackPendingPositionResolution(dbPositionId: string, agentId: string, agentName: string, walletAddress: string, orderId: string) {
  pendingPositionResolutions.set(dbPositionId, {
    dbPositionId,
    agentId,
    agentName,
    walletAddress,
    orderId,
    createdAt: Date.now(),
    attempts: 0,
  });
  console.log(`[PositionResolver] Tracking position ${dbPositionId} for on-chain ID resolution (order_id=${orderId}, agent=${agentName})`);
}

function trackPendingDigestReconciliation(dbPositionId: string, agentId: string, agentName: string, walletAddress: string, txDigest: string) {
  pendingDigestReconciliations.set(dbPositionId, {
    dbPositionId,
    agentId,
    agentName,
    walletAddress,
    txDigest,
    createdAt: Date.now(),
    attempts: 0,
  });
  console.log(`[DigestReconciler] Tracking position ${dbPositionId} for TX digest reconciliation (digest=${txDigest}, agent=${agentName})`);
}

async function reconcileFromDigest(txDigest: string): Promise<{ positionId?: string; orderId?: string }> {
  const tx = await suiClient.getTransactionBlock({
    digest: txDigest,
    options: { showEvents: true, showObjectChanges: true, showEffects: true },
  });

  let positionId: string | undefined;
  let orderId: string | undefined;

  const changes = (tx as any).objectChanges ?? [];
  for (const ch of changes) {
    if (ch.type === "created" && typeof ch.objectType === "string") {
      if (ch.objectType.includes("::position::Position") || ch.objectType.includes("::trading::Position")) {
        positionId = ch.objectId;
      }
    }
  }

  for (const evt of (tx as any).events ?? []) {
    const evtType = (evt as any).type || "";
    const parsed = (evt as any).parsedJson;
    if (!parsed) continue;

    if (evtType.includes("CreateTradingOrderEvent") && parsed.order_id !== undefined) {
      orderId = orderId ?? String(parsed.order_id);
      if (parsed.linked_position_id) {
        positionId = positionId ?? String(parsed.linked_position_id);
      }
    }
    if (evtType.includes("OrderFilledEvent") && parsed.new_position_id !== undefined) {
      positionId = positionId ?? String(parsed.new_position_id);
    }
    if ((evtType.includes("FillTradingOrderEvent") || evtType.includes("PositionChangeEvent")) && parsed.position_id) {
      positionId = positionId ?? String(parsed.position_id);
    }
  }

  return { positionId, orderId };
}

async function processPendingDigestReconciliations() {
  if (pendingDigestReconciliations.size === 0) return;

  for (const [key, pending] of Array.from(pendingDigestReconciliations.entries())) {
    pending.attempts++;

    try {
      const result = await reconcileFromDigest(pending.txDigest);

      if (result.positionId) {
        console.log(`[DigestReconciler] Resolved position_id=${result.positionId} from digest ${pending.txDigest} for ${pending.agentName} (attempt ${pending.attempts})`);
        const updates: any = { onChainPositionId: result.positionId, status: "open", verified: true };
        if (result.orderId) updates.typusOrderId = result.orderId;
        await storage.updatePosition(pending.dbPositionId, updates);
        pendingDigestReconciliations.delete(key);
        pendingPositionResolutions.delete(key);
        continue;
      }

      if (result.orderId) {
        console.log(`[DigestReconciler] Found order_id=${result.orderId} from digest (no position_id yet) for ${pending.agentName}`);
        await storage.updatePosition(pending.dbPositionId, { typusOrderId: result.orderId });
        if (!pendingPositionResolutions.has(pending.dbPositionId)) {
          trackPendingPositionResolution(pending.dbPositionId, pending.agentId, pending.agentName, pending.walletAddress, result.orderId);
        }
      }
    } catch (err: any) {
      console.log(`[DigestReconciler] Attempt ${pending.attempts} failed for ${pending.agentName}: ${err.message}`);
    }

    if (pending.attempts >= DIGEST_RECONCILIATION_MAX_ATTEMPTS) {
      console.log(`[DigestReconciler] Exhausted ${DIGEST_RECONCILIATION_MAX_ATTEMPTS} attempts for ${pending.agentName} digest=${pending.txDigest}`);
      pendingDigestReconciliations.delete(key);
    }
  }
}

async function processPendingPositionResolutions() {
  if (pendingPositionResolutions.size === 0) return;

  for (const [key, pending] of Array.from(pendingPositionResolutions.entries())) {
    pending.attempts++;

    try {
      const positionId = await TypusAdapter.resolvePositionIdFromOrderId(suiClient, pending.walletAddress, pending.orderId);
      if (positionId) {
        console.log(`[PositionResolver] Resolved on-chain position ID for ${pending.agentName}: order_id=${pending.orderId} → position_id=${positionId} (attempt ${pending.attempts})`);
        await storage.updatePosition(pending.dbPositionId, { onChainPositionId: positionId, status: "open", verified: true });
        pendingPositionResolutions.delete(key);
        continue;
      }
    } catch (err: any) {
      console.log(`[PositionResolver] Resolution attempt ${pending.attempts} failed for ${pending.agentName}: ${err.message}`);
    }

    if (pending.attempts >= POSITION_RESOLUTION_MAX_ATTEMPTS) {
      try {
        const adapter = getAdapter("typus");
        const agent = await storage.getAgent(pending.agentId);
        if (adapter && agent?.walletAddress) {
          const openOnChain = await adapter.getPositions(agent.walletAddress);
          const dbPos = (await storage.getPositions(pending.agentId)).find(p => p.id === pending.dbPositionId);
          if (dbPos && openOnChain.length > 0) {
            const match = openOnChain.find((op: any) => op.side === dbPos.side && Math.abs(op.size - dbPos.sizeSui) < 1);
            if (match && match.positionId) {
              console.log(`[PositionResolver] MATCHED on-chain position for ${pending.agentName} by side/size: ${match.positionId}`);
              await storage.updatePosition(pending.dbPositionId, { onChainPositionId: match.positionId, status: "open", verified: true });
              pendingPositionResolutions.delete(key);
              continue;
            }
          }
        }
      } catch (matchErr: any) {
        console.log(`[PositionResolver] Direct position match failed for ${pending.agentName}: ${matchErr.message}`);
      }
      console.log(`[PositionResolver] Exhausted ${POSITION_RESOLUTION_MAX_ATTEMPTS} attempts for ${pending.agentName} order_id=${pending.orderId}. Marking position as ERROR.`);
      await storage.updatePosition(pending.dbPositionId, { status: "error" });
      await storage.updateAgent(pending.agentId, {
        lastExecutionError: `Position ${pending.dbPositionId} has no on-chain ID after ${pending.attempts} resolution attempts. Use Verify & Recover to fix.`,
      });
      pendingPositionResolutions.delete(key);
    }
  }
}

function trackPendingUnfilledOrder(
  agent: AgentWithSignalAgent,
  orderId: string,
  txDigest: string,
  price: number,
  direction: string,
  quantity: number,
  stopLossPrice: number,
  takeProfitPrice?: number,
) {
  const key = `${agent.id}:${orderId}`;
  pendingUnfilledOrders.set(key, {
    agentId: agent.id,
    agentName: agent.name,
    agentWallet: agent.agentWallet,
    orderId,
    txDigest,
    price,
    direction,
    quantity,
    leverage: agent.leverage || 25,
    stopLossPrice,
    takeProfitPrice,
    submittedAt: Date.now(),
    cancelAttempts: 0,
  });
  console.log(`[UnfilledOrders] Tracking pending order ${orderId} for agent ${agent.name}`);
}

async function processPendingUnfilledOrders() {
  if (pendingUnfilledOrders.size === 0) return;

  for (const [key, pending] of Array.from(pendingUnfilledOrders.entries())) {
    const age = Date.now() - pending.submittedAt;

    const adapter = getAdapter("typus");
    if (!(adapter instanceof TypusAdapter) || !adapter.isReady()) continue;

    const walletAddr = decryptKeypair(pending.agentWallet).toSuiAddress();
    const fillResult = await TypusAdapter.resolvePositionIdFromOrderId(suiClient, walletAddr, pending.orderId);
    if (fillResult) {
      console.log(`[UnfilledOrders] Order ${pending.orderId} for ${pending.agentName} was FILLED (position_id=${fillResult}). Creating position in DB and locking collateral.`);
      try {
        const agent = await storage.getAgent(pending.agentId);
        if (agent) {
          const collateral = pending.quantity / (agent.leverage || 25);
          const typusLiquidationPrice = pending.direction === "long"
            ? pending.price * (1 - 1 / (agent.leverage || 25))
            : pending.price * (1 + 1 / (agent.leverage || 25));

          const position = await storage.createPosition({
            agentId: pending.agentId,
            symbol: "SUI-USDC",
            side: pending.direction,
            sizeSui: pending.quantity,
            collateral,
            entryPrice: pending.price,
            markPrice: pending.price,
            unrealizedPnl: 0,
            liquidationPrice: typusLiquidationPrice,
            txDigest: pending.txDigest,
          });
          await storage.updatePosition(position.id, {
            onChainPositionId: fillResult,
            verified: true,
          });
          await storage.updateAgent(pending.agentId, {
            balance: Math.max(0, agent.balance - collateral),
            totalTrades: (agent.totalTrades || 0) + 1,
            lastExecutionError: `Delayed fill: order ${pending.orderId} filled as position ${fillResult}`,
          });
          console.log(`[UnfilledOrders] Position created for delayed fill: DB position ${position.id}, on-chain ${fillResult}, collateral=${collateral.toFixed(4)} SUI`);
        }
      } catch (err: any) {
        console.log(`[UnfilledOrders] Error creating position for filled order ${pending.orderId}: ${err.message}`);
      }
      pendingUnfilledOrders.delete(key);
      continue;
    }

    if (age > UNFILLED_ORDER_MAX_AGE_MS && pending.cancelAttempts >= UNFILLED_ORDER_MAX_CANCEL_ATTEMPTS) {
      console.log(`[UnfilledOrders] Order ${pending.orderId} for ${pending.agentName} exceeded max age (${(age / 1000).toFixed(0)}s) after ${pending.cancelAttempts} cancel attempts. Final balance sync and orphan logging.`);
      try {
        const onChainBal = await suiClient.getBalance({ owner: walletAddr, coinType: "0x2::sui::SUI" });
        const realBalance = Number(onChainBal.totalBalance) / 1e9;
        const agent = await storage.getAgent(pending.agentId);
        const positions = await storage.getPositions(pending.agentId);
        const openPositions = positions.filter(p => (p.status === "open" || p.status === "pending_open"));
        const lockedCollateral = openPositions.reduce((s, p) => s + (p.collateral || p.sizeSui / (agent?.leverage || 25)), 0);
        await storage.updateAgent(pending.agentId, {
          balance: realBalance + lockedCollateral,
          lastExecutionError: `WARNING: Unfilled order ${pending.orderId} could not be cancelled after ${pending.cancelAttempts} attempts. Balance synced to on-chain: ${realBalance.toFixed(4)} SUI`,
        });
        console.log(`[UnfilledOrders] Orphan balance sync: on-chain=${realBalance.toFixed(4)}+locked=${lockedCollateral.toFixed(4)}=${(realBalance + lockedCollateral).toFixed(4)} SUI`);
      } catch (err: any) {
        console.log(`[UnfilledOrders] Orphan balance sync failed: ${err.message}`);
      }
      pendingUnfilledOrders.delete(key);
      continue;
    }

    console.log(`[UnfilledOrders] Retrying cancel for unfilled order ${pending.orderId} (${pending.agentName}, attempt ${pending.cancelAttempts + 1}, age=${(age / 1000).toFixed(0)}s)...`);
    const cancelResult = await adapter.cancelUnfilledOrder(pending.agentWallet, pending.orderId);
    pending.cancelAttempts++;

    if (cancelResult.cancelled) {
      console.log(`[UnfilledOrders] Successfully cancelled order ${pending.orderId} for ${pending.agentName}. Collateral recovered.`);
      pendingUnfilledOrders.delete(key);
      try {
        const onChainBal = await suiClient.getBalance({ owner: walletAddr, coinType: "0x2::sui::SUI" });
        const realBalance = Number(onChainBal.totalBalance) / 1e9;
        const agent = await storage.getAgent(pending.agentId);
        const positions = await storage.getPositions(pending.agentId);
        const openPositions = positions.filter(p => (p.status === "open" || p.status === "pending_open"));
        const lockedCollateral = openPositions.reduce((s, p) => s + (p.collateral || p.sizeSui / (agent?.leverage || 25)), 0);
        await storage.updateAgent(pending.agentId, {
          balance: realBalance + lockedCollateral,
          lastExecutionError: `Cancelled stale unfilled order ${pending.orderId} — collateral recovered. Balance synced to on-chain: ${realBalance.toFixed(4)} SUI`,
        });
        console.log(`[UnfilledOrders] Balance synced after cancel: on-chain=${realBalance.toFixed(4)}+locked=${lockedCollateral.toFixed(4)}=${(realBalance + lockedCollateral).toFixed(4)} SUI`);
      } catch (err: any) {
        console.log(`[UnfilledOrders] Balance sync after cancel failed: ${err.message}`);
      }
    } else {
      const isOrderNotFound = (cancelResult.error || "").includes("order_not_found");
      console.log(`[UnfilledOrders] Cancel retry failed for order ${pending.orderId}: ${cancelResult.error}${isOrderNotFound ? " — re-checking for fill" : ""}`);

      if (isOrderNotFound) {
        const secondCheck = await TypusAdapter.resolvePositionIdFromOrderId(suiClient, walletAddr, pending.orderId);
        if (secondCheck) {
          console.log(`[UnfilledOrders] Order ${pending.orderId} was actually FILLED! position_id=${secondCheck}. Creating position...`);
          try {
            const agent = await storage.getAgent(pending.agentId);
            if (agent) {
              const collateral = pending.quantity / pending.leverage;
              const liqPrice = pending.direction === "long"
                ? pending.price * (1 - 1 / pending.leverage)
                : pending.price * (1 + 1 / pending.leverage);
              const position = await storage.createPosition({
                agentId: pending.agentId,
                symbol: "SUI-USDC",
                side: pending.direction,
                sizeSui: pending.quantity,
                collateral,
                entryPrice: pending.price,
                markPrice: pending.price,
                unrealizedPnl: 0,
                liquidationPrice: liqPrice,
                txDigest: pending.txDigest,
              });
              await storage.updatePosition(position.id, { onChainPositionId: secondCheck, verified: true });
              await storage.updateAgent(pending.agentId, {
                totalTrades: (agent.totalTrades || 0) + 1,
                lastExecutionError: `Delayed fill: order ${pending.orderId} filled as position ${secondCheck}`,
              });
              console.log(`[UnfilledOrders] Position created for late-detected fill: ${position.id}`);
            }
          } catch (err: any) {
            console.log(`[UnfilledOrders] Error creating position for late fill: ${err.message}`);
          }
          pendingUnfilledOrders.delete(key);
          continue;
        }

        const onChainBal = await suiClient.getBalance({ owner: walletAddr, coinType: "0x2::sui::SUI" });
        const realBalance = Number(onChainBal.totalBalance) / 1e9;
        const agent = await storage.getAgent(pending.agentId);
        if (!agent) { pendingUnfilledOrders.delete(key); continue; }

        const positions = await storage.getPositions(pending.agentId);
        const openPositions = positions.filter(p => (p.status === "open" || p.status === "pending_open"));
        const lockedCollateral = openPositions.reduce((s, p) => s + (p.collateral || p.sizeSui / (agent.leverage || 25)), 0);
        const expectedCollateral = pending.quantity / pending.leverage;
        const totalAccountedFor = realBalance + lockedCollateral;
        const expectedPreTrade = agent.totalDeposited - (agent.protocolFeePaid || 0);
        const balanceGap = expectedPreTrade - totalAccountedFor;
        const balanceConfirmsFill = balanceGap >= expectedCollateral * 0.7;

        console.log(`[UnfilledOrders] Balance analysis for order ${pending.orderId}: on-chain=${realBalance.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, deposited=${agent.totalDeposited}, gap=${balanceGap.toFixed(4)}, expectedColl=${expectedCollateral.toFixed(4)}, confirmsFill=${balanceConfirmsFill}`);

        if (balanceConfirmsFill) {
          console.log(`[UnfilledOrders] Balance confirms order ${pending.orderId} WAS filled (${balanceGap.toFixed(4)} SUI gap matches collateral). Creating position without on-chain ID — resolver will find it.`);
          try {
            const collateral = expectedCollateral;
            const liqPrice = pending.direction === "long"
              ? pending.price * (1 - 1 / pending.leverage)
              : pending.price * (1 + 1 / pending.leverage);
            const position = await storage.createPosition({
              agentId: pending.agentId,
              symbol: "SUI-USDC",
              side: pending.direction,
              sizeSui: pending.quantity,
              collateral,
              entryPrice: pending.price,
              markPrice: pending.price,
              unrealizedPnl: 0,
              liquidationPrice: liqPrice,
              txDigest: pending.txDigest,
            });
            await storage.updatePosition(position.id, { verified: true });
            trackPendingPositionResolution(position.id, pending.agentId, pending.agentName, walletAddr, pending.orderId);
            await storage.updateAgent(pending.agentId, {
              balance: Math.max(0, agent.balance - collateral),
              totalTrades: (agent.totalTrades || 0) + 1,
              lastExecutionError: `Balance-confirmed fill: order ${pending.orderId} created position (resolving on-chain ID...)`,
            });
            console.log(`[UnfilledOrders] Position ${position.id} created from balance-confirmed fill for order ${pending.orderId}`);
          } catch (err: any) {
            console.log(`[UnfilledOrders] Error creating balance-confirmed position: ${err.message}`);
          }
        } else {
          console.log(`[UnfilledOrders] Order ${pending.orderId} not found, no fill detected, balance shows no collateral consumed — order expired. Syncing balance.`);
          await storage.updateAgent(pending.agentId, {
            balance: realBalance + lockedCollateral,
            lastExecutionError: `Order ${pending.orderId} expired. Balance synced: ${realBalance.toFixed(4)} SUI`,
          });
        }
        pendingUnfilledOrders.delete(key);
        continue;
      }
    }
  }
}

const TRADE_COOLDOWN_MS = 5_000;
const ORACLE_MISMATCH_COOLDOWN_MS = 3_000;
const MAX_OPEN_POSITIONS_PER_AGENT = 5;
const agentCapitalPlanCache = new Map<string, { plan: CapitalPlan; fetchedAt: number }>();
const CAPITAL_PLAN_CACHE_TTL = 60_000;

export function invalidateCapitalPlanCache(agentId: string): void {
  agentCapitalPlanCache.delete(agentId);
}

const BASE_LOSS_COOLDOWN_MS = 10 * 1000;
const STREAK_LOSS_COOLDOWN_MS = 45 * 1000;
const STREAK_LOSS_THRESHOLD = 5;
const COOLDOWN_SCALE_FACTOR = 1.2;
const lossCooldownMap = new Map<string, { consecutiveLosses: number; lastLossAt: number }>();

export function recordTradeLoss(agentId: string): void {
  const current = lossCooldownMap.get(agentId) || { consecutiveLosses: 0, lastLossAt: 0 };
  current.consecutiveLosses += 1;
  current.lastLossAt = Date.now();
  lossCooldownMap.set(agentId, current);
  const cooldownMs = getCooldownMs(current.consecutiveLosses);
  console.log(`[LossCooldown] Agent ${agentId}: ${current.consecutiveLosses} consecutive losses, cooldown=${Math.round(cooldownMs / 1000)}s`);
}

export function recordTradeWin(agentId: string): void {
  lossCooldownMap.delete(agentId);
  agentCapitalPlanCache.delete(agentId);
}

export function getConsecutiveLosses(agentId: string): number {
  return lossCooldownMap.get(agentId)?.consecutiveLosses || 0;
}

function getCooldownMs(consecutiveLosses: number): number {
  if (consecutiveLosses >= STREAK_LOSS_THRESHOLD) {
    return STREAK_LOSS_COOLDOWN_MS * Math.min(consecutiveLosses - STREAK_LOSS_THRESHOLD + 1, 3);
  }
  return BASE_LOSS_COOLDOWN_MS * Math.pow(COOLDOWN_SCALE_FACTOR, consecutiveLosses - 1);
}

function isLossCooldownActive(agentId: string): { blocked: boolean; reason?: string } {
  const record = lossCooldownMap.get(agentId);
  if (!record) return { blocked: false };
  const elapsed = Date.now() - record.lastLossAt;
  const cooldownMs = getCooldownMs(record.consecutiveLosses);
  if (elapsed < cooldownMs) {
    if (record.consecutiveLosses >= STREAK_LOSS_THRESHOLD) {
      const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
      return { blocked: true, reason: `STREAK_COOLDOWN: ${record.consecutiveLosses} consecutive losses, ${remaining}m remaining` };
    }
    const remaining = Math.ceil((cooldownMs - elapsed) / 1000);
    return { blocked: true, reason: `LOSS_COOLDOWN: ${remaining}s remaining (${record.consecutiveLosses} loss streak)` };
  }
  return { blocked: false };
}

const verifyRecoverInProgress = new Set<string>();

async function verifyAndRecoverStuckPositions() {
  try {
    const allAgents = await storage.getAgents();
    for (const agent of allAgents) {
      if (!agent.walletAddress) continue;

      const allPositions = await storage.getPositions(agent.id);
      const stuck = allPositions.filter(
        p => (p.status === "pending_open" || (p.status === "open" && (!p.onChainPositionId || p.onChainPositionId.includes("-"))))
      );

      for (const pos of stuck) {
        if (verifyRecoverInProgress.has(pos.id)) continue;
        if (pendingPositionResolutions.has(pos.id) || pendingDigestReconciliations.has(pos.id)) continue;
        verifyRecoverInProgress.add(pos.id);
        try {
        const ageMs = Date.now() - (pos.openedAt ? new Date(pos.openedAt).getTime() : Date.now());
        if (ageMs > 1_800_000 && pos.status === "pending_open") {
          console.log(`[VerifyRecover] Position ${pos.id} stuck as pending_open for ${Math.round(ageMs / 60000)}m — checking on-chain balance before marking error`);
          try {
            const balResp = await suiClient.getBalance({ owner: agent.walletAddress!, coinType: "0x2::sui::SUI" });
            const onChainBal = Number(balResp.totalBalance) / 1e9;
            const expectedCollateral = pos.collateral || pos.sizeSui / (agent.leverage || 25);
            if (onChainBal >= expectedCollateral * 0.8) {
              console.log(`[VerifyRecover] Balance ${onChainBal.toFixed(4)} SUI confirms collateral returned. Position ${pos.id} was never truly opened — closing as settled.`);
              await storage.updatePosition(pos.id, { status: "closed", closeReason: "never_opened_settled" });
              await storage.updateAgent(agent.id, {
                balance: onChainBal,
                lastExecutionError: null,
              });
            } else {
              console.log(`[VerifyRecover] Position ${pos.id} stuck >30m, balance ${onChainBal.toFixed(4)} SUI doesn't confirm return. Marking error for manual review.`);
              await storage.updatePosition(pos.id, { status: "error" });
              await storage.updateAgent(agent.id, {
                lastExecutionError: `Position ${pos.id} stuck in pending_open for ${Math.round(ageMs / 60000)}m. On-chain balance: ${onChainBal.toFixed(4)} SUI. Manual review needed.`,
              });
            }
          } catch (balErr: any) {
            console.log(`[VerifyRecover] Balance check failed for stuck position ${pos.id}: ${balErr.message}`);
          }
          continue;
        }

        if (pos.txDigest) {
          try {
            const result = await reconcileFromDigest(pos.txDigest);
            if (result.positionId) {
              console.log(`[VerifyRecover] Recovered position_id=${result.positionId} from digest ${pos.txDigest} for ${agent.name}`);
              const updates: any = { onChainPositionId: result.positionId, status: "open", verified: true };
              if (result.orderId) updates.typusOrderId = result.orderId;
              await storage.updatePosition(pos.id, updates);
              continue;
            }
            if (result.orderId && !pos.typusOrderId) {
              await storage.updatePosition(pos.id, { typusOrderId: result.orderId });
              trackPendingPositionResolution(pos.id, agent.id, agent.name, agent.walletAddress, result.orderId);
              continue;
            }
          } catch (err: any) {
            console.log(`[VerifyRecover] Digest reconcile failed for ${pos.id}: ${err.message}`);
          }
        }

        if (pos.typusOrderId) {
          try {
            const resolvedId = await TypusAdapter.resolvePositionIdFromOrderId(suiClient, agent.walletAddress, pos.typusOrderId);
            if (resolvedId) {
              console.log(`[VerifyRecover] Resolved position_id=${resolvedId} via orderId=${pos.typusOrderId} for ${agent.name}`);
              await storage.updatePosition(pos.id, { onChainPositionId: resolvedId, status: "open", verified: true });
              continue;
            }
          } catch (err: any) {
            console.log(`[VerifyRecover] Order resolution failed for ${pos.id}: ${err.message}`);
          }
        }

        try {
          const adapter = getAdapter(agent.venue || "typus");
          if (adapter) {
            const openOnChain = await adapter.getPositions(agent.walletAddress);
            const match = openOnChain.find((op: any) => op.side === pos.side && Math.abs(op.size - pos.sizeSui) < 1);
            if (match && match.positionId) {
              console.log(`[VerifyRecover] MATCHED on-chain position for ${agent.name} by side/size: ${match.positionId}`);
              await storage.updatePosition(pos.id, { onChainPositionId: match.positionId, status: "open", verified: true });
              continue;
            }
          }
        } catch (err: any) {
          console.log(`[VerifyRecover] On-chain match failed for ${pos.id}: ${err.message}`);
        }
        } finally {
          verifyRecoverInProgress.delete(pos.id);
        }
      }
    }
  } catch (err: any) {
    console.log(`[VerifyRecover] Loop error: ${err.message}`);
  }
}

let integrityCheckComplete = false;
export function markIntegrityComplete() { integrityCheckComplete = true; }
export function isIntegrityComplete() { return integrityCheckComplete; }
export { processPendingUnfilledOrders, processPendingPositionResolutions, processPendingDigestReconciliations, verifyAndRecoverStuckPositions };

export function getPendingUnfilledOrdersForAgent(agentId: string): { orderId: string; collateral: number; direction: string; age: number }[] {
  const result: { orderId: string; collateral: number; direction: string; age: number }[] = [];
  for (const [_key, pending] of pendingUnfilledOrders.entries()) {
    if (pending.agentId === agentId) {
      result.push({
        orderId: pending.orderId,
        collateral: pending.quantity / pending.leverage,
        direction: pending.direction,
        age: Date.now() - pending.submittedAt,
      });
    }
  }
  return result;
}

const MAX_COLLATERAL_LOSS_PCT = 8;
const EMERGENCY_COLLATERAL_LOSS_PCT = 12;
const MAX_POSITIONS_PER_SIDE = 1;
const MAX_CLOSE_RETRIES = 5;
const RETRY_DELAYS_MS = [300, 500, 800, 1200, 2000];
const SKIP_BUNDLE_COOLDOWN_MS = 300_000;
const lastSkipBundleTime = new Map<string, number>();
const MAX_DAILY_FAILED_GAS_SUI = 0.15;
const MAX_DAILY_FAILED_TX_COUNT = 25;
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
      const agentOpenCloses = (await storage.getPositions(agentId)).filter(p => positionCloseInProgress.has(p.id));
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

      const allPos = await storage.getPositions(agentId);
      const openPos = allPos.filter(p => (p.status === "open" || p.status === "pending_open"));
      const lockedCollateral = openPos.reduce((sum, p) => sum + (p.collateral || p.sizeSui / (agentNow.leverage || 20)), 0);

      let onChainLockedCollateral = 0;
      try {
        const adapter = getAdapter(agentNow.venue);
        if (adapter) {
          const onChainPositions = await adapter.getPositions(walletAddress);
          if (onChainPositions && onChainPositions.length > 0) {
            for (const ocp of onChainPositions) {
              const trackedAsOpen = openPos.some(p => p.onChainPositionId && String(p.onChainPositionId) === String(ocp.positionId));
              if (!trackedAsOpen) {
                const posCollateral = ocp.collateral || 0;
                onChainLockedCollateral += posCollateral;
                console.log(`[BalanceSync] RECONCILIATION: Found on-chain position ${ocp.positionId} (${ocp.side} ${ocp.size?.toFixed(2)} SUI) not tracked as open in DB — adding ${posCollateral.toFixed(4)} SUI locked collateral`);
              }
            }
          }
        }
      } catch (onChainCheckErr: any) {
        console.log(`[BalanceSync] RECONCILIATION: Failed to check on-chain positions: ${onChainCheckErr.message?.slice(0, 80)}`);
      }

      const onChainTotal = currentOnChainBalance + lockedCollateral + onChainLockedCollateral;

      if (Math.abs(onChainTotal - agentNow.balance) > 0.1) {
        console.log(`[BalanceSync] Balance RECONCILIATION for ${agentName}: DB=${agentNow.balance.toFixed(4)} → on-chain-derived=${onChainTotal.toFixed(4)} (wallet=${currentOnChainBalance.toFixed(4)}, dbLocked=${lockedCollateral.toFixed(4)}, onChainUntracked=${onChainLockedCollateral.toFixed(4)}, ${openPos.length} DB-open). Using on-chain truth.`);
        await storage.updateAgent(agentId, { balance: onChainTotal });
      }

      const closedPos = allPos.filter(p => p.status === "closed");
      const agentLeverage = agentNow?.leverage || 20;
      for (const p of closedPos) {
        const posCollateral = p.collateral || (p.sizeSui / agentLeverage);
        const storedPnl = p.unrealizedPnl || 0;
        const maxGain = posCollateral * Math.min(agentLeverage - 1, 10);
        let correctedPnl: number | null = null;
        if (storedPnl < -posCollateral - 0.01) {
          correctedPnl = -posCollateral;
          console.log(`[BalanceSync] Position ${p.id} PnL below -collateral: ${storedPnl.toFixed(4)} -> ${correctedPnl.toFixed(4)} (capped at -collateral ${posCollateral.toFixed(4)})`);
        } else if (storedPnl > maxGain + 0.01) {
          correctedPnl = maxGain;
          console.log(`[BalanceSync] Position ${p.id} PnL exceeds max gain: ${storedPnl.toFixed(4)} -> ${correctedPnl.toFixed(4)} (capped at ${maxGain.toFixed(4)}, ${agentLeverage}x lev)`);
        }
        if (correctedPnl !== null) {
          await storage.updatePosition(p.id, { unrealizedPnl: correctedPnl });
        }
      }

      const netDeposited = (agentNow.totalDeposited || 0) - (agentNow.protocolFeePaid || 0);
      if (netDeposited > 0.01) {
        let totalClaimedRewards = 0;
        try {
          const allRewards = await storage.getRewards();
          totalClaimedRewards = allRewards
            .filter(r => r.agentId === agentId && r.status === "claimed")
            .reduce((s, r) => s + r.amount, 0);
        } catch {}
        const correctPnl = (onChainTotal + totalClaimedRewards) - netDeposited;
        const dbPnl = agentNow.totalPnl || 0;
        if (Math.abs(correctPnl - dbPnl) > 0.5) {
          console.log(`[PnLSync] Correcting totalPnl for ${agentName}: DB=${dbPnl.toFixed(4)} → portfolio-derived=${correctPnl.toFixed(4)} (portfolio=${onChainTotal.toFixed(4)}, claimed=${totalClaimedRewards.toFixed(4)}, netDeposited=${netDeposited.toFixed(4)})`);
          await storage.updateAgent(agentId, { totalPnl: correctPnl });
        }
      }
    } catch (err: any) {
      console.log(`[BalanceSync] Reconciliation failed for ${agentName}: ${err.message}`);
    } finally {
      reconciliationInProgress.delete(agentId);
    }
  }, 500);
}

export function getGasSpendStatus(agentId: string): { totalMist: number; failedTxCount: number; maxSui: number; maxCount: number; resetAt?: number } {
  const record = dailyGasSpend.get(agentId);
  return {
    totalMist: record?.totalMist ?? 0,
    failedTxCount: record?.failedTxCount ?? 0,
    maxSui: MAX_DAILY_FAILED_GAS_SUI,
    maxCount: MAX_DAILY_FAILED_TX_COUNT,
    resetAt: record?.resetAt,
  };
}

export function isDailyGasCapReset(agentId: string): boolean {
  const record = dailyGasSpend.get(agentId);
  if (!record) return true;
  return Date.now() > record.resetAt;
}

export async function checkGasForAgent(agentWallet: any): Promise<{ ok: boolean; balanceSui?: number; reason?: string }> {
  try {
    const keypair = decryptKeypair(agentWallet);
    const walletAddr = keypair.toSuiAddress();
    const gasCheck = await ensureMinGasReserve(suiClient, walletAddr);
    if (gasCheck.ok) {
      return { ok: true, balanceSui: gasCheck.balanceSui };
    }
    return { ok: false, balanceSui: gasCheck.balanceSui, reason: gasCheck.reason };
  } catch (err: any) {
    return { ok: false, reason: err.message };
  }
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
  signalId?: string,
  tritonSignal?: TradeSignal
): Promise<DexOrderResult | null> {
  if (tritonSignal) {
    const mode = tritonSignal.activeMode || "PRECISION";
    const profile = MODE_PROFILES[mode];
    if (tritonSignal.side === "NONE") {
      console.log(`[Triton] ${agent.name}: SKIP — side=NONE | mode=${mode} regime=${tritonSignal.regime} htf=${tritonSignal.htfBias} score=${tritonSignal.score} | ${tritonSignal.reasons.slice(0, 4).join('; ')}`);
      return null;
    }
    if (Date.now() > tritonSignal.validUntilMs) {
      console.log(`[Triton] ${agent.name}: SKIP — signal expired (${Math.round((Date.now() - tritonSignal.validUntilMs) / 1000)}s ago) | ${tritonSignal.side} score=${tritonSignal.score}`);
      return null;
    }

    const consecutiveLosses = getConsecutiveLosses(agent.id);
    let effectiveScore = tritonSignal.score;
    let feedbackReason = "";
    try {
      const side = tritonSignal.side === "LONG" ? "long" : "short";
      const feedback = await getEntryFeedback(tritonSignal.regime, side, consecutiveLosses);
      if (feedback.regimeSideBlocked) {
        console.log(`[Learning] ${agent.name}: BLOCKED — ${feedback.reason}`);
        return null;
      }
      if (feedback.scorePenalty > 0) {
        effectiveScore = tritonSignal.score - feedback.scorePenalty;
        feedbackReason = ` [learning penalty: -${feedback.scorePenalty} → effective ${effectiveScore}; ${feedback.reason}]`;
      }
    } catch {}

    try {
      const competitive = await getAgentCompetitiveScore(agent.id);
      if (competitive.total >= 2 && competitive.scorePenalty !== 0) {
        effectiveScore += competitive.scorePenalty;
        feedbackReason += ` [competitive rank ${competitive.rank}/${competitive.total}: ${competitive.scorePenalty > 0 ? "+" : ""}${competitive.scorePenalty}]`;
      }
    } catch {}

    try {
      let earlyPlan = agentCapitalPlanCache.get(agent.id)?.plan;
      if (!earlyPlan) {
        earlyPlan = await getCapitalPlan(agent.id, agent.balance, 0);
        agentCapitalPlanCache.set(agent.id, { plan: earlyPlan, fetchedAt: Date.now() });
      }
      if (earlyPlan.adaptiveScoreBonus !== 0) {
        const bonus = earlyPlan.adaptiveScoreBonus;
        const threshold = profile.weakScore + bonus;
        feedbackReason += ` [capital plan: score threshold ${bonus > 0 ? "+" : ""}${bonus} → ${threshold}]`;
        if (effectiveScore < threshold) {
          console.log(`[Triton] ${agent.name}: SKIP — effective score ${effectiveScore} < adaptive threshold ${threshold} (${mode}) | capital plan raised bar${feedbackReason}`);
          return null;
        }
      }
    } catch {}

    if (effectiveScore < profile.weakScore) {
      console.log(`[Triton] ${agent.name}: SKIP — effective score ${effectiveScore} (raw ${tritonSignal.score}) < ${profile.weakScore} (${mode}) | ${tritonSignal.side} regime=${tritonSignal.regime} rr=${tritonSignal.rr.toFixed(2)}${feedbackReason}`);
      return null;
    }
    const minRR = tritonSignal.regime === "RANGE" ? profile.minRrRange : profile.minRrTrend;
    if (tritonSignal.rr < minRR) {
      console.log(`[Triton] ${agent.name}: SKIP — rr ${tritonSignal.rr.toFixed(2)} < ${minRR} (${mode}) | ${tritonSignal.side} score=${effectiveScore}`);
      return null;
    }

    if (consecutiveLosses >= 4 && tritonSignal.score < profile.strongScore) {
      console.log(`[Triton] ${agent.name}: SKIP — after ${consecutiveLosses} losses, requiring STRONG signal (score ${tritonSignal.score} < ${profile.strongScore}) | ${tritonSignal.side} regime=${tritonSignal.regime}`);
      return null;
    }

    const SURVIVAL_THRESHOLD_SUI = 3.0;
    let survivalMode = false;
    if (agent.agentWallet) {
      try {
        const survKp = decryptKeypair(agent.agentWallet);
        const survAddr = survKp.toSuiAddress();
        const survBal = await suiClient.getBalance({ owner: survAddr, coinType: "0x2::sui::SUI" });
        const freeSui = Number(survBal.totalBalance) / 1e9;
        if (freeSui < SURVIVAL_THRESHOLD_SUI) {
          survivalMode = true;
          if (tritonSignal.score < profile.strongScore) {
            console.log(`[Survival] ${agent.name}: SKIP — survival mode (${freeSui.toFixed(3)} SUI < ${SURVIVAL_THRESHOLD_SUI}), requiring STRONG signal (score ${tritonSignal.score} < ${profile.strongScore}) | ${tritonSignal.side}`);
            return null;
          }
          tritonSignal.sizeMultiplier = Math.max(0.25, tritonSignal.sizeMultiplier * 0.5);
          (tritonSignal as any).__survivalMode = true;
          feedbackReason += ` [SURVIVAL: size halved to ${tritonSignal.sizeMultiplier.toFixed(2)}, SL tightened 20%]`;
        }
      } catch {}
    }

    console.log(`[Triton] ${agent.name}: PASS${survivalMode ? " [SURVIVAL]" : ""} — ${tritonSignal.side} | mode=${mode} regime=${tritonSignal.regime} htf=${tritonSignal.htfBias} score=${effectiveScore}(raw=${tritonSignal.score}) rr=${tritonSignal.rr.toFixed(2)} size=${tritonSignal.sizeMultiplier.toFixed(2)} losses=${consecutiveLosses} | ${tritonSignal.reasons.slice(0, 4).join('; ')}${feedbackReason}`);
  }

  const direction = tritonSignal
    ? (tritonSignal.side === "LONG" ? "long" : tritonSignal.side === "SHORT" ? "short" : "hold" as const)
    : mapSignalToDirection(signal);

  if (direction === "hold") {
    return null;
  }

  if (!integrityCheckComplete) return null;

  if (agent.status !== "running") return null;
  if (agent.balance <= 0) return null;

  const gasCapTripped = await checkAndEnforceGasCap(agent);
  if (gasCapTripped) return null;

  const throttleLevel = getThrottleLevel(agent.id, agent.totalDeposited || 0);
  if (throttleLevel === "closes_only" || throttleLevel === "emergency_only") {
    console.log(`[Execution] ${agent.name}: Gas throttle at '${throttleLevel}' — blocking new position opens`);
    return null;
  }

  if (throttleLevel === "conserving" && tritonSignal) {
    const score = tritonSignal.score ?? 0;
    if (score < 70) {
      console.log(`[Execution] ${agent.name}: Gas conserving mode — skipping signal with score ${score} < 70 threshold`);
      return null;
    }
  }

  if (!tritonSignal && !isStrongSignal(signal)) {
    return null;
  }

  const lossCooldown = isLossCooldownActive(agent.id);
  if (lossCooldown.blocked) {
    console.log(`[Execution] ${agent.name}: Blocked by ${lossCooldown.reason}`);
    return null;
  }

  if (activeExecutions.has(agent.id)) {
    return null;
  }

  const hasPendingUnfilled = Array.from(pendingUnfilledOrders.keys()).some(k => k.startsWith(agent.id + ":"));
  if (hasPendingUnfilled) {
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

  let capitalPlan: CapitalPlan | null = null;
  try {
    const cachedPlan = agentCapitalPlanCache.get(agent.id);
    if (cachedPlan && Date.now() - cachedPlan.fetchedAt < CAPITAL_PLAN_CACHE_TTL) {
      capitalPlan = cachedPlan.plan;
    } else {
      capitalPlan = await getCapitalPlan(agent.id, agent.balance, openPositions.length);
      agentCapitalPlanCache.set(agent.id, { plan: capitalPlan, fetchedAt: Date.now() });
    }
  } catch {}

  const dynamicMaxPositions = capitalPlan ? Math.min(capitalPlan.recommendedMaxPositions, MAX_OPEN_POSITIONS_PER_AGENT) : MAX_OPEN_POSITIONS_PER_AGENT;

  if (openPositions.length >= dynamicMaxPositions) {
    console.log(`[Execution] Agent ${agent.name} at max positions (${openPositions.length}/${dynamicMaxPositions}${capitalPlan ? ` from capital plan` : ""})`);
    return null;
  }

  const sameSidePositions = openPositions.filter(p => p.side === direction);
  if (sameSidePositions.length >= MAX_POSITIONS_PER_SIDE) {
    console.log(`[Execution] Agent ${agent.name} already has ${sameSidePositions.length} ${direction} position(s) (max ${MAX_POSITIONS_PER_SIDE} per side) — blocking new ${direction} trade to prevent correlated liquidations`);
    return null;
  }

  const unresolvedPositions = openPositions.filter(p => !p.onChainPositionId || p.onChainPositionId.includes("-"));
  if (unresolvedPositions.length > 0) {
    const msg = `SAFETY: ${unresolvedPositions.length} open position(s) have unresolved on-chain IDs — blocking new trades until resolved. Use Verify & Recover.`;
    console.log(`[Execution] ${agent.name}: ${msg}`);
    await storage.updateAgent(agent.id, { lastExecutionError: msg, lastExecutionAt: new Date() });
    return null;
  }

  if (openPositions.length > 0) {
    const lockedColl = openPositions.reduce((sum, p) => sum + (p.collateral || p.sizeSui / agent.leverage), 0);
    const preCheckMinColl = agent.minCollateral ?? 0.5;
    const estFree = agent.balance - lockedColl;
    if (estFree < preCheckMinColl + COLLATERAL_GAS_RESERVE_SUI) {
      return null;
    }
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
      if (agent.balance > 0) {
        onChainBalance = agent.balance;
        console.log(`[Execution] RPC balance fetch failed for ${agent.name}: ${balErr.message}. Using DB balance fallback (${onChainBalance.toFixed(4)} SUI).`);
      } else {
        console.log(`[Execution] RPC balance fetch failed for ${agent.name}: ${balErr.message}. No DB balance to fall back on — skipping.`);
        await storage.updateAgent(agent.id, { lastExecutionError: "RPC balance unavailable — retrying next cycle", lastExecutionAt: new Date() });
        return null;
      }
    }

    if (balanceFetchedFromChain && onChainBalance < COLLATERAL_GAS_RESERVE_SUI) {
      const msg = `INSUFFICIENT_GAS: Wallet has ${onChainBalance.toFixed(4)} SUI — below gas reserve threshold (${COLLATERAL_GAS_RESERVE_SUI} SUI). Not opening new trades until balance is topped up.`;
      console.log(`[Execution] Skipping ${agent.name}: ${msg}`);
      await storage.updateAgent(agent.id, { lastExecutionError: msg, lastExecutionAt: new Date() });
      return { success: false, error: msg, venue: agent.venue };
    }

    const freshOpenPositions = await storage.getOpenPositions(agent.id);
    let lockedCollateral = freshOpenPositions.reduce((sum, p) => sum + (p.collateral || p.sizeSui / agent.leverage), 0);

    let onChainOpenCount = freshOpenPositions.length;
    const hasUnresolvedDbPositions = freshOpenPositions.some(p => !p.onChainPositionId || p.status === "pending_open");
    if (!hasUnresolvedDbPositions) {
      try {
        const adapter = getAdapter(agent.venue);
        if (adapter && agent.walletAddress) {
          const cachedPos = agentOnChainPosCache.get(agent.id);
          let onChainPositions: any[];
          if (cachedPos && Date.now() - cachedPos.timestamp < AGENT_ONCHAIN_POS_CACHE_TTL) {
            onChainPositions = cachedPos.positions;
          } else {
            onChainPositions = await adapter.getPositions(agent.walletAddress);
            agentOnChainPosCache.set(agent.id, { positions: onChainPositions, timestamp: Date.now() });
          }
          const dbPositionIds = new Set(freshOpenPositions.map(p => p.onChainPositionId).filter(Boolean));
          const contentMatchSet = new Set(
            freshOpenPositions.map(p => `${p.side}:${(p.entryPrice || 0).toFixed(4)}:${p.sizeSui.toFixed(0)}`).filter(Boolean)
          );
          for (const ocp of onChainPositions) {
            if (!dbPositionIds.has(ocp.positionId)) {
              const contentKey = `${ocp.side}:${(ocp.entryPrice || 0).toFixed(4)}:${(ocp.size || 0).toFixed(0)}`;
              const isContentMatch = contentMatchSet.has(contentKey);

              const untrackedColl = ocp.collateral || (ocp.size / agent.leverage);
              lockedCollateral += untrackedColl;
              onChainOpenCount++;

              if (ocp.entryPrice && ocp.entryPrice > 0 && ocp.size && ocp.size > 0) {
                try {
                  const allPositions = await storage.getPositions(agent.id);

                  const closedMatch = allPositions.find(p =>
                    p.onChainPositionId === ocp.positionId && p.status === "closed"
                  );
                  if (closedMatch) {
                    const closedAgo = closedMatch.closedAt ? Date.now() - new Date(closedMatch.closedAt).getTime() : Infinity;
                    const isSyntheticClose = !closedMatch.closeTxDigest || closedMatch.closeTxDigest === "settled_onchain" || closedMatch.closeTxDigest === "position_gone_onchain" || closedMatch.closeTxDigest === "closed_externally" || closedMatch.closeTxDigest === "cancelled_unfilled" || closedMatch.closeTxDigest === "liquidated_onchain" || closedMatch.closeTxDigest.startsWith("recovered_") || closedMatch.closeTxDigest.startsWith("sim_") || closedMatch.closeTxDigest.startsWith("db_");

                    const hasRealCloseTx = closedMatch.closeTxDigest && !isSyntheticClose;
                    if (hasRealCloseTx) {
                      continue;
                    }

                    const cm = closedMatch as any;
                    const hasProperCloseLifecycle = cm.closeState === "closed" && cm.closeReason && closedMatch.closedAt;
                    if (hasProperCloseLifecycle && closedAgo > 10 * 60 * 1000) {
                      continue;
                    }

                    const reopenKey = `reopen_${closedMatch.id}`;
                    const reopenCount = (positionReopenCounts.get(reopenKey) || 0);
                    const MAX_REOPEN_ATTEMPTS = 2;
                    const REOPEN_COOLDOWN_MS = 5 * 60 * 1000;

                    if (reopenCount >= MAX_REOPEN_ATTEMPTS) {
                      console.log(`[Execution] REOPEN BLOCKED for ${agent.name}: posId=${ocp.positionId} already re-opened ${reopenCount} times — likely infinite loop. Skipping.`);
                      continue;
                    }

                    if (isSyntheticClose && closedAgo < REOPEN_COOLDOWN_MS) {
                      console.log(`[Execution] REOPEN SKIPPED for ${agent.name}: posId=${ocp.positionId} was closed as "${closedMatch.closeTxDigest}" only ${(closedAgo / 1000).toFixed(0)}s ago. Waiting for settlement to propagate.`);
                      continue;
                    }

                    positionReopenCounts.set(reopenKey, reopenCount + 1);

                    const leverageVal = agent.leverage || 25;
                    const correctLiq = (ocp.side || closedMatch.side) === "long"
                      ? (ocp.entryPrice || closedMatch.entryPrice) * (1 - 1 / leverageVal)
                      : (ocp.entryPrice || closedMatch.entryPrice) * (1 + 1 / leverageVal);
                    await storage.updatePosition(closedMatch.id, {
                      status: "open",
                      closeReason: null,
                      closeTxDigest: null,
                      closedAt: null,
                      unrealizedPnl: 0,
                      verified: true,
                      entryPrice: ocp.entryPrice || closedMatch.entryPrice,
                      sizeSui: ocp.size || closedMatch.sizeSui,
                      collateral: untrackedColl,
                      liquidationPrice: correctLiq,
                    });
                    await storage.updatePosition(closedMatch.id, { closeState: "open", closeAttempts: 0 });
                    clearCloseGasTracking(closedMatch.id);
                    console.log(`[Execution] RE-OPENED closed position for ${agent.name}: posId=${ocp.positionId}, DB was "${closedMatch.closeReason}" but STILL OPEN on-chain. Reopen attempt ${reopenCount + 1}/${MAX_REOPEN_ATTEMPTS}. Reset close state for fresh SL/TP management.`);
                    continue;
                  }

                  if (isContentMatch) {
                    const contentMatchedPos = freshOpenPositions.find(p =>
                      `${p.side}:${(p.entryPrice || 0).toFixed(4)}:${p.sizeSui.toFixed(0)}` === contentKey
                    );
                    if (contentMatchedPos && contentMatchedPos.onChainPositionId !== ocp.positionId) {
                      await storage.updatePosition(contentMatchedPos.id, { onChainPositionId: ocp.positionId });
                      console.log(`[Execution] Updated on-chain ID for ${agent.name}: DB pos ${contentMatchedPos.id} now mapped to on-chain ${ocp.positionId}`);
                    }
                    continue;
                  }

                  const alreadyTracked = allPositions.some(p =>
                    (p.txDigest === `reopened_${ocp.positionId}` && p.status === "open") ||
                    (p.txDigest === `recovered_${ocp.positionId}` && p.status === "open")
                  );

                  if (!alreadyTracked) {
                    const leverageVal = agent.leverage || 25;
                    const liqPriceLong = ocp.entryPrice * (1 - 1 / leverageVal);
                    const liqPriceShort = ocp.entryPrice * (1 + 1 / leverageVal);
                    const correctLiq = ocp.side === "long" ? liqPriceLong : liqPriceShort;

                    const position = await storage.createPosition({
                      agentId: agent.id,
                      symbol: "SUI-USDC",
                      side: ocp.side || "long",
                      sizeSui: ocp.size,
                      collateral: untrackedColl,
                      entryPrice: ocp.entryPrice,
                      markPrice: ocp.entryPrice,
                      unrealizedPnl: 0,
                      liquidationPrice: correctLiq,
                      txDigest: `recovered_${ocp.positionId}`,
                    });
                    await storage.updatePosition(position.id, { onChainPositionId: ocp.positionId, verified: true });
                    console.log(`[Execution] AUTO-RECOVERED untracked position for ${agent.name}: posId=${ocp.positionId}, ${ocp.side} ${ocp.size.toFixed(2)} SUI @ $${ocp.entryPrice.toFixed(4)}, collateral=${untrackedColl.toFixed(4)} SUI — now managed with SL/TP`);
                  }
                } catch (recoverErr: any) {
                  console.log(`[Execution] Failed to auto-recover position ${ocp.positionId} for ${agent.name}: ${recoverErr.message} — included in balance calc only`);
                }
              } else {
                console.log(`[Execution] Untracked on-chain position for ${agent.name}: posId=${ocp.positionId}, collateral=${untrackedColl.toFixed(4)} SUI — no entry data, included in balance calc`);
              }
            }
          }
          try {
            const { setOnChainPositionsCache } = await import("../routes");
            const allPositionsForCache = onChainPositions.map(ocp => ({
              positionId: ocp.positionId,
              side: ocp.side,
              size: ocp.size,
              collateral: ocp.collateral || (ocp.size / agent.leverage),
              entryPrice: ocp.entryPrice || 0,
            }));
            setOnChainPositionsCache(agent.id, allPositionsForCache, lockedCollateral);
          } catch {}
        }
      } catch {}
    }

    const onChainTotal = onChainBalance + lockedCollateral;

    let effectiveBalance: number;
    if (Math.abs(agent.balance - onChainTotal) > 0.1) {
      console.log(`[Execution] Balance sync for ${agent.name}: DB=${agent.balance.toFixed(4)}, onChain=${onChainBalance.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, corrected=${onChainTotal.toFixed(4)}`);
      await storage.updateAgent(agent.id, { balance: onChainTotal });
      effectiveBalance = onChainTotal;
    } else {
      effectiveBalance = Math.min(agent.balance, onChainTotal);
    }

    const positionsAfterOpen = onChainOpenCount + 1;
    const dynamicGasReserve = COLLATERAL_GAS_RESERVE_SUI + (positionsAfterOpen * GAS_PER_CLOSE_SUI);
    const rawRetained = agent.retainedProfits || 0;
    if (rawRetained > onChainBalance && rawRetained > 0.01) {
      const cappedRetained = Math.max(0, onChainBalance);
      storage.updateAgent(agent.id, { retainedProfits: cappedRetained }).catch(() => {});
      console.log(`[Execution] Auto-capped retainedProfits for ${agent.name}: ${rawRetained.toFixed(4)} → ${cappedRetained.toFixed(4)} (wallet=${onChainBalance.toFixed(4)})`);
    }

    const maxCollateralByUtilization = effectiveBalance * MAX_COLLATERAL_UTILIZATION;
    const alreadyUtilized = lockedCollateral;
    const remainingUtilizationBudget = Math.max(0, maxCollateralByUtilization - alreadyUtilized);

    const minFreeSuiFloor = Math.max(MIN_FREE_SUI_FLOOR, dynamicGasReserve);
    const freeAfterReserve = Math.max(0, onChainBalance - minFreeSuiFloor);

    const totalReserve = dynamicGasReserve;
    const SAFETY_MARGIN = 0.90;
    const freeForTrading = Math.min(freeAfterReserve, remainingUtilizationBudget) * SAFETY_MARGIN;
    const availableForTrading = Math.max(0, freeForTrading);

    console.log(`[Execution] Capital plan for ${agent.name}: onChain=${onChainBalance.toFixed(4)}, totalEquity=${effectiveBalance.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, utilCap=${maxCollateralByUtilization.toFixed(4)} (${(MAX_COLLATERAL_UTILIZATION*100).toFixed(0)}%), utilBudget=${remainingUtilizationBudget.toFixed(4)}, gasReserve=${dynamicGasReserve.toFixed(4)}, minFloor=${minFreeSuiFloor.toFixed(4)}, available=${availableForTrading.toFixed(4)}`);

    const MIN_POSITION_SIZE_SUI = 10;
    const minColl = agent.minCollateral ?? 0.5;
    const maxColl = agent.maxCollateral ?? agent.maxQty;
    const baseColl = Math.min(maxColl, availableForTrading);
    const tritonSizeMultiplier = tritonSignal ? Math.max(0.1, Math.min(1, tritonSignal.sizeMultiplier)) : 1;
    const consecutiveLossCount = getConsecutiveLosses(agent.id);
    const lossReductionFactor = consecutiveLossCount >= 3 ? 0.5 : consecutiveLossCount >= 2 ? 0.7 : consecutiveLossCount >= 1 ? 0.85 : 1.0;
    const capitalPlanSizeMultiplier = capitalPlan ? capitalPlan.sizeMultiplier : 1.0;
    let collateral = baseColl * tritonSizeMultiplier * lossReductionFactor * capitalPlanSizeMultiplier;
    if (collateral < minColl && availableForTrading >= minColl) {
      collateral = minColl;
    }
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

    if (quantity < MIN_POSITION_SIZE_SUI) {
      const msg = `Insufficient balance for min trade (qty=${quantity.toFixed(2)} SUI < ${MIN_POSITION_SIZE_SUI} SUI min, collateral=${collateral.toFixed(4)})`;
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

    const isSurvivalTrade = tritonSignal && (tritonSignal as any).__survivalMode;
    if (isSurvivalTrade) {
      const tightenedBps = Math.round(effectiveSlBps * 0.80);
      console.log(`[Survival] ${agent.name}: SL tightened 20% — ${effectiveSlBps}bps → ${tightenedBps}bps`);
      effectiveSlBps = tightenedBps;
    }

    const slCollateralLossPct = (effectiveSlBps / 10000) * 100 * agent.leverage;
    if (slCollateralLossPct > MAX_COLLATERAL_LOSS_PCT) {
      const cappedSlBps = Math.floor((MAX_COLLATERAL_LOSS_PCT / (100 * agent.leverage)) * 10000);
      console.log(`[Execution] SL auto-tightened for ${agent.name}: ${effectiveSlBps}bps would lose ${slCollateralLossPct.toFixed(1)}% collateral at ${agent.leverage}x → capped to ${cappedSlBps}bps (${MAX_COLLATERAL_LOSS_PCT}% max collateral loss)`);
      effectiveSlBps = cappedSlBps;
    }

    const liquidationMoveBps = Math.floor((1 / agent.leverage) * 10000);
    const maxSafeSLBps = Math.floor(liquidationMoveBps * 0.60);
    if (effectiveSlBps > maxSafeSLBps) {
      console.log(`[Execution] Leverage-aware SL cap for ${agent.name}: ${effectiveSlBps}bps exceeds 60% of liquidation distance (${liquidationMoveBps}bps at ${agent.leverage}x) → capped to ${maxSafeSLBps}bps`);
      effectiveSlBps = maxSafeSLBps;
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

    if (capitalPlan) {
      const postTradeFreeSui = onChainBalance - collateral;
      if (postTradeFreeSui < capitalPlan.freeSuiReserveTarget) {
        const msg = `CAPITAL_PLAN: Post-trade free SUI ${postTradeFreeSui.toFixed(3)} would fall below reserve target ${capitalPlan.freeSuiReserveTarget.toFixed(3)} — skipping new trade to preserve reserves (wallet=${onChainBalance.toFixed(3)}, collateral=${collateral.toFixed(3)}, openPos=${openPositions.length})`;
        console.log(`[Execution] ${agent.name}: ${msg}`);
        return null;
      }
    }

    const expectedCollateral = quantity / agent.leverage;
    console.log(`[Execution] Submitting ${direction} order for agent ${agent.name} on ${agent.venue}: qty=${quantity.toFixed(4)} SUI @ $${currentPrice.toFixed(4)} | leverage=${agent.leverage}x | collateral=${expectedCollateral.toFixed(4)} SUI (maxCollateral=${agent.maxQty}) | sizeMult=${tritonSizeMultiplier.toFixed(2)} capPlan=${capitalPlanSizeMultiplier.toFixed(2)} lossScale=${lossReductionFactor.toFixed(2)}(${consecutiveLossCount}L) maxPos=${dynamicMaxPositions} | signal=${signal}`);

    let result: DexOrderResult;
    try {
      result = await adapter.openPosition(orderParams);
    } catch (dexError: any) {
      const err = `DEX error: ${dexError.message}`;
      const dexErrMsg = String(dexError.message || "");
      console.log(`[Execution] DEX call failed for ${agent.name}: ${dexError.message} — no balance spent`);

      if (isRateLimitError(dexErrMsg)) {
        console.log(`[Execution] RPC rate limited during open for ${agent.name} — skipping (no gas penalty).`);
        return { success: false, error: err, venue: agent.venue };
      }

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

      if (isRateLimitError(errorStr)) {
        console.log(`[Execution] RPC rate limited during open result for ${agent.name} — skipping (no gas penalty).`);
        return { success: false, error: errorStr, venue: agent.venue };
      }

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

    if (result.filled === false && result.orderId) {
      console.log(`[Execution] Order ${result.orderId} for ${agent.name} NOT FILLED after 30s. Attempting cancel to recover collateral...`);

      if (adapter instanceof TypusAdapter) {
        const cancelResult = await adapter.cancelUnfilledOrder(agent.agentWallet, result.orderId);
        if (cancelResult.cancelled) {
          console.log(`[Execution] Successfully cancelled unfilled order ${result.orderId} for ${agent.name}. Collateral returned: ${cancelResult.collateralReturned}`);
          try {
            const walletAddr = decryptKeypair(agent.agentWallet).toSuiAddress();
            const onChainBal = await suiClient.getBalance({ owner: walletAddr, coinType: "0x2::sui::SUI" });
            const realBalance = Number(onChainBal.totalBalance) / 1e9;
            const positions = await storage.getPositions(agent.id);
            const openPos = positions.filter(p => (p.status === "open" || p.status === "pending_open"));
            const lockedColl = openPos.reduce((s, p) => s + (p.collateral || p.sizeSui / (agent.leverage || 25)), 0);
            await storage.updateAgent(agent.id, {
              balance: realBalance + lockedColl,
              lastExecutionError: `Order ${result.orderId} cancelled — collateral recovered. Balance synced: ${realBalance.toFixed(4)} SUI`,
              lastExecutionAt: new Date(),
            });
          } catch (syncErr: any) {
            await storage.updateAgent(agent.id, {
              lastExecutionError: `Order ${result.orderId} cancelled — collateral recovered`,
              lastExecutionAt: new Date(),
            });
          }
          return { success: false, error: `Order not filled within 30s — cancelled and collateral recovered`, venue: agent.venue };
        } else {
          console.log(`[Execution] FAILED to cancel unfilled order ${result.orderId} for ${agent.name}: ${cancelResult.error}. Order may fill later — tracking as pending.`);
          trackPendingUnfilledOrder(agent, result.orderId, result.txDigest!, currentPrice, direction, quantity, stopLossPrice, takeProfitPrice);

          try {
            const walletAddr = decryptKeypair(agent.agentWallet).toSuiAddress();
            const onChainBal = await suiClient.getBalance({ owner: walletAddr, coinType: "0x2::sui::SUI" });
            const realBalance = Number(onChainBal.totalBalance) / 1e9;
            const positions = await storage.getPositions(agent.id);
            const openPos = positions.filter(p => (p.status === "open" || p.status === "pending_open"));
            const lockedColl = openPos.reduce((s, p) => s + (p.collateral || p.sizeSui / (agent.leverage || 25)), 0);
            await storage.updateAgent(agent.id, {
              balance: realBalance + lockedColl,
              lastExecutionError: `Pending unfilled order ${result.orderId} — cancel failed, will retry. Balance synced: ${(realBalance + lockedColl).toFixed(4)} SUI`,
              lastExecutionAt: new Date(),
            });
            console.log(`[Execution] Balance synced after cancel failure: on-chain=${realBalance.toFixed(4)}+locked=${lockedColl.toFixed(4)} SUI`);
          } catch (syncErr: any) {
            await storage.updateAgent(agent.id, {
              lastExecutionError: `Pending unfilled order ${result.orderId} — cancel failed, will retry`,
              lastExecutionAt: new Date(),
            });
          }
          return { success: false, error: `Order pending — cancel attempt failed`, venue: agent.venue };
        }
      }

      return { success: false, error: `Order not filled and no cancel mechanism available`, venue: agent.venue };
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
      collateral: quantity / agent.leverage,
      entryPrice: currentPrice,
      markPrice: currentPrice,
      unrealizedPnl: 0,
      liquidationPrice: typusLiquidationPrice,
      txDigest: result.txDigest,
      status: "pending_open",
    });

    console.log(`[Execution] Position created as PENDING_OPEN for ${agent.name} (dbId=${position.id}, txDigest=${result.txDigest})`);
    console.log(`[Execution] Position protection for ${agent.name}: effectiveSL=$${stopLossPrice.toFixed(4)} (${effectiveSlBps}bps), typusLiquidation=$${typusLiquidationPrice.toFixed(4)}, maxCollateralLoss=${MAX_COLLATERAL_LOSS_PCT}%, buffer=${Math.abs(((stopLossPrice - typusLiquidationPrice) / currentPrice) * 100).toFixed(2)}% price`);

    trackSessionGasSpend(agent.id, GAS_PER_OPERATION_ESTIMATE);
    persistSessionGasToDb(agent.id);
    if (result.txDigest) {
      trackActualGasFromTx(agent.id, result.txDigest).catch(() => {});
    }

    const posUpdateFields: any = {};
    if (result.positionId) {
      posUpdateFields.onChainPositionId = result.positionId;
      posUpdateFields.status = "open";
      posUpdateFields.verified = true;
      console.log(`[Execution] On-chain position ID confirmed: ${result.positionId} — promoting to OPEN for DB position ${position.id}`);
    } else {
      console.log(`[Execution] WARNING: No on-chain positionId captured for ${agent.name} — position stays PENDING_OPEN, scheduling background resolution`);
      if (result.orderId) {
        trackPendingPositionResolution(position.id, agent.id, agent.name, agent.walletAddress!, result.orderId);
      }
      if (result.txDigest) {
        trackPendingDigestReconciliation(position.id, agent.id, agent.name, agent.walletAddress!, result.txDigest);
      }
    }
    if (result.orderId) {
      posUpdateFields.typusOrderId = result.orderId;
      console.log(`[Execution] Stored Typus order_id: ${result.orderId} for DB position ${position.id}`);
    }
    if (Object.keys(posUpdateFields).length > 0) {
      await storage.updatePosition(position.id, posUpdateFields);
    }

    try {
      const { broadcastPositionUpdate } = await import("../position-monitor");
      const allPos = await storage.getPositions(agent.id);
      const openPos = allPos.filter(p => p.status === "open" || p.status === "pending_open");
      broadcastPositionUpdate(agent.id, openPos.map(p => ({
        id: p.id, side: p.side, sizeSui: p.sizeSui, entryPrice: p.entryPrice,
        markPrice: p.markPrice, unrealizedPnl: p.unrealizedPnl,
        onChainPositionId: p.onChainPositionId, status: p.status, openedAt: p.openedAt,
      })));
    } catch {}

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

export async function closePositionForAgent(agent: Agent, positionId: string, currentPrice: number, allowDbFallback = false, closeReason?: string): Promise<{ closed: boolean; onChain: boolean; pnl: number; txDigest?: string; error?: string }> {
  const closeStartTime = Date.now();
  let pos = (await storage.getPositions(agent.id)).find(p => p.id === positionId);
  if (!pos || (pos.status !== "open" && pos.status !== "pending_open")) return { closed: false, onChain: false, pnl: 0 };

  const adapter = getAdapter(agent.venue);
  let onChainSuccess = false;
  let closeTxDigest: string | null = null;
  let closeError: string | null = null;
  let positionAlreadySettled = false;
  let preCloseOnChainBalance: number | null = null;

  const hasOnChainId = pos.onChainPositionId && !pos.onChainPositionId.includes("-");

  if (!hasOnChainId) {
    console.log(`[Execution] Close recovery for ${agent.name} pos ${pos.id}: no valid on-chain position ID (stored=${pos.onChainPositionId || "null"}, status=${pos.status}, txDigest=${pos.txDigest || "null"}). Running multi-level reconciliation...`);

    if (agent.walletAddress) {
      if (pos.txDigest) {
        try {
          console.log(`[Execution] Level 0: Reconciling from TX digest ${pos.txDigest} (objectChanges + events) for ${agent.name}...`);
          const digestResult = await reconcileFromDigest(pos.txDigest);
          if (digestResult.positionId) {
            console.log(`[Execution] Level 0 SUCCESS: Found position_id=${digestResult.positionId} from TX digest for ${agent.name}`);
            const updates: any = { onChainPositionId: digestResult.positionId, status: "open", verified: true };
            if (digestResult.orderId) updates.typusOrderId = digestResult.orderId;
            await storage.updatePosition(pos.id, updates);
            pos = { ...pos, onChainPositionId: digestResult.positionId, status: "open" };
          } else if (digestResult.orderId) {
            console.log(`[Execution] Level 0: Found order_id=${digestResult.orderId} from digest (no position_id). Storing and resolving...`);
            await storage.updatePosition(pos.id, { typusOrderId: digestResult.orderId });
            pos = { ...pos, typusOrderId: digestResult.orderId };
          }
        } catch (digestErr: any) {
          console.log(`[Execution] Level 0 digest reconciliation failed for ${agent.name}: ${digestErr.message}`);
        }
      }

      const stillNoId0 = !pos.onChainPositionId || pos.onChainPositionId.includes("-");
      if (stillNoId0) {
        const storedTypusOrderId = (pos as any).typusOrderId;
        if (storedTypusOrderId) {
          try {
            console.log(`[Execution] Level 1: Using stored typusOrderId=${storedTypusOrderId} for position resolution (${agent.name})`);
            const resolvedId = await TypusAdapter.resolvePositionIdFromOrderId(suiClient, agent.walletAddress, storedTypusOrderId);
            if (resolvedId) {
              console.log(`[Execution] Level 1 SUCCESS: position_id=${resolvedId} via typusOrderId=${storedTypusOrderId} for ${agent.name}`);
              await storage.updatePosition(pos.id, { onChainPositionId: resolvedId, status: "open", verified: true });
              pos = { ...pos, onChainPositionId: resolvedId, status: "open" };
            }
          } catch (resolveErr: any) {
            console.log(`[Execution] Level 1 failed for ${agent.name}: ${resolveErr.message}`);
          }
        }
      }

      const stillNoId1 = !pos.onChainPositionId || pos.onChainPositionId.includes("-");
      if (stillNoId1) {
        try {
          console.log(`[Execution] Level 2: Scanning wallet TX history for Typus order_id (${agent.name})...`);
          const typusOrderId = await TypusAdapter.findOrderIdFromWalletTxHistory(suiClient, agent.walletAddress);
          if (typusOrderId) {
            console.log(`[Execution] Level 2: Found order_id=${typusOrderId} from TX history. Resolving position_id...`);
            const resolvedId = await TypusAdapter.resolvePositionIdFromOrderId(suiClient, agent.walletAddress, typusOrderId);
            if (resolvedId) {
              console.log(`[Execution] Level 2 SUCCESS: position_id=${resolvedId} from TX-history order_id=${typusOrderId} for ${agent.name}`);
              await storage.updatePosition(pos.id, { onChainPositionId: resolvedId, typusOrderId, status: "open", verified: true });
              pos = { ...pos, onChainPositionId: resolvedId, status: "open" };
            }
          }
        } catch (txErr: any) {
          console.log(`[Execution] Level 2 TX-history resolution failed for ${agent.name}: ${txErr.message}`);
        }
      }

      const stillNoId2 = !pos.onChainPositionId || pos.onChainPositionId.includes("-");
      if (stillNoId2) {
        try {
          console.log(`[Execution] Level 3: Heuristic on-chain position matching for ${agent.name}...`);
          const openOnChain = await getAdapter(agent.venue)?.getPositions(agent.walletAddress);
          if (openOnChain && openOnChain.length > 0) {
            const match = openOnChain.find((op: any) => op.side === pos.side && Math.abs(op.size - pos.sizeSui) < 1);
            if (match && match.positionId) {
              console.log(`[Execution] Level 3 SUCCESS: MATCHED on-chain position for ${agent.name} by side/size: ${match.positionId}`);
              await storage.updatePosition(pos.id, { onChainPositionId: match.positionId, status: "open", verified: true });
              pos = { ...pos, onChainPositionId: match.positionId, status: "open" };
            } else {
              console.log(`[Execution] Level 3: No side/size match among ${openOnChain.length} on-chain positions for ${agent.name} (wanted ${pos.side} ${pos.sizeSui.toFixed(2)} SUI)`);
            }
          } else if (openOnChain && openOnChain.length === 0) {
            const expectedCollateral = pos.collateral || pos.sizeSui / (agent.leverage || 25);
            try {
              const balResp = await suiClient.getBalance({ owner: agent.walletAddress, coinType: "0x2::sui::SUI" });
              const onChainBal = Number(balResp.totalBalance) / 1e9;
              if (onChainBal >= expectedCollateral * 0.8) {
                console.log(`[Execution] Level 3: getPositions=0 but on-chain balance ${onChainBal.toFixed(4)} SUI confirms collateral returned. Settling as on-chain success (NOT liquidation).`);
                onChainSuccess = true;
                closeTxDigest = "settled_onchain";
                closeError = `Position not found on Typus and on-chain balance confirms collateral returned. Settled safely.`;
              } else {
                console.log(`[Execution] Level 3: getPositions=0 but balance ${onChainBal.toFixed(4)} SUI < collateral ${expectedCollateral.toFixed(4)} SUI. NOT force-settling.`);
              }
            } catch (balErr: any) {
              console.log(`[Execution] Balance check failed during force-settle guard: ${balErr.message}`);
            }
          }
        } catch (matchErr: any) {
          console.log(`[Execution] Level 3 getPositions match failed for ${agent.name}: ${matchErr.message}`);
        }
      }
    }

    const nowHasId = pos.onChainPositionId && !pos.onChainPositionId.includes("-");
    if (!nowHasId && !onChainSuccess) {
      if (pos.status === "pending_open") {
        console.log(`[Execution] Position ${pos.id} still PENDING_OPEN with no on-chain ID. Scheduling background recovery.`);
        if (pos.txDigest && !pendingDigestReconciliations.has(pos.id)) {
          trackPendingDigestReconciliation(pos.id, agent.id, agent.name, agent.walletAddress!, pos.txDigest);
        }
        return { closed: false, onChain: false, pnl: 0, error: `Position is PENDING_OPEN — on-chain ID not yet confirmed. Background recovery scheduled.` };
      }
      return { closed: false, onChain: false, pnl: 0, error: `Position has no on-chain ID — all recovery levels exhausted. Background Verify & Recover will continue attempting resolution.` };
    }
  }

  if (adapter instanceof TypusAdapter && agent.walletAddress && pos.onChainPositionId) {
    try {
      const priorFill = await (adapter as TypusAdapter).checkPriorCloseFilled(agent.walletAddress, pos.onChainPositionId);
      if (priorFill.filled) {
        console.log(`[Execution] Position ${pos.onChainPositionId} for ${agent.name} was ALREADY closed on-chain (fill TX: ${priorFill.txDigest}). Settling in DB as on-chain success.`);
        onChainSuccess = true;
        closeTxDigest = priorFill.txDigest || "prior_fill";
        clearCloseGasTracking(pos.id);
      }
    } catch (checkErr: any) {
      console.log(`[Execution] Prior close fill check failed for ${agent.name}: ${checkErr.message} — continuing`);
    }
  }

  if (!onChainSuccess && adapter instanceof TypusAdapter && agent.walletAddress && pos.onChainPositionId) {
    try {
      const openOnChain = await (adapter as TypusAdapter).getPositions(agent.walletAddress);
      const existsOnChain = openOnChain.some((op: any) => String(op.positionId) === String(pos.onChainPositionId));
      if (!existsOnChain) {
        const posCollateral = pos.collateral || pos.sizeSui / (agent.leverage || 25);
        try {
          const balCheck = await suiClient.getBalance({ owner: agent.walletAddress, coinType: "0x2::sui::SUI" });
          const walletBal = Number(balCheck.totalBalance) / 1e9;
          const allPos = await storage.getPositions(agent.id);
          const otherOpen = allPos.filter(p => p.id !== pos.id && (p.status === "open" || p.status === "pending_open"));
          const otherLocked = otherOpen.reduce((s, p) => s + (p.collateral || p.sizeSui / (agent.leverage || 25)), 0);
          const freeBalance = walletBal - otherLocked;

          if (freeBalance >= posCollateral * 0.5) {
            console.log(`[Execution] PRE-CLOSE CHECK: Position ${pos.onChainPositionId} NOT found on Typus (${openOnChain.length} positions) AND balance confirms collateral returned (free=${freeBalance.toFixed(4)}, collateral=${posCollateral.toFixed(4)}). Settling as on-chain success (NOT liquidation).`);
            onChainSuccess = true;
            closeTxDigest = "settled_onchain";
            closeError = `Position not found on Typus and balance confirms settlement.`;
            clearCloseGasTracking(pos.id);
          } else {
            console.log(`[Execution] PRE-CLOSE CHECK: Position ${pos.onChainPositionId} NOT found via getPositions (${openOnChain.length} positions) but balance low (free=${freeBalance.toFixed(4)}, collateral=${posCollateral.toFixed(4)}). getPositions may be unreliable — attempting close TX anyway.`);
          }
        } catch (balErr: any) {
          console.log(`[Execution] PRE-CLOSE balance check failed: ${balErr.message} — attempting close TX anyway`);
        }
      }
    } catch (existErr: any) {
      console.log(`[Execution] Pre-close position existence check failed: ${existErr.message} — continuing`);
    }
  }

  const isManualClose = closeReason === "manual";
  const isEmergencyClose = closeReason === "emergency-liquidation-prevent" || closeReason === "max-collateral-loss" || closeReason === "blocked-recovery" || closeReason === "emergency-force-settle";
  const closeGasStatus = getCloseGasSpent(pos.id);
  const dbCloseAttempts = pos.closeAttempts || 0;
  if (!onChainSuccess && !isManualClose && !isEmergencyClose && (closeGasStatus.totalSui >= MAX_CLOSE_GAS_PER_POSITION_SUI || closeGasStatus.attempts >= MAX_CLOSE_ATTEMPTS_PER_POSITION || dbCloseAttempts >= MAX_CLOSE_ATTEMPTS_TOTAL)) {
    console.log(`[Execution] CLOSE_GAS_CAP for ${agent.name} pos ${pos.id}: ${closeGasStatus.totalSui.toFixed(4)} SUI gas across ${closeGasStatus.attempts} in-memory / ${dbCloseAttempts} DB attempts. Pausing agent.`);
    logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: `CLOSE_GAS_CAP: ${closeGasStatus.totalSui.toFixed(4)} SUI gas across ${closeGasStatus.attempts} attempts`, closeReason: closeReason, attemptNumber: closeGasStatus.attempts });
    await updateCloseState(pos.id, { closeState: "manual_review" });
    await storage.updateAgent(agent.id, {
      status: "paused",
      lastExecutionError: `CLOSE_GAS_CAP: Position ${pos.onChainPositionId} exceeded close attempt limits (${dbCloseAttempts} DB / ${closeGasStatus.attempts} in-mem, ${closeGasStatus.totalSui.toFixed(4)} SUI gas). Agent paused — use Verify & Recover or close manually.`,
    });
    return { closed: false, onChain: false, pnl: 0, error: "CLOSE_GAS_CAP: Gas cap reached — agent paused for manual review" };
  }
  if (isEmergencyClose && (closeGasStatus.attempts > 0 || dbCloseAttempts > 0)) {
    let walletBalForReset = -1;
    try {
      const keypairForCheck = decryptKeypair(agent.agentWallet!);
      const walletAddrForCheck = keypairForCheck.toSuiAddress();
      const balResp = await suiClient.getBalance({ owner: walletAddrForCheck, coinType: "0x2::sui::SUI" });
      walletBalForReset = Number(balResp.totalBalance) / 1e9;
    } catch {}

    if (walletBalForReset >= 0 && walletBalForReset < LOW_GAS_THRESHOLD_SUI) {
      console.log(`[Execution] EMERGENCY: ${agent.name} pos ${pos.id} — wallet has ${walletBalForReset.toFixed(4)} SUI, keeping gas tracking (${closeGasStatus.attempts} attempts, ${closeGasStatus.totalSui.toFixed(4)} SUI spent). Not resetting to prevent gas drain.`);
    } else {
      console.log(`[Execution] EMERGENCY BYPASS: Resetting gas tracking for ${agent.name} pos ${pos.id} (${closeReason}). Was ${dbCloseAttempts} DB / ${closeGasStatus.attempts} in-mem attempts.`);
      clearCloseGasTracking(pos.id);
      positionCloseCooldown.delete(pos.id);
      pendingCloseOrders.delete(pos.id);
      await updateCloseState(pos.id, { closeState: "close_requested", closeAttempts: 0, closePendingSince: null });
      pos = { ...pos, closeAttempts: 0, closeState: "close_requested" } as any;
    }
    if (agent.status === "paused") {
      await storage.updateAgent(agent.id, { status: "running", lastExecutionError: null });
    }
  }

  if (isManualClose && manualCloseInProgress.has(pos.id)) {
    return { closed: false, onChain: false, pnl: 0, error: "BLOCKED: A manual close is already in progress for this position. Please wait." };
  }

  if (isManualClose && (closeGasStatus.attempts > 0 || dbCloseAttempts > 0)) {
    console.log(`[Execution] MANUAL CLOSE: Resetting close state for ${agent.name} pos ${pos.id} (was ${dbCloseAttempts} DB / ${closeGasStatus.attempts} in-mem attempts). User-initiated override.`);
    clearCloseGasTracking(pos.id);
    positionCloseCooldown.delete(pos.id);
    pendingCloseOrders.delete(pos.id);
    await updateCloseState(pos.id, { closeState: "close_requested", closeAttempts: 0, closePendingSince: null });
    pos = { ...pos, closeAttempts: 0, closeState: "close_requested" } as any;
  }

  if (isManualClose) {
    manualCloseInProgress.add(pos.id);
  }

  try {
  return await _closePositionForAgentInner(agent, pos, adapter, currentPrice, allowDbFallback, closeReason, onChainSuccess, closeTxDigest, closeError, positionAlreadySettled, preCloseOnChainBalance, isManualClose, closeStartTime, hasOnChainId);
  } finally {
    if (isManualClose) {
      manualCloseInProgress.delete(pos.id);
    }
  }
}

async function _closePositionForAgentInner(
  agent: Agent, pos: any, adapter: any, currentPrice: number,
  allowDbFallback: boolean, closeReason: string | undefined,
  onChainSuccess: boolean, closeTxDigest: string | null, closeError: string | null,
  positionAlreadySettled: boolean, preCloseOnChainBalance: number | null,
  isManualClose: boolean, closeStartTime: number, hasOnChainId: boolean
): Promise<{ closed: boolean; onChain: boolean; pnl: number; txDigest?: string; error?: string }> {

  const closeId = pos.onChainPositionId || pos.id;
  let positionGoneFromDex = false;
  let closeTxWasAttempted = false;

  if (adapter && agent.agentWallet && !onChainSuccess) {
    try {
      const keypair = decryptKeypair(agent.agentWallet);
      const walletAddr = keypair.toSuiAddress();

      try {
        const balResp = await suiClient.getBalance({ owner: walletAddr, coinType: "0x2::sui::SUI" });
        preCloseOnChainBalance = Number(balResp.totalBalance) / 1e9;
      } catch {}

      const isEmergencyOrManual = closeReason === "emergency-liquidation-prevent" || closeReason === "max-collateral-loss" || closeReason === "blocked-recovery" || closeReason === "manual";
      const isProtectiveClose = closeReason === "stop-loss" || closeReason === "trailing-stop" || isEmergencyOrManual;

      let gasCheckPassed = false;
      let gasCheckAttempts = 0;
      const maxGasRetries = isManualClose ? 3 : (isProtectiveClose ? 2 : 1);
      while (gasCheckAttempts < maxGasRetries && !gasCheckPassed) {
        gasCheckAttempts++;
        const gasCheck = await ensureMinGasReserve(suiClient, walletAddr);
        if (gasCheck.ok) {
          gasCheckPassed = true;
          break;
        }

        const walletBal = (gasCheck as any).balanceSui ?? -1;
        const belowHardFloor = walletBal >= 0 && walletBal < HARD_GAS_FLOOR_SUI;

        if (belowHardFloor) {
          closeError = `INSUFFICIENT_GAS: Wallet has ${walletBal.toFixed(4)} SUI — below hard floor (${HARD_GAS_FLOOR_SUI} SUI). Cannot execute any transaction.`;
          console.log(`[Execution] HARD GAS FLOOR: ${agent.name} has ${walletBal.toFixed(4)} SUI — blocking ALL close attempts including ${closeReason}. Agent needs gas top-off.`);
          return { closed: false, onChain: false, pnl: 0, error: closeError };
        }

        if ((gasCheck as any).isRateLimit) {
          if ((isManualClose || isProtectiveClose) && gasCheckAttempts < maxGasRetries) {
            console.log(`[Execution] RPC rate limited during gas check for ${agent.name} — ${closeReason} retry ${gasCheckAttempts}/${maxGasRetries} in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          if (isEmergencyOrManual || isProtectiveClose) {
            console.log(`[Execution] ${isEmergencyOrManual ? "EMERGENCY/MANUAL" : "PROTECTIVE"}: Gas check rate-limited for ${agent.name} — attempting ${closeReason} close anyway.`);
            gasCheckPassed = true;
            break;
          }
          console.log(`[Execution] RPC rate limited during gas check for ${agent.name} — skipping close this tick (no gas spent, no penalty).`);
          return { closed: false, onChain: false, pnl: 0, error: `RATE_LIMITED: ${gasCheck.reason}` };
        }
        if (isEmergencyOrManual) {
          console.log(`[Execution] EMERGENCY/MANUAL: Gas reserve low for ${agent.name} (${gasCheck.reason}) — attempting close anyway to prevent liquidation.`);
          gasCheckPassed = true;
          break;
        } else if (isProtectiveClose && gasCheckAttempts < maxGasRetries) {
          console.log(`[Execution] Gas low for ${closeReason} on ${agent.name} — retry ${gasCheckAttempts}/${maxGasRetries} in 2s...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        } else if (isProtectiveClose) {
          console.log(`[Execution] PROTECTIVE: Gas reserve low for ${agent.name} (${gasCheck.reason}) — attempting ${closeReason} close anyway (protective closes should not be blocked by gas).`);
          gasCheckPassed = true;
          break;
        } else {
          closeError = `INSUFFICIENT_GAS: ${gasCheck.reason}`;
          console.log(`[Execution] Close skipped for ${agent.name}: ${closeError}`);
          return { closed: false, onChain: false, pnl: 0, error: closeError };
        }
      }
    } catch (gasErr: any) {
      const gasErrMsg = String(gasErr?.message ?? gasErr);
      if (isRateLimitError(gasErrMsg)) {
        if (isManualClose || isProtectiveClose) {
          console.log(`[Execution] RPC rate limited during gas check for ${agent.name} — ${closeReason} close proceeding anyway.`);
        } else {
          console.log(`[Execution] RPC rate limited during gas check for ${agent.name} — skipping close this tick (no gas spent, no penalty).`);
          return { closed: false, onChain: false, pnl: 0, error: `RATE_LIMITED: ${gasErrMsg}` };
        }
      }
      const isEmergencyOrManual2 = closeReason === "emergency-liquidation-prevent" || closeReason === "max-collateral-loss" || closeReason === "blocked-recovery" || closeReason === "manual";
      const isProtectiveClose2 = closeReason === "stop-loss" || closeReason === "trailing-stop" || isEmergencyOrManual2;
      if (isEmergencyOrManual2) {
        console.log(`[Execution] EMERGENCY/MANUAL: Gas check failed for ${agent.name} (${gasErr.message}) — attempting close anyway.`);
      } else if (isProtectiveClose2) {
        console.log(`[Execution] PROTECTIVE: Gas check failed for ${agent.name} (${gasErr.message}) — attempting ${closeReason} close anyway.`);
      } else {
        closeError = `INSUFFICIENT_GAS: ${gasErr.message}`;
        console.log(`[Execution] Gas check failed for close ${agent.name}: ${gasErr.message}`);
        logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: closeError, closeReason });
        return { closed: false, onChain: false, pnl: 0, error: closeError };
      }
    }

    console.log(`[Execution] Closing position for ${agent.name}: dbId=${pos.id}, onChainId=${pos.onChainPositionId || "NONE"}, using=${closeId}`);

    if (!onChainSuccess) {
      const cs = await getCloseState(pos);

      const isEmergencyReason = closeReason === "emergency-liquidation-prevent" || closeReason === "max-collateral-loss" || closeReason === "blocked-recovery" || closeReason === "emergency-force-settle";
      if (!isManualClose && !isEmergencyReason && cs.closeAttempts >= MAX_CLOSE_ATTEMPTS_TOTAL) {
        console.log(`[Execution] HARD STOP: ${agent.name} pos ${pos.id} has ${cs.closeAttempts} close attempts (max ${MAX_CLOSE_ATTEMPTS_TOTAL}). Entering manual_review.`);
        logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: `CLOSE_ATTEMPT_CAP: ${cs.closeAttempts} attempts exceeded max ${MAX_CLOSE_ATTEMPTS_TOTAL}`, closeReason, attemptNumber: cs.closeAttempts });
        await updateCloseState(pos.id, { closeState: "manual_review" });
        await storage.updateAgent(agent.id, {
          status: "paused",
          lastExecutionError: `CLOSE_GAS_CAP: Position ${pos.onChainPositionId || pos.id} exceeded ${MAX_CLOSE_ATTEMPTS_TOTAL} close attempts. Agent paused — use Verify & Recover or close manually.`,
        });
        return { closed: false, onChain: false, pnl: 0, error: `CLOSE_GAS_CAP: Max close attempts (${MAX_CLOSE_ATTEMPTS_TOTAL}) reached — agent paused for manual review` };
      }
      if (isEmergencyReason && cs.closeAttempts >= MAX_CLOSE_ATTEMPTS_TOTAL) {
        if (cs.closeAttempts < MAX_CLOSE_ATTEMPTS_TOTAL * 2) {
          console.log(`[Execution] EMERGENCY: Allowing one more close attempt for ${agent.name} pos ${pos.id} (${closeReason}, attempts=${cs.closeAttempts}).`);
          await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
        } else {
          console.log(`[Execution] EMERGENCY: ${agent.name} pos ${pos.id} exceeded ${cs.closeAttempts} attempts (2x cap). Stopping retries to conserve gas.`);
          return { closed: false, onChain: false, pnl: 0, error: `CLOSE_PERMANENTLY_BLOCKED: Emergency close exceeded ${cs.closeAttempts} attempts. Manual intervention required.` };
        }
      }
      if (isClosePending(cs) && !isManualClose && !isEmergencyReason) {
        const pendingAgeMs = closePendingAge(cs);
        const pendingAgeSec = Math.round(pendingAgeMs / 1000);
        console.log(`[Execution] Skipping close TX for ${agent.name} pos ${pos.id} — close order already working (age ${pendingAgeSec}s, tx=${cs.lastCloseTx || "unknown"}). Waiting for fill.`);
        positionCloseCooldown.set(pos.id, Date.now() + CLOSE_COOLDOWN_MS);
        return { closed: false, onChain: false, pnl: 0, error: `close_pending: Close order pending on Typus (${pendingAgeSec}s ago, tx=${cs.lastCloseTx || "unknown"}). Waiting for fill — NOT resubmitting.` };
      }
      if (isClosePending(cs) && isEmergencyReason) {
        console.log(`[Execution] EMERGENCY: Overriding close_pending for ${agent.name} pos ${pos.id} (${closeReason}). Cancelling stale order and resubmitting.`);
        if (adapter instanceof TypusAdapter && agent.agentWallet && pos.onChainPositionId) {
          try {
            await (adapter as TypusAdapter).cancelPendingOrdersForPosition(agent.agentWallet, pos.onChainPositionId);
          } catch (cancelErr: any) {
            console.log(`[Execution] Emergency cancel error (proceeding anyway): ${cancelErr.message}`);
          }
        }
        await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
        pendingCloseOrders.delete(pos.id);
      }

      if ((cs.closeState === "close_order_working" || cs.closeState === "close_tx_submitted") && cs.closePendingSince) {
        const pendingAgeMs = closePendingAge(cs);
        console.log(`[Execution] Close pending TTL expired for ${agent.name} pos ${pos.id} (${Math.round(pendingAgeMs / 1000)}s). Cancelling stale orders before retry.`);
        if (adapter instanceof TypusAdapter && agent.agentWallet && pos.onChainPositionId) {
          try {
            await (adapter as TypusAdapter).cancelPendingOrdersForPosition(agent.agentWallet, pos.onChainPositionId);
          } catch (cancelErr: any) {
            console.log(`[Execution] Cancel pending orders failed for ${agent.name}: ${cancelErr.message}`);
          }
        }
        await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
        pendingCloseOrders.delete(pos.id);
      }

      const lastAttemptAt = cs.closePendingSince ? new Date(cs.closePendingSince).getTime() : 0;
      if (!isManualClose && !isEmergencyReason && lastAttemptAt > 0 && (Date.now() - lastAttemptAt) < MIN_CLOSE_RETRY_GAP_MS) {
        const waitSec = Math.round((MIN_CLOSE_RETRY_GAP_MS - (Date.now() - lastAttemptAt)) / 1000);
        console.log(`[Execution] Close retry gap not met for ${agent.name} pos ${pos.id} — wait ${waitSec}s before next attempt.`);
        return { closed: false, onChain: false, pnl: 0, error: `close_pending: Retry gap — next attempt in ${waitSec}s.` };
      }

      if (!onChainSuccess) {
        const preEmptiveActions = getPositionClosePreEmptiveActions(agent.id, pos.id);
        if (preEmptiveActions.includes("pre_cancel_linked_orders") && adapter instanceof TypusAdapter && agent.agentWallet && pos.onChainPositionId) {
          try {
            console.log(`[Execution] PRE-EMPTIVE: Cancelling linked orders for ${agent.name} pos ${pos.onChainPositionId} (learning engine recommended)`);
            await (adapter as TypusAdapter).cancelPendingOrdersForPosition(agent.agentWallet, pos.onChainPositionId);
          } catch (preCancelErr: any) {
            console.log(`[Execution] Pre-emptive cancel error (non-fatal): ${preCancelErr.message?.slice(0, 100)}`);
          }
        }
        if (preEmptiveActions.includes("stagger_close_delay")) {
          const jitter = Math.floor(Math.random() * 2000) + 500;
          await new Promise(r => setTimeout(r, jitter));
        }
        if (preEmptiveActions.includes("extended_backoff")) {
          const backoff = Math.floor(Math.random() * 1500) + 1000;
          console.log(`[Execution] PRE-EMPTIVE: Extended backoff ${backoff}ms for ${agent.name} pos ${pos.id} (rate-limit history)`);
          await new Promise(r => setTimeout(r, backoff));
        }
        const skipDryRun = preEmptiveActions.includes("skip_dry_run");

        await updateCloseState(pos.id, {
          closeState: "close_tx_submitted",
        });

        try {
          closeTxWasAttempted = true;
          const result = await adapter.closePosition({
            agent,
            positionId: closeId,
            side: pos.side as "long" | "short",
            quantity: pos.sizeSui,
            price: currentPrice,
            skipDryRun,
          });

          const alreadyClosed = (result as any).alreadyClosedOnChain === true;
          const likelyLiquidated = (result as any).likelyLiquidated === true;
          if (!alreadyClosed) {
            const resultError = (result as any).error || "";
            const wasRateLimited = isRateLimitError(String(resultError));
            if (!wasRateLimited) {
              trackCloseGasSpend(pos.id, 50_000_000);
            }
            await updateCloseState(pos.id, {
              closeAttempts: (cs.closeAttempts || 0) + 1,
              closePendingSince: new Date(),
            });
          }

          if (likelyLiquidated && alreadyClosed) {
            const priceMoveCheck = pos.side === "long"
              ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
              : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
            const collLossPctCheck = Math.abs(Math.min(0, priceMoveCheck)) * (agent.leverage || 25);
            if (collLossPctCheck < 80) {
              console.log(`[Execution] Position ${pos.onChainPositionId || pos.id} for ${agent.name} reported as likelyLiquidated but price says only ${collLossPctCheck.toFixed(1)}% collateral loss — NOT a liquidation. Treating as position-gone/settled.`);
              closeError = "key_not_found";
              positionGoneFromDex = true;
            } else {
              let liqEventConfirmed = false;
              try {
                const scanTxs = await suiClient.queryTransactionBlocks({
                  filter: { ToAddress: agent.walletAddress || "" },
                  options: { showEvents: true },
                  limit: 25,
                  order: "descending" as any,
                });
                for (const txBlock of (scanTxs?.data || [])) {
                  for (const evt of ((txBlock as any).events || [])) {
                    const parsed = (evt as any).parsedJson;
                    const evtType = (evt as any).type || "";
                    if (parsed && evtType.includes("LiquidateEvent") && String(parsed.position_id) === String(pos.onChainPositionId)) {
                      liqEventConfirmed = true;
                      closeTxDigest = (txBlock as any).digest || "liquidated_onchain";
                      break;
                    }
                  }
                  if (liqEventConfirmed) break;
                }
              } catch {}

              if (liqEventConfirmed) {
                console.log(`[Execution] Position ${pos.onChainPositionId || pos.id} for ${agent.name} CONFIRMED LIQUIDATED on-chain via LiquidateEvent.`);
                const liqCollateral = pos.collateral || pos.sizeSui / (agent.leverage || 25);
                onChainSuccess = true;
                closeTxDigest = closeTxDigest || "liquidated_onchain";
                positionAlreadySettled = true;
                closeError = `Position liquidated on-chain. Collateral lost.`;
                clearCloseGasTracking(pos.id);
                await updateCloseState(pos.id, { closeState: "closed", lastCloseTx: closeTxDigest, closePendingSince: null });
                pendingCloseOrders.delete(pos.id);
                await storage.updatePosition(pos.id, {
                  status: "closed",
                  closedAt: new Date(),
                  closePrice: currentPrice,
                  closeTxDigest: closeTxDigest,
                  pnl: -liqCollateral,
                  closeReason: "liquidated",
                });
                console.log(`[Execution] Liquidation recorded: ${agent.name} pos ${pos.id}, collateral lost: ${liqCollateral.toFixed(4)} SUI`);
                return { closed: true, onChain: true, pnl: -liqCollateral, txDigest: closeTxDigest, error: "LIQUIDATED" };
              } else {
                console.log(`[Execution] Position ${pos.onChainPositionId || pos.id} for ${agent.name} reported likelyLiquidated but NO LiquidateEvent found on-chain. Deferring to positionGoneFromDex analysis.`);
                closeError = "key_not_found";
                positionGoneFromDex = true;
              }
            }
          }

          if (result.success && !likelyLiquidated && (alreadyClosed || (result.txDigest && !result.txDigest.startsWith("sim_")))) {
            if (result.orderId && !alreadyClosed) {
              try {
                await storage.createTrackedOrder({
                  agentId: agent.id,
                  positionDbId: pos.id,
                  typusOrderId: String(result.orderId),
                  linkedPositionId: pos.onChainPositionId || null,
                  orderType: "close",
                  txDigest: result.txDigest || null,
                  status: result.filled ? "filled" : "submitted",
                  fillTxDigest: result.filled ? (result.txDigest || null) : null,
                  resolvedAt: result.filled ? new Date() : null,
                });
                console.log(`[Execution] Tracked close order ${result.orderId} in DB for ${agent.name} pos ${pos.id} (filled=${result.filled})`);
              } catch (trackErr: any) {
                console.log(`[Execution] Failed to track close order: ${trackErr.message}`);
              }
            }

            if (!alreadyClosed && result.filled === false) {
              console.log(`[Execution] DEX close TX submitted for ${agent.name} (tx=${result.txDigest}) but close order NOT FILLED. Pending on Typus — will NOT resubmit.`);
              await updateCloseState(pos.id, {
                closeState: "close_order_working",
                lastCloseTx: result.txDigest || null,
                closePendingSince: new Date(),
              });
              pendingCloseOrders.set(pos.id, { orderId: result.orderId, txDigest: result.txDigest, setAt: Date.now() });
              positionCloseCooldown.set(pos.id, Date.now() + CLOSE_COOLDOWN_MS);
              return { closed: false, onChain: false, pnl: 0, error: `close_pending: Close order submitted on-chain (TX: ${result.txDigest}) but awaiting fill. Will auto-close when filled.` };
            }
            onChainSuccess = true;
            closeTxDigest = result.txDigest || "keeper_filled";

            if (!alreadyClosed && adapter instanceof TypusAdapter && agent.walletAddress && pos.onChainPositionId) {
              try {
                await new Promise(r => setTimeout(r, 2000));
                const onChainPositions = await adapter.getPositions(agent.walletAddress);
                const stillOpen = onChainPositions.some(p => String(p.positionId) === String(pos.onChainPositionId));
                if (stillOpen) {
                  console.log(`[Execution] WARNING: Close TX succeeded (tx=${closeTxDigest}) but position ${pos.onChainPositionId} still visible on-chain for ${agent.name}. Keeping open for retry.`);
                  onChainSuccess = false;
                  closeTxDigest = null;
                  await updateCloseState(pos.id, { closeState: "close_order_working", lastCloseTx: result.txDigest || null, closePendingSince: new Date() });
                  pendingCloseOrders.set(pos.id, { orderId: result.orderId, txDigest: result.txDigest, setAt: Date.now() });
                  return { closed: false, onChain: false, pnl: 0, error: `close_confirmed_still_open: TX ${result.txDigest} succeeded but position still on-chain. Will auto-retry.` };
                }
                console.log(`[Execution] Close confirmation: position ${pos.onChainPositionId} confirmed GONE from on-chain for ${agent.name}.`);
              } catch (confirmErr: any) {
                console.log(`[Execution] Close confirmation check failed (${confirmErr.message?.slice(0, 80)}) — proceeding with close settlement.`);
              }
            }

            await updateCloseState(pos.id, { closeState: "closed", lastCloseTx: result.txDigest || null, closePendingSince: null });
            pendingCloseOrders.delete(pos.id);
            clearCloseGasTracking(pos.id);
            if (alreadyClosed) {
              console.log(`[Execution] Position already closed on-chain by keeper for ${agent.name}: tx=${closeTxDigest}`);
            } else {
              console.log(`[Execution] DEX close SUCCESS for ${agent.name}: tx=${result.txDigest} (filled=true, on-chain confirmed)`);
            }
          } else {
            closeError = result.error || "close failed — unknown reason";
            console.log(`[Execution] DEX close returned no valid txDigest for ${agent.name}: ${closeError}`);

            const errIsClosePending = closeError.includes("close_pending") || closeError.includes("awaiting fill");
            if (errIsClosePending) {
              console.log(`[Execution] close_pending detected in error for ${agent.name} pos ${pos.id} — NOT resubmitting. Keeping existing closePendingSince.`);
              await updateCloseState(pos.id, { closeState: "close_order_working" });
              positionCloseCooldown.set(pos.id, Date.now() + CLOSE_COOLDOWN_MS);
              return { closed: false, onChain: false, pnl: 0, error: closeError };
            }

            if ((result as any).correctedPositionId) {
              const correctedId = (result as any).correctedPositionId;
              console.log(`[Execution] Adapter found corrected position ID for ${agent.name}: stored=${pos.onChainPositionId} → corrected=${correctedId}. Updating DB and will retry on next cycle.`);
              await storage.updatePosition(pos.id, { onChainPositionId: correctedId });
              pos = { ...pos, onChainPositionId: correctedId };
              await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
              positionCloseCooldown.set(pos.id, Date.now() + 5000);
              return { closed: false, onChain: false, pnl: 0, error: `Corrected position ID to ${correctedId} — retrying on next cycle.` };
            }

            if (closeError.includes("order_not_found") || closeError.includes("position_not_found")) {
              console.log(`[Execution] TERMINAL: order_not_found for ${agent.name} pos ${pos.id}. Position gone from on-chain — stopping retries.`);
              logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: closeError, closeReason, attemptNumber: (pos.closeAttempts || 0) + 1 });
              positionGoneFromDex = true;
              await updateCloseState(pos.id, { closeState: "manual_review" });
            } else if (closeError.includes("CLOSE_PERMANENTLY_BLOCKED")) {
              console.log(`[Execution] CLOSE_PERMANENTLY_BLOCKED for ${agent.name} pos ${pos.id} — pausing agent to prevent gas drain.`);
              logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: closeError, closeReason, attemptNumber: (pos.closeAttempts || 0) + 1 });
              await updateCloseState(pos.id, { closeState: "manual_review" });
              await storage.updateAgent(agent.id, {
                status: "paused",
                lastExecutionError: closeError,
              });
              return { closed: false, onChain: false, pnl: 0, error: closeError };
            } else if (closeError.includes("too_many_linked_orders")) {
              console.log(`[Execution] too_many_linked_orders for ${agent.name} pos ${pos.id} — cooldown ${CLOSE_COOLDOWN_MS / 1000}s.`);
              logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: closeError, closeReason, attemptNumber: (pos.closeAttempts || 0) + 1 });
              await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
              positionCloseCooldown.set(pos.id, Date.now() + CLOSE_COOLDOWN_MS);
              return { closed: false, onChain: false, pnl: 0, error: `too_many_linked_orders: Will retry in ${CLOSE_COOLDOWN_MS / 1000}s.` };
            } else {
              logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: closeError || "close TX failed — unknown", closeReason, attemptNumber: (pos.closeAttempts || 0) + 1 });
              await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
            }
          }
        } catch (err: any) {
          closeError = err.message || "close failed — unknown reason";
          console.log(`[Execution] DEX close failed for ${agent.name}: ${err.message}`);

          if (isRateLimitError(closeError)) {
            console.log(`[Execution] RPC rate limited during close TX for ${agent.name} pos ${pos.id} — no gas spent, skipping this tick.`);
            logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: `RATE_LIMITED: ${closeError}`, closeReason });
            positionCloseCooldown.set(pos.id, Date.now() + 5_000);
            return { closed: false, onChain: false, pnl: 0, error: `RATE_LIMITED: ${closeError}` };
          }

          const errIsClosePending = closeError.includes("close_pending") || closeError.includes("awaiting fill");
          if (errIsClosePending) {
            logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: closeError, closeReason });
            await updateCloseState(pos.id, { closeState: "close_order_working" });
            positionCloseCooldown.set(pos.id, Date.now() + CLOSE_COOLDOWN_MS);
            return { closed: false, onChain: false, pnl: 0, error: closeError };
          }

          if (closeError.includes("order_not_found") || closeError.includes("position_not_found")) {
            console.log(`[Execution] TERMINAL (exc): order_not_found for ${agent.name} pos ${pos.id}. Stopping retries.`);
            logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: closeError, closeReason });
            positionGoneFromDex = true;
            await updateCloseState(pos.id, { closeState: "manual_review" });
          } else if (closeError.includes("CLOSE_PERMANENTLY_BLOCKED")) {
            console.log(`[Execution] CLOSE_PERMANENTLY_BLOCKED (exc) for ${agent.name} pos ${pos.id} — pausing agent.`);
            logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: closeError, closeReason });
            await updateCloseState(pos.id, { closeState: "manual_review" });
            await storage.updateAgent(agent.id, { status: "paused", lastExecutionError: closeError });
            return { closed: false, onChain: false, pnl: 0, error: closeError };
          } else if (closeError.includes("too_many_linked_orders")) {
            logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: closeError, closeReason });
            await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
            positionCloseCooldown.set(pos.id, Date.now() + CLOSE_COOLDOWN_MS);
            return { closed: false, onChain: false, pnl: 0, error: `too_many_linked_orders: Will retry in ${CLOSE_COOLDOWN_MS / 1000}s.` };
          } else {
            logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: closeError, closeReason });
          }

          await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
        }
      }
    }
  }

  if (closeTxWasAttempted) {
    positionGoneFromDex = positionGoneFromDex || !!(closeError && (closeError.includes("key_not_found") || closeError.includes("keyed_big_vector") || closeError.includes("order_not_found") || closeError.includes("position_not_found")));
  }

  if (positionGoneFromDex && !onChainSuccess && agent.walletAddress && pos.onChainPositionId) {
    console.log(`[Execution] key_not_found for ${agent.name} position ${pos.onChainPositionId}. Checking if stored ID is order_id vs actual position_id...`);
    try {
      const resolvedId = await TypusAdapter.resolvePositionIdFromOrderId(
        suiClient, agent.walletAddress, pos.onChainPositionId
      );
      if (resolvedId && resolvedId !== pos.onChainPositionId) {
        console.log(`[Execution] POSITION ID MISMATCH for ${agent.name}: stored=${pos.onChainPositionId} (order_id), actual=${resolvedId} (position_id). Updating and retrying close...`);
        await storage.updatePosition(pos.id, { onChainPositionId: resolvedId });
        pos = { ...pos, onChainPositionId: resolvedId };

        try {
          const retryGasCheck = trackCloseGasSpend(pos.id, 50_000_000);
          if (retryGasCheck.exceeded) {
            console.log(`[Execution] ${retryGasCheck.reason} — pausing agent for manual review instead of force-settling`);
            clearCloseGasTracking(pos.id);
            await storage.updateAgent(agent.id, {
              status: "paused",
              lastExecutionError: `CLOSE_GAS_CAP on retry: ${retryGasCheck.reason}`,
            });
            return { closed: false, onChain: false, pnl: 0, error: "Gas cap reached on retry — agent paused" };
          }

          const retryResult = !retryGasCheck.exceeded ? await adapter!.closePosition({
            agent,
            positionId: resolvedId,
            side: pos.side as "long" | "short",
            quantity: pos.sizeSui,
            price: currentPrice,
          }) : { success: false, error: "gas_cap_exceeded" } as any;

          if (retryResult.success && retryResult.txDigest && !retryResult.txDigest.startsWith("sim_")) {
            if (retryResult.filled === false) {
              console.log(`[Execution] RETRY close TX submitted for ${agent.name} (tx=${retryResult.txDigest}) but close order NOT FILLED. Will retry later.`);
              return { closed: false, onChain: false, pnl: 0, error: `close_order_unfilled: retry TX ${retryResult.txDigest} not filled by Typus matcher` };
            }
            onChainSuccess = true;
            closeTxDigest = retryResult.txDigest;
            closeError = null;
            positionGoneFromDex = false;
            console.log(`[Execution] RETRY CLOSE SUCCESS for ${agent.name} with corrected position ID ${resolvedId}: tx=${retryResult.txDigest} (filled=true)`);
          } else {
            closeError = retryResult.error || "retry close failed";
            positionGoneFromDex = !!(closeError && (closeError.includes("key_not_found") || closeError.includes("keyed_big_vector") || closeError.includes("order_not_found") || closeError.includes("position_not_found")));
            console.log(`[Execution] Retry close with corrected ID also failed for ${agent.name}: ${closeError}`);
          }
        } catch (retryErr: any) {
          closeError = retryErr.message;
          console.log(`[Execution] Retry close exception for ${agent.name}: ${retryErr.message}`);
        }
      } else if (resolvedId) {
        console.log(`[Execution] Stored position ID ${pos.onChainPositionId} matches fill event — position genuinely gone from Typus.`);
      } else {
        console.log(`[Execution] Could not find fill event for order_id=${pos.onChainPositionId} — position may be genuinely gone.`);
      }
    } catch (resolveErr: any) {
      console.log(`[Execution] Position ID resolution failed: ${resolveErr.message}`);
    }
  }

  if (positionGoneFromDex && !onChainSuccess) {
    if (adapter instanceof TypusAdapter && agent.walletAddress && pos.onChainPositionId) {
      try {
        const fillCheck = await (adapter as TypusAdapter).checkPriorCloseFilled(agent.walletAddress, pos.onChainPositionId);
        if (fillCheck.filled) {
          console.log(`[Execution] Position ${pos.onChainPositionId} for ${agent.name} was FILLED on-chain (TX: ${fillCheck.txDigest}). Recovering as on-chain success.`);
          onChainSuccess = true;
          closeTxDigest = fillCheck.txDigest || "prior_fill";
          positionGoneFromDex = false;
        }
      } catch (fillCheckErr: any) {
        console.log(`[Execution] Fill check during key_not_found handling failed: ${fillCheckErr.message}`);
      }
    }
  }

  if (positionGoneFromDex) {
    const collateralForCheck = pos.collateral || (pos.sizeSui / agent.leverage);

    const priceMoveForLiqCheck = pos.side === "long"
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
    const collateralLossPctFromPrice = Math.abs(Math.min(0, priceMoveForLiqCheck)) * agent.leverage;
    const priceSaysLiquidationPossible = collateralLossPctFromPrice >= 80;

    console.log(`[Execution] Position ${pos.onChainPositionId} gone from Typus for ${agent.name}. Price analysis: ${pos.side} entry=$${pos.entryPrice.toFixed(4)}, exit=$${currentPrice.toFixed(4)}, priceMove=${priceMoveForLiqCheck.toFixed(3)}%, collateralLoss=${collateralLossPctFromPrice.toFixed(1)}%, liquidationPossible=${priceSaysLiquidationPossible}`);

    let confirmedLiquidation = false;
    let liquidationTxDigest: string | null = null;
    try {
      const recentTxs = await suiClient.queryTransactionBlocks({
        filter: { ToAddress: agent.walletAddress || "" },
        options: { showEvents: true },
        limit: 25,
        order: "descending" as any,
      });
      const onChainPosId = pos.onChainPositionId;
      if (recentTxs?.data && onChainPosId) {
        for (const txBlock of recentTxs.data) {
          const events = (txBlock as any).events;
          if (!events) continue;
          for (const evt of events) {
            const parsed = (evt as any).parsedJson;
            if (!parsed) continue;
            const evtType = (evt as any).type || "";
            if (evtType.includes("LiquidateEvent") && String(parsed.position_id) === String(onChainPosId)) {
              confirmedLiquidation = true;
              liquidationTxDigest = (txBlock as any).digest || null;
              console.log(`[Execution] ON-CHAIN LIQUIDATION EVENT confirmed for ${agent.name} position ${onChainPosId} in tx ${liquidationTxDigest}`);
              break;
            }
          }
          if (confirmedLiquidation) break;
        }
      }
    } catch (scanErr: any) {
      console.log(`[Execution] Transaction scan for settlement type failed: ${scanErr.message}`);
    }

    if (confirmedLiquidation) {
      positionAlreadySettled = true;
      closeTxDigest = liquidationTxDigest;
      console.log(`[Execution] LIQUIDATION confirmed by on-chain event for ${agent.name}: full collateral loss.`);
    } else if (!priceSaysLiquidationPossible) {
      onChainSuccess = true;
      closeTxDigest = "settled_onchain";
      console.log(`[Execution] PRICE GUARD: Position ${pos.onChainPositionId} for ${agent.name} CANNOT be a liquidation — price moved only ${priceMoveForLiqCheck.toFixed(3)}% (${collateralLossPctFromPrice.toFixed(1)}% collateral loss at ${agent.leverage}x). Treating as on-chain settled. Balance will reconcile from wallet.`);
    } else {
      let currentOnChainSui: number | null = null;
      try {
        const { getOnChainBalance } = await import("../sui-verify");
        const onChain = await getOnChainBalance(agent.walletAddress || "");
        currentOnChainSui = onChain.sui;
      } catch {}

      if (currentOnChainSui !== null) {
        const allPosForCheck = await storage.getPositions(agent.id);
        const otherOpenPositions = allPosForCheck.filter(p => p.id !== pos.id && (p.status === "open" || p.status === "pending_open"));
        const otherLockedCollateral = otherOpenPositions.reduce((sum, p) => sum + (p.collateral || p.sizeSui / agent.leverage), 0);
        const expectedWithoutCollateral = Math.max(0, agent.balance - otherLockedCollateral - collateralForCheck);
        const returnedAmount = currentOnChainSui - expectedWithoutCollateral;
        console.log(`[Execution] Balance analysis for ${agent.name}: onChain=${currentOnChainSui.toFixed(4)}, expectedWithout=${expectedWithoutCollateral.toFixed(4)}, returned=${returnedAmount.toFixed(4)}, collateral=${collateralForCheck.toFixed(4)}`);

        if (returnedAmount > collateralForCheck * 0.15) {
          onChainSuccess = true;
          closeTxDigest = "settled_onchain";
          console.log(`[Execution] Position ${pos.onChainPositionId} settled for ${agent.name}: collateral returned (${returnedAmount.toFixed(4)} > 15% of ${collateralForCheck.toFixed(4)}).`);
        } else {
          positionAlreadySettled = true;
          console.log(`[Execution] LIQUIDATION: on-chain LiquidateEvent confirmed AND collateral not returned (${returnedAmount.toFixed(4)} SUI). Full collateral loss.`);
        }
      } else {
        onChainSuccess = true;
        closeTxDigest = "settled_onchain";
        console.log(`[Execution] Position ${pos.onChainPositionId} gone for ${agent.name}: price justifies possible liquidation (${collateralLossPctFromPrice.toFixed(1)}% collateral loss) BUT balance unavailable AND no LiquidateEvent found. Treating as settled — reconciliation will correct from on-chain truth.`);
      }
    }

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
      console.log(`[Execution] Close rejected for ${agent.name} position ${pos.id} — on-chain close failed: ${closeError}`);
      return { closed: false, onChain: false, pnl: 0, error: closeError || "on-chain close failed — position may still be on DEX" };
    }
  }

  const collateral = pos.collateral || (pos.sizeSui / agent.leverage);
  let realizedPnl: number;
  const closeMethod = onChainSuccess ? "on-chain" : (positionAlreadySettled ? "liquidated" : "DB-fallback");

  const pricePnl = pos.side === "long"
    ? (currentPrice - pos.entryPrice) * pos.sizeSui / currentPrice
    : (pos.entryPrice - currentPrice) * pos.sizeSui / currentPrice;

  const leverageForPnlCap = agent.leverage || 36;
  const maxReasonableGain = collateral * Math.min(leverageForPnlCap - 1, 10);

  if (positionAlreadySettled) {
    realizedPnl = -collateral;
    console.log(`[Execution] LIQUIDATED position for ${agent.name}: ${pos.side} size=${pos.sizeSui}, collateral=${collateral.toFixed(4)} SUI lost.`);
  } else if (onChainSuccess) {
    realizedPnl = Math.min(maxReasonableGain, Math.max(-collateral, pricePnl));
    if (pricePnl > maxReasonableGain) {
      console.log(`[Execution] PnL CAPPED for ${agent.name}: raw pricePnl=${pricePnl.toFixed(4)} exceeds max reasonable gain ${maxReasonableGain.toFixed(4)} (${leverageForPnlCap}x lev, ${collateral.toFixed(4)} collateral)`);
    }
    console.log(`[Execution] Price-based PnL for ${agent.name}: ${pos.side} entry=${pos.entryPrice}, close=${currentPrice}, pricePnl=${pricePnl.toFixed(4)}, collateral=${collateral.toFixed(4)}`);
  } else {
    realizedPnl = Math.min(maxReasonableGain, Math.max(-collateral, pricePnl));
  }

  console.log(`[Execution] PnL calculated (${closeMethod}): ${pos.side} entry=${pos.entryPrice}, close=${currentPrice}, size=${pos.sizeSui}, PnL=${realizedPnl.toFixed(4)} SUI`);

  if (realizedPnl < 0) {
    recordTradeLoss(agent.id);
  } else if (realizedPnl > 0) {
    recordTradeWin(agent.id);
  }

  const finalCloseReason = closeReason || (positionAlreadySettled ? "liquidated" : "manual");

  const freshAgent = await storage.getAgent(agent.id);
  const currentBalance = freshAgent ? freshAgent.balance : agent.balance;

  const allPositions = await storage.getPositions(agent.id);
  const closedPositions = allPositions.filter(p => p.status === "closed" || p.id === pos.id);
  const remainingOpenPositions = allPositions.filter(p => p.id !== pos.id && (p.status === "open" || p.status === "pending_open"));
  const lockedCollateral = remainingOpenPositions.reduce((sum, p) => sum + (p.collateral || p.sizeSui / agent.leverage), 0);

  const rewardSharePct = agent.rewardSharePct ?? 50;
  let rewardAmount = 0;
  let finalBalance: number;
  let settlementPending = false;
  let positionStillOnChain = false;

  if (!onChainSuccess && !positionAlreadySettled) {
    finalBalance = Math.max(0, currentBalance);
    if (agent.walletAddress) {
      try {
        const { getOnChainBalance } = await import("../sui-verify");
        const onChain = await getOnChainBalance(agent.walletAddress);
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
        const expectedReturn = Math.max(0, collateral + realizedPnl);
        const preCloseWalletSui = Math.max(0, currentBalance - lockedCollateral - collateral);
        const expectedPostSettlement = Math.max(0, preCloseWalletSui + expectedReturn);

        const isSettledOnChainOnly = closeTxDigest === "settled_onchain" || closeTxDigest === "position_gone_onchain";
        const maxSettlementWaitMs = isSettledOnChainOnly ? 0 : 30000;
        const pollInterval = 2000;
        const maxAttempts = isSettledOnChainOnly ? 0 : Math.ceil(maxSettlementWaitMs / pollInterval);
        let settled = isSettledOnChainOnly;

        if (!isSettledOnChainOnly) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        let onChain = await getOnChainBalance(agent.walletAddress);
        let onChainTotal = onChain.sui + lockedCollateral;

        if (onChainSuccess && expectedReturn > 0.1 && onChain.sui < expectedPostSettlement * 0.7) {
          console.log(`[BalanceSync] Waiting for Typus fill/settlement for ${agent.name}: expectedPostSettlement ~${expectedPostSettlement.toFixed(4)} SUI, current wallet=${onChain.sui.toFixed(4)} — polling...`);
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            onChain = await getOnChainBalance(agent.walletAddress);
            onChainTotal = onChain.sui + lockedCollateral;
            if (onChain.sui >= expectedPostSettlement * 0.7) {
              console.log(`[BalanceSync] Settlement arrived for ${agent.name} after ${attempt * pollInterval / 1000}s: wallet=${onChain.sui.toFixed(4)} SUI`);
              settled = true;
              break;
            }
          }
          if (!settled) {
            console.log(`[BalanceSync] Settlement NOT detected after ${maxSettlementWaitMs / 1000}s for ${agent.name}: wallet=${onChain.sui.toFixed(4)}, expected ~${expectedPostSettlement.toFixed(4)}.`);
          }
        } else {
          settled = true;
        }

        if (isSettledOnChainOnly) {
          try {
            const adapter = getAdapter(agent.venue);
            if (adapter && agent.walletAddress) {
              const onChainPositions = await adapter.getPositions(agent.walletAddress);
              const stillOnChain = onChainPositions.some((p: any) =>
                p.positionId === pos.onChainPositionId ||
                (pos.onChainPositionId && String(p.positionId) === String(pos.onChainPositionId))
              );
              if (stillOnChain) {
                positionStillOnChain = true;
                onChainTotal += collateral;
                console.log(`[BalanceSync] Position ${pos.onChainPositionId} still on-chain for ${agent.name}: ABORTING CLOSE — position is still active on Typus with collateral ${collateral.toFixed(4)} SUI locked. Will retry close.`);
              } else {
                console.log(`[BalanceSync] Position ${pos.onChainPositionId} confirmed GONE from chain for ${agent.name}: collateral should have been returned to wallet`);
              }
            }
          } catch (posCheckErr: any) {
            onChainTotal += collateral;
            console.log(`[BalanceSync] Could not verify on-chain position status for ${agent.name}: ${posCheckErr.message?.slice(0, 60)} — preserving collateral in balance`);
          }
        }

        finalBalance = onChainTotal;

        if (!settled && !positionAlreadySettled) {
          const actualReturned = Math.max(0, onChain.sui - preCloseWalletSui);
          const onChainDerivedPnl = actualReturned - collateral;
          const cappedOnChainPnl = Math.max(-collateral, onChainDerivedPnl);
          console.log(`[BalanceSync] Settlement not yet detected for ${agent.name}: preClose wallet=${preCloseWalletSui.toFixed(4)}, postClose wallet=${onChain.sui.toFixed(4)}, actualReturned=${actualReturned.toFixed(4)}, collateral=${collateral.toFixed(4)}`);

          if (onChainSuccess) {
            settlementPending = true;
            console.log(`[BalanceSync] KEEPER SETTLEMENT PENDING: Close TX succeeded but keeper hasn't filled yet for ${agent.name}. KEEPING price-based PnL=${realizedPnl.toFixed(4)} SUI (NOT overriding with unreliable on-chain derived=${cappedOnChainPnl.toFixed(4)} SUI). Reconciliation will correct balance after settlement arrives.`);
            finalBalance = Math.max(0, currentBalance - collateral + Math.max(0, collateral + realizedPnl));
          } else {
            const isSettledOnChain = closeTxDigest === "settled_onchain";
            if (isSettledOnChain) {
              console.log(`[BalanceSync] PRICE GUARD PROTECTED: Position was classified as settled_onchain (NOT liquidation). KEEPING price-based PnL=${realizedPnl.toFixed(4)} SUI.`);
            } else if (Math.abs(cappedOnChainPnl - realizedPnl) > collateral * 0.1) {
              console.warn(`[BalanceSync] LARGE PNL DISCREPANCY for ${agent.name}: price says ${realizedPnl.toFixed(4)} SUI, on-chain says ${cappedOnChainPnl.toFixed(4)} SUI.`);
              realizedPnl = cappedOnChainPnl;
              if (cappedOnChainPnl <= -collateral * 0.85) {
                closeTxDigest = closeTxDigest || "liquidated_onchain";
                console.log(`[BalanceSync] Full collateral loss detected — marking as liquidated.`);
              }
            }
          }
        }

        console.log(`[BalanceSync] After close for ${agent.name}: on-chain=${onChain.sui.toFixed(4)} + locked=${lockedCollateral.toFixed(4)} (${remainingOpenPositions.length} open positions) = ${onChainTotal.toFixed(4)} SUI (settled=${settled})`);
      } catch (syncErr: any) {
        console.log(`[BalanceSync] FALLBACK: Failed to sync after close for ${agent.name}: ${syncErr.message}. Using DB balance.`);
        finalBalance = Math.max(0, Math.min(currentBalance, currentBalance + realizedPnl));
      }
    } else {
      finalBalance = Math.max(0, currentBalance + realizedPnl);
    }

    if (realizedPnl > 0 && rewardSharePct > 0 && !positionAlreadySettled) {
      let remainingLockedColl = 0;
      try {
        const allAgentPos = await storage.getPositions(agent.id);
        remainingLockedColl = allAgentPos
          .filter((p: any) => p.status === "open" && p.id !== pos.id)
          .reduce((s: number, p: any) => s + (p.collateral || p.sizeSui / agent.leverage), 0);
      } catch {}
      const estimatedPostCloseFreeSui = finalBalance - remainingLockedColl;
      if (estimatedPostCloseFreeSui < LOW_BALANCE_REWARD_SKIP_THRESHOLD) {
        console.log(`[Rewards] DEFERRING reward for ${agent.name}: freeSui after close ~${estimatedPostCloseFreeSui.toFixed(4)} < ${LOW_BALANCE_REWARD_SKIP_THRESHOLD} SUI threshold. Keeping profit in wallet for gas/capital growth.`);
        rewardAmount = 0;
      } else {
        rewardAmount = realizedPnl * (rewardSharePct / 100);
        console.log(`[Execution] Profitable close: PnL=${realizedPnl.toFixed(4)}, reward=${rewardAmount.toFixed(4)}`);
      }
    }
    if (positionAlreadySettled) {
      console.log(`[Execution] No reward for liquidated position — full collateral loss`);
    }
  }

  if (positionStillOnChain) {
    console.log(`[Execution] ABORT CLOSE: Position ${pos.onChainPositionId} for ${agent.name} is still active on Typus — NOT marking as closed. Keeping position open for retry. On-chain collateral ${collateral.toFixed(4)} SUI preserved.`);
    positionCloseInProgress.delete(pos.id);
    await storage.updatePosition(pos.id, {
      status: "open",
      markPrice: currentPrice,
      unrealizedPnl: Math.min(collateral * Math.min((agent.leverage || 36) - 1, 10), Math.max(-collateral, pricePnl)),
      closeState: undefined,
      closeAttempts: 0,
      lastCloseTx: undefined,
      closePendingSince: undefined,
    });
    return { closed: false, onChain: false, pnl: 0, error: `Position still active on Typus — close aborted, will retry` };
  }

  const finalCloseTxDigest = closeTxDigest || (positionAlreadySettled ? "liquidated_onchain" : null);

  clearCloseGasTracking(pos.id);

  await storage.updatePosition(pos.id, {
    status: "closed",
    markPrice: currentPrice,
    unrealizedPnl: realizedPnl,
    closedAt: new Date(),
    closeTxDigest: finalCloseTxDigest,
    closeReason: finalCloseReason,
  });

  const isWin = realizedPnl > 0;
  const totalClosed = closedPositions.length;
  const totalWins = closedPositions.filter(p => {
    const pnl = p.id === pos.id ? realizedPnl : (p.unrealizedPnl || 0);
    return pnl > 0;
  }).length;
  const newWinRate = totalClosed > 0 ? totalWins / totalClosed : 0;

  if (onChainSuccess && !positionAlreadySettled && agent.walletAddress && closeTxDigest) {
    if (closeTxDigest && !closeTxDigest.startsWith("sim_") && closeTxDigest !== "keeper_filled" && closeTxDigest !== "prior_fill" && closeTxDigest !== "keeper_filled_tracked" && closeTxDigest !== "settled_onchain" && closeTxDigest !== "position_gone_onchain") {
      try {
        const { inspectCloseTxBalanceChanges } = await import("../sui-verify");
        const txInspection = await inspectCloseTxBalanceChanges(closeTxDigest, agent.walletAddress);
        console.log(`[TxInspect] Close TX ${closeTxDigest} for ${agent.name}: returned=${txInspection.returned.toFixed(4)} SUI to ${txInspection.recipient || "UNKNOWN"}, gasCost=${txInspection.gasCost.toFixed(4)} SUI`);
        for (const change of txInspection.allChanges) {
          const addr = change.owner ? `${change.owner.slice(0, 10)}...` : "unknown";
          console.log(`[TxInspect]   balance change: ${addr} ${change.amountSui >= 0 ? "+" : ""}${change.amountSui.toFixed(4)} SUI`);
        }
        if (txInspection.returned <= 0 && realizedPnl >= 0) {
          const nonAgentRecipients = txInspection.allChanges.filter(c => c.amountSui > 0.01 && c.owner.toLowerCase() !== agent.walletAddress!.toLowerCase());
          if (nonAgentRecipients.length > 0) {
            console.log(`[TxInspect] WARNING: Returned SUI went to OTHER addresses, not agent wallet ${agent.walletAddress!.slice(0, 10)}:`);
            for (const r of nonAgentRecipients) {
              console.log(`[TxInspect]   -> ${r.owner}: +${r.amountSui.toFixed(4)} SUI`);
            }
          }
        }
      } catch (inspectErr: any) {
        console.log(`[TxInspect] Close TX inspection failed: ${inspectErr.message?.slice(0, 80)}`);
      }
    }

    try {
      const { getOnChainBalance } = await import("../sui-verify");
      const verifyOnChain = await getOnChainBalance(agent.walletAddress);
      const allPosVerify = await storage.getPositions(agent.id);
      const openPosVerify = allPosVerify.filter(p => p.id !== pos.id && (p.status === "open" || p.status === "pending_open"));
      let lockedVerify = openPosVerify.reduce((sum, p) => sum + (p.collateral || p.sizeSui / agent.leverage), 0);

      const isSettledSynthetic = closeTxDigest === "settled_onchain" || closeTxDigest === "position_gone_onchain";
      if (isSettledSynthetic) {
        try {
          const adapterVerify = getAdapter(agent.venue);
          if (adapterVerify && agent.walletAddress) {
            const onChainPosVerify = await adapterVerify.getPositions(agent.walletAddress);
            const closingPosStillOnChain = onChainPosVerify.some((p: any) =>
              p.positionId === pos.onChainPositionId ||
              (pos.onChainPositionId && String(p.positionId) === String(pos.onChainPositionId))
            );
            if (closingPosStillOnChain) {
              lockedVerify += collateral;
              console.log(`[CollateralVerify] Position ${pos.onChainPositionId} still on-chain: preserving ${collateral.toFixed(4)} SUI collateral in verification balance`);
            }
          }
        } catch {}
      }

      const verifyTotal = verifyOnChain.sui + lockedVerify;
      const expectedMinReturn = collateral * 0.5;
      const balanceDelta = verifyOnChain.sui - (preCloseOnChainBalance ?? verifyOnChain.sui);

      if (settlementPending) {
        console.log(`[CollateralVerify] SKIPPING on-chain override for ${agent.name}: settlement pending (keeper hasn't filled yet). Using price-based finalBalance=${finalBalance.toFixed(4)}, on-chain wallet=${verifyOnChain.sui.toFixed(4)}`);
      } else if (preCloseOnChainBalance !== null && balanceDelta < -collateral * 0.1 && realizedPnl >= 0 && !isSettledSynthetic) {
        console.log(`[CollateralVerify] WARNING: Balance DROPPED after close for ${agent.name}: pre=${preCloseOnChainBalance.toFixed(4)}, post=${verifyOnChain.sui.toFixed(4)}, delta=${balanceDelta.toFixed(4)}, expected return ~${expectedMinReturn.toFixed(4)} SUI. Collateral may not have returned — using on-chain truth.`);
        finalBalance = verifyTotal;
      } else {
        console.log(`[CollateralVerify] Close verified for ${agent.name}: pre=${(preCloseOnChainBalance ?? 0).toFixed(4)}, post=${verifyOnChain.sui.toFixed(4)}, delta=${balanceDelta.toFixed(4)}, total=${verifyTotal.toFixed(4)} SUI`);
        finalBalance = verifyTotal;
      }
    } catch (verifyErr: any) {
      console.log(`[CollateralVerify] Verification failed for ${agent.name}: ${verifyErr.message} — using existing finalBalance=${finalBalance.toFixed(4)}`);
    }
  }

  if (rewardAmount > 0 && agent.agentWallet && agent.walletAddress && (onChainSuccess || positionAlreadySettled)) {
    if (rewardCreationInProgress.has(pos.id)) {
      console.log(`[Rewards] LOCK: Reward creation already in progress for pos ${pos.id} — skipping`);
    } else {
      rewardCreationInProgress.add(pos.id);
      try {
        const rewardData = {
          agentId: agent.id,
          userId: agent.userId,
          amount: rewardAmount,
          agentName: agent.name,
          positionId: pos.id,
        };

        const { reward, alreadyExisted } = await storage.createRewardIdempotent(rewardData);
        if (alreadyExisted) {
          console.log(`[Rewards] DEDUP: Reward already exists for pos ${pos.id} (reward ${reward.id}) — skipping creation`);
        } else {
          await storage.updateReward(reward.id, { escrowTxDigest: "agent_retained" });
          console.log(`[Rewards] RECORDED ${rewardAmount.toFixed(4)} SUI reward for ${agent.name} pos ${pos.id} (${rewardSharePct}% of ${realizedPnl.toFixed(4)} profit) — claimable computed dynamically from wallet balance`);
        }
      } catch (retainErr: any) {
        console.log(`[Rewards] Failed to record retained reward for ${agent.name}: ${retainErr.message}`);
        try {
          const { reward, alreadyExisted } = await storage.createRewardIdempotent({
            agentId: agent.id,
            userId: agent.userId,
            amount: rewardAmount,
            agentName: agent.name,
            positionId: pos.id,
          });
          if (!alreadyExisted) {
            await storage.updateReward(reward.id, { escrowTxDigest: "agent_retained" });
          }
        } catch (recordErr: any) {
          console.log(`[Rewards] Failed to create reward record: ${recordErr.message}`);
        }
      } finally {
        rewardCreationInProgress.delete(pos.id);
      }
    }
  } else if (rewardAmount > 0 && !(onChainSuccess || positionAlreadySettled)) {
    console.log(`[Rewards] SKIPPING reward for ${agent.name} pos ${pos.id} — close not confirmed on-chain (onChainSuccess=${onChainSuccess}, settled=${positionAlreadySettled})`);
  }

  const pnlDelta = (onChainSuccess || positionAlreadySettled) ? realizedPnl : 0;

  if (realizedPnl > 0 && !positionAlreadySettled) {
    const retentionPct = agent.profitRetentionPct ?? 10;
    if (retentionPct > 0) {
      const MIN_FREE_SUI_FOR_RETENTION = COLLATERAL_GAS_RESERVE_SUI + 0.5;
      const estimatedFreeSui = finalBalance - lockedCollateral;
      if (estimatedFreeSui < MIN_FREE_SUI_FOR_RETENTION) {
        console.log(`[ProfitRetention] ${agent.name}: SKIPPING retention — freeSui ~${estimatedFreeSui.toFixed(4)} < ${MIN_FREE_SUI_FOR_RETENTION.toFixed(2)} threshold. Prioritizing gas growth.`);
      } else {
        const retainAmount = realizedPnl * (retentionPct / 100);
        const currentRetained = agent.retainedProfits || 0;
        let newRetained = currentRetained + retainAmount;
        const cappedRetained = Math.min(newRetained, Math.max(0, estimatedFreeSui - MIN_FREE_SUI_FOR_RETENTION));
        if (cappedRetained < newRetained) {
          console.log(`[ProfitRetention] ${agent.name}: Capping retained from ${newRetained.toFixed(4)} to ${cappedRetained.toFixed(4)} SUI (freeSui=${estimatedFreeSui.toFixed(4)})`);
          newRetained = cappedRetained;
        }
        if (newRetained > 0) {
          await storage.updateAgent(agent.id, { retainedProfits: newRetained });
          console.log(`[ProfitRetention] ${agent.name}: Retained ${retainAmount.toFixed(4)} SUI (${retentionPct}% of ${realizedPnl.toFixed(4)} profit). Total retained: ${newRetained.toFixed(4)} SUI`);
        }
      }
    }
  }

  await storage.atomicUpdateAgentAfterClose(agent.id, pnlDelta, finalBalance, newWinRate);

  try {
    const { invalidateOnChainPortfolioCache } = await import("../routes");
    invalidateOnChainPortfolioCache(agent.id);
  } catch {}

  if ((onChainSuccess || positionAlreadySettled) && agent.walletAddress) {
    scheduleReconciliation(agent.id, agent.name, agent.walletAddress);

    if (agent.agentWallet) {
      setTimeout(async () => {
        try {
          const keypair = decryptKeypair(agent.agentWallet!);
          const mergeTx = await buildMergeAllSuiCoinsTx(suiClient, agent.walletAddress!);
          if (mergeTx) {
            const mergeResult = await suiClient.signAndExecuteTransaction({
              signer: keypair,
              transaction: mergeTx,
              options: { showEffects: true },
            });
            if (mergeResult.effects?.status?.status === "success") {
              console.log(`[CoinMerge] Post-close coin merge succeeded for ${agent.name}`);
            }
          }
        } catch (mergeErr: any) {
          console.log(`[CoinMerge] Post-close merge failed for ${agent.name}: ${mergeErr.message?.slice(0, 80)}`);
        }
      }, 5000);
    }

    const runReconciliation = async (pass: string, delayMs: number) => {
      await new Promise(r => setTimeout(r, delayMs));
      try {
        const { getOnChainBalance } = await import("../sui-verify");
        const reconOnChain = await getOnChainBalance(agent.walletAddress!);
        const reconPositions = await storage.getPositions(agent.id);
        const reconOpen = reconPositions.filter(p => (p.status === "open" || p.status === "pending_open"));
        let reconLocked = reconOpen.reduce((sum, p) => sum + (p.collateral || p.sizeSui / agent.leverage), 0);

        const hasUnresolved = reconOpen.some(p => !p.onChainPositionId || p.status === "pending_open");
        if (!hasUnresolved) {
          try {
            const reconAdapter = getAdapter(agent.venue);
            if (reconAdapter && agent.walletAddress) {
              const reconOnChainPos = await reconAdapter.getPositions(agent.walletAddress);
              const reconDbIds = new Set(reconOpen.map(p => p.onChainPositionId).filter(Boolean));
              for (const ocp of reconOnChainPos) {
                if (!reconDbIds.has(ocp.positionId)) {
                  reconLocked += ocp.collateral || 0;
                }
              }
            }
          } catch {}
        }

        const reconTotal = reconOnChain.sui + reconLocked;

        const latestAgent = await storage.getAgent(agent.id);
        if (!latestAgent) return;

        if (Math.abs(reconTotal - latestAgent.balance) > 0.05) {
          console.log(`[Reconciliation][${pass}] Balance correction for ${agent.name}: DB=${latestAgent.balance.toFixed(4)} → on-chain-derived=${reconTotal.toFixed(4)} (on-chain=${reconOnChain.sui.toFixed(4)}, locked=${reconLocked.toFixed(4)})`);
          await storage.updateAgent(agent.id, { balance: reconTotal });
        }
      } catch (reconErr: any) {
        console.log(`[Reconciliation][${pass}] Post-close reconciliation failed for ${agent.name}: ${reconErr.message}`);
      }
    };

    runReconciliation("fast", onChainSuccess ? 20000 : 5000);
    if (onChainSuccess) {
      runReconciliation("slow", 60000);
      if (settlementPending) {
        runReconciliation("keeper-settle", 120000);
        runReconciliation("keeper-settle-late", 300000);
      }
    }
  }

  const pnlPct = pos.side === "long"
    ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

  lastTradeMap.delete(agent.id);
  logCloseSuccess(agent.id, pos.id);

  console.log(`[Execution] Position closed (${closeMethod}) for ${agent.name}: ${pos.side} ${pos.sizeSui.toFixed(4)} SUI, PnL=${realizedPnl.toFixed(4)} SUI (${pnlPct.toFixed(2)}%), balance=${finalBalance.toFixed(4)}, WinRate=${(newWinRate * 100).toFixed(0)}%`);

  try {
    await logCloseOutcome({
      agentId: agent.id,
      positionDbId: pos.id,
      closeMethod,
      regime: (pos as any).regime || undefined,
      side: pos.side,
      entryPrice: pos.entryPrice,
      closePrice: currentPrice,
      leverage: agent.leverage,
      collateral: pos.collateral || undefined,
      closeTxDigest: closeTxDigest || undefined,
      openTxDigest: pos.txDigest || undefined,
      onChainPositionId: pos.onChainPositionId || undefined,
      errorCode: closeError || undefined,
      latencyMs: closeStartTime ? Date.now() - closeStartTime : undefined,
      pnlSui: realizedPnl,
      onChainSuccess,
      htfBias: (pos as any).htfBias || undefined,
      signalScore: (pos as any).signalScore ? Number((pos as any).signalScore) : undefined,
      signalType: (pos as any).signalType || undefined,
    });
  } catch (learnErr: any) {
    console.log(`[Learning] Failed to log close outcome: ${learnErr.message}`);
  }

  return { closed: true, onChain: onChainSuccess, pnl: realizedPnl, txDigest: closeTxDigest || undefined };
}

export async function reconcilePositions(agent: Agent): Promise<void> {
  const adapter = getAdapter(agent.venue);
  if (!adapter || !agent.walletAddress) return;

  try {
    const onChainPositions = await adapter.getPositions(agent.walletAddress);
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
  const openPositions = positions.filter(p => (p.status === "open" || p.status === "pending_open"));

  let totalPnl = 0;
  let returnedCollateral = 0;
  let closedCount = 0;
  let failedCount = 0;

  for (const pos of openPositions) {
    const result = await closePositionForAgent(agent, pos.id, currentPrice, false, "agent-shutdown");
    if (result.closed) {
      closedCount++;
      totalPnl += result.pnl;
      returnedCollateral += pos.collateral || (pos.sizeSui / agent.leverage);
    } else {
      failedCount++;
      console.log(`[Execution] Failed to close position ${pos.id} on-chain for ${agent.name} (${pos.side} ${pos.sizeSui} SUI): ${result.error}`);
    }
  }

  return { closed: closedCount, failed: failedCount, totalPnl, returnedCollateral };
}

const lastCloseBundleEmit = new Map<string, number>();
const CLOSE_BUNDLE_THROTTLE_MS = 12_000;

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
  if (!integrityCheckComplete) return;

  const freshAgent = await storage.getAgent(agent.id);
  if (!freshAgent) return;
  const agentConfig = freshAgent;
  const adapter = getAdapter(agentConfig.venue);

  const positions = await storage.getPositions(agent.id);
  const openPositions = positions.filter(p =>
    (p.status === "open" || p.status === "pending_open")
  );
  if (openPositions.length === 0) return;

  if (agentConfig.agentWallet) {
    try {
      const keypair = decryptKeypair(agentConfig.agentWallet);
      const walletAddr = keypair.toSuiAddress();
      const balResp = await suiClient.getBalance({ owner: walletAddr, coinType: "0x2::sui::SUI" });
      const walletBalanceSui = Number(balResp.totalBalance) / 1e9;
      if (walletBalanceSui < MIN_EXECUTABLE_GAS_SUI) {
        const msg = `INSUFFICIENT_GAS: Wallet has ${walletBalanceSui.toFixed(4)} SUI — below minimum executable gas (${MIN_EXECUTABLE_GAS_SUI} SUI). Skipping all close attempts to prevent wasting remaining gas.`;
        console.log(`[TP/SL] ${agentConfig.name}: ${msg}`);
        await storage.updateAgent(agent.id, { lastExecutionError: msg, lastExecutionAt: new Date() });
        for (const pos of openPositions) {
          const rawPnl = pos.side === "long"
            ? (currentPrice - pos.entryPrice) * pos.sizeSui / currentPrice
            : (pos.entryPrice - currentPrice) * pos.sizeSui / currentPrice;
          const posCollateral = pos.collateral || (pos.sizeSui / (agentConfig.leverage || 25));
          const maxGainOpen = posCollateral * Math.min((agentConfig.leverage || 25) - 1, 10);
          await storage.updatePosition(pos.id, { markPrice: currentPrice, unrealizedPnl: Math.min(maxGainOpen, Math.max(-posCollateral, rawPnl)) });
        }
        return;
      }
    } catch (gasCheckErr: any) {
      if (isRateLimitError(String(gasCheckErr?.message ?? gasCheckErr))) {
        console.log(`[TP/SL] ${agentConfig.name}: RPC rate limited during pre-close gas check — proceeding with close checks`);
      }
    }
  }

  if (!isPriceSane(currentPrice)) {
    console.log(`[TP/SL] Skipping checks for ${agentConfig.name}: price $${currentPrice.toFixed(4)} failed sanity`);
    return;
  }

  const slBps = agentConfig.stopLossBps || 80;
  const tpBps = agentConfig.takeProfitBps;
  const slThreshold = slBps / 100;
  let tpThreshold = tpBps ? tpBps / 100 : null;

  const leverageMultiplier = agentConfig.leverage || 1;
  const liquidationPricePct = (1 / leverageMultiplier) * 100;

  let liveAdx = 0;
  let liveAtrPct = 0;
  try {
    const candles = getMultiTFCandles();
    const tf5m = candles.tf5m;
    if (tf5m && tf5m.length >= 30) {
      const highs = tf5m.map((c: any) => c.h);
      const lows = tf5m.map((c: any) => c.l);
      const closes = tf5m.map((c: any) => c.c);
      liveAdx = adxLast(highs, lows, closes, 14);
      const atrVal = atrLast(highs, lows, closes, 14);
      liveAtrPct = currentPrice > 0 ? (atrVal / currentPrice) * 100 : 0;
    }
  } catch {}

  if (tpThreshold !== null && liveAdx > 25 && liveAtrPct > 0.15) {
    const extensionFactor = liveAdx > 30 ? 1.35 : 1.25;
    const extendedTp = tpThreshold * extensionFactor;
    tpThreshold = extendedTp;
  }

  let effectiveSLThreshold = slThreshold;

  if (liveAtrPct > 0.05) {
    const atrBasedSL = liveAtrPct * 1.2;
    if (atrBasedSL < effectiveSLThreshold) {
      effectiveSLThreshold = atrBasedSL;
    }
  }

  const maxSLFromCollateral = MAX_COLLATERAL_LOSS_PCT / leverageMultiplier;
  if (effectiveSLThreshold > maxSLFromCollateral) {
    effectiveSLThreshold = maxSLFromCollateral;
    console.log(`[TP/SL] SL capped for ${agentConfig.name}: configured=${slThreshold.toFixed(2)}% → effective=${effectiveSLThreshold.toFixed(3)}% (max ${MAX_COLLATERAL_LOSS_PCT}% collateral loss at ${leverageMultiplier}x)`);
  }

  const liquidationMovePct = (1 / leverageMultiplier) * 100;
  const maxSafeSLPct = liquidationMovePct * 0.60;
  if (effectiveSLThreshold > maxSafeSLPct) {
    console.log(`[TP/SL] Leverage-aware SL cap for ${agentConfig.name}: ${effectiveSLThreshold.toFixed(3)}% exceeds 60% of liquidation distance (${liquidationMovePct.toFixed(2)}% at ${leverageMultiplier}x) → capped to ${maxSafeSLPct.toFixed(3)}%`);
    effectiveSLThreshold = maxSafeSLPct;
  }

  let positionsToClose: Array<{ pos: any; reason: string; pnlPercent: number; collateralLossPct: number; priority: number; riskScore: number }> = [];
  const positionsToUpdate: Array<{ pos: any; unrealizedPnl: number }> = [];

  for (const pos of openPositions) {
    if (!pos.onChainPositionId && !pos.txDigest?.startsWith("reopened_") && !pos.txDigest?.startsWith("recovered_")) {
      if (pos.status === "pending_open") continue;
    }
    if (!pos.entryPrice || pos.entryPrice === 0) continue;

    const pnlPercent = pos.side === "long"
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

    const collateralLossPct = pnlPercent < 0 ? Math.abs(pnlPercent) * leverageMultiplier : 0;

    let tracker = peakPnlTracker.get(pos.id);
    if (!tracker) {
      tracker = { peakPnlPct: pnlPercent, breakEvenLocked: false, trailingSLPct: effectiveSLThreshold };
      peakPnlTracker.set(pos.id, tracker);
    }
    if (pnlPercent > tracker.peakPnlPct) {
      tracker.peakPnlPct = pnlPercent;
    }

    if (tracker.peakPnlPct >= TRAILING_ACTIVATION_PCT) {
      if (!tracker.breakEvenLocked) {
        tracker.breakEvenLocked = true;
      }
      tracker.trailingSLPct = tracker.peakPnlPct - TRAILING_DISTANCE_PCT;
    } else if (tracker.peakPnlPct >= BREAKEVEN_ACTIVATION_PCT && !tracker.breakEvenLocked) {
      tracker.breakEvenLocked = true;
      tracker.trailingSLPct = 0;
    }

    let posEffectiveSL = effectiveSLThreshold;
    if (pos.openedAt) {
      const posOpenedAt = new Date(pos.openedAt).getTime();
      const posAgeMs = Date.now() - posOpenedAt;
      if (posAgeMs > POSITION_AGE_TIGHTEN_MS && pnlPercent < 0) {
        posEffectiveSL = effectiveSLThreshold * POSITION_AGE_TIGHTEN_FACTOR;
      }
    }

    const shouldStopLoss = pnlPercent <= -posEffectiveSL;
    let shouldTrailingStop = false;
    if (tracker.breakEvenLocked) {
      if (tracker.trailingSLPct > 0) {
        shouldTrailingStop = pnlPercent <= tracker.trailingSLPct;
      } else {
        shouldTrailingStop = pnlPercent <= 0;
      }
    }
    const shouldTakeProfit = tpThreshold !== null && pnlPercent >= tpThreshold;
    const maxCollateralBreached = collateralLossPct >= MAX_COLLATERAL_LOSS_PCT;
    const emergencyClose = collateralLossPct >= EMERGENCY_COLLATERAL_LOSS_PCT;

    if (shouldStopLoss || shouldTrailingStop || shouldTakeProfit || maxCollateralBreached || emergencyClose) {
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
      } else if (shouldTrailingStop) {
        reason = "trailing-stop";
        priority = 2;
      } else {
        reason = "take-profit";
        priority = 3;
      }

      const posCollateral = pos.collateral || (pos.sizeSui / leverageMultiplier);
      const absoluteLoss = pnlPercent < 0 ? Math.abs(pnlPercent) * posCollateral / 100 : 0;
      const posAgeMs = pos.openedAt ? Date.now() - new Date(pos.openedAt).getTime() : 0;
      const ageMinutes = posAgeMs / 60000;
      const liqDistPct = liquidationPricePct - collateralLossPct;
      let riskScore = collateralLossPct * 10 + absoluteLoss * 5;
      if (liqDistPct < 30) riskScore += (30 - liqDistPct) * 3;
      if (pnlPercent < 0 && ageMinutes > 5) riskScore += ageMinutes * 2;
      if (priority === 3) riskScore = Math.abs(pnlPercent);

      if (shouldTrailingStop && !shouldStopLoss) {
        console.log(`[TP/SL] TRAILING STOP triggered for ${agentConfig.name} pos ${pos.id}: peak=${tracker.peakPnlPct.toFixed(3)}%, current=${pnlPercent.toFixed(3)}%, trailSL=${tracker.trailingSLPct.toFixed(3)}%`);
      }

      positionsToClose.push({ pos, reason, pnlPercent, collateralLossPct, priority, riskScore });
      peakPnlTracker.delete(pos.id);
    } else {
      const rawUnrealizedPnl = pos.side === "long"
        ? (currentPrice - pos.entryPrice) * pos.sizeSui / currentPrice
        : (pos.entryPrice - currentPrice) * pos.sizeSui / currentPrice;
      const posCollateral = pos.collateral || (pos.sizeSui / agentConfig.leverage);
      const maxGainUpdate = posCollateral * Math.min((agentConfig.leverage || 36) - 1, 10);
      positionsToUpdate.push({ pos, unrealizedPnl: Math.min(maxGainUpdate, Math.max(-posCollateral, rawUnrealizedPnl)) });
    }
  }

  const updatePromises = positionsToUpdate.map(({ pos, unrealizedPnl }) =>
    storage.updatePosition(pos.id, { markPrice: currentPrice, unrealizedPnl }).catch(() => {})
  );
  if (updatePromises.length > 0) {
    await Promise.allSettled(updatePromises);
  }

  if (positionsToClose.length === 0) return;

  positionsToClose.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.riskScore - a.riskScore;
  });

  let walletBalForLimit = -1;
  if (agentConfig.agentWallet) {
    try {
      const kpLimit = decryptKeypair(agentConfig.agentWallet);
      const addrLimit = kpLimit.toSuiAddress();
      const balRespLimit = await suiClient.getBalance({ owner: addrLimit, coinType: "0x2::sui::SUI" });
      walletBalForLimit = Number(balRespLimit.totalBalance) / 1e9;
    } catch {}
  }

  const isLowGas = walletBalForLimit >= 0 && walletBalForLimit < LOW_GAS_THRESHOLD_SUI;
  const isBelowHardFloor = walletBalForLimit >= 0 && walletBalForLimit < HARD_GAS_FLOOR_SUI;

  if (isBelowHardFloor) {
    console.log(`[TP/SL] ${agentConfig.name}: Wallet has ${walletBalForLimit.toFixed(4)} SUI — BELOW HARD FLOOR (${HARD_GAS_FLOOR_SUI}). Skipping ALL ${positionsToClose.length} close attempts. Agent needs gas top-off.`);
    await storage.updateAgent(agent.id, {
      status: "paused",
      lastExecutionError: `INSUFFICIENT_GAS: Wallet has ${walletBalForLimit.toFixed(4)} SUI — below hard floor. Cannot close any positions. Please top off gas.`,
      lastExecutionAt: new Date(),
    });
    return;
  }

  const topoffResumeAt = agentLastTopoffResumeAt.get(agent.id);
  if (topoffResumeAt && Date.now() - topoffResumeAt < TOPOFF_RECOVERY_COOLDOWN_MS) {
    const remaining = Math.round((TOPOFF_RECOVERY_COOLDOWN_MS - (Date.now() - topoffResumeAt)) / 1000);
    console.log(`[TP/SL] ${agentConfig.name}: In post-topoff recovery period (${remaining}s remaining). Skipping close attempts to let gas stabilize.`);
    return;
  }

  const gasCapTrippedClose = await checkAndEnforceGasCap(agent);
  if (gasCapTrippedClose) return;

  if (isLowGas) {
    const lastTick = agentLastCloseTick.get(agent.id) || 0;
    if (Date.now() - lastTick < LOW_GAS_TICK_INTERVAL_MS) {
      return;
    }
    agentLastCloseTick.set(agent.id, Date.now());
  }

  const preBackoffCount = positionsToClose.length;
  const now = Date.now();
  positionsToClose = positionsToClose.filter(({ pos, priority }) => {
    const isEmergencyPriority = priority <= 1;
    if (isEmergencyPriority) return true;
    const backoff = positionCloseBackoff.get(pos.id);
    if (backoff && now < backoff.nextAttemptAt) {
      return false;
    }
    return true;
  });
  if (positionsToClose.length < preBackoffCount) {
    console.log(`[TP/SL] ${agentConfig.name}: ${preBackoffCount - positionsToClose.length} positions in backoff cooldown — ${positionsToClose.length} eligible for close`);
  }

  if (positionsToClose.length === 0) return;

  let maxCloseThisTick = positionsToClose.length;
  if (isLowGas && positionsToClose.length > 1) {
    maxCloseThisTick = 1;
    console.log(`[TP/SL] ${agentConfig.name}: LOW GAS (${walletBalForLimit.toFixed(4)} SUI) — limiting to 1 close attempt this tick (highest priority: ${positionsToClose[0].reason}). ${positionsToClose.length - 1} positions deferred.`);
  } else if (positionsToClose.length > 1) {
    console.log(`[TP/SL] ${agentConfig.name}: ${positionsToClose.length} positions queued for close — priority order: ${positionsToClose.map(p => `${p.pos.id}(${p.reason},P${p.priority},risk=${p.riskScore.toFixed(1)})`).join(", ")}`);
  }

  let closesAttempted = 0;
  for (const { pos, reason, pnlPercent, collateralLossPct, priority } of positionsToClose) {
    if (closesAttempted >= maxCloseThisTick) break;
    const isEmergencyPriority = priority <= 1;
    const closeStartedAt = positionCloseInProgress.get(pos.id);
    if (closeStartedAt) {
      const elapsed = Date.now() - closeStartedAt;
      if (isEmergencyPriority) {
        console.log(`[TP/SL] EMERGENCY OVERRIDE: ${agentConfig.name} pos ${pos.id} close in-progress for ${Math.round(elapsed / 1000)}s — forcing re-entry for ${reason} (collateral loss ${collateralLossPct.toFixed(1)}%)`);
        positionCloseInProgress.delete(pos.id);
      } else if (elapsed > CLOSE_IN_PROGRESS_TIMEOUT_MS) {
        console.log(`[TP/SL] Close timeout: ${agentConfig.name} pos ${pos.id} in-progress for ${Math.round(elapsed / 1000)}s (>${CLOSE_IN_PROGRESS_TIMEOUT_MS / 1000}s) — allowing re-attempt for ${reason}`);
        positionCloseInProgress.delete(pos.id);
      } else {
        continue;
      }
    }

    if (isEmergencyPriority) {
      if (!emergencyDetectedAt.has(pos.id)) {
        emergencyDetectedAt.set(pos.id, Date.now());
      }
    } else {
      emergencyDetectedAt.delete(pos.id);
    }

    let freshPos: any = pos;
    try {
      const dbPos = await storage.getPosition(pos.id);
      if (dbPos) freshPos = dbPos;
    } catch {}
    const posCloseState = freshPos.closeState || "open";
    const posCloseAttempts = freshPos.closeAttempts || 0;
    if ((posCloseState === "manual_review" || posCloseAttempts >= MAX_CLOSE_ATTEMPTS_TOTAL) && !isEmergencyPriority) {
      continue;
    }

    const cooldownExpiry = positionCloseCooldown.get(pos.id);
    if (cooldownExpiry && Date.now() < cooldownExpiry && !isEmergencyPriority) {
      const cooldownPnl = pos.side === "long"
        ? (currentPrice - pos.entryPrice) * pos.sizeSui / currentPrice
        : (pos.entryPrice - currentPrice) * pos.sizeSui / currentPrice;
      const cooldownCollateral = pos.collateral || (pos.sizeSui / agentConfig.leverage);
      const maxGainCooldown = cooldownCollateral * Math.min((agentConfig.leverage || 36) - 1, 10);
      const cappedCooldownPnl = Math.min(maxGainCooldown, Math.max(-cooldownCollateral, cooldownPnl));
      storage.updatePosition(pos.id, { markPrice: currentPrice, unrealizedPnl: cappedCooldownPnl }).catch(() => {});

      if (adapter && adapter instanceof TypusAdapter && agentConfig.walletAddress && pos.onChainPositionId) {
        (async () => {
          try {
            const priorFill = await (adapter as TypusAdapter).checkPriorCloseFilled(agentConfig.walletAddress!, pos.onChainPositionId!);
            if (priorFill.filled) {
              console.log(`[TP/SL] Cooldown check: Position ${pos.onChainPositionId} for ${agentConfig.name} was FILLED on-chain (tx: ${priorFill.txDigest}). Settling now.`);
              positionCloseCooldown.delete(pos.id);
              pendingCloseOrders.delete(pos.id);
              await updateCloseState(pos.id, { closeState: "closed", closePendingSince: null });
              const settleResult = await closePositionForAgent(agentConfig, pos.id, currentPrice, false, reason);
              if (settleResult.closed) {
                console.log(`[TP/SL] Cooldown settle SUCCESS for ${agentConfig.name}: PnL=${settleResult.pnl.toFixed(4)} SUI`);
                await storage.updateAgent(agent.id, { lastExecutionError: null, lastExecutionAt: new Date() });
              }
            }
          } catch (checkErr: any) {
            console.log(`[TP/SL] Cooldown fill check error for ${agentConfig.name}: ${checkErr.message}`);
          }
        })();
      }
      continue;
    }
    if (cooldownExpiry) {
      positionCloseCooldown.delete(pos.id);
    }
    if (isEmergencyPriority) {
      console.log(`[TP/SL] EMERGENCY OVERRIDE: bypassing cooldown for ${agentConfig.name} pos ${pos.id} (${reason}, collateral loss ${collateralLossPct.toFixed(1)}%)`);
    }

    positionCloseInProgress.set(pos.id, Date.now());
    closesAttempted++;

    const effectiveMaxRetries = isLowGas ? LOW_GAS_MAX_RETRIES : MAX_CLOSE_RETRIES;

    (async () => {
      try {
        console.log(`[TP/SL] TRIGGERING ${reason} for ${agentConfig.name}: ${pos.side} ${pos.sizeSui.toFixed(2)} SUI @ entry=$${pos.entryPrice.toFixed(4)}, mark=$${currentPrice.toFixed(4)}, PnL=${pnlPercent.toFixed(3)}% (collateral loss ${collateralLossPct.toFixed(1)}%), effectiveSL=${effectiveSLThreshold.toFixed(3)}%, lev=${leverageMultiplier}x, liq@=${liquidationPricePct.toFixed(1)}%, maxCollLoss=${MAX_COLLATERAL_LOSS_PCT}%, onChainId=${pos.onChainPositionId || "NONE"}${isLowGas ? ` [LOW GAS: ${walletBalForLimit.toFixed(3)} SUI, max ${effectiveMaxRetries} retries]` : ""}`);

        let result = await closePositionForAgent(agentConfig, pos.id, currentPrice, false, reason);
        trackSessionGasSpend(agent.id, GAS_PER_OPERATION_ESTIMATE);

        for (let retry = 0; retry < effectiveMaxRetries - 1 && !result.closed; retry++) {
          if (result.error && result.error.includes("close_pending")) {
            console.log(`[TP/SL] ${reason} for ${agentConfig.name} pos ${pos.id}: close_pending — stopping retries, cooldown set.`);
            break;
          }
          if (result.error && result.error.includes("CLOSE_PERMANENTLY_BLOCKED")) {
            console.log(`[TP/SL] ${reason} for ${agentConfig.name} pos ${pos.id}: CLOSE_PERMANENTLY_BLOCKED — agent paused, no further retries.`);
            break;
          }
          if (result.error && result.error.includes("too_many_linked_orders")) {
            console.log(`[TP/SL] ${reason} for ${agentConfig.name} pos ${pos.id}: too_many_linked_orders after cancel+retry — cooldown set.`);
            break;
          }
          if (result.error && result.error.includes("CLOSE_GAS_CAP")) {
            console.log(`[TP/SL] ${reason} for ${agentConfig.name} pos ${pos.id}: CLOSE_GAS_CAP — agent paused, no further retries.`);
            break;
          }
          if (result.error && result.error.includes("INSUFFICIENT_GAS")) {
            console.log(`[TP/SL] ${reason} for ${agentConfig.name} pos ${pos.id}: INSUFFICIENT_GAS — stopping retries, will try again next tick when gas is available.`);
            break;
          }
          if (result.error && result.error.includes("RATE_LIMITED")) {
            const backoffBase = 3000 + retry * 2000;
            const jitter = Math.floor(Math.random() * 2000);
            const backoffMs = backoffBase + jitter;
            console.log(`[TP/SL] ${reason} for ${agentConfig.name} pos ${pos.id}: RPC rate limited — waiting ${(backoffMs / 1000).toFixed(1)}s before retry (progressive backoff ${retry + 1}).`);
            await new Promise(r => setTimeout(r, backoffMs));
            const freshPrice2 = getLastPrice();
            result = await closePositionForAgent(agentConfig, pos.id, freshPrice2?.blended || currentPrice, false, reason);
            trackSessionGasSpend(agent.id, GAS_PER_OPERATION_ESTIMATE);
            if (result.closed) break;
            continue;
          }
          const delay = RETRY_DELAYS_MS[retry] || 800;
          console.log(`[TP/SL] ${reason} attempt ${retry + 1} FAILED for ${agentConfig.name} pos ${pos.id} — retrying in ${delay}ms (${retry + 2}/${effectiveMaxRetries})...`);
          await new Promise(r => setTimeout(r, delay));

          const freshPrice = getLastPrice();
          const retryPrice = freshPrice?.blended || currentPrice;
          result = await closePositionForAgent(agentConfig, pos.id, retryPrice, false, reason);
          trackSessionGasSpend(agent.id, GAS_PER_OPERATION_ESTIMATE);
        }

        persistSessionGasToDb(agent.id);
        if (result.txDigest && !result.txDigest.startsWith("settled") && !result.txDigest.startsWith("sim_") && !result.txDigest.startsWith("keeper") && !result.txDigest.startsWith("position_gone") && !result.txDigest.startsWith("liquidated") && !result.txDigest.startsWith("cancelled")) {
          trackActualGasFromTx(agent.id, result.txDigest).catch(() => {});
        }

        if (!result.closed) {
          const isCooldownError = result.error && (result.error.includes("too_many_linked_orders") || result.error.includes("close_pending"));
          const isRateLimit = result.error && result.error.includes("RATE_LIMITED");
          const isGasError = result.error && result.error.includes("INSUFFICIENT_GAS");

          const existingBackoff = positionCloseBackoff.get(pos.id);
          const failCount = (existingBackoff?.failCount || 0) + 1;
          if (failCount > CLOSE_BACKOFF_SCHEDULE_MS.length) {
            console.log(`[TP/SL] ${reason} for ${agentConfig.name} pos ${pos.id}: ${failCount} consecutive failures — marking for manual review.`);
            positionCloseBackoff.delete(pos.id);
            await updateCloseState(pos.id, { closeState: "manual_review" });
          } else {
            const backoffMs = CLOSE_BACKOFF_SCHEDULE_MS[Math.min(failCount - 1, CLOSE_BACKOFF_SCHEDULE_MS.length - 1)];
            positionCloseBackoff.set(pos.id, { failCount, nextAttemptAt: Date.now() + backoffMs });
            console.log(`[TP/SL] ${agentConfig.name} pos ${pos.id}: close fail #${failCount} — next attempt in ${Math.round(backoffMs / 1000)}s (exponential backoff)`);
          }

          const retryMsg = isGasError ? "paused — need gas top-up" : isCooldownError ? `cooldown ${CLOSE_COOLDOWN_MS / 1000}s` : "will retry with backoff";
          console.log(`[TP/SL] ${reason} close FAILED for ${agentConfig.name} pos ${pos.id} after ${effectiveMaxRetries} attempts — ${retryMsg}. Error: ${result.error}`);

          if (isGasError) {
            await storage.updateAgent(agent.id, {
              status: "paused",
              lastExecutionError: `INSUFFICIENT_GAS: Cannot close ${reason} — wallet needs SUI top-up. Positions remain open until gas is available.`,
              lastExecutionAt: new Date(),
            });
            console.log(`[TP/SL] AUTO-PAUSED ${agentConfig.name} due to INSUFFICIENT_GAS — will auto-resume when gas is replenished.`);
          } else if (!isRateLimit) {
            await storage.updateAgent(agent.id, {
              lastExecutionError: `${reason.toUpperCase()} CLOSE FAILED: ${result.error || "on-chain close rejected"} — ${retryMsg}`,
              lastExecutionAt: new Date(),
            });
          }

          const emergencyStart = emergencyDetectedAt.get(pos.id);
          if (emergencyStart && (Date.now() - emergencyStart) > EMERGENCY_FORCE_SETTLE_TIMEOUT_MS) {
            console.log(`[TP/SL] FORCE-SETTLE: ${agentConfig.name} pos ${pos.id} has been at emergency level for ${Math.round((Date.now() - emergencyStart) / 1000)}s — attempting force-settle from on-chain state`);
            try {
              const forceResult = await closePositionForAgent(agentConfig, pos.id, currentPrice, false, "emergency-force-settle");
              if (forceResult.closed) {
                console.log(`[TP/SL] FORCE-SETTLE SUCCESS for ${agentConfig.name} pos ${pos.id}: PnL=${forceResult.pnl.toFixed(4)} SUI`);
                emergencyDetectedAt.delete(pos.id);
                positionCloseCooldown.delete(pos.id);
                pendingCloseOrders.delete(pos.id);
                await storage.updateAgent(agent.id, { lastExecutionError: null, lastExecutionAt: new Date() });
              }
            } catch (forceErr: any) {
              console.log(`[TP/SL] FORCE-SETTLE failed for ${agentConfig.name} pos ${pos.id}: ${forceErr.message}`);
            }
          }
        } else {
          positionCloseCooldown.delete(pos.id);
          pendingCloseOrders.delete(pos.id);
          emergencyDetectedAt.delete(pos.id);
          positionCloseBackoff.delete(pos.id);
          console.log(`[TP/SL] ${reason} close SUCCESS for ${agentConfig.name}: PnL=${result.pnl.toFixed(4)} SUI, onChain=${result.onChain}, tx=${result.txDigest || "none"}`);
          await storage.updateAgent(agent.id, {
            lastExecutionError: null,
            lastExecutionAt: new Date(),
          });
          try {
            const { broadcastPositionUpdate } = await import("../position-monitor");
            const remaining = await storage.getPositions(agent.id);
            const stillOpen = remaining.filter(p => p.status === "open" || p.status === "pending_open");
            broadcastPositionUpdate(agent.id, stillOpen.map(p => ({
              id: p.id, side: p.side, sizeSui: p.sizeSui, entryPrice: p.entryPrice,
              markPrice: p.markPrice, unrealizedPnl: p.unrealizedPnl,
              onChainPositionId: p.onChainPositionId, status: p.status, openedAt: p.openedAt,
            })), true);
          } catch {}
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

let lastPendingCloseCheck = 0;
const PENDING_CLOSE_CHECK_INTERVAL_MS = 6_000;
let lastDbPendingScan = 0;
const DB_PENDING_SCAN_INTERVAL_MS = 6_000;

async function scanDbPendingCloses(): Promise<void> {
  const now = Date.now();
  if (now - lastDbPendingScan < DB_PENDING_SCAN_INTERVAL_MS) return;
  lastDbPendingScan = now;

  try {
    const agents = await storage.getAgentsWithSignalAgents();
    for (const agent of agents) {
      const positions = await storage.getPositions(agent.id);
      const pendingPositions = positions.filter(p =>
        (p.status === "open" || p.status === "pending_open") &&
        ((p as any).closeState === "close_order_working" || (p as any).closeState === "close_tx_submitted")
      );

      for (const pos of pendingPositions) {
        if (positionCloseInProgress.has(pos.id)) continue;
        if (pendingCloseOrders.has(pos.id)) continue;

        const closePendingSince = (pos as any).closePendingSince;
        if (!closePendingSince) continue;
        const pendingAge = now - new Date(closePendingSince).getTime();
        if (pendingAge < CLOSE_COOLDOWN_MS) continue;

        if (!agent.walletAddress || !pos.onChainPositionId) continue;

        const adapter = getAdapter(agent.venue);
        if (!adapter || !(adapter instanceof TypusAdapter)) continue;

        try {
          let confirmedFilled = false;
          let fillTxDigest: string | null = null;

          const trackedOrders = await storage.getTrackedOrdersByPosition(pos.id);
          const closeOrders = trackedOrders.filter(o => o.orderType === "close");

          if (closeOrders.length > 0) {
            const allSubmitted = closeOrders.every(o => o.status === "submitted");
            if (allSubmitted) {
              const onChainPositions = await (adapter as TypusAdapter).getPositions(agent.walletAddress!);
              const stillOnChain = onChainPositions.some(p => String(p.positionId) === String(pos.onChainPositionId));
              if (!stillOnChain) {
                console.log(`[DbPendingScan] Tracked orders show ${closeOrders.length} submitted close order(s) and position ${pos.onChainPositionId} is GONE from on-chain. Keeper filled.`);
                confirmedFilled = true;
                fillTxDigest = closeOrders[0].txDigest || "keeper_filled_tracked";
                for (const order of closeOrders) {
                  await storage.updateTrackedOrder(order.id, { status: "filled", resolvedAt: new Date() });
                }
              }
            }
          }

          if (!confirmedFilled) {
            const priorFill = await (adapter as TypusAdapter).checkPriorCloseFilled(agent.walletAddress, pos.onChainPositionId);
            if (priorFill.filled) {
              confirmedFilled = true;
              fillTxDigest = priorFill.txDigest || "prior_fill";
            }
          }

          if (confirmedFilled) {
            console.log(`[DbPendingScan] Position ${pos.onChainPositionId} for ${agent.name} FILLED by keeper (tx: ${fillTxDigest}). Settling.`);
            await updateCloseState(pos.id, { closeState: "closed", closePendingSince: null });
            positionCloseCooldown.delete(pos.id);

            const lastPrice = getLastPrice();
            const price = lastPrice?.blended || pos.entryPrice;
            const result = await closePositionForAgent(agent, pos.id, price, false, "db-pending-fill");
            if (result.closed) {
              console.log(`[DbPendingScan] Settled ${agent.name} pos ${pos.id}: PnL=${result.pnl.toFixed(4)} SUI`);
              await storage.updateAgent(agent.id, { lastExecutionError: null, lastExecutionAt: new Date() });
            }
          } else if (pendingAge > CLOSE_PENDING_TTL_MS) {
            console.log(`[DbPendingScan] Position ${pos.id} for ${agent.name} pending for ${Math.round(pendingAge / 1000)}s (> ${CLOSE_PENDING_TTL_MS / 1000}s watchdog) — resetting for force-retry.`);
            await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
            positionCloseCooldown.delete(pos.id);
          } else if (pendingAge > PENDING_CLOSE_MAX_AGE_MS) {
            console.log(`[DbPendingScan] Position ${pos.id} for ${agent.name} pending for ${Math.round(pendingAge / 1000)}s — resetting state for retry.`);
            await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
          }
        } catch (checkErr: any) {
          console.log(`[DbPendingScan] Fill check error for ${agent.name} pos ${pos.id}: ${checkErr.message}`);
        }
      }
    }
    for (const agent of agents) {
      const positions = await storage.getPositions(agent.id);
      const manualReviewPositions = positions.filter(p =>
        (p.status === "open" || p.status === "pending_open") &&
        (p as any).closeState === "manual_review"
      );

      for (const pos of manualReviewPositions) {
        if (positionCloseInProgress.has(pos.id)) continue;
        if (!agent.walletAddress || !pos.onChainPositionId) continue;

        const adapter = getAdapter(agent.venue);
        if (!adapter || !(adapter instanceof TypusAdapter)) continue;

        try {
          const onChainPositions = await (adapter as TypusAdapter).getPositions(agent.walletAddress!);
          const stillOnChain = onChainPositions.some(p => String(p.positionId) === String(pos.onChainPositionId));

          if (!stillOnChain) {
            console.log(`[DbPendingScan] manual_review position ${pos.onChainPositionId} for ${agent.name} is GONE from on-chain. Auto-settling DB record.`);
            clearCloseGasTracking(pos.id);
            positionCloseCooldown.delete(pos.id);
            pendingCloseOrders.delete(pos.id);

            const lastPrice = getLastPrice();
            const price = lastPrice?.blended || pos.entryPrice;
            const pnlSui = pos.side === "long"
              ? (price - pos.entryPrice) * pos.sizeSui / price
              : (pos.entryPrice - price) * pos.sizeSui / price;
            const posCollateral = pos.collateral || (pos.sizeSui / (agent.leverage || 25));
            const maxGain = posCollateral * Math.min((agent.leverage || 25) - 1, 10);
            const cappedPnl = Math.min(maxGain, Math.max(-posCollateral, pnlSui));

            await storage.updatePosition(pos.id, {
              status: "closed",
              closeReason: "manual-review-settled",
              closeTxDigest: "settled_onchain",
              closedAt: new Date(),
              unrealizedPnl: 0,
              markPrice: price,
            });
            await updateCloseState(pos.id, { closeState: "closed", closeAttempts: 0, closePendingSince: null });

            const currentBalance = agent.balance || 0;
            await storage.updateAgent(agent.id, {
              balance: Math.max(0, currentBalance + cappedPnl),
              totalPnl: (agent.totalPnl || 0) + cappedPnl,
              totalTrades: (agent.totalTrades || 0) + 1,
            });
            console.log(`[DbPendingScan] Auto-settled manual_review pos ${pos.id} for ${agent.name}: PnL=${cappedPnl.toFixed(4)} SUI @ $${price.toFixed(4)}`);

            const remainingOpen = positions.filter(p => p.id !== pos.id && p.status === "open");
            if (remainingOpen.length === 0 && agent.status === "paused") {
              await storage.updateAgent(agent.id, { status: "running", lastExecutionError: null, lastExecutionAt: new Date() });
              console.log(`[DbPendingScan] Resumed ${agent.name} — all manual_review positions settled.`);
            }
          }
        } catch (checkErr: any) {
          console.log(`[DbPendingScan] manual_review check error for ${agent.name} pos ${pos.id}: ${checkErr.message}`);
        }
      }
    }
  } catch (err: any) {
    console.error(`[DbPendingScan] Error: ${err.message}`);
  }
}

export async function processPendingCloseOrders(): Promise<void> {
  const now = Date.now();

  scanDbPendingCloses().catch((err: any) => {
    console.error(`[PendingClose] DB scan error: ${err.message}`);
  });

  if (now - lastPendingCloseCheck < PENDING_CLOSE_CHECK_INTERVAL_MS) return;
  lastPendingCloseCheck = now;

  if (pendingCloseOrders.size === 0) return;

  for (const [posId, pending] of Array.from(pendingCloseOrders.entries())) {
    const age = now - pending.setAt;
    if (age < CLOSE_COOLDOWN_MS) continue;

    try {
      const pos = await storage.getPosition(posId);
      if (!pos || pos.status !== "open") {
        pendingCloseOrders.delete(posId);
        continue;
      }

      const cs = await getCloseState(pos);
      if (cs.closeState === "manual_review" || cs.closeAttempts >= MAX_CLOSE_ATTEMPTS_TOTAL) {
        console.log(`[PendingClose] Skipping ${posId} — already in ${cs.closeState} with ${cs.closeAttempts} attempts.`);
        pendingCloseOrders.delete(posId);
        continue;
      }

      const agent = await storage.getAgent(pos.agentId);
      if (!agent || !agent.walletAddress) {
        pendingCloseOrders.delete(posId);
        continue;
      }

      if (positionCloseInProgress.has(posId)) continue;

      const adapter = getAdapter(agent.venue);
      if (!adapter || !(adapter instanceof TypusAdapter)) continue;

      if (pos.onChainPositionId) {
        try {
          const priorFill = await (adapter as TypusAdapter).checkPriorCloseFilled(agent.walletAddress, pos.onChainPositionId);
          if (priorFill.filled) {
            console.log(`[PendingClose] Close order for ${agent.name} pos ${posId} was FILLED by keeper (tx: ${priorFill.txDigest}). Settling.`);
            pendingCloseOrders.delete(posId);
            positionCloseCooldown.delete(posId);
            await updateCloseState(posId, { closeState: "closed", closePendingSince: null });

            const lastPrice = getLastPrice();
            const price = lastPrice?.blended || pos.entryPrice;
            const result = await closePositionForAgent(agent, posId, price, false, "pending-close-fill");
            if (result.closed) {
              console.log(`[PendingClose] Settled ${agent.name} pos ${posId}: PnL=${result.pnl.toFixed(4)} SUI`);
              await storage.updateAgent(agent.id, { lastExecutionError: null, lastExecutionAt: new Date() });
            }
            continue;
          }
        } catch (checkErr: any) {
          console.log(`[PendingClose] Fill check error for ${agent.name}: ${checkErr.message}`);
        }
      }

      if (age > PENDING_CLOSE_MAX_AGE_MS) {
        console.log(`[PendingClose] Close order for ${agent.name} pos ${posId} expired after ${Math.round(age / 1000)}s — cancelling and letting close state machine handle retry.`);
        pendingCloseOrders.delete(posId);
        positionCloseCooldown.delete(posId);
        await updateCloseState(posId, { closeState: "close_requested", closePendingSince: null });

        if (agent.agentWallet && pos.onChainPositionId) {
          try {
            await (adapter as TypusAdapter).cancelPendingOrdersForPosition(agent.agentWallet, pos.onChainPositionId);
          } catch (cancelErr: any) {
            console.log(`[PendingClose] Cancel failed for ${agent.name}: ${cancelErr.message}`);
          }
        }
      }
    } catch (err: any) {
      console.log(`[PendingClose] Error processing pending close for pos ${posId}: ${err.message}`);
    }
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
  const isPending = !result.closed && result.error?.includes("close_pending");
  const bundleStatus = isVerified ? "recorded" : isPending ? "pending" : "rejected";

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
