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

export async function registerRoutes(httpServer: Server, app: Express): Promise<void> {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  priceBus.on("price", (tick: any) => {
    const msg = JSON.stringify({ type: "price", data: tick });
    wss.clients.forEach((c) => {
      if (c.readyState === 1) c.send(msg);
    });
  });
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
      const trades = await journal.getRecent(limit);
      res.json(trades);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/engine/summary", async (_req, res) => {
    try {
      const summary = await journal.summarize(100);
      res.json(summary);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
