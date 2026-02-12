import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { startMarketEngine, getMarketState, getPriceHistory, getIndicatorHistory } from "./market-engine";
import { priceBus, getLastPrice } from "./price-service";
import { insertAgentSchema, PROTOCOL_FEE_RATE, PROTOCOL_FEE_ADDRESS } from "@shared/schema";
import { verifyTxDigest, getOnChainBalance } from "./sui-verify";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
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

    storage.getAgentsWithSignalAgents().then((agentsList) => {
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
      const agentsList = await storage.getAgentsWithSignalAgents();
      res.json(agentsList);
    } catch (e) {
      res.status(500).json({ message: "Failed to get agents" });
    }
  });

  app.get("/api/agents/:id", async (req, res) => {
    try {
      const agent = await storage.getAgentWithSignalAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      res.json(agent);
    } catch (e) {
      res.status(500).json({ message: "Failed to get agent" });
    }
  });

  app.get("/api/agents/:id/positions", async (req, res) => {
    try {
      const positions = await storage.getVerifiedPositions(req.params.id);
      res.json(positions);
    } catch (e) {
      res.status(500).json({ message: "Failed to get positions" });
    }
  });

  app.get("/api/agents/:id/orders", async (req, res) => {
    try {
      const orders = await storage.getVerifiedOrders(req.params.id);
      res.json(orders);
    } catch (e) {
      res.status(500).json({ message: "Failed to get orders" });
    }
  });

  app.post("/api/agents", async (req, res) => {
    try {
      const parsed = insertAgentSchema.parse(req.body);
      const agentWithSignal = await storage.createAgent(parsed);
      broadcast("agent:created", agentWithSignal);
      res.status(201).json(agentWithSignal);
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
      const { amount, txDigest } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid deposit amount" });
      }

      let verifiedCheckpoint: number | undefined;
      let verifiedSender: string | undefined;

      if (txDigest) {
        try {
          const result = await verifyTxDigest(txDigest);
          verifiedCheckpoint = result.checkpoint;
          verifiedSender = result.sender;
        } catch (e: any) {
          return res.status(400).json({ message: `Transaction verification failed: ${e.message}` });
        }
      }

      const protocolFee = amount * PROTOCOL_FEE_RATE;
      const netAmount = amount - protocolFee;

      const agent = await storage.depositToAgent(id, amount, txDigest, verifiedCheckpoint);
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
          txDigest: txDigest || null,
          verified: !!txDigest,
          checkpoint: verifiedCheckpoint || null,
        },
      });
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Failed to deposit" });
    }
  });

  app.get("/api/balance/:address", async (req, res) => {
    try {
      const { address } = req.params;
      if (!address || !address.startsWith("0x")) {
        return res.status(400).json({ message: "Invalid SUI address" });
      }
      const balance = await getOnChainBalance(address);
      res.json(balance);
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Failed to get balance" });
    }
  });

  app.post("/api/tx/track", async (req, res) => {
    try {
      const { txDigest, type, agentId, userId } = req.body;
      if (!txDigest) {
        return res.status(400).json({ message: "Missing txDigest" });
      }

      const { tx, checkpoint, sender } = await verifyTxDigest(txDigest);

      const record = await storage.createVerifiedTransaction({
        txDigest,
        txType: type || "unknown",
        agentId: agentId || null,
        userId: userId || null,
        checkpoint: checkpoint || null,
        sender: sender || null,
        rawData: tx as any,
      });

      res.json({ ok: true, checkpoint, txDigest, id: record.id });
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Verification failed" });
    }
  });

  app.post("/api/tx/verify", async (req, res) => {
    try {
      const { txDigest } = req.body;
      if (!txDigest) {
        return res.status(400).json({ message: "Missing txDigest" });
      }

      const { checkpoint, sender } = await verifyTxDigest(txDigest);
      res.json({ verified: true, checkpoint, sender });
    } catch (e: any) {
      res.status(400).json({ verified: false, message: e.message || "Verification failed" });
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
      const { txDigest } = req.body;

      let checkpoint: number | undefined;
      if (txDigest) {
        const result = await verifyTxDigest(txDigest);
        checkpoint = result.checkpoint;
      }

      const reward = await storage.claimReward(id, txDigest, checkpoint);
      if (!reward) {
        return res.status(404).json({ message: "Reward not found" });
      }
      res.json(reward);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to claim reward" });
    }
  });

  app.post("/api/rewards/claim-all", async (req, res) => {
    try {
      const { txDigest } = req.body;

      let checkpoint: number | undefined;
      if (txDigest) {
        const result = await verifyTxDigest(txDigest);
        checkpoint = result.checkpoint;
      }

      await storage.claimAllRewards("default-user", txDigest, checkpoint);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to claim all rewards" });
    }
  });

  return httpServer;
}
