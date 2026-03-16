/**
 * Position Guardian System
 *
 * Each open position gets a dedicated guardian that runs its own 200ms monitoring
 * loop — completely independent of all other positions and agents. A slow RPC close
 * attempt on one position NEVER blocks protection for any other position.
 *
 * Improvements over the shared rapid monitor:
 *   • 200ms tick per position (vs 500ms shared tick that can be blocked)
 *   • No shared lock — each guardian is fully independent
 *   • Retry close with exponential backoff on failure
 *   • Tighter emergency threshold: 25% remaining to liquidation (vs 40%)
 *   • SL trigger at 65% of effective SL distance (vs 70%)
 *   • Auto-terminates when position closes (no wasted cycles)
 */

import { getLastPrice } from "./price-service";
import { closePositionForAgent } from "./dex/execution-engine";
import { storage } from "./storage";
import type { Agent } from "../shared/schema";

const GUARDIAN_TICK_MS = 200;
const MAX_COLLATERAL_LOSS_PCT = 4;
const SL_TRIGGER_RATIO = 0.65;         // fire at 65% of effective SL distance
const EMERGENCY_LIQ_RATIO = 0.25;      // fire when < 25% of liq distance remains
const EMERGENCY_COLL_RATIO = 0.65;     // fire when collateral loss > 65% of max
const MAX_RETRIES = 3;
const RETRY_BACKOFF_BASE_MS = 500;
const GUARDIAN_STALE_MS = 30_000;      // consider guardian stale after 30s no heartbeat

interface GuardianState {
  agentId: string;
  positionId: string;
  side: "long" | "short";
  entryPrice: number;
  leverage: number;
  stopLossBps: number;
  slPrice: number | null;

  intervalId: ReturnType<typeof setInterval>;
  closeInProgress: boolean;
  retryCount: number;
  nextRetryAt: number;
  spawnedAt: number;
  lastHeartbeat: number;
  terminated: boolean;
}

const guardians = new Map<string, GuardianState>();

let agentCache = new Map<string, Agent>();
let agentCacheUpdatedAt = 0;
const AGENT_CACHE_TTL_MS = 10_000;

async function getCachedAgent(agentId: string): Promise<Agent | null> {
  const now = Date.now();
  if (now - agentCacheUpdatedAt > AGENT_CACHE_TTL_MS || !agentCache.has(agentId)) {
    try {
      const agents = await storage.getAgentsWithSignalAgents();
      agentCache = new Map(agents.map(a => [a.id, a as Agent]));
      agentCacheUpdatedAt = now;
    } catch {}
  }
  return agentCache.get(agentId) ?? null;
}

function computeEffectiveSLPct(slBps: number, leverage: number): number {
  const liquidationMovePct = (1 / leverage) * 100;
  return Math.min(slBps / 100, MAX_COLLATERAL_LOSS_PCT / leverage, liquidationMovePct * 0.60);
}

function buildGuardianTick(state: GuardianState) {
  return async function guardianTick() {
    if (state.terminated) return;

    state.lastHeartbeat = Date.now();

    const priceData = getLastPrice();
    if (!priceData || priceData.blended <= 0) return;
    const currentPrice = priceData.blended;

    // Skip if a close is already in flight or in backoff
    if (state.closeInProgress) return;
    if (state.retryCount >= MAX_RETRIES) {
      // Give up — guardian stays active but logs the failure
      if (state.retryCount === MAX_RETRIES) {
        console.warn(`[Guardian] pos ${state.positionId.slice(0, 8)} reached max retries (${MAX_RETRIES}) — close attempts exhausted, falling back to main monitor`);
        state.retryCount = MAX_RETRIES + 1; // sentinel so we log once
      }
      return;
    }
    if (Date.now() < state.nextRetryAt) return;

    // Compute adverse price move percentage
    const priceMovePct = state.side === "long"
      ? ((state.entryPrice - currentPrice) / state.entryPrice) * 100
      : ((currentPrice - state.entryPrice) / state.entryPrice) * 100;

    if (priceMovePct <= 0) return; // position is profitable, no action needed

    const leverage = state.leverage;
    const liquidationMovePct = (1 / leverage) * 100;
    const effectiveSLPct = computeEffectiveSLPct(state.stopLossBps, leverage);
    const collateralLossPct = priceMovePct * leverage;
    const distanceToLiquidation = liquidationMovePct - priceMovePct;

    // Check stored slPrice override
    let pastStoredSL = false;
    if (state.slPrice !== null) {
      pastStoredSL = state.side === "long"
        ? currentPrice <= state.slPrice
        : currentPrice >= state.slPrice;
    }

    const isNearLiquidation = distanceToLiquidation < liquidationMovePct * EMERGENCY_LIQ_RATIO;
    const isEmergency = collateralLossPct >= MAX_COLLATERAL_LOSS_PCT * EMERGENCY_COLL_RATIO;
    const isAtSL = pastStoredSL || priceMovePct >= effectiveSLPct * SL_TRIGGER_RATIO;

    if (!isAtSL && !isNearLiquidation && !isEmergency) return;

    const reason = isNearLiquidation
      ? `GUARDIAN-EMERGENCY: ${distanceToLiquidation.toFixed(3)}% to liquidation`
      : isEmergency
        ? `GUARDIAN-EMERGENCY: collateral loss ${collateralLossPct.toFixed(1)}%`
        : `GUARDIAN-SL: adverse ${priceMovePct.toFixed(3)}% vs SL ${effectiveSLPct.toFixed(3)}%`;

    const closeReason = isNearLiquidation
      ? "guardian-emergency-liquidation-prevent"
      : isEmergency
        ? "guardian-emergency-collateral-protection"
        : "guardian-stop-loss";

    console.log(`[Guardian] ${state.positionId.slice(0, 8)} ${state.side.toUpperCase()} — ${reason} | price=$${currentPrice.toFixed(4)} entry=$${state.entryPrice.toFixed(4)} lev=${leverage}x liq=${liquidationMovePct.toFixed(2)}%`);

    const agent = await getCachedAgent(state.agentId);
    if (!agent) {
      console.warn(`[Guardian] Could not load agent ${state.agentId} for pos ${state.positionId.slice(0, 8)} close attempt`);
      return;
    }

    state.closeInProgress = true;
    try {
      const result = await closePositionForAgent(agent, state.positionId, currentPrice, false, closeReason);
      if (result.closed) {
        console.log(`[Guardian] CLOSED ${state.positionId.slice(0, 8)}: pnl=${result.pnl.toFixed(4)} SUI (${closeReason})`);
        terminateGuardian(state.positionId);
      } else {
        state.retryCount++;
        const backoff = RETRY_BACKOFF_BASE_MS * Math.pow(2, state.retryCount - 1);
        state.nextRetryAt = Date.now() + backoff;
        console.warn(`[Guardian] Close attempt ${state.retryCount}/${MAX_RETRIES} failed for pos ${state.positionId.slice(0, 8)}: ${result.error || "not closed"} — retrying in ${backoff}ms`);
      }
    } catch (err: any) {
      state.retryCount++;
      const backoff = RETRY_BACKOFF_BASE_MS * Math.pow(2, state.retryCount - 1);
      state.nextRetryAt = Date.now() + backoff;
      console.warn(`[Guardian] Close error ${state.retryCount}/${MAX_RETRIES} for pos ${state.positionId.slice(0, 8)}: ${err.message?.slice(0, 100)} — retrying in ${backoff}ms`);
    } finally {
      state.closeInProgress = false;
    }
  };
}

export function spawnGuardian(
  positionId: string,
  agentId: string,
  side: "long" | "short",
  entryPrice: number,
  leverage: number,
  stopLossBps: number,
  slPrice: number | null = null,
): void {
  if (guardians.has(positionId)) return; // already watching

  const state: GuardianState = {
    agentId,
    positionId,
    side,
    entryPrice,
    leverage,
    stopLossBps,
    slPrice,
    intervalId: null as any,
    closeInProgress: false,
    retryCount: 0,
    nextRetryAt: 0,
    spawnedAt: Date.now(),
    lastHeartbeat: Date.now(),
    terminated: false,
  };

  const tick = buildGuardianTick(state);
  state.intervalId = setInterval(tick, GUARDIAN_TICK_MS);
  guardians.set(positionId, state);

  console.log(`[Guardian] Spawned for pos ${positionId.slice(0, 8)} ${side.toUpperCase()} entry=$${entryPrice.toFixed(4)} lev=${leverage}x SL=${stopLossBps}bps`);
}

export function terminateGuardian(positionId: string): void {
  const state = guardians.get(positionId);
  if (!state) return;
  state.terminated = true;
  clearInterval(state.intervalId);
  guardians.delete(positionId);
  console.log(`[Guardian] Terminated for pos ${positionId.slice(0, 8)}`);
}

export function updateGuardianSLPrice(positionId: string, slPrice: number): void {
  const state = guardians.get(positionId);
  if (state) state.slPrice = slPrice;
}

export function getActiveGuardianCount(): number {
  return guardians.size;
}

export function getGuardianIds(): string[] {
  return Array.from(guardians.keys());
}

export function isGuardianActive(positionId: string): boolean {
  return guardians.has(positionId);
}

/**
 * Synchronise guardians with the current set of open positions.
 * Called periodically by the position monitor (~every 5s).
 * Spawns guardians for new open positions, terminates stale ones.
 */
export async function syncGuardians(): Promise<void> {
  try {
    const agents = await storage.getAgentsWithSignalAgents();
    const activePositionIds = new Set<string>();

    for (const agent of agents) {
      const isEligible = agent.status === "running" || agent.status === "idle"
        || agent.status === "recovered" || agent.status === "paused";
      if (!isEligible) continue;

      const positions = await storage.getPositions(agent.id);
      const openPositions = positions.filter(p => p.status === "open" || p.status === "pending_open");

      for (const pos of openPositions) {
        activePositionIds.add(pos.id);
        if (!guardians.has(pos.id)) {
          const leverage = agent.leverage || 25;
          const stopLossBps = agent.stopLossBps || 80;
          const slPrice = (pos as any).slPrice ?? null;
          spawnGuardian(pos.id, agent.id, pos.side as "long" | "short", pos.entryPrice, leverage, stopLossBps, slPrice);
        }
      }
    }

    // Terminate guardians for positions that are no longer open
    for (const [positionId] of guardians) {
      if (!activePositionIds.has(positionId)) {
        terminateGuardian(positionId);
      }
    }

    // Purge stale guardians (defensive: no heartbeat for 30s)
    const now = Date.now();
    for (const [positionId, state] of guardians) {
      if (now - state.lastHeartbeat > GUARDIAN_STALE_MS) {
        console.warn(`[Guardian] Stale guardian for pos ${positionId.slice(0, 8)} — terminating`);
        terminateGuardian(positionId);
      }
    }
  } catch (err: any) {
    console.error(`[Guardian] syncGuardians error: ${err.message}`);
  }
}
