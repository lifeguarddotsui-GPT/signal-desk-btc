import { db } from "./db";
import { eq, desc, and } from "drizzle-orm";
import {
  users,
  agents,
  signalAgents,
  signals,
  orders,
  positions,
  rewards,
  marketData,
  protocolFees,
  deposits,
  verifiedTransactions,
  PROTOCOL_FEE_ADDRESS,
  PROTOCOL_FEE_RATE,
  type User,
  type InsertUser,
  type Agent,
  type InsertAgent,
  type SignalAgent,
  type InsertSignalAgent,
  type AgentWithSignalAgent,
  type Signal,
  type InsertSignal,
  type Order,
  type InsertOrder,
  type Position,
  type InsertPosition,
  type Reward,
  type InsertReward,
  type MarketData,
  type ProtocolFee,
  type InsertProtocolFee,
  type VerifiedTransaction,
  type Deposit,
  type InsertDeposit,
} from "@shared/schema";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByWallet(walletAddress: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getAgents(userId?: string): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent | undefined>;
  getAgentWithSignalAgent(id: string): Promise<AgentWithSignalAgent | undefined>;
  getAgentsWithSignalAgents(userId?: string): Promise<AgentWithSignalAgent[]>;
  createAgent(agent: InsertAgent): Promise<AgentWithSignalAgent>;
  updateAgent(id: string, data: Partial<Agent>): Promise<Agent | undefined>;
  depositToAgent(agentId: string, amount: number, txDigest?: string, checkpoint?: number): Promise<Agent | undefined>;

  getSignalAgent(id: string): Promise<SignalAgent | undefined>;
  getSignalAgentByExecId(executionAgentId: string): Promise<SignalAgent | undefined>;
  createSignalAgent(sa: InsertSignalAgent): Promise<SignalAgent>;
  updateSignalAgent(id: string, data: Partial<SignalAgent>): Promise<SignalAgent | undefined>;

  getSignals(limit?: number): Promise<Signal[]>;
  getSignalsByAgent(agentId: string, limit?: number): Promise<Signal[]>;
  createSignal(signal: InsertSignal): Promise<Signal>;

  getOrders(agentId?: string): Promise<Order[]>;
  getOpenOrders(agentId: string): Promise<Order[]>;
  getVerifiedOrders(agentId: string): Promise<Order[]>;
  createOrder(order: InsertOrder): Promise<Order>;
  updateOrder(id: string, data: Partial<Order>): Promise<Order | undefined>;

  getPositions(agentId: string): Promise<Position[]>;
  getOpenPositions(agentId: string): Promise<Position[]>;
  getVerifiedPositions(agentId: string): Promise<Position[]>;
  createPosition(position: InsertPosition): Promise<Position>;
  updatePosition(id: string, data: Partial<Position>): Promise<Position | undefined>;

  getRewards(userId?: string): Promise<Reward[]>;
  createReward(reward: InsertReward): Promise<Reward>;
  claimReward(id: string, txDigest?: string, checkpoint?: number): Promise<Reward | undefined>;
  claimAllRewards(userId: string, txDigest?: string, checkpoint?: number): Promise<void>;

  getLatestMarketData(): Promise<MarketData | undefined>;
  createMarketData(data: Omit<MarketData, "id" | "createdAt">): Promise<MarketData>;

  createProtocolFee(fee: InsertProtocolFee): Promise<ProtocolFee>;
  getProtocolFees(): Promise<ProtocolFee[]>;
  getUsers(): Promise<User[]>;

  deleteAgent(id: string): Promise<boolean>;

  createDeposit(deposit: InsertDeposit): Promise<Deposit>;
  getDepositsByAgent(agentId: string): Promise<Deposit[]>;
  getDepositsByWallet(walletAddress: string): Promise<Deposit[]>;
  getVerifiedDepositsByWallet(walletAddress: string): Promise<Deposit[]>;

  createVerifiedTransaction(data: Omit<VerifiedTransaction, "id" | "createdAt" | "verified">): Promise<VerifiedTransaction>;
}

function generateSuiWallet(): string {
  return `0x${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByWallet(walletAddress: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.walletAddress, walletAddress));
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

  async getAgentWithSignalAgent(id: string): Promise<AgentWithSignalAgent | undefined> {
    const agent = await this.getAgent(id);
    if (!agent) return undefined;
    const sa = agent.signalAgentId ? (await this.getSignalAgent(agent.signalAgentId)) ?? null : null;
    return { ...agent, signalAgent: sa };
  }

  async getAgentsWithSignalAgents(userId?: string): Promise<AgentWithSignalAgent[]> {
    const agentsList = await this.getAgents(userId);
    const results: AgentWithSignalAgent[] = [];
    for (const agent of agentsList) {
      const sa = agent.signalAgentId ? (await this.getSignalAgent(agent.signalAgentId)) ?? null : null;
      results.push({ ...agent, signalAgent: sa });
    }
    return results;
  }

  async createAgent(agent: InsertAgent): Promise<AgentWithSignalAgent> {
    const walletAddr = generateSuiWallet();
    const [created] = await db
      .insert(agents)
      .values({
        ...agent,
        agentWallet: walletAddr,
        balance: 0,
        totalDeposited: 0,
        protocolFeePaid: 0,
        totalPnl: 0,
        totalTrades: 0,
        winRate: 0,
      })
      .returning();

    const [sa] = await db
      .insert(signalAgents)
      .values({
        executionAgentId: created.id,
        name: `${created.name} Signal`,
        strategy: "momentum",
        indicators: ["rsi", "connorsRsi", "ema", "dema", "tema"],
        signalThreshold: 3,
      })
      .returning();

    const [updated] = await db
      .update(agents)
      .set({ signalAgentId: sa.id })
      .where(eq(agents.id, created.id))
      .returning();

    return { ...updated, signalAgent: sa };
  }

  async updateAgent(id: string, data: Partial<Agent>): Promise<Agent | undefined> {
    const [updated] = await db.update(agents).set(data).where(eq(agents.id, id)).returning();
    return updated;
  }

  async deleteAgent(id: string): Promise<boolean> {
    const agent = await this.getAgent(id);
    if (!agent) return false;
    await db.delete(signals).where(eq(signals.agentId, id));
    await db.delete(orders).where(eq(orders.agentId, id));
    await db.delete(positions).where(eq(positions.agentId, id));
    if (agent.signalAgentId) {
      await db.delete(signals).where(eq(signals.signalAgentId, agent.signalAgentId));
      await db.delete(signalAgents).where(eq(signalAgents.id, agent.signalAgentId));
    }
    await db.delete(agents).where(eq(agents.id, id));
    return true;
  }

  async depositToAgent(agentId: string, amount: number, txDigest?: string, checkpoint?: number): Promise<Agent | undefined> {
    const agent = await this.getAgent(agentId);
    if (!agent) return undefined;

    const grossAmount = amount / (1 - PROTOCOL_FEE_RATE);
    const protocolFee = grossAmount - amount;

    await this.createProtocolFee({
      agentId,
      userId: agent.userId,
      amount: protocolFee,
      feeAddress: PROTOCOL_FEE_ADDRESS,
      txDigest: txDigest || null,
    });

    const [updated] = await db
      .update(agents)
      .set({
        balance: agent.balance + amount,
        totalDeposited: agent.totalDeposited + grossAmount,
        protocolFeePaid: agent.protocolFeePaid + protocolFee,
      })
      .where(eq(agents.id, agentId))
      .returning();
    return updated;
  }

  async getSignalAgent(id: string): Promise<SignalAgent | undefined> {
    const [sa] = await db.select().from(signalAgents).where(eq(signalAgents.id, id));
    return sa;
  }

  async getSignalAgentByExecId(executionAgentId: string): Promise<SignalAgent | undefined> {
    const [sa] = await db.select().from(signalAgents).where(eq(signalAgents.executionAgentId, executionAgentId));
    return sa;
  }

  async createSignalAgent(saInput: InsertSignalAgent): Promise<SignalAgent> {
    const [created] = await db.insert(signalAgents).values(saInput).returning();
    return created;
  }

  async updateSignalAgent(id: string, data: Partial<SignalAgent>): Promise<SignalAgent | undefined> {
    const [updated] = await db.update(signalAgents).set(data).where(eq(signalAgents.id, id)).returning();
    return updated;
  }

  async getSignals(limit = 20): Promise<Signal[]> {
    return db.select().from(signals).orderBy(desc(signals.createdAt)).limit(limit);
  }

  async getSignalsByAgent(agentId: string, limit = 30): Promise<Signal[]> {
    return db.select().from(signals)
      .where(eq(signals.agentId, agentId))
      .orderBy(desc(signals.createdAt))
      .limit(limit);
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

  async getOpenOrders(agentId: string): Promise<Order[]> {
    return db.select().from(orders)
      .where(and(eq(orders.agentId, agentId), eq(orders.status, "open")))
      .orderBy(desc(orders.createdAt));
  }

  async getVerifiedOrders(agentId: string): Promise<Order[]> {
    return db.select().from(orders)
      .where(and(eq(orders.agentId, agentId), eq(orders.verified, true)))
      .orderBy(desc(orders.createdAt));
  }

  async createOrder(order: InsertOrder): Promise<Order> {
    const [created] = await db.insert(orders).values(order).returning();
    return created;
  }

  async updateOrder(id: string, data: Partial<Order>): Promise<Order | undefined> {
    const [updated] = await db.update(orders).set(data).where(eq(orders.id, id)).returning();
    return updated;
  }

  async getPositions(agentId: string): Promise<Position[]> {
    return db.select().from(positions).where(eq(positions.agentId, agentId)).orderBy(desc(positions.openedAt));
  }

  async getOpenPositions(agentId: string): Promise<Position[]> {
    return db.select().from(positions)
      .where(and(eq(positions.agentId, agentId), eq(positions.status, "open")))
      .orderBy(desc(positions.openedAt));
  }

  async getVerifiedPositions(agentId: string): Promise<Position[]> {
    return db.select().from(positions)
      .where(and(eq(positions.agentId, agentId), eq(positions.verified, true)))
      .orderBy(desc(positions.openedAt));
  }

  async createPosition(position: InsertPosition): Promise<Position> {
    const [created] = await db.insert(positions).values(position).returning();
    return created;
  }

  async updatePosition(id: string, data: Partial<Position>): Promise<Position | undefined> {
    const [updated] = await db.update(positions).set(data).where(eq(positions.id, id)).returning();
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

  async claimReward(id: string, txDigest?: string, checkpoint?: number): Promise<Reward | undefined> {
    const updateData: any = {
      status: "claimed",
      claimedAt: new Date(),
    };
    if (txDigest) {
      updateData.txDigest = txDigest;
      updateData.checkpoint = checkpoint;
      updateData.verified = true;
    }
    const [updated] = await db
      .update(rewards)
      .set(updateData)
      .where(eq(rewards.id, id))
      .returning();
    return updated;
  }

  async claimAllRewards(userId: string, txDigest?: string, checkpoint?: number): Promise<void> {
    const updateData: any = {
      status: "claimed",
      claimedAt: new Date(),
    };
    if (txDigest) {
      updateData.txDigest = txDigest;
      updateData.checkpoint = checkpoint;
      updateData.verified = true;
    }
    await db
      .update(rewards)
      .set(updateData)
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

  async createProtocolFee(fee: InsertProtocolFee): Promise<ProtocolFee> {
    const [created] = await db.insert(protocolFees).values(fee).returning();
    return created;
  }

  async getProtocolFees(): Promise<ProtocolFee[]> {
    return db.select().from(protocolFees).orderBy(desc(protocolFees.createdAt));
  }

  async getUsers(): Promise<User[]> {
    return db.select().from(users).orderBy(desc(users.createdAt));
  }

  async createDeposit(deposit: InsertDeposit): Promise<Deposit> {
    const [created] = await db.insert(deposits).values(deposit).returning();
    return created;
  }

  async getDepositsByAgent(agentId: string): Promise<Deposit[]> {
    return db.select().from(deposits).where(eq(deposits.agentId, agentId)).orderBy(desc(deposits.createdAt));
  }

  async getDepositsByWallet(walletAddress: string): Promise<Deposit[]> {
    return db.select().from(deposits).where(eq(deposits.depositorAddress, walletAddress)).orderBy(desc(deposits.createdAt));
  }

  async getVerifiedDepositsByWallet(walletAddress: string): Promise<Deposit[]> {
    return db.select().from(deposits)
      .where(and(eq(deposits.depositorAddress, walletAddress), eq(deposits.verified, true)))
      .orderBy(desc(deposits.createdAt));
  }

  async createVerifiedTransaction(data: Omit<VerifiedTransaction, "id" | "createdAt" | "verified">): Promise<VerifiedTransaction> {
    const [created] = await db.insert(verifiedTransactions).values({
      ...data,
      verified: true,
    }).returning();
    return created;
  }
}

export const storage = new DatabaseStorage();
