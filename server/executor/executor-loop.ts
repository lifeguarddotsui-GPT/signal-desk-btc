import { storage } from "../storage";

let running = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

const POLL_INTERVAL_MS = 5_000;
const executingAgents = new Set<string>();

export function startExecutorLoop() {
  if (running) return;
  running = true;

  console.log("[ExecutorLoop] Started bundle execution loop");

  intervalHandle = setInterval(async () => {
    try {
      await processPendingBundles();
    } catch (err: any) {
      console.error("[ExecutorLoop] Error:", err.message);
    }
  }, POLL_INTERVAL_MS);
}

export function stopExecutorLoop() {
  running = false;
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  console.log("[ExecutorLoop] Stopped");
}

async function processPendingBundles() {
  const pendingBundles = await storage.getPendingBundles();

  for (const bundleRecord of pendingBundles) {
    const now = Date.now();
    if (now > bundleRecord.expiresAtMs) {
      await storage.updateBundleStatus(bundleRecord.bundleId, "expired");
      continue;
    }

    if (executingAgents.has(bundleRecord.agentId)) {
      continue;
    }

    const agent = await storage.getAgentWithSignalAgent(bundleRecord.agentId);
    if (!agent) {
      await storage.updateBundleStatus(bundleRecord.bundleId, "failed");
      continue;
    }

    if (agent.status !== "running" || !agent.autoTrade) {
      await storage.updateBundleStatus(bundleRecord.bundleId, "failed");
      continue;
    }

    executingAgents.add(bundleRecord.agentId);

    const venue = (bundleRecord.actions as any[]).find((a: any) => a.venue)?.venue || null;
    const actionCount = (bundleRecord.actions as any[]).length;

    await storage.updateBundleStatus(bundleRecord.bundleId, "completed");

    await storage.createBundleExecution({
      bundleId: bundleRecord.bundleId,
      agentId: bundleRecord.agentId,
      status: "completed",
      txDigest: null,
      venue,
      actionsExecuted: actionCount,
      actionsFailed: 0,
      error: null,
    });

    console.log(`[ExecutorLoop] Bundle ${bundleRecord.bundleId} recorded (${actionCount} actions, trade executed via signal engine)`);
    executingAgents.delete(bundleRecord.agentId);
  }
}
