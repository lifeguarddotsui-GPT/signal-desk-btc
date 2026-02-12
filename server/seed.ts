import { db } from "./db";
import { agents, rewards } from "@shared/schema";
import { sql } from "drizzle-orm";

function generateSuiWallet(): string {
  return `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
}

export async function seedDatabase() {
  const existingAgents = await db.select().from(agents);
  if (existingAgents.length > 0) return;

  const seededAgents = await db
    .insert(agents)
    .values([
      {
        userId: "default-user",
        name: "Alpha Scalper",
        status: "running",
        venue: "sudo",
        agentWallet: generateSuiWallet(),
        leverage: 5,
        maxQty: 2,
        stopLossBps: 80,
        takeProfitBps: 200,
        autoTrade: true,
        balance: 0,
        totalDeposited: 0,
        protocolFeePaid: 0,
        totalPnl: 12.45,
        totalTrades: 47,
        winRate: 0.68,
      },
      {
        userId: "default-user",
        name: "Delta Swinger",
        status: "idle",
        venue: "typus",
        agentWallet: generateSuiWallet(),
        leverage: 3,
        maxQty: 5,
        stopLossBps: 120,
        takeProfitBps: 400,
        autoTrade: false,
        balance: 0,
        totalDeposited: 0,
        protocolFeePaid: 0,
        totalPnl: -2.18,
        totalTrades: 12,
        winRate: 0.42,
      },
      {
        userId: "default-user",
        name: "Gamma Trend",
        status: "running",
        venue: "sudo",
        agentWallet: generateSuiWallet(),
        leverage: 10,
        maxQty: 1,
        stopLossBps: 50,
        takeProfitBps: 150,
        autoTrade: true,
        balance: 0,
        totalDeposited: 0,
        protocolFeePaid: 0,
        totalPnl: 8.92,
        totalTrades: 83,
        winRate: 0.61,
      },
    ])
    .returning();

  await db.insert(rewards).values([
    {
      userId: "default-user",
      agentId: seededAgents[0].id,
      amount: 3.25,
      status: "pending",
    },
    {
      userId: "default-user",
      agentId: seededAgents[0].id,
      amount: 1.87,
      status: "pending",
    },
    {
      userId: "default-user",
      agentId: seededAgents[2].id,
      amount: 2.14,
      status: "pending",
    },
    {
      userId: "default-user",
      agentId: seededAgents[0].id,
      amount: 0.95,
      status: "claimed",
      claimedAt: new Date(Date.now() - 86400000),
    },
    {
      userId: "default-user",
      agentId: seededAgents[2].id,
      amount: 1.52,
      status: "claimed",
      claimedAt: new Date(Date.now() - 172800000),
    },
  ]);

  console.log("Database seeded with sample agents and rewards");
}
