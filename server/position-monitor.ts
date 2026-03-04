import { storage } from "./storage";
import { getLastPrice } from "./price-service";
import { checkAndClosePositions, processPendingCloseOrders, closePositionForAgent, clearCloseGasTrackingExternal, resetGasSpendTracking } from "./dex/execution-engine";

const MONITOR_INTERVAL_MS = 1000;
let monitorInterval: ReturnType<typeof setInterval> | null = null;

const agentCheckInProgress = new Set<string>();
let lastBlockedRecoveryCheck = 0;
const BLOCKED_RECOVERY_INTERVAL_MS = 120_000;
const blockedRecoveryInProgress = new Set<string>();
const MAX_RECOVERY_ATTEMPTS_PER_POSITION = 10;
const recoveryAttemptCount = new Map<string, number>();

let lastAutoResumeCheck = 0;
const AUTO_RESUME_INTERVAL_MS = 60_000;
const AUTO_RESUME_COOLDOWN_MS = 300_000;

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
            const recoveryKey = `${agent.id}:${pos.id}`;
            const priorRecoveries = recoveryAttemptCount.get(recoveryKey) || 0;
            if (priorRecoveries >= MAX_RECOVERY_ATTEMPTS_PER_POSITION) {
              console.log(`[BlockedRecovery] Skipping ${agent.name} pos ${pos.id} — already attempted ${priorRecoveries} recoveries (max ${MAX_RECOVERY_ATTEMPTS_PER_POSITION}).`);
              continue;
            }

            const closeAttempts = (pos as any).closeAttempts || 0;
            const errorType = isGasCap ? "CLOSE_GAS_CAP" : "CLOSE_PERMANENTLY_BLOCKED";
            console.log(`[BlockedRecovery] Retrying close for ${agent.name} pos ${pos.id} (was ${errorType}, DB attempts=${closeAttempts}, recoveries=${priorRecoveries}). Resetting all tracking — emergency priority.`);
            clearCloseGasTrackingExternal(pos.id);
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
        const pausedAt = agent.lastExecutionAt ? new Date(agent.lastExecutionAt).getTime() : 0;
        if (now - pausedAt >= AUTO_RESUME_COOLDOWN_MS) {
          console.log(`[AutoResume] Resuming ${agent.name} after ${Math.round((now - pausedAt) / 1000)}s cooldown (was: ${err.slice(0, 60)})`);
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
    }
  } catch (err: any) {
    console.error(`[AutoResume] Error: ${err.message}`);
  }
}

async function monitorTick() {
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

    const agents = await storage.getAgentsWithSignalAgents();

    const checkPromises: Promise<void>[] = [];

    for (const agent of agents) {
      if (agent.status !== "running" && agent.status !== "idle" && agent.status !== "paused" && agent.status !== "recovered") continue;

      if (agent.status === "running" && agent.lastExecutionError) {
        const errAge = agent.lastExecutionAt ? Date.now() - new Date(agent.lastExecutionAt).getTime() : 300000;
        if (errAge > 120000) {
          try {
            await storage.updateAgent(agent.id, { lastExecutionError: null });
            console.log(`[PositionMonitor] Cleared stale execution error for ${agent.name} (error was ${Math.round(errAge / 1000)}s old)`);
          } catch {}
        }
      }

      if (agent.status === "paused" && agent.lastExecutionError) {
        const err = agent.lastExecutionError;
        if (err.includes("CLOSE_PERMANENTLY_BLOCKED")) {
          continue;
        }
        if (err.includes("CLOSE_GAS_CAP") || err.includes("SPEND_CAP")) {
          const positions = await storage.getPositions(agent.id);
          const hasOpenPositions = positions.some(p => p.status === "open" || p.status === "pending_open");
          if (!hasOpenPositions) {
            continue;
          }
        }
      }

      if (agentCheckInProgress.has(agent.id)) {
        continue;
      }

      agentCheckInProgress.add(agent.id);
      checkPromises.push(
        checkAndClosePositions(agent, currentPrice)
          .catch((err: any) => {
            console.error(`[PositionMonitor] SL/TP check error for ${agent.name}: ${err.message}`);
          })
          .finally(() => {
            agentCheckInProgress.delete(agent.id);
          })
      );
    }

    if (checkPromises.length > 0) {
      await Promise.allSettled(checkPromises);
    }
  } catch (err: any) {
    console.error(`[PositionMonitor] Tick error: ${err.message}`);
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
