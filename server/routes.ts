import type { Express } from "express";
import type { Server } from "http";
import { WebSocketServer } from "ws";
import { priceBus, getLastPrice } from "./price-service";
import { getCandleHistory, getMarketState } from "./market-engine";
import {
  getEngineState,
  setEngineEnabled,
  journal,
  getLastScanDecision,
  manualClosePosition,
  resetDailyCounters,
  executionService,
  clearCurrentTrade,
} from "./engine/trading-engine";
import { db } from "./db";
import {
  agents,
  rewards,
  users,
  breakoutTrades,
  deposits,
  insertAgentSchema,
} from "../shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { generateAgentWallet, decryptKeypair } from "./dex/wallet-manager";
import { getThrottledSuiClient } from "./rpc-throttle";
import { Transaction } from "@mysten/sui/transactions";
import { TypusAdapter } from "./dex/typus-adapter";

export async function registerRoutes(httpServer: Server, app: Express): Promise<void> {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  priceBus.on("price", (tick: any) => {
    const msg = JSON.stringify({ type: "price", data: tick });
    wss.clients.forEach((c) => {
      if (c.readyState === 1) c.send(msg);
    });
  });

  // ── Market ──────────────────────────────────────────────────────────────────
  app.get("/api/market/price", (_req, res) => {
    const p = getLastPrice();
    if (!p) return res.status(503).json({ error: "price_unavailable" });
    res.json(p);
  });

  app.get("/api/market/candles", (_req, res) => {
    res.json(getCandleHistory());
  });

  app.get("/api/market/state", (_req, res) => {
    res.json(getMarketState());
  });

  // ── Engine ───────────────────────────────────────────────────────────────────
  app.get("/api/engine/state", async (_req, res) => {
    try {
      const state = await getEngineState();
      const scanDecision = getLastScanDecision();
      res.json({ state, scanDecision });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/engine/toggle", async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be boolean" });
      }
      await setEngineEnabled(enabled);
      res.json({ ok: true, enabled });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/engine/reset-daily-counters", async (_req, res) => {
    try {
      await resetDailyCounters();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/engine/trades", async (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
      const agentId = req.query.agentId as string | undefined;
      const trades = await journal.getRecent(limit, agentId);
      res.json(trades);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/engine/summary", async (req, res) => {
    try {
      const agentId = req.query.agentId as string | undefined;
      const summary = await journal.summarize(100, agentId);
      res.json(summary);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Agents ───────────────────────────────────────────────────────────────────
  app.get("/api/agents", async (req, res) => {
    try {
      const wallet = req.query.wallet as string | undefined;
      let rows = wallet
        ? await db.select().from(agents).where(eq(agents.userId, wallet)).orderBy(desc(agents.createdAt))
        : await db.select().from(agents).orderBy(desc(agents.createdAt));

      // Auto-provision wallets for agents created before wallet generation was added
      const missingWallet = rows.filter(a => !a.walletAddress);
      if (missingWallet.length > 0) {
        const updated = await Promise.all(missingWallet.map(async (a) => {
          const w = generateAgentWallet();
          const [upd] = await db.update(agents)
            .set({ walletAddress: w.address, agentWallet: w.encryptedPrivateKey })
            .where(eq(agents.id, a.id))
            .returning();
          return upd;
        }));
        const updatedIds = new Set(updated.map(a => a.id));
        rows = [...rows.filter(a => !updatedIds.has(a.id)), ...updated].sort(
          (a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime()
        );
      }

      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/agents/:id", async (req, res) => {
    try {
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent) return res.status(404).json({ error: "not_found" });
      res.json(agent);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const createAgentSchema = z.object({
    name: z.string().min(2).max(40),
    userId: z.string().min(10),
  });

  app.post("/api/agents", async (req, res) => {
    try {
      const parsed = createAgentSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });

      const { name, userId } = parsed.data;

      const agentWalletData = generateAgentWallet();

      const [created] = await db.insert(agents).values({
        name,
        userId,
        status: "idle",
        venue: "typus",
        leverage: 30,
        maxQty: 3.5,
        minCollateral: 3,
        maxCollateral: 4,
        stopLossBps: 35,
        takeProfitBps: 50,
        autoTrade: false,
        rewardSharePct: 10,
        balance: 0,
        totalDeposited: 0,
        protocolFeePaid: 0,
        totalPnl: 0,
        totalTrades: 0,
        winRate: 0,
        walletAddress: agentWalletData.address,
        agentWallet: agentWalletData.encryptedPrivateKey,
      }).returning();

      res.status(201).json(created);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const updateAgentSchema = z.object({
    status: z.enum(["idle", "active"]).optional(),
    autoTrade: z.boolean().optional(),
    name: z.string().min(2).max(40).optional(),
    leverage: z.number().int().min(1).max(50).optional(),
    minCollateral: z.number().min(0.5).max(50).optional(),
    maxCollateral: z.number().min(0.5).max(100).optional(),
    stopLossBps: z.number().int().min(10).max(500).optional(),
    takeProfitBps: z.number().int().min(10).max(2000).optional(),
    rewardSharePct: z.number().int().min(0).max(50).optional(),
  });

  app.patch("/api/agents/:id", async (req, res) => {
    try {
      const parsed = updateAgentSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });

      const update: Record<string, any> = {};
      if (parsed.data.status !== undefined) update.status = parsed.data.status;
      if (parsed.data.autoTrade !== undefined) update.autoTrade = parsed.data.autoTrade;
      if (parsed.data.name !== undefined) update.name = parsed.data.name;
      if (parsed.data.leverage !== undefined) update.leverage = parsed.data.leverage;
      if (parsed.data.minCollateral !== undefined) update.minCollateral = parsed.data.minCollateral;
      if (parsed.data.maxCollateral !== undefined) update.maxCollateral = parsed.data.maxCollateral;
      if (parsed.data.stopLossBps !== undefined) update.stopLossBps = parsed.data.stopLossBps;
      if (parsed.data.takeProfitBps !== undefined) update.takeProfitBps = parsed.data.takeProfitBps;
      if (parsed.data.rewardSharePct !== undefined) update.rewardSharePct = parsed.data.rewardSharePct;

      if (parsed.data.status === "active" || parsed.data.autoTrade === true) {
        await db.update(agents)
          .set({ status: "idle", autoTrade: false })
          .where(sql`${agents.id} != ${req.params.id}`);
      }

      const [updated] = await db.update(agents).set(update).where(eq(agents.id, req.params.id)).returning();
      if (!updated) return res.status(404).json({ error: "not_found" });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const depositSchema = z.object({
    txDigest: z.string().min(10),
    depositorAddress: z.string().min(10),
    amount: z.number().positive(),
  });

  app.post("/api/agents/:id/deposit", async (req, res) => {
    try {
      const parsed = depositSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });

      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent) return res.status(404).json({ error: "not_found" });

      const { txDigest, depositorAddress, amount } = parsed.data;

      // Prevent double-crediting the same tx
      const existing = await db.select().from(deposits).where(eq(deposits.txDigest as any, txDigest)).limit(1);
      if (existing.length > 0) {
        return res.status(409).json({ error: "deposit_already_recorded" });
      }

      // Verify the transaction on-chain
      let verified = false;
      let onChainAmount = amount;
      try {
        const suiClient = getThrottledSuiClient();
        const txBlock = await suiClient.getTransactionBlock({
          digest: txDigest,
          options: { showEffects: true, showBalanceChanges: true },
        });

        const status = txBlock.effects?.status?.status;
        if (status !== "success") {
          return res.status(400).json({ error: "transaction_failed_on_chain" });
        }

        // Find the balance change going to the agent wallet
        if (agent.walletAddress && txBlock.balanceChanges) {
          const inflow = txBlock.balanceChanges.find(
            (bc: any) => bc.owner?.AddressOwner === agent.walletAddress &&
              bc.coinType === "0x2::sui::SUI" &&
              BigInt(bc.amount) > 0n
          );
          if (inflow) {
            onChainAmount = Number(BigInt(inflow.amount)) / 1_000_000_000;
            verified = true;
          }
        } else {
          // No walletAddress yet — trust the client amount but mark as unverified
          verified = false;
        }
      } catch (verifyErr: any) {
        console.error("[deposit] on-chain verify error:", verifyErr.message);
        return res.status(400).json({ error: "could_not_verify_transaction", detail: verifyErr.message });
      }

      const creditable = verified ? onChainAmount : amount;

      const [updatedAgent] = await db.update(agents)
        .set({
          balance: (agent.balance ?? 0) + creditable,
          totalDeposited: (agent.totalDeposited ?? 0) + creditable,
        })
        .where(eq(agents.id, req.params.id))
        .returning();

      await db.insert(deposits).values({
        agentId: req.params.id,
        depositorAddress,
        amount: creditable,
        grossAmount: amount,
        protocolFee: 0,
        txDigest,
        verified,
      });

      res.json({ ...updatedAgent, verifiedAmount: creditable });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Real on-chain SUI balance for an agent wallet
  app.get("/api/agents/:id/wallet-balance", async (req, res) => {
    try {
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent) return res.status(404).json({ error: "not_found" });
      if (!agent.walletAddress) return res.json({ balanceSui: 0, walletAddress: null });

      const suiClient = getThrottledSuiClient();
      const bal = await suiClient.getBalance({ owner: agent.walletAddress, coinType: "0x2::sui::SUI" });
      const balanceSui = Number(BigInt(bal.totalBalance)) / 1_000_000_000;
      res.json({ balanceSui, walletAddress: agent.walletAddress });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Withdraw SUI from agent wallet → user wallet (server-side signature)
  app.post("/api/agents/:id/withdraw", async (req, res) => {
    try {
      const { toAddress, amountSui } = req.body;
      if (!toAddress || !amountSui || amountSui <= 0) {
        return res.status(400).json({ error: "toAddress and amountSui required" });
      }
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent) return res.status(404).json({ error: "not_found" });
      if (!agent.agentWallet) return res.status(400).json({ error: "no_agent_wallet" });
      if (!agent.walletAddress) return res.status(400).json({ error: "no_wallet_address" });

      // Check live balance to avoid over-withdrawal
      const suiClient = getThrottledSuiClient();
      const bal = await suiClient.getBalance({ owner: agent.walletAddress, coinType: "0x2::sui::SUI" });
      const balSui = Number(BigInt(bal.totalBalance)) / 1e9;
      const GAS_RESERVE = 0.05; // keep 0.05 SUI for gas
      if (amountSui > balSui - GAS_RESERVE) {
        return res.status(400).json({ error: "insufficient_balance", available: balSui - GAS_RESERVE });
      }

      const keypair = decryptKeypair(agent.agentWallet);
      const mist = BigInt(Math.floor(amountSui * 1e9));

      const tx = new Transaction();
      const [coin] = tx.splitCoins(tx.gas, [mist]);
      tx.transferObjects([coin], toAddress);

      const result = await suiClient.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        options: { showEffects: true },
      });

      res.json({ txDigest: result.digest, amountSui });
    } catch (err: any) {
      console.error("[withdraw] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // List all on-chain open positions for an agent wallet
  app.get("/api/agents/:id/on-chain-positions", async (req, res) => {
    try {
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent) return res.status(404).json({ error: "not_found" });
      if (!agent.walletAddress) return res.json({ positions: [] });

      const adapter = new TypusAdapter();
      const onChainPositions = await adapter.getPositions(agent.walletAddress);
      res.json({ positions: onChainPositions, walletAddress: agent.walletAddress });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Close all on-chain positions that are NOT tracked by the engine (orphan recovery)
  app.post("/api/agents/:id/recover-orphaned", async (req, res) => {
    try {
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent) return res.status(404).json({ error: "not_found" });
      if (!agent.walletAddress || !agent.agentWallet) {
        return res.status(400).json({ error: "agent_wallet_not_configured" });
      }

      const adapter = new TypusAdapter();
      const engineState = await getEngineState();
      const trackedId = engineState?.currentTradeId ?? null;

      const onChainPositions = await adapter.getPositions(agent.walletAddress);
      if (!onChainPositions.length) {
        return res.json({ recovered: 0, message: "No on-chain positions found" });
      }

      // Identify orphans: positions on-chain that don't match the tracked trade
      const orphans = trackedId
        ? onChainPositions.filter(p => p.positionId !== trackedId)
        : onChainPositions;

      if (!orphans.length) {
        return res.json({ recovered: 0, message: "No orphaned positions — all on-chain positions are tracked" });
      }

      const results: { positionId: string; success: boolean; error?: string }[] = [];
      for (const pos of orphans) {
        try {
          // Get current oracle price for the close
          const priceRes = await fetch("https://hermes.pyth.network/v2/updates/price/latest?ids[]=0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744");
          const priceJson = await priceRes.json();
          const rawPrice = priceJson?.parsed?.[0]?.price;
          const oraclePrice = rawPrice
            ? Number(rawPrice.price) * Math.pow(10, rawPrice.expo)
            : pos.markPrice;

          const closeResult = await adapter.closePosition({
            agent,
            positionId: pos.positionId,
            side: pos.side,
            price: oraclePrice,
            isFirstAttempt: true,
          });
          results.push({ positionId: pos.positionId, success: closeResult.success, error: closeResult.error });
          console.log(`[RecoverOrphaned] agent=${agent.name} pos=${pos.positionId} side=${pos.side} → ${closeResult.success ? "CLOSED tx=" + closeResult.txDigest : "FAILED " + closeResult.error}`);
        } catch (closeErr: any) {
          results.push({ positionId: pos.positionId, success: false, error: closeErr.message });
        }
      }

      const succeeded = results.filter(r => r.success).length;
      res.json({
        recovered: succeeded,
        total: orphans.length,
        results,
        message: `Closed ${succeeded}/${orphans.length} orphaned positions`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manual close of open position at current market price
  app.post("/api/agents/:id/close-position", async (req, res) => {
    try {
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent) return res.status(404).json({ error: "not_found" });

      const result = await manualClosePosition(agent.id);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      res.json({ ok: true, exitPrice: result.exitPrice, pnlSui: result.pnlSui });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Force-close ALL live on-chain positions for this agent and reconcile the DB.
  // Use this when the regular close button fails or shows "untracked" state.
  app.post("/api/agents/:id/force-close-all-positions", async (req, res) => {
    try {
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent) return res.status(404).json({ error: "not_found" });
      if (!agent.walletAddress || !agent.agentWallet) {
        return res.status(400).json({ error: "agent_wallet_not_configured" });
      }

      // Close every live on-chain position (uses real on-chain IDs, not DB IDs)
      const closeResults = await executionService.forceCloseAllPositions(agent);

      // Reconcile DB: mark all open breakout_trades for this agent as closed
      const openRows = await db.select().from(breakoutTrades)
        .where(and(eq(breakoutTrades.agentId, agent.id), eq(breakoutTrades.status, "open")));

      const nowTs = Date.now();
      const priceTick = getLastPrice();
      const currentPrice = priceTick?.blended ?? priceTick?.pyth?.price ?? 0;

      for (const row of openRows) {
        const pnlRaw = row.side === "long" ? currentPrice - row.entryPrice : row.entryPrice - currentPrice;
        const pnlBps = row.entryPrice > 0 ? (pnlRaw / row.entryPrice) * 10000 : 0;
        const pnlSui = (row.collateralSui ?? 0) * (row.leverage ?? 1) * (pnlBps / 10000);
        await db.update(breakoutTrades)
          .set({
            status: "closed",
            exitReason: "force_close",
            exitTs: nowTs,
            exitPrice: currentPrice,
            pnlBps,
            pnlSui,
          })
          .where(eq(breakoutTrades.id, row.id));
      }

      // Clear engine state's currentTradeId so the engine can resume
      await clearCurrentTrade();

      const succeeded = closeResults.filter(r => r.success).length;
      console.log(`[ForceCloseAll] agent=${agent.name}: ${succeeded}/${closeResults.length} on-chain positions closed, ${openRows.length} DB records reconciled`);

      res.json({
        closedOnChain: succeeded,
        totalOnChain: closeResults.length,
        dbRecordsReconciled: openRows.length,
        results: closeResults,
        message: `Force-closed ${succeeded}/${closeResults.length} on-chain position(s) and reconciled ${openRows.length} DB record(s)`,
      });
    } catch (err: any) {
      console.error(`[ForceCloseAll] error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/agents/:id", async (req, res) => {
    try {
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent) return res.status(404).json({ error: "not_found" });
      await db.delete(agents).where(eq(agents.id, req.params.id));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Rewards ──────────────────────────────────────────────────────────────────
  app.get("/api/rewards/summary", async (req, res) => {
    try {
      const userId = req.query.userId as string | undefined;
      const rows = userId
        ? await db.select().from(rewards).where(eq(rewards.userId, userId)).orderBy(desc(rewards.createdAt))
        : await db.select().from(rewards).orderBy(desc(rewards.createdAt));

      const pending = rows.filter(r => r.status === "pending");
      const claimed = rows.filter(r => r.status === "claimed");

      res.json({
        totalPending: pending.reduce((s, r) => s + r.amount, 0),
        totalClaimed: claimed.reduce((s, r) => s + r.amount, 0),
        totalEarned: rows.reduce((s, r) => s + r.amount, 0),
        rewards: rows,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/rewards/claim-all", async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ error: "userId required" });
      await db.update(rewards)
        .set({ status: "claimed", claimedAt: new Date() })
        .where(and(eq(rewards.userId, userId), eq(rewards.status, "pending")));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/rewards/:id/claim", async (req, res) => {
    try {
      const [updated] = await db.update(rewards)
        .set({ status: "claimed", claimedAt: new Date() })
        .where(eq(rewards.id, req.params.id))
        .returning();
      if (!updated) return res.status(404).json({ error: "not_found" });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
