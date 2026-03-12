import { getOnChainBalance } from "./sui-verify";
import { getAdapter } from "./dex";
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
}

interface VerifierState {
  running: boolean;
  startedAt: Date;
  lastCycleAt: Date | null;
  totalCycles: number;
  agents: Map<string, AgentVerificationState>;
}

const VERIFY_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 120_000;
const DISCREPANCY_WARN_PCT = 5;

const state: VerifierState = {
  running: false,
  startedAt: new Date(),
  lastCycleAt: null,
  totalCycles: 0,
  agents: new Map(),
};

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

  for (const agent of agents) {
    if (!agent.walletAddress) continue;

    try {
      const [onChain, adapterPositions] = await Promise.all([
        getOnChainBalance(agent.walletAddress),
        (async () => {
          const adapter = getAdapter(agent.venue || "typus");
          if (!adapter) return [];
          return adapter.getPositions(agent.walletAddress);
        })(),
      ]);

      const freeSui = onChain.sui;

      const validPositions = adapterPositions.filter(
        (p: any) => p.positionId && !(p as any).__rateLimited
      );
      const totalLocked = validPositions.reduce((sum: number, p: any) => {
        const coll = p.collateral || (p.size / (agent.leverage || 25));
        return sum + coll;
      }, 0);

      const portfolioValue = freeSui + totalLocked;
      const dbBalance = agent.balance || 0;
      const discrepancyPct = dbBalance > 0
        ? Math.abs(portfolioValue - dbBalance) / dbBalance * 100
        : 0;
      const isConsistent = discrepancyPct < DISCREPANCY_WARN_PCT;

      if (!isConsistent) {
        console.log(`[PortfolioVerifier] ${agent.name}: discrepancy ${discrepancyPct.toFixed(1)}% — on-chain=${portfolioValue.toFixed(4)} SUI, DB=${dbBalance.toFixed(4)} SUI`);
      }

      state.agents.set(agent.id, {
        agentId: agent.id,
        agentName: agent.name,
        verifiedAt: new Date(),
        portfolioValue,
        freeSui,
        totalLocked,
        positionCount: validPositions.length,
        isConsistent,
        discrepancyPct,
        dbBalance,
        source: "rpc",
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
  console.log(`[PortfolioVerifier] Cycle ${state.totalCycles}: ${verified}/${state.agents.size} agents verified on-chain`);
}

export async function runOnDemandVerification(): Promise<void> {
  return runVerificationCycle();
}

export function startPortfolioVerifier(storage: IStorage): void {
  if (state.running) return;
  storageRef = storage;
  state.running = true;
  state.startedAt = new Date();

  console.log("[PortfolioVerifier] Started — verifying portfolio state every 60s");

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
