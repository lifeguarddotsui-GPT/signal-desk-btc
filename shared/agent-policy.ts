import { z } from "zod";

const money = z.number().int().min(0).max(100_000_000);
const percent = z.number().finite().min(0).max(100);
export const agentPolicySchema = z.object({
  network: z.enum(["testnet", "mainnet"]),
  intervals: z.array(z.union([z.literal(5), z.literal(15)])).min(1).max(2),
  signalSource: z.literal("BLUEWATER_CHAMPION"),
  frequency: z.enum(["SELECTIVE", "EVERY_ELIGIBLE_ROUND"]),
  selectiveMinProbability: z.number().min(.5).max(1),
  edgeEnabled: z.boolean(),
  minimumEdgePp: z.number().min(0).max(100),
  sizingMode: z.enum(["FIXED", "AVAILABLE_PERCENT", "ALLOCATION_PERCENT"]),
  fixedCents: money.refine(n => n > 0),
  sizingPercent: percent.refine(n => n > 0),
  allocationCents: money.refine(n => n > 0),
  compound: z.boolean(),
  dailyTurnoverCents: money.nullable(),
  dailyLoss: z.object({ mode: z.enum(["AMOUNT", "PERCENT"]), value: z.number().positive().max(100_000_000) }).strict().nullable(),
  maxDrawdownPercent: percent.nullable(),
  maxConsecutiveLosses: z.number().int().positive().max(10000).nullable(),
  reserveCents: money,
  maxOrderCents: money.nullable(),
  maxUnresolved: z.object({ mode: z.enum(["AMOUNT", "PERCENT"]), value: z.number().positive().max(100_000_000) }).strict(),
  targetCents: money.nullable(),
  dailyProfitTargetCents: money.nullable(),
  dailyProfitAction: z.enum(["PAUSE", "CONTINUE"]),
  autoClaim: z.literal(false),
  minRemainingMs: z.number().int().min(5000).max(180000),
  maxSignalAgeMs: z.number().int().min(1000).max(60000),
  maxQuoteAgeMs: z.number().int().min(100).max(5000),
  orderTtlMs: z.number().int().min(1000).max(10000),
  slippageBps: z.number().int().min(0).max(500),
}).strict().superRefine((p, c) => {
  if (new Set(p.intervals).size !== p.intervals.length) c.addIssue({ code: "custom", path: ["intervals"], message: "Duplicate interval" });
  for (const [path, v] of [["dailyLoss", p.dailyLoss], ["maxUnresolved", p.maxUnresolved]] as const) {
    if (v?.mode === "PERCENT" && v.value > 100) c.addIssue({ code: "custom", path: [path], message: "Percentage must be at most 100" });
    if (v?.mode === "AMOUNT" && !Number.isSafeInteger(v.value)) c.addIssue({ code: "custom", path: [path], message: "Amount must be integer cents" });
  }
});
export type AgentPolicy = z.infer<typeof agentPolicySchema>;
export const defaultAgentPolicy: AgentPolicy = {
  network: "testnet", intervals: [5], signalSource: "BLUEWATER_CHAMPION",
  frequency: "SELECTIVE", selectiveMinProbability: .6, edgeEnabled: true, minimumEdgePp: 5,
  sizingMode: "AVAILABLE_PERCENT", fixedCents: 500, sizingPercent: 10, allocationCents: 1000,
  compound: true, dailyTurnoverCents: 2500, dailyLoss: { mode: "AMOUNT", value: 400 },
  maxDrawdownPercent: 20, maxConsecutiveLosses: 3, reserveCents: 200, maxOrderCents: 2000,
  maxUnresolved: { mode: "PERCENT", value: 30 }, targetCents: null,
  dailyProfitTargetCents: null, dailyProfitAction: "PAUSE", autoClaim: false,
  minRemainingMs: 10000, maxSignalAgeMs: 30000, maxQuoteAgeMs: 3000, orderTtlMs: 5000, slippageBps: 100,
};
export function policySummary(p: AgentPolicy): string[] {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  return [
    `${p.frequency === "SELECTIVE" ? "Selective" : "Every eligible"} BTC ${p.intervals.join("/")}m round`,
    p.edgeEnabled ? `At least ${p.minimumEdgePp} percentage points of verified net edge` : "Edge filter disabled — qualifying rounds may trade without positive estimated edge",
    p.sizingMode === "FIXED" ? `${usd(p.fixedCents)} per order` : `${p.sizingPercent}% of ${p.sizingMode !== "ALLOCATION_PERCENT" && p.compound ? "current available equity" : "original allocation"}`,
    `Compound ${p.compound ? "ON" : "OFF"}`,
    p.dailyTurnoverCents === null ? "Unlimited daily turnover; balance and all risk stops still apply" : `${usd(p.dailyTurnoverCents)} daily turnover limit`,
    `Reserve ${usd(p.reserveCents)}${p.reserveCents === 0 ? " — all available capital may be committed" : ""}`,
    p.targetCents === null ? "No account balance target" : `Pause new orders at ${usd(p.targetCents)} available equity`,
    "Daily counters reset at 00:00 UTC; session target and drawdown do not reset",
    "Auto claim OFF; no withdrawal or delegate-management authority",
  ];
}