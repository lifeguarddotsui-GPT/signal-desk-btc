import { z } from "zod";

const money = z.number().int().min(0).max(100_000_000);
const percent = z.number().finite().min(0).max(100);
export const agentPolicySchema = z.object({
  network: z.enum(["testnet", "mainnet"]),
  intervals: z.array(z.union([z.literal(5), z.literal(15)])).min(1).max(2),
  signalSource: z.enum(["BLUEWATER_CHAMPION","EXPERIMENTAL_QUALIFICATION_GATES"]),
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
  roundCollateralCents: money.refine(n=>n>0).default(500),
  sessionTurnoverCents: money.refine(n=>n>0).default(1000),
  sessionLossCents: money.refine(n=>n>0).default(1000),
  sessionDurationMs: z.number().int().min(60000).max(604800000).default(3600000),
  sessionGasBudgetMist: z.number().int().min(0).max(500000000).default(0),
  minimumWinningReturnCents: money.refine(n=>n>0).default(600),
  preferredWinningReturnCents: money.refine(n=>n>0).default(700),
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
  if(p.preferredWinningReturnCents<p.minimumWinningReturnCents)
    c.addIssue({code:"custom",path:["preferredWinningReturnCents"],message:"Preferred return cannot be below the minimum preference; it is not a maximum."});
  if(p.network==="mainnet"&&p.fixedCents>p.roundCollateralCents)
    c.addIssue({code:"custom",path:["fixedCents"],message:"Order size cannot exceed the explicitly approved aggregate round limit"});
  for (const [path, v] of [["dailyLoss", p.dailyLoss], ["maxUnresolved", p.maxUnresolved]] as const) {
    if (v?.mode === "PERCENT" && v.value > 100) c.addIssue({ code: "custom", path: [path], message: "Percentage must be at most 100" });
    if (v?.mode === "AMOUNT" && !Number.isSafeInteger(v.value)) c.addIssue({ code: "custom", path: [path], message: "Amount must be integer cents" });
  }
});
export type AgentPolicy = z.infer<typeof agentPolicySchema>;
export const defaultAgentPolicy: AgentPolicy = {
  network: "mainnet", intervals: [5,15], signalSource: "BLUEWATER_CHAMPION",
  frequency: "SELECTIVE", selectiveMinProbability: .6, edgeEnabled: true, minimumEdgePp: 5,
  sizingMode: "FIXED", fixedCents: 500, sizingPercent: 10, allocationCents: 1000,
  compound: false, dailyTurnoverCents: 1000, dailyLoss: { mode: "AMOUNT", value: 400 },
  maxDrawdownPercent: 20, maxConsecutiveLosses: 3, reserveCents: 200, maxOrderCents: 500,
  maxUnresolved: { mode: "AMOUNT", value: 500 }, targetCents: null,
  roundCollateralCents:500,sessionTurnoverCents:1000,sessionLossCents:1000,
  sessionDurationMs:3600000,sessionGasBudgetMist:0,
  minimumWinningReturnCents:600,preferredWinningReturnCents:700,
  dailyProfitTargetCents: null, dailyProfitAction: "PAUSE", autoClaim: false,
  minRemainingMs: 10000, maxSignalAgeMs: 30000, maxQuoteAgeMs: 3000, orderTtlMs: 5000, slippageBps: 100,
};
export function policySummary(p: AgentPolicy): string[] {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  return [
    p.signalSource==="EXPERIMENTAL_QUALIFICATION_GATES"?"Experimental committed 30-second qualification gates — market-derived, uncalibrated, no profitability claim":"Qualified Bluewater champion",
    `${p.frequency === "SELECTIVE" ? "Selective" : "Every eligible"} BTC ${p.intervals.join("/")}m round`,
    p.edgeEnabled ? `At least ${p.minimumEdgePp} percentage points of verified net edge` : "Edge filter disabled — qualifying rounds may trade without positive estimated edge",
    p.sizingMode === "FIXED" ? `${usd(p.fixedCents)} per order` : `${p.sizingPercent}% of ${p.sizingMode !== "ALLOCATION_PERCENT" && p.compound ? "current available equity" : "original allocation"}`,
    `Compound ${p.compound ? "ON" : "OFF"}`,
    `${usd(p.roundCollateralCents)} aggregate all-in collateral per wallet/exact round`,
    `${usd(p.sessionTurnoverCents)} session turnover; ${usd(p.sessionLossCents)} session loss limit`,
    `${usd(p.minimumWinningReturnCents)}–${usd(p.preferredWinningReturnCents)} preferred total return on a win before costs; larger returns are allowed, no promise or forced lock`,
    `${Math.round(p.sessionDurationMs/60000)} minute session; ${(p.sessionGasBudgetMist/1e9).toFixed(3)} SUI authorized gas`,
    p.dailyTurnoverCents === null ? "Unlimited daily turnover; balance and all risk stops still apply" : `${usd(p.dailyTurnoverCents)} daily turnover limit`,
    `Reserve ${usd(p.reserveCents)}${p.reserveCents === 0 ? " — all available capital may be committed" : ""}`,
    p.targetCents === null ? "No account balance target" : `Pause new orders at ${usd(p.targetCents)} available equity`,
    "Daily counters reset at 00:00 UTC; session target and drawdown do not reset",
    "Auto claim OFF; no withdrawal or delegate-management authority",
  ];
}