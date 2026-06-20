import { pgTable, text, integer, real, boolean, timestamp, jsonb, serial } from "drizzle-orm/pg-core";
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
