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