import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const agents = pgTable("agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("idle"),
  venue: text("venue").notNull().default("bluefin"),
  agentWallet: text("agent_wallet"),
  leverage: integer("leverage").notNull().default(5),
  maxQty: real("max_qty").notNull().default(1),
  stopLossBps: integer("stop_loss_bps").notNull().default(80),
  takeProfitBps: integer("take_profit_bps"),
  autoTrade: boolean("auto_trade").notNull().default(false),
  totalPnl: real("total_pnl").notNull().default(0),
  totalTrades: integer("total_trades").notNull().default(0),
  winRate: real("win_rate").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const signals = pgTable("signals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id"),
  symbol: text("symbol").notNull().default("SUI-PERP"),
  price: real("price").notNull(),
  rsi: real("rsi").notNull(),
  ema9: real("ema9").notNull(),
  ema21: real("ema21").notNull(),
  signal: text("signal").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const orders = pgTable("orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  symbol: text("symbol").notNull().default("SUI-PERP"),
  side: text("side").notNull(),
  leverage: integer("leverage").notNull(),
  qty: real("qty").notNull(),
  entryPrice: real("entry_price").notNull(),
  stopLossPrice: real("stop_loss_price").notNull(),
  takeProfitPrice: real("take_profit_price"),
  status: text("status").notNull().default("open"),
  pnl: real("pnl"),
  venue: text("venue").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const rewards = pgTable("rewards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  agentId: varchar("agent_id").notNull(),
  amount: real("amount").notNull(),
  status: text("status").notNull().default("pending"),
  claimedAt: timestamp("claimed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const marketData = pgTable("market_data", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  symbol: text("symbol").notNull().default("SUI-PERP"),
  price: real("price").notNull(),
  high24h: real("high_24h").notNull(),
  low24h: real("low_24h").notNull(),
  volume24h: real("volume_24h").notNull(),
  change24h: real("change_24h").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export const insertAgentSchema = createInsertSchema(agents).omit({ id: true, createdAt: true, totalPnl: true, totalTrades: true, winRate: true, agentWallet: true, status: true });
export const insertSignalSchema = createInsertSchema(signals).omit({ id: true, createdAt: true });
export const insertOrderSchema = createInsertSchema(orders).omit({ id: true, createdAt: true, pnl: true, status: true });
export const insertRewardSchema = createInsertSchema(rewards).omit({ id: true, createdAt: true, claimedAt: true, status: true });

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Agent = typeof agents.$inferSelect;
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Signal = typeof signals.$inferSelect;
export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type Order = typeof orders.$inferSelect;
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Reward = typeof rewards.$inferSelect;
export type InsertReward = z.infer<typeof insertRewardSchema>;
export type MarketData = typeof marketData.$inferSelect;
