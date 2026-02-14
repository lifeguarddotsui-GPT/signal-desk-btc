import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { startMarketEngine, getMarketState, getPriceHistory, getIndicatorHistory, getCandleHistory, getLastSignalResult } from "./market-engine";
import { priceBus, getLastPrice } from "./price-service";
import { insertAgentSchema, PROTOCOL_FEE_RATE, PROTOCOL_FEE_ADDRESS } from "@shared/schema";
import { verifyTxDigest, getOnChainBalance, verifyDepositTransfers, resolveNSName } from "./sui-verify";
import { generateAgentWallet, getAdapterStatus, getAdapter } from "./dex";
import { closeAllPositionsForAgent } from "./dex/execution-engine";
import { startExecutorLoop } from "./executor/executor-loop";

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
  startExecutorLoop();

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

      const isVerifiedTx = (tx: string | null | undefined, verified?: boolean) => tx && !tx.startsWith("sim_") && verified !== false;
      const verifiedOrders = agentOrders.filter(o => isVerifiedTx(o.txDigest, o.verified));
      const verifiedPositions = agentPositions.filter(p => isVerifiedTx(p.txDigest, p.verified));

      const openPositions = verifiedPositions.filter(p => p.status === "open");
      const closedPositions = verifiedPositions.filter(p => p.status === "closed");
      const totalClosed = closedPositions.length;
      const totalWins = closedPositions.filter(p => (p.unrealizedPnl || 0) > 0).length;
      const liveWinRate = totalClosed > 0 ? totalWins / totalClosed : 0;

      let lockedCollateral = 0;
      let totalUnrealizedPnl = 0;
      for (const pos of openPositions) {
        lockedCollateral += (pos.sizeSui * pos.entryPrice) / agent.leverage;
        totalUnrealizedPnl += pos.unrealizedPnl || 0;
      }
      const portfolioValue = agent.balance + lockedCollateral + totalUnrealizedPnl;

      res.json({
        agent: sanitizeAgent(agent),
        orders: verifiedOrders,
        positions: verifiedPositions,
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
        portfolioValue,
        lockedCollateral,
        totalUnrealizedPnl,
        liveWinRate,
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
      } else if (!parsed.userId) {
        const creatorWallet = req.body.creatorWallet as string | undefined;
        if (creatorWallet && creatorWallet.startsWith("0x")) {
          let user = await storage.getUserByWallet(creatorWallet);
          if (!user) {
            user = await storage.createUser({ walletAddress: creatorWallet });
          }
          parsed.userId = user.id;
        }
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

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === agent.userId;
      const isOrphaned = agent.userId === "default-user" || !agent.userId;

      if (!isOwner && !isOrphaned) {
        return res.status(403).json({ message: "You can only delete agents you created." });
      }

      if (agent.status === "running") {
        await storage.updateAgent(id, { status: "idle", autoTrade: false });
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

      await storage.createDeposit({
        agentId: id,
        depositorAddress: verifiedSender || sender || "",
        amount: netAmount,
        grossAmount: amount,
        protocolFee,
        txDigest: txDigest || null,
      }).catch(() => {});

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

      if (agent.status === "recovered") {
        return res.status(400).json({ message: "Cannot withdraw from a recovered agent - the original signing keys were lost during database reset. The collateral remains on-chain but cannot be moved without the original private key." });
      }

      const user = await storage.getUserByWallet(toAddress);
      const isCreator = user && user.id === agent.userId;
      const agentDeposits = await storage.getDepositsByAgent(id);
      const isDepositor = agentDeposits.some(d => d.depositorAddress.toLowerCase() === toAddress.toLowerCase());
      if (!isCreator && !isDepositor) {
        return res.status(403).json({ message: "Only the agent creator or a depositor can withdraw." });
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

  app.post("/api/agents/:id/remove-collateral", async (req, res) => {
    try {
      const { id } = req.params;
      const { toAddress } = req.body;

      if (!toAddress || typeof toAddress !== "string" || !toAddress.startsWith("0x")) {
        return res.status(400).json({ message: "Valid SUI wallet address required" });
      }

      const agent = await storage.getAgent(id);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(toAddress);
      const isCreator = user && user.id === agent.userId;
      const agentDeposits = await storage.getDepositsByAgent(id);
      const isDepositor = agentDeposits.some(d => d.depositorAddress.toLowerCase() === toAddress.toLowerCase());
      if (!isCreator && !isDepositor) {
        return res.status(403).json({ message: "Only the agent creator or a depositor can withdraw collateral." });
      }

      const lastPrice = getLastPrice();
      const currentPrice = lastPrice?.blended || 0;
      if (currentPrice <= 0) {
        return res.status(400).json({ message: "Cannot determine current market price" });
      }

      let closedCount = 0;
      let totalRealizedPnl = 0;
      let returnedCollateral = 0;

      const openPositions = (await storage.getPositions(id)).filter(p => p.status === "open");
      if (openPositions.length > 0) {
        const result = await closeAllPositionsForAgent(agent, currentPrice);
        closedCount = result.closed;
        totalRealizedPnl = result.totalPnl;
        returnedCollateral = result.returnedCollateral;
      }

      if (agent.status === "running") {
        await storage.updateAgent(id, { status: "idle" });
      }

      const updatedAgent = await storage.getAgent(id);
      if (!updatedAgent) {
        return res.status(500).json({ message: "Failed to retrieve updated agent" });
      }

      const withdrawBalance = updatedAgent.balance;
      let txDigest: string | null = null;

      if (withdrawBalance > 0 && updatedAgent.agentWallet && updatedAgent.walletAddress) {
        try {
          const onChainBalance = await getOnChainBalance(updatedAgent.walletAddress);
          const withdrawMist = BigInt(Math.floor(withdrawBalance * 1e9));
          const gasBudget = BigInt(10_000_000);

          if (BigInt(onChainBalance.mist) >= withdrawMist + gasBudget) {
            const { decryptKeypair } = await import("./dex/wallet-manager");
            const { Transaction } = await import("@mysten/sui/transactions");
            const keypair = decryptKeypair(updatedAgent.agentWallet);

            const tx = new Transaction();
            tx.setSender(updatedAgent.walletAddress);
            tx.setGasBudget(gasBudget);
            const [coin] = tx.splitCoins(tx.gas, [withdrawMist]);
            tx.transferObjects([coin], toAddress);

            const { suiClient } = await import("./sui-verify");
            const result = await suiClient.signAndExecuteTransaction({
              transaction: tx,
              signer: keypair,
              options: { showEffects: true },
            });

            if (result.effects?.status?.status === "success") {
              txDigest = result.digest;
              await storage.updateAgent(id, { balance: 0 });

              await storage.createVerifiedTransaction({
                txDigest: result.digest,
                txType: "remove_collateral",
                agentId: id,
                userId: updatedAgent.userId,
                sender: updatedAgent.walletAddress,
                checkpoint: null,
                rawData: { amount: withdrawBalance, toAddress, closedPositions: closedCount },
              }).catch(() => {});
            }
          } else {
            await storage.updateAgent(id, { balance: 0 });
          }
        } catch (withdrawErr: any) {
          console.error(`[RemoveCollateral] Withdraw error for ${updatedAgent.name}: ${withdrawErr.message}`);
          await storage.updateAgent(id, { balance: 0 });
        }
      } else {
        await storage.updateAgent(id, { balance: 0 });
      }

      const finalAgent = await storage.getAgent(id);
      broadcast("agent:updated", sanitizeAgent(finalAgent));

      res.json({
        success: true,
        closedPositions: closedCount,
        totalRealizedPnl,
        returnedCollateral,
        withdrawnAmount: withdrawBalance,
        txDigest,
        agentStatus: "idle",
        remainingBalance: 0,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to remove collateral" });
    }
  });

  app.get("/api/wallet/:address/summary", async (req, res) => {
    try {
      const { address } = req.params;
      if (!address || !address.startsWith("0x")) {
        return res.status(400).json({ message: "Invalid SUI address" });
      }

      const walletDeposits = await storage.getDepositsByWallet(address);
      const verifiedDeposits = walletDeposits.filter(d => d.verified && d.txDigest);

      const allAgents = await storage.getAgents();
      const allRewards = await storage.getRewards();

      const depositedAgentIds = new Set(walletDeposits.map(d => d.agentId));
      const user = await storage.getUserByWallet(address);
      if (user) {
        allAgents.filter(a => a.userId === user.id).forEach(a => depositedAgentIds.add(a.id));
      }

      const myAgentIds = Array.from(depositedAgentIds);

      let totalDepositedGross = 0;
      let totalDepositedNet = 0;
      let totalFeesPaid = 0;
      for (const d of verifiedDeposits) {
        totalDepositedGross += d.grossAmount;
        totalDepositedNet += d.amount;
        totalFeesPaid += d.protocolFee;
      }

      let totalLockedCollateral = 0;
      let totalFreeBalance = 0;
      let totalRealizedPnl = 0;
      let totalUnrealizedPnl = 0;
      let verifiedOpenPositions = 0;
      let verifiedClosedPositions = 0;

      for (const agentId of myAgentIds) {
        const agent = allAgents.find(a => a.id === agentId);
        if (agent) totalFreeBalance += agent.balance;

        const allPositions = await storage.getPositions(agentId);
        const verifiedPos = allPositions.filter(p => p.txDigest && !p.txDigest.startsWith("sim_") && p.verified);
        for (const p of verifiedPos) {
          if (p.status === "open") {
            totalLockedCollateral += p.sizeSui;
            totalUnrealizedPnl += p.unrealizedPnl || 0;
            verifiedOpenPositions++;
          } else {
            totalRealizedPnl += p.unrealizedPnl || 0;
            verifiedClosedPositions++;
          }
        }
      }

      const myRewards = allRewards.filter(r => myAgentIds.includes(r.agentId));
      const verifiedClaimedRewards = myRewards.filter(r => r.status === "claimed" && r.txDigest && r.verified);
      const pendingRewards = myRewards.filter(r => r.status === "pending");
      const totalClaimedVerified = verifiedClaimedRewards.reduce((s, r) => s + r.amount, 0);
      const totalPendingRewards = pendingRewards.reduce((s, r) => s + r.amount, 0);

      res.json({
        wallet: address,
        totalDepositedGross,
        totalDepositedNet,
        totalFeesPaid,
        totalFreeBalance,
        totalLockedCollateral,
        totalRealizedPnl,
        totalUnrealizedPnl,
        totalClaimedVerified,
        totalPendingRewards,
        verifiedOpenPositions,
        verifiedClosedPositions,
        depositsCount: verifiedDeposits.length,
        claimsCount: verifiedClaimedRewards.length,
        agentIds: myAgentIds,
        deposits: verifiedDeposits.slice(0, 20).map(d => ({
          agentId: d.agentId,
          amount: d.amount,
          grossAmount: d.grossAmount,
          fee: d.protocolFee,
          txDigest: d.txDigest,
          date: d.createdAt,
        })),
        claims: verifiedClaimedRewards.slice(0, 20).map(r => ({
          agentId: r.agentId,
          amount: r.amount,
          txDigest: r.txDigest,
          date: r.claimedAt,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to get wallet summary" });
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

  app.get("/api/debug/ledger", async (req, res) => {
    try {
      const wallet = req.query.wallet as string;
      const allAgents = await storage.getAgents();
      const allRewards = await storage.getRewards();
      const allFees = await storage.getProtocolFees();
      

      let deposits: any[] = [];
      let agentIds: string[] = [];

      if (wallet) {
        const walletDeposits = await storage.getDepositsByWallet(wallet);
        deposits = walletDeposits;
        const depositedAgentIds = new Set(walletDeposits.map(d => d.agentId));
        const user = await storage.getUserByWallet(wallet);
        if (user) {
          allAgents.filter(a => a.userId === user.id).forEach(a => depositedAgentIds.add(a.id));
        }
        agentIds = Array.from(depositedAgentIds);
      } else {
        agentIds = allAgents.map(a => a.id);
        for (const agentId of agentIds) {
          const agentDeps = await storage.getDepositsByAgent(agentId);
          deposits.push(...agentDeps);
        }
      }

      const myAgents = allAgents.filter(a => agentIds.includes(a.id));
      const myRewards = allRewards.filter(r => agentIds.includes(r.agentId));
      const myFees = allFees.filter(f => agentIds.includes(f.agentId));

      const allOrders: any[] = [];
      const allPositions: any[] = [];
      for (const agentId of agentIds) {
        const orders = await storage.getOrders(agentId);
        const positions = await storage.getPositions(agentId);
        allOrders.push(...orders.map(o => ({ ...o, agentId })));
        allPositions.push(...positions.map(p => ({ ...p, agentId })));
      }

      const recentDigests = [
        ...deposits.filter(d => d.txDigest).map(d => ({ type: "deposit", digest: d.txDigest, date: d.createdAt, amount: d.grossAmount, agentId: d.agentId })),
        ...myRewards.filter(r => r.txDigest).map(r => ({ type: "claim", digest: r.txDigest, date: r.claimedAt, amount: r.amount, agentId: r.agentId })),
        ...allOrders.filter(o => o.txDigest && !o.txDigest.startsWith("sim_")).map(o => ({ type: "order", digest: o.txDigest, date: o.createdAt, amount: null, agentId: o.agentId })),
        ...allPositions.filter(p => p.txDigest && !p.txDigest.startsWith("sim_")).map(p => ({ type: "position", digest: p.txDigest, date: p.openedAt, amount: p.sizeSui, agentId: p.agentId })),
      ].sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        return db - da;
      }).slice(0, 50);

      const totalDeposited = deposits.reduce((s, d) => s + (d.grossAmount || 0), 0);
      const totalFees = deposits.reduce((s, d) => s + (d.protocolFee || 0), 0);
      const totalNetDeposited = deposits.reduce((s, d) => s + (d.amount || 0), 0);
      const totalAgentBalance = myAgents.reduce((s, a) => s + a.balance, 0);
      const pendingRewards = myRewards.filter(r => r.status === "pending").reduce((s, r) => s + r.amount, 0);
      const claimedRewards = myRewards.filter(r => r.status === "claimed" && r.verified).reduce((s, r) => s + r.amount, 0);

      res.json({
        wallet: wallet || "all",
        agents: myAgents.map(a => ({
          id: a.id,
          name: a.name,
          balance: a.balance,
          walletAddress: a.walletAddress,
          status: a.status,
          totalDeposited: a.totalDeposited,
          totalPnl: a.totalPnl,
        })),
        deposits: deposits.map(d => ({
          id: d.id,
          agentId: d.agentId,
          depositorAddress: d.depositorAddress,
          grossAmount: d.grossAmount,
          netAmount: d.amount,
          protocolFee: d.protocolFee,
          txDigest: d.txDigest,
          verified: d.verified,
          checkpoint: d.checkpoint,
          date: d.createdAt,
        })),
        rewards: myRewards.map(r => ({
          id: r.id,
          agentId: r.agentId,
          amount: r.amount,
          status: r.status,
          txDigest: r.txDigest,
          verified: r.verified,
          date: r.status === "claimed" ? r.claimedAt : r.createdAt,
        })),
        recentDigests,
        totals: {
          totalDeposited,
          totalFees,
          totalNetDeposited,
          totalAgentBalance,
          pendingRewards,
          claimedRewards,
          agentCount: myAgents.length,
          depositCount: deposits.length,
          verifiedDepositCount: deposits.filter(d => d.verified).length,
          orderCount: allOrders.filter(o => o.txDigest && !o.txDigest.startsWith("sim_")).length,
          positionCount: allPositions.filter(p => p.txDigest && !p.txDigest.startsWith("sim_")).length,
        },
        feeAddress: PROTOCOL_FEE_ADDRESS,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to get ledger" });
    }
  });

  app.post("/api/debug/trace", async (req, res) => {
    try {
      const { digest } = req.body;
      if (!digest) {
        return res.status(400).json({ message: "Transaction digest required" });
      }

      const result = await verifyTxDigest(digest);

      const suiChanges = (result.balanceChanges || [])
        .filter((bc: any) => bc.coinType === "0x2::sui::SUI" || bc.coinType?.includes("::sui::SUI"))
        .map((bc: any) => ({
          owner: bc.owner?.AddressOwner || bc.owner?.ObjectOwner || "unknown",
          amountMist: bc.amount,
          amountSui: Number(bc.amount) / 1e9,
          direction: Number(bc.amount) < 0 ? "SENT" : "RECEIVED",
        }));

      res.json({
        digest,
        status: "success",
        sender: result.sender,
        checkpoint: result.checkpoint,
        suiChanges,
        isContractCall: false,
        objectsCreated: 0,
      });
    } catch (e: any) {
      res.status(400).json({
        digest: req.body?.digest,
        status: "error",
        error: e.message || "Failed to trace transaction",
      });
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
      const verifiedFees = fees.filter((f) => f.verified && f.txDigest);
      const totalFeesCollected = verifiedFees.reduce((sum, f) => sum + f.amount, 0);
      const totalVerifiedFees = totalFeesCollected;
      const uniqueUsers = new Set(verifiedFees.map((f) => f.userId));
      const uniqueAgents = new Set(verifiedFees.map((f) => f.agentId));
      const verifiedClaimedRewards = allRewards.filter((r) => r.status === "claimed" && r.txDigest && r.verified);
      const totalRewardsPaid = verifiedClaimedRewards.reduce((sum, r) => sum + r.amount, 0);
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
        recentFees: verifiedFees.slice(0, 20),
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
      const pendingRewards = allRewards.filter((r) => r.status === "pending");
      const verifiedClaimed = allRewards.filter((r) => r.status === "claimed" && r.txDigest && r.verified);
      const totalPending = pendingRewards.reduce((sum, r) => sum + r.amount, 0);
      const totalClaimed = verifiedClaimed.reduce((sum, r) => sum + r.amount, 0);

      const verifiableRewards = [...pendingRewards, ...verifiedClaimed];

      res.json({
        totalPending,
        totalClaimed,
        totalEarned: totalPending + totalClaimed,
        rewards: verifiableRewards,
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

  app.post("/api/admin/backfill-rewards", async (_req, res) => {
    try {
      const allAgents = await storage.getAgents();
      const existingRewards = await storage.getRewards();
      let created = 0;
      let winRatesUpdated = 0;

      for (const agent of allAgents) {
        const allPositions = await storage.getPositions(agent.id);
        const closedPositions = allPositions.filter(p => p.status === "closed");

        if (closedPositions.length === 0) continue;

        const totalClosed = closedPositions.length;
        const totalWins = closedPositions.filter(p => {
          const realizedPnl = p.unrealizedPnl || 0;
          return realizedPnl > 0;
        }).length;
        const newWinRate = totalClosed > 0 ? totalWins / totalClosed : 0;

        if (Math.abs(agent.winRate - newWinRate) > 0.001) {
          await storage.updateAgent(agent.id, { winRate: newWinRate });
          winRatesUpdated++;
        }

        const agentRewards = existingRewards.filter(r => r.agentId === agent.id);
        const profitablePositions = closedPositions.filter(p => (p.unrealizedPnl || 0) > 0);

        if (agentRewards.length >= profitablePositions.length) continue;

        const rewardSharePct = agent.rewardSharePct ?? 50;
        if (rewardSharePct <= 0) continue;

        const existingAmountSet = new Set(agentRewards.map(r => Math.round(r.amount * 10000)));

        for (const pos of profitablePositions) {
          const realizedPnl = pos.unrealizedPnl || 0;
          const rewardAmount = realizedPnl * (rewardSharePct / 100);
          if (rewardAmount <= 0) continue;

          const roundedAmount = Math.round(rewardAmount * 10000);
          if (existingAmountSet.has(roundedAmount)) {
            existingAmountSet.delete(roundedAmount);
            continue;
          }

          await storage.createReward({
            agentId: agent.id,
            userId: agent.userId,
            amount: rewardAmount,
          });
          created++;
        }
      }

      res.json({ success: true, rewardsCreated: created, winRatesUpdated });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Backfill failed" });
    }
  });

  app.get("/api/bundles", async (_req, res) => {
    try {
      const bundles = await storage.getInstructionBundles();
      res.json(bundles);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/bundles/:agentId/latest", async (req, res) => {
    try {
      const agentId = req.params.agentId;
      const bundles = await storage.getInstructionBundles(agentId);
      res.json(bundles);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/bundles/executions/:agentId", async (req, res) => {
    try {
      const agentId = req.params.agentId;
      const executions = await storage.getBundleExecutions(agentId);
      res.json(executions);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/recovery/analyze-tx", async (req, res) => {
    try {
      const { txDigest } = req.body;
      if (!txDigest || typeof txDigest !== "string") {
        return res.status(400).json({ message: "txDigest is required" });
      }

      const result = await verifyTxDigest(txDigest);
      const sender = result.sender || "unknown";
      const checkpoint = result.checkpoint;

      const balanceChanges = result.balanceChanges || [];
      const suiChanges = balanceChanges.filter((bc: any) =>
        bc.coinType === "0x2::sui::SUI" || bc.coinType === "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
      );

      const protocolFeeAddr = PROTOCOL_FEE_ADDRESS.toLowerCase();
      const senderAddr = sender.toLowerCase();

      const transfers = suiChanges.map((bc: any) => {
        const owner = bc.owner?.AddressOwner || "unknown";
        const amount = Number(bc.amount) / 1e9;
        let role = "unknown";
        if (owner.toLowerCase() === protocolFeeAddr) role = "protocol_fee";
        else if (owner.toLowerCase() === senderAddr) role = "sender";
        else if (Number(bc.amount) > 0) role = "agent_wallet";
        return { address: owner, amount, role, rawMist: bc.amount };
      });

      const agentTransfer = transfers.find((t: any) => t.role === "agent_wallet");
      const feeTransfer = transfers.find((t: any) => t.role === "protocol_fee");

      let agentBalance = null;
      if (agentTransfer) {
        try {
          const bal = await getOnChainBalance(agentTransfer.address);
          agentBalance = bal.sui;
        } catch {}
      }

      const existingAgent = agentTransfer
        ? await storage.getAgentByWallet(agentTransfer.address).catch(() => null)
        : null;

      const existingDeposit = await storage.getDepositByTxDigest(txDigest).catch(() => null);
      const existingVerified = await storage.getVerifiedTransactionByDigest(txDigest).catch(() => null);

      res.json({
        txDigest,
        status: "success",
        sender,
        checkpoint,
        transfers,
        agentWallet: agentTransfer?.address || null,
        agentWalletBalance: agentBalance,
        protocolFee: feeTransfer?.amount || 0,
        grossDeposit: agentTransfer && feeTransfer ? agentTransfer.amount + feeTransfer.amount : null,
        netDeposit: agentTransfer?.amount || null,
        alreadyTracked: !!existingDeposit || !!existingVerified,
        agentExists: !!existingAgent,
        agentId: existingAgent?.id || null,
        recoverable: !existingDeposit && !!agentTransfer,
      });
    } catch (e: any) {
      res.status(500).json({ message: `Failed to analyze transaction: ${e.message}` });
    }
  });

  app.post("/api/recovery/import-deposit", async (req, res) => {
    try {
      const { txDigest, walletAddress } = req.body;
      if (!txDigest) {
        return res.status(400).json({ message: "txDigest is required" });
      }

      const existingDeposit = await storage.getDepositByTxDigest(txDigest).catch(() => null);
      if (existingDeposit) {
        return res.status(409).json({ message: "This transaction has already been imported", deposit: existingDeposit });
      }

      const existingVerified = await storage.getVerifiedTransactionByDigest(txDigest).catch(() => null);
      if (existingVerified) {
        return res.status(409).json({ message: "This transaction has already been verified and tracked", tx: existingVerified });
      }

      const result = await verifyTxDigest(txDigest);
      const sender = result.sender || "";
      const checkpoint = result.checkpoint;

      if (!sender) {
        return res.status(400).json({ message: "Could not determine sender from on-chain data" });
      }

      const balanceChanges = result.balanceChanges || [];
      const suiChanges = balanceChanges.filter((bc: any) =>
        bc.coinType === "0x2::sui::SUI" || bc.coinType === "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
      );

      const protocolFeeAddr = PROTOCOL_FEE_ADDRESS.toLowerCase();

      const feeChange = suiChanges.find((bc: any) => {
        const owner = ((bc.owner as any)?.AddressOwner || "").toLowerCase();
        return owner === protocolFeeAddr && Number(bc.amount) > 0;
      });

      if (!feeChange) {
        return res.status(400).json({ message: "No protocol fee transfer found - this does not appear to be a Blue Water deposit transaction" });
      }

      const agentChange = suiChanges.find((bc: any) => {
        const owner = ((bc.owner as any)?.AddressOwner || "").toLowerCase();
        return owner !== protocolFeeAddr && owner !== sender.toLowerCase() && Number(bc.amount) > 0;
      });

      if (!agentChange) {
        return res.status(400).json({ message: "No agent wallet transfer found in this transaction" });
      }

      const agentWalletAddr = (agentChange.owner as any)?.AddressOwner || "";
      const netAmount = Number(agentChange.amount) / 1e9;
      const feeAmount = Number(feeChange.amount) / 1e9;
      const grossAmount = netAmount + feeAmount;

      const expectedFeeRate = feeAmount / grossAmount;
      if (Math.abs(expectedFeeRate - PROTOCOL_FEE_RATE) > 0.005) {
        return res.status(400).json({
          message: `Fee rate mismatch: expected ${(PROTOCOL_FEE_RATE * 100).toFixed(1)}% but found ${(expectedFeeRate * 100).toFixed(1)}%. This may not be a Blue Water deposit.`,
        });
      }

      let agent = await storage.getAgentByWallet(agentWalletAddr).catch(() => null);
      let agentId = agent?.id;

      if (!agent && walletAddress) {
        let user = await storage.getUserByWallet(walletAddress);
        if (!user) {
          user = await storage.createUser({ walletAddress });
        }

        agent = await storage.createAgent({
          userId: user.id,
          name: `Recovered-${agentWalletAddr.slice(0, 8)}`,
          venue: "typus",
          leverage: 5,
          maxQty: 1,
          stopLossBps: 80,
          takeProfitBps: 200,
        });

        await storage.updateAgent(agent.id, {
          walletAddress: agentWalletAddr,
          status: "recovered",
        });
        agentId = agent.id;
      }

      if (!agentId) {
        return res.status(400).json({
          message: "Agent not found for this wallet address. Provide your walletAddress to create a recovery agent.",
          agentWallet: agentWalletAddr,
        });
      }

      await storage.depositToAgent(agentId, netAmount, txDigest, checkpoint);

      await storage.createDeposit({
        agentId,
        depositorAddress: sender,
        amount: netAmount,
        grossAmount,
        protocolFee: feeAmount,
        txDigest,
      }).catch(() => {});

      await storage.createVerifiedTransaction({
        txDigest,
        txType: "deposit_recovery",
        agentId,
        userId: sender,
        sender,
        checkpoint: checkpoint ?? null,
        rawData: { netAmount, feeAmount, grossAmount, recoveredAt: new Date().toISOString() },
      }).catch(() => {});

      if (feeAmount > 0) {
        await storage.createProtocolFee({
          agentId,
          userId: sender,
          amount: feeAmount,
          txDigest,
        }).catch(() => {});
      }

      const updatedAgent = await storage.getAgent(agentId);
      res.json({
        success: true,
        txDigest,
        agentId,
        agentWallet: agentWalletAddr,
        netDeposit: netAmount,
        protocolFee: feeAmount,
        grossAmount,
        sender,
        agentBalance: updatedAgent?.balance || 0,
        recoveredAgent: !agent,
        message: `Successfully recovered deposit of ${grossAmount.toFixed(2)} SUI (${netAmount.toFixed(2)} net + ${feeAmount.toFixed(2)} fee)`,
      });
    } catch (e: any) {
      res.status(500).json({ message: `Recovery failed: ${e.message}` });
    }
  });

  return httpServer;
}
