import { z } from "zod";

export const VENUES = ["TYPUS_PERPS"] as const;
export type Venue = typeof VENUES[number];

export const venueSchema = z.enum(VENUES);

export const openActionSchema = z.object({
  type: z.literal("OPEN"),
  venue: venueSchema,
  market: z.string(),
  side: z.enum(["LONG", "SHORT"]),
  leverage: z.number().min(1).max(50),
  notionalUsd: z.number().positive(),
  sl: z.number().positive(),
  tp: z.number().positive().optional(),
});

export const closeActionSchema = z.object({
  type: z.literal("CLOSE"),
  venue: venueSchema,
  market: z.string(),
  pct: z.number().min(0.01).max(1),
});

export const setSltpActionSchema = z.object({
  type: z.literal("SET_SLTP"),
  venue: venueSchema,
  market: z.string(),
  sl: z.number().positive(),
  tp: z.number().positive().optional(),
});

export const claimRewardsActionSchema = z.object({
  type: z.literal("CLAIM_REWARDS"),
});

export const noopActionSchema = z.object({
  type: z.literal("NOOP"),
  reason: z.string(),
});

export const actionSchema = z.discriminatedUnion("type", [
  openActionSchema,
  closeActionSchema,
  setSltpActionSchema,
  claimRewardsActionSchema,
  noopActionSchema,
]);

export type OpenAction = z.infer<typeof openActionSchema>;
export type CloseAction = z.infer<typeof closeActionSchema>;
export type SetSltpAction = z.infer<typeof setSltpActionSchema>;
export type ClaimRewardsAction = z.infer<typeof claimRewardsActionSchema>;
export type NoopAction = z.infer<typeof noopActionSchema>;
export type Action = z.infer<typeof actionSchema>;

export const riskParamsSchema = z.object({
  maxNotionalUsd: z.number().positive(),
  maxLeverage: z.number().min(1).max(50),
  maxDailyLossUsd: z.number().positive(),
});

export type RiskParams = z.infer<typeof riskParamsSchema>;

export const instructionBundleSchema = z.object({
  bundleId: z.string().uuid(),
  agentId: z.string(),
  user: z.string(),
  vaultId: z.string().optional(),
  tradeCapId: z.string().optional(),
  createdAtMs: z.number().int().positive(),
  expiresAtMs: z.number().int().positive(),
  risk: riskParamsSchema,
  actions: z.array(actionSchema).min(1),
  signature: z.string().optional(),
});

export type InstructionBundle = z.infer<typeof instructionBundleSchema>;

export const bundleExecutionStatus = ["pending", "executing", "completed", "failed", "expired"] as const;
export type BundleExecutionStatus = typeof bundleExecutionStatus[number];

export interface BundleExecution {
  id: string;
  bundleId: string;
  agentId: string;
  status: BundleExecutionStatus;
  txDigest: string | null;
  venue: string | null;
  actionsExecuted: number;
  actionsFailed: number;
  error: string | null;
  executedAtMs: number | null;
  createdAtMs: number;
}

export const BUNDLE_MAX_AGE_MS = 30_000;
export const BUNDLE_DEFAULT_EXPIRY_MS = 30_000;

export function createBundle(params: {
  agentId: string;
  user: string;
  actions: Action[];
  risk: RiskParams;
  vaultId?: string;
  tradeCapId?: string;
}): InstructionBundle {
  const now = Date.now();
  return {
    bundleId: crypto.randomUUID(),
    agentId: params.agentId,
    user: params.user,
    vaultId: params.vaultId,
    tradeCapId: params.tradeCapId,
    createdAtMs: now,
    expiresAtMs: now + BUNDLE_DEFAULT_EXPIRY_MS,
    risk: params.risk,
    actions: params.actions,
  };
}

export function validateBundle(bundle: unknown): { valid: boolean; bundle?: InstructionBundle; error?: string } {
  const result = instructionBundleSchema.safeParse(bundle);
  if (!result.success) {
    return { valid: false, error: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  if (Date.now() > result.data.expiresAtMs) {
    return { valid: false, error: "Bundle has expired" };
  }
  for (const action of result.data.actions) {
    if ("venue" in action && "leverage" in action) {
      if (action.leverage > result.data.risk.maxLeverage) {
        return { valid: false, error: `Action leverage ${action.leverage} exceeds max ${result.data.risk.maxLeverage}` };
      }
    }
    if ("notionalUsd" in action) {
      if (action.notionalUsd > result.data.risk.maxNotionalUsd) {
        return { valid: false, error: `Action notional ${action.notionalUsd} exceeds max ${result.data.risk.maxNotionalUsd}` };
      }
    }
  }
  return { valid: true, bundle: result.data };
}
