import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { startMarketEngine, getMarketState, getPriceHistory, getIndicatorHistory, getCandleHistory, getLastSignalResult } from "./market-engine";
import { priceBus, getLastPrice } from "./price-service";
import { insertAgentSchema, PROTOCOL_FEE_RATE, PROTOCOL_FEE_ADDRESS } from "@shared/schema";
import { verifyTxDigest, getOnChainBalance, verifyDepositTransfers, resolveNSName } from "./sui-verify";
import { generateAgentWallet, getAdapterStatus, getAdapter } from "./dex";
import { closeAllPositionsForAgent, closePositionForAgent, resetGasSpendTracking } from "./dex/execution-engine";
import { startExecutorLoop } from "./executor/executor-loop";
import { runStartupIntegrityChecks, startPeriodicBalanceSync } from "./startup-integrity";
import { initRewardWallet, getRewardWalletAddress, getRewardWalletBalance, transferRewardToUser } from "./reward-wallet";

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

  initRewardWallet().catch(err => {
    console.error("[startup] Reward wallet init failed:", err.message);
  });

  runStartupIntegrityChecks().catch(err => {
    console.error("[startup] Integrity check failed:", err.message);
  });

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

  startPeriodicBalanceSync(broadcast);

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
        symbol: "SUI-USDC",
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
      const verifiedCloses = closedPositions.filter(p => !!p.closeTxDigest);
      const unverifiedCloses = closedPositions.filter(p => !p.closeTxDigest);
      const totalClosed = closedPositions.length;
      const totalWins = closedPositions.filter(p => (p.unrealizedPnl || 0) > 0).length;
      const liveWinRate = totalClosed > 0 ? totalWins / totalClosed : 0;

      let lockedCollateral = 0;
      let totalUnrealizedPnl = 0;
      for (const pos of openPositions) {
        lockedCollateral += pos.sizeSui / agent.leverage;
        totalUnrealizedPnl += pos.unrealizedPnl || 0;
      }

      let effectiveBalance = agent.balance;
      if (agent.walletAddress) {
        try {
          const onChain = await getOnChainBalance(agent.walletAddress);
          const onChainTotal = onChain.sui + lockedCollateral;
          if (Math.abs(effectiveBalance - onChainTotal) > 0.1) {
            console.log(`[Activity] Balance sync for ${agent.name}: DB=${effectiveBalance.toFixed(4)} -> on-chain=${onChain.sui.toFixed(4)}+locked=${lockedCollateral.toFixed(4)}=${onChainTotal.toFixed(4)}`);
            effectiveBalance = onChainTotal;
            storage.updateAgent(agent.id, { balance: onChainTotal }).catch(() => {});
          }
        } catch (e) {}
      }
      const portfolioValue = effectiveBalance + totalUnrealizedPnl;

      let realizedGain = 0;
      let realizedLoss = 0;
      for (const pos of closedPositions) {
        const pnl = pos.unrealizedPnl || 0;
        if (pnl > 0) realizedGain += pnl;
        else realizedLoss += pnl;
      }

      const allRewards = await storage.getRewards();
      const agentRewards = allRewards.filter(r => r.agentId === req.params.id && r.status !== "voided");
      const pendingRewards = agentRewards.filter(r => r.status === "pending").reduce((s, r) => s + r.amount, 0);
      const claimedRewards = agentRewards.filter(r => r.status === "claimed").reduce((s, r) => s + r.amount, 0);

      const rewardSharePct = agent.rewardSharePct ?? 50;
      const reinvestPct = 100 - rewardSharePct;
      const totalRealizedProfit = realizedGain;
      const reinvestedAmount = rewardSharePct > 0 && totalRealizedProfit > 0
        ? totalRealizedProfit * (reinvestPct / 100)
        : totalRealizedProfit;

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
        realizedGain,
        realizedLoss,
        pendingRewards,
        claimedRewards,
        reinvestedAmount,
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
        symbol: "SUI-USDC",
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

      const minColl = parsed.minCollateral ?? 0.4;
      const maxColl = parsed.maxCollateral ?? 10;
      if (minColl < 0.2) {
        return res.status(400).json({ message: "Minimum collateral must be at least 0.2 SUI" });
      }
      if (maxColl < minColl) {
        return res.status(400).json({ message: "Maximum collateral must be greater than or equal to minimum collateral" });
      }

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
        autoTrade: true,
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
      const walletAddress = req.query.wallet as string || req.body.walletAddress;
      const updates = { ...req.body };
      delete updates.autoTrade;
      delete updates.walletAddress;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required. Connect your wallet to modify agents." });
      }

      const existingAgent = await storage.getAgent(id);
      if (!existingAgent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === existingAgent.userId;
      const isCreator = existingAgent.walletAddress && existingAgent.walletAddress.toLowerCase() === walletAddress.toLowerCase();

      if (!isOwner && !isCreator) {
        return res.status(403).json({ message: "You can only modify agents you created." });
      }

      if (updates.minCollateral !== undefined || updates.maxCollateral !== undefined) {
        const minColl = updates.minCollateral ?? existingAgent.minCollateral ?? 0.4;
        const maxColl = updates.maxCollateral ?? existingAgent.maxCollateral ?? 10;
        if (minColl < 0.2) {
          return res.status(400).json({ message: "Minimum collateral must be at least 0.2 SUI" });
        }
        if (maxColl < minColl) {
          return res.status(400).json({ message: "Maximum collateral must be >= minimum collateral" });
        }
      }

      const agent = await storage.updateAgent(id, updates);
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
      const isCreator = agent.walletAddress && agent.walletAddress.toLowerCase() === walletAddress.toLowerCase();

      if (!isOwner && !isCreator) {
        return res.status(403).json({ message: "You can only delete agents you created." });
      }

      const openPositions = await storage.getOpenPositions(id);
      if (openPositions.length > 0) {
        console.log(`[Delete] Agent ${agent.name} has ${openPositions.length} DB-open positions. Force-closing them for deletion.`);
        const { getLastPrice } = await import("./price-service");
        const priceTick = getLastPrice();
        const currentPrice = priceTick?.pyth?.price ?? priceTick?.blended ?? 0;
        for (const pos of openPositions) {
          const realizedPnl = currentPrice > 0
            ? ((pos.side === "long"
              ? (currentPrice - pos.entryPrice) * pos.sizeSui / currentPrice
              : (pos.entryPrice - currentPrice) * pos.sizeSui / currentPrice))
            : 0;
          await storage.updatePosition(pos.id, {
            status: "closed",
            markPrice: currentPrice || pos.markPrice,
            unrealizedPnl: realizedPnl,
            closedAt: new Date(),
          });
        }
      }

      if (agent.status === "running") {
        await storage.updateAgent(id, { status: "idle" });
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

  app.post("/api/agents/:id/clone", async (req, res) => {
    try {
      const { id } = req.params;
      const { walletAddress, name } = req.body;

      if (!walletAddress || typeof walletAddress !== "string" || !walletAddress.startsWith("0x")) {
        return res.status(401).json({ message: "Connect your SUI wallet to clone an agent." });
      }

      const parentAgent = await storage.getAgent(id);
      if (!parentAgent) {
        return res.status(404).json({ message: "Parent agent not found" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === parentAgent.userId;
      if (!isOwner) {
        return res.status(403).json({ message: "Only the agent owner can clone their strategy." });
      }

      const cloneName = name || `${parentAgent.name} (Clone)`;

      const cloneData = {
        userId: parentAgent.userId,
        name: cloneName,
        venue: parentAgent.venue,
        leverage: parentAgent.leverage,
        maxQty: parentAgent.maxQty,
        stopLossBps: parentAgent.stopLossBps,
        takeProfitBps: parentAgent.takeProfitBps,
        autoTrade: parentAgent.autoTrade,
        rewardSharePct: parentAgent.rewardSharePct,
      };

      const cloneAgent = await storage.createAgent(cloneData);

      await storage.updateAgent(cloneAgent.id, {
        isClone: true,
        parentAgentId: parentAgent.id,
      });

      const updated = await storage.getAgentWithSignalAgent(cloneAgent.id);
      broadcast("agent:created", sanitizeAgent(updated));

      res.json({
        success: true,
        agent: sanitizeAgent(updated),
        parentAgent: { id: parentAgent.id, name: parentAgent.name },
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to clone agent" });
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
        verified: true,
        checkpoint: verifiedCheckpoint ?? null,
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
      const { amount, toAddress, authTxDigest } = req.body;

      if (!authTxDigest || typeof authTxDigest !== "string") {
        return res.status(400).json({ message: "Wallet authorization transaction required. Please approve the transaction in your wallet." });
      }

      if (!toAddress || typeof toAddress !== "string" || !toAddress.startsWith("0x")) {
        return res.status(400).json({ message: "Valid SUI wallet address required" });
      }

      const authResult = await verifyTxDigest(authTxDigest);
      if (!authResult.sender || authResult.sender.toLowerCase() !== toAddress.toLowerCase()) {
        return res.status(403).json({ message: "Authorization transaction sender does not match the withdrawal address. Sign from the correct wallet." });
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

      const onChainBalance = await getOnChainBalance(agent.walletAddress);
      const gasBudget = BigInt(10_000_000);
      const maxOnChainWithdraw = Math.max(0, (Number(onChainBalance.mist) - Number(gasBudget)) / 1e9);

      let withdrawAmount: number;
      if (parsedAmount && parsedAmount > 0) {
        withdrawAmount = parsedAmount;
      } else if (agent.balance > 0) {
        withdrawAmount = agent.balance;
      } else if (maxOnChainWithdraw > 0.001) {
        withdrawAmount = maxOnChainWithdraw;
      } else {
        return res.status(400).json({ message: "No balance available to withdraw" });
      }

      if (withdrawAmount > maxOnChainWithdraw) {
        return res.status(400).json({
          message: `Insufficient on-chain balance. Agent wallet has ${onChainBalance.sui.toFixed(4)} SUI on-chain (${maxOnChainWithdraw.toFixed(4)} withdrawable after gas).`,
        });
      }

      const withdrawMist = BigInt(Math.floor(withdrawAmount * 1e9));

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
        balance: Math.max(0, agent.balance - withdrawAmount),
      });

      await storage.createVerifiedTransaction({
        txDigest: result.digest,
        txType: "withdraw",
        agentId: id,
        userId: agent.userId,
        sender: agent.walletAddress,
        checkpoint: null,
        rawData: { amount: withdrawAmount, toAddress, authTxDigest },
      }).catch(() => {});

      broadcast("agent:updated", sanitizeAgent(await storage.getAgent(id)));

      res.json({
        txDigest: result.digest,
        amount: withdrawAmount,
        toAddress,
        remainingBalance: Math.max(0, agent.balance - withdrawAmount),
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to withdraw" });
    }
  });

  app.get("/api/agents/:id/on-chain-balance", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      if (!agent.walletAddress) return res.status(400).json({ message: "Agent wallet not configured" });

      const onChain = await getOnChainBalance(agent.walletAddress);
      res.json({
        walletAddress: agent.walletAddress,
        onChainSui: onChain.sui,
        onChainMist: onChain.mist,
        dbBalance: agent.balance,
        mismatch: Math.abs(onChain.sui - agent.balance) > 0.001,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to get on-chain balance" });
    }
  });

  app.post("/api/agents/:id/sync-balance", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      if (!agent.walletAddress) return res.status(400).json({ message: "Agent wallet not configured" });

      const onChain = await getOnChainBalance(agent.walletAddress);

      const positions = await storage.getPositions(agent.id);
      const openPositions = positions.filter(p => p.status === "open");
      let lockedCollateral = 0;
      for (const pos of openPositions) {
        lockedCollateral += pos.sizeSui / agent.leverage;
      }

      const correctedBalance = onChain.sui + lockedCollateral;
      const diff = correctedBalance - agent.balance;

      if (Math.abs(diff) < 0.001) {
        return res.json({ synced: false, message: "Balances already match", dbBalance: agent.balance, onChainSui: onChain.sui, lockedCollateral });
      }

      const updated = await storage.updateAgent(agent.id, { balance: correctedBalance });

      broadcast("agent:updated", sanitizeAgent(updated));
      res.json({ synced: true, previousBalance: agent.balance, newBalance: correctedBalance, onChainSui: onChain.sui, lockedCollateral, diff });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to sync balance" });
    }
  });

  app.post("/api/agents/:id/resume", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });

      const walletAddress = req.query.wallet as string || req.body.walletAddress;
      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required." });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === agent.userId;
      const isCreator = agent.walletAddress && agent.walletAddress.toLowerCase() === walletAddress.toLowerCase();
      if (!isOwner && !isCreator) {
        return res.status(403).json({ message: "Only the agent owner can resume it." });
      }

      if (agent.status === "running") {
        return res.json({ message: "Agent is already running", agent: sanitizeAgent(agent) });
      }

      resetGasSpendTracking(agent.id);

      const adapter = getAdapter(agent.venue || "typus");
      if (adapter && typeof (adapter as any).resetCircuitBreaker === "function") {
        (adapter as any).resetCircuitBreaker(agent.id);
      }

      const updated = await storage.updateAgent(agent.id, { status: "running", lastExecutionError: null });
      broadcast("agent:updated", sanitizeAgent(updated));
      res.json({ message: "Agent resumed", agent: sanitizeAgent(updated) });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to resume agent" });
    }
  });

  app.post("/api/agents/:id/recalculate-stats", async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });

      const allPositions = await storage.getPositions(agent.id);
      const closedPositions = allPositions.filter(p => p.status === "closed");
      const openPositions = allPositions.filter(p => p.status === "open");

      let onChainSui: number;
      if (agent.walletAddress) {
        try {
          const onChain = await getOnChainBalance(agent.walletAddress);
          onChainSui = onChain.sui;
        } catch (e: any) {
          return res.status(503).json({ message: "On-chain balance unavailable — please retry" });
        }
      } else {
        return res.status(400).json({ message: "Agent has no wallet address" });
      }

      const lockedCollateral = openPositions.reduce((sum, p) => sum + p.sizeSui / agent.leverage, 0);
      const onChainTotal = onChainSui + lockedCollateral;

      const netDeposited = (agent.totalDeposited || 0) - (agent.protocolFeePaid || 0);
      const onChainDerivedPnl = onChainTotal - netDeposited;

      let recalcPnl = 0;
      let wins = 0;
      for (const pos of closedPositions) {
        const collateral = pos.sizeSui / agent.leverage;
        const cappedPnl = Math.max(-(collateral), pos.unrealizedPnl || 0);
        recalcPnl += cappedPnl;
        if (cappedPnl > 0) wins++;
      }

      const totalTrades = closedPositions.length + openPositions.length;
      const winRate = closedPositions.length > 0 ? wins / closedPositions.length : 0;

      const newBalance = onChainTotal;

      console.log(`[Recalc] ${agent.name}: onChain=${onChainSui.toFixed(4)}, locked=${lockedCollateral.toFixed(4)}, total=${onChainTotal.toFixed(4)}, netDeposited=${netDeposited.toFixed(4)}, dbPnl=${recalcPnl.toFixed(4)}, onChainPnl=${onChainDerivedPnl.toFixed(4)}`);

      const updated = await storage.updateAgent(agent.id, {
        totalPnl: onChainDerivedPnl,
        totalTrades,
        winRate,
        balance: newBalance,
      });

      broadcast("agent:updated", sanitizeAgent(updated));
      res.json({
        recalculated: true,
        closedPositions: closedPositions.length,
        openPositions: openPositions.length,
        totalTrades,
        totalPnl: onChainDerivedPnl,
        winRate,
        newBalance,
        previousPnl: agent.totalPnl,
        previousTrades: agent.totalTrades,
        onChainSui,
        lockedCollateral,
        netDeposited,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to recalculate" });
    }
  });

  app.post("/api/agents/:id/refund", async (req, res) => {
    try {
      const { id } = req.params;
      const { toAddress, authTxDigest } = req.body;

      if (!authTxDigest || typeof authTxDigest !== "string") {
        return res.status(400).json({ message: "Wallet authorization transaction required." });
      }
      if (!toAddress || typeof toAddress !== "string" || !toAddress.startsWith("0x")) {
        return res.status(400).json({ message: "Valid SUI wallet address required" });
      }

      const authResult = await verifyTxDigest(authTxDigest);
      if (!authResult.sender || authResult.sender.toLowerCase() !== toAddress.toLowerCase()) {
        return res.status(403).json({ message: "Authorization transaction sender does not match your wallet." });
      }

      const agent = await storage.getAgent(id);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      if (!agent.agentWallet || !agent.walletAddress) {
        return res.status(400).json({ message: "Agent wallet not configured" });
      }

      const user = await storage.getUserByWallet(toAddress);
      const isCreator = user && user.id === agent.userId;
      const agentDeposits = await storage.getDepositsByAgent(id);
      const isDepositor = agentDeposits.some(d => d.depositorAddress.toLowerCase() === toAddress.toLowerCase());
      if (!isCreator && !isDepositor) {
        return res.status(403).json({ message: "Only the agent creator or a depositor can request a refund." });
      }

      const onChainBalance = await getOnChainBalance(agent.walletAddress);
      const gasBudget = BigInt(2_000_000);
      const availableMist = BigInt(onChainBalance.mist) - gasBudget;

      if (availableMist <= BigInt(0)) {
        return res.status(400).json({ message: `No refundable balance. Agent wallet has ${onChainBalance.sui.toFixed(6)} SUI on-chain, which is less than the ~0.002 SUI gas fee needed to send a transaction.` });
      }

      const { decryptKeypair } = await import("./dex/wallet-manager");
      const { Transaction } = await import("@mysten/sui/transactions");
      const keypair = decryptKeypair(agent.agentWallet);

      const tx = new Transaction();
      tx.setSender(agent.walletAddress);
      tx.setGasBudget(gasBudget);
      const [coin] = tx.splitCoins(tx.gas, [availableMist]);
      tx.transferObjects([coin], toAddress);

      const { suiClient } = await import("./sui-verify");
      const result = await suiClient.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true },
      });

      if (result.effects?.status?.status !== "success") {
        return res.status(500).json({ message: "On-chain refund transaction failed" });
      }

      const refundedSui = Number(availableMist) / 1e9;

      await storage.updateAgent(id, { balance: 0 });

      await storage.createVerifiedTransaction({
        txDigest: result.digest,
        txType: "refund",
        agentId: id,
        userId: agent.userId,
        sender: agent.walletAddress,
        checkpoint: null,
        rawData: { amount: refundedSui, toAddress, authTxDigest, type: "full_refund" },
      }).catch(() => {});

      broadcast("agent:updated", sanitizeAgent(await storage.getAgent(id)));

      res.json({
        txDigest: result.digest,
        amount: refundedSui,
        toAddress,
        message: `Refunded ${refundedSui.toFixed(4)} SUI to ${toAddress}`,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to process refund" });
    }
  });

  app.post("/api/agents/:id/remove-collateral", async (req, res) => {
    try {
      const { id } = req.params;
      const { toAddress, authTxDigest } = req.body;

      if (!authTxDigest || typeof authTxDigest !== "string") {
        return res.status(400).json({ message: "Wallet authorization transaction required. Please approve the transaction in your wallet." });
      }

      if (!toAddress || typeof toAddress !== "string" || !toAddress.startsWith("0x")) {
        return res.status(400).json({ message: "Valid SUI wallet address required" });
      }

      const authResult = await verifyTxDigest(authTxDigest);
      if (!authResult.sender || authResult.sender.toLowerCase() !== toAddress.toLowerCase()) {
        return res.status(403).json({ message: "Authorization transaction sender does not match your wallet address. Sign from the correct wallet." });
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
        const result = await closeAllPositionsForAgent(agent, currentPrice, true);
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

      if (updatedAgent.agentWallet && updatedAgent.walletAddress) {
        try {
          const onChainBalance = await getOnChainBalance(updatedAgent.walletAddress);
          const gasBudget = BigInt(10_000_000);
          const maxOnChainWithdraw = Math.max(0, (Number(onChainBalance.mist) - Number(gasBudget)) / 1e9);
          const actualWithdrawAmount = Math.min(
            Math.max(withdrawBalance, 0),
            maxOnChainWithdraw
          );
          const transferAmount = actualWithdrawAmount > 0.001 ? actualWithdrawAmount : maxOnChainWithdraw;

          if (transferAmount > 0.001) {
            const withdrawMist = BigInt(Math.floor(transferAmount * 1e9));
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
              const remainingBalance = Math.max(0, withdrawBalance - transferAmount);
              await storage.updateAgent(id, { balance: remainingBalance });
              console.log(`[RemoveCollateral] Transferred ${transferAmount.toFixed(4)} SUI to ${toAddress} for ${updatedAgent.name} (tx: ${result.digest}, remaining: ${remainingBalance.toFixed(4)})`);

              await storage.createVerifiedTransaction({
                txDigest: result.digest,
                txType: "remove_collateral",
                agentId: id,
                userId: updatedAgent.userId,
                sender: updatedAgent.walletAddress,
                checkpoint: null,
                rawData: { amount: transferAmount, toAddress, closedPositions: closedCount },
              }).catch(() => {});
            } else {
              console.error(`[RemoveCollateral] On-chain transfer failed for ${updatedAgent.name}, keeping balance intact`);
            }
          } else {
            console.log(`[RemoveCollateral] No withdrawable balance for ${updatedAgent.name} (on-chain: ${onChainBalance.sui.toFixed(4)} SUI, gas needed)`);
            if (onChainBalance.sui < 0.01) {
              await storage.updateAgent(id, { balance: 0 });
            }
          }
        } catch (withdrawErr: any) {
          console.error(`[RemoveCollateral] Withdraw error for ${updatedAgent.name}: ${withdrawErr.message}, keeping balance intact`);
        }
      } else if (withdrawBalance <= 0) {
        await storage.updateAgent(id, { balance: 0 });
      }

      const finalAgent = await storage.getAgent(id);
      broadcast("agent:updated", sanitizeAgent(finalAgent));

      const withdrawSucceeded = txDigest !== null;
      const finalBalance = (await storage.getAgent(id))?.balance ?? 0;

      res.json({
        success: true,
        closedPositions: closedCount,
        totalRealizedPnl,
        returnedCollateral,
        withdrawnAmount: withdrawSucceeded ? withdrawBalance : 0,
        txDigest,
        agentStatus: "idle",
        remainingBalance: finalBalance,
        withdrawFailed: !withdrawSucceeded && withdrawBalance > 0,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to remove collateral" });
    }
  });

  app.post("/api/agents/:id/close-position/:positionId", async (req, res) => {
    try {
      const { id, positionId } = req.params;
      const walletAddress = req.query.wallet as string || req.body.walletAddress;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required. Connect your wallet." });
      }

      const agent = await storage.getAgent(id);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === agent.userId;
      const isCreator = agent.walletAddress && agent.walletAddress.toLowerCase() === walletAddress.toLowerCase();
      const agentDeposits = await storage.getDepositsByAgent(id);
      const isDepositor = agentDeposits.some(d => d.depositorAddress.toLowerCase() === walletAddress.toLowerCase());

      if (!isOwner && !isCreator && !isDepositor) {
        return res.status(403).json({ message: "Only the agent owner or depositor can close positions." });
      }

      const lastPrice = getLastPrice();
      const currentPrice = lastPrice?.pyth?.price ?? lastPrice?.blended ?? 0;
      if (currentPrice <= 0) {
        return res.status(400).json({ message: "Cannot determine current market price. Try again shortly." });
      }

      const result = await closePositionForAgent(agent, positionId, currentPrice, true);
      if (!result.closed) {
        let errorMsg = "Position could not be closed. It may already be closed or not found.";
        if (result.error?.includes("INSUFFICIENT_GAS")) {
          errorMsg = "Insufficient gas in agent wallet to close position on-chain. Please deposit more SUI.";
        } else if (result.error?.includes("oracle")) {
          errorMsg = "Oracle price mismatch — please try again in a few seconds.";
        } else if (result.error?.includes("still on-chain")) {
          errorMsg = "Position exists on-chain but is missing tracking data. Please try again or contact support.";
        }
        return res.status(400).json({ message: errorMsg });
      }

      const updatedAgent = await storage.getAgent(id);
      broadcast("agent:updated", sanitizeAgent(updatedAgent));

      res.json({
        success: true,
        onChain: result.onChain,
        pnl: result.pnl,
        txDigest: result.txDigest || null,
        closedAt: new Date().toISOString(),
        newBalance: updatedAgent?.balance ?? 0,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to close position" });
    }
  });

  app.get("/api/wallet/:address/summary", async (req, res) => {
    try {
      const { address } = req.params;
      if (!address || !address.startsWith("0x")) {
        return res.status(400).json({ message: "Invalid SUI address" });
      }

      const walletDeposits = await storage.getDepositsByWallet(address);
      const allDeposits = walletDeposits;

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
      if (allDeposits.length > 0) {
        for (const d of allDeposits) {
          totalDepositedGross += d.grossAmount;
          totalDepositedNet += d.amount;
          totalFeesPaid += d.protocolFee;
        }
      } else {
        for (const agentId of myAgentIds) {
          const agent = allAgents.find(a => a.id === agentId);
          if (agent) {
            totalDepositedGross += agent.totalDeposited || 0;
            totalDepositedNet += (agent.totalDeposited || 0) - (agent.protocolFeePaid || 0);
            totalFeesPaid += agent.protocolFeePaid || 0;
          }
        }
      }

      let totalLockedCollateral = 0;
      let totalFreeBalance = 0;
      let totalRealizedPnl = 0;
      let totalUnrealizedPnl = 0;
      let openPositionCount = 0;
      let closedPositionCount = 0;

      for (const agentId of myAgentIds) {
        const agent = allAgents.find(a => a.id === agentId);
        if (!agent) continue;

        const allPositions = await storage.getPositions(agentId);
        let agentLockedCollateral = 0;
        for (const p of allPositions) {
          if (p.status === "open") {
            const collateral = p.sizeSui / (agent.leverage || 1);
            agentLockedCollateral += collateral;
            totalLockedCollateral += collateral;
            totalUnrealizedPnl += p.unrealizedPnl || 0;
            openPositionCount++;
          } else if (p.status === "closed") {
            closedPositionCount++;
          }
        }

        let agentBalance = Math.max(0, agent.balance);
        if (agent.walletAddress) {
          try {
            const onChain = await getOnChainBalance(agent.walletAddress);
            const onChainTotal = onChain.sui + agentLockedCollateral;
            if (Math.abs(agentBalance - onChainTotal) > 0.1) {
              agentBalance = onChainTotal;
            }
          } catch (e) {}
        }
        totalFreeBalance += Math.max(0, agentBalance - agentLockedCollateral);
        totalRealizedPnl += agent.totalPnl || 0;
      }

      const myRewards = allRewards.filter(r => myAgentIds.includes(r.agentId));
      const claimedRewards = myRewards.filter(r => r.status === "claimed");
      const pendingRewards = myRewards.filter(r => r.status === "pending");
      const totalClaimedVerified = claimedRewards.reduce((s, r) => s + r.amount, 0);
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
        verifiedOpenPositions: openPositionCount,
        verifiedClosedPositions: closedPositionCount,
        depositsCount: allDeposits.length,
        claimsCount: claimedRewards.length,
        agentIds: myAgentIds,
        deposits: allDeposits.slice(0, 20).map(d => ({
          agentId: d.agentId,
          amount: d.amount,
          grossAmount: d.grossAmount,
          fee: d.protocolFee,
          txDigest: d.txDigest,
          date: d.createdAt,
        })),
        claims: claimedRewards.slice(0, 20).map(r => ({
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
    let rewardWallet = "";
    try { rewardWallet = getRewardWalletAddress(); } catch {}
    res.json({
      feeRate: PROTOCOL_FEE_RATE,
      feeAddress: PROTOCOL_FEE_ADDRESS,
      rewardWallet,
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

      let rewardWalletAddress = "";
      let rewardWalletBalance = 0;
      try {
        rewardWalletAddress = getRewardWalletAddress();
        const bal = await getRewardWalletBalance();
        rewardWalletBalance = bal.sui;
      } catch {}

      res.json({
        protocolWallet: PROTOCOL_FEE_ADDRESS,
        rewardWallet: rewardWalletAddress,
        rewardWalletBalance,
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
      const allRewards = (await storage.getRewards()).filter(r => r.status !== "voided");
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
      const activeRewards = allRewards.filter((r) => r.status !== "voided");
      const pendingRewards = activeRewards.filter((r) => r.status === "pending");
      const claimedRewards = activeRewards.filter((r) => r.status === "claimed");
      const totalPending = pendingRewards.reduce((sum, r) => sum + r.amount, 0);
      const totalClaimed = claimedRewards.reduce((sum, r) => sum + r.amount, 0);

      const verifiableRewards = [...pendingRewards, ...claimedRewards];

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
      const { txDigest: authTxDigest, walletAddress } = req.body;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required to claim rewards" });
      }
      if (!authTxDigest || typeof authTxDigest !== "string") {
        return res.status(400).json({ message: "Wallet authorization transaction required" });
      }

      const authResult = await verifyTxDigest(authTxDigest);
      if (!authResult.sender || authResult.sender.toLowerCase() !== walletAddress.toLowerCase()) {
        return res.status(403).json({ message: "Authorization transaction sender does not match your wallet." });
      }

      const allRewards = await storage.getRewards();
      const reward = allRewards.find((r) => r.id === id);
      if (!reward) {
        return res.status(404).json({ message: "Reward not found" });
      }

      if (reward.status === "claimed") {
        return res.status(400).json({ message: "Reward already claimed" });
      }

      const agent = await storage.getAgent(reward.agentId);
      if (!agent) {
        return res.status(400).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const isOwner = user && user.id === agent.userId;
      const deposits = await storage.getDepositsByAgent(agent.id);
      const isDepositor = deposits.some(d => d.depositorAddress.toLowerCase() === walletAddress.toLowerCase());

      if (!isOwner && !isDepositor) {
        return res.status(403).json({ message: "Only the agent creator or depositor can claim rewards" });
      }

      const transferResult = await transferRewardToUser(walletAddress, reward.amount);

      const claimed = await storage.claimReward(id, transferResult.txDigest, authResult.checkpoint);

      await storage.createVerifiedTransaction({
        txDigest: transferResult.txDigest,
        txType: "reward_claim",
        agentId: agent.id,
        userId: agent.userId,
        sender: getRewardWalletAddress(),
        checkpoint: null,
        rawData: { amount: reward.amount, toAddress: walletAddress, authTxDigest, type: "reward_claim", fromRewardWallet: true },
      }).catch(() => {});

      res.json({ ...claimed, transferTxDigest: transferResult.txDigest, transferredAmount: reward.amount });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to claim reward" });
    }
  });

  app.post("/api/rewards/claim-all", async (req, res) => {
    try {
      const { txDigest: authTxDigest, walletAddress } = req.body;

      if (!walletAddress) {
        return res.status(401).json({ message: "Wallet address required to claim rewards" });
      }
      if (!authTxDigest || typeof authTxDigest !== "string") {
        return res.status(400).json({ message: "Wallet authorization transaction required" });
      }

      const authResult = await verifyTxDigest(authTxDigest);
      if (!authResult.sender || authResult.sender.toLowerCase() !== walletAddress.toLowerCase()) {
        return res.status(403).json({ message: "Authorization transaction sender does not match your wallet." });
      }

      const allRewards = await storage.getRewards();
      const pendingRewards = allRewards.filter((r) => r.status === "pending");

      if (pendingRewards.length === 0) {
        return res.status(400).json({ message: "No pending rewards to claim" });
      }

      const authorizedRewards: typeof pendingRewards = [];
      for (const reward of pendingRewards) {
        const agent = await storage.getAgent(reward.agentId);
        if (!agent) continue;

        const user = await storage.getUserByWallet(walletAddress);
        const isOwner = user && user.id === agent.userId;
        const deposits = await storage.getDepositsByAgent(agent.id);
        const isDepositor = deposits.some(d => d.depositorAddress.toLowerCase() === walletAddress.toLowerCase());

        if (isOwner || isDepositor) {
          authorizedRewards.push(reward);
        }
      }

      if (authorizedRewards.length === 0) {
        return res.status(403).json({ message: "No rewards found for your wallet" });
      }

      const totalAmount = authorizedRewards.reduce((sum, r) => sum + r.amount, 0);

      const transferResult = await transferRewardToUser(walletAddress, totalAmount);

      let totalClaimed = 0;
      for (const reward of authorizedRewards) {
        await storage.claimReward(reward.id, transferResult.txDigest, authResult.checkpoint);
        totalClaimed++;
      }

      await storage.createVerifiedTransaction({
        txDigest: transferResult.txDigest,
        txType: "reward_claim",
        agentId: authorizedRewards[0].agentId,
        userId: authorizedRewards[0].userId,
        sender: getRewardWalletAddress(),
        checkpoint: null,
        rawData: { amount: totalAmount, toAddress: walletAddress, authTxDigest, type: "reward_claim_all", rewardCount: totalClaimed, fromRewardWallet: true },
      }).catch(() => {});

      res.json({
        success: true,
        claimed: totalClaimed,
        totalTransferred: totalAmount,
        transferTxDigest: transferResult.txDigest,
        transfers: [{ txDigest: transferResult.txDigest, amount: totalAmount, rewardsClaimed: totalClaimed }],
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to claim all rewards" });
    }
  });

  app.post("/api/admin/fix-corrupted-data", async (_req, res) => {
    try {
      const allAgents = await storage.getAgents();
      const allRewards = await storage.getRewards();
      const results: any[] = [];

      for (const agent of allAgents) {
        const positions = await storage.getPositions(agent.id);
        const closedPositions = positions.filter(p => p.status === "closed");

        const bogusPositions = closedPositions.filter(p => p.markPrice !== null && p.markPrice > 1.5);

        if (bogusPositions.length === 0) continue;

        for (const pos of bogusPositions) {
          await storage.updatePosition(pos.id, {
            markPrice: pos.entryPrice,
            unrealizedPnl: 0,
          });
        }

        const agentRewards = allRewards.filter(r => r.agentId === agent.id);
        let voidedCount = 0;
        let resetCount = 0;

        for (const reward of agentRewards) {
          if (reward.amount > 5 && bogusPositions.length > 0) {
            await storage.voidReward(reward.id);
            voidedCount++;
          } else if (reward.status === "claimed" && reward.amount <= 5) {
            const hasRealTransfer = reward.txDigest ?
              (await storage.getVerifiedTransactionByDigest(reward.txDigest))?.txType === "reward_claim" : false;
            if (!hasRealTransfer) {
              await storage.resetRewardToPending(reward.id);
              resetCount++;
            }
          }
        }

        let recalcPnl = 0;
        let wins = 0;
        const freshPositions = await storage.getPositions(agent.id);
        const freshClosed = freshPositions.filter(p => p.status === "closed");
        for (const pos of freshClosed) {
          const collateral = pos.sizeSui / agent.leverage;
          const cappedPnl = Math.max(-collateral, pos.unrealizedPnl || 0);
          recalcPnl += cappedPnl;
          if (cappedPnl > 0) wins++;
        }

        const totalTrades = freshPositions.length;
        const winRate = freshClosed.length > 0 ? wins / freshClosed.length : 0;

        await storage.updateAgent(agent.id, {
          totalPnl: recalcPnl,
          totalTrades,
          winRate,
          balance: Math.max(0, agent.balance),
        });

        results.push({
          agentId: agent.id,
          name: agent.name,
          bogusPositionsFixed: bogusPositions.length,
          rewardsVoided: voidedCount,
          rewardsReset: resetCount,
          newPnl: recalcPnl,
          oldPnl: agent.totalPnl,
          newBalance: Math.max(0, agent.balance),
        });
      }

      res.json({ success: true, results });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to fix corrupted data" });
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
      const allExecutions = await storage.getBundleExecutions();
      const execMap = new Map(allExecutions.map(e => [e.bundleId, e]));
      const enriched = bundles.map(b => ({
        ...b,
        executionError: execMap.get(b.bundleId)?.error || null,
        executionTxDigest: execMap.get(b.bundleId)?.txDigest || null,
      }));
      res.json(enriched);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/bundles/:agentId/latest", async (req, res) => {
    try {
      const agentId = req.params.agentId;
      const bundles = await storage.getInstructionBundles(agentId);
      const executions = await storage.getBundleExecutions(agentId);
      const execMap = new Map(executions.map(e => [e.bundleId, e]));
      const enriched = bundles.map(b => ({
        ...b,
        executionError: execMap.get(b.bundleId)?.error || null,
        executionTxDigest: execMap.get(b.bundleId)?.txDigest || null,
      }));
      res.json(enriched);
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
        verified: true,
        checkpoint: checkpoint ?? null,
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

  app.post("/api/recovery/by-wallet", async (req, res) => {
    try {
      const { walletAddress } = req.body;
      if (!walletAddress || typeof walletAddress !== "string") {
        return res.status(400).json({ message: "walletAddress is required" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      const walletAgents = user ? await storage.getAgents(user.id) : [];

      const recoveryItems: Array<{
        agentId: string;
        agentName: string;
        agentWallet: string;
        dbBalance: number;
        onChainBalance: number;
        difference: number;
        status: string;
        recoverable: boolean;
      }> = [];

      for (const agent of walletAgents) {
        if (!agent.walletAddress) continue;
        try {
          const onChain = await getOnChainBalance(agent.walletAddress);
          const diff = onChain.sui - agent.balance;
          recoveryItems.push({
            agentId: agent.id,
            agentName: agent.name,
            agentWallet: agent.walletAddress,
            dbBalance: agent.balance,
            onChainBalance: onChain.sui,
            difference: diff,
            status: agent.status,
            recoverable: diff > 0.001,
          });
        } catch {
          recoveryItems.push({
            agentId: agent.id,
            agentName: agent.name,
            agentWallet: agent.walletAddress || "",
            dbBalance: agent.balance,
            onChainBalance: -1,
            difference: 0,
            status: agent.status,
            recoverable: false,
          });
        }
      }

      const totalDbBalance = recoveryItems.reduce((s, r) => s + r.dbBalance, 0);
      const totalOnChain = recoveryItems.filter(r => r.onChainBalance >= 0).reduce((s, r) => s + r.onChainBalance, 0);
      const totalRecoverable = recoveryItems.filter(r => r.recoverable).reduce((s, r) => s + r.difference, 0);

      res.json({
        walletAddress,
        agentCount: recoveryItems.length,
        items: recoveryItems,
        totals: {
          dbBalance: totalDbBalance,
          onChainBalance: totalOnChain,
          recoverable: totalRecoverable,
        },
      });
    } catch (e: any) {
      res.status(500).json({ message: `Recovery scan failed: ${e.message}` });
    }
  });

  app.post("/api/recovery/sync-balance", async (req, res) => {
    try {
      const { agentId, walletAddress } = req.body;
      if (!agentId || !walletAddress) {
        return res.status(400).json({ message: "agentId and walletAddress are required" });
      }

      const agent = await storage.getAgent(agentId);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }

      const user = await storage.getUserByWallet(walletAddress);
      if (!user || agent.userId !== user.id) {
        return res.status(403).json({ message: "Only the agent owner can sync balances" });
      }

      if (!agent.walletAddress) {
        return res.status(400).json({ message: "Agent has no wallet address" });
      }

      const onChain = await getOnChainBalance(agent.walletAddress);
      const diff = onChain.sui - agent.balance;

      if (diff <= 0.001) {
        return res.status(400).json({ message: "No recoverable balance difference found" });
      }

      await storage.updateAgent(agentId, { balance: onChain.sui });

      res.json({
        success: true,
        agentId,
        agentName: agent.name,
        previousBalance: agent.balance,
        newBalance: onChain.sui,
        recovered: diff,
        message: `Synced agent balance: ${agent.balance.toFixed(4)} -> ${onChain.sui.toFixed(4)} SUI (+${diff.toFixed(4)} recovered)`,
      });
    } catch (e: any) {
      res.status(500).json({ message: `Balance sync failed: ${e.message}` });
    }
  });

  const usedWithdrawAuthDigests: Record<string, { wallet: string; usedAt: number }> = {};
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    Object.keys(usedWithdrawAuthDigests).forEach(k => {
      if (usedWithdrawAuthDigests[k].usedAt < cutoff) delete usedWithdrawAuthDigests[k];
    });
  }, 60_000);

  app.post("/api/recovery/withdraw-to-wallet", async (req, res) => {
    try {
      const { agentId, walletAddress, authTxDigest } = req.body;
      if (!agentId || !walletAddress || !authTxDigest) {
        return res.status(400).json({ message: "agentId, walletAddress, and authTxDigest are required" });
      }

      const authResult = await verifyTxDigest(authTxDigest);
      if (!authResult.sender || authResult.sender.toLowerCase() !== walletAddress.toLowerCase()) {
        return res.status(403).json({ message: "Authorization transaction sender does not match your wallet address." });
      }

      const existingUse = usedWithdrawAuthDigests[authTxDigest];
      if (existingUse && existingUse.wallet.toLowerCase() !== walletAddress.toLowerCase()) {
        return res.status(403).json({ message: "Authorization digest already used by a different wallet." });
      }

      if (authResult.timestampMs) {
        const ageMs = Date.now() - authResult.timestampMs;
        if (ageMs > 5 * 60 * 1000) {
          return res.status(403).json({ message: "Authorization transaction is too old (>5 min). Please try again." });
        }
      }

      usedWithdrawAuthDigests[authTxDigest] = { wallet: walletAddress, usedAt: Date.now() };

      const agent = await storage.getAgent(agentId);
      if (!agent) return res.status(404).json({ message: "Agent not found" });

      const user = await storage.getUserByWallet(walletAddress);
      if (!user || agent.userId !== user.id) {
        return res.status(403).json({ message: "Only the agent owner can withdraw" });
      }

      if (!agent.agentWallet || !agent.walletAddress) {
        return res.status(400).json({ message: "Agent wallet not configured" });
      }

      if (agent.status === "recovered") {
        return res.status(400).json({ message: "Cannot withdraw from a recovered agent — the original signing keys were lost." });
      }

      const openPositions = (await storage.getPositions(agentId)).filter(p => p.status === "open");
      
      // If user wants to "remove all collateral", they need to close positions first.
      // We already have a close-position logic in market-engine or routes.
      // But the user specifically asked to "Make the agent close all order to remove all collateral"
      // This implies we should trigger an emergency close if they try to withdraw and have positions.
      
      if (openPositions.length > 0) {
        const { closePositionForAgent } = await import("./dex/execution-engine");
        const { getLastPrice } = await import("./price-service");
        console.log(`[Withdraw] Emergency closing ${openPositions.length} positions for ${agent.name} to free collateral`);
        
        const priceTick = getLastPrice();
        const currentPrice = priceTick?.pyth?.price ?? priceTick?.blended ?? 0;
        if (currentPrice <= 0) {
          return res.status(500).json({ message: "Cannot close positions: no current price available. Try again shortly." });
        }
        for (const pos of openPositions) {
          try {
            await closePositionForAgent(agent, pos.id, currentPrice);
            console.log(`[Withdraw] Successfully closed position ${pos.id} on-chain`);
          } catch (e: any) {
            console.warn(`[Withdraw] On-chain close failed for position ${pos.id}: ${e.message}. Marking as closed in DB to proceed with withdrawal.`);
            const realizedPnl = pos.side === "long"
              ? (currentPrice - pos.entryPrice) * pos.sizeSui / currentPrice
              : (pos.entryPrice - currentPrice) * pos.sizeSui / currentPrice;
            await storage.updatePosition(pos.id, {
              status: "closed",
              markPrice: currentPrice,
              unrealizedPnl: realizedPnl,
              closedAt: new Date(),
            });
          }
        }
      }

      // Re-fetch balance after closing positions
      const onChainBalance = await getOnChainBalance(agent.walletAddress);
      const gasBudget = BigInt(10_000_000);
      const gasReserveSui = 0.05; // Reduced reserve for total withdrawal
      const availableOnChain = Math.max(0, (Number(onChainBalance.mist) - Number(gasBudget)) / 1e9);
      const maxWithdraw = Math.max(0, availableOnChain - gasReserveSui);

      const withdrawMist = BigInt(Math.floor(maxWithdraw * 1e9));
      const { decryptKeypair } = await import("./dex/wallet-manager");
      const { Transaction } = await import("@mysten/sui/transactions");
      const keypair = decryptKeypair(agent.agentWallet);

      const tx = new Transaction();
      tx.setSender(agent.walletAddress);
      tx.setGasBudget(gasBudget);
      const [coin] = tx.splitCoins(tx.gas, [withdrawMist]);
      tx.transferObjects([coin], walletAddress);

      const { suiClient } = await import("./sui-verify");
      const result = await suiClient.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true },
      });

      if (result.effects?.status?.status !== "success") {
        return res.status(500).json({ message: "On-chain withdrawal transaction failed" });
      }

      const newBalance = Math.max(0, (agent.balance ?? 0) - maxWithdraw);
      await storage.updateAgent(agentId, { balance: newBalance });

      await storage.createVerifiedTransaction({
        txDigest: result.digest,
        txType: "recovery_withdraw",
        agentId,
        userId: agent.userId,
        sender: agent.walletAddress,
        checkpoint: null,
        rawData: { amount: maxWithdraw, toAddress: walletAddress },
      }).catch(() => {});

      broadcast("agent:updated", sanitizeAgent(await storage.getAgent(agentId)));

      res.json({
        success: true,
        txDigest: result.digest,
        amount: maxWithdraw,
        agentName: agent.name,
        message: `Withdrew ${maxWithdraw.toFixed(4)} SUI to your wallet`,
      });
    } catch (e: any) {
      res.status(500).json({ message: `Recovery withdrawal failed: ${e.message}` });
    }
  });

  app.post("/api/admin/cleanup-orphaned-agents", async (req, res) => {
    try {
      const allAgents = await storage.getAgents();
      const orphaned = allAgents.filter(a => a.userId === "default-user" || !a.userId);
      let deleted = 0;
      for (const agent of orphaned) {
        if (agent.status === "running") {
          await storage.updateAgent(agent.id, { status: "idle" });
        }
        await storage.deleteAgent(agent.id);
        deleted++;
      }
      broadcast("agents:refresh", {});
      res.json({ success: true, deleted, agentIds: orphaned.map(a => ({ id: a.id, name: a.name })) });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Cleanup failed" });
    }
  });

  return httpServer;
}
