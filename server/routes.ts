import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { startMarketEngine, getMarketState, getPriceHistory, getIndicatorHistory } from "./market-engine";
import { insertAgentSchema } from "@shared/schema";
import { seedDatabase } from "./seed";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await seedDatabase();
  startMarketEngine();

  app.get("/api/market", async (_req, res) => {
    try {
      const state = getMarketState();
      res.json({
        id: "live",
        symbol: "SUI-PERP",
        ...state,
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to get market data" });
    }
  });

  app.get("/api/market/history", async (_req, res) => {
    try {
      res.json(getPriceHistory());
    } catch (e) {
      res.status(500).json({ message: "Failed to get price history" });
    }
  });

  app.get("/api/market/indicators", async (_req, res) => {
    try {
      res.json(getIndicatorHistory());
    } catch (e) {
      res.status(500).json({ message: "Failed to get indicators" });
    }
  });

  app.get("/api/signals", async (_req, res) => {
    try {
      const sigs = await storage.getSignals(20);
      res.json(sigs);
    } catch (e) {
      res.status(500).json({ message: "Failed to get signals" });
    }
  });

  app.get("/api/agents", async (_req, res) => {
    try {
      const agentsList = await storage.getAgents();
      res.json(agentsList);
    } catch (e) {
      res.status(500).json({ message: "Failed to get agents" });
    }
  });

  app.post("/api/agents", async (req, res) => {
    try {
      const parsed = insertAgentSchema.parse(req.body);
      const agent = await storage.createAgent(parsed);
      res.status(201).json(agent);
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Invalid agent data" });
    }
  });

  app.patch("/api/agents/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const agent = await storage.updateAgent(id, req.body);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }
      res.json(agent);
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Failed to update agent" });
    }
  });

  app.get("/api/rewards/summary", async (_req, res) => {
    try {
      const allRewards = await storage.getRewards();
      const totalPending = allRewards
        .filter((r) => r.status === "pending")
        .reduce((sum, r) => sum + r.amount, 0);
      const totalClaimed = allRewards
        .filter((r) => r.status === "claimed")
        .reduce((sum, r) => sum + r.amount, 0);

      res.json({
        totalPending,
        totalClaimed,
        totalEarned: totalPending + totalClaimed,
        rewards: allRewards,
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to get rewards" });
    }
  });

  app.post("/api/rewards/:id/claim", async (req, res) => {
    try {
      const { id } = req.params;
      const reward = await storage.claimReward(id);
      if (!reward) {
        return res.status(404).json({ message: "Reward not found" });
      }
      res.json(reward);
    } catch (e) {
      res.status(500).json({ message: "Failed to claim reward" });
    }
  });

  app.post("/api/rewards/claim-all", async (_req, res) => {
    try {
      await storage.claimAllRewards("default-user");
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ message: "Failed to claim all rewards" });
    }
  });

  return httpServer;
}
