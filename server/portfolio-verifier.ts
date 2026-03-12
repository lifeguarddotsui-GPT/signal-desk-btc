import { getOnChainBalance } from "./sui-verify";
import { getAdapter } from "./dex";
import { getLastPrice } from "./price-service";
import type { IStorage } from "./storage";

export interface AgentVerificationState {
  agentId: string;
  agentName: string;
  verifiedAt: Date;
  portfolioValue: number;
  freeSui: number;
  totalLocked: number;
  positionCount: number;
  isConsistent: boolean;
  discrepancyPct: number;
  dbBalance: number;
  source: "rpc" | "failed";
  error?: string;
  missingPositions?: Array<{ positionId: string; side: string; collateral: number }>;
  recoveredCount?: number;
}

interface VerifierState {
  running: boolean;
  startedAt: Date;
  lastCycleAt: Date | null;
  totalCycles: number;
  agents: Map<string, AgentVerificationState>;
}

const VERIFY_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 120_000;
const DISCREPANCY_WARN_PCT = 10;
const DISCREPANCY_ABS_MIN = 1.0;
const RECOVERY_COOLDOWN_MS = 10 * 60 * 1000;

const state: VerifierState = {
  running: false,
  startedAt: new Date(),
  lastCycleAt: null,
  totalCycles: 0,
  agents: new Map(),
};

const recentlyRecoveredPositions = new Map<string, number>();

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let storageRef: IStorage | null = null;

export function getVerifierStatus(): {
  running: boolean;
  startedAt: Date;
  lastCycleAt: Date | null;
  totalCycles: number;
  agents: AgentVerificationState[];
} {
  return {
    running: state.running,
    startedAt: state.startedAt,
    lastCycleAt: state.lastCycleAt,
    totalCycles: state.totalCycles,
    agents: [...state.agents.values()],
  };
}

export function getAgentVerification(agentId: string): AgentVerificationState | null {
  const v = state.agents.get(agentId);
  if (!v) return null;
  const age = Date.now() - v.verifiedAt.getTime();
  if (age > STALE_THRESHOLD_MS) return null;
  return v;
}

export function isPortfolioVerified(agentId: string): boolean {
  const v = getAgentVerification(agentId);
  if (!v) return false;
  return v.source === "rpc" && v.isConsistent;
}

async function recoverMissingPosition(
  agent: any,
  onChainPos: any,
  currentPrice: number
): Promise<boolean> {
  if (!storageRef) return false;

  const posId = String(onChainPos.positionId || onChainPos.orderId || "");
  if (!posId) return false;

  const cooldownKey = `${agent.id}:${posId}`;
  const lastRecovery = recentlyRecoveredPositions.get(cooldownKey);
  if (lastRecovery && Date.now() - lastRecovery < RECOVERY_COOLDOWN_MS) {
    return false;
  }

  const allPositions = await storageRef.getPositions(agent.id);
  const alreadyClosed = allPositions.some(p =>
    p.onChainPositionId === posId &&
    (p.status === "closed" || p.status === "cancelled_unfilled")
  );
  if (alreadyClosed) {
    recentlyRecoveredPositions.set(cooldownKey, Date.now());
    return false;
  }

  const posCollateral = onChainPos.collateral || (onChainPos.size / (agent.leverage || 36));
  if (!posCollateral || posCollateral <= 0) return false;

  const entryPrice = onChainPos.entryPrice || currentPrice;
  if (!entryPrice || entryPrice <= 0) return false;

  const leverage = agent.leverage || 36;
  const notionalSize = posCollateral * leverage;
  const correctLiq = (onChainPos.side || "long") === "long"
    ? entryPrice * (1 - 1 / leverage)
    : entryPrice * (1 + 1 / leverage);

  console.log(`[PortfolioVerifier] AUTO-RECOVERING ${agent.name}: posId=${posId}, side=${onChainPos.side}, collateral=${posCollateral.toFixed(4)} SUI, entry=$${entryPrice.toFixed(4)}`);

  try {
    const newPos = await storageRef.createPosition({
      agentId: agent.id,
      symbol: "SUI-USDC",
      side: onChainPos.side || "long",
      sizeSui: notionalSize,
      collateral: posCollateral,
      entryPrice,
      markPrice: currentPrice || entryPrice,
      unrealizedPnl: 0,
      liquidationPrice: correctLiq,
      txDigest: `reopened_${posId}`,
    });

    await storageRef.updatePosition(newPos.id, {
      onChainPositionId: posId,
      verified: true,
    });

    const currentAgent = await storageRef.getAgent(agent.id);
    if (currentAgent) {
      const newBalance = (currentAgent.balance || 0) + posCollateral;
      await storageRef.updateAgent(agent.id, { balance: newBalance });
      console.log(`[PortfolioVerifier] ${agent.name}: balance updated ${(currentAgent.balance || 0).toFixed(4)} → ${newBalance.toFixed(4)} SUI after recovering position ${posId}`);
    }

    recentlyRecoveredPositions.set(cooldownKey, Date.now());
    console.log(`[PortfolioVerifier] ${agent.name}: position ${posId} successfully created in DB`);

    // Invalidate the on-chain portfolio cache so the UI picks up the new position
    try {
      const cache = (globalThis as any).__onChainPortfolioCache;
      if (cache) cache.delete(agent.id);
    } catch (_) {}

    return true;
  } catch (e: any) {
    console.log(`[PortfolioVerifier] ${agent.name}: failed to recover position ${posId}: ${e.message}`);
    return false;
  }
}

async function runVerificationCycle(): Promise<void> {
  if (!storageRef) return;

  let agents: any[];
  try {
    agents = await storageRef.getAgents();
  } catch (e: any) {
    console.log(`[PortfolioVerifier] Failed to load agents: ${e.message}`);
    return;
  }

  state.totalCycles++;
  state.lastCycleAt = new Date();

  const priceData = getLastPrice();
  const currentPrice = priceData?.pyth?.price ?? priceData?.blended ?? 0;

  for (const agent of agents) {
    if (!agent.walletAddress) continue;

    try {
      const [onChain, adapterPositions, dbOpenPositions] = await Promise.all([
        getOnChainBalance(agent.walletAddress),
        (async () => {
          const adapter = getAdapter(agent.venue || "typus");
          if (!adapter) return [];
          return adapter.getPositions(agent.walletAddress).catch(() => [] as any[]);
        })(),
        storageRef!.getPositions(agent.id).then(positions =>
          positions.filter((p: any) => p.status === "open")
        ),
      ]);

      const rawWalletSui = onChain.sui;

      const validAdapterPositions = adapterPositions.filter(
        (p: any) => p.positionId && !(p as any).__rateLimited
      );
      const totalLocked = validAdapterPositions.reduce((sum: number, p: any) => {
        const coll = p.collateral || (p.size / (agent.leverage || 25));
        return sum + coll;
      }, 0);

      const portfolioValue = rawWalletSui + totalLocked;
      const dbBalance = agent.balance || 0;

      const absDiff = Math.abs(portfolioValue - dbBalance);
      const discrepancyPct = dbBalance > 0
        ? absDiff / dbBalance * 100
        : 0;

      const isConsistent = discrepancyPct < DISCREPANCY_WARN_PCT || absDiff < DISCREPANCY_ABS_MIN;

      if (!isConsistent) {
        console.log(`[PortfolioVerifier] ${agent.name}: discrepancy ${discrepancyPct.toFixed(1)}% (${absDiff.toFixed(4)} SUI) — on-chain=${portfolioValue.toFixed(4)} SUI (free=${rawWalletSui.toFixed(4)}, locked=${totalLocked.toFixed(4)}), DB=${dbBalance.toFixed(4)} SUI`);
      }

      const dbPositionIds = new Set(
        dbOpenPositions.map((p: any) => p.onChainPositionId).filter(Boolean)
      );

      const missingPositions: Array<{ positionId: string; side: string; collateral: number }> = [];
      let recoveredCount = 0;

      for (const onChainPos of validAdapterPositions) {
        const posId = String(onChainPos.positionId || onChainPos.orderId || "");
        if (!posId || dbPositionIds.has(posId)) continue;

        const coll = onChainPos.collateral || (onChainPos.size / (agent.leverage || 25));
        missingPositions.push({
          positionId: posId,
          side: onChainPos.side || "unknown",
          collateral: coll,
        });

        if (onChainPos.entryPrice && onChainPos.entryPrice > 0) {
          const recovered = await recoverMissingPosition(agent, onChainPos, currentPrice);
          if (recovered) {
            recoveredCount++;
            dbPositionIds.add(posId);
          }
        } else {
          console.log(`[PortfolioVerifier] ${agent.name}: position ${posId} has no entry price — cannot auto-recover, needs manual check`);
        }
      }

      if (missingPositions.length > 0 && recoveredCount === 0) {
        console.log(`[PortfolioVerifier] ${agent.name}: ${missingPositions.length} on-chain position(s) NOT in DB — ${missingPositions.map(p => `${p.positionId}(${p.side},${p.collateral.toFixed(2)}SUI)`).join(", ")}`);
      } else if (recoveredCount > 0) {
        console.log(`[PortfolioVerifier] ${agent.name}: recovered ${recoveredCount}/${missingPositions.length} missing position(s) into DB`);
      }

      const chainPositionIds = new Set(
        validAdapterPositions.map((p: any) => String(p.positionId || p.orderId)).filter(Boolean)
      );
      for (const dbPos of dbOpenPositions) {
        const posId = (dbPos as any).onChainPositionId;
        if (posId && !chainPositionIds.has(String(posId))) {
          console.log(`[PortfolioVerifier] ${agent.name}: DB position ${posId} NOT found on-chain (may be settling)`);
        }
      }

      state.agents.set(agent.id, {
        agentId: agent.id,
        agentName: agent.name,
        verifiedAt: new Date(),
        portfolioValue,
        freeSui: rawWalletSui,
        totalLocked,
        positionCount: validAdapterPositions.length,
        isConsistent,
        discrepancyPct,
        dbBalance,
        source: "rpc",
        missingPositions: missingPositions.length > 0 ? missingPositions : undefined,
        recoveredCount,
      });
    } catch (e: any) {
      const errMsg = e.message?.slice(0, 120) || "Unknown error";
      const prev = state.agents.get(agent.id);
      if (prev) {
        state.agents.set(agent.id, { ...prev, error: errMsg });
      } else {
        state.agents.set(agent.id, {
          agentId: agent.id,
          agentName: agent.name,
          verifiedAt: new Date(),
          portfolioValue: 0,
          freeSui: 0,
          totalLocked: 0,
          positionCount: 0,
          isConsistent: false,
          discrepancyPct: 0,
          dbBalance: agent.balance || 0,
          source: "failed",
          error: errMsg,
        });
      }
    }
  }

  const verified = [...state.agents.values()].filter(v => v.source === "rpc" && v.isConsistent).length;
  const withMissing = [...state.agents.values()].filter(v => (v.missingPositions?.length ?? 0) > 0).length;
  const withRecovered = [...state.agents.values()].filter(v => (v.recoveredCount ?? 0) > 0).length;
  const missingSummary = withMissing > 0 ? ` | ${withMissing} agent(s) with untracked chain positions` : "";
  const recoveredSummary = withRecovered > 0 ? ` | ${withRecovered} agent(s) had positions auto-recovered` : "";
  console.log(`[PortfolioVerifier] Cycle ${state.totalCycles}: ${verified}/${state.agents.size} agents verified on-chain${missingSummary}${recoveredSummary}`);
}

export async function runOnDemandVerification(): Promise<void> {
  return runVerificationCycle();
}

export function startPortfolioVerifier(storage: IStorage): void {
  if (state.running) return;
  storageRef = storage;
  state.running = true;
  state.startedAt = new Date();

  console.log("[PortfolioVerifier] Started — verifying portfolio state every 30s with auto-recovery");

  runVerificationCycle().catch(e => {
    console.log(`[PortfolioVerifier] Initial cycle error: ${e.message}`);
  });

  intervalHandle = setInterval(() => {
    runVerificationCycle().catch(e => {
      console.log(`[PortfolioVerifier] Cycle error: ${e.message}`);
    });
  }, VERIFY_INTERVAL_MS);
}

export function stopPortfolioVerifier(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  state.running = false;
}
