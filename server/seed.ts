import { db } from "./db";
import { agents, rewards } from "@shared/schema";
import { sql } from "drizzle-orm";

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
        venue: "bluefin",
        agentWallet: "0x7a3b1c9f8e2d4a6b0c5f1e8d7a2b3c9f4e6d8a1b",
        leverage: 5,
        maxQty: 2,
        stopLossBps: 80,
        takeProfitBps: 200,
        autoTrade: true,
        totalPnl: 12.45,
        totalTrades: 47,
        winRate: 0.68,
      },
      {
        userId: "default-user",
        name: "Delta Swinger",
        status: "idle",
        venue: "typus",
        agentWallet: "0x2f8e1d4a6c9b3e7f0a5d8c1b4e2a9f6d3c8b7e1a",
        leverage: 3,
        maxQty: 5,
        stopLossBps: 120,
        takeProfitBps: 400,
        autoTrade: false,
        totalPnl: -2.18,
        totalTrades: 12,
        winRate: 0.42,
      },
      {
        userId: "default-user",
        name: "Gamma Trend",
        status: "running",
        venue: "zofai",
        agentWallet: "0x5c9f3a1b8e7d2f4a6c0b5e1d8a3c9f2b7e4d6a1c",
        leverage: 10,
        maxQty: 1,
        stopLossBps: 50,
        takeProfitBps: 150,
        autoTrade: true,
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
