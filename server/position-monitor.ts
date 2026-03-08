import { storage } from "./storage";
import { getLastPrice } from "./price-service";
import { checkAndClosePositions, processPendingCloseOrders, closePositionForAgent, clearCloseGasTrackingExternal, resetGasSpendTracking, isDailyGasCapReset, checkGasForAgent, registerTopoffResume } from "./dex/execution-engine";
import { getAdapter } from "./dex/index";
import { TypusAdapter } from "./dex/typus-adapter";

const MONITOR_INTERVAL_MS = 10000;
let monitorInterval: ReturnType<typeof setInterval> | null = null;
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
const ZOMBIE_POSITION_CHECK_INTERVAL_MS = 300_000;
const zombieCheckInProgress = new Set<string>();

const lastSkipLog = new Map<string, number>();
const SKIP_LOG_THROTTLE_MS = 60_000;

function logSkipReason(agentId: string, agentName: string, reason: string) {
  const now = Date.now();
  const lastLog = lastSkipLog.get(agentId) || 0;
  if (now - lastLog < SKIP_LOG_THROTTLE_MS) return;
  lastSkipLog.set(agentId, now);
  console.log(`[PositionMonitor] Skip ${agentName}: ${reason}`);
}

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
            const closeState = (matchToReopen as any).closeState;
            if (closeState === "pending_close" || closeState === "closing") {
              console.log(`[ZombieRecovery] Skipping ${agent.name} pos ${matchToReopen.id}: close in flight (closeState=${closeState})`);
              continue;
            }
            if (matchToReopen.closedAt) {
              const closedAgo = Date.now() - new Date(matchToReopen.closedAt).getTime();
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
            await storage.updatePosition(matchToReopen.id, {
              status: "open",
              closeReason: null,
              closeTxDigest: null,
              closedAt: null,
              unrealizedPnl: 0,
              verified: true,
              entryPrice: ocp.entryPrice || matchToReopen.entryPrice,
              sizeSui: ocp.size || matchToReopen.sizeSui,
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

            totalRecovered++;
            continue;
          }

          if (!ocp.entryPrice || ocp.entryPrice === 0) continue;

          const alreadyReopened = dbPositions.find(p =>
            p.txDigest === `reopened_${ocp.positionId}` || p.onChainPositionId === ocp.positionId
          );
          if (alreadyReopened) continue;

          const posCollateral = ocp.collateral || (ocp.size / (agent.leverage || 25));
          const leverage = agent.leverage || 25;
          const correctLiq = ocp.side === "long"
            ? ocp.entryPrice * (1 - 1 / leverage)
            : ocp.entryPrice * (1 + 1 / leverage);
          console.log(`[ZombieRecovery] Creating NEW managed position for ${agent.name}: on-chain posId=${ocp.positionId}, side=${ocp.side}, size=${ocp.size?.toFixed(2)}, entry=$${ocp.entryPrice.toFixed(4)}`);
          try {
            const position = await storage.createPosition({
              agentId: agent.id,
              symbol: "SUI-USDC",
              side: ocp.side || "long",
              sizeSui: ocp.size || posCollateral * leverage,
              collateral: posCollateral,
              entryPrice: ocp.entryPrice,
              markPrice: ocp.entryPrice,
              unrealizedPnl: 0,
              liquidationPrice: correctLiq,
              txDigest: `reopened_${ocp.positionId}`,
            });
            await storage.updatePosition(position.id, { onChainPositionId: ocp.positionId, verified: true });
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

    const agents = await storage.getAgentsWithSignalAgents();

    const runningAgents = agents;

    for (let agentIndex = 0; agentIndex < runningAgents.length; agentIndex++) {
      const agent = runningAgents[agentIndex];
      if (agent.status !== "running" && agent.status !== "idle" && agent.status !== "paused" && agent.status !== "recovered") {
        logSkipReason(agent.id, agent.name, `status="${agent.status}" — not in active set`);
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
                console.log(`[PositionMonitor] Cleared INSUFFICIENT_GAS error for ${agent.name} — gas check now passes`);
              }
            } catch {}
          }
        } else if (errAge > 120000) {
          try {
            await storage.updateAgent(agent.id, { lastExecutionError: null });
            console.log(`[PositionMonitor] Cleared stale execution error for ${agent.name} (error was ${Math.round(errAge / 1000)}s old)`);
          } catch {}
        }
      }

      if (agent.status === "paused" && agent.lastExecutionError) {
        const err = agent.lastExecutionError;
        logSkipReason(agent.id, agent.name, `paused — ${err.slice(0, 80)} (SL/TP still active)`);
      }

      if (agent.status === "idle") {
        logSkipReason(agent.id, agent.name, `status=idle — waiting for activation`);
      }

      const lastErr = agent.lastExecutionError || "";
      if (lastErr.includes("INSUFFICIENT_GAS") && lastErr.includes("below minimum executable gas")) {
        logSkipReason(agent.id, agent.name, `INSUFFICIENT_GAS — wallet too low for any TX, waiting for top-up`);
        continue;
      }

      if (agentCheckInProgress.has(agent.id)) {
        continue;
      }

      agentCheckInProgress.add(agent.id);
      try {
        await checkAndClosePositions(agent, currentPrice);
        try {
          const positions = await storage.getPositions(agent.id);
          const openPositions = positions.filter(p => p.status === "open" || p.status === "pending_open");
          if (openPositions.length > 0) {
            const posData = openPositions.map(p => ({
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
            }));
            broadcastPositionUpdate(agent.id, posData);
          }
        } catch {}
      } catch (err: any) {
        console.error(`[PositionMonitor] SL/TP check error for ${agent.name}: ${err.message}`);
      } finally {
        agentCheckInProgress.delete(agent.id);
      }

      if (agentIndex < runningAgents.length - 1) {
        await new Promise(r => setTimeout(r, 800));
      }
    }
  } catch (err: any) {
    console.error(`[PositionMonitor] Tick error: ${err.message}`);
  } finally {
    tickRunning = false;
  }
}

export function startPositionMonitor() {
  if (monitorInterval) return;

  console.log(`[PositionMonitor] Started — checking SL/TP every ${MONITOR_INTERVAL_MS / 1000}s`);
  monitorInterval = setInterval(monitorTick, MONITOR_INTERVAL_MS);

  setTimeout(monitorTick, 500);
}

export function stopPositionMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    console.log("[PositionMonitor] Stopped");
  }
}
