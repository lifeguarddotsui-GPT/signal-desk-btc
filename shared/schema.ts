import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, boolean, timestamp, jsonb, serial, doublePrecision, uniqueIndex } from "drizzle-orm/pg-core";
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
  signalMode: text("signal_mode").notNull().default("AUTO"),
  profitRetentionPct: integer("profit_retention_pct").notNull().default(10),
  retainedProfits: real("retained_profits").notNull().default(0),
  isClone: boolean("is_clone").notNull().default(false),
  parentAgentId: varchar("parent_agent_id"),
  gasCapBreached: boolean("gas_cap_breached").notNull().default(false),
  gasCapBreachedAt: timestamp("gas_cap_breached_at"),
  gasCapReason: text("gas_cap_reason"),
  sessionGasUsed: real("session_gas_used").notNull().default(0),
  pausedBy: text("paused_by"),
  pausedReason: text("paused_reason"),
  estimatedResumeAt: timestamp("estimated_resume_at"),
  gasThrottleLevel: text("gas_throttle_level"),
  ownerClaimableBalance: real("owner_claimable_balance").notNull().default(0),
  lastAuditAt: timestamp("last_audit_at"),
  auditBalanceSui: real("audit_balance_sui"),
  savingsWallet: text("savings_wallet"),
  savingsWalletAddress: text("savings_wallet_address"),
  savingsSplitPct: integer("savings_split_pct").notNull().default(10),
  precisionAdjustmentsEnabled: boolean("precision_adjustments_enabled").notNull().default(true),
  antiIdleEnabled: boolean("anti_idle_enabled").notNull().default(true),
  dailyVolumeTargetSui: real("daily_volume_target_sui").default(0),
  volumeTargetEnabled: boolean("volume_target_enabled").notNull().default(true),
  baseStopLossBps: integer("base_stop_loss_bps"),
  baseTakeProfitBps: integer("base_take_profit_bps"),
  baseLeverage: integer("base_leverage"),
  baseMinCollateral: real("base_min_collateral"),
  baseMaxCollateral: real("base_max_collateral"),
  // ── Capital State Machine ───────────────────────────────────────────────────
  capitalMode: text("capital_mode").default("RECUPERATE"),
  capitalModeUpdatedAt: timestamp("capital_mode_updated_at"),
  equityPeak: real("equity_peak"),
  startingEquity: real("starting_equity"),
  // ── Dynamic Leverage Range ──────────────────────────────────────────────────
  leverageMin: integer("leverage_min"),
  leverageMax: integer("leverage_max"),
  dynamicLeverageEnabled: boolean("dynamic_leverage_enabled").notNull().default(false),
  // ── Risk Budget Config ──────────────────────────────────────────────────────
  riskPerTradePct: real("risk_per_trade_pct").default(0.005),
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
  collateral: real("collateral"),
  entryPrice: real("entry_price").notNull(),
  markPrice: real("mark_price").notNull(),
  unrealizedPnl: real("unrealized_pnl").notNull().default(0),
  liquidationPrice: real("liquidation_price"),
  status: text("status").notNull().default("open"),
  closeReason: text("close_reason"),
  txDigest: text("tx_digest"),
  closeTxDigest: text("close_tx_digest"),
  onChainPositionId: text("on_chain_position_id"),
  typusOrderId: text("typus_order_id"),
  closeState: text("close_state").notNull().default("open"),
  closeAttempts: integer("close_attempts").notNull().default(0),
  lastCloseTx: text("last_close_tx"),
  closePendingSince: timestamp("close_pending_since"),
  checkpoint: integer("checkpoint"),
  verified: boolean("verified").notNull().default(false),
  openedAt: timestamp("opened_at").defaultNow(),
  closedAt: timestamp("closed_at"),
  returnedSui: real("returned_sui"),
  pnlSource: text("pnl_source"),
  slPrice: real("sl_price"),
  tpPrice: real("tp_price"),
  riskPredictionId: text("risk_prediction_id"),
  // ── Frozen Probability Fields — written at entry, NEVER mutated ──────────
  entryProbability: doublePrecision("entry_probability"),
  entryProbabilityDisplay: integer("entry_probability_display"),
  entryConfidence: doublePrecision("entry_confidence"),
  entryExpectedEdgeBps: doublePrecision("entry_expected_edge_bps"),
  entryRegime: text("entry_regime"),
  entryCluster: text("entry_cluster"),
  probabilityBucket: text("probability_bucket"),
  probabilityVersion: text("probability_version"),
});

export const rewards = pgTable("rewards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  agentId: varchar("agent_id").notNull(),
  agentName: text("agent_name"),
  positionId: varchar("position_id"),
  amount: real("amount").notNull(),
  status: text("status").notNull().default("pending"),
  txDigest: text("tx_digest"),
  escrowTxDigest: text("escrow_tx_digest"),
  checkpoint: integer("checkpoint"),
  verified: boolean("verified").notNull().default(false),
  claimedAt: timestamp("claimed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const systemConfig = pgTable("system_config", {
  key: varchar("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const marketData = pgTable("market_data", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  symbol: text("symbol").notNull().default("SUI-PERP"),
  price: real("price").notNull(),
  pythPrice: real("pyth_price"),
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

export const typusTrackedOrders = pgTable("typus_tracked_orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  positionDbId: varchar("position_db_id").notNull(),
  typusOrderId: text("typus_order_id").notNull(),
  linkedPositionId: text("linked_position_id"),
  orderType: text("order_type").notNull(),
  txDigest: text("tx_digest"),
  status: text("status").notNull().default("submitted"),
  fillTxDigest: text("fill_tx_digest"),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const closeOutcomes = pgTable("close_outcomes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  positionDbId: varchar("position_db_id").notNull(),
  closeMethod: text("close_method").notNull(),
  regime: text("regime"),
  side: text("side"),
  label: text("label").notNull(),
  latencyMs: real("latency_ms"),
  slippageBps: real("slippage_bps"),
  pnlSui: real("pnl_sui"),
  closeTxDigest: text("close_tx_digest"),
  openTxDigest: text("open_tx_digest"),
  onChainPositionId: text("on_chain_position_id"),
  entryPrice: real("entry_price"),
  closePrice: real("close_price"),
  leverage: real("leverage"),
  collateral: real("collateral"),
  errorCode: text("error_code"),
  // ── Contextual learning enrichment ─────────────────────────────────────────
  atrPercentile: real("atr_percentile"),
  macdHist: real("macd_hist"),
  volumeRatio: real("volume_ratio"),
  contextualReward: real("contextual_reward"),
  closePolicyArm: text("close_policy_arm"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const agentCapitalSnapshots = pgTable("agent_capital_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  capitalMode: text("capital_mode").notNull(),
  currentEquity: real("current_equity").notNull(),
  equityPeak: real("equity_peak").notNull(),
  startingEquity: real("starting_equity").notNull(),
  drawdownPct: real("drawdown_pct").notNull(),
  recentPnl5: real("recent_pnl_5"),
  recentWinRate5: real("recent_win_rate_5"),
  recentLossStreak: integer("recent_loss_streak"),
  reasonTags: text("reason_tags"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const policyWeights = pgTable("policy_weights", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  market: text("market").notNull().default("SUI-PERP"),
  regime: text("regime").notNull(),
  actionKey: text("action_key").notNull(),
  trials: integer("trials").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  avgReward: real("avg_reward").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * performance_log — time-series ledger of portfolio and EV snapshots.
 * Written every 5 minutes by the performance tracker service.
 * Used to identify loss patterns and feed the learning engine.
 */
export const performanceLog = pgTable("performance_log", {
  id: serial("id").primaryKey(),
  ts: timestamp("ts").notNull().defaultNow(),
  userWallet: varchar("user_wallet", { length: 66 }).notNull(),
  portfolioValue: real("portfolio_value").notNull(),
  economicValue: real("economic_value"),
  netDeposited: real("net_deposited").notNull(),
  totalPnl: real("total_pnl").notNull(),
  winRate: real("win_rate"),
  openPositions: integer("open_positions").default(0),
  regime: varchar("regime", { length: 20 }),
  htfBias: varchar("htf_bias", { length: 10 }),
  signalScore: integer("signal_score"),
  signalSide: varchar("signal_side", { length: 10 }),
  activeAgents: integer("active_agents").default(0),
  lossReason: varchar("loss_reason", { length: 300 }),
  deltaPnl5m: real("delta_pnl_5m"),
  deltaEv5m: real("delta_ev_5m"),
});
export type PerformanceLog = typeof performanceLog.$inferSelect;
export type InsertPerformanceLog = typeof performanceLog.$inferInsert;

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

export type TypusTrackedOrder = typeof typusTrackedOrders.$inferSelect;
export type InsertTypusTrackedOrder = typeof typusTrackedOrders.$inferInsert;

export type CloseOutcome = typeof closeOutcomes.$inferSelect;
export type InsertCloseOutcome = typeof closeOutcomes.$inferInsert;
export type PolicyWeight = typeof policyWeights.$inferSelect;
export type InsertPolicyWeight = typeof policyWeights.$inferInsert;

export type AgentWithSignalAgent = Agent & { signalAgent: SignalAgent | null };

// Transfer Jobs — tracks in-flight SUI transfers between owned wallets (savings splits, reward claims, etc.)
export const transferJobs = pgTable("transfer_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  transferType: text("transfer_type").notNull(), // 'SAVINGS_SPLIT' | 'REWARD_CLAIM' | 'POSITION_SETTLEMENT'
  amountSui: real("amount_sui").notNull(),
  fromAddress: text("from_address"),
  toAddress: text("to_address"),
  txHash: text("tx_hash"),
  status: text("status").notNull().default("CREATED"), // CREATED | SUBMITTED | CONFIRMED | RECONCILED | FAILED
  initiatedAt: timestamp("initiated_at").defaultNow(),
  confirmedAt: timestamp("confirmed_at"),
  reconciledAt: timestamp("reconciled_at"),
  metadata: text("metadata"),
});
export type TransferJob = typeof transferJobs.$inferSelect;
export type InsertTransferJob = typeof transferJobs.$inferInsert;

// Agent Graveyard — preserves keypairs of deleted agents for future fund recovery
export const agentGraveyard = pgTable("agent_graveyard", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  originalAgentId: varchar("original_agent_id").notNull(),
  agentName: text("agent_name").notNull(),
  codename: text("codename"),
  walletAddress: text("wallet_address").notNull(),
  agentWallet: text("agent_wallet").notNull(),
  userId: varchar("user_id"),
  ownerWalletAddress: text("owner_wallet_address"),
  totalDeposited: real("total_deposited").default(0),
  totalPnl: real("total_pnl").default(0),
  totalTrades: integer("total_trades").default(0),
  balanceAtDeletion: real("balance_at_deletion").default(0),
  deletedAt: timestamp("deleted_at").defaultNow(),
  recoveredAt: timestamp("recovered_at"),
  recoveredTxDigest: text("recovered_tx_digest"),
  recoveredAmount: real("recovered_amount"),
});

export type AgentGraveyardEntry = typeof agentGraveyard.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// PER-USER REWARD WALLETS
// Each user (identified by their connected SUI wallet address) gets their own
// isolated reward wallet so rewards from their agents accumulate privately and
// are always claimable without depending on the shared global reward wallet balance.
// ─────────────────────────────────────────────────────────────────────────────

export const userRewardWallets = pgTable("user_reward_wallets", {
  id: serial("id").primaryKey(),
  ownerWallet: text("owner_wallet").notNull().unique(),
  address: text("address").notNull(),
  encryptedKey: text("encrypted_key").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type UserRewardWallet = typeof userRewardWallets.$inferSelect;
export type InsertUserRewardWallet = typeof userRewardWallets.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// RECONCILIATION LAYER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * position_journal — durable lifecycle record for every position.
 * Never deleted; each row persists from ENTRY_REQUESTED through SETTLED.
 * This is the source of truth for position display — UI never drops a card
 * just because an RPC read returned null.
 *
 * Lifecycle states:
 *   ENTRY_REQUESTED → ENTRY_SUBMITTED → ENTRY_CONFIRMED → LIVE →
 *   CLOSE_REQUESTED → CLOSE_SUBMITTED → CLOSE_CONFIRMED →
 *   SETTLEMENT_PENDING → SETTLED | LIQUIDATED | RECONCILIATION_ERROR
 */
export const positionJournal = pgTable("position_journal", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  positionId: varchar("position_id").notNull(), // FK to positions.id
  agentId: varchar("agent_id").notNull(),
  market: text("market").notNull().default("SUI-PERP"),
  side: text("side").notNull(), // long | short
  lifecycleState: text("lifecycle_state").notNull().default("ENTRY_REQUESTED"),
  // ENTRY_REQUESTED | ENTRY_SUBMITTED | ENTRY_CONFIRMED | LIVE |
  // CLOSE_REQUESTED | CLOSE_SUBMITTED | CLOSE_CONFIRMED |
  // SETTLEMENT_PENDING | SETTLED | LIQUIDATED | RECONCILIATION_ERROR
  entryPrice: real("entry_price"),
  exitPrice: real("exit_price"),
  collateralLocked: real("collateral_locked"),
  realizedPnl: real("realized_pnl"),
  fees: real("fees"),
  closeReason: text("close_reason"), // tp | sl | manual | liquidation | reduce | unknown
  settlementStatus: text("settlement_status"), // pending | confirmed | failed
  collateralReturned: real("collateral_returned"),
  settlementTxHash: text("settlement_tx_hash"),
  entryTxHash: text("entry_tx_hash"),
  closeTxHash: text("close_tx_hash"),
  entryRequestedAt: timestamp("entry_requested_at").defaultNow(),
  entryConfirmedAt: timestamp("entry_confirmed_at"),
  closeRequestedAt: timestamp("close_requested_at"),
  closeConfirmedAt: timestamp("close_confirmed_at"),
  settlementConfirmedAt: timestamp("settlement_confirmed_at"),
  lastReconciledAt: timestamp("last_reconciled_at"),
  sourceConfidence: text("source_confidence").notNull().default("pending"),
  // pending | live | verified | degraded
});
export type PositionJournalEntry = typeof positionJournal.$inferSelect;
export type InsertPositionJournalEntry = typeof positionJournal.$inferInsert;

/**
 * fund_flow_ledger — immutable journal of every SUI movement.
 * This is the canonical source for portfolio accounting.
 * Economic Value = sum of all credit events - sum of all debit events
 * for a given agent/user.
 *
 * Event types:
 *   USER_DEPOSIT | AGENT_FUNDING_ALLOCATED | AGENT_SAVINGS_TRANSFER |
 *   COLLATERAL_LOCKED | POSITION_OPEN_FEE | REALIZED_PNL |
 *   COLLATERAL_RELEASED | SETTLEMENT_RETURNED | REWARD_EARNED |
 *   REWARD_CLAIMED | IN_TRANSIT_OUT | IN_TRANSIT_IN |
 *   RECONCILIATION_ADJUSTMENT | GAS_SPENT
 */
export const fundFlowLedger = pgTable("fund_flow_ledger", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  positionId: varchar("position_id"), // nullable — not all flows are position-related
  eventType: text("event_type").notNull(),
  amount: real("amount").notNull(), // always positive
  direction: text("direction").notNull(), // debit | credit
  txHash: text("tx_hash"),
  sourceSystem: text("source_system").notNull().default("execution-engine"),
  // execution-engine | reconciler | wallet-sync | manual
  settlementBucket: text("settlement_bucket"), // grouping key for reconciliation
  confirmed: boolean("confirmed").notNull().default(false),
  notes: text("notes"),
  eventTime: timestamp("event_time").defaultNow(),
  reconciledAt: timestamp("reconciled_at"),
});
export type FundFlowEntry = typeof fundFlowLedger.$inferSelect;
export type InsertFundFlowEntry = typeof fundFlowLedger.$inferInsert;

/**
 * portfolio_snapshots — precomputed canonical portfolio state per agent.
 * Written by the reconciliation engine every 5s.
 * Frontend reads this first for instant coherent load.
 */
export const portfolioSnapshots = pgTable("portfolio_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull().unique(),
  settledFundingWallet: real("settled_funding_wallet").notNull().default(0),
  settledSavingsWallet: real("settled_savings_wallet").notNull().default(0),
  openCollateral: real("open_collateral").notNull().default(0),
  unrealizedPnl: real("unrealized_pnl").notNull().default(0),
  inTransit: real("in_transit").notNull().default(0),
  settlementPending: real("settlement_pending").notNull().default(0),
  claimableRewards: real("claimable_rewards").notNull().default(0),
  economicValue: real("economic_value").notNull().default(0),
  settledBalance: real("settled_balance").notNull().default(0),
  netDeposited: real("net_deposited").notNull().default(0),
  totalPnl: real("total_pnl").notNull().default(0),
  openPositionCount: integer("open_position_count").notNull().default(0),
  closingPositionCount: integer("closing_position_count").notNull().default(0),
  pendingSettlementCount: integer("pending_settlement_count").notNull().default(0),
  accountingHealth: real("accounting_health").notNull().default(0),
  // 0-100: % of economic value that is fully accounted and reconciled
  confidence: text("confidence").notNull().default("pending"),
  // pending | live | verified | degraded
  lastReconciledAt: timestamp("last_reconciled_at").defaultNow(),
  lastTypusSyncAt: timestamp("last_typus_sync_at"),
  degradedReason: text("degraded_reason"),
});
export type PortfolioSnapshot = typeof portfolioSnapshots.$inferSelect;
export type InsertPortfolioSnapshot = typeof portfolioSnapshots.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// PRECISION ADJUSTMENTS — Learning engine auto-tuning log
// ─────────────────────────────────────────────────────────────────────────────

export const precisionAdjustmentLogs = pgTable("precision_adjustment_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  field: text("field").notNull(),
  oldValue: real("old_value").notNull(),
  newValue: real("new_value").notNull(),
  reason: text("reason").notNull(),
  winRate: real("win_rate"),
  tradeCount: integer("trade_count"),
  appliedAt: timestamp("applied_at").defaultNow(),
});

export type PrecisionAdjustmentLog = typeof precisionAdjustmentLogs.$inferSelect;
export type InsertPrecisionAdjustmentLog = typeof precisionAdjustmentLogs.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// Market Sentiment Snapshots — SentimentFlow Engine
// ─────────────────────────────────────────────────────────────────────────────

export const marketSentimentSnapshots = pgTable("market_sentiment_snapshots", {
  id: serial("id").primaryKey(),
  venue: text("venue").notNull(),
  symbol: text("symbol").notNull(),
  timestamp: timestamp("timestamp").defaultNow(),
  markPrice: real("mark_price"),
  oiTotal: real("oi_total"),
  oiLongPct: real("oi_long_pct"),
  oiShortPct: real("oi_short_pct"),
  fundingRate: real("funding_rate"),
  netRateLong: real("net_rate_long"),
  netRateShort: real("net_rate_short"),
  tapeBuyNotional: real("tape_buy_notional"),
  tapeSellNotional: real("tape_sell_notional"),
  tapeBuyCount: integer("tape_buy_count"),
  tapeSellCount: integer("tape_sell_count"),
  largestBuy: real("largest_buy"),
  largestSell: real("largest_sell"),
  crowdingScore: real("crowding_score"),
  tapeScore: real("tape_score"),
  oiExpansionScore: real("oi_expansion_score"),
  fundingPressureScore: real("funding_pressure_score"),
  sentimentAdjustment: real("sentiment_adjustment"),
  regime: text("regime"),
  notes: text("notes").array(),
});

export type MarketSentimentSnapshot = typeof marketSentimentSnapshots.$inferSelect;
export type InsertMarketSentimentSnapshot = typeof marketSentimentSnapshots.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// BTC Overlay Snapshots — BTC Correlation Overlay Engine
// ─────────────────────────────────────────────────────────────────────────────

export const btcOverlaySnapshots = pgTable("btc_overlay_snapshots", {
  id: serial("id").primaryKey(),
  timestamp: timestamp("timestamp").defaultNow(),
  btcPrice: real("btc_price").notNull(),
  change5m: real("change_5m"),
  change15m: real("change_15m"),
  change60m: real("change_60m"),
  direction5m: text("direction_5m"),
  direction15m: text("direction_15m"),
  direction60m: text("direction_60m"),
  bias: text("bias"),
  strength: real("strength"),
  agreementScore: real("agreement_score"),
});

export type BtcOverlaySnapshot = typeof btcOverlaySnapshots.$inferSelect;
export type InsertBtcOverlaySnapshot = typeof btcOverlaySnapshots.$inferInsert;

// SUI Overlay Snapshots — SUI Price Momentum Overlay Engine
// ─────────────────────────────────────────────────────────────────────────────

export const suiOverlaySnapshots = pgTable("sui_overlay_snapshots", {
  id: serial("id").primaryKey(),
  timestamp: timestamp("timestamp").defaultNow(),
  suiPrice: real("sui_price").notNull(),
  change5m: real("change_5m"),
  change15m: real("change_15m"),
  change60m: real("change_60m"),
  direction5m: text("direction_5m"),
  direction15m: text("direction_15m"),
  direction60m: text("direction_60m"),
  bias: text("bias"),
  strength: real("strength"),
  agreementScore: real("agreement_score"),
});

export type SuiOverlaySnapshot = typeof suiOverlaySnapshots.$inferSelect;
export type InsertSuiOverlaySnapshot = typeof suiOverlaySnapshots.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// Agent Chat Messages — per-agent conversation history
// ─────────────────────────────────────────────────────────────────────────────

export const agentChatMessages = pgTable("agent_chat_messages", {
  id: serial("id").primaryKey(),
  agentId: varchar("agent_id").notNull(),
  role: text("role").notNull(), // "user" | "agent"
  content: text("content").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type AgentChatMessage = typeof agentChatMessages.$inferSelect;
export type InsertAgentChatMessage = typeof agentChatMessages.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// Probability Predictions — pre-trade win probability predictions
// ─────────────────────────────────────────────────────────────────────────────

export const probabilityPredictions = pgTable("probability_predictions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  side: text("side").notNull(),
  regime: text("regime"),
  predictedProbability: real("predicted_probability").notNull(),
  confidence: real("confidence").notNull(),
  expectedEdgeBps: real("expected_edge_bps"),
  expectedRR: real("expected_rr"),
  verdict: text("verdict").notNull(), // STRONG | WEAK | SKIP
  modelVersion: text("model_version"),
  featureJson: jsonb("feature_json"),
  linkedPositionId: varchar("linked_position_id"),
  resolvedOutcome: text("resolved_outcome"), // SUCCESS | PARTIAL | TIMEOUT | FAIL
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type ProbabilityPrediction = typeof probabilityPredictions.$inferSelect;
export type InsertProbabilityPrediction = typeof probabilityPredictions.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation Snapshots — rolling agent health diagnostics
// ─────────────────────────────────────────────────────────────────────────────

export const evaluationSnapshots = pgTable("evaluation_snapshots", {
  id: serial("id").primaryKey(),
  agentId: varchar("agent_id").notNull(),
  winRate10: real("win_rate_10"),
  winRate25: real("win_rate_25"),
  winRate50: real("win_rate_50"),
  avgPnl10: real("avg_pnl_10"),
  avgPnlPerRisk10: real("avg_pnl_per_risk_10"),
  avgSlippageBps10: real("avg_slippage_bps_10"),
  avgLatencyMs10: real("avg_latency_ms_10"),
  drawdownPct: real("drawdown_pct"),
  modelCalibrationScore: real("model_calibration_score"),
  regimeFitScore: real("regime_fit_score"),
  sideBiasScore: real("side_bias_score"),
  executionQualityScore: real("execution_quality_score"),
  deploymentStatus: text("deployment_status"), // GREEN | YELLOW | RED
  recommendationsJson: jsonb("recommendations_json"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type EvaluationSnapshot = typeof evaluationSnapshots.$inferSelect;
export type InsertEvaluationSnapshot = typeof evaluationSnapshots.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// Analysis Sentiment Snapshots — analysis agent market intelligence
// ─────────────────────────────────────────────────────────────────────────────

export const analysisSentimentSnapshots = pgTable("analysis_sentiment_snapshots", {
  id: serial("id").primaryKey(),
  overallScore: real("overall_score"),
  btcScore: real("btc_score"),
  suiScore: real("sui_score"),
  marketRiskScore: real("market_risk_score"),
  eventRiskScore: real("event_risk_score"),
  confidence: real("confidence"),
  bias: text("bias"), // BULLISH | BEARISH | NEUTRAL
  headlineSummaryJson: jsonb("headline_summary_json"),
  keyDriversJson: jsonb("key_drivers_json"),
  warningsJson: jsonb("warnings_json"),
  reportText: text("report_text"),
  sourcesUsedJson: jsonb("sources_used_json"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type AnalysisSentimentSnapshot = typeof analysisSentimentSnapshots.$inferSelect;
export type InsertAnalysisSentimentSnapshot = typeof analysisSentimentSnapshots.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// Risk Decisions — pre-trade risk management agent decisions
// ─────────────────────────────────────────────────────────────────────────────

export const riskDecisions = pgTable("risk_decisions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  side: text("side"),
  approved: boolean("approved").notNull(),
  sizeMultiplier: real("size_multiplier"),
  leverageMultiplier: real("leverage_multiplier"),
  stopLossMode: text("stop_loss_mode"),
  takeProfitMode: text("take_profit_mode"),
  posture: text("posture"), // DEFENSIVE | NEUTRAL | OFFENSIVE
  notesJson: jsonb("notes_json"),
  blockReason: text("block_reason"),
  probability: real("probability"),
  confidence: real("confidence"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type RiskDecision = typeof riskDecisions.$inferSelect;
export type InsertRiskDecision = typeof riskDecisions.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// Probability Calibration Stats — bucket-level accuracy tracking
// Tracks how well each probability band performs vs expectations.
// Updated on every trade close via the calibration engine.
// ─────────────────────────────────────────────────────────────────────────────

export const probabilityCalibrationStats = pgTable("probability_calibration_stats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  bucketLabel: text("bucket_label").notNull(),        // "90-99", "80-89", etc.
  bucketMinDisplay: integer("bucket_min_display").notNull(),
  bucketMaxDisplay: integer("bucket_max_display").notNull(),
  sampleSize: integer("sample_size").notNull().default(0),
  winCount: integer("win_count").notNull().default(0),
  lossCount: integer("loss_count").notNull().default(0),
  actualWinRate: doublePrecision("actual_win_rate").notNull().default(0),
  expectedWinRate: doublePrecision("expected_win_rate").notNull().default(0),
  calibrationGap: doublePrecision("calibration_gap").notNull().default(0),
  avgPnlBps: doublePrecision("avg_pnl_bps").notNull().default(0),
  avgPnlUsd: doublePrecision("avg_pnl_usd").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
},
(table) => ({
  agentBucketIdx: uniqueIndex("prob_cal_agent_bucket_idx").on(table.agentId, table.bucketLabel),
}));

export type ProbabilityCalibrationStat = typeof probabilityCalibrationStats.$inferSelect;
export type InsertProbabilityCalibrationStat = typeof probabilityCalibrationStats.$inferInsert;
