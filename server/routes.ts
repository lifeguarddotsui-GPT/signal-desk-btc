import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { startMarketEngine, getMarketState, getPriceHistory, getIndicatorHistory } from "./market-engine";
import { priceBus, getLastPrice } from "./price-service";
import { insertAgentSchema, PROTOCOL_FEE_RATE, PROTOCOL_FEE_ADDRESS } from "@shared/schema";
import { seedDatabase } from "./seed";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await seedDatabase();
  startMarketEngine();

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  const broadcast = (type: string, data: any) => {
    const msg = JSON.stringify({ type, data });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  };

  priceBus.on("tick", (tick) => {
    broadcast("price", tick);
  });

  wss.on("connection", (ws) => {
    const last = getLastPrice();
    if (last) {
      ws.send(JSON.stringify({ type: "price", data: last }));
    }

    const agents = storage.getAgents().then((agentsList) => {
      ws.send(JSON.stringify({ type: "agents:init", data: agentsList }));
    });
  });

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

  app.get("/api/price", (_req, res) => {
    const last = getLastPrice();
    res.json(last ?? null);
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

  app.get("/api/agents/:id", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      res.json(agent);
    } catch (e) {
      res.status(500).json({ message: "Failed to get agent" });
    }
  });

  app.get("/api/agents/:id/positions", async (req, res) => {
    try {
      const positions = await storage.getOpenPositions(req.params.id);
      res.json(positions);
    } catch (e) {
      res.status(500).json({ message: "Failed to get positions" });
    }
  });

  app.get("/api/agents/:id/orders", async (req, res) => {
    try {
      const orders = await storage.getOpenOrders(req.params.id);
      res.json(orders);
    } catch (e) {
      res.status(500).json({ message: "Failed to get orders" });
    }
  });

  app.post("/api/agents", async (req, res) => {
    try {
      const parsed = insertAgentSchema.parse(req.body);
      const agent = await storage.createAgent(parsed);
      broadcast("agent:created", agent);
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
      broadcast("agent:updated", agent);
      res.json(agent);
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Failed to update agent" });
    }
  });

  app.post("/api/agents/:id/deposit", async (req, res) => {
    try {
      const { id } = req.params;
      const { amount } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid deposit amount" });
      }

      const protocolFee = amount * PROTOCOL_FEE_RATE;
      const netAmount = amount - protocolFee;

      const agent = await storage.depositToAgent(id, amount);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      broadcast("agent:updated", agent);
      res.json({
        agent,
        deposit: {
          grossAmount: amount,
          protocolFee,
          protocolFeeRate: PROTOCOL_FEE_RATE,
          protocolFeeAddress: PROTOCOL_FEE_ADDRESS,
          netAmount,
        },
      });
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Failed to deposit" });
    }
  });

  app.get("/api/protocol/info", (_req, res) => {
    res.json({
      feeRate: PROTOCOL_FEE_RATE,
      feeAddress: PROTOCOL_FEE_ADDRESS,
      poweredBy: "Blue Water Digital",
      developedBy: "lifeguard.sui",
    });
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
