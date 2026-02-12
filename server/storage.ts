import { db } from "./db";
import { eq, desc } from "drizzle-orm";
import {
  users,
  agents,
  signals,
  orders,
  rewards,
  marketData,
  type User,
  type InsertUser,
  type Agent,
  type InsertAgent,
  type Signal,
  type InsertSignal,
  type Order,
  type InsertOrder,
  type Reward,
  type InsertReward,
  type MarketData,
} from "@shared/schema";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getAgents(userId?: string): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent | undefined>;
  createAgent(agent: InsertAgent): Promise<Agent>;
  updateAgent(id: string, data: Partial<Agent>): Promise<Agent | undefined>;

  getSignals(limit?: number): Promise<Signal[]>;
  createSignal(signal: InsertSignal): Promise<Signal>;

  getOrders(agentId?: string): Promise<Order[]>;
  createOrder(order: InsertOrder): Promise<Order>;
  updateOrder(id: string, data: Partial<Order>): Promise<Order | undefined>;

  getRewards(userId?: string): Promise<Reward[]>;
  createReward(reward: InsertReward): Promise<Reward>;
  claimReward(id: string): Promise<Reward | undefined>;
  claimAllRewards(userId: string): Promise<void>;

  getLatestMarketData(): Promise<MarketData | undefined>;
  createMarketData(data: Omit<MarketData, "id" | "createdAt">): Promise<MarketData>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async createUser(user: InsertUser): Promise<User> {
    const [created] = await db.insert(users).values(user).returning();
    return created;
  }

  async getAgents(userId?: string): Promise<Agent[]> {
    if (userId) {
      return db.select().from(agents).where(eq(agents.userId, userId)).orderBy(desc(agents.createdAt));
    }
    return db.select().from(agents).orderBy(desc(agents.createdAt));
  }

  async getAgent(id: string): Promise<Agent | undefined> {
    const [agent] = await db.select().from(agents).where(eq(agents.id, id));
    return agent;
  }

  async createAgent(agent: InsertAgent): Promise<Agent> {
    const walletAddr = `0x${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
    const [created] = await db
      .insert(agents)
      .values({ ...agent, agentWallet: walletAddr })
      .returning();
    return created;
  }

  async updateAgent(id: string, data: Partial<Agent>): Promise<Agent | undefined> {
    const [updated] = await db.update(agents).set(data).where(eq(agents.id, id)).returning();
    return updated;
  }

  async getSignals(limit = 20): Promise<Signal[]> {
    return db.select().from(signals).orderBy(desc(signals.createdAt)).limit(limit);
  }

  async createSignal(signal: InsertSignal): Promise<Signal> {
    const [created] = await db.insert(signals).values(signal).returning();
    return created;
  }

  async getOrders(agentId?: string): Promise<Order[]> {
    if (agentId) {
      return db.select().from(orders).where(eq(orders.agentId, agentId)).orderBy(desc(orders.createdAt));
    }
    return db.select().from(orders).orderBy(desc(orders.createdAt));
  }

  async createOrder(order: InsertOrder): Promise<Order> {
    const [created] = await db.insert(orders).values(order).returning();
    return created;
  }

  async updateOrder(id: string, data: Partial<Order>): Promise<Order | undefined> {
    const [updated] = await db.update(orders).set(data).where(eq(orders.id, id)).returning();
    return updated;
  }

  async getRewards(userId?: string): Promise<Reward[]> {
    if (userId) {
      return db.select().from(rewards).where(eq(rewards.userId, userId)).orderBy(desc(rewards.createdAt));
    }
    return db.select().from(rewards).orderBy(desc(rewards.createdAt));
  }

  async createReward(reward: InsertReward): Promise<Reward> {
    const [created] = await db.insert(rewards).values(reward).returning();
    return created;
  }

  async claimReward(id: string): Promise<Reward | undefined> {
    const [updated] = await db
      .update(rewards)
      .set({ status: "claimed", claimedAt: new Date() })
      .where(eq(rewards.id, id))
      .returning();
    return updated;
  }

  async claimAllRewards(userId: string): Promise<void> {
    await db
      .update(rewards)
      .set({ status: "claimed", claimedAt: new Date() })
      .where(eq(rewards.userId, userId));
  }

  async getLatestMarketData(): Promise<MarketData | undefined> {
    const [data] = await db.select().from(marketData).orderBy(desc(marketData.createdAt)).limit(1);
    return data;
  }

  async createMarketData(data: Omit<MarketData, "id" | "createdAt">): Promise<MarketData> {
    const [created] = await db.insert(marketData).values(data).returning();
    return created;
  }
}

export const storage = new DatabaseStorage();
