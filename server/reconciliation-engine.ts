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
import { getCachedOnChainPositions } from "./on-chain-cache";
import { getAgentVerification } from "./portfolio-verifier";

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

    // Recently closed positions in settlement window (closed in last 300s).
    // IMPORTANT: Only count positions closed with a REAL on-chain TX digest.
    // Synthetic close digests (position_gone_onchain, settled_onchain, liquidated_onchain)
    // do NOT represent pending keeper settlement — they're either already settled (the
    // SUI came back when Typus settled them) or they're phantom duplicate records from
    // the recovery loop. Including them inflates settlementPending to hundreds of SUI.
    const SYNTHETIC_DIGESTS = new Set([
      "settled_onchain", "position_gone_onchain", "closed_externally",
      "liquidated_onchain", "prior_fill", "keeper_filled", "keeper_filled_tracked",
    ]);
    const now = Date.now();
    const settlingClosed = allPositions.filter(p => {
      if (p.status !== "closed") return false;
      if (!p.closedAt) return false;
      const closedAgo = now - new Date(p.closedAt).getTime();
      if (closedAgo >= 300_000) return false;
      const digest = (p as any).closeTxDigest ?? null;
      if (!digest) return false;
      if (SYNTHETIC_DIGESTS.has(digest)) return false;
      if (digest.startsWith("cancelled_unfilled")) return false;
      if (digest.startsWith("sim_")) return false;
      if (digest.startsWith("db_")) return false;
      if (digest.startsWith("recovered_")) return false;
      // Only count if it looks like a real TX digest (base58, at least 40 chars)
      return digest.length >= 40;
    });

    // Positions with close TX submitted but not yet confirmed closed in DB.
    // These are "in-flight" and their collateral is still at risk of disappearing
    // from the openCollateral bucket before it lands in the wallet.
    const closeTxSubmittedPositions = livePositions.filter(p =>
      (p as any).closeState === "close_tx_submitted"
    );

    // Collateral locked in open positions (DB)
    const dbOpenCollateral = livePositions.reduce((sum, p) => {
      return sum + (p.collateral || p.sizeSui / (agent.leverage || 25));
    }, 0);

    // Supplement from on-chain caches (verifier + activity endpoint) when they show
    // more locked collateral than the DB — i.e. positions exist on-chain but not yet
    // re-opened in the DB after recovery.
    const onChainCache = getCachedOnChainPositions(agentId);
    const verifierState = getAgentVerification(agentId);
    const onChainCollateral = onChainCache?.totalLocked ?? 0;
    const onChainPosCount = verifierState?.positionCount ?? onChainCache?.positions.length ?? 0;
    const openCollateral = Math.max(dbOpenCollateral, onChainCollateral);

    // Effective open position count — max of DB open + on-chain verifier count
    const effectiveLivePositionCount = Math.max(livePositions.length, onChainPosCount);

    // Settlement pending = collateral from closed-but-not-reconciled positions
    // PLUS in-flight close TX positions (close_tx_submitted) — prevents EV blind spots
    // when a position transitions from "open collateral" to "closed" before the wallet
    // balance updates from the chain.
    const settledPendingFromClosed = settlingClosed.reduce((sum, p) => {
      return sum + (p.collateral || p.sizeSui / (agent.leverage || 25));
    }, 0);
    const settledPendingFromInFlight = closeTxSubmittedPositions.reduce((sum, p) => {
      return sum + (p.collateral || p.sizeSui / (agent.leverage || 25));
    }, 0);
    // Only add in-flight collateral if it's not already counted in openCollateral
    // (it is in livePositions, so openCollateral already includes it — don't double-count).
    // Instead track it separately for frontend display to signal "settling" state.
    const settlementPending = settledPendingFromClosed;
    const inFlightCloseCollateral = settledPendingFromInFlight;

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
    // agent.balance = free on-chain SUI + locked collateral in open positions
    //   (kept current by periodicReconciliation which queries on-chain every 20–300s)
    // settlementPending = collateral from RECENTLY CLOSED positions (real TX only)
    //   whose keeper fill hasn't yet landed in agent.balance.
    //   After keeper fills → balance goes up → this position falls out of the 300s window.
    //   Brief double-count window (max 300s) is accepted; phantom positions are now
    //   filtered so only real TX digests count here.
    const economicValue =
      agent.balance +           // funded wallet (includes locked collateral from open positions)
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
    const hasOpenOrSettlingPositions = effectiveLivePositionCount > 0 || settlingClosed.length > 0;
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
      effectiveLivePositionCount > 0 || pendingTransfers.length > 0 ? "live"
      : settlingClosed.length > 0 || closeTxSubmittedPositions.length > 0 ? "pending"
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
      inFlightCloseCollateral,
      claimableRewards,
      economicValue,
      settledBalance,
      netDeposited,
      totalPnl,
      openPositionCount: effectiveLivePositionCount,
      closingPositionCount: closingPositions.length,
      pendingSettlementCount: settlingClosed.length + closeTxSubmittedPositions.length,
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
      openPositionCount: effectiveLivePositionCount,
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
let rewardReconcileTimer: ReturnType<typeof setInterval> | null = null;

const REWARD_RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // Every 5 minutes

async function reconcileMissedRewards(): Promise<void> {
  try {
    const allAgents = await storage.getAgents();
    const allRewards = await storage.getRewards();
    const rewardedPositionIds = new Set(
      allRewards.filter(r => r.positionId).map(r => r.positionId!)
    );

    for (const agent of allAgents) {
      if (!agent.agentWallet || !agent.walletAddress) continue;
      const rewardSharePct = agent.rewardSharePct ?? 0;
      if (rewardSharePct <= 0) continue;

      const allPositions = await storage.getPositions(agent.id);
      const missedRewardPositions = allPositions.filter(p =>
        p.status === "closed" &&
        (p.unrealizedPnl || 0) > 0 &&
        !rewardedPositionIds.has(p.id)
      );

      if (missedRewardPositions.length === 0) continue;
      console.log(`[RewardReconciler] Found ${missedRewardPositions.length} profitable closed position(s) without rewards for ${agent.name}`);

      for (const pos of missedRewardPositions) {
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

          if (alreadyExisted) {
            rewardedPositionIds.add(pos.id);
            continue;
          }

          rewardedPositionIds.add(pos.id);
          console.log(`[RewardReconciler] Created missed reward ${rewardAmount.toFixed(4)} SUI for ${agent.name} pos ${pos.id}`);

          try {
            await storage.updateReward(reward.id, { escrowTxDigest: "pending_escrow" });
            const { escrowRewardFromAgent } = await import("./reward-wallet");
            const escrowResult = await escrowRewardFromAgent(agent.agentWallet!, agent.walletAddress!, rewardAmount);
            await storage.updateReward(reward.id, { escrowTxDigest: escrowResult.txDigest });
            console.log(`[RewardReconciler] Escrowed ${rewardAmount.toFixed(4)} SUI for ${agent.name} → reward wallet (tx: ${escrowResult.txDigest})`);
          } catch (escErr: any) {
            console.log(`[RewardReconciler] Escrow failed for ${agent.name}: ${escErr.message} — pending_escrow retained`);
          }
        } catch (err: any) {
          console.log(`[RewardReconciler] Error creating reward for ${agent.name} pos ${pos.id}: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    console.log(`[RewardReconciler] Error during reconciliation: ${err.message}`);
  }
}

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

  // Run reward reconciliation immediately on startup, then every 5 minutes
  setTimeout(() => reconcileMissedRewards(), 30 * 1000); // 30s after startup
  rewardReconcileTimer = setInterval(() => reconcileMissedRewards(), REWARD_RECONCILE_INTERVAL_MS);
}

export function stopReconciliationEngine(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  if (rewardReconcileTimer) {
    clearInterval(rewardReconcileTimer);
    rewardReconcileTimer = null;
  }
}

export { snapshotCache };
