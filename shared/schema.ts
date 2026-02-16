import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const PROTOCOL_FEE_ADDRESS = "0xf40709feb6dcdbfbc4f93eff4ddf50137ea6e1dc4f7a4167e7e260a8569613d6";
export const PROTOCOL_FEE_RATE = 0.02;

export const SUI_COIN_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const signalAgents = pgTable("signal_agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  executionAgentId: varchar("execution_agent_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  strategy: text("strategy").notNull().default("momentum"),
  indicators: text("indicators").array().notNull().default(sql`ARRAY['rsi','connorsRsi','ema','dema','tema']`),
  signalThreshold: integer("signal_threshold").notNull().default(3),
  lastSignal: text("last_signal"),
  lastSignalScore: text("last_signal_score"),
  lastSignalAt: timestamp("last_signal_at"),
  signalCount: integer("signal_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const agents = pgTable("agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("idle"),
  venue: text("venue").notNull().default("typus"),
  agentWallet: text("agent_wallet"),
  walletAddress: text("wallet_address"),
  signalAgentId: varchar("signal_agent_id"),
  leverage: integer("leverage").notNull().default(5),
  maxQty: real("max_qty").notNull().default(1),
  minCollateral: real("min_collateral").notNull().default(0.4),
  maxCollateral: real("max_collateral").notNull().default(10),
  stopLossBps: integer("stop_loss_bps").notNull().default(80),
  takeProfitBps: integer("take_profit_bps"),
  autoTrade: boolean("auto_trade").notNull().default(false),
  rewardSharePct: integer("reward_share_pct").notNull().default(50),
  balance: real("balance").notNull().default(0),
  totalDeposited: real("total_deposited").notNull().default(0),
  protocolFeePaid: real("protocol_fee_paid").notNull().default(0),
  totalPnl: real("total_pnl").notNull().default(0),
  totalTrades: integer("total_trades").notNull().default(0),
  winRate: real("win_rate").notNull().default(0),
  lastSignalSide: text("last_signal_side"),
  lastSignalReason: text("last_signal_reason"),
  lastSignalAt: timestamp("last_signal_at"),
  lastExecutionError: text("last_execution_error"),
  lastExecutionAt: timestamp("last_execution_at"),
  isClone: boolean("is_clone").notNull().default(false),
  parentAgentId: varchar("parent_agent_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const signals = pgTable("signals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id"),
  signalAgentId: varchar("signal_agent_id"),
  symbol: text("symbol").notNull().default("SUI-PERP"),
  price: real("price").notNull(),
  rsi: real("rsi").notNull(),
  connorsRsi: real("connors_rsi"),
  ema9: real("ema9").notNull(),
  ema21: real("ema21").notNull(),
  dema: real("dema"),
  tema: real("tema"),
  signal: text("signal").notNull(),
  signalScore: text("signal_score"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const orders = pgTable("orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  signalId: varchar("signal_id"),
  symbol: text("symbol").notNull().default("SUI-PERP"),
  side: text("side").notNull(),
  type: text("type").notNull().default("limit"),
  leverage: integer("leverage").notNull(),
  qty: real("qty").notNull(),
  price: real("price").notNull(),
  entryPrice: real("entry_price"),
  stopLossPrice: real("stop_loss_price"),
  takeProfitPrice: real("take_profit_price"),
  status: text("status").notNull().default("open"),
  pnl: real("pnl"),
  venue: text("venue").notNull(),
  txDigest: text("tx_digest"),
  checkpoint: integer("checkpoint"),
  verified: boolean("verified").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const positions = pgTable("positions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  symbol: text("symbol").notNull().default("SUI-PERP"),
  side: text("side").notNull(),
  sizeSui: real("size_sui").notNull(),
  entryPrice: real("entry_price").notNull(),
  markPrice: real("mark_price").notNull(),
  unrealizedPnl: real("unrealized_pnl").notNull().default(0),
  liquidationPrice: real("liquidation_price"),
  status: text("status").notNull().default("open"),
  txDigest: text("tx_digest"),
  onChainPositionId: text("on_chain_position_id"),
  checkpoint: integer("checkpoint"),
  verified: boolean("verified").notNull().default(false),
  openedAt: timestamp("opened_at").defaultNow(),
  closedAt: timestamp("closed_at"),
});

export const rewards = pgTable("rewards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  agentId: varchar("agent_id").notNull(),
  amount: real("amount").notNull(),
  status: text("status").notNull().default("pending"),
  txDigest: text("tx_digest"),
  checkpoint: integer("checkpoint"),
  verified: boolean("verified").notNull().default(false),
  claimedAt: timestamp("claimed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const marketData = pgTable("market_data", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  symbol: text("symbol").notNull().default("SUI-PERP"),
  price: real("price").notNull(),
  pythPrice: real("pyth_price"),
  sudoPrice: real("sudo_price"),
  high24h: real("high_24h").notNull(),
  low24h: real("low_24h").notNull(),
  volume24h: real("volume_24h").notNull(),
  change24h: real("change_24h").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const protocolFees = pgTable("protocol_fees", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  userId: varchar("user_id").notNull(),
  amount: real("amount").notNull(),
  feeAddress: text("fee_address").notNull().default(PROTOCOL_FEE_ADDRESS),
  txDigest: text("tx_digest"),
  checkpoint: integer("checkpoint"),
  verified: boolean("verified").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const deposits = pgTable("deposits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  depositorAddress: text("depositor_address").notNull(),
  amount: real("amount").notNull(),
  grossAmount: real("gross_amount").notNull(),
  protocolFee: real("protocol_fee").notNull(),
  txDigest: text("tx_digest"),
  checkpoint: integer("checkpoint"),
  verified: boolean("verified").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const instructionBundles = pgTable("instruction_bundles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  bundleId: text("bundle_id").notNull().unique(),
  agentId: varchar("agent_id").notNull(),
  userAddress: text("user_address").notNull(),
  vaultId: text("vault_id"),
  tradeCapId: text("trade_cap_id"),
  actions: jsonb("actions").notNull(),
  risk: jsonb("risk").notNull(),
  status: text("status").notNull().default("pending"),
  expiresAtMs: real("expires_at_ms").notNull(),
  signature: text("signature"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const bundleExecutions = pgTable("bundle_executions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  bundleId: text("bundle_id").notNull(),
  agentId: varchar("agent_id").notNull(),
  status: text("status").notNull().default("pending"),
  txDigest: text("tx_digest"),
  venue: text("venue"),
  actionsExecuted: integer("actions_executed").notNull().default(0),
  actionsFailed: integer("actions_failed").notNull().default(0),
  error: text("error"),
  executedAt: timestamp("executed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const verifiedTransactions = pgTable("verified_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  txDigest: text("tx_digest").notNull().unique(),
  txType: text("tx_type").notNull(),
  agentId: varchar("agent_id"),
  userId: varchar("user_id"),
  checkpoint: integer("checkpoint"),
  sender: text("sender"),
  rawData: jsonb("raw_data"),
  verified: boolean("verified").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export const insertSignalAgentSchema = createInsertSchema(signalAgents).omit({
  id: true, createdAt: true, lastSignal: true, lastSignalScore: true, lastSignalAt: true, signalCount: true, status: true,
});
export const insertAgentSchema = createInsertSchema(agents).omit({
  id: true, createdAt: true, totalPnl: true, totalTrades: true, winRate: true,
  agentWallet: true, walletAddress: true, status: true, balance: true, totalDeposited: true, protocolFeePaid: true,
  lastSignalSide: true, lastSignalReason: true, lastSignalAt: true, signalAgentId: true,
});
export const insertSignalSchema = createInsertSchema(signals).omit({ id: true, createdAt: true });
export const insertOrderSchema = createInsertSchema(orders).omit({ id: true, createdAt: true, pnl: true, status: true, verified: true, checkpoint: true });
export const insertPositionSchema = createInsertSchema(positions).omit({ id: true, openedAt: true, closedAt: true, status: true, verified: true, checkpoint: true });
export const insertRewardSchema = createInsertSchema(rewards).omit({ id: true, createdAt: true, claimedAt: true, status: true, txDigest: true, verified: true, checkpoint: true });
export const insertProtocolFeeSchema = createInsertSchema(protocolFees).omit({ id: true, createdAt: true, verified: true, checkpoint: true });
export const insertDepositSchema = createInsertSchema(deposits).omit({ id: true, createdAt: true });
export const insertInstructionBundleSchema = createInsertSchema(instructionBundles).omit({ id: true, createdAt: true });
export const insertBundleExecutionSchema = createInsertSchema(bundleExecutions).omit({ id: true, createdAt: true, executedAt: true });

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type SignalAgent = typeof signalAgents.$inferSelect;
export type InsertSignalAgent = z.infer<typeof insertSignalAgentSchema>;
export type Agent = typeof agents.$inferSelect;
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Signal = typeof signals.$inferSelect;
export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type Order = typeof orders.$inferSelect;
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Position = typeof positions.$inferSelect;
export type InsertPosition = z.infer<typeof insertPositionSchema>;
export type Reward = typeof rewards.$inferSelect;
export type InsertReward = z.infer<typeof insertRewardSchema>;
export type MarketData = typeof marketData.$inferSelect;
export type ProtocolFee = typeof protocolFees.$inferSelect;
export type InsertProtocolFee = z.infer<typeof insertProtocolFeeSchema>;
export type VerifiedTransaction = typeof verifiedTransactions.$inferSelect;
export type Deposit = typeof deposits.$inferSelect;
export type InsertDeposit = z.infer<typeof insertDepositSchema>;
export type InstructionBundleRecord = typeof instructionBundles.$inferSelect;
export type InsertInstructionBundle = z.infer<typeof insertInstructionBundleSchema>;
export type BundleExecutionRecord = typeof bundleExecutions.$inferSelect;
export type InsertBundleExecution = z.infer<typeof insertBundleExecutionSchema>;

export type AgentWithSignalAgent = Agent & { signalAgent: SignalAgent | null };
