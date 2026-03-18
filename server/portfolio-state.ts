/**
 * Portfolio State Engine
 *
 * Canonical per-agent portfolio state maintained on the backend.
 * Pushes portfolio:tick WebSocket events immediately on state changes,
 * giving the frontend real-time updates without polling.
 *
 * Confidence semantics:
 *   green  = on-chain verified, no pending transitions
 *   yellow = transition in progress (order submitted, closing, settling)
 *   blue   = mark-price estimate (open positions, unverified)
 */

type Confidence = 'blue' | 'yellow' | 'green';

export interface PortfolioTick {
  agentId: string;
  walletSui: number;
  savingsBalance: number;
  lockedCollateral: number;
  pendingOrderCollateral: number;
  unrealizedPnl: number;
  portfolioValue: number;
  openPositionCount: number;
  closingPositionCount: number;
  hasSettling: boolean;
  confidence: Confidence;
  reason: string;
  sequence: number;
  updatedAt: number;
}

interface AgentState {
  tick: PortfolioTick;
  pendingTransitions: Set<string>;
}

class PortfolioStateEngine {
  private agents = new Map<string, AgentState>();
  private sequences = new Map<string, number>();
  private broadcastFn: ((type: string, data: any) => void) | null = null;

  setBroadcast(fn: (type: string, data: any) => void) {
    this.broadcastFn = fn;
  }

  private nextSeq(agentId: string): number {
    const s = (this.sequences.get(agentId) || 0) + 1;
    this.sequences.set(agentId, s);
    return s;
  }

  private getOrCreate(agentId: string): AgentState {
    if (!this.agents.has(agentId)) {
      this.agents.set(agentId, {
        tick: {
          agentId,
          walletSui: 0,
          savingsBalance: 0,
          lockedCollateral: 0,
          pendingOrderCollateral: 0,
          unrealizedPnl: 0,
          portfolioValue: 0,
          openPositionCount: 0,
          closingPositionCount: 0,
          hasSettling: false,
          confidence: 'blue',
          reason: 'initializing',
          sequence: 0,
          updatedAt: Date.now(),
        },
        pendingTransitions: new Set(),
      });
    }
    return this.agents.get(agentId)!;
  }

  private computeConfidence(state: AgentState): { confidence: Confidence; reason: string } {
    if (state.pendingTransitions.size > 0) {
      const reasons = Array.from(state.pendingTransitions);
      return { confidence: 'yellow', reason: reasons[0] };
    }
    const t = state.tick;
    if (t.openPositionCount > 0 || t.closingPositionCount > 0 || t.hasSettling) {
      return { confidence: 'blue', reason: 'mark_estimate' };
    }
    return { confidence: 'green', reason: 'verified_chain' };
  }

  private emit(agentId: string) {
    const state = this.agents.get(agentId);
    if (!state || !this.broadcastFn) return;
    const { confidence, reason } = this.computeConfidence(state);
    state.tick.confidence = confidence;
    state.tick.reason = reason;
    state.tick.sequence = this.nextSeq(agentId);
    state.tick.updatedAt = Date.now();
    this.broadcastFn('portfolio:tick', { ...state.tick });
  }

  /**
   * Called when an open order is submitted.
   * Immediately marks the agent as yellow (pending_open).
   */
  openOrderSubmitted(agentId: string) {
    const state = this.getOrCreate(agentId);
    state.pendingTransitions.add('pending_open');
    this.emit(agentId);
  }

  /**
   * Called when a close order is submitted.
   * Immediately marks the agent as yellow (pending_close).
   */
  closeOrderSubmitted(agentId: string) {
    const state = this.getOrCreate(agentId);
    state.pendingTransitions.add('pending_close');
    state.tick.closingPositionCount = Math.max(1, state.tick.closingPositionCount);
    this.emit(agentId);
  }

  /**
   * Called when a position is confirmed open (WAL created + on-chain ID found).
   * Transitions from pending_open → blue (mark_estimate).
   */
  positionConfirmedOpen(agentId: string) {
    const state = this.getOrCreate(agentId);
    state.pendingTransitions.delete('pending_open');
    state.tick.openPositionCount = Math.max(1, state.tick.openPositionCount);
    this.emit(agentId);
  }

  /**
   * Called when a position close is confirmed on-chain.
   * Settlement may still be pending so stays yellow.
   */
  positionConfirmedClosed(agentId: string) {
    const state = this.getOrCreate(agentId);
    state.pendingTransitions.delete('pending_close');
    state.pendingTransitions.add('pending_settlement');
    state.tick.closingPositionCount = Math.max(0, state.tick.closingPositionCount - 1);
    state.tick.hasSettling = true;
    this.emit(agentId);
  }

  /**
   * Full state update from the periodic balance sync or activity endpoint.
   * This is the authoritative reconciliation that resolves confidence color.
   */
  balanceSynced(agentId: string, params: {
    walletSui: number;
    savingsBalance: number;
    lockedCollateral: number;
    pendingOrderCollateral: number;
    unrealizedPnl: number;
    openPositionCount: number;
    closingPositionCount: number;
    hasSettling: boolean;
    portfolioValue: number;
  }) {
    const state = this.getOrCreate(agentId);
    const prevOpenCount = state.tick.openPositionCount;
    const prevLockedCollateral = state.tick.lockedCollateral;

    // Guard against sudden position erasure from stale DB reads.
    // When balanceSynced reports 0 open positions after previously having >0,
    // without any pending_close transition having been signalled first, the data
    // is likely from a stale query (e.g. on-chain query raced with a DB read).
    // In that case: preserve the existing position count and collateral so the
    // frontend doesn't show a phantom -70 SUI loss. The next genuine close event
    // (positionConfirmedClosed) or HTTP canonical-snapshot will correct this.
    const isSuddenErasure =
      prevOpenCount > 0 &&
      params.openPositionCount === 0 &&
      params.lockedCollateral < 0.1 &&
      !params.hasSettling &&
      !state.pendingTransitions.has('pending_close') &&
      !state.pendingTransitions.has('pending_settlement');

    if (isSuddenErasure) {
      // Accept wallet/savings updates but keep position state from previous tick
      state.tick = {
        ...state.tick,
        agentId,
        walletSui: params.walletSui,
        savingsBalance: params.savingsBalance,
        pendingOrderCollateral: params.pendingOrderCollateral,
        // Keep previous position data — don't trust the sudden zero
        openPositionCount: prevOpenCount,
        lockedCollateral: prevLockedCollateral,
        unrealizedPnl: state.tick.unrealizedPnl,
        hasSettling: state.tick.hasSettling,
        portfolioValue: params.walletSui + params.savingsBalance + prevLockedCollateral + state.tick.unrealizedPnl,
      };
    } else {
      state.tick = { ...state.tick, ...params, agentId };

      // Clear settlement transition if no more settling positions
      if (!params.hasSettling) {
        state.pendingTransitions.delete('pending_settlement');
      }
      // Clear pending_open if no open positions expected
      if (params.openPositionCount === 0 && !params.hasSettling) {
        state.pendingTransitions.delete('pending_open');
      }
      // Clear pending_close if no more closing
      if (params.closingPositionCount === 0 && !params.hasSettling) {
        state.pendingTransitions.delete('pending_close');
      }
    }

    this.emit(agentId);
  }

  /**
   * Lightweight mark-price update — recomputes unrealized PnL for open positions.
   * Only broadcasts if there are open positions (otherwise no PnL to update).
   */
  markPriceTick(agentId: string, unrealizedPnl: number) {
    const state = this.agents.get(agentId);
    if (!state || state.tick.openPositionCount === 0) return;

    const oldPnl = state.tick.unrealizedPnl;
    if (Math.abs(unrealizedPnl - oldPnl) < 0.0001) return; // skip tiny changes

    state.tick.unrealizedPnl = unrealizedPnl;
    state.tick.portfolioValue =
      state.tick.walletSui +
      state.tick.savingsBalance +
      state.tick.lockedCollateral +
      state.tick.pendingOrderCollateral +
      unrealizedPnl;
    this.emit(agentId);
  }

  getState(agentId: string): PortfolioTick | undefined {
    return this.agents.get(agentId)?.tick;
  }

  getAllStates(): PortfolioTick[] {
    return Array.from(this.agents.values()).map(s => ({ ...s.tick }));
  }
}

export const portfolioEngine = new PortfolioStateEngine();
