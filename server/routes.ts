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
import { generateAgentWallet } from "./dex/wallet-manager";
import { getThrottledSuiClient } from "./rpc-throttle";

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

      const existing = await db.select().from(agents).where(eq(agents.userId, userId)).limit(1);
      if (existing.length > 0) {
        return res.status(409).json({ error: "agent_already_exists", agent: existing[0] });
      }

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
