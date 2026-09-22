import {
  pgTable, text, integer, real, boolean, timestamp, jsonb, serial,
  uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const markets = pgTable("pred_markets", {
  id: serial("id").primaryKey(),
  coinbaseMarketId: text("coinbase_market_id").notNull().unique(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  asset: text("asset"),
  sport: text("sport"),
  status: text("status").notNull().default("active"),
  expirationTime: timestamp("expiration_time"),
  volume: real("volume").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const outcomes = pgTable("pred_outcomes", {
  id: serial("id").primaryKey(),
  marketId: integer("market_id").references(() => markets.id).notNull(),
  label: text("label").notNull(),
  price: real("price").notNull(),
  impliedProbability: real("implied_probability").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const marketSnapshots = pgTable("pred_snapshots", {
  id: serial("id").primaryKey(),
  marketId: integer("market_id").references(() => markets.id).notNull(),
  yesPrice: real("yes_price").notNull(),
  noPrice: real("no_price").notNull(),
  spotPrice: real("spot_price"),
  targetPrice: real("target_price"),
  volume: real("volume").default(0),
  timeRemainingSeconds: integer("time_remaining_seconds"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const signals = pgTable("pred_signals", {
  id: serial("id").primaryKey(),
  marketId: integer("market_id").references(() => markets.id).notNull(),
  recommendedSide: text("recommended_side").notNull(),
  confidenceScore: real("confidence_score").notNull(),
  edgeScore: real("edge_score").notNull(),
  riskScore: real("risk_score").notNull(),
  reasoning: text("reasoning").notNull(),
  supportingDataJson: jsonb("supporting_data_json"),
  rankToday: integer("rank_today"),
  maxBetPct: real("max_bet_pct"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const alerts = pgTable("pred_alerts", {
  id: serial("id").primaryKey(),
  signalId: integer("signal_id").references(() => signals.id),
  alertType: text("alert_type").notNull(),
  message: text("message").notNull(),
  sentStatus: text("sent_status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const appSettings = pgTable("pred_settings", {
  id: serial("id").primaryKey(),
  bankrollAmount: real("bankroll_amount").notNull().default(1000),
  emailNotifications: boolean("email_notifications").notNull().default(false),
  minConfidenceAlert: real("min_confidence_alert").notNull().default(8.0),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type Market = typeof markets.$inferSelect;
export type InsertMarket = typeof markets.$inferInsert;
export type Outcome = typeof outcomes.$inferSelect;
export type InsertOutcome = typeof outcomes.$inferInsert;
export type MarketSnapshot = typeof marketSnapshots.$inferSelect;
export type Signal = typeof signals.$inferSelect;
export type InsertSignal = typeof signals.$inferInsert;
export type Alert = typeof alerts.$inferSelect;
export type InsertAlert = typeof alerts.$inferInsert;
export type AppSettings = typeof appSettings.$inferSelect;

export const insertMarketSchema = createInsertSchema(markets).omit({ id: true, createdAt: true, updatedAt: true });
export const insertSignalSchema = createInsertSchema(signals).omit({ id: true, createdAt: true });
export const insertAlertSchema = createInsertSchema(alerts).omit({ id: true, createdAt: true });
export const updateSettingsSchema = createInsertSchema(appSettings).omit({ id: true, updatedAt: true });

// Accumulation tables are additive. The pred_* tables above intentionally remain
// available for historical records, but are not used by the accumulation routes.
// Amounts that can reach chain arithmetic are text so JavaScript never coerces
// MIST or token base units through a floating point number.
export const campaigns = pgTable("accumulation_campaigns", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  network: text("network").notNull().default("mainnet"),
  mode: text("mode").notNull().default("OBSERVE"),
  status: text("status").notNull().default("active"),
  ownerAddress: text("owner_address"),
  agentAddress: text("agent_address"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const botPolicies = pgTable("accumulation_bot_policies", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").references(() => campaigns.id).notNull(),
  version: text("version").notNull(),
  status: text("status").notNull().default("active"),
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  campaignVersionUnique: uniqueIndex("accumulation_bot_policies_campaign_version_uq")
    .on(table.campaignId, table.version),
}));

export const assets = pgTable("accumulation_assets", {
  id: text("id").primaryKey(),
  network: text("network").notNull().default("mainnet"),
  coinType: text("coin_type").notNull(),
  packageId: text("package_id").notNull().default(""),
  curveId: text("curve_id").notNull().default(""),
  symbol: text("symbol"),
  status: text("status").notNull().default("observed"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  identityUnique: uniqueIndex("accumulation_assets_identity_uq")
    .on(table.network, table.coinType, table.packageId, table.curveId),
}));

export const marketObservations = pgTable("accumulation_market_observations", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").references(() => assets.id).notNull(),
  checkpoint: text("checkpoint").notNull(),
  observedAt: timestamp("observed_at").notNull(),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
  provider: text("provider").notNull(),
  coverageStatus: text("coverage_status").notNull().default("UNKNOWN"),
  data: jsonb("data").notNull(),
}, (table) => ({
  assetCheckpointIndex: index("accumulation_observations_asset_checkpoint_idx")
    .on(table.assetId, table.checkpoint, table.provider),
  checkpointIndex: index("accumulation_observations_checkpoint_idx").on(table.checkpoint),
}));

export const marketEvents = pgTable("accumulation_market_events", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().unique(),
  assetId: text("asset_id").references(() => assets.id),
  checkpoint: text("checkpoint").notNull(),
  eventType: text("event_type").notNull(),
  txDigest: text("tx_digest"),
  provider: text("provider").notNull(),
  payload: jsonb("payload").notNull(),
  occurredAt: timestamp("occurred_at").notNull(),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
});

export const decisions = pgTable("accumulation_decisions", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").references(() => campaigns.id).notNull(),
  assetId: text("asset_id").references(() => assets.id),
  decisionKey: text("decision_key").notNull().unique(),
  policyVersion: text("policy_version").notNull(),
  action: text("action").notNull(),
  featureSnapshot: jsonb("feature_snapshot").notNull(),
  quote: jsonb("quote"),
  costModel: jsonb("cost_model"),
  rejectionReasons: jsonb("rejection_reasons").notNull(),
  outcome: text("outcome").notNull().default("PENDING"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const positions = pgTable("accumulation_positions", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").references(() => campaigns.id).notNull(),
  assetId: text("asset_id").references(() => assets.id).notNull(),
  unitsBase: text("units_base").notNull().default("0"),
  costMist: text("cost_mist").notNull().default("0"),
  realizedMist: text("realized_mist").notNull().default("0"),
  status: text("status").notNull().default("OPEN"),
  openedAt: timestamp("opened_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  campaignAssetUnique: uniqueIndex("accumulation_positions_campaign_asset_uq")
    .on(table.campaignId, table.assetId),
}));

export const ledgerEntries = pgTable("accumulation_ledger_entries", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").references(() => campaigns.id).notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  entryType: text("entry_type").notNull(),
  suiMist: text("sui_mist").notNull().default("0"),
  tokenAmountBase: text("token_amount_base"),
  assetId: text("asset_id").references(() => assets.id),
  referenceType: text("reference_type"),
  referenceId: text("reference_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const workerLeases = pgTable("accumulation_worker_leases", {
  id: text("id").primaryKey(),
  workerName: text("worker_name").notNull().unique(),
  fencingToken: text("fencing_token").notNull(),
  holder: text("holder").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  renewedAt: timestamp("renewed_at").defaultNow().notNull(),
});

export const collectorCheckpoints = pgTable("accumulation_collector_checkpoints", {
  collectorName: text("collector_name").primaryKey(),
  source: text("source").notNull(),
  status: text("status").notNull().default("STARTING"),
  lastCheckpoint: text("last_checkpoint"),
  providerEventCount: text("provider_event_count"),
  collectedObservationCount: integer("collected_observation_count").notNull().default(0),
  verifiedAssetCount: integer("verified_asset_count").notNull().default(0),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  lastSuccessAt: timestamp("last_success_at"),
  lastError: text("last_error"),
  replayFromCheckpoint: text("replay_from_checkpoint"),
  lastCompleteCheckpoint: text("last_complete_checkpoint"),
  replayStatus: text("replay_status").notNull().default("UNPROVEN"),
  gapCount: integer("gap_count").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const ownerSessions = pgTable("accumulation_owner_sessions", {
  sid: text("sid").primaryKey(),
  sess: jsonb("sess").notNull(),
  expire: timestamp("expire").notNull(),
}, (table) => ({
  expireIndex: index("accumulation_owner_sessions_expire_idx").on(table.expire),
}));

export const walletAuthChallenges = pgTable("accumulation_wallet_auth_challenges", {
  nonceHash: text("nonce_hash").primaryKey(),
  sessionHash: text("session_hash").notNull(),
  walletAddress: text("wallet_address").notNull(),
  message: text("message").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  sessionIndex: index("accumulation_wallet_auth_challenges_session_idx").on(table.sessionHash),
  expiryIndex: index("accumulation_wallet_auth_challenges_expiry_idx").on(table.expiresAt),
}));

export const protocolManifests = pgTable("accumulation_protocol_manifests", {
  id: text("id").primaryKey(),
  network: text("network").notNull(),
  packageId: text("package_id").notNull(),
  definingPackageId: text("defining_package_id"),
  version: text("version").notNull(),
  manifest: jsonb("manifest").notNull(),
  checksum: text("checksum").notNull(),
  status: text("status").notNull().default("UNRESOLVED"),
  validFromCheckpoint: text("valid_from_checkpoint"),
  evidenceDigests: jsonb("evidence_digests").notNull(),
  verifiedAt: timestamp("verified_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const candidateRankings = pgTable("accumulation_candidate_rankings", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").references(() => assets.id).notNull(),
  checkpoint: text("checkpoint").notNull(),
  strategyVersion: text("strategy_version").notNull(),
  score: integer("score").notNull(),
  components: jsonb("components").notNull(),
  hardVetoes: jsonb("hard_vetoes").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  rankedAt: timestamp("ranked_at").defaultNow().notNull(),
}, (table) => ({
  reproducibleUnique: uniqueIndex("accumulation_candidate_rankings_repro_uq")
    .on(table.assetId, table.checkpoint, table.strategyVersion),
}));

export const agentWallets = pgTable("accumulation_agent_wallets", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").references(() => campaigns.id).notNull(),
  ownerAddress: text("owner_address").notNull(),
  agentAddress: text("agent_address"),
  signerKeyReference: text("signer_key_reference"),
  mode: text("mode").notNull().default("PAPER"),
  status: text("status").notNull().default("PAPER_ACTIVE"),
  riskPolicyVersion: text("risk_policy_version").notNull().default("canary-v1"),
  withdrawalAddress: text("withdrawal_address").notNull(),
  armedAt: timestamp("armed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  campaignUnique: uniqueIndex("accumulation_agent_wallets_campaign_uq").on(table.campaignId),
  ownerIndex: index("accumulation_agent_wallets_owner_idx").on(table.ownerAddress),
}));

export const executionRecords = pgTable("accumulation_execution_records", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").references(() => campaigns.id).notNull(),
  decisionId: text("decision_id").references(() => decisions.id),
  assetId: text("asset_id").references(() => assets.id),
  kind: text("kind").notNull(),
  state: text("state").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  transactionHash: text("transaction_hash"),
  transactionDigest: text("transaction_digest"),
  checkpoint: text("checkpoint"),
  evidence: jsonb("evidence").notNull(),
  failureCode: text("failure_code"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const collectorDeadLetters = pgTable("accumulation_collector_dead_letters", {
  id: text("id").primaryKey(),
  collectorName: text("collector_name").notNull(),
  checkpoint: text("checkpoint"),
  sourceId: text("source_id"),
  errorCode: text("error_code").notNull(),
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const researchSnapshots = pgTable("accumulation_research_snapshots", {
  id: text("id").primaryKey(),
  snapshotKey: text("snapshot_key").notNull().unique(),
  status: text("status").notNull().default("UNAVAILABLE"),
  evidence: jsonb("evidence").notNull(),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
});

export const policyProposals = pgTable("accumulation_policy_proposals", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").references(() => campaigns.id),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  proposedVersion: text("proposed_version").notNull(),
  proposal: jsonb("proposal").notNull(),
  status: text("status").notNull().default("PENDING_REVIEW"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const withdrawals = pgTable("accumulation_withdrawals", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").references(() => campaigns.id).notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  destinationAddress: text("destination_address").notNull(),
  amountMist: text("amount_mist").notNull().default("0"),
  status: text("status").notNull().default("BLOCKED"),
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Campaign = typeof campaigns.$inferSelect;
export type BotPolicy = typeof botPolicies.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type MarketObservation = typeof marketObservations.$inferSelect;
export type MarketEvent = typeof marketEvents.$inferSelect;
export type Decision = typeof decisions.$inferSelect;
export type Position = typeof positions.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type WorkerLease = typeof workerLeases.$inferSelect;
export type CollectorCheckpoint = typeof collectorCheckpoints.$inferSelect;
export type ResearchSnapshot = typeof researchSnapshots.$inferSelect;
export type PolicyProposal = typeof policyProposals.$inferSelect;
export type Withdrawal = typeof withdrawals.$inferSelect;
