import { storage } from "./storage";
import { getLastPrice } from "./price-service";
import { checkAndClosePositions, processPendingCloseOrders, closePositionForAgent, clearCloseGasTrackingExternal, resetGasSpendTracking, isDailyGasCapReset, checkGasForAgent, registerTopoffResume, getGasCapStatus } from "./dex/execution-engine";
import { getAdapter } from "./dex/index";
import { TypusAdapter } from "./dex/typus-adapter";

const MONITOR_INTERVAL_MS = 5000;
const RAPID_MONITOR_INTERVAL_MS = 500;
const RECONCILIATION_INTERVAL_MS = 60000;
let monitorInterval: ReturnType<typeof setInterval> | null = null;
let rapidMonitorInterval: ReturnType<typeof setInterval> | null = null;
let reconciliationInterval: ReturnType<typeof setInterval> | null = null;
let broadcastFn: ((type: string, data: any) => void) | null = null;

export function setPositionMonitorBroadcast(fn: (type: string, data: any) => void) {
  broadcastFn = fn;
}

const lastPositionBroadcast = new Map<string, number>();
const POSITION_BROADCAST_THROTTLE_MS = 900;

export function broadcastPositionUpdate(agentId: string, positions: any[], force = false) {
  if (!broadcastFn) return;
  const now = Date.now();
  const lastBroadcast = lastPositionBroadcast.get(agentId) || 0;
  if (!force && now - lastBroadcast < POSITION_BROADCAST_THROTTLE_MS) return;
  lastPositionBroadcast.set(agentId, now);
  broadcastFn("positions:updated", { agentId, positions, timestamp: now });
}

const agentCheckInProgress = new Set<string>();
let lastBlockedRecoveryCheck = 0;
const BLOCKED_RECOVERY_INTERVAL_MS = 300_000;
const blockedRecoveryInProgress = new Set<string>();
const MAX_RECOVERY_ATTEMPTS_PER_POSITION = 3;
const recoveryAttemptCount = new Map<string, number>();

let lastAutoResumeCheck = 0;
const AUTO_RESUME_INTERVAL_MS = 60_000;
const AUTO_RESUME_COOLDOWN_MS = 300_000;

let lastEscrowRetryCheck = 0;
const ESCROW_RETRY_INTERVAL_MS = 600_000;

let lastZombiePositionCheck = 0;
const ZOMBIE_POSITION_CHECK_INTERVAL_MS = 60_000;
const zombieCheckInProgress = new Set<string>();

let lastStaleCloseCheck = 0;
const STALE_CLOSE_CHECK_INTERVAL_MS = 90_000;
const STALE_CLOSE_AGE_MS = 120_000;
const staleCloseInProgress = new Set<string>();
const MAX_STALE_RECOVERY_PER_POSITION = 3;
const staleRecoveryAttempts = new Map<string, number>();

let lastContradictoryStateCheck = 0;
const CONTRADICTORY_STATE_CHECK_INTERVAL_MS = 120_000;


async function recoverBlockedAgents(currentPrice: number) {
  const now = Date.now();
  if (now - lastBlockedRecoveryCheck < BLOCKED_RECOVERY_INTERVAL_MS) return;
  lastBlockedRecoveryCheck = now;

  try {
    const agents = await storage.getAgentsWithSignalAgents();
    for (const agent of agents) {
      if (agent.status !== "paused") continue;
      const err = agent.lastExecutionError || "";
      const isBlocked = err.includes("CLOSE_PERMANENTLY_BLOCKED");
      const isGasCap = err.includes("CLOSE_GAS_CAP");
      if (!isBlocked && !isGasCap) continue;
      if (blockedRecoveryInProgress.has(agent.id)) continue;

      const positions = await storage.getPositions(agent.id);
      const openPositions = positions.filter(p => p.status === "open");
      if (openPositions.length === 0) {
        console.log(`[BlockedRecovery] ${agent.name} paused with ${isGasCap ? "CLOSE_GAS_CAP" : "CLOSE_PERMANENTLY_BLOCKED"} but has no open positions — resuming agent.`);
        await storage.updateAgent(agent.id, {
          status: "running",
          lastExecutionError: null,
          lastExecutionAt: new Date(),
        });
        continue;
      }

      blockedRecoveryInProgress.add(agent.id);
      (async () => {
        try {
          for (const pos of openPositions) {
            const posRewards = await storage.getRewardsByPositionId(pos.id);
            if (posRewards.some(r => r.status !== "voided")) {
              console.log(`[BlockedRecovery] Skipping ${agent.name} pos ${pos.id} — has active reward(s), position was already closed on-chain. Marking closed in DB.`);
              await storage.updatePosition(pos.id, { status: "closed", closeReason: pos.closeReason || "verified-closed", closeState: "closed", closedAt: pos.closedAt || new Date() });
              continue;
            }
            const recoveryKey = `${agent.id}:${pos.id}`;
            const priorRecoveries = recoveryAttemptCount.get(recoveryKey) || 0;
            if (priorRecoveries >= MAX_RECOVERY_ATTEMPTS_PER_POSITION) {
              console.log(`[BlockedRecovery] Skipping ${agent.name} pos ${pos.id} — already attempted ${priorRecoveries} recoveries (max ${MAX_RECOVERY_ATTEMPTS_PER_POSITION}).`);
              continue;
            }

            let hasGas = false;
            try {
              const gasResult = await checkGasForAgent(agent.agentWallet);
              hasGas = gasResult.ok && gasResult.balanceSui >= 0.1;
            } catch {}
            if (!hasGas) {
              console.log(`[BlockedRecovery] Skipping ${agent.name} pos ${pos.id} — insufficient gas for recovery close.`);
              continue;
            }

            const closeAttempts = (pos as any).closeAttempts || 0;
            const errorType = isGasCap ? "CLOSE_GAS_CAP" : "CLOSE_PERMANENTLY_BLOCKED";
            console.log(`[BlockedRecovery] Retrying close for ${agent.name} pos ${pos.id} (was ${errorType}, DB attempts=${closeAttempts}, recoveries=${priorRecoveries}/${MAX_RECOVERY_ATTEMPTS_PER_POSITION}).`);
            recoveryAttemptCount.set(recoveryKey, priorRecoveries + 1);

            const result = await closePositionForAgent(agent, pos.id, currentPrice, false, "blocked-recovery");
            if (result.closed) {
              console.log(`[BlockedRecovery] Close SUCCESS for ${agent.name} pos ${pos.id}: PnL=${result.pnl.toFixed(4)} SUI`);
              recoveryAttemptCount.delete(recoveryKey);
              await storage.updateAgent(agent.id, {
                status: "running",
                lastExecutionError: null,
                lastExecutionAt: new Date(),
              });
            } else {
              console.log(`[BlockedRecovery] Close still failed for ${agent.name} pos ${pos.id}: ${result.error}`);
            }
          }
        } catch (err: any) {
          console.error(`[BlockedRecovery] Error for ${agent.name}: ${err.message}`);
        } finally {
          blockedRecoveryInProgress.delete(agent.id);
        }
      })();
    }
  } catch (err: any) {
    console.error(`[BlockedRecovery] Tick error: ${err.message}`);
  }
}

async function autoResumePausedAgents() {
  const now = Date.now();
  if (now - lastAutoResumeCheck < AUTO_RESUME_INTERVAL_MS) return;
  lastAutoResumeCheck = now;

  try {
    const agents = await storage.getAgentsWithSignalAgents();
    for (const agent of agents) {
      if (agent.status !== "paused") continue;
      const err = agent.lastExecutionError || "";

      if (err.includes("SPEND_CAP") || err.includes("CIRCUIT_BREAKER")) {
        const gasCapReset = isDailyGasCapReset(agent.id);
        const pausedAt = agent.lastExecutionAt ? new Date(agent.lastExecutionAt).getTime() : 0;
        const cooldownElapsed = now - pausedAt >= AUTO_RESUME_COOLDOWN_MS;

        if (gasCapReset || cooldownElapsed) {
          console.log(`[AutoResume] Resuming ${agent.name} after ${Math.round((now - pausedAt) / 1000)}s (gasCapReset=${gasCapReset}, cooldownElapsed=${cooldownElapsed}) (was: ${err.slice(0, 80)})`);
          resetGasSpendTracking(agent.id);
          await storage.updateAgent(agent.id, {
            status: "running",
            lastExecutionError: null,
            lastExecutionAt: new Date(),
          });
        }
      }

      if (err.includes("CLOSE_GAS_CAP")) {
        const positions = await storage.getPositions(agent.id);
        const openPositions = positions.filter(p => p.status === "open" || p.status === "pending_open");
        if (openPositions.length === 0) {
          console.log(`[AutoResume] Resuming ${agent.name} — was CLOSE_GAS_CAP paused but no open positions remain.`);
          resetGasSpendTracking(agent.id);
          await storage.updateAgent(agent.id, {
            status: "running",
            lastExecutionError: null,
            lastExecutionAt: new Date(),
          });
        }
      }

      if (err.includes("INSUFFICIENT_GAS") || err.toLowerCase().includes("gas check failed")) {
        if (!agent.agentWallet) continue;
        try {
          const gasResult = await checkGasForAgent(agent.agentWallet);
          if (gasResult.ok) {
            console.log(`[AutoResume] Resuming ${agent.name} — was INSUFFICIENT_GAS but gas check now passes. Setting 60s recovery cooldown + session gas budget.`);
            resetGasSpendTracking(agent.id);
            registerTopoffResume(agent.id, gasResult.balanceSui);
            await storage.updateAgent(agent.id, {
              status: "running",
              lastExecutionError: null,
              lastExecutionAt: new Date(),
            });
          }
        } catch (gasErr: any) {
          console.log(`[AutoResume] Gas re-check failed for ${agent.name}: ${gasErr.message}`);
        }
      }

      if (err.includes("GAS_CAP_BREACHED") || err.includes("GAS_BUDGET_EXHAUSTED") || err.includes("budget limit reached")) {
        if (agent.pausedBy === "user") continue;

        const gasStatus = getGasCapStatus(agent.id, agent.totalDeposited || 0);

        const gasResumeFields = {
          status: "running" as const,
          lastExecutionError: null,
          lastExecutionAt: new Date(),
          pausedBy: null,
          pausedReason: null,
          estimatedResumeAt: null,
          gasThrottleLevel: null,
          gasCapBreached: false,
          gasCapBreachedAt: null,
          gasCapReason: null,
          sessionGasUsed: 0,
        };

        if (!gasStatus.breached) {
          console.log(`[AutoResume] Resuming ${agent.name} — gas session has reset (was: ${err.slice(0, 60)}). Session gas now ${gasStatus.sessionGasUsed.toFixed(4)} SUI < ${gasStatus.effectiveCap.toFixed(4)} cap.`);
          resetGasSpendTracking(agent.id);
          registerTopoffResume(agent.id);
          await storage.updateAgent(agent.id, gasResumeFields);
        } else {
          const pausedAt = agent.gasCapBreachedAt ? new Date(agent.gasCapBreachedAt).getTime() : agent.lastExecutionAt ? new Date(agent.lastExecutionAt).getTime() : 0;
          const pauseDuration = now - pausedAt;
          if (pauseDuration > 6 * 60 * 60 * 1000) {
            console.log(`[AutoResume] Force-resuming ${agent.name} — paused for ${(pauseDuration / 3600000).toFixed(1)}h due to gas cap. Resetting session.`);
            resetGasSpendTracking(agent.id);
            registerTopoffResume(agent.id);
            await storage.updateAgent(agent.id, gasResumeFields);
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`[AutoResume] Error: ${err.message}`);
  }
}

async function recoverZombiePositions(): Promise<void> {
  const now = Date.now();
  if (now - lastZombiePositionCheck < ZOMBIE_POSITION_CHECK_INTERVAL_MS) return;
  lastZombiePositionCheck = now;

  try {
    const allAgents = await storage.getAgents();
    const typusAgents = allAgents.filter(a => a.venue === "typus" && a.agentWallet && a.walletAddress);
    let totalRecovered = 0;

    for (const agent of typusAgents) {
      if (zombieCheckInProgress.has(agent.id)) continue;
      zombieCheckInProgress.add(agent.id);
      try {
        const adapter = getAdapter("typus");
        if (!(adapter instanceof TypusAdapter) || !adapter.isReady()) continue;

        const onChainPositions = await adapter.getPositions(agent.walletAddress!);
        if (onChainPositions.length === 0) continue;

        const dbPositions = await storage.getPositions(agent.id);
        const openDbPositionIds = new Set(
          dbPositions.filter(p => p.status === "open" || p.status === "pending_open")
            .map(p => p.onChainPositionId).filter(Boolean)
        );

        for (const ocp of onChainPositions) {
          if (!ocp.positionId) continue;
          if (openDbPositionIds.has(ocp.positionId)) continue;

          const contentMatch = dbPositions.find(p =>
            (p.status === "open" || p.status === "pending_open") &&
            p.entryPrice > 0 && ocp.entryPrice && ocp.entryPrice > 0 &&
            p.side === ocp.side &&
            Math.abs(p.entryPrice - ocp.entryPrice) < 0.001 &&
            Math.abs(p.sizeSui - (ocp.size || 0)) < 1
          );
          if (contentMatch) {
            if (contentMatch.onChainPositionId !== ocp.positionId) {
              await storage.updatePosition(contentMatch.id, { onChainPositionId: ocp.positionId });
            }
            continue;
          }

          let verifiedOpen = true;
          try {
            const priorFill = await adapter.checkPriorCloseFilled(agent.walletAddress!, ocp.positionId);
            if (priorFill.filled) {
              verifiedOpen = false;
            }
          } catch {}
          if (!verifiedOpen) continue;

          const closedMatch = dbPositions.find(p =>
            p.onChainPositionId === ocp.positionId && p.status === "closed" && p.entryPrice > 0
          );

          const matchToReopen = closedMatch || (ocp.entryPrice && ocp.entryPrice > 0 ? dbPositions.find(p =>
            p.status === "closed" && !p.onChainPositionId &&
            p.entryPrice > 0 &&
            p.side === ocp.side &&
            Math.abs(p.entryPrice - ocp.entryPrice) < 0.01 &&
            (ocp.size > 1 ? Math.abs(p.sizeSui - ocp.size) / ocp.size < 0.05 : Math.abs(p.sizeSui - ocp.size) < 0.1)
          ) : null);

          if (matchToReopen) {
            const cmAny = matchToReopen as any;
            const closeState = cmAny.closeState;
            if (closeState === "pending_close" || closeState === "closing") {
              console.log(`[ZombieRecovery] Skipping ${agent.name} pos ${matchToReopen.id}: close in flight (closeState=${closeState})`);
              continue;
            }

            const hasRealCloseTx = matchToReopen.closeTxDigest &&
              matchToReopen.closeTxDigest !== "settled_onchain" &&
              matchToReopen.closeTxDigest !== "position_gone_onchain" &&
              matchToReopen.closeTxDigest !== "closed_externally" &&
              matchToReopen.closeTxDigest !== "cancelled_unfilled" &&
              matchToReopen.closeTxDigest !== "liquidated_onchain" &&
              !matchToReopen.closeTxDigest.startsWith("recovered_") &&
              !matchToReopen.closeTxDigest.startsWith("sim_") &&
              !matchToReopen.closeTxDigest.startsWith("db_");
            if (hasRealCloseTx) {
              continue;
            }

            const hasProperCloseLifecycle = closeState === "closed" && cmAny.closeReason && matchToReopen.closedAt;
            if (hasProperCloseLifecycle) {
              continue;
            }

            if (matchToReopen.closeTxDigest && matchToReopen.closedAt) {
              const closedAgo = Date.now() - new Date(matchToReopen.closedAt).getTime();
              if (closedAgo > 5 * 60 * 1000) {
                continue;
              }
              if (closedAgo < 60_000) {
                console.log(`[ZombieRecovery] Skipping ${agent.name} pos ${matchToReopen.id}: closed ${Math.round(closedAgo / 1000)}s ago — waiting for settlement`);
                continue;
              }
            }

            const posCollateral = ocp.collateral || (ocp.size / (agent.leverage || 25));
            const leverage = agent.leverage || 25;
            const correctLiq = (ocp.side || matchToReopen.side) === "long"
              ? (ocp.entryPrice || matchToReopen.entryPrice) * (1 - 1 / leverage)
              : (ocp.entryPrice || matchToReopen.entryPrice) * (1 + 1 / leverage);
            console.log(`[ZombieRecovery] Re-opening position ${matchToReopen.id} for ${agent.name}: DB says closed but STILL OPEN on-chain (posId=${ocp.positionId})`);
            const notionalSize = matchToReopen.sizeSui > posCollateral * 2 
              ? matchToReopen.sizeSui 
              : posCollateral * leverage;
            await storage.updatePosition(matchToReopen.id, {
              status: "open",
              closeReason: null,
              closeTxDigest: null,
              closedAt: null,
              unrealizedPnl: 0,
              verified: true,
              entryPrice: ocp.entryPrice || matchToReopen.entryPrice,
              sizeSui: notionalSize,
              collateral: posCollateral,
              liquidationPrice: correctLiq,
              onChainPositionId: ocp.positionId,
            });

            const posRewards = await storage.getRewardsByPositionId(matchToReopen.id);
            for (const reward of posRewards) {
              if (reward.status === "pending" && reward.escrowTxDigest === "pending_escrow") {
                await storage.voidReward(reward.id);
                console.log(`[ZombieRecovery] Voided pending reward ${reward.id} for re-opened position ${matchToReopen.id}`);
              }
            }

            try {
              const { invalidateOnChainPortfolioCache } = await import("./routes");
              invalidateOnChainPortfolioCache(agent.id);
            } catch {}
            const updatedPositions = await storage.getPositions(agent.id);
            const openAfterRecovery = updatedPositions.filter(p => p.status === "open" || p.status === "pending_open");
            broadcastPositionUpdate(agent.id, openAfterRecovery.map(p => ({
              id: p.id, side: p.side, sizeSui: p.sizeSui, entryPrice: p.entryPrice,
              markPrice: p.markPrice, unrealizedPnl: p.unrealizedPnl,
              onChainPositionId: p.onChainPositionId, status: p.status,
              closeState: (p as any).closeState, openedAt: p.openedAt,
            })), true);
            if (broadcastFn) {
              broadcastFn("agent:updated", { agentId: agent.id, recovery: true });
            }

            totalRecovered++;
            continue;
          }

          if (!ocp.entryPrice || ocp.entryPrice === 0) continue;

          const alreadyReopened = dbPositions.find(p =>
            p.txDigest === `reopened_${ocp.positionId}` || p.onChainPositionId === ocp.positionId
          );
          if (alreadyReopened) continue;

          const recentlyClosedWithSameId = dbPositions.find(p =>
            p.onChainPositionId === ocp.positionId &&
            p.status === "closed" &&
            p.closedAt &&
            (Date.now() - new Date(p.closedAt).getTime()) < 10 * 60 * 1000
          );
          if (recentlyClosedWithSameId) {
            console.log(`[ZombieRecovery] Skipping ${agent.name} posId=${ocp.positionId}: recently closed ${Math.round((Date.now() - new Date(recentlyClosedWithSameId.closedAt!).getTime()) / 1000)}s ago — not a zombie`);
            continue;
          }

          const posCollateral = ocp.collateral || (ocp.size / (agent.leverage || 25));
          const leverage = agent.leverage || 25;
          const correctLiq = ocp.side === "long"
            ? ocp.entryPrice * (1 - 1 / leverage)
            : ocp.entryPrice * (1 + 1 / leverage);
          console.log(`[ZombieRecovery] Creating NEW managed position for ${agent.name}: on-chain posId=${ocp.positionId}, side=${ocp.side}, size=${ocp.size?.toFixed(2)}, entry=$${ocp.entryPrice.toFixed(4)}`);
          try {
            const notionalSize = posCollateral * leverage;
            const position = await storage.createPosition({
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
            await storage.updatePosition(position.id, { onChainPositionId: ocp.positionId, verified: true });

            try {
              const { invalidateOnChainPortfolioCache } = await import("./routes");
              invalidateOnChainPortfolioCache(agent.id);
            } catch {}
            const updatedPositions2 = await storage.getPositions(agent.id);
            const openAfterCreate = updatedPositions2.filter(p => p.status === "open" || p.status === "pending_open");
            broadcastPositionUpdate(agent.id, openAfterCreate.map(p => ({
              id: p.id, side: p.side, sizeSui: p.sizeSui, entryPrice: p.entryPrice,
              markPrice: p.markPrice, unrealizedPnl: p.unrealizedPnl,
              onChainPositionId: p.onChainPositionId, status: p.status,
              closeState: (p as any).closeState, openedAt: p.openedAt,
            })), true);
            if (broadcastFn) {
              broadcastFn("agent:updated", { agentId: agent.id, recovery: true });
            }

            totalRecovered++;
          } catch (createErr: any) {
            console.log(`[ZombieRecovery] Failed to create position: ${createErr.message}`);
          }
        }
      } catch (err: any) {
        console.log(`[ZombieRecovery] Error checking ${agent.name}: ${err.message?.slice(0, 100)}`);
      } finally {
        zombieCheckInProgress.delete(agent.id);
      }
    }

    if (totalRecovered > 0) {
      console.log(`[ZombieRecovery] Recovered ${totalRecovered} zombie position(s) — now managed by SL/TP monitor`);
    }
  } catch (err: any) {
    console.error(`[ZombieRecovery] Tick error: ${err.message}`);
  }
}

async function recoverStaleClosePositions(currentPrice: number): Promise<void> {
  const now = Date.now();
  if (now - lastStaleCloseCheck < STALE_CLOSE_CHECK_INTERVAL_MS) return;
  lastStaleCloseCheck = now;

  try {
    const allAgents = await storage.getAgents();
    const typusAgents = allAgents.filter(a => a.venue === "typus" && a.agentWallet && a.walletAddress);
    let totalRecovered = 0;

    for (const agent of typusAgents) {
      if (staleCloseInProgress.has(agent.id)) continue;
      if (agentCheckInProgress.has(agent.id)) continue;
      staleCloseInProgress.add(agent.id);
      try {
        const positions = await storage.getPositions(agent.id);
        const staleClosePositions = positions.filter(p => {
          if (p.status !== "open") return false;
          const cs = p as any;
          const closeState = cs.closeState || "open";
          if (closeState !== "close_requested" && closeState !== "manual_review") return false;
          const pendingSince = cs.closePendingSince ? new Date(cs.closePendingSince).getTime() : 0;
          const lastExec = agent.lastExecutionAt ? new Date(agent.lastExecutionAt).getTime() : 0;
          const staleRef = Math.max(pendingSince, lastExec);
          return staleRef === 0 || (now - staleRef) > STALE_CLOSE_AGE_MS;
        });

        if (staleClosePositions.length === 0) continue;

        let hasGas = false;
        try {
          const gasResult = await checkGasForAgent(agent.agentWallet!);
          hasGas = gasResult.ok && gasResult.balanceSui >= 0.05;
        } catch {}
        if (!hasGas) {
          console.log(`[StaleCloseRecovery] Skipping ${agent.name} — insufficient gas for stale close retry.`);
          continue;
        }

        for (const pos of staleClosePositions) {
          const cs = pos as any;
          const closeState = cs.closeState || "close_requested";
          const closeAttempts = cs.closeAttempts || 0;

          const recoveryKey = `${agent.id}:${pos.id}`;
          const priorRecoveries = staleRecoveryAttempts.get(recoveryKey) || 0;
          if (priorRecoveries >= MAX_STALE_RECOVERY_PER_POSITION) {
            continue;
          }

          const adapter = getAdapter("typus");
          if (adapter && adapter instanceof TypusAdapter && pos.onChainPositionId) {
            try {
              const onChainPositions = await adapter.getPositions(agent.walletAddress!);
              const stillOnChain = onChainPositions.some((op: any) => String(op.positionId) === String(pos.onChainPositionId));

              if (!stillOnChain) {
                console.log(`[StaleCloseRecovery] ${agent.name} pos ${pos.id} (onChainId=${pos.onChainPositionId}) is GONE from on-chain — routing through standard close flow.`);
                staleRecoveryAttempts.set(recoveryKey, priorRecoveries + 1);
                try {
                  const result = await closePositionForAgent(
                    { ...agent, agentWallet: agent.agentWallet! },
                    pos.id, currentPrice, true, cs.closeReason || "settled-stale"
                  );
                  if (result.closed) {
                    totalRecovered++;
                    console.log(`[StaleCloseRecovery] Close-settle SUCCESS for ${agent.name} pos ${pos.id}: PnL=${result.pnl.toFixed(4)} SUI`);
                    staleRecoveryAttempts.delete(recoveryKey);
                  } else {
                    console.log(`[StaleCloseRecovery] Close-settle FAILED for ${agent.name} pos ${pos.id}: ${result.error || "unknown"}`);
                  }
                } catch (closeErr: any) {
                  console.log(`[StaleCloseRecovery] Close-settle error for ${agent.name} pos ${pos.id}: ${closeErr.message?.slice(0, 100)}`);
                }
                continue;
              }
            } catch (err: any) {
              console.log(`[StaleCloseRecovery] On-chain check failed for ${agent.name} pos ${pos.id}: ${err.message?.slice(0, 80)}`);
            }
          }

          staleRecoveryAttempts.set(recoveryKey, priorRecoveries + 1);
          console.log(`[StaleCloseRecovery] Retrying close for ${agent.name} pos ${pos.id} (state=${closeState}, attempts=${closeAttempts}, recovery=${priorRecoveries + 1}/${MAX_STALE_RECOVERY_PER_POSITION}, onChainId=${pos.onChainPositionId || "NONE"}).`);

          const { updateCloseState: ucs } = await import("./dex/execution-engine");
          await ucs(pos.id, { closeState: "close_requested", closePendingSince: null });

          try {
            const closeReason = cs.closeReason || "stale-recovery";
            const result = await closePositionForAgent(
              { ...agent, agentWallet: agent.agentWallet! },
              pos.id, currentPrice, false, closeReason
            );
            if (result.closed) {
              totalRecovered++;
              console.log(`[StaleCloseRecovery] Close SUCCESS for ${agent.name} pos ${pos.id}: PnL=${result.pnl.toFixed(4)} SUI`);
              staleRecoveryAttempts.delete(recoveryKey);
            } else {
              console.log(`[StaleCloseRecovery] Close FAILED for ${agent.name} pos ${pos.id}: ${result.error || "unknown"}`);
            }
          } catch (closeErr: any) {
            console.log(`[StaleCloseRecovery] Close error for ${agent.name} pos ${pos.id}: ${closeErr.message?.slice(0, 100)}`);
          }
        }
      } catch (err: any) {
        console.log(`[StaleCloseRecovery] Error checking ${agent.name}: ${err.message?.slice(0, 100)}`);
      } finally {
        staleCloseInProgress.delete(agent.id);
      }
    }

    if (totalRecovered > 0) {
      console.log(`[StaleCloseRecovery] Recovered ${totalRecovered} stale close position(s)`);
    }
  } catch (err: any) {
    console.error(`[StaleCloseRecovery] Tick error: ${err.message}`);
  }
}

async function healContradictoryPositionStates(): Promise<void> {
  const now = Date.now();
  if (now - lastContradictoryStateCheck < CONTRADICTORY_STATE_CHECK_INTERVAL_MS) return;
  lastContradictoryStateCheck = now;

  try {
    const allAgents = await storage.getAgents();
    let totalHealed = 0;

    for (const agent of allAgents) {
      const positions = await storage.getPositions(agent.id);

      for (const pos of positions) {
        const cs = pos as any;
        const closeState = cs.closeState || "open";

        if (pos.status === "closed" && closeState !== "closed") {
          const hasSyntheticDigest = !pos.closeTxDigest ||
            pos.closeTxDigest === "settled_onchain" ||
            pos.closeTxDigest === "position_gone_onchain" ||
            pos.closeTxDigest === "liquidated_onchain" ||
            pos.closeTxDigest === "closed_externally" ||
            pos.closeTxDigest === "cancelled_unfilled" ||
            pos.closeTxDigest?.startsWith("recovered_") ||
            pos.closeTxDigest?.startsWith("sim_") ||
            pos.closeTxDigest?.startsWith("db_");

          const hasRealDigest = pos.closeTxDigest && !hasSyntheticDigest;

          if (hasRealDigest || hasSyntheticDigest) {
            console.log(`[StateHeal] ${agent.name} pos ${pos.id}: status=closed but closeState=${closeState} — healing to closeState=closed (closeTxDigest=${pos.closeTxDigest?.slice(0, 20)})`);
            await storage.updatePosition(pos.id, { closeState: "closed" });
            totalHealed++;
          }
        }

        if (pos.status === "open" && !pos.closeTxDigest && pos.openedAt) {
          const ageMs = Date.now() - new Date(pos.openedAt).getTime();
          if (ageMs > 5 * 60 * 1000 && agent.walletAddress) {
            let onChainStatus: "on_chain" | "not_on_chain" | "unknown" = "unknown";
            try {
              const adapter = getAdapter("typus");
              if (adapter instanceof TypusAdapter && adapter.isReady()) {
                const onChainPositions = await adapter.getPositions(agent.walletAddress);
                const hasValidId = pos.onChainPositionId && !pos.onChainPositionId.includes("-");
                const matchById = hasValidId && onChainPositions.some((op: any) => String(op.positionId) === String(pos.onChainPositionId));
                const matchBySideSize = onChainPositions.some((op: any) => op.side === pos.side && Math.abs(op.size - pos.sizeSui) < 1);
                onChainStatus = (matchById || matchBySideSize) ? "on_chain" : "not_on_chain";
              }
            } catch {
              onChainStatus = "unknown";
            }
            if (onChainStatus === "not_on_chain") {
              const collateral = pos.collateral || (pos.sizeSui / agent.leverage);
              let healPnl = pos.unrealizedPnl || 0;
              const exitPrice = pos.markPrice || 0;
              if (exitPrice > 0 && pos.entryPrice > 0) {
                const pricePnl = pos.side === "long"
                  ? (exitPrice - pos.entryPrice) * pos.sizeSui / exitPrice
                  : (pos.entryPrice - exitPrice) * pos.sizeSui / exitPrice;
                healPnl = Math.min(collateral * 5, Math.max(-collateral, pricePnl));
              } else {
                healPnl = Math.min(collateral * 5, Math.max(-collateral, healPnl));
              }

              let keeperTxDigest: string | null = null;
              let keeperCloseReason = cs.closeReason || "healed-not-onchain";
              if (pos.onChainPositionId && agent.walletAddress) {
                try {
                  const adapter = getAdapter("typus");
                  if (adapter instanceof TypusAdapter && adapter.isReady()) {
                    const priorFill = await adapter.checkPriorCloseFilled(agent.walletAddress, pos.onChainPositionId);
                    if (priorFill.filled && priorFill.txDigest) {
                      keeperTxDigest = priorFill.txDigest;
                      keeperCloseReason = cs.closeReason || "keeper-filled";
                      console.log(`[StateHeal] ${agent.name} pos ${pos.id}: keeper fill confirmed (tx: ${keeperTxDigest})`);
                    }
                  }
                } catch {}
              }

              console.log(`[StateHeal] ${agent.name} pos ${pos.id}: status=open, closeTxDigest=null, age=${Math.round(ageMs/60000)}min, NOT on-chain — healing to closed, PnL=${healPnl.toFixed(4)}${keeperTxDigest ? " (keeper-filled)" : ""}`);
              await storage.updatePosition(pos.id, {
                status: "closed",
                closeState: "closed",
                closedAt: pos.closedAt || new Date(),
                closeReason: keeperCloseReason,
                closeTxDigest: keeperTxDigest || "position_gone_onchain",
                unrealizedPnl: healPnl,
              });
              totalHealed++;
              continue;
            }
          }
        }

        if (pos.status === "open" && (pos.closeTxDigest === "settled_onchain" || pos.closeTxDigest === "liquidated_onchain" || pos.closeTxDigest === "position_gone_onchain")) {
          let onChainStatus: "on_chain" | "not_on_chain" | "unknown" = "unknown";
          if (pos.onChainPositionId && agent.walletAddress) {
            try {
              const adapter = getAdapter("typus");
              if (adapter instanceof TypusAdapter && adapter.isReady()) {
                const onChainPositions = await adapter.getPositions(agent.walletAddress);
                onChainStatus = onChainPositions.some((op: any) => String(op.positionId) === String(pos.onChainPositionId))
                  ? "on_chain" : "not_on_chain";
              }
            } catch {
              onChainStatus = "unknown";
            }
          }

          if (onChainStatus === "not_on_chain") {
            let keeperDigest: string | null = null;
            if (pos.onChainPositionId && agent.walletAddress) {
              try {
                const adapter = getAdapter("typus");
                if (adapter instanceof TypusAdapter && adapter.isReady()) {
                  const priorFill = await adapter.checkPriorCloseFilled(agent.walletAddress, pos.onChainPositionId);
                  if (priorFill.filled && priorFill.txDigest) {
                    keeperDigest = priorFill.txDigest;
                    console.log(`[StateHeal] ${agent.name} pos ${pos.id}: keeper fill confirmed (tx: ${keeperDigest})`);
                  }
                }
              } catch {}
            }
            console.log(`[StateHeal] ${agent.name} pos ${pos.id}: status=open but closeTxDigest=${pos.closeTxDigest} and NOT on-chain — healing to closed${keeperDigest ? " (keeper-filled)" : ""}`);
            await storage.updatePosition(pos.id, {
              status: "closed",
              closeState: "closed",
              closedAt: pos.closedAt || new Date(),
              closeReason: (cs.closeReason || (keeperDigest ? "keeper-filled" : "settled-onchain")),
              closeTxDigest: keeperDigest || pos.closeTxDigest,
            } as any);
            totalHealed++;
          } else if (onChainStatus === "on_chain") {
            if (pos.closedAt) {
              const closedAgo = Date.now() - new Date(pos.closedAt).getTime();
              if (closedAgo < 10 * 60 * 1000) {
                continue;
              }
            }
            console.log(`[StateHeal] ${agent.name} pos ${pos.id}: has synthetic closeTxDigest but IS still on-chain — clearing close fields, re-opening`);
            await storage.updatePosition(pos.id, {
              closeTxDigest: null,
              closeState: "open",
              closeReason: null,
              closedAt: null,
            });
            totalHealed++;
          }
        }
      }
    }

    if (totalHealed > 0) {
      console.log(`[StateHeal] Healed ${totalHealed} contradictory position state(s)`);
    }
  } catch (err: any) {
    console.error(`[StateHeal] Error: ${err.message}`);
  }
}

let tickRunning = false;

async function retryPendingEscrows() {
  const now = Date.now();
  if (now - lastEscrowRetryCheck < ESCROW_RETRY_INTERVAL_MS) return;
  lastEscrowRetryCheck = now;

  try {
    const rewards = await storage.getRewards();
    const pendingEscrow = rewards.filter(r => r.status === "pending" && r.escrowTxDigest === "pending_escrow");
    if (pendingEscrow.length === 0) return;

    const agentIds = [...new Set(pendingEscrow.map(r => r.agentId))];
    let escrowed = 0;

    for (const agentId of agentIds) {
      const agent = await storage.getAgent(agentId);
      if (!agent?.agentWallet || !agent?.walletAddress) continue;

      try {
        const { getOnChainBalance } = await import("./sui-verify");
        const bal = await getOnChainBalance(agent.walletAddress);
        if (bal.sui < 0.5) continue;

        const agentRewards = pendingEscrow.filter(r => r.agentId === agentId).sort((a, b) => a.amount - b.amount);

        for (const reward of agentRewards) {
          try {
            const { getOnChainBalance: getBalFresh } = await import("./sui-verify");
            const freshBal = await getBalFresh(agent.walletAddress);
            if (freshBal.sui < reward.amount + 0.15) break;

            const { escrowRewardFromAgent } = await import("./reward-wallet");
            const escrowResult = await escrowRewardFromAgent(agent.agentWallet, agent.walletAddress, reward.amount);
            await storage.updateReward(reward.id, { escrowTxDigest: escrowResult.txDigest });
            escrowed++;
            console.log(`[EscrowRetry] Escrowed ${reward.amount.toFixed(4)} SUI for ${agent.name} reward ${reward.id} — tx: ${escrowResult.txDigest}`);
            await new Promise(r => setTimeout(r, 2000));
          } catch (err: any) {
            console.log(`[EscrowRetry] Failed for ${agent.name} reward ${reward.id}: ${err.message?.slice(0, 100)}`);
            break;
          }
        }
      } catch {}
    }

    if (escrowed > 0) {
      console.log(`[EscrowRetry] Escrowed ${escrowed} pending rewards this cycle`);
    }
  } catch (err: any) {
    console.error(`[EscrowRetry] Error: ${err.message}`);
  }
}

const MAX_COLLATERAL_LOSS_PCT = 4;

let rapidTickRunning = false;
const rapidCloseInProgress = new Set<string>();

async function rapidMonitorTick() {
  if (rapidTickRunning) return;
  rapidTickRunning = true;
  try {
    const lastPrice = getLastPrice();
    if (!lastPrice || !lastPrice.pyth || lastPrice.pyth.price <= 0) return;
    const currentPrice = lastPrice.blended;
    if (currentPrice <= 0) return;

    const agents = await storage.getAgentsWithSignalAgents();
    for (const agent of agents) {
      if (agent.status !== "running" && agent.status !== "idle" && agent.status !== "recovered") continue;
      const positions = await storage.getPositions(agent.id);
      const openPositions = positions.filter(p => p.status === "open" || p.status === "pending_open");
      if (openPositions.length === 0) continue;

      const leverage = agent.leverage || 25;
      const liquidationMovePct = (1 / leverage) * 100;
      const slBps = agent.stopLossBps || 80;
      const maxCollLossPct = MAX_COLLATERAL_LOSS_PCT;
      const effectiveSLPct = Math.min(slBps / 100, maxCollLossPct / leverage, liquidationMovePct * 0.60);

      for (const pos of openPositions) {
        if (rapidCloseInProgress.has(pos.id)) continue;

        const priceMovePct = pos.side === "long"
          ? ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100
          : ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

        if (priceMovePct <= 0) continue;

        const distanceToLiquidationPct = liquidationMovePct - priceMovePct;
        const distanceToSLPct = effectiveSLPct - priceMovePct;
        const isApproachingSL = priceMovePct >= effectiveSLPct * 0.85;
        const isNearLiquidation = distanceToLiquidationPct < liquidationMovePct * 0.4;

        if (isApproachingSL || isNearLiquidation) {
          const reason = isNearLiquidation
            ? `RAPID: ${distanceToLiquidationPct.toFixed(3)}% to liquidation`
            : `RAPID: SL approaching (${priceMovePct.toFixed(3)}% adverse vs ${effectiveSLPct.toFixed(3)}% SL)`;

          rapidCloseInProgress.add(pos.id);
          console.log(`[RapidMonitor] ${agent.name} pos ${pos.id} ${pos.side.toUpperCase()} — ${reason} | price=$${currentPrice.toFixed(4)} entry=$${pos.entryPrice.toFixed(4)} | lev=${leverage}x liq=${liquidationMovePct.toFixed(2)}%`);

          const closeReason = isNearLiquidation ? "emergency-liquidation-prevent" : "stop-loss";
          closePositionForAgent(agent, pos.id, currentPrice, false, closeReason)
            .then(result => {
              if (result.closed) {
                console.log(`[RapidMonitor] CLOSED ${agent.name} pos ${pos.id}: pnl=${result.pnl.toFixed(4)} SUI (${closeReason})`);
              } else {
                console.log(`[RapidMonitor] Close attempt for ${agent.name} pos ${pos.id}: ${result.error || "not closed"}`);
              }
            })
            .catch(err => {
              console.error(`[RapidMonitor] Close error for ${agent.name} pos ${pos.id}: ${err.message}`);
            })
            .finally(() => {
              setTimeout(() => rapidCloseInProgress.delete(pos.id), 30000);
            });
        }
      }
    }
  } catch (err: any) {
    console.error(`[RapidMonitor] Tick error: ${err.message}`);
  } finally {
    rapidTickRunning = false;
  }
}

async function monitorTick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const lastPrice = getLastPrice();
    if (!lastPrice || !lastPrice.pyth || lastPrice.pyth.price <= 0) {
      return;
    }

    const currentPrice = lastPrice.blended;
    if (currentPrice <= 0) return;

    processPendingCloseOrders().catch((err: any) => {
      console.error(`[PositionMonitor] processPendingCloseOrders error: ${err.message}`);
    });

    recoverBlockedAgents(currentPrice).catch((err: any) => {
      console.error(`[PositionMonitor] recoverBlockedAgents error: ${err.message}`);
    });

    autoResumePausedAgents().catch((err: any) => {
      console.error(`[PositionMonitor] autoResumePausedAgents error: ${err.message}`);
    });

    retryPendingEscrows().catch((err: any) => {
      console.error(`[PositionMonitor] retryPendingEscrows error: ${err.message}`);
    });

    recoverZombiePositions().catch((err: any) => {
      console.error(`[PositionMonitor] recoverZombiePositions error: ${err.message}`);
    });

    recoverStaleClosePositions(currentPrice).catch((err: any) => {
      console.error(`[PositionMonitor] recoverStaleClosePositions error: ${err.message}`);
    });

    healContradictoryPositionStates().catch((err: any) => {
      console.error(`[PositionMonitor] healContradictoryPositionStates error: ${err.message}`);
    });

    const agents = await storage.getAgentsWithSignalAgents();

    for (let agentIndex = 0; agentIndex < agents.length; agentIndex++) {
      const agent = agents[agentIndex];
      if (agent.status !== "running" && agent.status !== "idle" && agent.status !== "paused" && agent.status !== "recovered") {
        continue;
      }

      if (agent.status === "running" && agent.lastExecutionError) {
        const errAge = agent.lastExecutionAt ? Date.now() - new Date(agent.lastExecutionAt).getTime() : 300000;
        const errStr = agent.lastExecutionError || "";

        if (errStr.includes("INSUFFICIENT_GAS") || errStr.toLowerCase().includes("gas check failed")) {
          if (errAge > 30000 && agent.agentWallet) {
            try {
              const gasResult = await checkGasForAgent(agent.agentWallet);
              if (gasResult.ok) {
                await storage.updateAgent(agent.id, { lastExecutionError: null });
                console.log(`[PositionMonitor] Cleared INSUFFICIENT_GAS error for ${agent.name}`);
              }
            } catch {}
          }
        } else if (errAge > 120000) {
          try {
            await storage.updateAgent(agent.id, { lastExecutionError: null });
          } catch {}
        }
      }

      const lastErr = agent.lastExecutionError || "";
      if (lastErr.includes("INSUFFICIENT_GAS") && lastErr.includes("below minimum executable gas")) {
        continue;
      }

      if (agentCheckInProgress.has(agent.id)) continue;

      agentCheckInProgress.add(agent.id);
      try {
        await checkAndClosePositions(agent, currentPrice);
        try {
          const positions = await storage.getPositions(agent.id);
          const openPositions = positions.filter(p => p.status === "open" || p.status === "pending_open");
          if (openPositions.length > 0) {
            broadcastPositionUpdate(agent.id, openPositions.map(p => ({
              id: p.id,
              side: p.side,
              sizeSui: p.sizeSui,
              entryPrice: p.entryPrice,
              markPrice: p.markPrice,
              unrealizedPnl: p.unrealizedPnl,
              onChainPositionId: p.onChainPositionId,
              status: p.status,
              closeState: (p as any).closeState,
              openedAt: p.openedAt,
            })));
          }
        } catch {}
      } catch (err: any) {
        console.error(`[PositionMonitor] SL/TP check error for ${agent.name}: ${err.message}`);
      } finally {
        agentCheckInProgress.delete(agent.id);
      }

      if (agentIndex < agents.length - 1) {
        await new Promise(r => setTimeout(r, 800));
      }
    }
  } catch (err: any) {
    console.error(`[PositionMonitor] Tick error: ${err.message}`);
  } finally {
    tickRunning = false;
  }
}

let reconciliationRunning = false;

async function periodicReconciliation(): Promise<void> {
  if (reconciliationRunning) return;
  reconciliationRunning = true;
  try {
    const agents = await storage.getAgentsWithSignalAgents();
    for (const agent of agents) {
      if (!agent.walletAddress) continue;
      if (agent.status !== "running" && agent.status !== "idle" && agent.status !== "paused" && agent.status !== "recovered") continue;

      try {
        const { getOnChainBalance } = await import("./sui-verify");
        const onChain = await getOnChainBalance(agent.walletAddress);
        const positions = await storage.getPositions(agent.id);
        const openPos = positions.filter(p => (p.status === "open" || p.status === "pending_open"));
        let lockedCollateral = openPos.reduce((sum, p) => sum + (p.collateral || p.sizeSui / agent.leverage), 0);

        const hasUnresolved = openPos.some(p => !p.onChainPositionId || p.status === "pending_open");
        if (!hasUnresolved && openPos.length > 0) {
          try {
            const adapter = getAdapter(agent.venue || "typus");
            if (adapter && agent.walletAddress) {
              const onChainPositions = await adapter.getPositions(agent.walletAddress);
              const dbIds = new Set(openPos.map(p => p.onChainPositionId).filter(Boolean));
              for (const ocp of onChainPositions) {
                if (!dbIds.has(ocp.positionId)) {
                  lockedCollateral += ocp.collateral || 0;
                }
              }
            }
          } catch {}
        }

        const onChainTotal = onChain.sui + lockedCollateral;
        const latestAgent = await storage.getAgent(agent.id);
        if (!latestAgent) continue;

        if (Math.abs(onChainTotal - latestAgent.balance) > 0.1) {
          console.log(`[PeriodicRecon] Balance correction for ${agent.name}: DB=${latestAgent.balance.toFixed(4)} → on-chain=${onChainTotal.toFixed(4)} (wallet=${onChain.sui.toFixed(4)}, locked=${lockedCollateral.toFixed(4)})`);
          await storage.updateAgent(agent.id, { balance: onChainTotal });

          if (broadcastFn) {
            broadcastFn("agent:updated", { agentId: agent.id, balance: onChainTotal });
          }
        }
      } catch (err: any) {
        if (!err.message?.includes("429")) {
          console.log(`[PeriodicRecon] Error reconciling ${agent.name}: ${err.message?.slice(0, 80)}`);
        }
      }
    }
  } catch (err: any) {
    console.error(`[PeriodicRecon] Reconciliation tick error: ${err.message}`);
  } finally {
    reconciliationRunning = false;
  }
}

let portfolioAuditRunning = false;
let portfolioAuditInterval: ReturnType<typeof setInterval> | null = null;
const PORTFOLIO_AUDIT_INTERVAL_MS = 30_000;

async function periodicPortfolioAudit(): Promise<void> {
  if (portfolioAuditRunning) return;
  portfolioAuditRunning = true;
  try {
    const cache = (globalThis as any).__onChainPortfolioCache as Map<string, any> | undefined;
    if (!cache) return;

    const agents = await storage.getAgentsWithSignalAgents();
    const { getOnChainBalance } = await import("./sui-verify");

    for (const agent of agents) {
      if (!agent.walletAddress) continue;
      if (agent.status !== "running" && agent.status !== "idle" && agent.status !== "paused" && agent.status !== "recovered") continue;

      try {
        const onChain = await getOnChainBalance(agent.walletAddress);
        const freeSui = onChain.sui;

        if (!Number.isFinite(freeSui) || freeSui < 0) continue;

        const dbPositions = await storage.getOpenPositions(agent.id);
        let totalLocked = 0;
        const positionData: Array<{ positionId: string; side: string; size: number; collateral: number; entryPrice: number }> = [];
        for (const p of dbPositions) {
          if (p.closeState === "closed" || p.closeTxDigest) continue;
          const collateral = Number(p.collateral) || 0;
          if (!Number.isFinite(collateral)) continue;
          totalLocked += collateral;
          positionData.push({
            positionId: p.onChainPositionId || p.id,
            side: p.side,
            size: Number(p.sizeSui || p.size) || 0,
            collateral,
            entryPrice: Number(p.entryPrice) || 0,
          });
        }

        if (!Number.isFinite(totalLocked)) continue;

        const existing = cache.get(agent.id);
        const existingSource = existing?.source || "initial-db";
        cache.set(agent.id, {
          freeSui,
          positions: positionData,
          totalLocked,
          timestamp: Date.now(),
          source: existingSource === "on-chain" ? "on-chain" : "audit-refreshed",
        });
      } catch (err: any) {
        // Skip agent on error, don't break the loop
      }
    }
  } catch (err: any) {
    console.error(`[PositionMonitor] Portfolio audit error: ${err.message}`);
  } finally {
    portfolioAuditRunning = false;
  }
}

export function startPositionMonitor() {
  if (monitorInterval) return;

  console.log(`[PositionMonitor] Started — checking SL/TP every ${MONITOR_INTERVAL_MS / 1000}s, rapid monitor every ${RAPID_MONITOR_INTERVAL_MS}ms`);
  monitorInterval = setInterval(monitorTick, MONITOR_INTERVAL_MS);
  rapidMonitorInterval = setInterval(rapidMonitorTick, RAPID_MONITOR_INTERVAL_MS);
  reconciliationInterval = setInterval(periodicReconciliation, RECONCILIATION_INTERVAL_MS);
  portfolioAuditInterval = setInterval(periodicPortfolioAudit, PORTFOLIO_AUDIT_INTERVAL_MS);

  setTimeout(monitorTick, 500);
  setTimeout(rapidMonitorTick, 1000);
  setTimeout(periodicReconciliation, 15000);
  setTimeout(periodicPortfolioAudit, 5000);
}

export function stopPositionMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    console.log("[PositionMonitor] Stopped");
  }
  if (rapidMonitorInterval) {
    clearInterval(rapidMonitorInterval);
    rapidMonitorInterval = null;
  }
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
    reconciliationInterval = null;
  }
  if (portfolioAuditInterval) {
    clearInterval(portfolioAuditInterval);
    portfolioAuditInterval = null;
  }
}
