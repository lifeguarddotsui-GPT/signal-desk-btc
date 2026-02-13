import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { startMarketEngine, getMarketState, getPriceHistory, getIndicatorHistory, getCandleHistory, getLastSignalResult } from "./market-engine";
import { priceBus, getLastPrice } from "./price-service";
import { insertAgentSchema, PROTOCOL_FEE_RATE, PROTOCOL_FEE_ADDRESS } from "@shared/schema";
import { verifyTxDigest, getOnChainBalance, verifyDepositTransfers, resolveNSName } from "./sui-verify";
import { generateAgentWallet, getAdapterStatus, getAdapter } from "./dex";

function sanitizeAgent(agent: any) {
  if (!agent) return agent;
  const { agentWallet, ...safe } = agent;
  return safe;
}

function sanitizeAgents(agents: any[]) {
  return agents.map(sanitizeAgent);
}

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
      ws.send(JSON.stringify({ type: "agents:init", data: sanitizeAgents(agentsList) }));
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

  app.get("/api/market/candles", async (_req, res) => {
    try {
      res.json(getCandleHistory());
    } catch (e) {
      res.status(500).json({ message: "Failed to get candle data" });
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

  app.get("/api/signals/reasoning", (_req, res) => {
    try {
      const result = getLastSignalResult();
      if (!result) {
        return res.json({ available: false });
      }
      res.json({
        available: true,
        signal: result.signal,
        side: result.side,
        reason: result.reason,
        longScore: result.longScore,
        shortScore: result.shortScore,
        conditions: result.conditions,
        indicators: result.indicators,
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to get signal reasoning" });
    }
  });

  app.get("/api/agents", async (_req, res) => {
    try {
      const agentsList = await storage.getAgentsWithSignalAgents();
      res.json(sanitizeAgents(agentsList));
    } catch (e) {
      res.status(500).json({ message: "Failed to get agents" });
    }
  });

  app.get("/api/agents/:id", async (req, res) => {
    try {
      const agent = await storage.getAgentWithSignalAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      res.json(sanitizeAgent(agent));
    } catch (e) {
      res.status(500).json({ message: "Failed to get agent" });
    }
  });

  app.get("/api/agents/:id/positions", async (req, res) => {
    try {
      const positions = await storage.getPositions(req.params.id);
      res.json(positions);
    } catch (e) {
      res.status(500).json({ message: "Failed to get positions" });
    }
  });

  app.get("/api/agents/:id/orders", async (req, res) => {
    try {
      const allOrders = await storage.getOrders(req.params.id);
      res.json(allOrders);
    } catch (e) {
      res.status(500).json({ message: "Failed to get orders" });
    }
  });

  app.get("/api/agents/:id/signals", async (req, res) => {
    try {
      const agentSignals = await storage.getSignalsByAgent(req.params.id, 30);
      res.json(agentSignals);
    } catch (e) {
      res.status(500).json({ message: "Failed to get agent signals" });
    }
  });

  app.get("/api/agents/:id/activity", async (req, res) => {
    try {
      const agentOrders = await storage.getOrders(req.params.id);
      const agentPositions = await storage.getPositions(req.params.id);
      const agentSignals = await storage.getSignalsByAgent(req.params.id, 20);
      const agent = await storage.getAgentWithSignalAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });

      const reasoning = getLastSignalResult();

      res.json({
        agent: sanitizeAgent(agent),
        orders: agentOrders,
        positions: agentPositions,
        signals: agentSignals,
        reasoning: reasoning ? {
          signal: reasoning.signal,
          side: reasoning.side,
          reason: reasoning.reason,
          longScore: reasoning.longScore,
          shortScore: reasoning.shortScore,
          conditions: reasoning.conditions,
          indicators: reasoning.indicators,
        } : null,
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to get agent activity" });
    }
  });

  app.get("/api/venues", async (_req, res) => {
    try {
      const venues = getAdapterStatus();
      res.json(venues);
    } catch (e) {
      res.status(500).json({ message: "Failed to get venue status" });
    }
  });

  app.get("/api/venues/:venue/fees", async (req, res) => {
    try {
      const adapter = getAdapter(req.params.venue);
      if (!adapter) return res.status(404).json({ message: "Venue not found" });
      const fees = await adapter.estimateFees({
        agent: { balance: 100 } as any,
        symbol: "SUI-PERP",
        side: "long",
        leverage: 5,
        quantity: 1,
        price: 3.80,
      });
      res.json({ venue: adapter.venue, supported: adapter.supported, fees });
    } catch (e) {
      res.status(500).json({ message: "Failed to estimate fees" });
    }
  });

  app.post("/api/agents", async (req, res) => {
    try {
      const parsed = insertAgentSchema.parse(req.body);

      if (parsed.userId && parsed.userId !== "default-user") {
        let user = await storage.getUserByWallet(parsed.userId);
        if (!user) {
          user = await storage.createUser({ walletAddress: parsed.userId });
        }
        parsed.userId = user.id;
      }

      const wallet = generateAgentWallet();
      const agentWithSignal = await storage.createAgent({
        ...parsed,
      });
      if (agentWithSignal) {
        await storage.updateAgent(agentWithSignal.id, {
          agentWallet: wallet.encryptedPrivateKey,
          walletAddress: wallet.address,
        });
        agentWithSignal.agentWallet = wallet.encryptedPrivateKey;
        agentWithSignal.walletAddress = wallet.address;
      }
      broadcast("agent:created", sanitizeAgent(agentWithSignal));
      res.status(201).json(sanitizeAgent(agentWithSignal));
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
      broadcast("agent:updated", sanitizeAgent(agent));
      res.json(sanitizeAgent(agent));
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Failed to update agent" });
    }
  });

  app.delete("/api/agents/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const walletAddress = req.query.wallet as string | undefined;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required. Connect your wallet to delete agents." });
      }

      const agent = await storage.getAgent(id);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      if (agent.status === "running") {
        return res.status(400).json({ message: "Cannot delete an active agent. Stop the agent first before deleting." });
      }

      const user = await storage.getUserByWallet(walletAddress);
      if (!user || user.id !== agent.userId) {
        return res.status(403).json({ message: "You can only delete agents you created." });
      }

      const deleted = await storage.deleteAgent(id);
      if (!deleted) {
        return res.status(404).json({ message: "Agent not found" });
      }
      broadcast("agent:deleted", { id });
      res.json({ message: "Agent deleted" });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to delete agent" });
    }
  });

  app.post("/api/agents/:id/deposit", async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, txDigest, sender } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid deposit amount" });
      }
      if (!txDigest) {
        return res.status(400).json({ message: "Transaction digest required. Deposits must be verified on-chain." });
      }

      const existingAgent = await storage.getAgent(id);
      if (!existingAgent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      if (!existingAgent.walletAddress) {
        return res.status(400).json({ message: "Agent wallet address not configured" });
      }

      let verifiedCheckpoint: number | undefined;
      let verifiedSender: string | undefined;

      const protocolFee = amount * PROTOCOL_FEE_RATE;
      const netAmount = amount - protocolFee;
      const expectedAgentMist = BigInt(Math.floor(netAmount * 1e9));
      const expectedFeeMist = BigInt(Math.floor(protocolFee * 1e9));

      try {
        const result = await verifyTxDigest(txDigest);
        verifiedCheckpoint = result.checkpoint;
        verifiedSender = result.sender;

        if (!verifiedSender) {
          return res.status(400).json({ message: "Could not determine transaction sender from on-chain data" });
        }

        if (sender && verifiedSender !== sender) {
          return res.status(400).json({ message: "Transaction sender does not match your wallet address" });
        }

        const transferCheck = verifyDepositTransfers(result.balanceChanges, {
          agentWalletAddress: existingAgent.walletAddress,
          protocolFeeAddress: PROTOCOL_FEE_ADDRESS,
          expectedAgentMist,
          expectedFeeMist,
          sender: verifiedSender,
        });

        if (!transferCheck.valid) {
          return res.status(400).json({
            message: `On-chain transfer verification failed: ${transferCheck.reason}`,
          });
        }
      } catch (e: any) {
        return res.status(400).json({ message: `Transaction verification failed: ${e.message}` });
      }

      const agent = await storage.depositToAgent(id, netAmount, txDigest, verifiedCheckpoint);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      if (verifiedSender) {
        await storage.createVerifiedTransaction({
          txDigest,
          txType: "deposit",
          agentId: id,
          userId: sender || verifiedSender,
          sender: verifiedSender,
          checkpoint: verifiedCheckpoint ?? null,
          rawData: { amount, protocolFee, netAmount },
        }).catch(() => {});
      }

      broadcast("agent:updated", sanitizeAgent(agent));
      res.json({
        agent: sanitizeAgent(agent),
        deposit: {
          grossAmount: amount,
          protocolFee,
          protocolFeeRate: PROTOCOL_FEE_RATE,
          protocolFeeAddress: PROTOCOL_FEE_ADDRESS,
          netAmount,
          txDigest,
          verified: true,
          checkpoint: verifiedCheckpoint || null,
          sender: verifiedSender || null,
        },
      });
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Failed to deposit" });
    }
  });

  app.post("/api/agents/:id/withdraw", async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, toAddress } = req.body;

      if (!toAddress || typeof toAddress !== "string" || !toAddress.startsWith("0x")) {
        return res.status(400).json({ message: "Valid SUI wallet address required" });
      }

      const agent = await storage.getAgent(id);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(toAddress);
      if (!user || user.id !== agent.userId) {
        return res.status(403).json({ message: "You can only withdraw from agents you created." });
      }

      if (!agent.agentWallet || !agent.walletAddress) {
        return res.status(400).json({ message: "Agent wallet not configured" });
      }

      const parsedAmount = amount !== undefined && amount !== null ? Number(amount) : null;
      if (parsedAmount !== null && (isNaN(parsedAmount) || parsedAmount <= 0)) {
        return res.status(400).json({ message: "Amount must be a positive number" });
      }
      const withdrawAmount = parsedAmount && parsedAmount > 0 ? parsedAmount : agent.balance;
      if (withdrawAmount <= 0) {
        return res.status(400).json({ message: "No balance available to withdraw" });
      }
      if (withdrawAmount > agent.balance) {
        return res.status(400).json({ message: `Insufficient balance. Agent has ${agent.balance.toFixed(4)} SUI available.` });
      }

      const onChainBalance = await getOnChainBalance(agent.walletAddress);
      const withdrawMist = BigInt(Math.floor(withdrawAmount * 1e9));
      const gasBudget = BigInt(10_000_000);

      if (BigInt(onChainBalance.mist) < withdrawMist + gasBudget) {
        return res.status(400).json({
          message: `Insufficient on-chain balance. Agent wallet has ${onChainBalance.sui.toFixed(4)} SUI on-chain.`,
        });
      }

      const { decryptKeypair } = await import("./dex/wallet-manager");
      const { Transaction } = await import("@mysten/sui/transactions");
      const keypair = decryptKeypair(agent.agentWallet);

      const tx = new Transaction();
      tx.setSender(agent.walletAddress);
      tx.setGasBudget(gasBudget);
      const [coin] = tx.splitCoins(tx.gas, [withdrawMist]);
      tx.transferObjects([coin], toAddress);

      const { suiClient } = await import("./sui-verify");
      const result = await suiClient.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true },
      });

      if (result.effects?.status?.status !== "success") {
        return res.status(500).json({ message: "On-chain withdrawal transaction failed" });
      }

      await storage.updateAgent(id, {
        balance: agent.balance - withdrawAmount,
      });

      await storage.createVerifiedTransaction({
        txDigest: result.digest,
        txType: "withdraw",
        agentId: id,
        userId: agent.userId,
        sender: agent.walletAddress,
        checkpoint: null,
        rawData: { amount: withdrawAmount, toAddress },
      }).catch(() => {});

      broadcast("agent:updated", sanitizeAgent(await storage.getAgent(id)));

      res.json({
        txDigest: result.digest,
        amount: withdrawAmount,
        toAddress,
        remainingBalance: agent.balance - withdrawAmount,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to withdraw" });
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

  app.get("/api/protocol/overview", async (_req, res) => {
    try {
      const fees = await storage.getProtocolFees();
      const allAgents = await storage.getAgents();
      const allRewards = await storage.getRewards();
      const totalFeesCollected = fees.reduce((sum, f) => sum + f.amount, 0);
      const verifiedFees = fees.filter((f) => f.verified);
      const totalVerifiedFees = verifiedFees.reduce((sum, f) => sum + f.amount, 0);
      const uniqueUsers = new Set(fees.map((f) => f.userId));
      const uniqueAgents = new Set(fees.map((f) => f.agentId));
      const totalRewardsPaid = allRewards.filter((r) => r.status === "claimed").reduce((sum, r) => sum + r.amount, 0);
      const totalRewardsPending = allRewards.filter((r) => r.status === "pending").reduce((sum, r) => sum + r.amount, 0);
      const totalDeposited = allAgents.reduce((sum, a) => sum + (a.totalDeposited || 0), 0);

      res.json({
        protocolWallet: PROTOCOL_FEE_ADDRESS,
        feeRate: PROTOCOL_FEE_RATE,
        totalFeesCollected,
        totalVerifiedFees,
        totalDeposited,
        totalRewardsPaid,
        totalRewardsPending,
        uniqueUsers: uniqueUsers.size,
        uniqueAgents: uniqueAgents.size,
        totalAgents: allAgents.length,
        activeAgents: allAgents.filter((a) => a.status === "running").length,
        recentFees: fees.slice(0, 20),
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to get protocol overview" });
    }
  });

  app.get("/api/leaderboard", async (_req, res) => {
    try {
      const allAgents = await storage.getAgents();
      const allRewards = await storage.getRewards();
      const allUsers = await storage.getUsers();

      const agentStats = allAgents.map((a) => {
        const agentRewards = allRewards.filter((r) => r.agentId === a.id);
        const totalRewards = agentRewards.reduce((sum, r) => sum + r.amount, 0);
        const claimedRewards = agentRewards.filter((r) => r.status === "claimed").reduce((sum, r) => sum + r.amount, 0);
        return {
          id: a.id,
          name: a.name,
          userId: a.userId,
          venue: a.venue,
          status: a.status,
          balance: a.balance,
          totalPnl: a.totalPnl,
          totalTrades: a.totalTrades,
          winRate: a.winRate,
          totalDeposited: a.totalDeposited,
          totalRewards,
          claimedRewards,
          createdAt: a.createdAt,
        };
      }).sort((a, b) => b.totalPnl - a.totalPnl);

      const userMap = new Map<string, { walletAddress: string; nsName: string | null; totalRewards: number; claimedRewards: number; agentCount: number; totalPnl: number; totalTrades: number }>();
      for (const agent of allAgents) {
        const user = allUsers.find((u) => u.id === agent.userId);
        const wallet = user?.walletAddress || agent.userId;
        const existing = userMap.get(wallet) || { walletAddress: wallet, nsName: null, totalRewards: 0, claimedRewards: 0, agentCount: 0, totalPnl: 0, totalTrades: 0 };
        const agentRewards = allRewards.filter((r) => r.agentId === agent.id);
        existing.totalRewards += agentRewards.reduce((sum, r) => sum + r.amount, 0);
        existing.claimedRewards += agentRewards.filter((r) => r.status === "claimed").reduce((sum, r) => sum + r.amount, 0);
        existing.agentCount += 1;
        existing.totalPnl += agent.totalPnl || 0;
        existing.totalTrades += agent.totalTrades || 0;
        userMap.set(wallet, existing);
      }
      const userStats = Array.from(userMap.values()).sort((a, b) => b.totalRewards - a.totalRewards);

      const nsPromises = userStats.map(async (u) => {
        try {
          u.nsName = await resolveNSName(u.walletAddress);
        } catch { /* ignore */ }
        return u;
      });
      await Promise.all(nsPromises);

      res.json({
        agents: agentStats,
        users: userStats,
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to get leaderboard" });
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
      const { txDigest } = req.body;

      const allRewards = await storage.getRewards();
      const reward = allRewards.find((r) => r.id === id);
      if (!reward) {
        return res.status(404).json({ message: "Reward not found" });
      }

      if (reward.status === "claimed") {
        return res.status(400).json({ message: "Reward already claimed" });
      }

      let checkpoint: number | undefined;
      if (txDigest) {
        const result = await verifyTxDigest(txDigest);
        checkpoint = result.checkpoint;
      }

      const claimed = await storage.claimReward(id, txDigest, checkpoint);
      if (!claimed) {
        return res.status(404).json({ message: "Reward not found" });
      }
      res.json(claimed);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to claim reward" });
    }
  });

  app.post("/api/rewards/claim-all", async (req, res) => {
    try {
      const { txDigest } = req.body;

      const allRewards = await storage.getRewards();
      const pendingRewards = allRewards.filter((r) => r.status === "pending");

      if (pendingRewards.length === 0) {
        return res.status(400).json({ message: "No pending rewards to claim" });
      }

      let checkpoint: number | undefined;
      if (txDigest) {
        const result = await verifyTxDigest(txDigest);
        checkpoint = result.checkpoint;
      }

      for (const reward of pendingRewards) {
        await storage.claimReward(reward.id, txDigest, checkpoint);
      }

      res.json({ success: true, claimed: pendingRewards.length });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to claim all rewards" });
    }
  });

  return httpServer;
}
