import { storage } from "../storage";
import { getAdapter } from "./index";
import type { DexOrderParams, DexOrderResult } from "./types";
import type { Agent, AgentWithSignalAgent } from "../../shared/schema";
import { pushCommEvent } from "../comms-engine";
import { ensureMinGasReserve, COLLATERAL_GAS_RESERVE_SUI, GAS_PER_CLOSE_SUI, MIN_EXECUTABLE_GAS_SUI, isRateLimitError, buildMergeAllSuiCoinsTx, MAX_COLLATERAL_UTILIZATION, MIN_FREE_SUI_FLOOR, LOW_BALANCE_REWARD_SKIP_THRESHOLD } from "./gas";
import { decryptKeypair } from "./wallet-manager";
import { TypusAdapter } from "./typus-adapter";
import { getLastPrice } from "../price-service";
import { getMultiTFCandles, getLastTritonSignal } from "../market-engine";
import { createBundle, type Action, type RiskParams } from "../../shared/bundle";
import type { TradeSignal } from "../signal-engine";
import { MODE_PROFILES } from "../signal-engine";
import { adx as adxLast, atr as atrLast, emaSeries } from "../../shared/indicators";
import { logCloseOutcome, getEntryFeedback, getRecentAgentPerformance, logCloseFailure, logCloseSuccess, getPositionClosePreEmptiveActions, getAgentCompetitiveScore, getCapitalPlan, type CapitalPlan, type DynamicSlTp } from "../learning-engine";
import { getThrottledSuiClient, getCachedWalletBalance, setCachedWalletBalance, invalidateCachedWalletBalance, getRpcStats } from "../rpc-throttle";
import { recordFundFlow, settlePositionJournal, getCachedSnapshot, getAllCachedSnapshots } from "../reconciliation-engine";
import { getCachedOnChainPositions } from "../on-chain-cache";

const suiClient = getThrottledSuiClient();

const activeExecutions = new Set<string>();
const lastTradeMap = new Map<string, { direction: string; time: number }>();
const agentSkipStatusMap = new Map<string, { reason: string; time: number }>();
const agentNudgeMap = new Map<string, { time: number; userId?: string }>();
const NUDGE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const oracleMismatchCooldown = new Map<string, number>();
const dailyGasSpend = new Map<string, { totalMist: number; failedTxCount: number; resetAt: number }>();
const reconciliationInProgress = new Set<string>();
export const positionCloseInProgress = new Map<string, number>();
export const positionCloseCooldown = new Map<string, number>();
const pendingCloseOrders = new Map<string, { orderId?: string; txDigest?: string; setAt: number }>();
const positionReopenCounts = new Map<string, number>();
const CLOSE_COOLDOWN_MS = 3_000;
const EMERGENCY_CLOSE_COOLDOWN_MS = 800;
const PENDING_CLOSE_MAX_AGE_MS = 20_000;
// 90s gives the Typus keeper enough time to fill linked close orders.
// cancel_linked_orders is keeper-only so we can never drain stale linked orders ourselves.
// Raising TTL from 45s to 90s reduces the risk of filling up the 5-slot linked_orders array.
// MUST be longer than recoverUntrackedPositions REOPEN_COOLDOWN (600s) so
// a closing position is never reopened before TTL expires.
const CLOSE_PENDING_TTL_MS = 90_000;
// When Typus explicitly says "close_already_in_progress", freeze for even longer.
const CLOSE_ALREADY_IN_PROGRESS_FREEZE_MS = 180_000;
const MIN_CLOSE_RETRY_GAP_MS = 1_500;
const MAX_CLOSE_ATTEMPTS_TOTAL = 12;
// Dedup: don't call cancelPendingOrdersForPosition for the same position
// more than once per 60 seconds. Prevents the repeated cancel_trading_order
// storm where each 90s TTL expiry triggers multiple cancel calls.
const lastCancelAttemptMs = new Map<string, number>();
const CANCEL_DEDUP_WINDOW_MS = 60_000;
// Track how many TTL cycles we've extended without actually clearing linked orders.
// cancel_linked_orders is KEEPER_ONLY so drain always returns 0 cancelled.
// We extend the TTL window MAX_TTL_STALL_CYCLES times before forcing a price-refresh resubmit.
// With 90s TTL and 4 stall cycles: at most 1 new linked order every 4×90s = 6 minutes.
// Typus allows max 5 linked orders — this keeps us well inside the slot limit.
const ttlDrainStallCycles = new Map<string, number>();
const MAX_TTL_STALL_CYCLES = 4;
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

const ABSOLUTE_SESSION_GAS_CAP_SUI = 2.0;
const GAS_TO_DEPOSIT_RATIO_CAP = 0.10;
const GAS_CAP_CHECK_INTERVAL_MS = 30_000;
const SESSION_RESET_INTERVAL_MS = 6 * 60 * 60 * 1000;
const GAS_PER_OPERATION_ESTIMATE = 0.004;
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
          const correction = actualGasSui - GAS_PER_OPERATION_ESTIMATE;
          if (Math.abs(correction) > 0.0001) {
            session.spent = Math.max(0, session.spent + correction);
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
// Backoff schedule for ACTUAL close failures (bad TX, not found, etc.)
// NOT used for close_pending (those are working keeper orders, not failures)
const CLOSE_BACKOFF_SCHEDULE_MS = [20_000, 45_000, 90_000, 180_000];

// MULTI-POS-UNBLOCK cooldown: tracks when we last fired an unblock close attempt
// for each blocker (oldest same-side) position. Prevents the rapid monitor (500ms)
// from firing MULTI-POS-UNBLOCK on every tick and flooding the 5-slot linked_orders array.
const multiPosUnblockLastFired = new Map<string, number>();
const MULTI_POS_UNBLOCK_COOLDOWN_MS = 90_000; // match CLOSE_PENDING_TTL_MS

const agentLastCloseTick = new Map<string, number>();
const LOW_GAS_TICK_INTERVAL_MS = 30_000;

const manualCloseInProgress = new Set<string>();
const rewardCreationInProgress = new Set<string>();

const agentOnChainPosCache = new Map<string, { positions: any[]; timestamp: number }>();
const AGENT_ONCHAIN_POS_CACHE_TTL = 5_000;

const peakPnlTracker = new Map<string, {
  peakPnlPct: number;
  breakEvenLocked: boolean;
  trailingSLPct: number;
  lastPnlPct: number;
  consecutiveDeclineTicks: number;
}>();
const TRAILING_ACTIVATION_PCT = 0.25;
const TRAILING_DISTANCE_PCT = 0.20;
const BREAKEVEN_ACTIVATION_PCT = 0.12;
const POSITION_AGE_TIGHTEN_MS = 3 * 60 * 1000;
const POSITION_AGE_TIGHTEN_FACTOR = 0.70;

// Priority Engine — profit protection constants
const PROFIT_LOCK_MIN_AGE_MS = 20 * 60 * 1000;    // 20min+ positions eligible for TP escalation
const PROFIT_LOCK_MIN_PCT = 0.50;                   // >0.5% profit = escalation candidate
const PROFIT_LARGE_THRESHOLD_PCT = 0.80;            // >0.8% profit = urgent lock-in
const PROFIT_DECAY_URGENCY_TICKS = 3;              // 3 consecutive declining ticks = decaying
const PROFIT_DECAY_MIN_DROP_PCT = 0.06;            // each tick must drop ≥0.06% to count as decline

// Priority Engine — execution order constants
// ─────────────────────────────────────────────────────────────────────────────
// Execution Priority Ladder (highest → lowest):
//   P0  emergency-liquidation-prevent  — collateral loss ≥6%, near liquidation
//   P1  max-collateral-loss            — collateral loss ≥4%
//   P1  take-profit-urgent             — large profit (≥0.8%) actively decaying
//   P2  stop-loss / trailing-stop      — price hit SL or trailing level
//   P2  take-profit-protect            — old (≥20min) or large profitable position
//   P3  take-profit / signal-tp        — standard TP threshold
//   P4  [new position opens]           — only when NO P0-P3 close is pending
// ─────────────────────────────────────────────────────────────────────────────
const STALE_PENDING_OPEN_MS = 15 * 60 * 1000;      // abandon pending_open after 15 min — unblocks execution
const CLOSE_FIRST_CHECK_ENABLED = true;             // block new opens when existing positions qualify for close

function trackCloseGasSpend(positionId: string, gasMist: number = 4_000_000): { exceeded: boolean; reason?: string } {
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
  lastCancelAttemptMs.delete(positionId);
  ttlDrainStallCycles.delete(positionId);
  multiPosUnblockLastFired.delete(positionId);
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
      console.log(`[UnfilledOrders] Order ${pending.orderId} for ${pending.agentName} was FILLED (position_id=${fillResult}). Updating WAL position.`);
      try {
        const agent = await storage.getAgent(pending.agentId);
        if (agent) {
          const existingPositions = await storage.getPositions(pending.agentId);
          const walPosition = existingPositions.find(p => 
            p.status === "pending_open" && p.txDigest === pending.txDigest
          );
          if (walPosition) {
            await storage.updatePosition(walPosition.id, {
              onChainPositionId: fillResult,
              status: "open",
              verified: true,
            });
            console.log(`[UnfilledOrders] Updated WAL position ${walPosition.id} with on-chain ID ${fillResult} for delayed fill`);
          } else {
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
            console.log(`[UnfilledOrders] No WAL position found — created new position ${position.id} for delayed fill`);
          }
        }
      } catch (err: any) {
        console.log(`[UnfilledOrders] Error updating position for filled order ${pending.orderId}: ${err.message}`);
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
      try {
        const existingPositions = await storage.getPositions(pending.agentId);
        const walPos = existingPositions.find(p => p.status === "pending_open" && p.txDigest === pending.txDigest);
        if (walPos) {
          await storage.updatePosition(walPos.id, { status: "closed", closeTxDigest: "cancelled_unfilled", closeState: "closed", closeReason: "Unfilled order cancelled" } as any);
          console.log(`[UnfilledOrders] Cleaned up WAL position ${walPos.id} after cancel`);
        }
      } catch {}
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
          console.log(`[UnfilledOrders] Order ${pending.orderId} was actually FILLED! position_id=${secondCheck}. Updating WAL position...`);
          try {
            const agent = await storage.getAgent(pending.agentId);
            if (agent) {
              const existingPositions = await storage.getPositions(pending.agentId);
              const walPos = existingPositions.find(p => p.status === "pending_open" && p.txDigest === pending.txDigest);
              if (walPos) {
                await storage.updatePosition(walPos.id, {
                  onChainPositionId: secondCheck,
                  status: "open",
                  verified: true,
                });
                console.log(`[UnfilledOrders] Updated WAL position ${walPos.id} with on-chain ID ${secondCheck} for late fill`);
              } else {
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
                console.log(`[UnfilledOrders] No WAL position found — created new position ${position.id} for late fill`);
              }
            }
          } catch (err: any) {
            console.log(`[UnfilledOrders] Error updating position for late fill: ${err.message}`);
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
          console.log(`[UnfilledOrders] Balance confirms order ${pending.orderId} WAS filled. Updating WAL position for resolver.`);
          try {
            const existingPositions2 = await storage.getPositions(pending.agentId);
            const walPos2 = existingPositions2.find(p => p.status === "pending_open" && p.txDigest === pending.txDigest);
            if (walPos2) {
              await storage.updatePosition(walPos2.id, { verified: true });
              trackPendingPositionResolution(walPos2.id, pending.agentId, pending.agentName, walletAddr, pending.orderId);
              console.log(`[UnfilledOrders] WAL position ${walPos2.id} confirmed by balance for order ${pending.orderId} — resolver will find on-chain ID`);
            } else {
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
              console.log(`[UnfilledOrders] No WAL position — created new position ${position.id} from balance-confirmed fill`);
            }
          } catch (err: any) {
            console.log(`[UnfilledOrders] Error updating balance-confirmed position: ${err.message}`);
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

const TRADE_COOLDOWN_MS = 30_000;
const POST_CLOSE_COOLDOWN_MS = 20_000;

/** Mode-specific post-close cooldown: AGGRESSIVE re-enters faster after winning closes.
 *  Loss cooldown and liquidation block still fully apply regardless of mode.
 *  NOW mode: no post-close cooldown — enters immediately at next signal. */
function getPostCloseCooldownMs(signalMode: string): number {
  if (signalMode === "NOW") return 0;
  if (signalMode === "AGGRESSIVE") return 5_000;
  if (signalMode === "PRECISION") return 30_000;
  return 20_000; // AUTO
}

/** Mode-specific same-direction trade cooldown. */
function getTradeCooldownMs(signalMode: string): number {
  if (signalMode === "NOW") return 0;
  if (signalMode === "AGGRESSIVE") return 10_000;
  if (signalMode === "PRECISION") return 30_000;
  return 20_000; // AUTO
}
const ORACLE_MISMATCH_COOLDOWN_MS = 3_000;
const MAX_OPEN_POSITIONS_PER_AGENT = 2;
const agentOpeningLock = new Set<string>();
const agentCapitalPlanCache = new Map<string, { plan: CapitalPlan; fetchedAt: number }>();
const CAPITAL_PLAN_CACHE_TTL = 60_000;

export function invalidateCapitalPlanCache(agentId: string): void {
  agentCapitalPlanCache.delete(agentId);
}

// Short breathing room after a single loss — enough for the market to reprice but not so
// long that it suppresses trading in a trending market.
const BASE_LOSS_COOLDOWN_MS = 10 * 1000; // 10s per loss — minimal cooling, just debounce
// After a streak, give the market more time to stabilise. Capped at 1× to prevent the
// multiplier spiralling to 3× 20min = 60min from double-recorded closes.
const STREAK_LOSS_COOLDOWN_MS = 30 * 1000; // 30s max even during a streak
const STREAK_LOSS_THRESHOLD = 15; // streak gate only triggers after 15+ consecutive losses
const COOLDOWN_SCALE_FACTOR = 1.05; // minimal exponential growth — streak cap hit almost immediately
const lossCooldownMap = new Map<string, { consecutiveLosses: number; lastLossAt: number }>();

// Deduplication guard: track which position IDs have already had a loss recorded in
// the last 10 minutes. Prevents multiple recovery / reconciliation code paths from
// each independently calling recordTradeLoss for the SAME closed position, which was
// inflating the streak counter (e.g., 1 actual close → 8 recorded "losses").
const recentLossPositions = new Map<string, number>(); // positionId → recordedAt ms
const LOSS_DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// Periodic cleanup: purge entries older than LOSS_DEDUP_WINDOW_MS to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [posId, ts] of recentLossPositions) {
    if (now - ts > LOSS_DEDUP_WINDOW_MS) recentLossPositions.delete(posId);
  }
}, LOSS_DEDUP_WINDOW_MS).unref();

export function recordTradeLoss(agentId: string, positionId?: string): void {
  if (positionId) {
    const last = recentLossPositions.get(positionId);
    if (last && Date.now() - last < LOSS_DEDUP_WINDOW_MS) {
      console.log(`[LossCooldown] Agent ${agentId}: DEDUP — position ${positionId} loss already recorded ${Math.round((Date.now()-last)/1000)}s ago, skipping`);
      return;
    }
    recentLossPositions.set(positionId, Date.now());
  }
  const current = lossCooldownMap.get(agentId) || { consecutiveLosses: 0, lastLossAt: 0 };
  current.consecutiveLosses += 1;
  current.lastLossAt = Date.now();
  lossCooldownMap.set(agentId, current);
  const cooldownMs = getCooldownMs(current.consecutiveLosses);
  console.log(`[LossCooldown] Agent ${agentId}: ${current.consecutiveLosses} consecutive losses, cooldown=${Math.round(cooldownMs / 1000)}s${positionId ? ` (pos=${positionId.slice(0, 8)})` : ""}`);
}

export function recordTradeWin(agentId: string): void {
  lossCooldownMap.delete(agentId);
  agentCapitalPlanCache.delete(agentId);
}

/**
 * Manually clear the consecutive-loss streak for an agent.
 * Used by the admin API and called on agent restart/mode changes to prevent
 * stale in-memory streaks from blocking a healthy, newly-configured agent.
 */
export function clearStreakCooldown(agentId: string): void {
  lossCooldownMap.delete(agentId);
  console.log(`[LossCooldown] Streak cleared for agent ${agentId}`);
}

export function getConsecutiveLosses(agentId: string): number {
  return lossCooldownMap.get(agentId)?.consecutiveLosses || 0;
}

// ─── Liquidation hard block ─────────────────────────────────────────────────
// After ANY liquidation (keeper or self-triggered), all new entries are blocked
// for 30 minutes regardless of signal strength or mode.  This is separate from
// the loss-cooldown which is score-gated and can be bypassed by strong signals.
// A liquidation = 100% collateral destruction — the most severe failure mode.
const LIQUIDATION_HARD_BLOCK_MS = 30 * 60 * 1000; // 30 minutes
const liquidationHardBlockMap = new Map<string, number>(); // agentId -> timestamp

export function recordLiquidationEvent(agentId: string, positionId?: string): void {
  liquidationHardBlockMap.set(agentId, Date.now());
  // Also counts as a trade loss for the consecutive-loss gate (deduped by positionId)
  recordTradeLoss(agentId, positionId);
  console.log(`[LiquidationBlock] Agent ${agentId}: LIQUIDATION — hard-blocking new entries for 30 minutes${positionId ? ` (pos=${positionId.slice(0, 8)})` : ""}`);
}

export function isLiquidationBlocked(agentId: string): { blocked: boolean; reason?: string } {
  const lastLiqAt = liquidationHardBlockMap.get(agentId);
  if (!lastLiqAt) return { blocked: false };
  const elapsed = Date.now() - lastLiqAt;
  if (elapsed < LIQUIDATION_HARD_BLOCK_MS) {
    const remaining = Math.ceil((LIQUIDATION_HARD_BLOCK_MS - elapsed) / 60000);
    return { blocked: true, reason: `LIQUIDATION_BLOCK: ${remaining}m cooldown after liquidation` };
  }
  return { blocked: false };
}

/** Combined per-agent block status — used by the activity endpoint for UI display */
export function getAgentBlockStatus(agentId: string): {
  liquidationBlock: { active: boolean; remainingMs: number } | null;
  consecutiveLosses: number;
  lossCooldown: { active: boolean; remainingMs: number } | null;
} {
  const liq = isLiquidationBlocked(agentId);
  const liqLastAt = liquidationHardBlockMap.get(agentId);
  const liqRemaining = liqLastAt ? Math.max(0, LIQUIDATION_HARD_BLOCK_MS - (Date.now() - liqLastAt)) : 0;

  const losses = getConsecutiveLosses(agentId);
  const record = lossCooldownMap.get(agentId);
  let cooldownRemaining = 0;
  let cooldownActive = false;
  if (record && record.lastLossAt > 0) {
    const elapsed = Date.now() - record.lastLossAt;
    const cdMs = getCooldownMs(record.consecutiveLosses);
    if (elapsed < cdMs) { cooldownActive = true; cooldownRemaining = cdMs - elapsed; }
  }

  return {
    liquidationBlock: liq.blocked ? { active: true, remainingMs: liqRemaining } : null,
    consecutiveLosses: losses,
    lossCooldown: cooldownActive ? { active: true, remainingMs: cooldownRemaining } : null,
  };
}

function getCooldownMs(consecutiveLosses: number): number {
  if (consecutiveLosses >= STREAK_LOSS_THRESHOLD) {
    // Cap multiplier at 1 — max streak cooldown is always 1× STREAK_LOSS_COOLDOWN_MS.
    // The old 3× cap turned one doubled-counted close into a 60-min block.
    return STREAK_LOSS_COOLDOWN_MS;
  }
  return Math.min(
    BASE_LOSS_COOLDOWN_MS * Math.pow(COOLDOWN_SCALE_FACTOR, consecutiveLosses - 1),
    STREAK_LOSS_COOLDOWN_MS, // never exceed streak threshold even on the exponential path
  );
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
        if (ageMs > STALE_PENDING_OPEN_MS && pos.status === "pending_open") {
          console.log(`[VerifyRecover] Position ${pos.id} stuck as pending_open for ${Math.round(ageMs / 60000)}m (>${Math.round(STALE_PENDING_OPEN_MS / 60000)}min limit) — checking on-chain balance before marking stale`);
          try {
            const balResp = await suiClient.getBalance({ owner: agent.walletAddress!, coinType: "0x2::sui::SUI" });
            const onChainBal = Number(balResp.totalBalance) / 1e9;
            const expectedCollateral = pos.collateral || pos.sizeSui / (agent.leverage || 25);
            if (onChainBal >= expectedCollateral * 0.8) {
              console.log(`[VerifyRecover] Balance ${onChainBal.toFixed(4)} SUI confirms collateral returned. Position ${pos.id} was never truly opened — closing as settled.`);
              await storage.updatePosition(pos.id, { status: "closed", closeReason: "never_opened_settled", verified: true });
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

/** Returns how many minutes the agent has been idle (since last trade). 9999 if never traded. */
export function getAgentIdleMinutes(agentId: string): number {
  const lastTrade = lastTradeMap.get(agentId);
  return lastTrade ? (Date.now() - lastTrade.time) / 60_000 : 9999;
}

/**
 * Seed lastTradeMap from the database on startup.
 * Without this, all agents appear idle for 9999 minutes after server restart,
 * making idle relaxation thresholds inaccurate and potentially triggering
 * micro-scalp too aggressively or too conservatively.
 */
export function initializeAgentIdleFromDb(agents: { id: string; lastExecutionAt?: Date | null; lastSignalSide?: string | null }[]): void {
  for (const agent of agents) {
    if (agent.lastExecutionAt && !lastTradeMap.has(agent.id)) {
      const lastTradeTime = new Date(agent.lastExecutionAt).getTime();
      const direction = agent.lastSignalSide === "short" ? "short" : "long";
      lastTradeMap.set(agent.id, { direction, time: lastTradeTime });
      const idleMin = (Date.now() - lastTradeTime) / 60_000;
      console.log(`[IdleInit] ${agent.id.slice(0, 8)}: idle ${idleMin.toFixed(0)}min (last trade: ${new Date(lastTradeTime).toISOString()})`);
    }
  }
}

export function setAgentNudge(agentId: string, userId?: string): void {
  agentNudgeMap.set(agentId, { time: Date.now(), userId });
  console.log(`[Nudge] ${agentId.slice(0, 8)}: human nudge set — threshold -8pts for 15min`);
}

export function isNudgeActive(agentId: string): boolean {
  const n = agentNudgeMap.get(agentId);
  if (!n) return false;
  return Date.now() - n.time < NUDGE_TTL_MS;
}

export function getNudgeState(agentId: string): { active: boolean; remainingMs: number; setAt?: number } {
  const n = agentNudgeMap.get(agentId);
  if (!n) return { active: false, remainingMs: 0 };
  const age = Date.now() - n.time;
  if (age >= NUDGE_TTL_MS) return { active: false, remainingMs: 0 };
  return { active: true, remainingMs: NUDGE_TTL_MS - age, setAt: n.time };
}

export function getAgentSkipStatus(agentId: string): { reason: string; ageMs: number } | null {
  const s = agentSkipStatusMap.get(agentId);
  if (!s) return null;
  return { reason: s.reason, ageMs: Date.now() - s.time };
}

function recordSkipReason(agentId: string, reason: string): void {
  agentSkipStatusMap.set(agentId, { reason, time: Date.now() });
}
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

const MAX_COLLATERAL_LOSS_PCT = 4;
// T1-D: Lowered from 6% to 3.5% — emergency trigger must fire BEFORE the 5s
// monitor tick has a chance to miss a rapidly-moving position. At 32x leverage,
// 3.5% collateral loss = 0.109% adverse price move (still well before liquidation
// at 3.125% / 100% collateral loss).
const EMERGENCY_COLLATERAL_LOSS_PCT = 3.5;
// Hard cap on leverage — raised to 50x per user request (2026-03-25), matching Typus Perps max.
// At 50x leverage a 2.0% adverse move triggers liquidation. Monitor acts within 500ms.
// Anti-liquidation protection (4% collateral loss cap) activates well before liquidation at all levels.
const MAX_LEVERAGE_HARD_CAP = 50;
const MIN_SECOND_POS_AGE_MS = 5 * 60 * 1000;
const lastCloseMap = new Map<string, number>();
const MAX_CLOSE_RETRIES = 5;
const RETRY_DELAYS_MS = [300, 500, 800, 1200, 2000];
const SKIP_BUNDLE_COOLDOWN_MS = 60_000;
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
            const allDbPositions = await storage.getPositions(agentId);
            for (const ocp of onChainPositions) {
              const trackedAsOpen = openPos.some(p => p.onChainPositionId && String(p.onChainPositionId) === String(ocp.positionId));
              if (!trackedAsOpen) {
                const posCollateral = ocp.collateral || (ocp.size / (agentNow.leverage || 25));
                onChainLockedCollateral += posCollateral;
                console.log(`[BalanceSync] RECONCILIATION: Found on-chain position ${ocp.positionId} (${ocp.side} ${ocp.size?.toFixed(2)} SUI) not tracked as open in DB — adding ${posCollateral.toFixed(4)} SUI locked collateral`);

                // If this on-chain position matches a DB position with a synthetic close
                // (settled_onchain / position_gone_onchain), reopen it so the position
                // monitor can manage it properly.
                const syntheticClosed = allDbPositions.find(p =>
                  p.onChainPositionId === ocp.positionId &&
                  p.status === "closed" &&
                  (p.closeTxDigest === "settled_onchain" || p.closeTxDigest === "position_gone_onchain") &&
                  p.closedAt &&
                  (Date.now() - new Date(p.closedAt).getTime()) > 3 * 60 * 1000
                );
                if (syntheticClosed) {
                  try {
                    await storage.updatePosition(syntheticClosed.id, {
                      status: "open",
                      closeState: "open",
                      unrealizedPnl: 0,
                      closedAt: null,
                      closeTxDigest: null,
                      closeReason: null,
                      verified: true,
                    } as any);
                    console.log(`[BalanceSync] RECONCILIATION: Re-opened synthetic-closed position ${syntheticClosed.id.slice(0, 8)} for on-chain ID ${ocp.positionId} — was incorrectly marked ${syntheticClosed.closeTxDigest}`);
                  } catch (reopenErr: any) {
                    console.log(`[BalanceSync] RECONCILIATION: Failed to re-open position ${syntheticClosed.id.slice(0, 8)}: ${reopenErr.message}`);
                  }
                }
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
        if (Math.abs(correctPnl - dbPnl) > 0.1) {
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

/**
 * computeDynamicThreshold — centralised threshold adjustment logic.
 *
 * Inputs:
 *   baseThreshold     — mode profile's base threshold (e.g. 55)
 *   regime            — current market regime
 *   chopScalp         — signal engine flagged chop-scalp setup
 *   microScalp        — signal engine flagged micro-scalp setup (anti-idle)
 *   idleMinutes       — minutes since agent last placed a trade
 *   consecutiveLosses — running loss streak for the agent
 *   score             — effective score after learning penalties
 *   volumePressure    — pts to reduce from threshold due to behind-on-volume milestones
 *
 * Returns:
 *   effectiveThreshold — final threshold to compare score against
 *   adjustments        — human-readable list of applied changes
 */
function computeDynamicThreshold(params: {
  baseThreshold: number;
  regime: string;
  chopScalp: boolean;
  microScalp: boolean;
  idleMinutes: number;
  consecutiveLosses: number;
  score: number;
  nudgeActive?: boolean;
  agentBalance?: number;
  volumePressure?: number;
}): { effectiveThreshold: number; adjustments: string[] } {
  const { baseThreshold, regime, chopScalp, microScalp, idleMinutes, consecutiveLosses, score, nudgeActive, agentBalance, volumePressure } = params;
  let threshold = baseThreshold;
  const adjustments: string[] = [];

  // ── CHOP_SCALP: fixed threshold of 42 ──────────────────────────────────────
  if (regime === "CHOP_SCALP" || chopScalp) {
    threshold = 42;
    adjustments.push("CHOP_SCALP: threshold fixed at 42");

    if (idleMinutes >= 90 && score >= 38) {
      threshold = 38;
      adjustments.push(`90min idle soft-force → threshold 38 (idle ${idleMinutes.toFixed(0)}min)`);
    }
    if (idleMinutes >= 180 && score >= 34) {
      threshold = 34;
      adjustments.push(`3h idle override → threshold 34`);
    }
    if (nudgeActive) {
      threshold = Math.max(threshold - 8, 26);
      adjustments.push(`nudge: -8pts → ${threshold}`);
    }
    return { effectiveThreshold: threshold, adjustments };
  }

  // ── MICRO_SCALP (anti-idle): very relaxed threshold ─────────────────────────
  if (microScalp) {
    threshold = Math.min(threshold, 38);
    adjustments.push(`microScalp: threshold capped at 38 (idle ${idleMinutes.toFixed(0)}min)`);
    if (idleMinutes >= 180) { threshold = 32; adjustments.push("3h micro-scalp threshold → 32"); }
    if (idleMinutes >= 360) { threshold = 28; adjustments.push("6h micro-scalp threshold → 28"); }
    if (idleMinutes >= 540) { threshold = 24; adjustments.push("9h micro-scalp threshold → 24"); }
    if (nudgeActive) {
      threshold = Math.max(threshold - 8, 20);
      adjustments.push(`nudge: -8pts → ${threshold}`);
    }
    return { effectiveThreshold: threshold, adjustments };
  }

  // ── TREND regime incentive: -9 pts, floor 32 ────────────────────────────────
  if (regime === "TREND") {
    const newThreshold = Math.max(threshold - 9, 32);
    if (newThreshold < threshold) {
      adjustments.push(`TREND bonus: threshold ${threshold} → ${newThreshold}`);
      threshold = newThreshold;
    }
  }

  // ── RANGE regime incentive: -6 pts, floor 32 ────────────────────────────────
  if (regime === "RANGE") {
    const newThreshold = Math.max(threshold - 6, 32);
    if (newThreshold < threshold) {
      adjustments.push(`RANGE bonus: threshold ${threshold} → ${newThreshold}`);
      threshold = newThreshold;
    }
  }

  // ── General idle relaxation (non-CHOP regimes) ───────────────────────────────
  // Very aggressive progressive threshold reduction — idle agents MUST trade.
  // 15min: -3pts; 30min: -6pts; 1h: -12pts; 2h: -18pts; 3h: -24pts;
  // 4h: -30pts; 6h: -36pts; 8h: floor 10; 12h+: floor 8 (near-force).
  if (idleMinutes >= 720) {
    const newThreshold = Math.max(threshold - 42, 8); // 12h+ — nearly force any setup
    if (newThreshold < threshold) {
      adjustments.push(`12h idle FORCE: threshold ${threshold} → ${newThreshold}`);
      threshold = newThreshold;
    }
  } else if (idleMinutes >= 480) {
    const newThreshold = Math.max(threshold - 38, 10); // 8h — force good setups
    if (newThreshold < threshold) {
      adjustments.push(`8h idle FORCE: threshold ${threshold} → ${newThreshold}`);
      threshold = newThreshold;
    }
  } else if (idleMinutes >= 360) {
    const newThreshold = Math.max(threshold - 34, 12); // 6h — very aggressive
    if (newThreshold < threshold) {
      adjustments.push(`6h idle relaxation: threshold ${threshold} → ${newThreshold}`);
      threshold = newThreshold;
    }
  } else if (idleMinutes >= 240) {
    const newThreshold = Math.max(threshold - 28, 16); // 4h
    if (newThreshold < threshold) {
      adjustments.push(`4h idle relaxation: threshold ${threshold} → ${newThreshold}`);
      threshold = newThreshold;
    }
  } else if (idleMinutes >= 180) {
    const newThreshold = Math.max(threshold - 22, 20); // 3h
    if (newThreshold < threshold) {
      adjustments.push(`3h idle relaxation: threshold ${threshold} → ${newThreshold}`);
      threshold = newThreshold;
    }
  } else if (idleMinutes >= 120) {
    const newThreshold = Math.max(threshold - 16, 24); // 2h
    if (newThreshold < threshold) {
      adjustments.push(`2h idle relaxation: threshold ${threshold} → ${newThreshold}`);
      threshold = newThreshold;
    }
  } else if (idleMinutes >= 60) {
    const newThreshold = Math.max(threshold - 10, 28); // 1h
    if (newThreshold < threshold) {
      adjustments.push(`1h idle relaxation: threshold ${threshold} → ${newThreshold}`);
      threshold = newThreshold;
    }
  } else if (idleMinutes >= 30) {
    const newThreshold = Math.max(threshold - 6, 32); // 30min
    if (newThreshold < threshold) {
      adjustments.push(`30min idle relaxation: threshold ${threshold} → ${newThreshold}`);
      threshold = newThreshold;
    }
  } else if (idleMinutes >= 15) {
    const newThreshold = Math.max(threshold - 3, 36); // 15min
    if (newThreshold < threshold) {
      adjustments.push(`15min idle relaxation: threshold ${threshold} → ${newThreshold}`);
      threshold = newThreshold;
    }
  }

  // ── Volume milestone pressure ─────────────────────────────────────────────────
  // When an agent is behind on required volume targets, increase urgency by
  // lowering the threshold further. Volume targets: 2h, 4h, 8h, 12h, 24h.
  if (volumePressure && volumePressure > 0) {
    const newThreshold = Math.max(threshold - volumePressure, 20);
    if (newThreshold < threshold) {
      adjustments.push(`volume pressure: -${volumePressure}pts → ${newThreshold}`);
      threshold = newThreshold;
    }
  }

  // ── Growth mode: small balance agents get extra incentive ───────────────────
  // Agents with < 20 SUI need to compound aggressively to grow.
  if (agentBalance !== undefined && agentBalance < 20 && agentBalance > 0) {
    const growthBonus = agentBalance < 5 ? 7 : agentBalance < 10 ? 5 : 4;
    const newThreshold = Math.max(threshold - growthBonus, 20);
    if (newThreshold < threshold) {
      adjustments.push(`growth mode (${agentBalance.toFixed(1)} SUI): -${growthBonus}pts → ${newThreshold}`);
      threshold = newThreshold;
    }
  }

  // ── Human nudge: user signals this is a good entry ──────────────────────────
  if (nudgeActive) {
    const newThreshold = Math.max(threshold - 8, 22);
    if (newThreshold < threshold) {
      adjustments.push(`human nudge: -8pts → ${newThreshold}`);
      threshold = newThreshold;
    }
  }

  // ── Consecutive losses penalty: +3 per loss beyond 4 (max +9) ───────────────
  if (consecutiveLosses >= 4) {
    const penalty = Math.min((consecutiveLosses - 3) * 3, 9);
    threshold = Math.min(threshold + penalty, 80);
    adjustments.push(`streak-loss guard: +${penalty} (${consecutiveLosses} losses) → ${threshold}`);
  }

  return { effectiveThreshold: threshold, adjustments };
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
    const isNowMode = mode === "NOW";
    if (tritonSignal.side === "NONE") {
      recordSkipReason(agent.id, `No signal — ${tritonSignal.regime} regime, score ${tritonSignal.score}`);
      console.log(`[Triton] ${agent.name}: SKIP — side=NONE | mode=${mode} regime=${tritonSignal.regime} htf=${tritonSignal.htfBias} score=${tritonSignal.score} | ${tritonSignal.reasons.slice(0, 4).join('; ')}`);
      return null;
    }
    if (Date.now() > tritonSignal.validUntilMs) {
      recordSkipReason(agent.id, `Signal expired — ${tritonSignal.side} score ${tritonSignal.score}`);
      console.log(`[Triton] ${agent.name}: SKIP — signal expired (${Math.round((Date.now() - tritonSignal.validUntilMs) / 1000)}s ago) | ${tritonSignal.side} score=${tritonSignal.score}`);
      return null;
    }

    const consecutiveLosses = getConsecutiveLosses(agent.id);
    let effectiveScore = tritonSignal.score;
    let feedbackReason = "";
    const highConfidenceScore = Math.min(Math.round(profile.threshold * 1.08), 75); // strong signal — capped at 75 (was 1.2×/80)

    // Learning engine feedback — NOW mode skips hard blocks, keeps score penalties.
    if (!isNowMode) {
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
    }

    // Capital plan gate — applies to all modes but with mode-appropriate threshold.
    try {
      let earlyPlan = agentCapitalPlanCache.get(agent.id)?.plan;
      if (!earlyPlan) {
        earlyPlan = await getCapitalPlan(agent.id, agent.balance, 0);
        agentCapitalPlanCache.set(agent.id, { plan: earlyPlan, fetchedAt: Date.now() });
      }
      if (!isNowMode && earlyPlan.adaptiveScoreBonus !== 0) {
        const bonus = earlyPlan.adaptiveScoreBonus;
        const adaptiveThreshold = profile.threshold + bonus;
        // Log but do NOT hard-block — the dynamic threshold system already handles idle/risk adjustments.
        // Stacking capital plan +5 on top of PRECISION(63) made the effective bar 68, blocking all trading.
        feedbackReason += ` [capital plan: threshold note ${bonus > 0 ? "+" : ""}${bonus} → ${adaptiveThreshold} (advisory)]`;
      }

      // Win rate gate: non-NOW modes require a higher-quality signal at very low win rates.
      // Micro-scalp anti-idle signals get a significantly relaxed gate (10% instead of 15%)
      // because they use very tight SL/TP ranges designed for high-frequency compounding.
      // CHOP_SCALP is also slightly relaxed (12%) since it uses range mean-reversion.
      const isMicroScalpSignal = tritonSignal.microScalp === true;
      const isChopScalpSignal2 = tritonSignal.chopScalp === true;
      const agentAntiIdleEnabled = (agent as any).antiIdleEnabled !== false;
      const winRateGateThreshold = (isMicroScalpSignal && agentAntiIdleEnabled) ? 0.02
        : (isChopScalpSignal2 && agentAntiIdleEnabled) ? 0.03
        : 0.03; // Only block if win rate is catastrophically low (<3%)
      const winRateMinScore = (isMicroScalpSignal && agentAntiIdleEnabled) ? 20
        : (isChopScalpSignal2 && agentAntiIdleEnabled) ? 22
        : Math.min(Math.round(profile.threshold * 0.85), 50); // Require much less for win rate gate
      if (!isNowMode && earlyPlan.recentWinRate !== undefined && earlyPlan.recentWinRate < winRateGateThreshold) {
        if (effectiveScore < winRateMinScore) {
          const reason = `WIN_RATE_GATE: Recent win rate ${(earlyPlan.recentWinRate * 100).toFixed(0)}% < ${(winRateGateThreshold * 100).toFixed(0)}% — requires score ≥ ${winRateMinScore}, got ${effectiveScore}`;
          recordSkipReason(agent.id, reason);
          console.log(`[Triton] ${agent.name}: SKIP — ${reason}`);
          return null;
        }
      }
    } catch {}

    // Human nudge: if active, add +6 to the effective score (user intuition bonus)
    const nudgeActiveNow = isNudgeActive(agent.id);
    if (nudgeActiveNow) {
      effectiveScore = Math.min(effectiveScore + 6, 100);
      feedbackReason += ` [human nudge: +6 → effective ${effectiveScore}]`;
    }

    // Volume milestone pressure — agent behind on volume targets gets relaxed threshold.
    // Milestones: 2h, 4h, 8h, 12h, 24h. Behind on each milestone = lower threshold.
    let volumePressure = 0;
    try {
      const configuredDailyTarget = (agent as any).dailyVolumeTargetSui ?? 0;
      if (configuredDailyTarget > 0 && (agent as any).volumeTargetEnabled !== false) {
        const allPos = await storage.getPositions(agent.id);
        const closedPos = allPos.filter(p => p.status === "closed" && p.closedAt);
        const now2 = Date.now();
        const getTs = (p: any) => p.closedAt ? new Date(p.closedAt as unknown as string).getTime() : 0;
        const vol2h = closedPos.filter(p => now2 - getTs(p) < 2*3600*1000).reduce((s,p)=>s+(p.sizeSui||0),0);
        const vol4h = closedPos.filter(p => now2 - getTs(p) < 4*3600*1000).reduce((s,p)=>s+(p.sizeSui||0),0);
        const vol8h = closedPos.filter(p => now2 - getTs(p) < 8*3600*1000).reduce((s,p)=>s+(p.sizeSui||0),0);
        const vol12h = closedPos.filter(p => now2 - getTs(p) < 12*3600*1000).reduce((s,p)=>s+(p.sizeSui||0),0);
        const vol24h = closedPos.filter(p => now2 - getTs(p) < 24*3600*1000).reduce((s,p)=>s+(p.sizeSui||0),0);
        const t2h = configuredDailyTarget / 12, t4h = configuredDailyTarget / 6;
        const t8h = configuredDailyTarget / 3, t12h = configuredDailyTarget / 2;
        // Heavy pressure based on which milestones are missed — targets must be met.
        // Behind at any level = strong threshold reduction to force entries.
        if (vol24h < configuredDailyTarget * 0.25) volumePressure = Math.max(volumePressure, 28); // severely behind on full day
        else if (vol24h < configuredDailyTarget * 0.5) volumePressure = Math.max(volumePressure, 20);
        if (vol12h < t12h * 0.25) volumePressure = Math.max(volumePressure, 22);
        else if (vol12h < t12h * 0.5) volumePressure = Math.max(volumePressure, 16);
        if (vol8h < t8h * 0.25) volumePressure = Math.max(volumePressure, 16);
        else if (vol8h < t8h * 0.5) volumePressure = Math.max(volumePressure, 11);
        if (vol4h < t4h * 0.25) volumePressure = Math.max(volumePressure, 10);
        else if (vol4h < t4h * 0.5) volumePressure = Math.max(volumePressure, 7);
        if (vol2h < t2h * 0.5) volumePressure = Math.max(volumePressure, 5);
        if (volumePressure > 0) feedbackReason += ` [vol-pressure: -${volumePressure}]`;
      }
    } catch {}

    // Dynamic threshold — consolidates all regime/idle/risk adjustments in one place.
    const dtResult = computeDynamicThreshold({
      baseThreshold: profile.threshold,
      regime: tritonSignal.regime,
      chopScalp: tritonSignal.chopScalp ?? false,
      microScalp: tritonSignal.microScalp ?? false,
      idleMinutes: getAgentIdleMinutes(agent.id),
      consecutiveLosses,
      score: effectiveScore,
      nudgeActive: nudgeActiveNow,
      agentBalance: agent.balance,
      volumePressure,
    });
    const effectiveThreshold = dtResult.effectiveThreshold;
    if (dtResult.adjustments.length > 0) {
      feedbackReason += ` [${dtResult.adjustments.join("; ")}]`;
    }

    // Score threshold check — signal must meet the mode's fire threshold.
    if (effectiveScore < effectiveThreshold) {
      recordSkipReason(agent.id, `Score ${effectiveScore} < ${effectiveThreshold} (${mode}) — ${tritonSignal.side} ${tritonSignal.regime}`);
      console.log(`[Triton] ${agent.name}: SKIP — score ${effectiveScore} < ${effectiveThreshold} (${mode}) | ${tritonSignal.side} regime=${tritonSignal.regime} rr=${tritonSignal.rr.toFixed(2)}${feedbackReason}`);
      return null;
    }

    // Minimum RR check — only reject signals with truly terrible risk/reward.
    const minRR = 0.80; // Very permissive — agents should take most signals and compound
    if (tritonSignal.rr < minRR) {
      recordSkipReason(agent.id, `RR ${tritonSignal.rr.toFixed(2)} < ${minRR} — ${tritonSignal.side} ${tritonSignal.regime}`);
      console.log(`[Triton] ${agent.name}: SKIP — rr ${tritonSignal.rr.toFixed(2)} < ${minRR} | ${tritonSignal.side} score=${effectiveScore}`);
      return null;
    }

    // Counter-trend hard block — no long vs HTF BEAR, no short vs HTF BULL.
    // CHOP_SCALP bypasses this — range fading deliberately trades against the HTF bias.
    const isChopScalpEntry = tritonSignal?.chopScalp === true;
    if (!isChopScalpEntry &&
        ((tritonSignal.side === "LONG" && tritonSignal.htfBias === "BEAR") ||
         (tritonSignal.side === "SHORT" && tritonSignal.htfBias === "BULL"))) {
      const reason = `HTF_CONFLICT: ${tritonSignal.side} vs HTF=${tritonSignal.htfBias} — counter-trend blocked`;
      recordSkipReason(agent.id, reason);
      console.log(`[Triton] ${agent.name}: SKIP — ${reason} (score ${effectiveScore})${feedbackReason}`);
      return null;
    }

    // Consecutive-loss gate — non-NOW modes require a high-confidence signal after 5+ losses.
    // Raised from 3 → 5: agents need to be able to trade through losing streaks with good signals.
    // Micro-scalp anti-idle signals bypass this gate when anti-idle is enabled — they are designed
    // to keep agents compounding with tight SL/TP even through loss streaks.
    const agentAntiIdleEnabled2 = (agent as any).antiIdleEnabled !== false;
    const isMicroScalpEntry = tritonSignal.microScalp === true;
    const consLossMinScore = (isMicroScalpEntry && agentAntiIdleEnabled2) ? 28 : highConfidenceScore;
    if (!isNowMode && consecutiveLosses >= 20 && tritonSignal.score < consLossMinScore) {
      recordSkipReason(agent.id, `${consecutiveLosses} losses: needs score ${consLossMinScore}${isMicroScalpEntry ? " (micro-scalp)" : ""}, got ${tritonSignal.score}`);
      console.log(`[Triton] ${agent.name}: SKIP — after ${consecutiveLosses} losses, requiring score ≥ ${consLossMinScore} (got ${tritonSignal.score}) | ${tritonSignal.side} regime=${tritonSignal.regime}`);
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
          if (tritonSignal.score < highConfidenceScore) {
            console.log(`[Survival] ${agent.name}: SKIP — survival mode (${freeSui.toFixed(3)} SUI < ${SURVIVAL_THRESHOLD_SUI}), requiring score ≥ ${highConfidenceScore} (got ${tritonSignal.score}) | ${tritonSignal.side}`);
            return null;
          }
          tritonSignal.sizeMultiplier = Math.max(0.25, tritonSignal.sizeMultiplier * 0.5);
          (tritonSignal as any).__survivalMode = true;
          feedbackReason += ` [SURVIVAL: size halved to ${tritonSignal.sizeMultiplier.toFixed(2)}]`;
        }
      } catch {}
    }

    // Portfolio-level correlated direction block.
    // If ≥ 2 other agents already have open positions on the SAME side, block this
    // entry — the portfolio is already fully exposed to that direction. Any adverse
    // move will hit every agent simultaneously (as proven by the March 16 cascade).
    try {
      const allOpenPositions = await storage.getAllOpenPositions();
      const sameDirectionAgents = new Set<string>();
      for (const p of allOpenPositions) {
        if (p.agentId !== agent.id && p.side === tritonSignal.side) {
          sameDirectionAgents.add(p.agentId);
        }
      }
      if (sameDirectionAgents.size >= 2) {
        const reason = `PORTFOLIO_CORR: ${sameDirectionAgents.size} other agents already ${tritonSignal.side} — correlated direction blocked`;
        recordSkipReason(agent.id, reason);
        console.log(`[Triton] ${agent.name}: SKIP — ${reason}`);
        return null;
      }
    } catch {}

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

  // T3-D: Drawdown circuit breaker — if total economic value (funding + savings + open
  // collateral) has fallen below 45% of net deposited, pause to preserve capital.
  // IMPORTANT: must use TOTAL economic value, not just funding wallet, because agents
  // accumulate profits in a separate savings wallet — checking funding alone would
  // falsely trigger this gate whenever profits have been moved to savings.
  if (agent.totalDeposited && agent.totalDeposited > 2) {
    const snap = getCachedSnapshot(agent.id);
    let totalEconomicValue: number;
    let netDeposited: number;
    if (snap) {
      // Use full economic picture: funding + savings + locked collateral + unrealized PnL
      totalEconomicValue = snap.settledFundingWallet + snap.settledSavingsWallet +
        snap.openCollateral + Math.max(0, snap.unrealizedPnl);
      netDeposited = snap.netDeposited > 0 ? snap.netDeposited : agent.totalDeposited;
    } else {
      // Fallback: just funding wallet (imperfect but safe when snapshot not ready yet)
      totalEconomicValue = agent.balance;
      netDeposited = agent.totalDeposited;
    }
    const balancePct = (totalEconomicValue / netDeposited) * 100;
    // T3-D: Drawdown circuit breaker — only pause when truly critical (>65% loss).
    // Set at 35% threshold: agent needs to have lost 65% of deposited capital before pausing.
    if (balancePct < 35) {
      const msg = `DRAWDOWN_CIRCUIT_BREAKER: Total value ${totalEconomicValue.toFixed(3)} SUI = ${balancePct.toFixed(1)}% of net deposited ${netDeposited.toFixed(3)} SUI (<35%) — pausing to preserve capital`;
      console.log(`[SafetyGate] ${agent.name}: ${msg}`);
      await storage.updateAgent(agent.id, { status: "paused", lastExecutionError: msg, lastExecutionAt: new Date() });
      return null;
    }
  }

  // T3-E: Portfolio-level EV circuit breaker.
  // If the TOTAL portfolio across all agents has lost more than 35% of its net deposited value,
  // block all new entries for this agent. This prevents "diversification illusion" where
  // individual agents continue trading while the portfolio as a whole is severely impaired.
  // Threshold: 65% = max 35% total portfolio drawdown permitted.
  try {
    const allSnaps = getAllCachedSnapshots();
    if (allSnaps.size >= 2) {
      let portfolioTotalEV = 0;
      let portfolioTotalDeposited = 0;
      for (const [, snap] of allSnaps) {
        const ev = snap.settledFundingWallet + snap.settledSavingsWallet +
          snap.openCollateral + Math.max(0, snap.unrealizedPnl);
        portfolioTotalEV += ev;
        portfolioTotalDeposited += snap.netDeposited > 0 ? snap.netDeposited : 0;
      }
      if (portfolioTotalDeposited > 5) {
        const portfolioPct = (portfolioTotalEV / portfolioTotalDeposited) * 100;
        if (portfolioPct < 30) {
          const msg = `PORTFOLIO_CIRCUIT_BREAKER: Total portfolio EV ${portfolioTotalEV.toFixed(2)} SUI = ${portfolioPct.toFixed(1)}% of deposits (${portfolioTotalDeposited.toFixed(2)} SUI) — portfolio below 30%, blocking new entries`;
          console.log(`[SafetyGate] ${agent.name}: ${msg}`);
          return null;
        }
      }
    }
  } catch {}

  // T2-C/D/F: Pre-open market quality gates.
  // These block entries when market conditions make leveraged positions unsafe
  // regardless of signal score.
  try {
    const mktCandles = getMultiTFCandles();
    const tf5mCandles = mktCandles?.tf5m;
    const tf1hCandles = mktCandles?.tf1h;
    if (tf5mCandles && tf5mCandles.length >= 30) {
      const h5 = tf5mCandles.map((c: any) => c.h);
      const l5 = tf5mCandles.map((c: any) => c.l);
      const c5 = tf5mCandles.map((c: any) => c.c);
      const liveAdx = adxLast(h5, l5, c5, 14);
      const atrVal = atrLast(h5, l5, c5, 14);
      const atrPct = currentPrice > 0 ? (atrVal / currentPrice) * 100 : 0;

      // T2-C: ADX gate — score-aware range market filter.
      // CHOP_SCALP regime uses relaxed thresholds — low ADX IS the expected condition.
      // ADX < 8 (CHOP) / < 4 (CHOP_SCALP): pure noise, hard block.
      // ADX 8-15: allow if signal score is high enough.
      const entrySignalScore = tritonSignal?.score ?? 0;
      const isChopScalpSignal = tritonSignal?.chopScalp === true;
      const adxHardBlock = isChopScalpSignal ? 4 : 8;
      const adxSoftBlock = isChopScalpSignal ? 8 : 15;
      const adxSoftScoreMin = isChopScalpSignal ? 50 : 65;
      if (liveAdx < adxHardBlock) {
        const adxReason = `EntryGate: ADX ${liveAdx.toFixed(1)} < ${adxHardBlock} — market is pure noise, no directional edge`;
        recordSkipReason(agent.id, adxReason);
        console.log(`[EntryGate] ${agent.name}: SKIP — ADX ${liveAdx.toFixed(1)} < ${adxHardBlock} (random noise, entry impossible) | ${direction}`);
        return null;
      }
      if (liveAdx < adxSoftBlock && entrySignalScore < adxSoftScoreMin) {
        const adxReason = `EntryGate: ADX ${liveAdx.toFixed(1)} (range market) — score ${entrySignalScore} < ${adxSoftScoreMin} needed for low-ADX entry`;
        recordSkipReason(agent.id, adxReason);
        console.log(`[EntryGate] ${agent.name}: SKIP — ADX ${liveAdx.toFixed(1)} in range market, score ${entrySignalScore} < ${adxSoftScoreMin} | ${direction}`);
        return null;
      }

      // T2-D: ATR gate — if the market is so quiet that a single ATR move approaches
      // the stop loss, the position is likely to be noise-stopped.
      // CHOP_SCALP / micro-scalp: bypass entirely — these modes are designed for low ATR.
      //
      // For all other signals we compare the ATR against the MINIMUM of:
      //   a) the signal's actual computed SL (entry/stop price levels), and
      //   b) the agent's configured stopLossBps
      // Taking the minimum avoids the circular dependency where TREND signals set their SL
      // to 1.5× ATR (so signalSL > ATR always) while also using the tighter signal SL
      // for RANGE signals that scale SL to 1.2× ATR (barely above ATR).
      const isMicroScalpSignalAtr = tritonSignal?.microScalp === true;
      if (!isChopScalpSignal && !isMicroScalpSignalAtr) {
        const configuredSLBps = agent.stopLossBps || 30;
        let signalSLBps = configuredSLBps;
        if (tritonSignal && tritonSignal.entry > 0 && tritonSignal.stop > 0) {
          signalSLBps = Math.round((Math.abs(tritonSignal.entry - tritonSignal.stop) / tritonSignal.entry) * 10000);
        }
        // Use the tighter of (signal SL, configured SL) — prevents circular dependency
        // with ATR-derived TREND SLs while still using the tighter RANGE signal SL.
        const effSLBps = Math.min(signalSLBps, configuredSLBps);
        const slDistPct = effSLBps / 100;
        if (atrPct > 0 && atrPct < slDistPct * 0.8) {
          const atrReason = `EntryGate: ATR ${atrPct.toFixed(3)}% too low vs SL ${slDistPct.toFixed(3)}% (${effSLBps}bps) — noise stop-out risk`;
          recordSkipReason(agent.id, atrReason);
          console.log(`[EntryGate] ${agent.name}: SKIP — ATR ${atrPct.toFixed(3)}% < SL ${slDistPct.toFixed(3)}% (${effSLBps}bps) | ${direction}`);
          return null;
        }
      }
    }

    // T2-F: 1h EMA direction alignment — prevent buying into a downtrend or
    // selling into an uptrend at the 1-hour level.
    // Bypassed for: CHOP_SCALP (range mean-reversion), micro-scalp (tight params),
    // NOW mode (override all entry quality gates), and idle agents (>30min idle
    // means the idle relaxation system has already lowered the bar significantly).
    const isChopScalpGate = tritonSignal?.chopScalp === true;
    const isMicroScalpGate = tritonSignal?.microScalp === true;
    const agentIdleMinGate = getAgentIdleMinutes(agent.id);
    const nowModeGate = (tritonSignal?.activeMode || agent.signalMode) === "NOW";
    const idleBypassGate = agentIdleMinGate >= 30; // after 30min idle, bypass EMA conflict
    if (!isChopScalpGate && !isMicroScalpGate && !nowModeGate && !idleBypassGate && tf1hCandles && tf1hCandles.length >= 21) {
      const c1h = tf1hCandles.map((c: any) => c.c);
      const ema20_1h = emaSeries(c1h, 20);
      const lastClose1h = c1h[c1h.length - 1];
      const ema20Last = ema20_1h[ema20_1h.length - 1];
      const above1hEma = lastClose1h > ema20Last;
      const below1hEma = lastClose1h < ema20Last;
      const htfConflict1h = (direction === "long" && below1hEma) || (direction === "short" && above1hEma);
      if (htfConflict1h) {
        const htfSignalScore = tritonSignal?.score ?? 0;
        const emaScoreMin = 45; // relaxed from 68 — let signals through with decent conviction
        if (htfSignalScore < emaScoreMin) {
          const emaReason = `EntryGate: 1h EMA conflict — ${direction} signal but price ${below1hEma ? "below" : "above"} 1h EMA20 ($${ema20Last.toFixed(4)}). Counter-trend needs score ≥${emaScoreMin}, got ${htfSignalScore}`;
          recordSkipReason(agent.id, emaReason);
          console.log(`[EntryGate] ${agent.name}: SKIP — 1h EMA conflict (${direction} but price ${lastClose1h.toFixed(4)} ${below1hEma ? "below" : "above"} EMA20 ${ema20Last.toFixed(4)}) — score ${htfSignalScore} < ${emaScoreMin} required for counter-trend`);
          return null;
        }
      }
    }
  } catch {}

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

  // Hard liquidation block — no score override, no mode bypass.
  const liqBlock = isLiquidationBlocked(agent.id);
  if (liqBlock.blocked) {
    recordSkipReason(agent.id, `Liquidation cooldown: ${liqBlock.reason}`);
    console.log(`[Execution] ${agent.name}: Blocked by ${liqBlock.reason}`);
    return null;
  }

  const lossCooldown = isLossCooldownActive(agent.id);
  if (lossCooldown.blocked) {
    const mode = (agent as any).signalMode || "AUTO";
    // NOW mode: bypass the streak cooldown entirely — it's designed for aggressive re-entry.
    // PRECISION mode with a very high score (>=85): bypass the streak cooldown to allow
    // high-conviction entries even during a losing streak. The PRECISION threshold (70+) and
    // the per-signal evaluation already act as quality filters, so a score >=85 is a genuine
    // high-confidence signal that justifies re-entry despite the streak.
    // The base per-loss cooldown (2 min) still applies so we don't open positions back-to-back
    // after a loss, but the 8-min streak gate does not apply in these cases.
    const record = lossCooldownMap.get(agent.id);
    const isStreakBlock = record && record.consecutiveLosses >= STREAK_LOSS_THRESHOLD;
    const tritonScoreForBypass = (tritonSignal as any)?.score ?? 0;
    const isPrecisionHighConfidence = mode === "PRECISION" && tritonScoreForBypass >= 85;
    if (isStreakBlock && (mode === "NOW" || isPrecisionHighConfidence)) {
      const label = mode === "NOW" ? "NOW mode" : `PRECISION mode score=${tritonScoreForBypass}`;
      console.log(`[Execution] ${agent.name}: ${label} — streak cooldown bypassed (${record!.consecutiveLosses} losses). Signal continues.`);
      // fall through — do NOT return null
    } else {
      recordSkipReason(agent.id, `Loss cooldown: ${lossCooldown.reason}`);
      console.log(`[Execution] ${agent.name}: Blocked by ${lossCooldown.reason}`);
      return null;
    }
  }

  if (activeExecutions.has(agent.id)) {
    return null;
  }
  // CRITICAL: Acquire the execution lock IMMEDIATELY after the check, before any async work.
  // Previously, activeExecutions.add() was called 200+ lines later after many awaits,
  // creating a race window where two concurrent signal evaluations could both pass the check
  // and both open positions. This caused 4+ simultaneous positions and a 17-loss cascade.
  // Each early-exit path explicitly releases the lock before returning.
  activeExecutions.add(agent.id);

  const hasPendingUnfilled = Array.from(pendingUnfilledOrders.keys()).some(k => k.startsWith(agent.id + ":"));
  if (hasPendingUnfilled) {
    activeExecutions.delete(agent.id);
    return null;
  }

  const mismatchCooldownUntil = oracleMismatchCooldown.get(agent.id);
  if (mismatchCooldownUntil && Date.now() < mismatchCooldownUntil) {
    activeExecutions.delete(agent.id);
    return null;
  }

  const postCloseCooldownMs = getPostCloseCooldownMs(agent.signalMode || "AUTO");
  const lastClose = lastCloseMap.get(agent.id);
  if (lastClose && Date.now() - lastClose < postCloseCooldownMs) {
    const remaining = Math.ceil((postCloseCooldownMs - (Date.now() - lastClose)) / 1000);
    console.log(`[Execution] ${agent.name}: post-close cooldown active (${remaining}s remaining, mode=${agent.signalMode}) — skipping new trade`);
    activeExecutions.delete(agent.id);
    return null;
  }

  const tradeCooldownMs = getTradeCooldownMs(agent.signalMode || "AUTO");
  const lastTrade = lastTradeMap.get(agent.id);
  if (lastTrade && lastTrade.direction === direction && Date.now() - lastTrade.time < tradeCooldownMs) {
    activeExecutions.delete(agent.id);
    return null;
  }

  const openPositions = await storage.getOpenPositions(agent.id);

  // Block new position opens when any existing position has a close in-progress.
  // This prevents race conditions where the execution engine opens a 2nd position
  // while the position monitor is simultaneously closing the first one.
  // Also catches positions where a close TX was submitted (closeTxDigest set) but
  // the DB closeState wasn't updated to a formal "closing" state — e.g. emergency
  // closes triggered by the guardian backup path.
  const CLOSE_IN_PROGRESS_STATES = ["close_requested", "close_tx_submitted", "close_order_working", "closing", "pending_close"];
  const CLOSE_SETTLED_DIGESTS = ["cancelled_unfilled", "position_already_closed", "position_gone_onchain"];
  const closingPos = openPositions.find((p: any) => {
    if (CLOSE_IN_PROGRESS_STATES.includes(p.closeState || "open")) return true;
    const digest = (p as any).closeTxDigest;
    if (digest && !CLOSE_SETTLED_DIGESTS.includes(digest)) return true;
    return false;
  });
  if (closingPos) {
    console.log(`[Execution] ${agent.name}: SKIP — position ${closingPos.id.slice(0, 8)} is being closed (closeState=${(closingPos as any).closeState}, digest=${(closingPos as any).closeTxDigest}). Wait for close to settle before opening new position.`);
    activeExecutions.delete(agent.id); return null;
  }

  let walPosition: any = null;
  let walOrder: any = null;

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

  // T2: Never open new position if any existing position is >50% collateral at risk
  const highRiskPos = openPositions.find(p => {
    const pnlPct = p.side === "long"
      ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100
      : ((p.entryPrice - currentPrice) / p.entryPrice) * 100;
    const collLoss = pnlPct < 0 ? Math.abs(pnlPct) * (agent.leverage || 25) : 0;
    return collLoss > 50;
  });
  if (highRiskPos) {
    console.log(`[Execution] ${agent.name}: SKIP — existing position ${highRiskPos.id} is high risk (${(highRiskPos as any).collateralLossPct?.toFixed(1) || "unknown"}% loss > 50% limit)`);
    activeExecutions.delete(agent.id); return null;
  }

  if (openPositions.length >= dynamicMaxPositions) {
    console.log(`[Execution] Agent ${agent.name} at max positions (${openPositions.length}/${dynamicMaxPositions}${capitalPlan ? ` from capital plan` : ""})`);
    activeExecutions.delete(agent.id); return null;
  }

  if (openPositions.length === 1) {
    const existingPos = openPositions[0];
    const isResolved = existingPos.onChainPositionId && !existingPos.onChainPositionId.includes("-");
    if (!isResolved) {
      console.log(`[Execution] ${agent.name}: 2nd position blocked — 1st position not yet confirmed on-chain (ID: ${existingPos.onChainPositionId})`);
      activeExecutions.delete(agent.id); return null;
    }
    const openedAt = existingPos.openedAt ? new Date(existingPos.openedAt).getTime() : Date.now();
    const ageMs = Date.now() - openedAt;
    const isHedge = existingPos.side !== direction;
    const minAgeMs = isHedge ? 2 * 60 * 1000 : MIN_SECOND_POS_AGE_MS;
    if (ageMs < minAgeMs) {
      const ageS = Math.round(ageMs / 1000);
      console.log(`[Execution] ${agent.name}: 2nd position blocked — 1st position only ${ageS}s old (min ${Math.round(minAgeMs / 60000)}min required${isHedge ? " for hedge" : " for full eval"})`);
      activeExecutions.delete(agent.id); return null;
    }
    if (existingPos.side === direction) {
      const pnl = existingPos.unrealizedPnl ?? 0;
      if (pnl < 0) {
        console.log(`[Execution] ${agent.name}: same-side 2nd position blocked — existing ${direction} position in loss (pnl=${pnl.toFixed(4)} SUI). Hedge by opening opposite side, or wait for loss to recover.`);
        activeExecutions.delete(agent.id); return null;
      }
      console.log(`[Execution] ${agent.name}: opening same-side 2nd position (double-down ${direction}) — 1st pos ${Math.round(ageMs / 60000)}m old, pnl=+${pnl.toFixed(4)} SUI`);
    } else {
      console.log(`[Execution] ${agent.name}: opening opposing 2nd position (hedge ${direction}) — 1st pos ${Math.round(ageMs / 60000)}m old, pnl=${(existingPos.unrealizedPnl ?? 0).toFixed(4)} SUI`);
    }
  }

  // === PRIORITY ENGINE: Cross-agent profit protection ===
  // If any OTHER running agent holds a profitable position in the OPPOSITE direction,
  // opening here would create a cross-agent hedge that neutralizes portfolio gains.
  // Block the open until those profitable positions are closed.
  try {
    const allAgents = await storage.getAgents();
    for (const otherAgent of allAgents) {
      if (otherAgent.id === agent.id) continue;
      if (!otherAgent.isRunning) continue;
      const otherPositions = await storage.getOpenPositions(otherAgent.id);
      const opposingDir = direction === "long" ? "short" : "long";
      const profitableOpposing = otherPositions.filter(p => {
        if (p.side !== opposingDir) return false;
        const pnlPct = (p.unrealizedPnl !== null && p.unrealizedPnl !== undefined && p.collateral && p.collateral > 0)
          ? (p.unrealizedPnl / p.collateral) * 100
          : 0;
        return pnlPct >= PROFIT_LOCK_MIN_PCT;
      });
      if (profitableOpposing.length > 0) {
        const totalProfit = profitableOpposing.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
        const bestPnl = Math.max(...profitableOpposing.map(p => (p.unrealizedPnl ?? 0) / Math.max(p.collateral ?? 1, 0.01) * 100));
        console.log(`[CrossAgentGuard] ${agent.name}: blocking ${direction} open — ${otherAgent.name} has ${profitableOpposing.length} profitable ${opposingDir} position(s) (+${totalProfit.toFixed(4)} SUI total, best ${bestPnl.toFixed(2)}%). Hedging would cancel portfolio gains.`);
        await storage.updateAgent(agent.id, {
          lastExecutionError: `Cross-agent guard: ${otherAgent.name} has profitable ${opposingDir} positions (+${totalProfit.toFixed(3)} SUI) — ${direction} open blocked to protect portfolio gains`,
          lastExecutionAt: new Date(),
        });
        activeExecutions.delete(agent.id); return null;
      }
    }
  } catch (e) {
    console.warn(`[CrossAgentGuard] Error checking cross-agent positions: ${e}`);
  }

  // Stale pending_open auto-abandonment: positions verifying on-chain for >15min
  // block ALL new trades indefinitely. Auto-abandon them so the execution queue unblocks.
  const unresolvedPositions = openPositions.filter(p => !p.onChainPositionId || p.onChainPositionId.includes("-"));
  if (unresolvedPositions.length > 0) {
    const now = Date.now();
    let stillBlocking: typeof unresolvedPositions = [];
    for (const pos of unresolvedPositions) {
      const ageMs = pos.openedAt ? now - new Date(pos.openedAt).getTime() : 0;
      if (ageMs >= STALE_PENDING_OPEN_MS) {
        // Position has been unresolved for ≥15min — auto-abandon to unblock execution
        console.log(`[PriorityEngine] ${agent.name}: stale pending_open pos ${pos.id} (${Math.round(ageMs / 60000)}m) auto-abandoned — unblocking execution queue`);
        await storage.updatePosition(pos.id, {
          status: "closed",
          closeReason: "abandoned_pending_open",
          closeTxDigest: "cancelled_unfilled",
          closedAt: new Date(),
          unrealizedPnl: 0,
        }).catch(() => {});
      } else {
        stillBlocking.push(pos);
      }
    }
    if (stillBlocking.length > 0) {
      const msg = `SAFETY: ${stillBlocking.length} position(s) verifying on-chain (${Math.round((now - new Date(stillBlocking[0].openedAt ?? now).getTime()) / 1000)}s) — blocking new opens until confirmed.`;
      console.log(`[Execution] ${agent.name}: ${msg}`);
      await storage.updateAgent(agent.id, { lastExecutionError: msg, lastExecutionAt: new Date() });
      activeExecutions.delete(agent.id); return null;
    }
  }

  if (openPositions.length > 0) {
    const lockedColl = openPositions.reduce((sum, p) => sum + (p.collateral || p.sizeSui / agent.leverage), 0);
    const preCheckMinColl = agent.minCollateral ?? 0.5;
    const estFree = agent.balance - lockedColl;
    if (estFree < preCheckMinColl + COLLATERAL_GAS_RESERVE_SUI) {
      activeExecutions.delete(agent.id); return null;
    }

    // === PRIORITY ENGINE: Close-first gate (P4 enforcement) ===
    // New opens are the LOWEST priority (P4). Before committing to an open,
    // scan existing positions for any that qualify for TP or SL close.
    // If any close is pending, defer this open — the position monitor will
    // handle closes on its own 5s cycle.
    if (CLOSE_FIRST_CHECK_ENABLED) {
      try {
        if (currentPrice > 0) {
          const leverage = agent.leverage || 25;
          const slThreshold = (agent.stopLossBps ?? 50) / 100;
          const maxCollLoss = MAX_COLLATERAL_LOSS_PCT;
          const tpBps = (agent as any).takeProfitBps ?? null;
          const tpThreshold = tpBps ? tpBps / 100 : null;

          for (const pos of openPositions) {
            if (!pos.entryPrice || pos.entryPrice === 0) continue;
            const pnlPct = pos.side === "long"
              ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
              : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
            const collLossPct = pnlPct < 0 ? Math.abs(pnlPct) * leverage : 0;
            const qualifiesForClose = (tpThreshold !== null && pnlPct >= tpThreshold)
              || pnlPct <= -slThreshold
              || collLossPct >= maxCollLoss;
            if (qualifiesForClose) {
              const closeReason = pnlPct >= (tpThreshold ?? Infinity) ? `TP +${pnlPct.toFixed(3)}%` :
                collLossPct >= maxCollLoss ? `max-loss ${collLossPct.toFixed(1)}%` :
                `SL ${pnlPct.toFixed(3)}%`;
              console.log(`[PriorityEngine] ${agent.name}: new open DEFERRED — pos ${pos.id} qualifies for close (${closeReason}). Closes are P0-P3; opens are P4.`);
              activeExecutions.delete(agent.id); return null;
            }
          }
        }
      } catch {}
    }
  }

  // === PRE-OPEN REWARD FLUSH ===
  // Before opening any new position, flush any pending_escrow rewards to the reward wallet.
  // This ensures rewards are always transferred to the user before capital is re-deployed.
  if (agent.agentWallet && agent.walletAddress) {
    try {
      const pendingRewards = await storage.getAgentPendingEscrowRewards(agent.id);
      if (pendingRewards.length > 0) {
        console.log(`[RewardFlush] ${agent.name}: flushing ${pendingRewards.length} pending reward(s) before opening new position`);
        const { escrowRewardFromAgent, getOrCreateUserRewardWallet } = await import("../reward-wallet");
        let flushUserRwAddr: string | undefined;
        try {
          const flushOwnerUser = await storage.getUser(agent.userId);
          if (flushOwnerUser?.walletAddress) {
            const flushUw = await getOrCreateUserRewardWallet(flushOwnerUser.walletAddress);
            flushUserRwAddr = flushUw.address;
          }
        } catch {}
        for (const pendingReward of pendingRewards) {
          try {
            const escrowResult = await escrowRewardFromAgent(agent.agentWallet, agent.walletAddress, pendingReward.amount, flushUserRwAddr);
            await storage.updateReward(pendingReward.id, { escrowTxDigest: escrowResult.txDigest });
            console.log(`[RewardFlush] ${agent.name}: flushed ${pendingReward.amount.toFixed(4)} SUI reward (pos ${pendingReward.positionId?.slice(0, 8)}) → ${flushUserRwAddr ? "personal" : "global"} reward wallet (tx: ${escrowResult.txDigest})`);
          } catch (flushErr: any) {
            console.log(`[RewardFlush] ${agent.name}: flush failed for reward ${pendingReward.id}: ${flushErr.message} — proceeding with open anyway`);
          }
        }
      }
    } catch (flushQueryErr: any) {
      console.log(`[RewardFlush] ${agent.name}: could not query pending rewards: ${flushQueryErr.message}`);
    }
  }

  const adapter = getAdapter(agent.venue);
  if (!adapter || !adapter.supported || !adapter.isReady()) {
    activeExecutions.delete(agent.id); return null;
  }

  if (!agent.agentWallet) {
    activeExecutions.delete(agent.id); return null;
  }

  try {
    const keypair = decryptKeypair(agent.agentWallet);
    const walletAddr = keypair.toSuiAddress();
    const gasCheck = await ensureMinGasReserve(suiClient, walletAddr);
    if (!gasCheck.ok) {
      const msg = `Gas check failed: ${gasCheck.reason}`;
      console.log(`[Execution] Skipping ${agent.name}: ${msg}`);
      await storage.updateAgent(agent.id, { lastExecutionError: msg, lastExecutionAt: new Date() });
      activeExecutions.delete(agent.id);
      return { success: false, error: msg, venue: agent.venue };
    }
  } catch (gasErr: any) {
    console.log(`[Execution] Gas check failed for ${agent.name}: ${gasErr.message}`);
  }

  // Lock was already acquired early (before pre-checks). No duplicate add needed.

  try {
    const keypairForBalance = decryptKeypair(agent.agentWallet);
    const walletAddrForBalance = keypairForBalance.toSuiAddress();
    let onChainBalance: number;
    let balanceFetchedFromChain = false;
    const cachedBal = getCachedWalletBalance(walletAddrForBalance);
    if (cachedBal !== null) {
      onChainBalance = cachedBal;
      balanceFetchedFromChain = true;
    } else {
      try {
        const balResp = await suiClient.getBalance({ owner: walletAddrForBalance, coinType: "0x2::sui::SUI" });
        onChainBalance = Number(balResp.totalBalance) / 1e9;
        balanceFetchedFromChain = true;
        setCachedWalletBalance(walletAddrForBalance, onChainBalance);
      } catch (balErr: any) {
        const cachedFallback = getCachedWalletBalance(walletAddrForBalance);
        if (cachedFallback !== null) {
          onChainBalance = cachedFallback;
          balanceFetchedFromChain = true;
          console.log(`[Execution] RPC balance fetch failed for ${agent.name} (${balErr.message}) — using recent cache (${onChainBalance.toFixed(4)} SUI).`);
        } else if (agent.balance > 0) {
          onChainBalance = agent.balance;
          console.log(`[Execution] RPC balance fetch failed for ${agent.name}: ${balErr.message}. Using DB balance fallback (${onChainBalance.toFixed(4)} SUI).`);
        } else {
          console.log(`[Execution] RPC balance fetch failed for ${agent.name}: ${balErr.message}. No DB balance to fall back on — skipping.`);
          await storage.updateAgent(agent.id, { lastExecutionError: "RPC balance unavailable — retrying next cycle", lastExecutionAt: new Date() });
          return null;
        }
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
          const allPositionsForClosedCheck = await storage.getPositions(agent.id);
          for (const ocp of onChainPositions) {
            if (!dbPositionIds.has(ocp.positionId)) {
              const contentKey = `${ocp.side}:${(ocp.entryPrice || 0).toFixed(4)}:${(ocp.size || 0).toFixed(0)}`;
              const isContentMatch = contentMatchSet.has(contentKey);

              const closedMatch = allPositionsForClosedCheck.find(p =>
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
                if (hasProperCloseLifecycle && closedAgo > 5 * 60 * 1000) {
                  continue;
                }
              }

              const contentClosedMatch = !closedMatch && allPositionsForClosedCheck.find(p =>
                p.status === "closed" && p.side === ocp.side &&
                Math.abs((p.entryPrice || 0) - (ocp.entryPrice || 0)) < 0.001 &&
                Math.abs(p.sizeSui - (ocp.size || 0)) < 1
              );
              if (contentClosedMatch) {
                const ccAgo = contentClosedMatch.closedAt ? Date.now() - new Date(contentClosedMatch.closedAt).getTime() : Infinity;
                const ccm = contentClosedMatch as any;
                if ((ccm.closeState === "closed" && ccm.closeReason && contentClosedMatch.closedAt && ccAgo > 5 * 60 * 1000) ||
                    (contentClosedMatch.closeTxDigest && !contentClosedMatch.closeTxDigest.startsWith("recovered_") && !contentClosedMatch.closeTxDigest.startsWith("sim_") && !contentClosedMatch.closeTxDigest.startsWith("db_") && contentClosedMatch.closeTxDigest !== "settled_onchain" && contentClosedMatch.closeTxDigest !== "position_gone_onchain")) {
                  continue;
                }
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

              const untrackedColl = ocp.collateral || (ocp.size / agent.leverage);
              lockedCollateral += untrackedColl;
              onChainOpenCount++;

              if (ocp.entryPrice && ocp.entryPrice > 0 && ocp.size && ocp.size > 0) {
                try {
                  if (closedMatch) {
                    const closedAgoR = closedMatch.closedAt ? Date.now() - new Date(closedMatch.closedAt).getTime() : Infinity;
                    const isSyntheticCloseR = !closedMatch.closeTxDigest || closedMatch.closeTxDigest === "settled_onchain" || closedMatch.closeTxDigest === "position_gone_onchain" || closedMatch.closeTxDigest === "closed_externally" || closedMatch.closeTxDigest === "cancelled_unfilled" || closedMatch.closeTxDigest === "liquidated_onchain" || closedMatch.closeTxDigest.startsWith("recovered_") || closedMatch.closeTxDigest.startsWith("sim_") || closedMatch.closeTxDigest.startsWith("db_");

                    const reopenKey = `reopen_${closedMatch.id}`;
                    const reopenCount = (positionReopenCounts.get(reopenKey) || 0);
                    const MAX_REOPEN_ATTEMPTS = 2;
                    const isCancelledUnfilled = closedMatch.closeTxDigest === "cancelled_unfilled";
                    const REOPEN_COOLDOWN_MS = isCancelledUnfilled ? 3 * 60 * 1000 : 10 * 60 * 1000;

                    if (reopenCount >= MAX_REOPEN_ATTEMPTS) {
                      console.log(`[Execution] REOPEN BLOCKED for ${agent.name}: posId=${ocp.positionId} already re-opened ${reopenCount} times — likely infinite loop. Skipping.`);
                      continue;
                    }

                    if (isSyntheticCloseR && closedAgoR < REOPEN_COOLDOWN_MS) {
                      console.log(`[Execution] REOPEN SKIPPED for ${agent.name}: posId=${ocp.positionId} was closed as "${closedMatch.closeTxDigest}" only ${(closedAgoR / 1000).toFixed(0)}s ago. Waiting for settlement (cooldown=${REOPEN_COOLDOWN_MS / 60000}min).`);
                      continue;
                    }

                    if (isSyntheticCloseR && closedMatch.onChainPositionId) {
                      try {
                        if (adapter instanceof TypusAdapter) {
                          const priorFill = await adapter.checkPriorCloseFilled(agent.walletAddress, closedMatch.onChainPositionId);
                          if (priorFill.filled) {
                            console.log(`[Execution] REOPEN BLOCKED for ${agent.name}: posId=${ocp.positionId} was KEEPER-FILLED (tx: ${priorFill.txDigest}). Updating digest instead.`);
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

                  const alreadyTracked = allPositionsForClosedCheck.some(p =>
                    // Check by on-chain position ID (most reliable)
                    (p.onChainPositionId === ocp.positionId &&
                      (p.status === "open" || p.status === "pending_open" || p.status === "closing" || p.status === "pending_close")) ||
                    // Also check by recovery txDigest markers
                    (p.txDigest === `reopened_${ocp.positionId}` && p.status === "open") ||
                    (p.txDigest === `recovered_${ocp.positionId}` && p.status === "open") ||
                    // Content-match: covers case where onChainPositionId wasn't set yet
                    (ocp.entryPrice > 0 && p.entryPrice > 0 && p.side === ocp.side &&
                      (p.status === "open" || p.status === "pending_open") &&
                      Math.abs(p.entryPrice - ocp.entryPrice) < 0.001 &&
                      Math.abs(p.sizeSui - (ocp.size || 0)) < 1)
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
    const activeMode = tritonSignal?.activeMode ?? "PRECISION";
    const lossReductionFactor = activeMode === "AGGRESSIVE"
      ? (consecutiveLossCount >= 5 ? 0.65 : consecutiveLossCount >= 4 ? 0.75 : consecutiveLossCount >= 2 ? 0.88 : 1.0)
      : (consecutiveLossCount >= 3 ? 0.55 : consecutiveLossCount >= 2 ? 0.70 : consecutiveLossCount >= 1 ? 0.85 : 1.0);
    const capitalPlanSizeMultiplier = capitalPlan ? capitalPlan.sizeMultiplier : 1.0;
    let collateral = baseColl * tritonSizeMultiplier * lossReductionFactor * capitalPlanSizeMultiplier;
    if (collateral < minColl && availableForTrading >= minColl) {
      collateral = minColl;
    }

    // T3-A: Hard leverage cap — no position may open above 32x regardless of agent config.
    const effectiveLeverage = Math.min(agent.leverage, MAX_LEVERAGE_HARD_CAP);
    if (agent.leverage > MAX_LEVERAGE_HARD_CAP) {
      console.log(`[SafetyGate] ${agent.name}: Leverage capped from ${agent.leverage}x → ${effectiveLeverage}x (${MAX_LEVERAGE_HARD_CAP}x max)`);
    }

    // T3-C: Per-position collateral cap — no single position may use more than
    // 12% of the on-chain wallet balance as collateral. This prevents a single
    // bad trade from taking more than ~12% of capital.
    const maxCollateralPerPosition = Math.max(minColl, onChainBalance * 0.12);
    if (collateral > maxCollateralPerPosition) {
      console.log(`[SafetyGate] ${agent.name}: Collateral capped at 12% of wallet (${collateral.toFixed(4)} → ${maxCollateralPerPosition.toFixed(4)} SUI, wallet=${onChainBalance.toFixed(4)})`);
      collateral = maxCollateralPerPosition;
    }

    const quantity = Math.floor(collateral * effectiveLeverage);

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

    const slCollateralLossPct = (effectiveSlBps / 10000) * 100 * effectiveLeverage;
    if (slCollateralLossPct > MAX_COLLATERAL_LOSS_PCT) {
      const cappedSlBps = Math.floor((MAX_COLLATERAL_LOSS_PCT / (100 * effectiveLeverage)) * 10000);
      console.log(`[Execution] SL auto-tightened for ${agent.name}: ${effectiveSlBps}bps would lose ${slCollateralLossPct.toFixed(1)}% collateral at ${effectiveLeverage}x → capped to ${cappedSlBps}bps (${MAX_COLLATERAL_LOSS_PCT}% max collateral loss)`);
      effectiveSlBps = cappedSlBps;
    }

    const liquidationMoveBps = Math.floor((1 / effectiveLeverage) * 10000);
    const maxSafeSLBps = Math.floor(liquidationMoveBps * 0.60);
    if (effectiveSlBps > maxSafeSLBps) {
      console.log(`[Execution] Leverage-aware SL cap for ${agent.name}: ${effectiveSlBps}bps exceeds 60% of liquidation distance (${liquidationMoveBps}bps at ${effectiveLeverage}x) → capped to ${maxSafeSLBps}bps`);
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
      leverage: effectiveLeverage,
      quantity,
      price: currentPrice,
      stopLossPrice,
      takeProfitPrice,
      slippage: 0.01,
      openPositionCount: openPositions.length,
      prefetchedBalance: onChainBalance,
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

    const expectedCollateral = quantity / effectiveLeverage;
    console.log(`[Execution] Submitting ${direction} order for agent ${agent.name} on ${agent.venue}: qty=${quantity.toFixed(4)} SUI @ $${currentPrice.toFixed(4)} | leverage=${effectiveLeverage}x | collateral=${expectedCollateral.toFixed(4)} SUI (maxCollateral=${agent.maxQty}) | SL=$${stopLossPrice.toFixed(4)} (${effectiveSlBps}bps) | sizeMult=${tritonSizeMultiplier.toFixed(2)} capPlan=${capitalPlanSizeMultiplier.toFixed(2)} lossScale=${lossReductionFactor.toFixed(2)}(${consecutiveLossCount}L) maxPos=${dynamicMaxPositions} | signal=${signal}`);

    const typusLiquidationPrice = direction === "long"
      ? currentPrice * (1 - 1 / effectiveLeverage)
      : currentPrice * (1 + 1 / effectiveLeverage);

    // T4-C: RPC health gate — skip new position opens if the RPC is in a
    // throttle cooldown (meaning recent requests failed/timed-out).
    const rpcStats = getRpcStats();
    if (rpcStats.cooldownRemaining > 0) {
      const msg = `RPC cooldown active (${(rpcStats.cooldownRemaining / 1000).toFixed(1)}s remaining) — skipping open to avoid bad-state WAL entries`;
      console.log(`[SafetyGate] ${agent.name}: ${msg}`);
      return null; // silent skip — will retry next cycle
    }

    walOrder = await storage.createOrder({
      agentId: agent.id,
      signalId: signalId || null,
      symbol: "SUI-USDC",
      side: direction,
      type: "market",
      leverage: effectiveLeverage,
      qty: quantity,
      price: currentPrice,
      entryPrice: currentPrice,
      stopLossPrice,
      takeProfitPrice,
      venue: agent.venue,
      txDigest: "pending_submission",
    });

    walPosition = await storage.createPosition({
      agentId: agent.id,
      symbol: "SUI-USDC",
      side: direction,
      sizeSui: quantity,
      collateral: quantity / effectiveLeverage,
      entryPrice: currentPrice,
      markPrice: currentPrice,
      unrealizedPnl: 0,
      liquidationPrice: typusLiquidationPrice,
      txDigest: "pending_submission",
      status: "pending_open",
      // T4-D: Store computed SL/TP prices in DB for use by rapid monitor,
      // so protection persists even across parameter changes mid-position.
      slPrice: stopLossPrice,
      tpPrice: takeProfitPrice ?? null,
    } as any);
    console.log(`[WAL] Pre-created position ${walPosition.id} for ${agent.name} BEFORE on-chain submission (side=${direction}, collateral=${(quantity / effectiveLeverage).toFixed(4)}, SL=$${stopLossPrice.toFixed(4)})`);
    // Record collateral lock event in fund flow ledger
    recordFundFlow({
      agentId: agent.id,
      eventType: "COLLATERAL_LOCKED",
      amount: quantity / effectiveLeverage,
      direction: "debit",
      positionId: walPosition.id,
      sourceSystem: "execution-engine",
      notes: `${direction} ${(quantity / effectiveLeverage).toFixed(4)} SUI @ ${currentPrice.toFixed(4)}`,
    }).catch(() => {});
    // Signal portfolio state engine: order submitted → yellow (pending_open)
    import("../portfolio-state").then(m => m.portfolioEngine.openOrderSubmitted(agent.id)).catch(() => {});
    // Comms: position open submitted
    pushCommEvent({
      agentId: agent.id,
      type: "trade_open",
      direction: "out",
      from: agent.walletAddress || "Funding Wallet",
      to: "Typus Perps",
      amount: quantity / effectiveLeverage,
      message: `Opened ${direction.toUpperCase()} ${(quantity / effectiveLeverage).toFixed(4)} SUI collateral @ $${currentPrice.toFixed(4)} (${effectiveLeverage}×) — SL $${stopLossPrice.toFixed(4)}`,
      side: direction,
      entryPrice: currentPrice,
      status: "pending",
    });

    let result: DexOrderResult;
    try {
      result = await adapter.openPosition(orderParams);
    } catch (dexError: any) {
      const err = `DEX error: ${dexError.message}`;
      const dexErrMsg = String(dexError.message || "");
      console.log(`[Execution] DEX call failed for ${agent.name}: ${dexError.message} — no balance spent`);

      await storage.updatePosition(walPosition.id, { status: "closed", closeTxDigest: "cancelled_unfilled", closeState: "closed", closeReason: `DEX error: ${dexError.message}` } as any);
      await storage.updateOrder(walOrder.id, { status: "cancelled" } as any);
      console.log(`[WAL] Cleaned up pre-created position ${walPosition.id} after DEX failure`);

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

      await storage.updatePosition(walPosition.id, { status: "closed", closeTxDigest: "cancelled_unfilled", closeState: "closed", closeReason: `DEX error: ${errorStr}` } as any);
      await storage.updateOrder(walOrder.id, { status: "cancelled" } as any);
      console.log(`[WAL] Cleaned up pre-created position ${walPosition.id} after DEX error result`);

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
      await storage.updatePosition(walPosition.id, { status: "closed", closeTxDigest: "cancelled_unfilled", closeState: "closed", closeReason: "No valid on-chain transaction" } as any);
      await storage.updateOrder(walOrder.id, { status: "cancelled" } as any);
      console.log(`[WAL] Cleaned up WAL position ${walPosition.id} — no valid txDigest`);
      await storage.updateAgent(agent.id, { lastExecutionError: err, lastExecutionAt: new Date() });
      return { success: false, error: err, venue: agent.venue };
    }

    if (result.filled === false && result.orderId) {
      console.log(`[Execution] Order ${result.orderId} for ${agent.name} NOT FILLED after 30s. Attempting cancel to recover collateral...`);
      await storage.updatePosition(walPosition.id, { txDigest: result.txDigest, typusOrderId: result.orderId } as any);
      await storage.updateOrder(walOrder.id, { txDigest: result.txDigest } as any);

      if (adapter instanceof TypusAdapter) {
        const cancelResult = await adapter.cancelUnfilledOrder(agent.agentWallet, result.orderId);
        if (cancelResult.cancelled) {
          console.log(`[Execution] Successfully cancelled unfilled order ${result.orderId} for ${agent.name}. Collateral returned: ${cancelResult.collateralReturned}`);
          await storage.updatePosition(walPosition.id, { status: "closed", closeTxDigest: "cancelled_unfilled", closeState: "closed", closeReason: "Order not filled — cancelled" } as any);
          await storage.updateOrder(walOrder.id, { status: "cancelled" } as any);
          console.log(`[WAL] Cleaned up WAL position ${walPosition.id} — unfilled order cancelled`);
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

    const position = walPosition!;
    const order = walOrder!;

    await storage.updateOrder(order.id, { status: "filled", txDigest: result.txDigest } as any);
    await storage.updatePosition(position.id, { txDigest: result.txDigest });

    // Flush the wallet TX cache so findAllUnfilledOrderIds sees the new order immediately
    if (adapter instanceof TypusAdapter && agent.walletAddress) {
      adapter.invalidateWalletCache(agent.walletAddress);
    }

    console.log(`[WAL] Updated WAL position ${position.id} with txDigest=${result.txDigest} for ${agent.name}`);
    console.log(`[Execution] Position protection for ${agent.name}: effectiveSL=$${stopLossPrice.toFixed(4)} (${effectiveSlBps}bps), typusLiquidation=$${typusLiquidationPrice.toFixed(4)}, maxCollateralLoss=${MAX_COLLATERAL_LOSS_PCT}%, buffer=${Math.abs(((stopLossPrice - typusLiquidationPrice) / currentPrice) * 100).toFixed(2)}% price`);

    trackSessionGasSpend(agent.id, GAS_PER_OPERATION_ESTIMATE);
    persistSessionGasToDb(agent.id);
    invalidateCachedWalletBalance(walletAddrForBalance);
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
      console.log(`[Execution] No on-chain positionId yet for ${agent.name} — attempting immediate inline resolution...`);
      let inlineResolved = false;
      if (result.txDigest) {
        try {
          const inlineResult = await reconcileFromDigest(result.txDigest);
          if (inlineResult.positionId) {
            posUpdateFields.onChainPositionId = inlineResult.positionId;
            posUpdateFields.status = "open";
            posUpdateFields.verified = true;
            inlineResolved = true;
            console.log(`[Execution] INLINE resolution succeeded: positionId=${inlineResult.positionId} from digest ${result.txDigest}`);
          }
          if (inlineResult.orderId && !result.orderId) {
            result.orderId = inlineResult.orderId;
          }
        } catch (inlineErr: any) {
          console.log(`[Execution] Inline resolution failed for ${agent.name}: ${inlineErr.message} — falling back to background`);
        }
      }
      if (!inlineResolved) {
        console.log(`[Execution] WARNING: Position stays PENDING_OPEN for ${agent.name}, scheduling background resolution`);
        if (result.orderId) {
          trackPendingPositionResolution(position.id, agent.id, agent.name, agent.walletAddress!, result.orderId);
        }
        if (result.txDigest) {
          trackPendingDigestReconciliation(position.id, agent.id, agent.name, agent.walletAddress!, result.txDigest);
        }
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
    agentSkipStatusMap.delete(agent.id);
    resetGasSpendTracking(agent.id);
    oracleMismatchCooldown.delete(agent.id);

    console.log(`[Execution][LIVE] Order filled: ${result.txDigest} for agent ${agent.name} (${direction} ${quantity.toFixed(4)} SUI @ $${currentPrice.toFixed(4)})`);

    return result;
  } catch (error: any) {
    console.error(`[Execution] Error for agent ${agent.name}:`, error.message);
    try {
      if (walPosition) {
        const pos = await storage.getPositions(agent.id);
        const walPos = pos.find(p => p.id === walPosition.id && p.status === "pending_open");
        if (walPos && walPos.txDigest === "pending_submission") {
          await storage.updatePosition(walPos.id, { status: "closed", closeTxDigest: "cancelled_unfilled", closeState: "closed", closeReason: `Unexpected error: ${error.message}` } as any);
          console.log(`[WAL] Rolled back WAL position ${walPos.id} after unexpected error`);
        }
      }
      if (walOrder) {
        await storage.updateOrder(walOrder.id, { status: "cancelled" } as any).catch(() => {});
        console.log(`[WAL] Rolled back WAL order ${walOrder.id} after unexpected error`);
      }
    } catch {}
    return { success: false, error: error.message, venue: agent.venue };
  } finally {
    activeExecutions.delete(agent.id);
  }
}

export async function closePositionForAgent(agent: Agent, positionId: string, currentPrice: number, allowDbFallback = false, closeReason?: string): Promise<{ closed: boolean; onChain: boolean; pnl: number; txDigest?: string; error?: string }> {
  // FAST DB PRE-CHECK (no lock, no on-chain call): if there are multiple same-side positions
  // and this one is NOT the oldest, defer immediately. This prevents the 38-second on-chain
  // getPositions() call from holding the lock and causing false close_already_in_progress
  // backoff accumulation for the newer position while the older one is being closed.
  try {
    const allOpen = await storage.getPositions(agent.id);
    const targetPos = allOpen.find(p => p.id === positionId);
    if (targetPos && (targetPos.status === "open" || targetPos.status === "pending_open")) {
      const sameSide = allOpen.filter(p =>
        p.id !== positionId &&
        p.side === targetPos.side &&
        (p.status === "open" || p.status === "pending_open") &&
        p.onChainPositionId && !p.onChainPositionId.includes("-")
      );
      if (sameSide.length > 0) {
        const targetOnChainId = parseInt(targetPos.onChainPositionId ?? "0", 10);
        const allOnChainIds = [targetOnChainId, ...sameSide.map(p => parseInt(p.onChainPositionId ?? "0", 10))];
        const oldestId = Math.min(...allOnChainIds);
        if (targetOnChainId !== oldestId) {
          // Not the oldest — defer without touching the lock or cooldown map.
          // The TP/SL loop MUST NOT record this as a failure; it's an ordered deferral.
          console.log(`[Execution] DB-PRECHECK DEFER pos=${targetPos.onChainPositionId} (${agent.name}): not oldest same-side. Oldest=${oldestId}. Deferring without backoff.`);
          return { closed: false, onChain: false, pnl: 0, error: `CLOSE_OLDEST_FIRST: close pos ${oldestId} before targeting ${targetPos.onChainPositionId}` };
        }
      }
    }
  } catch (_preErr) {
    // Non-fatal — fall through to normal close path
  }

  // Per-position close lock — prevents simultaneous close attempts from position guardian
  // (200ms), rapid monitor (500ms), and SL/TP loop (5s) all firing at the same time.
  // Lock has a 90-second timeout: if a prior close call got stuck (e.g., slow keeper scan),
  // release the stale lock so a fresh attempt can proceed.
  // Check explicit cooldown BEFORE acquiring the lock. This prevents any close attempt
  // while a close_already_in_progress freeze (180s) is active — critical for gas safety.
  const cooldownExpiry = positionCloseCooldown.get(positionId);
  if (cooldownExpiry && Date.now() < cooldownExpiry) {
    const waitSec = Math.ceil((cooldownExpiry - Date.now()) / 1000);
    console.log(`[Execution] Close cooldown active for pos ${positionId.slice(0, 8)} (${agent.name}) — ${waitSec}s remaining. Gas saved.`);
    return { closed: false, onChain: false, pnl: 0, error: `close_cooldown: ${waitSec}s remaining` };
  }
  const CLOSE_LOCK_TIMEOUT_MS = 25_000;
  if (positionCloseInProgress.has(positionId)) {
    const lockAge = Date.now() - (positionCloseInProgress.get(positionId) ?? 0);
    if (lockAge < CLOSE_LOCK_TIMEOUT_MS) {
      console.log(`[Execution] Close already in progress for pos ${positionId.slice(0, 8)} (${agent.name}) — duplicate suppressed (gas saved)`);
      return { closed: false, onChain: false, pnl: 0, error: "close_already_in_progress" };
    }
    console.log(`[Execution] Stale close lock (${Math.floor(lockAge / 1000)}s) for pos ${positionId.slice(0, 8)} (${agent.name}) — releasing and retrying`);
    positionCloseInProgress.delete(positionId);
  }
  positionCloseInProgress.set(positionId, Date.now());
  console.log(`[CLOSE_POSITION_START] agent=${agent.name} pos=${positionId.slice(0, 8)} onChainId=${agent.id} price=${currentPrice} allowDbFallback=${allowDbFallback} reason=${closeReason ?? "auto"}`);

  // Outer try/finally ensures the per-position lock is ALWAYS released,
  // regardless of which early-exit path is taken inside the function.
  try {

  const closeStartTime = Date.now();
  let pos = (await storage.getPositions(agent.id)).find(p => p.id === positionId);
  if (!pos || (pos.status !== "open" && pos.status !== "pending_open")) return { closed: false, onChain: false, pnl: 0 };
  // If the position was already fast-closed (PRE-CLOSE confirmed gone and wrote closeState=closed),
  // don't start another close attempt — it would overwrite the settled state.
  // EXCEPTION: if status is still "open", this is a contradictory state caused by the reconciler
  // restoring "open" status after a failed close TX. Clear the stale closeState and proceed.
  if ((pos as any).closeState === "closed") {
    if (pos.status === "open" || pos.status === "pending_open") {
      console.log(`[Execution] pos ${positionId.slice(0, 8)} has CONTRADICTORY state (status=${pos.status}, closeState=closed) — stale fast-close marker from a failed TX. Clearing and proceeding with close.`);
      await storage.updatePosition(positionId, { closeState: "close_requested" } as any);
      pos = { ...pos, closeState: "close_requested" as any };
    } else {
      console.log(`[Execution] pos ${positionId.slice(0, 8)} already has closeState=closed (fast-close settled) — skipping new close attempt`);
      return { closed: false, onChain: false, pnl: 0 };
    }
  }

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
              const cachedBal3 = getCachedWalletBalance(agent.walletAddress);
              let onChainBal: number;
              if (cachedBal3 !== null) {
                onChainBal = cachedBal3;
              } else {
                const balResp = await suiClient.getBalance({ owner: agent.walletAddress, coinType: "0x2::sui::SUI" });
                onChainBal = Number(balResp.totalBalance) / 1e9;
                setCachedWalletBalance(agent.walletAddress, onChainBal);
              }
              if (onChainBal >= expectedCollateral * 0.8) {
                let keeperFillDigest: string | null = null;
                if (pos.onChainPositionId && adapter instanceof TypusAdapter) {
                  try {
                    const priorFill = await adapter.checkPriorCloseFilled(agent.walletAddress, pos.onChainPositionId);
                    if (priorFill.filled && priorFill.txDigest) {
                      keeperFillDigest = priorFill.txDigest;
                      console.log(`[Execution] Level 3: keeper fill confirmed for pos ${pos.onChainPositionId} (tx: ${keeperFillDigest})`);
                    }
                  } catch {}
                }
                console.log(`[Execution] Level 3: getPositions=0 but on-chain balance ${onChainBal.toFixed(4)} SUI confirms collateral returned. Settling as on-chain success (NOT liquidation).${keeperFillDigest ? " KEEPER-FILLED" : ""}`);
                onChainSuccess = true;
                closeTxDigest = keeperFillDigest || "settled_onchain";
                closeError = `Position not found on Typus and on-chain balance confirms collateral returned. Settled safely.${keeperFillDigest ? " Keeper fill TX: " + keeperFillDigest : ""}`;
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
      const rawOnChain = await (adapter as TypusAdapter).getPositions(agent.walletAddress);
      // Raw result (no cache) is the source of truth for gone-detection.
      // If getPositions truly returns 0, the balance check below handles rate-limit false positives.
      const rawHasPosition = rawOnChain.some((op: any) => String(op.positionId) === String(pos.onChainPositionId));

      // For side-correction only: allow cache fallback when RPC returns empty (rate-limited)
      let openOnChain = rawOnChain;
      if (openOnChain.length === 0 && agent.id) {
        const posCache = getCachedOnChainPositions(agent.id);
        if (posCache && posCache.positions.length > 0) {
          console.log(`[Execution] getPositions returned 0 — using on-chain cache (${posCache.positions.length} cached) for side-correction check on ${agent.name}`);
          openOnChain = posCache.positions.map((cp: any) => ({ positionId: cp.positionId, side: cp.side, size: cp.size, collateral: cp.collateral, entryPrice: cp.entryPrice }));
        }
      }
      const onChainMatchPos = openOnChain.find((op: any) => String(op.positionId) === String(pos.onChainPositionId));
      const existsOnChain = !!onChainMatchPos;

      if (existsOnChain && onChainMatchPos.side && onChainMatchPos.side !== pos.side) {
        console.log(`[Execution] SIDE MISMATCH for ${agent.name} pos ${pos.onChainPositionId}: DB=${pos.side} but on-chain=${onChainMatchPos.side}. Correcting DB before close.`);
        try {
          await storage.updatePosition(pos.id, { side: onChainMatchPos.side as any });
          pos = { ...pos, side: onChainMatchPos.side };
          console.log(`[Execution] SIDE CORRECTED: pos ${pos.onChainPositionId} for ${agent.name} → side=${onChainMatchPos.side}`);
        } catch (sideFixErr: any) {
          console.log(`[Execution] Side correction failed for ${pos.onChainPositionId}: ${sideFixErr.message} — will use on-chain side for close TX`);
          pos = { ...pos, side: onChainMatchPos.side };
        }
      }

      // Use raw (pre-cache) result for gone-detection: stale cache must not mask a gone position
      if (!rawHasPosition) {
        const posCollateral = pos.collateral || pos.sizeSui / (agent.leverage || 25);
        try {
          const cachedBal4 = getCachedWalletBalance(agent.walletAddress);
          const walletBal = cachedBal4 !== null ? cachedBal4 : await (async () => {
            const balCheck = await suiClient.getBalance({ owner: agent.walletAddress, coinType: "0x2::sui::SUI" });
            const b = Number(balCheck.totalBalance) / 1e9;
            setCachedWalletBalance(agent.walletAddress, b);
            return b;
          })();
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
            // Immediately write closed status to DB so any concurrent/future retry attempts
            // see the position as already closed and return instantly (without needing the lock).
            // Full PnL settlement continues below in _closePositionForAgentInner.
            try {
              await storage.updatePosition(pos.id, {
                status: "closed" as any,
                closeState: "closed" as any,
                closedAt: new Date(),
                closeTxDigest: "settled_onchain",
                closeReason: closeReason || "keeper_settled",
              });
              console.log(`[Execution] PRE-CLOSE FAST-CLOSE: pos ${pos.id.slice(0, 8)} marked closed in DB immediately. Full PnL settlement continues.`);
            } catch (fastCloseErr: any) {
              console.log(`[Execution] PRE-CLOSE fast-close DB write failed: ${fastCloseErr.message}`);
            }
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
  const innerResult = await _closePositionForAgentInner(agent, pos, adapter, currentPrice, allowDbFallback, closeReason, onChainSuccess, closeTxDigest, closeError, positionAlreadySettled, preCloseOnChainBalance, isManualClose, closeStartTime, hasOnChainId);
  if (!innerResult.closed) {
    console.log(`[CLOSE_POSITION_FAILED] agent=${agent.name} pos=${positionId.slice(0, 8)} error=${innerResult.error?.slice(0, 80) ?? "unknown"}`);
  }
  return innerResult;
  } catch (innerErr: any) {
    console.log(`[CLOSE_POSITION_FAILED] agent=${agent.name} pos=${positionId.slice(0, 8)} threw=${innerErr?.message?.slice(0, 80)}`);
    throw innerErr;
  } finally {
    if (isManualClose) {
      manualCloseInProgress.delete(pos.id);
    }
  }

  } finally {
    // Always release the per-position close lock
    positionCloseInProgress.delete(positionId);
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
  let confirmedKeeperClose = false;
  let keeperCloseReturnedSui: number | null = null;

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
        // Emergency override of pending close: reset state so the close loop can resubmit.
        // Close orders use create_trading_order(linked_position_id=Some(X), reduce_only=true).
        // Each attempt consumes one slot in the position's linked_orders array (max 5).
        // Emergency override: reset state so the close loop can resubmit after draining the array.
        console.log(`[Execution] EMERGENCY: Overriding close_pending for ${agent.name} pos ${pos.id} (${closeReason}). Resetting close state for resubmit.`);
        await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
        pendingCloseOrders.delete(pos.id);
      }

      // NOTE: Pre-cancel of linked orders is done at TTL-expiry (above) before each retry,
      // via cancelPendingOrdersForPosition. This drains any stale close orders from the
      // position's linked_orders array before resubmitting, preventing too_many_linked_orders.

      if ((cs.closeState === "close_order_working" || cs.closeState === "close_tx_submitted") && cs.closePendingSince) {
        const pendingAgeMs = closePendingAge(cs);
        console.log(`[Execution] Close pending TTL expired for ${agent.name} pos ${pos.id} (${Math.round(pendingAgeMs / 1000)}s). Verifying on-chain then cancelling stale orders before retry.`);
        // FIRST: check if position is already gone on-chain (keeper may have filled and settled it)
        let posGoneDuringTTL = false;
        if (adapter instanceof TypusAdapter && agent.walletAddress && pos.onChainPositionId) {
          try {
            const ttlCheckPositions = await (adapter as TypusAdapter).getPositions(agent.walletAddress);
            posGoneDuringTTL = !ttlCheckPositions.some((p: any) => String(p.positionId) === String(pos.onChainPositionId));
            if (posGoneDuringTTL) {
              console.log(`[Execution] TTL expiry check: Position ${pos.onChainPositionId} GONE from on-chain (keeper filled). Marking closed, skipping cancel+resubmit.`);
              onChainSuccess = true;
              closeTxDigest = cs.lastCloseTx || "keeper_filled_on_ttl";
              clearCloseGasTracking(pos.id);
              await updateCloseState(pos.id, { closeState: "closed", lastCloseTx: closeTxDigest, closePendingSince: null });
              pendingCloseOrders.delete(pos.id);
            }
          } catch (ttlCheckErr: any) {
            console.log(`[Execution] TTL on-chain check failed (${ttlCheckErr.message?.slice(0, 60)}) — proceeding with cancel+resubmit`);
          }
        }
        // DRAIN stale linked close orders before resubmitting.
        // NOTE: cancel_linked_orders is KEEPER_ONLY — cancelLinkedOrdersBatch always returns 0.
        // We use the drain result to detect positionGoneOnChain, but we cannot actually clear slots.
        // Instead of blindly resubmitting (which fills another slot in the 5-slot linked_orders
        // array), we apply a stall-cycle strategy: extend the TTL window MAX_TTL_STALL_CYCLES
        // times (giving the keeper 4×90s = 6min to fill), then force a price-refresh resubmit.
        let drainAllowsResubmit = false;
        if (!posGoneDuringTTL && adapter instanceof TypusAdapter && agent.walletAddress && pos.onChainPositionId) {
          try {
            console.log(`[Execution] TTL drain: checking on-chain state for ${agent.name} pos ${pos.onChainPositionId} (cancel_linked_orders is keeper-only, cannot clear slots)...`);
            const drainResult = await (adapter as TypusAdapter).cancelPendingOrdersForPosition(
              agent.agentWallet!,
              String(pos.onChainPositionId),
            );
            if ((drainResult as any).positionGoneOnChain) {
              console.log(`[Execution] TTL drain: position ${pos.onChainPositionId} GONE on-chain (signalled by cancel). Marking settled.`);
              posGoneDuringTTL = true;
              onChainSuccess = true;
              closeTxDigest = cs.lastCloseTx || "position_gone_on_ttl_drain";
              clearCloseGasTracking(pos.id);
              ttlDrainStallCycles.delete(pos.id);
              await updateCloseState(pos.id, { closeState: "closed", lastCloseTx: closeTxDigest, closePendingSince: null });
              pendingCloseOrders.delete(pos.id);
            } else if (drainResult.cancelled) {
              // Drain actually cleared orders — safe to resubmit (freed a slot).
              console.log(`[Execution] TTL drain: cancelled ${drainResult.cancelledCount} linked order(s) for pos ${pos.onChainPositionId} — slot freed, resetting for retry.`);
              ttlDrainStallCycles.delete(pos.id);
              drainAllowsResubmit = true;
            } else {
              // Drain returned 0 cancelled (KEEPER_ONLY stub or no orders found).
              // The existing linked close order is still pending in the position's linked_orders array.
              // Resubmitting now would fill ANOTHER slot (max 5) → too_many_linked_orders.
              // Instead, extend the TTL window and wait for the keeper to fill the existing order.
              const stallCount = (ttlDrainStallCycles.get(pos.id) || 0) + 1;
              ttlDrainStallCycles.set(pos.id, stallCount);
              if (stallCount < MAX_TTL_STALL_CYCLES) {
                console.log(`[Execution] TTL drain stall ${stallCount}/${MAX_TTL_STALL_CYCLES} for ${agent.name} pos ${pos.onChainPositionId} — extending TTL window, NOT resubmitting (keeper has active linked order in array).`);
                posGoneDuringTTL = true; // skip reset below — extend window instead
                await updateCloseState(pos.id, { closePendingSince: new Date().toISOString() });
                // Keep state as close_order_working, keep in pendingCloseOrders
              } else {
                // Exceeded stall limit — price may have changed significantly.
                // Force resubmit with fresh oracle price (slot will be consumed, but
                // we've waited 4×90s = 6min, well within the 5-slot budget).
                ttlDrainStallCycles.delete(pos.id);
                drainAllowsResubmit = true;
                console.log(`[Execution] TTL drain: ${stallCount} stall cycles exceeded for pos ${pos.onChainPositionId} — forcing price-refresh resubmit.`);
              }
            }
          } catch (drainErr: any) {
            console.log(`[Execution] TTL drain error (non-fatal): ${drainErr.message?.slice(0, 100)} — extending TTL to avoid blind resubmit.`);
            // On error, extend TTL rather than blindly resubmit.
            posGoneDuringTTL = true;
            await updateCloseState(pos.id, { closePendingSince: new Date().toISOString() });
          }
        } else if (!posGoneDuringTTL) {
          // No Typus adapter or no onChainPositionId — allow resubmit
          drainAllowsResubmit = true;
        }
        if (!posGoneDuringTTL && drainAllowsResubmit) {
          await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
          pendingCloseOrders.delete(pos.id);
        }
      }

      const lastAttemptAt = cs.closePendingSince ? new Date(cs.closePendingSince).getTime() : 0;
      if (!onChainSuccess && !isManualClose && !isEmergencyReason && lastAttemptAt > 0 && (Date.now() - lastAttemptAt) < MIN_CLOSE_RETRY_GAP_MS) {
        const waitSec = Math.round((MIN_CLOSE_RETRY_GAP_MS - (Date.now() - lastAttemptAt)) / 1000);
        console.log(`[Execution] Close retry gap not met for ${agent.name} pos ${pos.id} — wait ${waitSec}s before next attempt.`);
        return { closed: false, onChain: false, pnl: 0, error: `close_pending: Retry gap — next attempt in ${waitSec}s.` };
      }

      if (!onChainSuccess) {
        const preEmptiveActions = getPositionClosePreEmptiveActions(agent.id, pos.id);
        // Linked order drain is handled at TTL-expiry (above) for retries.
        // Close orders use create_trading_order(linked_position_id=Some(X), reduce_only=true),
        // consuming one slot per attempt. The TTL-expiry path drains stale orders before retry.
        if (preEmptiveActions.includes("stagger_close_delay")) {
          const jitter = Math.floor(Math.random() * 2000) + 500;
          await new Promise(r => setTimeout(r, jitter));
        }
        if (preEmptiveActions.includes("extended_backoff")) {
          const backoff = Math.floor(Math.random() * 1500) + 1000;
          console.log(`[Execution] PRE-EMPTIVE: Extended backoff ${backoff}ms for ${agent.name} pos ${pos.id} (rate-limit history)`);
          await new Promise(r => setTimeout(r, backoff));
        }
        // Emergency/protective closes always skip dry-run to avoid false rejections when
        // the position state is transitioning (e.g., SL partially executed, price at boundary).
        const skipDryRun = preEmptiveActions.includes("skip_dry_run") || isEmergencyReason || closeReason === "stop-loss" || closeReason === "trailing-stop";
        if (skipDryRun && isEmergencyReason) {
          console.log(`[Execution] EMERGENCY: Skipping dry-run preflight for ${agent.name} pos ${pos.id} — submitting live TX directly`);
        }

        await updateCloseState(pos.id, {
          closeState: "close_tx_submitted",
        });
        // Signal portfolio state engine: close submitted → yellow (pending_close)
        import("../portfolio-state").then(m => m.portfolioEngine.closeOrderSubmitted(agent.id)).catch(() => {});
        // Comms: close order submitted to Typus
        pushCommEvent({
          agentId: agent.id,
          type: "close_order",
          direction: "out",
          from: agent.walletAddress || "Funding Wallet",
          to: "Typus Perps",
          amount: pos.sizeSui,
          message: `Close order submitted for ${(pos.side || "").toUpperCase()} pos — ${closeReason || "signal exit"} @ $${currentPrice.toFixed(4)}`,
          side: pos.side as "long" | "short",
          closeReason: closeReason,
          status: "pending",
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
            // Retry path: uses create_trading_order(linked_position_id=Some(X), reduce_only=true).
            // Stale linked orders are drained at TTL-expiry before this retry is submitted.
            isFirstAttempt: false,
          });

          const alreadyClosed = (result as any).alreadyClosedOnChain === true;
          const likelyLiquidated = (result as any).likelyLiquidated === true;
          if (!alreadyClosed) {
            const resultError = (result as any).error || "";
            const wasRateLimited = isRateLimitError(String(resultError));
            if (!wasRateLimited) {
              trackCloseGasSpend(pos.id);
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
                // CRITICAL: must register the liquidation event BEFORE the early return,
                // otherwise the entry gate never sees a loss and opens a new position immediately.
                recordLiquidationEvent(agent.id, pos.id);
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
              const isProtectiveOrEmergency = closeReason === "stop-loss" || closeReason === "trailing-stop" || closeReason === "emergency-liquidation-prevent" || closeReason === "max-collateral-loss" || closeReason === "blocked-recovery" || closeReason === "manual";
              if (isProtectiveOrEmergency) {
                console.log(`[Execution] CLOSE VERIFY: ${agent.name} protective close (${closeReason}) NOT FILLED — waiting 10s then verifying and retrying with aggressive pricing...`);
                await new Promise(r => setTimeout(r, 10_000));
                try {
                  if (adapter instanceof TypusAdapter && agent.walletAddress && pos.onChainPositionId) {
                    const verifyPositions = await adapter.getPositions(agent.walletAddress);
                    const stillExists = verifyPositions.some((p: any) => String(p.positionId) === String(pos.onChainPositionId));
                    if (!stillExists) {
                      console.log(`[Execution] CLOSE VERIFY: Position ${pos.onChainPositionId} no longer on-chain after unfilled close. Close may have filled by keeper. Treating as success.`);
                      onChainSuccess = true;
                      closeTxDigest = result.txDigest || "verified_closed";
                      clearCloseGasTracking(pos.id);
                      await updateCloseState(pos.id, { closeState: "closed", lastCloseTx: closeTxDigest, closePendingSince: null });
                      pendingCloseOrders.delete(pos.id);
                    } else {
                      // Position still open after 10s — re-verify once more then retry close.
                      // Close orders are linked (linked_position_id=Some(X)).
                      // The TTL drain path will cancel stale orders before the next retry.
                      console.log(`[Execution] CLOSE VERIFY: Position ${pos.onChainPositionId} STILL OPEN after 10s. Rechecking and retrying close.`);
                      let posGoneAfterCancel = false;
                      try {
                        const recheckAfterCancel = await (adapter as TypusAdapter).getPositions(agent.walletAddress!);
                        posGoneAfterCancel = !recheckAfterCancel.some((p: any) => String(p.positionId) === String(pos.onChainPositionId));
                        if (posGoneAfterCancel) {
                          console.log(`[Execution] CLOSE VERIFY: Position ${pos.onChainPositionId} GONE on recheck — keeper filled the close order. Marking closed, skipping retry TX.`);
                          onChainSuccess = true;
                          closeTxDigest = result.txDigest || "keeper_filled_verified";
                          clearCloseGasTracking(pos.id);
                          await updateCloseState(pos.id, { closeState: "closed", lastCloseTx: closeTxDigest, closePendingSince: null });
                          pendingCloseOrders.delete(pos.id);
                        }
                      } catch (recheckErr: any) {
                        console.log(`[Execution] CLOSE VERIFY recheck error (non-fatal): ${recheckErr.message?.slice(0, 100)}`);
                      }
                      const retryResult = !posGoneAfterCancel ? await adapter.closePosition({
                        agent,
                        positionId: closeId,
                        side: pos.side as "long" | "short",
                        quantity: pos.sizeSui,
                        price: currentPrice,
                        skipDryRun: true,
                        isFirstAttempt: false,
                      }) : null;
                      // Only process retryResult if we actually submitted a retry TX
                      if (retryResult && retryResult.success && retryResult.filled !== false) {
                        console.log(`[Execution] CLOSE VERIFY RETRY SUCCESS: ${agent.name} pos ${pos.id} closed on retry (tx=${retryResult.txDigest})`);
                        onChainSuccess = true;
                        closeTxDigest = retryResult.txDigest || "retry_close";
                        clearCloseGasTracking(pos.id);
                        await updateCloseState(pos.id, { closeState: "closed", lastCloseTx: closeTxDigest, closePendingSince: null });
                        pendingCloseOrders.delete(pos.id);
                      } else if (retryResult) {
                        console.log(`[Execution] CLOSE VERIFY RETRY: Still not filled — position remains at risk. Will retry on next monitor tick.`);
                        trackCloseGasSpend(pos.id);
                        await updateCloseState(pos.id, {
                          closeState: "close_order_working",
                          closeAttempts: (cs.closeAttempts || 0) + 2,
                          lastCloseTx: retryResult.txDigest || result.txDigest || null,
                          closePendingSince: new Date(),
                        });
                        pendingCloseOrders.set(pos.id, { orderId: retryResult.orderId || result.orderId, txDigest: retryResult.txDigest || result.txDigest, setAt: Date.now() });
                        return { closed: false, onChain: false, pnl: 0, error: `close_pending: Protective close retry submitted — awaiting fill.` };
                      }
                    }
                  }
                } catch (verifyErr: any) {
                  console.log(`[Execution] CLOSE VERIFY error: ${verifyErr.message?.slice(0, 200)} — falling through to standard pending path`);
                }
              }
              if (!onChainSuccess) {
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
            }
            onChainSuccess = true;
            closeTxDigest = result.txDigest || "keeper_filled";

            // ── Balance-change inspection ─────────────────────────────────────────────
            // A close ORDER submission (create_trading_order) only burns gas + returns
            // a tiny storage rebate from the Pyth VAA (~414k mist).  Real settlement
            // (keeper fill) returns collateral + PnL — always >> 1M mist.
            // If the balance delta from OUR TX is dust, this is a NON_SETTLING_SUCCESS:
            // the close order landed on-chain but the keeper has not filled it yet.
            // Classify correctly and wait for keeper fill instead of marking settled.
            // ─────────────────────────────────────────────────────────────────────────
            const SETTLEMENT_MIST_THRESHOLD = 1_000_000n; // 0.001 SUI — dust threshold
            if (!alreadyClosed && result.txDigest && agent.walletAddress) {
              try {
                const closeTxData = await suiClient.getTransactionBlock({
                  digest: result.txDigest,
                  options: { showBalanceChanges: true, showObjectChanges: true },
                });
                const isSuiType = (coinType: string) =>
                  coinType === "0x2::sui::SUI" || coinType.includes("::sui::SUI");
                const agentSuiDeltaMist = BigInt(
                  Math.round(
                    (closeTxData.balanceChanges || [])
                      .filter((bc: any) =>
                        bc.owner?.AddressOwner &&
                        bc.owner.AddressOwner.toLowerCase() === (agent.walletAddress || "").toLowerCase() &&
                        isSuiType(bc.coinType)
                      )
                      .reduce((sum: number, bc: any) => sum + Number(bc.amount), 0)
                  )
                );
                const objectChanges = (closeTxData as any).objectChanges || [];
                const positionDeleted = objectChanges.some(
                  (oc: any) => oc.type === "deleted" && String(oc.objectId) === String(pos.onChainPositionId)
                );
                console.log(`[Execution] CLOSE_TX_INSPECTION ${result.txDigest}: agent SUI delta=${agentSuiDeltaMist} mist (${(Number(agentSuiDeltaMist) / 1e9).toFixed(6)} SUI), positionDeleted=${positionDeleted}`, {
                  dbPositionId: pos.id,
                  chainPositionId: pos.onChainPositionId,
                  agentName: agent.name,
                });
                if (!positionDeleted && agentSuiDeltaMist < SETTLEMENT_MIST_THRESHOLD) {
                  // NON_SETTLING_SUCCESS: Our TX submitted a close ORDER but no settlement
                  // occurred. The keeper will fill the order — wait 30s for keeper fill.
                  console.log(`[Execution] NON_SETTLING_SUCCESS: TX ${result.txDigest} for ${agent.name} pos ${pos.onChainPositionId} — balance delta ${agentSuiDeltaMist} mist below threshold. Close order pending keeper fill.`);
                  onChainSuccess = false;
                  closeTxDigest = null;
                  await updateCloseState(pos.id, { closeState: "close_order_working", lastCloseTx: result.txDigest, closePendingSince: new Date() });
                  pendingCloseOrders.set(pos.id, { orderId: result.orderId, txDigest: result.txDigest, setAt: Date.now() });
                  positionCloseCooldown.set(pos.id, Date.now() + 30_000);
                  return { closed: false, onChain: false, pnl: 0, error: `NON_SETTLING_SUCCESS: close order submitted tx=${result.txDigest}, waiting 30s for keeper fill.` };
                }
                if (positionDeleted || agentSuiDeltaMist >= SETTLEMENT_MIST_THRESHOLD) {
                  console.log(`[Execution] SETTLEMENT_CONFIRMED: TX ${result.txDigest} for ${agent.name} pos ${pos.onChainPositionId} — balance delta ${agentSuiDeltaMist} mist, positionDeleted=${positionDeleted}. Proceeding to settle.`);
                }
              } catch (inspectErr: any) {
                console.log(`[Execution] Close TX inspection failed for ${agent.name}: ${inspectErr.message?.slice(0, 100)} — falling back to position-list check.`);
              }
            }

            if (!alreadyClosed && onChainSuccess && adapter instanceof TypusAdapter && agent.walletAddress && pos.onChainPositionId) {
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
            // Comms: position closed confirmed
            pushCommEvent({
              agentId: agent.id,
              type: "trade_close",
              direction: "in",
              from: "Typus Perps",
              to: agent.walletAddress || "Funding Wallet",
              amount: pos.sizeSui,
              message: alreadyClosed
                ? `Position closed by Typus Keeper @ $${currentPrice.toFixed(4)} (${closeReason || "keeper fill"})`
                : `Position CLOSED on-chain @ $${currentPrice.toFixed(4)} — tx ${(result.txDigest || "").slice(0, 8)}…`,
              side: pos.side as "long" | "short",
              txDigest: result.txDigest || undefined,
              closeReason: closeReason,
              status: "confirmed",
            });
            if (alreadyClosed) {
              console.log(`[Execution] Position already closed on-chain by keeper for ${agent.name}: tx=${closeTxDigest}`);
            } else {
              console.log(`[Execution] DEX close SUCCESS for ${agent.name}: tx=${result.txDigest} (filled=true, on-chain confirmed)`);
            }
          } else {
            closeError = result.error || "close failed — unknown reason";
            console.log(`[Execution] DEX close returned no valid txDigest for ${agent.name}: ${closeError}`);

            const errIsTypusInProgress = closeError.includes("close_already_in_progress");
            const errIsClosePending = closeError.includes("close_pending") || closeError.includes("awaiting fill") || errIsTypusInProgress;
            if (errIsClosePending) {
              if (errIsTypusInProgress) {
                // Typus protocol says a close is already in-flight. This is NOT a failure.
                // Treat as "close order is working" — freeze for 180s, do NOT resubmit or cancel.
                // The keeper will fill the existing close order. We just need to wait and poll.
                console.log(`[Execution] CLOSE_ALREADY_IN_PROGRESS from Typus for ${agent.name} pos ${pos.id} — NOT retrying. Freezing ${CLOSE_ALREADY_IN_PROGRESS_FREEZE_MS / 1000}s, polling for keeper fill.`);
                await updateCloseState(pos.id, { closeState: "close_order_working", closePendingSince: new Date() });
                positionCloseCooldown.set(pos.id, Date.now() + CLOSE_ALREADY_IN_PROGRESS_FREEZE_MS);
              } else {
                console.log(`[Execution] close_pending detected in error for ${agent.name} pos ${pos.id} — NOT resubmitting. Keeping existing closePendingSince.`);
                await updateCloseState(pos.id, { closeState: "close_order_working" });
                positionCloseCooldown.set(pos.id, Date.now() + CLOSE_COOLDOWN_MS);
              }
              return { closed: false, onChain: false, pnl: 0, error: closeError };
            }

            // For emergency/protective closes: verify position still exists on-chain before marking as failed.
            // If the position is already gone, it was closed by the keeper — treat as success.
            const isEmergencyOrProtective = closeReason === "emergency-liquidation-prevent" || closeReason === "max-collateral-loss" || closeReason === "blocked-recovery" || closeReason === "stop-loss" || closeReason === "trailing-stop" || closeReason === "manual";
            if (isEmergencyOrProtective && adapter instanceof TypusAdapter && agent.walletAddress && pos.onChainPositionId) {
              try {
                const onChainVerify = await adapter.getPositions(agent.walletAddress);
                const stillExists = onChainVerify.some((p: any) => String(p.positionId) === String(pos.onChainPositionId));
                if (!stillExists) {
                  console.log(`[Execution] CLOSE VERIFY: ${agent.name} pos ${pos.onChainPositionId} gone from on-chain despite TX failure — treating as keeper-closed. Success.`);
                  onChainSuccess = true;
                  closeTxDigest = result.txDigest || "verified_closed_oncall";
                  clearCloseGasTracking(pos.id);
                  await updateCloseState(pos.id, { closeState: "closed", lastCloseTx: closeTxDigest, closePendingSince: null });
                  pendingCloseOrders.delete(pos.id);
                  // Fall through to settlement below
                } else {
                  console.log(`[Execution] CLOSE VERIFY: ${agent.name} pos ${pos.onChainPositionId} still on-chain — TX was genuinely rejected. Will retry.`);
                }
              } catch (verifyErr: any) {
                console.log(`[Execution] On-chain verify failed after close TX rejection (${verifyErr.message?.slice(0, 80)}) — continuing with standard retry`);
              }
            }

            if (onChainSuccess) {
              // Position was gone on-chain — fall through to the settlement path below
            } else if ((result as any).correctedPositionId) {
              const correctedId = (result as any).correctedPositionId;
              console.log(`[Execution] Adapter found corrected position ID for ${agent.name}: stored=${pos.onChainPositionId} → corrected=${correctedId}. Updating DB and will retry on next cycle.`);
              await storage.updatePosition(pos.id, { onChainPositionId: correctedId });
              pos = { ...pos, onChainPositionId: correctedId };
              await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
              positionCloseCooldown.set(pos.id, Date.now() + 5000);
              return { closed: false, onChain: false, pnl: 0, error: `Corrected position ID to ${correctedId} — retrying on next cycle.` };
            } else if (closeError.includes("order_not_found") || closeError.includes("position_not_found")) {
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
            } else if (closeError.includes("GHOST_ORDERS_FULL") || closeError.includes("GHOST_ORDERS_COOLDOWN")) {
              // Typus adapter blocked the TX before submission — linked_orders array is full OR
              // still within the ghost-order cooldown window. Ghost close orders are ACTIVE in the
              // array; submitting another would fail. Wait for the keeper to fill them.
              const ghostLabel = closeError.includes("GHOST_ORDERS_FULL") ? "GHOST_ORDERS_FULL" : "GHOST_ORDERS_COOLDOWN";
              console.log(`[Execution] ${ghostLabel} for ${agent.name} pos ${pos.id} — keeper has active ghost orders. No new TX. DbPendingScan will poll for keeper fill.`);
              logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: `${ghostLabel}: ${closeError.slice(0, 80)}`, closeReason });
              ttlDrainStallCycles.delete(pos.id);
              await updateCloseState(pos.id, { closeState: "close_order_working", closePendingSince: new Date() });
              positionCloseCooldown.set(pos.id, Date.now() + 10_000);
              return { closed: false, onChain: false, pnl: 0, error: `${ghostLabel}: waiting for keeper to fill ghost orders before retry.` };
            } else if (closeError.includes("too_many_linked_orders")) {
              // LINKED_ORDER_SATURATED: position's linked_orders array (max 5 slots) is full.
              // Each close attempt consumes one slot via create_trading_order(linked_position_id=Some(X)).
              // cancel_linked_orders is KEEPER_ONLY — we cannot clear slots ourselves.
              console.log(`[Execution] LINKED_ORDER_SATURATED for ${agent.name} pos ${pos.id} (onChainId=${pos.onChainPositionId}) — checking on-chain then waiting for keeper.`);
              logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: `LINKED_ORDER_SATURATED: ${closeError}`, closeReason, attemptNumber: (pos.closeAttempts || 0) + 1 });
              if (adapter instanceof TypusAdapter && agent.walletAddress && pos.onChainPositionId) {
                try {
                  const drainResult = await (adapter as TypusAdapter).cancelPendingOrdersForPosition(
                    agent.agentWallet!,
                    String(pos.onChainPositionId),
                  );
                  if ((drainResult as any).positionGoneOnChain) {
                    console.log(`[Execution] LINKED_ORDER_SATURATED drain: position ${pos.onChainPositionId} GONE on-chain. Marking settled.`);
                    positionGoneFromDex = true;
                    await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
                  } else if (drainResult.cancelled && drainResult.cancelledCount > 0) {
                    console.log(`[Execution] LINKED_ORDER_SATURATED drain: cancelled ${drainResult.cancelledCount} linked order(s). Resetting for immediate retry.`);
                    await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
                    positionCloseCooldown.set(pos.id, Date.now() + 3000);
                  } else {
                    // 0 cancelled — cancel_linked_orders is keeper-only so we can NEVER clear slots.
                    // The ghost orders ARE still in the linked_orders array pending keeper fill.
                    // Do NOT reset to close_requested (causes rapid gas-burning retry loop).
                    // Instead: mark close_order_working + short cooldown so DbPendingScan can poll
                    // for keeper fills every 3s. The adapter's ghostOrderStuckUntil (120s) blocks
                    // new TX submissions independently. Positions settle ONE AT A TIME as keeper fills.
                    console.log(`[Execution] LINKED_ORDER_SATURATED drain: 0 cancellable — ghost orders still active in linked_orders array. DbPendingScan will poll for keeper fill.`);
                    ttlDrainStallCycles.delete(pos.id);
                    await updateCloseState(pos.id, { closeState: "close_order_working", closePendingSince: new Date() });
                    positionCloseCooldown.set(pos.id, Date.now() + 10_000);
                  }
                } catch (drainErr: any) {
                  console.log(`[Execution] LINKED_ORDER_SATURATED drain error: ${drainErr.message?.slice(0, 100)}`);
                  await updateCloseState(pos.id, { closeState: "close_order_working", closePendingSince: new Date() });
                  positionCloseCooldown.set(pos.id, Date.now() + 10_000);
                }
              } else {
                await updateCloseState(pos.id, { closeState: "close_order_working", closePendingSince: new Date() });
                positionCloseCooldown.set(pos.id, Date.now() + 10_000);
              }
              return { closed: false, onChain: false, pnl: 0, error: `LINKED_ORDER_SATURATED: ghost orders active — waiting for keeper fill before retry.` };
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

          // For emergency closes: verify position still exists on-chain after TX exception.
          // If it's gone, it was closed by the keeper — treat as success.
          const isExcEmergency = closeReason === "emergency-liquidation-prevent" || closeReason === "max-collateral-loss" || closeReason === "blocked-recovery" || closeReason === "stop-loss" || closeReason === "trailing-stop";
          if (isExcEmergency && adapter instanceof TypusAdapter && agent.walletAddress && pos.onChainPositionId) {
            try {
              const excVerify = await adapter.getPositions(agent.walletAddress);
              const excStillExists = excVerify.some((p: any) => String(p.positionId) === String(pos.onChainPositionId));
              if (!excStillExists) {
                console.log(`[Execution] CLOSE VERIFY (exc): ${agent.name} pos ${pos.onChainPositionId} gone from on-chain despite exception — treating as keeper-closed.`);
                onChainSuccess = true;
                closeTxDigest = "verified_closed_after_exception";
                clearCloseGasTracking(pos.id);
                await updateCloseState(pos.id, { closeState: "closed", lastCloseTx: closeTxDigest, closePendingSince: null });
                pendingCloseOrders.delete(pos.id);
                closeError = null;
              }
            } catch (excVerifyErr: any) {
              console.log(`[Execution] On-chain verify failed after close exception (${excVerifyErr.message?.slice(0, 80)}) — continuing`);
            }
          }

          if (onChainSuccess) {
            // Fall through to settlement path
          } else {

          const errIsTypusInProgressExc = closeError?.includes("close_already_in_progress");
          const errIsClosePending = closeError?.includes("close_pending") || closeError?.includes("awaiting fill") || errIsTypusInProgressExc;
          if (errIsClosePending) {
            if (errIsTypusInProgressExc) {
              console.log(`[Execution] CLOSE_ALREADY_IN_PROGRESS (exc) from Typus for ${agent.name} pos ${pos.id} — freezing ${CLOSE_ALREADY_IN_PROGRESS_FREEZE_MS / 1000}s.`);
              await updateCloseState(pos.id, { closeState: "close_order_working", closePendingSince: new Date() });
              positionCloseCooldown.set(pos.id, Date.now() + CLOSE_ALREADY_IN_PROGRESS_FREEZE_MS);
            } else {
              logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: closeError, closeReason });
              await updateCloseState(pos.id, { closeState: "close_order_working" });
              positionCloseCooldown.set(pos.id, Date.now() + CLOSE_COOLDOWN_MS);
            }
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
          } else if (closeError.includes("GHOST_ORDERS_FULL") || closeError.includes("GHOST_ORDERS_COOLDOWN")) {
            const ghostLabel2 = closeError.includes("GHOST_ORDERS_FULL") ? "GHOST_ORDERS_FULL" : "GHOST_ORDERS_COOLDOWN";
            console.log(`[Execution] ${ghostLabel2} (exc) for ${agent.name} pos ${pos.id} — ghost orders active. DbPendingScan will poll for keeper fill.`);
            logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: `${ghostLabel2}(exc): ${closeError.slice(0, 80)}`, closeReason });
            ttlDrainStallCycles.delete(pos.id);
            await updateCloseState(pos.id, { closeState: "close_order_working", closePendingSince: new Date() });
            positionCloseCooldown.set(pos.id, Date.now() + 10_000);
            return { closed: false, onChain: false, pnl: 0, error: `${ghostLabel2}(exc): waiting for keeper fill.` };
          } else if (closeError.includes("too_many_linked_orders")) {
            // LINKED_ORDER_SATURATED (exception path): drain linked_orders array then retry.
            console.log(`[Execution] LINKED_ORDER_SATURATED (exc) for ${agent.name} pos ${pos.id} (onChainId=${pos.onChainPositionId}) — draining linked_orders array.`);
            logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: `LINKED_ORDER_SATURATED(exc): ${closeError}`, closeReason });
            if (adapter instanceof TypusAdapter && agent.walletAddress && pos.onChainPositionId) {
              try {
                const drainResult2 = await (adapter as TypusAdapter).cancelPendingOrdersForPosition(
                  agent.agentWallet!,
                  String(pos.onChainPositionId),
                );
                if ((drainResult2 as any).positionGoneOnChain) {
                  console.log(`[Execution] LINKED_ORDER_SATURATED (exc) drain: position GONE on-chain. Marking settled.`);
                  positionGoneFromDex = true;
                } else if (drainResult2.cancelled && drainResult2.cancelledCount > 0) {
                  console.log(`[Execution] LINKED_ORDER_SATURATED (exc) drain: cancelled ${drainResult2.cancelledCount} order(s). Resetting for retry.`);
                  await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
                  positionCloseCooldown.set(pos.id, Date.now() + 3000);
                } else {
                  // 0 cancelled — cancel_linked_orders is keeper-only so we can NEVER clear slots.
                  // Ghost orders are still active. Wait 120s for keeper fill; DbPendingScan watches.
                  console.log(`[Execution] LINKED_ORDER_SATURATED (exc) drain: 0 cancellable — ghost orders still active. DbPendingScan will poll for keeper fill.`);
                  ttlDrainStallCycles.delete(pos.id);
                  await updateCloseState(pos.id, { closeState: "close_order_working", closePendingSince: new Date() });
                  positionCloseCooldown.set(pos.id, Date.now() + 10_000);
                }
              } catch (drainErr2: any) {
                console.log(`[Execution] LINKED_ORDER_SATURATED (exc) drain error: ${drainErr2.message?.slice(0, 100)}`);
                await updateCloseState(pos.id, { closeState: "close_order_working", closePendingSince: new Date() });
                positionCloseCooldown.set(pos.id, Date.now() + 10_000);
              }
            } else {
              await updateCloseState(pos.id, { closeState: "close_order_working", closePendingSince: new Date() });
              positionCloseCooldown.set(pos.id, Date.now() + 10_000);
            }
            return { closed: false, onChain: false, pnl: 0, error: `LINKED_ORDER_SATURATED(exc): ghost orders active — waiting for keeper fill before retry.` };
          } else {
            logCloseFailure({ agentId: agent.id, agentName: agent.name, positionId: pos.id, onChainPositionId: pos.onChainPositionId, errorMessage: closeError, closeReason });
          }

          await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
          } // end else (not onChainSuccess)
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
          const retryGasCheck = trackCloseGasSpend(pos.id);
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
            isFirstAttempt: false,
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
    let priceSaysLiquidationPossible = collateralLossPctFromPrice >= 80;

    // LIQUIDATION GUARD FIX: Also check whether the 24h high/low ever breached the
    // position's liquidation price. When a SHORT is liquidated at the daily high
    // (e.g., SUI $1.0496 > liqPrice $1.0433) and price later falls back below entry,
    // the "current price vs entry" check says "0% collateral loss — not a liquidation"
    // even though the position WAS liquidated at the peak. The 24h range catches this.
    const liqPrice = pos.liquidationPrice;
    if (!priceSaysLiquidationPossible && liqPrice) {
      try {
        const { getVerified24hData } = await import("../market-engine");
        const data24h = getVerified24hData();
        if (data24h.high > 0 && data24h.low > 0) {
          const liqBreach = pos.side === "long"
            ? data24h.low <= liqPrice   // LONG liquidated when price fell to liqPrice
            : data24h.high >= liqPrice; // SHORT liquidated when price rose to liqPrice
          if (liqBreach) {
            priceSaysLiquidationPossible = true;
            console.log(`[Execution] LIQUIDATION GUARD: 24h range ($${data24h.low.toFixed(4)}-$${data24h.high.toFixed(4)}) breached liqPrice=$${liqPrice.toFixed(4)} for ${pos.side} ${agent.name} — marking liquidation possible.`);
          }
        }
      } catch (_) { /* non-blocking */ }
    }

    console.log(`[Execution] Position ${pos.onChainPositionId} gone from Typus for ${agent.name}. Price analysis: ${pos.side} entry=$${pos.entryPrice.toFixed(4)}, exit=$${currentPrice.toFixed(4)}, priceMove=${priceMoveForLiqCheck.toFixed(3)}%, collateralLoss=${collateralLossPctFromPrice.toFixed(1)}%, liquidationPossible=${priceSaysLiquidationPossible}`);

    let confirmedLiquidation = false;
    let liquidationTxDigest: string | null = null;
    let keeperCloseTxDigest: string | null = null;
    try {
      const recentTxs = await suiClient.queryTransactionBlocks({
        filter: { ToAddress: agent.walletAddress || "" },
        options: { showEvents: true, showBalanceChanges: true },
        limit: 25,
        order: "descending" as any,
      });
      const onChainPosId = pos.onChainPositionId;
      const SUI_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
      const isSuiCoin = (coinType: string) => coinType === "0x2::sui::SUI" || coinType === SUI_TYPE;
      const normalizeAddr = (a: string) => a.toLowerCase();
      if (recentTxs?.data && onChainPosId) {
        for (const txBlock of recentTxs.data) {
          const events = (txBlock as any).events;
          if (!events) continue;
          let matchesPosition = false;
          let isLiquidation = false;
          let isClose = false;
          for (const evt of events) {
            const parsed = (evt as any).parsedJson;
            if (!parsed) continue;
            const evtType = (evt as any).type || "";
            if (String(parsed.position_id) === String(onChainPosId) || String(parsed.linked_position_id) === String(onChainPosId)) {
              matchesPosition = true;
              if (evtType.includes("LiquidateEvent")) isLiquidation = true;
              if (evtType.includes("ClosePositionEvent") || evtType.includes("RemovePositionEvent") || evtType.includes("DecreasePositionEvent") || evtType.includes("OrderFilledEvent")) isClose = true;
            }
          }
          if (matchesPosition && isLiquidation) {
            confirmedLiquidation = true;
            liquidationTxDigest = (txBlock as any).digest || null;
            console.log(`[Execution] ON-CHAIN LIQUIDATION EVENT confirmed for ${agent.name} position ${onChainPosId} in tx ${liquidationTxDigest}`);
            break;
          }
          if (matchesPosition && isClose && !confirmedKeeperClose) {
            const balanceChanges = (txBlock as any).balanceChanges || [];
            const agentSuiChange = balanceChanges
              .filter((bc: any) => bc.owner?.AddressOwner && normalizeAddr(bc.owner.AddressOwner) === normalizeAddr(agent.walletAddress || "") && isSuiCoin(bc.coinType))
              .reduce((sum: number, bc: any) => sum + Number(bc.amount), 0);
            const returnedSui = agentSuiChange / 1e9;
            if (returnedSui > 0.01) {
              confirmedKeeperClose = true;
              keeperCloseTxDigest = (txBlock as any).digest || null;
              keeperCloseReturnedSui = returnedSui;
              console.log(`[Execution] KEEPER CLOSE confirmed for ${agent.name} position ${onChainPosId} in tx ${keeperCloseTxDigest}: returned=${returnedSui.toFixed(4)} SUI`);
            }
          }
        }
      }
    } catch (scanErr: any) {
      console.log(`[Execution] Transaction scan for settlement type failed: ${scanErr.message}`);
    }

    if (confirmedLiquidation) {
      positionAlreadySettled = true;
      closeTxDigest = liquidationTxDigest;
      console.log(`[Execution] LIQUIDATION confirmed by on-chain event for ${agent.name}: full collateral loss.`);
    } else if (confirmedKeeperClose && keeperCloseTxDigest) {
      onChainSuccess = true;
      closeTxDigest = keeperCloseTxDigest;
      console.log(`[Execution] KEEPER FILL found for ${agent.name} position ${pos.onChainPositionId}: tx=${keeperCloseTxDigest}, returned=${keeperCloseReturnedSui?.toFixed(4)} SUI. Using actual close data instead of price estimate.`);
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

      const isEmergencyClose = closeReason && (closeReason.includes("liquidation") || closeReason.includes("emergency") || closeReason.includes("max-collateral-loss"));

      if (currentOnChainSui !== null) {
        const allPosForCheck = await storage.getPositions(agent.id);
        const otherOpenPositions = allPosForCheck.filter(p => p.id !== pos.id && (p.status === "open" || p.status === "pending_open"));
        const otherLockedCollateral = otherOpenPositions.reduce((sum, p) => sum + (p.collateral || p.sizeSui / agent.leverage), 0);
        const expectedWithoutCollateral = Math.max(0, agent.balance - otherLockedCollateral - collateralForCheck);
        const returnedAmount = currentOnChainSui - expectedWithoutCollateral;
        console.log(`[Execution] Balance analysis for ${agent.name}: onChain=${currentOnChainSui.toFixed(4)}, expectedWithout=${expectedWithoutCollateral.toFixed(4)}, returned=${returnedAmount.toFixed(4)}, collateral=${collateralForCheck.toFixed(4)}, isEmergency=${!!isEmergencyClose}`);

        const returnThreshold = isEmergencyClose ? 0.50 : 0.15;

        if (returnedAmount > collateralForCheck * returnThreshold) {
          onChainSuccess = true;
          closeTxDigest = "settled_onchain";
          console.log(`[Execution] Position ${pos.onChainPositionId} settled for ${agent.name}: collateral returned (${returnedAmount.toFixed(4)} > ${(returnThreshold * 100).toFixed(0)}% of ${collateralForCheck.toFixed(4)}).`);
        } else {
          positionAlreadySettled = true;
          console.log(`[Execution] LIQUIDATION: position gone, price suggests possible liquidation, collateral not returned (${returnedAmount.toFixed(4)} SUI < ${(returnThreshold * 100).toFixed(0)}% of ${collateralForCheck.toFixed(4)}). Full collateral loss.`);
        }
      } else {
        if (isEmergencyClose) {
          positionAlreadySettled = true;
          console.log(`[Execution] LIQUIDATION (conservative): Position ${pos.onChainPositionId} gone for ${agent.name}: emergency close reason="${closeReason}", price suggests possible liquidation, balance unavailable. Assuming full collateral loss — reconciliation will correct if wrong.`);
        } else {
          onChainSuccess = true;
          closeTxDigest = "settled_onchain";
          console.log(`[Execution] Position ${pos.onChainPositionId} gone for ${agent.name}: price justifies possible liquidation (${collateralLossPctFromPrice.toFixed(1)}% collateral loss) BUT balance unavailable AND no LiquidateEvent found. Treating as settled — reconciliation will correct from on-chain truth.`);
        }
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
  } else if (confirmedKeeperClose && keeperCloseReturnedSui !== null) {
    realizedPnl = Math.min(maxReasonableGain, Math.max(-collateral, keeperCloseReturnedSui - collateral));
    console.log(`[Execution] KEEPER-DERIVED PnL for ${agent.name}: returned=${keeperCloseReturnedSui.toFixed(4)} SUI, collateral=${collateral.toFixed(4)}, PnL=${realizedPnl.toFixed(4)} (vs price-based=${pricePnl.toFixed(4)})`);
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
    // If 90%+ of collateral was destroyed, treat this as a liquidation for
    // circuit-breaker purposes — trigger the hard 30-minute block regardless
    // of whether the keeper or our own close submitted the order.
    const collateralLossFraction = collateral > 0 ? Math.abs(realizedPnl) / collateral : 0;
    const isEffectiveLiquidation = collateralLossFraction >= 0.90 ||
      closeReason === "liquidated" ||
      (pos as any).closeTxDigest === "liquidated_onchain";
    if (isEffectiveLiquidation) {
      recordLiquidationEvent(agent.id, pos.id);
    } else {
      recordTradeLoss(agent.id, pos.id);
    }
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
            // SETTLEMENT ACCOUNTING FIX: Keeper hasn't filled yet — the collateral
            // is still logically locked on-chain (in the Typus order book, awaiting fill).
            // Do NOT reduce balance with a price estimate now; the position is in-transit.
            // The reconciliation passes scheduled at 20s, 60s, 120s, 300s will correct
            // the balance once the keeper fills and funds actually return to the wallet.
            // Keeping currentBalance prevents a premature drop that makes the funding
            // wallet appear to shrink before settlement completes.
            finalBalance = currentBalance;
            console.log(`[BalanceSync] KEEPER SETTLEMENT PENDING: balance preserved at ${currentBalance.toFixed(4)} SUI (collateral=${collateral.toFixed(4)} in transit). Recon will correct after keeper fills.`);
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

    // Anti-false-reward guard: verify the actual on-chain balance change is positive before
    // generating rewards. Price-based PnL can appear positive while trading fees + funding
    // + keeper costs turn the trade net-negative.
    // Example: price move +0.39 SUI, protocol fees -0.50 SUI → net -0.11 SUI → no reward.
    // Only applies when settlement is complete (not pending keeper fill) to avoid blocking
    // legitimate rewards for positions that haven't settled yet.
    if (!settlementPending && realizedPnl > 0) {
      const netBalanceChange = finalBalance - currentBalance;
      if (netBalanceChange < -0.02) {
        console.log(`[Rewards] SUPPRESSING false reward for ${agent.name}: price PnL=${realizedPnl.toFixed(4)} SUI but actual balance change=${netBalanceChange.toFixed(4)} SUI — fees exceeded price gain`);
        realizedPnl = netBalanceChange; // fail the > 0 check below
      }
    }

    // Allow rewards for: (1) our own close TX, OR (2) confirmed keeper fills (trailing stop/TP filled on-chain)
    // Liquidations are excluded by the realizedPnl > 0 check (they always have negative PnL)
    if (realizedPnl > 0 && rewardSharePct > 0 && (!positionAlreadySettled || confirmedKeeperClose)) {
      let remainingLockedColl = 0;
      try {
        const allAgentPos = await storage.getPositions(agent.id);
        remainingLockedColl = allAgentPos
          .filter((p: any) => p.status === "open" && p.id !== pos.id)
          .reduce((s: number, p: any) => s + (p.collateral || p.sizeSui / agent.leverage), 0);
      } catch {}
      // When settlement is pending, finalBalance = currentBalance (collateral not yet returned).
      // Add expected collateral return + profit so we don't incorrectly defer the reward.
      const settlementAdjustment = settlementPending ? Math.max(0, collateral + realizedPnl) : 0;
      const estimatedPostCloseFreeSui = finalBalance + settlementAdjustment - remainingLockedColl;
      console.log(`[Rewards] Balance check for ${agent.name}: finalBalance=${finalBalance.toFixed(4)}, settlementPending=${settlementPending}, settlementAdj=${settlementAdjustment.toFixed(4)}, remainingLocked=${remainingLockedColl.toFixed(4)}, estimatedFree=${estimatedPostCloseFreeSui.toFixed(4)}, threshold=${LOW_BALANCE_REWARD_SKIP_THRESHOLD}`);
      if (estimatedPostCloseFreeSui < LOW_BALANCE_REWARD_SKIP_THRESHOLD) {
        console.log(`[Rewards] DEFERRING reward for ${agent.name}: freeSui after close ~${estimatedPostCloseFreeSui.toFixed(4)} < ${LOW_BALANCE_REWARD_SKIP_THRESHOLD} SUI threshold. Keeping profit in wallet for gas/capital growth.`);
        rewardAmount = 0;
      } else {
        rewardAmount = realizedPnl * (rewardSharePct / 100);
        const closeType = confirmedKeeperClose ? "keeper fill" : "on-chain close";
        console.log(`[Execution] Profitable ${closeType}: PnL=${realizedPnl.toFixed(4)}, reward=${rewardAmount.toFixed(4)}`);
      }
    }
    if (positionAlreadySettled && !confirmedKeeperClose) {
      console.log(`[Execution] No reward for settled/liquidated position — full collateral loss`);
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

  // Correct PnL from actual close TX balance changes — ground truth, same approach as keeper closes
  if (onChainSuccess && !positionAlreadySettled && agent.walletAddress && closeTxDigest &&
      !closeTxDigest.startsWith("sim_") && closeTxDigest !== "keeper_filled" &&
      closeTxDigest !== "prior_fill" && closeTxDigest !== "settled_onchain" &&
      closeTxDigest !== "position_gone_onchain" && closeTxDigest !== "keeper_filled_tracked") {
    try {
      const { inspectCloseTxBalanceChanges: inspectPnlTx } = await import("../sui-verify");
      const txPnl = await inspectPnlTx(closeTxDigest, agent.walletAddress);
      if (txPnl.returned > 0) {
        const txDerivedPnl = txPnl.returned - collateral;
        const cappedTxPnl = Math.max(-collateral, Math.min(maxReasonableGain, txDerivedPnl));
        if (Math.abs(cappedTxPnl - realizedPnl) > 0.01) {
          console.log(`[PnL] TX-derived PnL ${cappedTxPnl.toFixed(4)} replaces price-based ${realizedPnl.toFixed(4)} for ${agent.name}: returned=${txPnl.returned.toFixed(4)} SUI, collateral=${collateral.toFixed(4)} SUI`);
          realizedPnl = cappedTxPnl;
        }
      }
    } catch (txPnlErr: any) {
      console.log(`[PnL] TX inspection for PnL failed for ${agent.name}: ${txPnlErr.message?.slice(0, 60)}`);
    }
  }

  const finalCloseTxDigest = closeTxDigest || (positionAlreadySettled ? "liquidated_onchain" : null);

  clearCloseGasTracking(pos.id);

  // A close is only "onchain_verified" if it has a real on-chain TX digest (≥40 chars, not a synthetic marker)
  const SYNTHETIC_CLOSE_MARKERS = new Set([
    "sim_", "settled_onchain", "liquidated_onchain", "position_gone_onchain",
    "healed-not-onchain", "manual-review-settled", "closed_externally",
    "verified_closed", "retry_close", "cancelled_unfilled", "keeper_filled",
  ]);
  const finalDigestIsReal = finalCloseTxDigest != null &&
    finalCloseTxDigest.length >= 40 &&
    !Array.from(SYNTHETIC_CLOSE_MARKERS).some(m => finalCloseTxDigest.startsWith(m) || finalCloseTxDigest === m);

  const pnlSourceField = confirmedKeeperClose
    ? "keeper_verified"
    : (onChainSuccess && finalDigestIsReal)
      ? "onchain_verified"
      : "estimated";

  await storage.updatePosition(pos.id, {
    status: "closed",
    markPrice: currentPrice,
    unrealizedPnl: realizedPnl,
    closedAt: new Date(),
    closeTxDigest: finalCloseTxDigest,
    closeReason: finalCloseReason,
    verified: onChainSuccess || confirmedKeeperClose || positionAlreadySettled ? true : undefined,
    returnedSui: confirmedKeeperClose && keeperCloseReturnedSui !== null
      ? keeperCloseReturnedSui
      : (onChainSuccess ? Math.max(0, collateral + realizedPnl) : undefined),
    pnlSource: pnlSourceField,
  });

  try {
    const portfolioCache = (globalThis as any).__onChainPortfolioCache;
    if (portfolioCache) portfolioCache.delete(agent.id);
  } catch {}

  const isWin = realizedPnl > 0;
  // Re-fetch positions AFTER updating current one to avoid race conditions with simultaneous closes
  let newWinRate: number;
  try {
    const freshForWinRate = await storage.getPositions(agent.id);
    const closedForWinRate = freshForWinRate.filter(p => p.status === "closed");
    const wins = closedForWinRate.filter(p => (p.unrealizedPnl || 0) > 0).length;
    newWinRate = closedForWinRate.length > 0 ? wins / closedForWinRate.length : 0;
  } catch {
    const totalClosed = closedPositions.length;
    const totalWins = closedPositions.filter(p => {
      const pnl = p.id === pos.id ? realizedPnl : (p.unrealizedPnl || 0);
      return pnl > 0;
    }).length;
    newWinRate = totalClosed > 0 ? totalWins / totalClosed : 0;
  }

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
  } else if (confirmedKeeperClose && agent.walletAddress) {
    try {
      const { getOnChainBalance: getKeeperOnChain } = await import("../sui-verify");
      const keeperOnChain = await getKeeperOnChain(agent.walletAddress);
      const keeperPositions = await storage.getPositions(agent.id);
      const keeperOpen = keeperPositions.filter(p => p.id !== pos.id && (p.status === "open" || p.status === "pending_open"));
      const keeperLocked = keeperOpen.reduce((sum, p) => sum + (p.collateral || p.sizeSui / agent.leverage), 0);
      const keeperTotal = keeperOnChain.sui + keeperLocked;
      if (Math.abs(keeperTotal - finalBalance) > 0.05) {
        console.log(`[KeeperVerify] Balance correction for ${agent.name}: formula=${finalBalance.toFixed(4)} → on-chain-derived=${keeperTotal.toFixed(4)} (wallet=${keeperOnChain.sui.toFixed(4)}, locked=${keeperLocked.toFixed(4)})`);
        finalBalance = keeperTotal;
      } else {
        console.log(`[KeeperVerify] Keeper close verified for ${agent.name}: wallet=${keeperOnChain.sui.toFixed(4)}, locked=${keeperLocked.toFixed(4)}, total=${keeperTotal.toFixed(4)} SUI`);
      }
    } catch (keeperVerifyErr: any) {
      console.log(`[KeeperVerify] Verification failed for ${agent.name}: ${keeperVerifyErr.message?.slice(0, 60)}`);
    }
  }

  // Rewards require EITHER:
  // (a) A real on-chain TX digest (our own close TX — agent submitted it),
  // (b) A confirmed keeper fill (Typus filled a TP/SL order on-chain), OR
  // (c) on-chain settlement confirmed by balance-change analysis (onChainSuccess=true) AND
  //     NOT classified as a liquidation (positionAlreadySettled=false).
  //     The anti-false-reward balance guard (netBalanceChange check above) is the economic
  //     protection — if fees exceeded the price gain, realizedPnl was already set negative.
  //     Requiring finalDigestIsReal here is too strict: keeper TPs often settle via synthetic
  //     "settled_onchain" markers when the exact keeper TX wasn't found in the scan window,
  //     but the balance-change proof is sufficient confirmation.
  const rewardEligible = (onChainSuccess && finalDigestIsReal) || confirmedKeeperClose ||
    (onChainSuccess && !positionAlreadySettled);
  if (rewardAmount > 0 && agent.agentWallet && agent.walletAddress && rewardEligible) {
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
          await storage.updateReward(reward.id, { escrowTxDigest: "pending_escrow" });
          console.log(`[Rewards] RECORDED ${rewardAmount.toFixed(4)} SUI reward for ${agent.name} pos ${pos.id} (${rewardSharePct}% of ${realizedPnl.toFixed(4)} profit) — escrowing to reward wallet immediately`);
          try {
            const { escrowRewardFromAgent, getOrCreateUserRewardWallet } = await import("../reward-wallet");
            let userRwAddr: string | undefined;
            try {
              const ownerUser = await storage.getUser(agent.userId);
              if (ownerUser?.walletAddress) {
                const uw = await getOrCreateUserRewardWallet(ownerUser.walletAddress);
                userRwAddr = uw.address;
              }
            } catch {}
            const escrowResult = await escrowRewardFromAgent(agent.agentWallet!, agent.walletAddress!, rewardAmount, userRwAddr);
            await storage.updateReward(reward.id, { escrowTxDigest: escrowResult.txDigest });
            console.log(`[Rewards] Escrowed ${rewardAmount.toFixed(4)} SUI for ${agent.name} pos ${pos.id} → ${userRwAddr ? "personal" : "global"} reward wallet (tx: ${escrowResult.txDigest})`);
          } catch (escrowErr: any) {
            console.log(`[Rewards] Escrow failed for ${agent.name} pos ${pos.id}: ${escrowErr.message} — pending_escrow retained, will flush before next open`);
          }
        }
      } catch (retainErr: any) {
        console.log(`[Rewards] Failed to record reward for ${agent.name}: ${retainErr.message}`);
        try {
          const { reward, alreadyExisted } = await storage.createRewardIdempotent({
            agentId: agent.id,
            userId: agent.userId,
            amount: rewardAmount,
            agentName: agent.name,
            positionId: pos.id,
          });
          if (!alreadyExisted) {
            await storage.updateReward(reward.id, { escrowTxDigest: "pending_escrow" });
            try {
              const { escrowRewardFromAgent, getOrCreateUserRewardWallet } = await import("../reward-wallet");
              let userRwAddr2: string | undefined;
              try {
                const ownerUser2 = await storage.getUser(agent.userId);
                if (ownerUser2?.walletAddress) {
                  const uw2 = await getOrCreateUserRewardWallet(ownerUser2.walletAddress);
                  userRwAddr2 = uw2.address;
                }
              } catch {}
              const escrowResult = await escrowRewardFromAgent(agent.agentWallet!, agent.walletAddress!, rewardAmount, userRwAddr2);
              await storage.updateReward(reward.id, { escrowTxDigest: escrowResult.txDigest });
              console.log(`[Rewards] Retry-escrowed ${rewardAmount.toFixed(4)} SUI for ${agent.name} → ${userRwAddr2 ? "personal" : "global"} reward wallet (tx: ${escrowResult.txDigest})`);
            } catch (escErr: any) {
              console.log(`[Rewards] Retry-escrow failed for ${agent.name}: ${escErr.message} — pending_escrow retained`);
            }
          }
        } catch (recordErr: any) {
          console.log(`[Rewards] Failed to create reward record: ${recordErr.message}`);
        }
      } finally {
        rewardCreationInProgress.delete(pos.id);
      }
    }
  } else if (rewardAmount > 0 && !rewardEligible) {
    console.log(`[Rewards] SKIPPING reward for ${agent.name} pos ${pos.id} — close not confirmed on-chain (onChainSuccess=${onChainSuccess}, settled=${positionAlreadySettled}, finalDigestIsReal=${finalDigestIsReal}, confirmedKeeperClose=${confirmedKeeperClose})`);
  }

  // Savings wallet split — transfers a portion of profit to the agent's savings wallet
  // Same guard as rewards: only split on real verified closes, not synthetic markers.
  if (realizedPnl > 0 && agent.savingsWalletAddress && agent.agentWallet && agent.walletAddress && rewardEligible) {
    const savingsSplitPct = agent.savingsSplitPct ?? 10;
    const MIN_SAVINGS_TRANSFER = 0.01; // skip gas-inefficient tiny transfers (lowered for small-profit trades)
    const savingsAmount = realizedPnl * (savingsSplitPct / 100);
    if (savingsSplitPct > 0 && savingsAmount >= MIN_SAVINGS_TRANSFER) {
      let remainingLockedForSavings = 0;
      try {
        const allAgentPosSav = await storage.getPositions(agent.id);
        remainingLockedForSavings = allAgentPosSav
          .filter((p: any) => p.status === "open" && p.id !== pos.id)
          .reduce((s: number, p: any) => s + (p.collateral || p.sizeSui / agent.leverage), 0);
      } catch {}
      const estimatedPostSavingsFreeSui = finalBalance - remainingLockedForSavings - rewardAmount - savingsAmount;
      const minSavingsThreshold = Math.max(LOW_BALANCE_REWARD_SKIP_THRESHOLD, (agent.minCollateral ?? 5) + COLLATERAL_GAS_RESERVE_SUI);
      if (estimatedPostSavingsFreeSui >= minSavingsThreshold) {
        // Record transfer job BEFORE initiating, so In Transit bucket is populated immediately
        let transferJobId: string | undefined;
        try {
          const job = await storage.createTransferJob({
            agentId: agent.id,
            transferType: "SAVINGS_SPLIT",
            amountSui: savingsAmount,
            fromAddress: agent.walletAddress!,
            toAddress: agent.savingsWalletAddress!,
            status: "CREATED",
          });
          transferJobId = job.id;
          // Record in-transit debit immediately when job is created
          recordFundFlow({
            agentId: agent.id,
            eventType: "IN_TRANSIT_OUT",
            amount: savingsAmount,
            direction: "debit",
            positionId: pos.id,
            sourceSystem: "execution-engine",
            notes: `savings_split ${savingsSplitPct}% of ${realizedPnl.toFixed(4)} SUI profit`,
          }).catch(() => {});
        } catch { /* non-fatal */ }

        setImmediate(async () => {
          try {
            const { transferToSavingsWallet } = await import("../reward-wallet");
            const txResult = await transferToSavingsWallet(agent.agentWallet!, agent.walletAddress!, agent.savingsWalletAddress!, savingsAmount);
            console.log(`[Savings] ${savingsAmount.toFixed(4)} SUI (${savingsSplitPct}% of ${realizedPnl.toFixed(4)} profit) → savings wallet for ${agent.name}`);
            // Mark as SUBMITTED now that tx was sent; reconciliation happens on next balance sync
            const txDigest = (txResult as any)?.digest ?? undefined;
            if (transferJobId) {
              await storage.updateTransferJob(transferJobId, { status: "SUBMITTED", txHash: txDigest });
            }
            // Record credit in savings wallet
            recordFundFlow({
              agentId: agent.id,
              eventType: "AGENT_SAVINGS_TRANSFER",
              amount: savingsAmount,
              direction: "credit",
              positionId: pos.id,
              txHash: txDigest,
              sourceSystem: "execution-engine",
              notes: `savings wallet confirmed: ${agent.savingsWalletAddress}`,
            }).catch(() => {});
          } catch (savErr: any) {
            console.log(`[Savings] Transfer failed for ${agent.name}: ${savErr.message}`);
            if (transferJobId) {
              await storage.updateTransferJob(transferJobId, { status: "FAILED" });
            }
          }
        });
      } else {
        console.log(`[Savings] DEFERRING savings for ${agent.name}: freeSui after savings ~${estimatedPostSavingsFreeSui.toFixed(4)} < threshold`);
      }
    }
  }

  const pnlDelta = (onChainSuccess || positionAlreadySettled) ? realizedPnl : 0;

  // SETTLEMENT ACCOUNTING SUMMARY — authoritative log for every close event
  {
    const netReturn = collateral + Math.max(-collateral, realizedPnl);
    const settled = onChainSuccess || positionAlreadySettled;
    console.log(
      `[Settlement] ${agent.name} pos ${pos.id} | ` +
      `side=${pos.side} leverage=${agent.leverage}x | ` +
      `collateral=${collateral.toFixed(4)} | ` +
      `pnl=${realizedPnl.toFixed(4)} (${pnlSourceField}) | ` +
      `netReturn=${netReturn.toFixed(4)} SUI | ` +
      `walletBefore=${currentBalance.toFixed(4)} → walletAfter=${finalBalance.toFixed(4)} | ` +
      `settlementPending=${settlementPending} | ` +
      `settled=${settled}`
    );
  }

  // Record position settlement in fund flow ledger and position journal
  if (onChainSuccess || positionAlreadySettled) {
    const posCollateral = pos.collateral || pos.sizeSui / agent.leverage;
    const collateralReturned = posCollateral + Math.max(-posCollateral, realizedPnl);
    settlePositionJournal(
      pos.id,
      agent.id,
      realizedPnl,
      collateralReturned,
      pos.closeTxDigest || undefined,
    ).catch(() => {});
  }

  if (realizedPnl > 0 && (!positionAlreadySettled || confirmedKeeperClose)) {
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

  // Hard accounting invariant: balance must never go negative
  if (finalBalance < -0.01) {
    console.error(`[Settlement] INVARIANT VIOLATION: ${agent.name} balance=${finalBalance.toFixed(4)} SUI after close of pos ${pos.id}. currentBalance=${currentBalance.toFixed(4)}, pnl=${realizedPnl.toFixed(4)}, collateral=${collateral.toFixed(4)}. Clamping to 0.`);
    await storage.updateAgent(agent.id, { balance: 0 });
  }

  // Accounting audit trail: deposited vs current economic value
  if ((agent.totalDeposited ?? 0) > 0) {
    const totalPnlAfter = (freshAgent?.totalPnl ?? agent.totalPnl ?? 0) + pnlDelta;
    const impliedLoss = (agent.totalDeposited ?? 0) - finalBalance;
    console.log(`[Settlement] ${agent.name} ledger: deposited=${(agent.totalDeposited ?? 0).toFixed(4)} | newBalance=${finalBalance.toFixed(4)} | totalPnl=${totalPnlAfter.toFixed(4)} | cumulativeLoss=${impliedLoss.toFixed(4)}`);
  }

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
  lastCloseMap.set(agent.id, Date.now());
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

  console.log(`[CLOSE_POSITION_SUCCESS] agent=${agent.name} pos=${pos.id.slice(0, 8)} onChainId=${pos.onChainPositionId} side=${pos.side} pnl=${realizedPnl.toFixed(4)} verified=${onChainSuccess && finalDigestIsReal} digest=${closeTxDigest?.slice(0, 16) ?? "synthetic"}`);
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

  // Pre-mark ALL positions in the close-in-progress map so the TP/SL position monitor
  // (checkAndClosePositions, running every ~5s) skips them during the sequential close-all
  // loop. Without this, the monitor fires during the loop and marks all remaining positions
  // as "close_tx_submitted" simultaneously, causing coin fragmentation and UI chaos.
  for (const pos of openPositions) {
    positionCloseInProgress.set(pos.id, Date.now());
  }
  console.log(`[Execution] closeAll for ${agent.name}: pre-locked ${openPositions.length} position(s) in close-in-progress map. Processing sequentially.`);

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
      let walletBalanceSui: number | null = getCachedWalletBalance(walletAddr);
      if (walletBalanceSui === null) {
        const balResp = await suiClient.getBalance({ owner: walletAddr, coinType: "0x2::sui::SUI" });
        walletBalanceSui = Number(balResp.totalBalance) / 1e9;
        setCachedWalletBalance(walletAddr, walletBalanceSui);
      }
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

  // ── Dynamic SL/TP — fetch personality from capital plan ──────────────────
  let _dynamicSlTp: DynamicSlTp | null = null;
  try {
    const _capitalPlanForSlTp = await getCapitalPlan(agentConfig.id, agentConfig.balance || 0, openPositions.length);
    _dynamicSlTp = _capitalPlanForSlTp.dynamicSlTp;
  } catch {}

  // Hard limits — always close (never let the position exceed these)
  // Soft thresholds — close early when market conditions confirm the move
  const slHardBps = _dynamicSlTp?.slHardBps ?? (agentConfig.stopLossBps || 50);
  const slSoftBps = _dynamicSlTp?.slSoftBps ?? Math.round(slHardBps * 0.60);
  const tpHardBps = _dynamicSlTp?.tpHardBps ?? (agentConfig.takeProfitBps || 100);
  const tpSoftBps = _dynamicSlTp?.tpSoftBps ?? Math.round(tpHardBps * 0.65);
  const earlyCloseAggression = _dynamicSlTp?.earlyCloseAggression ?? 0.55;

  const slThreshold = slHardBps / 100;
  const slSoftThreshold = slSoftBps / 100;
  const tpSoftThreshold = tpSoftBps / 100;
  let tpThreshold: number | null = tpHardBps / 100;

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

  // Strong trend (ADX > 25) with volatile market — extend hard TP to let winners run
  if (liveAdx > 25 && liveAtrPct > 0.15) {
    const extensionFactor = liveAdx > 30 ? 1.30 : 1.20;
    tpThreshold = Math.min(tpHardBps / 100, (tpThreshold ?? tpHardBps / 100) * extensionFactor);
  }

  let effectiveSLThreshold = slThreshold;

  // High volatility — tighten SL toward soft limit
  if (liveAtrPct > 0.05) {
    const atrBasedSL = liveAtrPct * 1.2;
    if (atrBasedSL < effectiveSLThreshold) {
      effectiveSLThreshold = atrBasedSL;
    }
  }

  const maxSLFromCollateral = MAX_COLLATERAL_LOSS_PCT / leverageMultiplier;
  if (effectiveSLThreshold > maxSLFromCollateral) {
    effectiveSLThreshold = maxSLFromCollateral;
    console.log(`[TP/SL] SL capped for ${agentConfig.name}: ${slHardBps}bps → effective=${effectiveSLThreshold.toFixed(3)}% (max ${MAX_COLLATERAL_LOSS_PCT}% collateral loss at ${leverageMultiplier}x)`);
  }

  const liquidationMovePct = (1 / leverageMultiplier) * 100;
  const maxSafeSLPct = liquidationMovePct * 0.60;
  if (effectiveSLThreshold > maxSafeSLPct) {
    console.log(`[TP/SL] Leverage-aware SL cap for ${agentConfig.name}: ${effectiveSLThreshold.toFixed(3)}% exceeds 60% of liquidation distance → capped to ${maxSafeSLPct.toFixed(3)}%`);
    effectiveSLThreshold = maxSafeSLPct;
  }

  const currentTritonSignal = getLastTritonSignal();
  const signalMode = currentTritonSignal?.activeMode ?? "PRECISION";
  const signalProfile = MODE_PROFILES[signalMode];

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
      tracker = { peakPnlPct: pnlPercent, breakEvenLocked: false, trailingSLPct: effectiveSLThreshold, lastPnlPct: pnlPercent, consecutiveDeclineTicks: 0 };
      peakPnlTracker.set(pos.id, tracker);
    }

    // T2: ADVERSE MOVEMENT TRACKING
    // If a position has been adverse (PnL < 0) for >30s and loss is increasing,
    // we should trigger an early close.
    let shouldEarlyCloseAdverse = false;
    let earlyCloseAdverseReason = "";
    if (pnlPercent < -0.05 && pos.openedAt) {
      const posAgeMs = Date.now() - new Date(pos.openedAt).getTime();
      if (posAgeMs > 30000) { // >30s
        const declineTicks = tracker.consecutiveDeclineTicks ?? 0;
        if (declineTicks >= 3 && collateralLossPct >= 30) {
          shouldEarlyCloseAdverse = true;
          earlyCloseAdverseReason = `adverse-trend(${declineTicks}ticks,loss=${collateralLossPct.toFixed(1)}%)`;
        }
      }
    }

    if (pnlPercent > tracker.peakPnlPct) {
      tracker.peakPnlPct = pnlPercent;
    }

    // Decay detection: count consecutive 5s ticks where profit is falling
    if (pnlPercent > 0 && tracker.lastPnlPct !== undefined) {
      if (pnlPercent < tracker.lastPnlPct - PROFIT_DECAY_MIN_DROP_PCT) {
        tracker.consecutiveDeclineTicks++;
      } else {
        tracker.consecutiveDeclineTicks = 0;
      }
    }
    tracker.lastPnlPct = pnlPercent;

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

    // ── Soft-zone early close ─────────────────────────────────────────────────
    // Agent closes before hard limits when market conditions confirm the move.
    // This is the core of the dynamic SL/TP behavior.
    const posAgeForSoft = pos.openedAt ? Date.now() - new Date(pos.openedAt).getTime() : 0;
    const posAgeMinForSoft = posAgeForSoft / 60000;
    const isOpposingSignal = currentTritonSignal && currentTritonSignal.side !== "NONE" &&
      (pos.side === "long" ? currentTritonSignal.side === "SHORT" : currentTritonSignal.side === "LONG") &&
      Date.now() <= currentTritonSignal.validUntilMs;
    const signalScore = currentTritonSignal?.score ?? 0;

    let shouldSoftTP = false;
    let softTPReason = "";
    if (!shouldTakeProfit && pnlPercent >= tpSoftThreshold) {
      const declineTicks = tracker?.consecutiveDeclineTicks ?? 0;
      const profitDecaying = declineTicks >= 2;
      const strongOpposingSignal = isOpposingSignal && signalScore >= 60;
      // highAggression at 0.65 so agents configured at 70%+ use the aggressive capture paths
      const highAggression = earlyCloseAggression >= 0.65;
      const moderateAggression = earlyCloseAggression >= 0.55;
      // Position only needs to be 8+ min old to qualify for age-based early close
      const agedPosition = posAgeMinForSoft >= 8;
      // Profit is actively climbing if it's risen >0.03% since the last 5s tick
      const pnlActivelyRising = tracker?.lastPnlPct !== undefined && pnlPercent > (tracker.lastPnlPct ?? 0) + 0.03;

      if (profitDecaying && (highAggression || pnlPercent >= tpSoftThreshold * 1.10)) {
        // Profit has started reversing — capture it now
        shouldSoftTP = true;
        softTPReason = `soft-tp-decay(${declineTicks}ticks,pnl=${pnlPercent.toFixed(3)}%)`;
      } else if (strongOpposingSignal && moderateAggression) {
        // Market is signaling a direction against this position — exit with profit intact
        shouldSoftTP = true;
        softTPReason = `soft-tp-signal(${currentTritonSignal!.side},score=${signalScore},pnl=${pnlPercent.toFixed(3)}%)`;
      } else if (agedPosition && moderateAggression) {
        // Position has been held long enough — don't risk giving back gains
        shouldSoftTP = true;
        softTPReason = `soft-tp-aged(${posAgeMinForSoft.toFixed(0)}min,pnl=${pnlPercent.toFixed(3)}%)`;
      } else if (highAggression && pnlPercent >= tpSoftThreshold * 1.03) {
        // High-aggression agents take profit as soon as we're clearly into the soft zone
        shouldSoftTP = true;
        softTPReason = `soft-tp-aggressive(pnl=${pnlPercent.toFixed(3)}%,agg=${earlyCloseAggression.toFixed(2)})`;
      } else if (moderateAggression && !pnlActivelyRising) {
        // Profit in soft zone and not actively climbing — lock in the gain rather than
        // risk giving it back waiting for the hard TP threshold
        shouldSoftTP = true;
        softTPReason = `soft-tp-capture(pnl=${pnlPercent.toFixed(3)}%,agg=${earlyCloseAggression.toFixed(2)},rising=${pnlActivelyRising})`;
      }
      if (shouldSoftTP) {
        console.log(`[SoftTP] ${agentConfig.name} pos ${pos.id}: early TP at ${pnlPercent.toFixed(3)}% (soft=${tpSoftThreshold.toFixed(3)}% hard=${(tpThreshold ?? tpHardBps/100).toFixed(3)}%) — ${softTPReason}`);
      }
    }

    let shouldSoftSL = false;
    let softSLReason = "";
    if (!shouldStopLoss && !shouldTrailingStop && pnlPercent <= -slSoftThreshold) {
      const declineTicks = tracker?.consecutiveDeclineTicks ?? 0;
      const strongOpposingSignal = isOpposingSignal && signalScore >= 70;
      const highAggression = earlyCloseAggression >= 0.70;
      const extremeAggression = earlyCloseAggression >= 0.80;

      if (strongOpposingSignal) {
        shouldSoftSL = true;
        softSLReason = `soft-sl-signal(${currentTritonSignal!.side},score=${signalScore},pnl=${pnlPercent.toFixed(3)}%)`;
      } else if (highAggression && declineTicks >= 3) {
        shouldSoftSL = true;
        softSLReason = `soft-sl-decay(${declineTicks}ticks,pnl=${pnlPercent.toFixed(3)}%)`;
      } else if (extremeAggression && posAgeMinForSoft >= 5 && pnlPercent <= -(slSoftThreshold * 1.10)) {
        shouldSoftSL = true;
        softSLReason = `soft-sl-aged(${posAgeMinForSoft.toFixed(0)}min,pnl=${pnlPercent.toFixed(3)}%)`;
      }
      if (shouldSoftSL) {
        console.log(`[SoftSL] ${agentConfig.name} pos ${pos.id}: early SL at ${pnlPercent.toFixed(3)}% (soft=${slSoftThreshold.toFixed(3)}% hard=${posEffectiveSL.toFixed(3)}%) — ${softSLReason}`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (shouldStopLoss || shouldSoftSL || shouldTrailingStop || shouldTakeProfit || shouldSoftTP || maxCollateralBreached || emergencyClose || shouldEarlyCloseAdverse) {
      let reason: string;
      let priority: number;
      if (emergencyClose) {
        reason = "emergency-liquidation-prevent";
        priority = 0;
      } else if (maxCollateralBreached && !shouldStopLoss) {
        reason = "max-collateral-loss";
        priority = 1;
      } else if (shouldEarlyCloseAdverse) {
        reason = `early-close-adverse:${earlyCloseAdverseReason}`;
        priority = 2;
      } else if (shouldStopLoss) {
        reason = "stop-loss";
        priority = 2;
      } else if (shouldSoftSL) {
        // Soft SL — early cut confirmed by signal or decay
        reason = `soft-stop-loss:${softSLReason}`;
        priority = 2;
      } else if (shouldTrailingStop) {
        reason = "trailing-stop";
        priority = 2;
      } else if (shouldSoftTP) {
        // Soft TP — early profit capture confirmed by conditions
        // Priority depends on what triggered it: decay = higher urgency, aging = normal
        const isDecayTrigger = softTPReason.startsWith("soft-tp-decay") || softTPReason.startsWith("soft-tp-signal");
        reason = `soft-take-profit:${softTPReason}`;
        priority = isDecayTrigger ? 2 : 3;
      } else {
        // === PRIORITY ENGINE: TP escalation ===
        // At 36x leverage, a 1% market move = 36% collateral change.
        // Profitable positions that are large, old, or actively decaying need
        // the same urgency as stop-losses to prevent giving back gains.
        const posAgeMs2 = pos.openedAt ? Date.now() - new Date(pos.openedAt).getTime() : 0;
        const isProfitDecaying = (tracker?.consecutiveDeclineTicks ?? 0) >= PROFIT_DECAY_URGENCY_TICKS;
        const isLargeProfit = pnlPercent >= PROFIT_LARGE_THRESHOLD_PCT;
        const isOldAndProfitable = pnlPercent >= PROFIT_LOCK_MIN_PCT && posAgeMs2 >= PROFIT_LOCK_MIN_AGE_MS;

        if (isLargeProfit && isProfitDecaying) {
          reason = "take-profit-urgent";
          priority = 1;
          console.log(`[PriorityEngine] ${agentConfig.name} pos ${pos.id}: TP URGENT (priority 1) — large profit ${pnlPercent.toFixed(3)}% decaying ${tracker?.consecutiveDeclineTicks} ticks`);
        } else if (isOldAndProfitable || (isLargeProfit && !isProfitDecaying)) {
          reason = "take-profit-protect";
          priority = 2;
          console.log(`[PriorityEngine] ${agentConfig.name} pos ${pos.id}: TP PROTECT (priority 2) — ${pnlPercent.toFixed(3)}% profit, ${Math.round(posAgeMs2 / 60000)}m old`);
        } else {
          reason = "take-profit";
          priority = 3;
        }
      }

      const posCollateral = pos.collateral || (pos.sizeSui / leverageMultiplier);
      const absoluteLoss = pnlPercent < 0 ? Math.abs(pnlPercent) * posCollateral / 100 : 0;
      const posAgeMs = pos.openedAt ? Date.now() - new Date(pos.openedAt).getTime() : 0;
      const ageMinutes = posAgeMs / 60000;
      const liqDistPct = liquidationPricePct - collateralLossPct;
      let riskScore = collateralLossPct * 10 + absoluteLoss * 5;
      if (liqDistPct < 30) riskScore += (30 - liqDistPct) * 3;
      if (pnlPercent < 0 && ageMinutes > 5) riskScore += ageMinutes * 2;
      // Enhanced riskScore for TP and soft-zone closes
      if (reason.startsWith("take-profit") || reason.startsWith("soft-take-profit")) {
        const decayBonus = (tracker?.consecutiveDeclineTicks ?? 0) * 50;
        riskScore = Math.abs(pnlPercent) * 100 + (ageMinutes > 20 ? ageMinutes * 5 : 0) + decayBonus;
      } else if (reason.startsWith("soft-stop-loss")) {
        riskScore = collateralLossPct * 10 + absoluteLoss * 5 + (signalScore >= 70 ? 50 : 20);
      }

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

      let dynamicEarlyClose = false;
      let dynamicCloseReason = "";

      const posAny = pos as any;
      if (currentTritonSignal && currentTritonSignal.side !== "NONE" && Date.now() <= currentTritonSignal.validUntilMs) {
        const signalSide = currentTritonSignal.side;
        const isOpposing = (pos.side === "long" && signalSide === "SHORT") || (pos.side === "short" && signalSide === "LONG");

        if (isOpposing) {
          const isStrongSignal = currentTritonSignal.score >= Math.round(signalProfile.threshold * 1.4);
          const posAgeMs = pos.openedAt ? Date.now() - new Date(pos.openedAt).getTime() : 0;
          const MIN_HOLD_MS = 3 * 60 * 1000;

          if (isStrongSignal && pnlPercent >= 0.5 && posAgeMs >= MIN_HOLD_MS) {
            dynamicEarlyClose = true;
            dynamicCloseReason = "signal-tp";
            console.log(`[SignalTP] ${agentConfig.name} pos ${pos.id}: early TP — strong opposing ${signalSide} signal (score=${currentTritonSignal.score}) | pnl=${pnlPercent.toFixed(3)}% (age=${Math.round(posAgeMs/60000)}min)`);
          } else if (isStrongSignal && pnlPercent < 0 && pnlPercent <= -(effectiveSLThreshold * 0.50)) {
            dynamicEarlyClose = true;
            dynamicCloseReason = "signal-sl";
            console.log(`[SignalSL] ${agentConfig.name} pos ${pos.id}: early SL cut — strong opposing ${signalSide} signal (score=${currentTritonSignal.score}) | pnl=${pnlPercent.toFixed(3)}% (${(effectiveSLThreshold * 0.50).toFixed(3)}% trigger)`);
          }
        }
      }

      if (!dynamicEarlyClose && posAny.regime) {
        try {
          const regimeSide = pos.side === "long" ? "long" : "short";
          const feedback = await getEntryFeedback(posAny.regime, regimeSide, 0);
          if (feedback.scorePenalty >= 15 && pnlPercent > 0 && tpThreshold !== null && pnlPercent >= tpThreshold * 0.55) {
            dynamicEarlyClose = true;
            dynamicCloseReason = "learning-tp";
            console.log(`[LearningTP] ${agentConfig.name} pos ${pos.id}: early TP — regime ${posAny.regime}/${regimeSide} is underperforming (penalty=${feedback.scorePenalty}) | pnl=${pnlPercent.toFixed(3)}% (${(tpThreshold * 0.55).toFixed(2)}% floor)`);
          } else if (feedback.scorePenalty >= 15 && pnlPercent < 0 && pnlPercent <= -(effectiveSLThreshold * 0.65)) {
            dynamicEarlyClose = true;
            dynamicCloseReason = "learning-sl";
            console.log(`[LearningSL] ${agentConfig.name} pos ${pos.id}: early SL — regime ${posAny.regime}/${regimeSide} underperforming (penalty=${feedback.scorePenalty}) | pnl=${pnlPercent.toFixed(3)}%`);
          }
        } catch {}
      }

      if (dynamicEarlyClose) {
        // Apply priority escalation to signal/learning TPs too
        const dynAgeMs = pos.openedAt ? Date.now() - new Date(pos.openedAt).getTime() : 0;
        const dynIsOldProfit = pnlPercent >= PROFIT_LOCK_MIN_PCT && dynAgeMs >= PROFIT_LOCK_MIN_AGE_MS;
        const dynIsLarge = pnlPercent >= PROFIT_LARGE_THRESHOLD_PCT;
        const dynDecaying = (tracker?.consecutiveDeclineTicks ?? 0) >= PROFIT_DECAY_URGENCY_TICKS;
        let dynPriority = 3;
        if (dynIsLarge && dynDecaying) dynPriority = 1;
        else if (dynIsOldProfit || dynIsLarge) dynPriority = 2;
        const dynAgeMin = dynAgeMs / 60000;
        const dynDecayBonus = (tracker?.consecutiveDeclineTicks ?? 0) * 50;
        const dynRiskScore = pnlPercent > 0
          ? Math.abs(pnlPercent) * 100 + (dynAgeMin > 20 ? dynAgeMin * 5 : 0) + dynDecayBonus
          : collateralLossPct * 10 + Math.abs(rawUnrealizedPnl) * 5;
        positionsToClose.push({ pos, reason: dynamicCloseReason, pnlPercent, collateralLossPct, priority: dynPriority, riskScore: dynRiskScore });
        peakPnlTracker.delete(pos.id);
      } else {
        positionsToUpdate.push({ pos, unrealizedPnl: Math.min(maxGainUpdate, Math.max(-posCollateral, rawUnrealizedPnl)) });
      }
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
      const cachedLimitBal = getCachedWalletBalance(addrLimit);
      if (cachedLimitBal !== null) {
        walletBalForLimit = cachedLimitBal;
      } else {
        const balRespLimit = await suiClient.getBalance({ owner: addrLimit, coinType: "0x2::sui::SUI" });
        walletBalForLimit = Number(balRespLimit.totalBalance) / 1e9;
        setCachedWalletBalance(addrLimit, walletBalForLimit);
      }
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
  positionsToClose = positionsToClose.filter(({ pos, priority, reason }) => {
    const isEmergencyPriority = priority <= 1;
    if (isEmergencyPriority) return true;
    // PROFIT PRIORITY: TP-triggered closes always pass through backoff.
    // Once a position has hit the take-profit threshold, realized gains are the
    // top priority. Backoff only guards against spam — not against legitimate TP.
    const isTpReason = reason.startsWith("take-profit") || reason.startsWith("soft-take-profit") || reason === "signal-tp" || reason === "learning-tp";
    if (isTpReason) return true;
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

  // Limit to 1 close per tick to avoid wallet coin fragmentation and nonce conflicts.
  // Exception: when multiple positions have hit TP (profit realization priority), allow
  // up to 2 per tick so that profitable positions aren't deferred an extra 5 seconds
  // while price could reverse. The oldest same-side position closes first per CLOSE_OLDEST_FIRST.
  const tpCount = positionsToClose.filter(({ reason }) =>
    reason.startsWith("take-profit") || reason.startsWith("soft-take-profit")
  ).length;
  let maxCloseThisTick = (tpCount >= 2 && !isLowGas) ? Math.min(tpCount, 2) : 1;
  if (isLowGas && positionsToClose.length > 1) {
    maxCloseThisTick = 1;
    console.log(`[TP/SL] ${agentConfig.name}: LOW GAS (${walletBalForLimit.toFixed(4)} SUI) — 1 close this tick (highest priority: ${positionsToClose[0].reason}). ${positionsToClose.length - 1} deferred.`);
  } else if (positionsToClose.length > 1) {
    console.log(`[TP/SL] ${agentConfig.name}: ${positionsToClose.length} positions need closing — ${maxCloseThisTick} per tick, highest priority first (${positionsToClose[0].reason}). ${Math.max(0, positionsToClose.length - maxCloseThisTick)} deferred. Order: ${positionsToClose.map(p => `${p.pos.id.slice(0, 8)}(${p.reason},P${p.priority},risk=${p.riskScore.toFixed(1)})`).join(", ")}`);
  }

  let closesAttempted = 0;
  for (const { pos, reason, pnlPercent, collateralLossPct, priority } of positionsToClose) {
    if (closesAttempted >= maxCloseThisTick) break;
    const isEmergencyPriority = priority <= 1;
    const closeStartedAt = positionCloseInProgress.get(pos.id);
    if (closeStartedAt) {
      const elapsed = Date.now() - closeStartedAt;
      if (isEmergencyPriority) {
        // Before forcing lock re-entry, check DB: if the close already confirmed the position
        // as settled (fast-close path), overriding here would submit a redundant TX and
        // overwrite closeState=closed with close_tx_submitted.
        let alreadySettling = false;
        try {
          const dbPos = await storage.getPosition(pos.id);
          if (dbPos && ((dbPos as any).closeState === "closed" || (dbPos as any).closeTxDigest === "settled_onchain" || (dbPos as any).closeTxDigest === "position_gone_onchain")) {
            alreadySettling = true;
            console.log(`[TP/SL] EMERGENCY OVERRIDE suppressed: ${agentConfig.name} pos ${pos.id.slice(0, 8)} already settling (closeState=${(dbPos as any).closeState}, digest=${(dbPos as any).closeTxDigest}) — skipping re-entry`);
          }
        } catch {}
        if (alreadySettling) { continue; }
        console.log(`[TP/SL] EMERGENCY OVERRIDE: ${agentConfig.name} pos ${pos.id} close in-progress for ${Math.round(elapsed / 1000)}s — forcing re-entry for ${reason} (collateral loss ${collateralLossPct.toFixed(1)}%)`);
        positionCloseInProgress.delete(pos.id);
      } else if (elapsed > CLOSE_IN_PROGRESS_TIMEOUT_MS) {
        console.log(`[TP/SL] Close timeout: ${agentConfig.name} pos ${pos.id} in-progress for ${Math.round(elapsed / 1000)}s (>${CLOSE_IN_PROGRESS_TIMEOUT_MS / 1000}s) — allowing re-attempt for ${reason}`);
        positionCloseInProgress.delete(pos.id);
      } else {
        // For TP closes, the timeout is 8s instead of 15s — profit realization can't wait.
        const isTpForTimeout = reason.startsWith("take-profit") || reason.startsWith("soft-take-profit");
        if (isTpForTimeout && elapsed > 8_000) {
          console.log(`[TP/SL] TP fast-unlock: ${agentConfig.name} pos ${pos.id} in-progress for ${Math.round(elapsed / 1000)}s — releasing lock for TP re-attempt`);
          positionCloseInProgress.delete(pos.id);
        } else {
          continue;
        }
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
    const isTpClose = reason.startsWith("take-profit") || reason.startsWith("soft-take-profit") || reason === "signal-tp" || reason === "learning-tp";
    if (cooldownExpiry && Date.now() < cooldownExpiry && !isEmergencyPriority && !isTpClose) {
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
        if (result.txDigest && !result.txDigest.startsWith("sim_") && !result.txDigest.startsWith("settled") && !result.txDigest.startsWith("position_gone") && !result.txDigest.startsWith("liquidated") && !result.txDigest.startsWith("cancelled") && !result.txDigest.startsWith("keeper")) {
          trackSessionGasSpend(agent.id, GAS_PER_OPERATION_ESTIMATE);
        }

        for (let retry = 0; retry < effectiveMaxRetries - 1 && !result.closed; retry++) {
          const errStr = result.error || "";
          const isTerminalError = errStr.includes("close_pending") ||
            errStr.includes("CLOSE_PERMANENTLY_BLOCKED") ||
            errStr.includes("too_many_linked_orders") ||
            errStr.includes("CLOSE_GAS_CAP") ||
            errStr.includes("INSUFFICIENT_GAS") ||
            errStr.includes("already_closed") ||
            errStr.includes("position_already_settled") ||
            errStr.includes("manual_review");
          if (isTerminalError) {
            console.log(`[TP/SL] ${reason} for ${agentConfig.name} pos ${pos.id}: terminal error "${errStr.slice(0, 80)}" — stopping retries.`);
            break;
          }
          if (result.txDigest && (result.txDigest.startsWith("settled") || result.txDigest.startsWith("position_gone") || result.txDigest.startsWith("liquidated") || result.txDigest.startsWith("cancelled") || result.txDigest.startsWith("keeper"))) {
            console.log(`[TP/SL] ${reason} for ${agentConfig.name} pos ${pos.id}: position already settled (${result.txDigest}) — stopping retries.`);
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
            if (result.txDigest && !result.txDigest.startsWith("sim_") && !result.txDigest.startsWith("settled") && !result.txDigest.startsWith("position_gone") && !result.txDigest.startsWith("liquidated") && !result.txDigest.startsWith("cancelled") && !result.txDigest.startsWith("keeper")) {
              trackSessionGasSpend(agent.id, GAS_PER_OPERATION_ESTIMATE);
            }
            if (result.closed) break;
            continue;
          }
          const delay = RETRY_DELAYS_MS[retry] || 800;
          console.log(`[TP/SL] ${reason} attempt ${retry + 1} FAILED for ${agentConfig.name} pos ${pos.id} — retrying in ${delay}ms (${retry + 2}/${effectiveMaxRetries})...`);
          await new Promise(r => setTimeout(r, delay));

          const freshPrice = getLastPrice();
          const retryPrice = freshPrice?.blended || currentPrice;
          result = await closePositionForAgent(agentConfig, pos.id, retryPrice, false, reason);
          if (result.txDigest && !result.txDigest.startsWith("sim_") && !result.txDigest.startsWith("settled") && !result.txDigest.startsWith("position_gone") && !result.txDigest.startsWith("liquidated") && !result.txDigest.startsWith("cancelled") && !result.txDigest.startsWith("keeper")) {
            trackSessionGasSpend(agent.id, GAS_PER_OPERATION_ESTIMATE);
          }
        }

        persistSessionGasToDb(agent.id);
        if (agent.walletAddress) invalidateCachedWalletBalance(agent.walletAddress);
        if (result.txDigest && !result.txDigest.startsWith("settled") && !result.txDigest.startsWith("sim_") && !result.txDigest.startsWith("keeper") && !result.txDigest.startsWith("position_gone") && !result.txDigest.startsWith("liquidated") && !result.txDigest.startsWith("cancelled")) {
          trackActualGasFromTx(agent.id, result.txDigest).catch(() => {});
        }

        if (!result.closed) {
          const isCooldownError = result.error && (result.error.includes("too_many_linked_orders") || result.error.includes("close_pending"));
          const isRateLimit = result.error && result.error.includes("RATE_LIMITED");
          const isGasError = result.error && result.error.includes("INSUFFICIENT_GAS");
          // CLOSE_OLDEST_FIRST: target is not the oldest same-side position.
          // Typus would close the wrong one — defer without backoff until oldest is settled.
          const isMultiPosDefer = result.error && result.error.includes("CLOSE_OLDEST_FIRST");

          if (isCooldownError && result.error?.includes("close_pending")) {
            // The close order was successfully submitted and is waiting for Typus keeper to fill.
            // This is NOT a failure — don't apply backoff. Clear any existing backoff so the
            // next tick can re-check the position (DbPendingScan detects keeper fills every 6s).
            positionCloseBackoff.delete(pos.id);
            console.log(`[TP/SL] ${agentConfig.name} pos ${pos.id}: close order working (keeper pending) — no backoff. Will check fill status next tick.`);
          } else if (isMultiPosDefer) {
            // Clear any existing backoff so this position retries cleanly once oldest is closed.
            positionCloseBackoff.delete(pos.id);
            console.log(`[TP/SL] ${agentConfig.name} pos ${pos.id}: deferred (oldest same-side must close first) — no backoff applied, will retry next cycle.`);

            // MULTI-POS-UNBLOCK: Proactively close the blocking oldest position so the deferred
            // position doesn't have to wait indefinitely. Without this, if the oldest position
            // hasn't hit its own TP/SL thresholds, it will never self-initiate a close, causing
            // a permanent deadlock where the newer position accumulates losses but can't close.
            (async () => {
              try {
                const allOpenForUnblock = await storage.getPositions(agentConfig.id);
                const sameSideBlockers = allOpenForUnblock.filter(p =>
                  p.id !== pos.id &&
                  p.side === pos.side &&
                  (p.status === "open" || p.status === "pending_open") &&
                  p.onChainPositionId && !p.onChainPositionId.includes("-")
                );
                if (sameSideBlockers.length > 0) {
                  const blocker = sameSideBlockers.sort((a, b) =>
                    parseInt(a.onChainPositionId ?? "99999") - parseInt(b.onChainPositionId ?? "99999")
                  )[0];
                  // Skip if blocker already has a TX in flight
                  if (positionCloseInProgress.has(blocker.id)) {
                    console.log(`[TP/SL] MULTI-POS-UNBLOCK: Blocker pos=${blocker.onChainPositionId} close TX in flight — skip.`);
                    return;
                  }
                  // Skip if blocker's linked close order is already pending keeper fill.
                  // The RAPID monitor fires every 500ms — without this guard, every tick would
                  // submit a new linked close order for the blocker, flooding the 5-slot array.
                  const blockerCloseState = (blocker as any).closeState;
                  if (blockerCloseState === "close_order_working" || blockerCloseState === "close_tx_submitted") {
                    console.log(`[TP/SL] MULTI-POS-UNBLOCK: Blocker pos=${blocker.onChainPositionId} already has linked close pending (state=${blockerCloseState}) — skip.`);
                    return;
                  }
                  // Cooldown: only fire once per MULTI_POS_UNBLOCK_COOLDOWN_MS per blocker position.
                  // Prevents the rapid monitor from submitting a new linked order every 500ms.
                  const lastFired = multiPosUnblockLastFired.get(blocker.id) ?? 0;
                  const timeSinceFired = Date.now() - lastFired;
                  if (timeSinceFired < MULTI_POS_UNBLOCK_COOLDOWN_MS) {
                    const waitSec = Math.ceil((MULTI_POS_UNBLOCK_COOLDOWN_MS - timeSinceFired) / 1000);
                    console.log(`[TP/SL] MULTI-POS-UNBLOCK: Blocker pos=${blocker.onChainPositionId} cooldown — ${waitSec}s remaining. Skip.`);
                    return;
                  }
                  // Record firing time before the close call so concurrent callers see the cooldown.
                  multiPosUnblockLastFired.set(blocker.id, Date.now());
                  // Clear blocker's backoff/cooldown so the close can proceed immediately
                  positionCloseBackoff.delete(blocker.id);
                  positionCloseCooldown.delete(blocker.id);
                  console.log(`[TP/SL] MULTI-POS-UNBLOCK: Triggering close of oldest blocker pos=${blocker.onChainPositionId} (db=${blocker.id.slice(0, 8)}) to unblock deferred pos=${pos.onChainPositionId || pos.id.slice(0, 8)}`);
                  const unblockResult = await closePositionForAgent(agentConfig, blocker.id, currentPrice, false, "multi-pos-unblock");
                  if (unblockResult.closed) {
                    multiPosUnblockLastFired.delete(blocker.id);
                    console.log(`[TP/SL] MULTI-POS-UNBLOCK SUCCESS: pos=${blocker.onChainPositionId} closed, PnL=${unblockResult.pnl.toFixed(4)} SUI`);
                  } else {
                    console.log(`[TP/SL] MULTI-POS-UNBLOCK: pos=${blocker.onChainPositionId} close attempt returned: ${unblockResult.error || "not closed"}`);
                  }
                }
              } catch (unblockErr: any) {
                console.log(`[TP/SL] MULTI-POS-UNBLOCK error: ${unblockErr.message?.slice(0, 100)}`);
              }
            })();
          } else {
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
          }

          const retryMsg = isGasError ? "paused — need gas top-up" : isCooldownError ? `cooldown ${CLOSE_COOLDOWN_MS / 1000}s` : isMultiPosDefer ? "deferred (oldest position must close first)" : "will retry with backoff";
          console.log(`[TP/SL] ${reason} close FAILED for ${agentConfig.name} pos ${pos.id} after ${effectiveMaxRetries} attempts — ${retryMsg}. Error: ${result.error}`);

          if (isGasError) {
            await storage.updateAgent(agent.id, {
              status: "paused",
              lastExecutionError: `INSUFFICIENT_GAS: Cannot close ${reason} — wallet needs SUI top-up. Positions remain open until gas is available.`,
              lastExecutionAt: new Date(),
            });
            console.log(`[TP/SL] AUTO-PAUSED ${agentConfig.name} due to INSUFFICIENT_GAS — will auto-resume when gas is replenished.`);
          } else if (!isRateLimit && !isMultiPosDefer) {
            await storage.updateAgent(agent.id, {
              lastExecutionError: `${reason.toUpperCase()} CLOSE FAILED: ${result.error || "on-chain close rejected"} — ${retryMsg}`,
              lastExecutionAt: new Date(),
            });
          }

          const emergencyStart = emergencyDetectedAt.get(pos.id);
          if (emergencyStart && (Date.now() - emergencyStart) > EMERGENCY_FORCE_SETTLE_TIMEOUT_MS) {
            console.log(`[TP/SL] FORCE-SETTLE: ${agentConfig.name} pos ${pos.id} has been at emergency level for ${Math.round((Date.now() - emergencyStart) / 1000)}s — attempting force-settle from on-chain state`);
            // Clear any stale in-progress lock and cooldown so the force-settle can actually proceed
            positionCloseInProgress.delete(pos.id);
            positionCloseCooldown.delete(pos.id);
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
const DB_PENDING_SCAN_INTERVAL_MS = 3_000; // Check for keeper fills every 3s (was 6s)

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

        // Respect explicit cooldown set by close_already_in_progress freeze.
        const cooldownExpiry = positionCloseCooldown.get(pos.id);
        if (cooldownExpiry && now < cooldownExpiry) continue;

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
            // TTL expired and position was not confirmed filled. Check on-chain one more time
            // before resetting to prevent premature cancel+resubmit when keeper is still filling.
            let goneOnChain = false;
            try {
              const freshOnChain = await (adapter as TypusAdapter).getPositions(agent.walletAddress!);
              goneOnChain = !freshOnChain.some((p: any) => String(p.positionId) === String(pos.onChainPositionId));
              if (goneOnChain) {
                console.log(`[DbPendingScan] TTL expired for ${pos.id} (${agent.name}) but position GONE on-chain — keeper filled it. Settling.`);
                await updateCloseState(pos.id, { closeState: "closed", closePendingSince: null });
                positionCloseCooldown.delete(pos.id);
                const lastPrice = getLastPrice();
                if (lastPrice && agent) {
                  closePositionForAgent(agent as any, pos.id, lastPrice, true, "keeper_filled_ttl").catch(() => {});
                }
              }
            } catch {}
            if (!goneOnChain) {
              // Position still on-chain after TTL. The linked close order is in the keeper queue.
              // cancel_linked_orders is KEEPER_ONLY — we cannot clear slots ourselves.
              // Use the same stall-cycle counter as closePositionForAgent to avoid filling
              // up the 5-slot linked_orders array with repeated resubmits.
              const stallCount = (ttlDrainStallCycles.get(pos.id) || 0) + 1;
              if (stallCount < MAX_TTL_STALL_CYCLES) {
                ttlDrainStallCycles.set(pos.id, stallCount);
                console.log(`[DbPendingScan] pos ${pos.id} (${agent.name}) TTL stall ${stallCount}/${MAX_TTL_STALL_CYCLES} — extending window, NOT resubmitting (keeper has active linked order).`);
                await updateCloseState(pos.id, { closePendingSince: new Date().toISOString() });
              } else {
                ttlDrainStallCycles.delete(pos.id);
                console.log(`[DbPendingScan] Position ${pos.id} for ${agent.name} pending for ${Math.round(pendingAge / 1000)}s (${stallCount} stall cycles) — forcing price-refresh resubmit.`);
                await updateCloseState(pos.id, { closeState: "close_requested", closePendingSince: null });
                positionCloseCooldown.delete(pos.id);
              }
            }
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
              verified: true,
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
        // Close order expired — reset state so the close loop resubmits.
        // NOTE: No cancel_linked_orders call here. Our closes are unlinked reduce-only orders.
        // cancel_linked_orders cannot target them and would fill the linked_orders array.
        // The expired order will be cleaned up by Typus's keeper automatically.
        console.log(`[PendingClose] Close order for ${agent.name} pos ${posId} expired after ${Math.round(age / 1000)}s — resetting state for retry.`);
        pendingCloseOrders.delete(posId);
        positionCloseCooldown.delete(posId);
        await updateCloseState(posId, { closeState: "close_requested", closePendingSince: null });
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

  // Only persist a bundle record when something meaningful happened on-chain (TX submitted or
  // position closed). Skip no-op attempts (e.g., getPositions returned 0 due to RPC rate-limit)
  // to avoid flooding the SUI Flow log with meaningless "Rejected" entries.
  const txWasSubmitted = !!(result.txDigest && !result.txDigest.startsWith("sim_"));
  const shouldEmitBundle = isVerified || isPending || txWasSubmitted;
  if (!shouldEmitBundle) {
    return;
  }

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
