import { storage } from "../storage";
import { executeBundleForAgent } from "./bundle-executor";
import type { InstructionBundle } from "../../shared/bundle";

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

    if (agent.status !== "running") {
      await storage.updateBundleStatus(bundleRecord.bundleId, "failed");
      continue;
    }

    executingAgents.add(bundleRecord.agentId);

    try {
      const bundle: InstructionBundle = {
        bundleId: bundleRecord.bundleId,
        agentId: bundleRecord.agentId,
        user: bundleRecord.userAddress || "",
        vaultId: bundleRecord.vaultId || undefined,
        tradeCapId: bundleRecord.tradeCapId || undefined,
        actions: bundleRecord.actions as any[],
        risk: bundleRecord.risk as any,
        expiresAtMs: bundleRecord.expiresAtMs,
        ts: bundleRecord.createdAt ? new Date(bundleRecord.createdAt).getTime() : Date.now(),
      } as InstructionBundle;

      const result = await executeBundleForAgent(bundle, agent);

      const isVerified = result.success && result.txDigest && !result.txDigest.startsWith("sim_");
      const bundleStatus = isVerified ? "completed" : "rejected";

      await storage.updateBundleStatus(bundleRecord.bundleId, bundleStatus);

      await storage.createBundleExecution({
        bundleId: bundleRecord.bundleId,
        agentId: bundleRecord.agentId,
        status: bundleStatus,
        txDigest: isVerified ? result.txDigest! : null,
        venue: (bundleRecord.actions as any[]).find((a: any) => a.venue)?.venue || agent.venue,
        actionsExecuted: result.actionsExecuted,
        actionsFailed: result.actionsFailed,
        error: result.error || null,
      });

      console.log(`[ExecutorLoop] Bundle ${bundleRecord.bundleId.slice(0, 8)} ${bundleStatus}: ${result.actionsExecuted} executed, ${result.actionsFailed} failed${result.error ? ` (${result.error})` : ""}`);
    } catch (err: any) {
      await storage.updateBundleStatus(bundleRecord.bundleId, "failed");
      console.error(`[ExecutorLoop] Bundle ${bundleRecord.bundleId.slice(0, 8)} failed: ${err.message}`);
    } finally {
      executingAgents.delete(bundleRecord.agentId);
    }
  }
}
