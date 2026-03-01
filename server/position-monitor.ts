import { storage } from "./storage";
import { getLastPrice } from "./price-service";
import { checkAndClosePositions, processPendingCloseOrders, closePositionForAgent } from "./dex/execution-engine";

const MONITOR_INTERVAL_MS = 1000;
let monitorInterval: ReturnType<typeof setInterval> | null = null;

const agentCheckInProgress = new Set<string>();
let lastBlockedRecoveryCheck = 0;
const BLOCKED_RECOVERY_INTERVAL_MS = 60_000;
const blockedRecoveryInProgress = new Set<string>();

async function recoverBlockedAgents(currentPrice: number) {
  const now = Date.now();
  if (now - lastBlockedRecoveryCheck < BLOCKED_RECOVERY_INTERVAL_MS) return;
  lastBlockedRecoveryCheck = now;

  try {
    const agents = await storage.getAgentsWithSignalAgents();
    for (const agent of agents) {
      if (agent.status !== "paused") continue;
      if (!agent.lastExecutionError?.includes("CLOSE_PERMANENTLY_BLOCKED")) continue;
      if (blockedRecoveryInProgress.has(agent.id)) continue;

      const positions = await storage.getPositions(agent.id);
      const openPositions = positions.filter(p => p.status === "open");
      if (openPositions.length === 0) continue;

      blockedRecoveryInProgress.add(agent.id);
      (async () => {
        try {
          for (const pos of openPositions) {
            console.log(`[BlockedRecovery] Retrying close for ${agent.name} pos ${pos.id} (was CLOSE_PERMANENTLY_BLOCKED)`);
            const result = await closePositionForAgent(agent, pos.id, currentPrice, false, "blocked-recovery");
            if (result.closed) {
              console.log(`[BlockedRecovery] Close SUCCESS for ${agent.name} pos ${pos.id}: PnL=${result.pnl.toFixed(4)} SUI`);
              await storage.updateAgent(agent.id, {
                status: "running",
                lastExecutionError: null,
                lastExecutionAt: new Date(),
              });
            } else {
              console.log(`[BlockedRecovery] Close still failed for ${agent.name} pos ${pos.id}: ${result.error}`);
              if (!result.error?.includes("CLOSE_PERMANENTLY_BLOCKED")) {
                await storage.updateAgent(agent.id, {
                  lastExecutionError: `Recovery attempt: ${result.error}`,
                  lastExecutionAt: new Date(),
                });
              }
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

    const agents = await storage.getAgentsWithSignalAgents();

    const checkPromises: Promise<void>[] = [];

    for (const agent of agents) {
      if (agent.status !== "running" && agent.status !== "idle" && agent.status !== "paused" && agent.status !== "recovered") continue;

      if (agent.status === "paused" && agent.lastExecutionError) {
        const err = agent.lastExecutionError;
        if (err.includes("CLOSE_GAS_CAP") || err.includes("SPEND_CAP") || err.includes("CLOSE_PERMANENTLY_BLOCKED")) {
          continue;
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
