import { storage } from "./storage";
import { getLastPrice } from "./price-service";
import { checkAndClosePositions } from "./dex/execution-engine";

const MONITOR_INTERVAL_MS = 2000;
let monitorInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

async function monitorTick() {
  if (isRunning) return;
  isRunning = true;

  try {
    const lastPrice = getLastPrice();
    if (!lastPrice || !lastPrice.pyth || lastPrice.pyth.price <= 0) {
      return;
    }

    const currentPrice = lastPrice.blended;
    if (currentPrice <= 0) return;

    const agents = await storage.getAgentsWithSignalAgents();

    for (const agent of agents) {
      if (agent.status !== "running" && agent.status !== "idle" && agent.status !== "paused") continue;

      try {
        await checkAndClosePositions(agent, currentPrice);
      } catch (err: any) {
        console.error(`[PositionMonitor] SL/TP check error for ${agent.name}: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error(`[PositionMonitor] Tick error: ${err.message}`);
  } finally {
    isRunning = false;
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
