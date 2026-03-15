/**
 * Reconciliation Engine
 *
 * Backend-first canonical portfolio state machine.
 * Runs every 5 seconds per agent, computes and stores a full
 * portfolio snapshot so the frontend always loads coherent truth.
 *
 * Economic Value formula:
 *   settledFundingWallet
 *   + settledSavingsWallet
 *   + openCollateral       (collateral locked in live positions)
 *   + unrealizedPnl        (mark-to-market gain/loss on open positions)
 *   + inTransit            (submitted transfer jobs not yet reconciled)
 *   + settlementPending    (closed positions whose collateral hasn't returned)
 *   + claimableRewards
 *
 * Total PnL = Economic Value - Net Deposited
 *
 * Accounting Health =
 *   (settledFundingWallet + settledSavingsWallet + openCollateral) / Economic Value
 *   → 100% means every SUI is tracked to a reconciled source
 */

import { storage } from "./storage";
import { db } from "./db";
import { eq, and } from "drizzle-orm";
import { rewards } from "@shared/schema";
import { portfolioEngine } from "./portfolio-state";
import { getLastPrice } from "./price-service";

const RECONCILE_INTERVAL_MS = 5_000;
const SNAPSHOT_STALE_MS = 30_000; // show "degraded" badge if no reconcile for 30s

// In-memory hot cache so API calls never hit DB for the snapshot
const snapshotCache = new Map<string, {
  snapshot: any;
  computedAt: number;
}>();

export function getCachedSnapshot(agentId: string) {
  return snapshotCache.get(agentId);
}

export function getAllCachedSnapshots() {
  const now = Date.now();
  const MAX_SNAPSHOT_AGE_MS = 5 * 60 * 1000;
  return Array.from(snapshotCache.values())
    .filter(v => (now - v.computedAt) < MAX_SNAPSHOT_AGE_MS)
    .map(v => v.snapshot);
}

export function removeFromSnapshotCache(agentId: string) {
  snapshotCache.delete(agentId);
}

/**
 * Compute and store the canonical portfolio snapshot for one agent.
 * Reads from DB positions + transferJobs + rewards, overlays live price.
 */
async function reconcileAgent(agentId: string): Promise<void> {
  try {
    const agent = await storage.getAgent(agentId);
    if (!agent) return;

    const priceTick = getLastPrice();
    const currentPrice = priceTick?.price ?? 0;

    // ── Positions ────────────────────────────────────────────────────────────
    const allPositions = await storage.getPositions(agentId);
    const livePositions = allPositions.filter(p => p.status === "open");
    const closingPositions = livePositions.filter(
      p => p.closeState !== "open" && p.closeState !== null,
    );
    const activeOpen = livePositions.filter(p => p.closeState === "open");

    // Recently closed positions in settlement window (closed in last 120s)
    const now = Date.now();
    const settlingClosed = allPositions.filter(p => {
      if (p.status !== "closed") return false;
      if (!p.closedAt) return false;
      const closedAgo = now - new Date(p.closedAt).getTime();
      return closedAgo < 120_000 && !p.closeTxDigest?.startsWith("cancelled_unfilled");
    });

    // Collateral locked in open positions
    const openCollateral = livePositions.reduce((sum, p) => {
      return sum + (p.collateral || p.sizeSui / (agent.leverage || 25));
    }, 0);

    // Settlement pending = collateral from closed-but-not-reconciled positions
    const settlementPending = settlingClosed.reduce((sum, p) => {
      return sum + (p.collateral || p.sizeSui / (agent.leverage || 25));
    }, 0);

    // Unrealized PnL using live mark price
    let unrealizedPnl = 0;
    if (currentPrice > 0) {
      unrealizedPnl = livePositions.reduce((sum, p) => {
        if (!p.entryPrice || p.entryPrice === 0) return sum + (p.unrealizedPnl || 0);
        const pnl = p.side === "long"
          ? (currentPrice - p.entryPrice) * p.sizeSui / currentPrice
          : (p.entryPrice - currentPrice) * p.sizeSui / currentPrice;
        const posCollateral = p.collateral || p.sizeSui / (agent.leverage || 25);
        return sum + Math.min(posCollateral * ((agent.leverage || 25) - 1), Math.max(-posCollateral, pnl));
      }, 0);
    } else {
      unrealizedPnl = livePositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
    }

    // ── Transfers In Transit ─────────────────────────────────────────────────
    const pendingTransfers = await storage.getPendingTransferJobs(agentId);
    const inTransit = pendingTransfers
      .filter(t => t.status === "SUBMITTED" || t.status === "CREATED")
      .reduce((sum, t) => sum + (t.amountSui || 0), 0);

    // ── Rewards ─────────────────────────────────────────────────────────────
    const allRewards = await db.select().from(rewards)
      .where(and(eq(rewards.agentId, agentId), eq(rewards.status, "pending")));
    const claimableRewards = allRewards.reduce((sum, r) => sum + (r.amount || 0), 0);

    // ── Wallet balances from agent record ────────────────────────────────────
    // The agent.balance is synced from on-chain by the activity endpoint
    const settledFundingWallet = Math.max(0, agent.balance - openCollateral);

    // Read savings from the shared global cache populated by the canonical-snapshot
    // proactive fetch (T002b). Falls back to onChainPortfolioCache if available.
    const _savingsCache: Map<string, { balance: number; ts: number }> | undefined =
      (globalThis as any).__agentSavingsCache;
    const _portfolioCache = (globalThis as any).__onChainPortfolioCache;
    const cachedSavingsEntry = _savingsCache?.get(agentId);
    const portfolioCacheSavings = _portfolioCache?.get(agentId)?.savingsBalance ?? 0;
    const settledSavingsWallet = Math.max(
      cachedSavingsEntry?.balance ?? 0,
      portfolioCacheSavings
    );

    // ── Economic Value ───────────────────────────────────────────────────────
    const economicValue =
      agent.balance +           // funded wallet (includes locked collateral)
      settledSavingsWallet +
      unrealizedPnl +
      inTransit +
      settlementPending +
      claimableRewards;

    const settledBalance = agent.balance + settledSavingsWallet;
    // Use the deposits table as the authoritative source for totalDeposited
    let reconTotalDeposited = agent.totalDeposited || 0;
    let reconProtocolFee = agent.protocolFeePaid || 0;
    try {
      const agentDeposits = await storage.getDepositsByAgent(agentId);
      if (agentDeposits.length > 0) {
        const depositsGross = agentDeposits.reduce((s, d) => s + (d.grossAmount || 0), 0);
        const depositsFee = agentDeposits.reduce((s, d) => s + (d.protocolFee || 0), 0);
        if (depositsGross > 0 && Math.abs(depositsGross - reconTotalDeposited) > 0.01) {
          storage.updateAgent(agentId, { totalDeposited: depositsGross, protocolFeePaid: depositsFee }).catch(() => {});
          reconTotalDeposited = depositsGross;
          reconProtocolFee = depositsFee;
        }
      }
    } catch (_) { /* non-blocking */ }

    // Subtract protocol fee from totalDeposited to get the true net (matches portfolio endpoint)
    let netDeposited = Math.max(0, reconTotalDeposited - reconProtocolFee);

    // Fresh-agent baseline correction: if the agent has never completed a trade, has no
    // open positions, and totalDeposited is inflated (e.g., untracked manual withdrawal),
    // reset the deposit baseline to current economic value so NET DEPOSIT and PnL start clean.
    // Guard: only when no positions are open to prevent mark-to-market from repeatedly resetting.
    const hasOpenOrSettlingPositions = livePositions.length > 0 || settlingClosed.length > 0;
    if ((agent.totalTrades ?? 0) === 0 && !hasOpenOrSettlingPositions && economicValue > 0.001 && netDeposited > economicValue + 0.01) {
      const correctedGross = economicValue + reconProtocolFee;
      storage.updateAgent(agentId, { totalDeposited: correctedGross }).catch(() => {});
      netDeposited = economicValue;
    }

    const totalPnl = economicValue - netDeposited;

    // ── F002: Aggressive agent.totalPnl auto-correction ─────────────────────
    // Runs every 5s — NO chain-data dependency required.
    // agent.totalPnl can drift by 10-20 SUI due to price-estimated close PnL
    // accumulation errors. Correct it here from economic first principles.
    // Threshold: 0.5 SUI — tight enough to catch drift, loose enough to avoid thrash.
    const dbPnl = agent.totalPnl ?? 0;
    const pnlDrift = Math.abs(dbPnl - totalPnl);
    if (pnlDrift > 0.5 && netDeposited > 0) {
      storage.updateAgent(agentId, { totalPnl }).catch(() => {});
      console.log(`[Reconciler] Auto-corrected totalPnl for ${agent.name}: DB=${dbPnl.toFixed(4)} → portfolio=${totalPnl.toFixed(4)} (drift=${pnlDrift.toFixed(4)} SUI)`);
    }

    // ── Accounting Health ────────────────────────────────────────────────────
    // How much of economic value is tracked to reconciled on-chain sources
    const trackedValue = agent.balance + settledSavingsWallet + claimableRewards;
    const accountingHealth = economicValue > 0
      ? Math.min(100, Math.round((trackedValue / economicValue) * 100))
      : 100;

    const confidence =
      livePositions.length > 0 || pendingTransfers.length > 0 ? "live"
      : settlingClosed.length > 0 ? "pending"
      : "verified";

    // ── Store snapshot ───────────────────────────────────────────────────────
    const snapshot = {
      agentId,
      settledFundingWallet: agent.balance,
      settledSavingsWallet,
      openCollateral,
      unrealizedPnl,
      inTransit,
      settlementPending,
      claimableRewards,
      economicValue,
      settledBalance,
      netDeposited,
      totalPnl,
      openPositionCount: livePositions.length,
      closingPositionCount: closingPositions.length,
      pendingSettlementCount: settlingClosed.length,
      accountingHealth,
      confidence,
      lastReconciledAt: new Date().toISOString(),
      agentName: agent.name,
      agentStatus: agent.status,
    };

    snapshotCache.set(agentId, { snapshot, computedAt: Date.now() });

    // Persist to DB (non-blocking, fire and forget)
    storage.upsertPortfolioSnapshot(agentId, {
      settledFundingWallet: agent.balance,
      settledSavingsWallet,
      openCollateral,
      unrealizedPnl,
      inTransit,
      settlementPending,
      claimableRewards,
      economicValue,
      settledBalance,
      netDeposited,
      totalPnl,
      openPositionCount: livePositions.length,
      closingPositionCount: closingPositions.length,
      pendingSettlementCount: settlingClosed.length,
      accountingHealth,
      confidence,
    }).catch(() => {});

    // Push mark-price tick to WebSocket subscribers
    portfolioEngine.markPriceTick(agentId, unrealizedPnl);

    // Update position lifecycle journal for all live positions
    for (const pos of livePositions) {
      const lifecycleState = pos.status === "pending_open" ? "ENTRY_SUBMITTED"
        : pos.closeState === "close_tx_submitted" ? "CLOSE_SUBMITTED"
        : pos.closeState === "close_order_working" ? "CLOSE_SUBMITTED"
        : pos.onChainPositionId ? "LIVE"
        : "ENTRY_CONFIRMED";

      storage.upsertPositionJournal(pos.id, {
        positionId: pos.id,
        agentId,
        side: pos.side,
        lifecycleState,
        entryPrice: pos.entryPrice,
        collateralLocked: pos.collateral || pos.sizeSui / (agent.leverage || 25),
        entryTxHash: pos.txDigest || undefined,
        sourceConfidence: pos.onChainPositionId ? "live" : "pending",
      }).catch(() => {});
    }

    // Update settled positions journal
    for (const pos of settlingClosed) {
      storage.upsertPositionJournal(pos.id, {
        positionId: pos.id,
        agentId,
        side: pos.side,
        lifecycleState: "SETTLEMENT_PENDING",
        entryPrice: pos.entryPrice,
        exitPrice: pos.markPrice,
        realizedPnl: pos.unrealizedPnl,
        closeReason: pos.closeReason || undefined,
        closeTxHash: pos.closeTxDigest || undefined,
        sourceConfidence: "pending",
      }).catch(() => {});
    }

  } catch (err: any) {
    // Non-fatal — reconciliation will retry next tick
  }
}

/**
 * Write a fund flow ledger entry for a SUI movement.
 * Called from the execution engine at key lifecycle points.
 */
export async function recordFundFlow(params: {
  agentId: string;
  eventType: string;
  amount: number;
  direction: "debit" | "credit";
  positionId?: string;
  txHash?: string;
  notes?: string;
  sourceSystem?: string;
}): Promise<void> {
  try {
    await storage.appendFundFlow({
      agentId: params.agentId,
      positionId: params.positionId,
      eventType: params.eventType,
      amount: Math.abs(params.amount),
      direction: params.direction,
      txHash: params.txHash,
      sourceSystem: params.sourceSystem || "execution-engine",
      notes: params.notes,
      confirmed: false,
      eventTime: new Date(),
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Mark a position's journal entry as SETTLED with final PnL.
 * Called after close is confirmed and collateral returned.
 */
export async function settlePositionJournal(
  positionId: string,
  agentId: string,
  realizedPnl: number,
  collateralReturned: number,
  closeTxHash?: string,
): Promise<void> {
  try {
    await storage.upsertPositionJournal(positionId, {
      lifecycleState: "SETTLED",
      realizedPnl,
      collateralReturned,
      closeTxHash,
      settlementStatus: "confirmed",
      settlementConfirmedAt: new Date(),
      closeConfirmedAt: new Date(),
      sourceConfidence: "verified",
    });
    // Record the fund flow
    await recordFundFlow({
      agentId,
      eventType: "COLLATERAL_RELEASED",
      amount: collateralReturned,
      direction: "credit",
      positionId,
      txHash: closeTxHash,
      notes: `realized_pnl=${realizedPnl.toFixed(4)} SUI`,
    });
    if (realizedPnl !== 0) {
      await recordFundFlow({
        agentId,
        eventType: "REALIZED_PNL",
        amount: Math.abs(realizedPnl),
        direction: realizedPnl >= 0 ? "credit" : "debit",
        positionId,
        txHash: closeTxHash,
      });
    }
  } catch {
    // Non-fatal
  }
}

let reconcileTimer: ReturnType<typeof setInterval> | null = null;

export function startReconciliationEngine(): void {
  if (reconcileTimer) return;
  console.log("[Reconciler] Started — computing canonical portfolio state every 5s");

  reconcileTimer = setInterval(async () => {
    try {
      const agents = await storage.getAgents();
      await Promise.allSettled(agents.map(a => reconcileAgent(a.id)));
    } catch {
      // Non-fatal
    }
  }, RECONCILE_INTERVAL_MS);
}

export function stopReconciliationEngine(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

export { snapshotCache };
