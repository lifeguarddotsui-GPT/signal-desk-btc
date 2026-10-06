import { agentPolicySchema, type AgentPolicy } from "../../shared/agent-policy";

export type Equity = {
  availableCents: number; committedCents: number; startingCents: number;
  dayStartingCents: number; dayTurnoverCents: number; dayRealizedPnlCents: number;
  highWaterCents: number; consecutiveLosses: number;
};
export type ExecutionEvidence = {
  nowMs: number; mode: "SHADOW" | "LIVE"; paused: boolean; killed: boolean;
  releaseApproved: boolean; delegateValid: boolean; delegateExpiresAtMs: number | null;
  network: string; accountVerified: boolean; providerEligible: boolean;
  signal: { source: string; qualified: boolean; frozen: boolean; atMs: number; roundId: string; interval: 5 | 15; startMs: number; expiryMs: number; side: "UP" | "DOWN"; probability: number } | null;
  market: { id: string; roundId: string; interval: 5 | 15; startMs: number; expiryMs: number; underlying: string; open: boolean; semanticsVerified: boolean; yesMeans: "UP" | "DOWN"; network: string } | null;
  quote: { atMs: number; marketId: string; selection: "YES" | "NO"; spendCents: number; totalFeeCents: number; payoutIfWinCents: number; priceBps: number; minSharesAtomic: string; economicsVerified: boolean } | null;
  duplicate: boolean; simulationPassed: boolean | null;
};
export type RiskDecision = { action: "HOLD" | "QUALIFIED"; reason: string; stakeCents: number; selection: "YES" | "NO" | null; modelProbability: number | null; effectiveBreakEvenProbability: number | null; edgePp: number | null };
function validEquity(e: Equity): boolean {
  return Object.entries(e).every(([k, v]) => Number.isSafeInteger(v) && (k === "dayRealizedPnlCents" || v >= 0));
}
export function sizePosition(p: AgentPolicy, e: Equity): number {
  if (!validEquity(e)) throw new Error("Unverified/noninteger equity");
  // Monetary amounts are integer cents. Floor percentages; never round a cap up.
  const basis = p.sizingMode === "ALLOCATION_PERCENT" ? p.allocationCents :
    p.compound ? e.availableCents : p.allocationCents;
  const base = p.sizingMode === "FIXED" ? p.fixedCents : Math.floor(basis * p.sizingPercent / 100);
  const exposure = p.maxUnresolved.mode === "AMOUNT" ? p.maxUnresolved.value :
    Math.floor((e.availableCents + e.committedCents) * p.maxUnresolved.value / 100);
  return Math.max(0, Math.floor(Math.min(base, Math.max(0, e.availableCents - p.reserveCents),
    p.maxOrderCents ?? Number.MAX_SAFE_INTEGER,
    p.dailyTurnoverCents === null ? Number.MAX_SAFE_INTEGER : Math.max(0, p.dailyTurnoverCents - e.dayTurnoverCents),
    Math.max(0, exposure - e.committedCents))));
}
export function evaluateRisk(raw: AgentPolicy, e: Equity, v: ExecutionEvidence): RiskDecision {
  const p = agentPolicySchema.parse(raw);
  const d: RiskDecision = { action: "HOLD", reason: "", stakeCents: 0, selection: null, modelProbability: null, effectiveBreakEvenProbability: null, edgePp: null };
  const hold = (reason: string) => ({ ...d, reason });
  if (v.paused) return hold("PAUSED");
  if (v.killed) return hold("GLOBAL_EXECUTION_DISABLED");
  if (!Number.isSafeInteger(v.nowMs) || v.nowMs < 0) return hold("INVALID_CLOCK");
  if (v.mode === "LIVE" && !v.releaseApproved) return hold("MAINNET_RELEASE_NOT_APPROVED");
  if (!validEquity(e)) return hold("EQUITY_UNVERIFIED");
  if (v.network !== p.network) return hold("WRONG_NETWORK");
  if (!v.accountVerified) return hold("ACCOUNT_UNVERIFIED");
  if (!v.providerEligible) return hold("PROVIDER_ELIGIBILITY_UNVERIFIED");
  if (!v.delegateValid || v.delegateExpiresAtMs === null || v.delegateExpiresAtMs <= v.nowMs + p.minRemainingMs) return hold("DELEGATE_INVALID_OR_EXPIRED");
  if (v.duplicate) return hold("DUPLICATE_ROUND");
  if (p.targetCents !== null && e.availableCents >= p.targetCents) return hold("TARGET_REACHED");
  if (p.dailyProfitAction === "PAUSE" && p.dailyProfitTargetCents !== null && e.dayRealizedPnlCents >= p.dailyProfitTargetCents) return hold("DAILY_PROFIT_TARGET");
  const lossLimit = p.dailyLoss === null ? null : p.dailyLoss.mode === "AMOUNT" ?
    p.dailyLoss.value : Math.floor(e.dayStartingCents * p.dailyLoss.value / 100);
  if (lossLimit !== null && e.dayRealizedPnlCents <= -lossLimit) return hold("DAILY_LOSS_STOP");
  // Paper settled equity and committed cost together avoid treating reservation as a loss.
  const equity = e.availableCents + e.committedCents;
  if (p.maxDrawdownPercent !== null && e.highWaterCents > 0 && (e.highWaterCents - equity) / e.highWaterCents * 100 >= p.maxDrawdownPercent) return hold("DRAWDOWN_STOP");
  if (p.maxConsecutiveLosses !== null && e.consecutiveLosses >= p.maxConsecutiveLosses) return hold("CONSECUTIVE_LOSS_STOP");
  const s = v.signal, m = v.market, q = v.quote;
  if (!s || s.source !== p.signalSource || !s.qualified || !s.frozen)
    return hold(p.signalSource==="BLUEWATER_CHAMPION"?"NO_QUALIFIED_CHAMPION_FINAL_CHOICE":"NO_COMMITTED_QUALIFICATION_GATE_DECISION");
  if (!Number.isFinite(s.probability) || s.probability < 0 || s.probability > 1 || !Number.isSafeInteger(s.atMs) ||
    s.atMs > v.nowMs || v.nowMs - s.atMs > p.maxSignalAgeMs || s.atMs >= s.expiryMs) return hold("STALE_OR_INVALID_SIGNAL");
  if (!p.intervals.includes(s.interval)) return hold("INTERVAL_NOT_AUTHORIZED");
  if (!m || !m.semanticsVerified) return hold("MARKET_SEMANTICS_UNVERIFIED");
  if (m.underlying !== "BTC" || !m.open || m.network !== p.network || m.roundId !== s.roundId || m.interval !== s.interval ||
    m.startMs !== s.startMs || m.expiryMs !== s.expiryMs || m.expiryMs - m.startMs !== s.interval * 60000 ||
    m.startMs > v.nowMs) return hold("WRONG_OR_CLOSED_MARKET");
  if (m.expiryMs - v.nowMs < p.minRemainingMs) return hold("INSUFFICIENT_TIME");
  d.selection = s.side === m.yesMeans ? "YES" : "NO";
  d.modelProbability = s.probability;
  if (p.frequency === "SELECTIVE" && s.probability < p.selectiveMinProbability) return hold("SELECTIVE_PROBABILITY_BELOW_LIMIT");
  d.stakeCents = sizePosition(p, e);
  if (d.stakeCents <= 0) return hold("BALANCE_RESERVE_TURNOVER_OR_EXPOSURE_LIMIT");
  if (!q || !q.economicsVerified) return hold("EXECUTABLE_ECONOMICS_UNVERIFIED");
  if(p.network==="mainnet"&&q.spendCents+q.totalFeeCents>p.roundCollateralCents)return hold("BETA_ALL_IN_COLLATERAL_CAP");
  if (!Number.isSafeInteger(q.atMs) || q.atMs > v.nowMs || v.nowMs - q.atMs > p.maxQuoteAgeMs) return hold("STALE_QUOTE");
  if (q.marketId !== m.id || q.selection !== d.selection) return hold("QUOTE_IDENTITY_MISMATCH");
  const exposureLimit=p.maxUnresolved.mode==="AMOUNT"?p.maxUnresolved.value:
    Math.floor((e.availableCents+e.committedCents)*p.maxUnresolved.value/100);
  if (![q.spendCents, q.totalFeeCents, q.payoutIfWinCents, q.priceBps].every(Number.isSafeInteger) ||
    q.spendCents !== d.stakeCents || q.totalFeeCents < 0 || q.payoutIfWinCents <= 0 ||
    q.spendCents + q.totalFeeCents > e.availableCents - p.reserveCents ||
     q.spendCents + q.totalFeeCents + e.committedCents > exposureLimit ||
    (p.dailyTurnoverCents !== null && q.spendCents + q.totalFeeCents + e.dayTurnoverCents > p.dailyTurnoverCents) ||
    q.priceBps <= 0 || q.priceBps > 10000 || !/^[1-9]\d*$/.test(q.minSharesAtomic)) return hold("QUOTE_ECONOMICS_OR_PRICE_CAP_INVALID");
  // Include known entry fees and the actual net winning payout, not indicative odds.
  d.effectiveBreakEvenProbability = (q.spendCents + q.totalFeeCents) / q.payoutIfWinCents;
  d.edgePp = (s.probability - d.effectiveBreakEvenProbability) * 100;
  if (p.edgeEnabled && d.edgePp + 1e-9 < p.minimumEdgePp) return hold("EDGE_BELOW_LIMIT");
  if (v.simulationPassed === false) return hold("SIMULATION_FAILED");
  if (v.simulationPassed !== true) return hold("SIMULATION_REQUIRED");
  return { ...d, action: "QUALIFIED", reason: "ALL_HARD_CHECKS_PASSED" };
}