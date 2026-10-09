import type { AgentPolicy } from "../../shared/agent-policy";

export const agentMoney = (cents: number | null | undefined) =>
  cents == null || !Number.isFinite(cents) ? "Not reported" : `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const agentDate = (ms: number | null | undefined) =>
  ms == null || !Number.isFinite(ms) ? "Not reported" : new Date(ms).toLocaleString();

export function copyPolicy<T extends AgentPolicy>(policy: T): T {
  return {
    ...policy,
    intervals: [...policy.intervals],
    dailyLoss: policy.dailyLoss ? { ...policy.dailyLoss } : null,
    maxUnresolved: { ...policy.maxUnresolved },
  };
}

export function asErrorMessage(value: unknown, fallback = "Request could not be completed.") {
  return value instanceof Error ? value.message : fallback;
}

export const policyAmountInputValue = (mode: "AMOUNT" | "PERCENT", value: number) =>
  mode === "AMOUNT" ? value / 100 : value;

export const policyValueFromInput = (mode: "AMOUNT" | "PERCENT", value: string) =>
  mode === "AMOUNT" ? Math.round(Number(value || 0) * 100) : Number(value);

export function changePolicyLimitMode(from: "AMOUNT" | "PERCENT", to: "AMOUNT" | "PERCENT", value: number) {
  if (from === to) return value;
  return from === "AMOUNT" ? value / 100 : Math.round(value * 100);
}

export const AGENT_SESSION_DURATIONS = [
  { label: "30 minutes", milliseconds: 30 * 60 * 1000 },
  { label: "1 hour", milliseconds: 60 * 60 * 1000 },
  { label: "2 hours", milliseconds: 2 * 60 * 60 * 1000 },
  { label: "4 hours", milliseconds: 4 * 60 * 60 * 1000 },
] as const;

/**
 * Convert a plain decimal SUI input to MIST without floating-point rounding.
 * More than nine fractional digits, unsafe integers, and malformed values are rejected.
 */
export function suiToMist(value: string): number | null {
  if (!/^(?:\d+)(?:\.\d{0,9})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const mist = BigInt(whole) * BigInt("1000000000") + BigInt((fraction + "000000000").slice(0, 9));
  if (mist > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(mist);
}

export function mistToSui(mist: number): string {
  if (!Number.isSafeInteger(mist) || mist < 0) return "";
  const whole = Math.floor(mist / 1_000_000_000);
  const fraction = String(mist % 1_000_000_000).padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function dollarsToSafeCents(value: string): number | null {
  if (!/^(?:\d+)(?:\.\d{0,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole) * BigInt(100) + BigInt((fraction + "00").slice(0, 2));
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

export function paperCapitalFromInput(value: string): number | null {
  const cents = dollarsToSafeCents(value);
  return cents != null && cents >= 1 && cents <= 100_000_000 ? cents : null;
}

export function canStartGuidedShadow(input: {
  policy: AgentPolicy;
  gasInput: string;
  spendInput: string;
  authorized: boolean;
  shadowAvailable: boolean;
  dirty: boolean;
  paperExists: boolean;
  paperCapital: string;
  status: string;
  busy: boolean;
  reviewed: boolean;
  everyRoundAck: boolean;
  edgeOffAck: boolean;
  zeroReserveAck: boolean;
}): boolean {
  return input.authorized && input.shadowAvailable && !input.dirty && input.reviewed && !input.busy &&
    validateGuidedSession(input.policy, input.gasInput, input.spendInput).length === 0 &&
    (input.policy.frequency !== "EVERY_ELIGIBLE_ROUND" || input.everyRoundAck) &&
    (input.policy.edgeEnabled || input.edgeOffAck) &&
    (input.policy.reserveCents !== 0 || input.zeroReserveAck) &&
    (input.paperExists || paperCapitalFromInput(input.paperCapital) != null) &&
    input.status !== "SHADOW" && input.status !== "LOSS_STOP" && input.status !== "TARGET_REACHED";
}

export function validateGuidedSession(policy: AgentPolicy, gasInput: string, spendInput: string): string[] {
  const issues: string[] = [];
  const gasMist = suiToMist(gasInput);
  const spendCents = dollarsToSafeCents(spendInput);
  const durations = AGENT_SESSION_DURATIONS.map(duration => duration.milliseconds);
  if (!policy.intervals.length || policy.intervals.some(interval => interval !== 5 && interval !== 15)) issues.push("Choose at least one supported round interval.");
  if (policy.maxOrderCents == null || policy.maxOrderCents < 1 || policy.maxOrderCents > 500 ||
      policy.roundCollateralCents > 500 || policy.maxOrderCents > policy.roundCollateralCents ||
      (policy.sizingMode === "FIXED" && policy.fixedCents > 500)) {
    issues.push("Order and aggregate round limits must remain within the $5 beta ceiling.");
  }
  if (!Number.isSafeInteger(policy.sessionTurnoverCents) || policy.sessionTurnoverCents < 1 || policy.sessionTurnoverCents > 100_000_000 ||
      spendCents !== policy.sessionTurnoverCents) issues.push("Set a finite cumulative session spend cap in cents precision.");
  if (!durations.includes(policy.sessionDurationMs)) issues.push("Choose a supported finite session duration.");
  if (gasMist == null || gasMist !== policy.sessionGasBudgetMist || gasMist > 500_000_000) issues.push("Set a safe gas allowance from 0 to 0.5 SUI.");
  if (policy.network !== "mainnet") issues.push("A Sui mainnet policy is required.");
  if (policy.compound || policy.dailyTurnoverCents == null) {
    issues.push("Compounding or unlimited daily turnover is outside this bounded beta flow; explicitly narrow it under Advanced before a shadow start.");
  }
  return issues;
}