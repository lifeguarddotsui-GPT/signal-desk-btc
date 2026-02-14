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

    if (agent.status !== "running" || !agent.autoTrade) {
      await storage.updateBundleStatus(bundleRecord.bundleId, "failed");
      continue;
    }

    executingAgents.add(bundleRecord.agentId);
    await storage.updateBundleStatus(bundleRecord.bundleId, "executing");

    const execution = await storage.createBundleExecution({
      bundleId: bundleRecord.bundleId,
      agentId: bundleRecord.agentId,
      status: "executing",
      txDigest: null,
      venue: null,
      actionsExecuted: 0,
      actionsFailed: 0,
      error: null,
    });

    try {
      const bundle: InstructionBundle = {
        bundleId: bundleRecord.bundleId,
        agentId: bundleRecord.agentId,
        user: bundleRecord.userAddress,
        vaultId: bundleRecord.vaultId || undefined,
        tradeCapId: bundleRecord.tradeCapId || undefined,
        createdAtMs: new Date(bundleRecord.createdAt!).getTime(),
        expiresAtMs: bundleRecord.expiresAtMs,
        risk: bundleRecord.risk as any,
        actions: bundleRecord.actions as any[],
      };

      const result = await executeBundleForAgent(bundle, agent);

      const venue = (bundleRecord.actions as any[]).find((a: any) => a.venue)?.venue || null;

      await storage.updateBundleExecution(execution.id, {
        status: result.success ? "completed" : "failed",
        txDigest: result.txDigest || null,
        venue,
        actionsExecuted: result.actionsExecuted,
        actionsFailed: result.actionsFailed,
        error: result.error || null,
        executedAt: new Date(),
      });

      await storage.updateBundleStatus(
        bundleRecord.bundleId,
        result.success ? "completed" : "failed"
      );

      console.log(`[ExecutorLoop] Bundle ${bundleRecord.bundleId}: ${result.actionsExecuted} executed, ${result.actionsFailed} failed${result.txDigest ? ` tx: ${result.txDigest}` : ""}`);
    } catch (err: any) {
      await storage.updateBundleExecution(execution.id, {
        status: "failed",
        error: err.message,
        executedAt: new Date(),
      });
      await storage.updateBundleStatus(bundleRecord.bundleId, "failed");
      console.error(`[ExecutorLoop] Bundle ${bundleRecord.bundleId} failed:`, err.message);
    } finally {
      executingAgents.delete(bundleRecord.agentId);
    }
  }
}
