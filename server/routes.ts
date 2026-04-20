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
  insertAgentSchema,
} from "../shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { z } from "zod";

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
      const rows = wallet
        ? await db.select().from(agents).where(eq(agents.userId, wallet)).orderBy(desc(agents.createdAt))
        : await db.select().from(agents).orderBy(desc(agents.createdAt));
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
  });

  app.patch("/api/agents/:id", async (req, res) => {
    try {
      const parsed = updateAgentSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });

      const update: Record<string, any> = {};
      if (parsed.data.status !== undefined) update.status = parsed.data.status;
      if (parsed.data.autoTrade !== undefined) update.autoTrade = parsed.data.autoTrade;
      if (parsed.data.name !== undefined) update.name = parsed.data.name;

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
