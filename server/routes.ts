import type { Express } from "express";
import type { Server } from "http";
import {
  getAllMarkets, getMarketsWithOutcomes, getTodaySignals, getSignalById,
  getRecentAlerts, createAlert, getSettings, updateSettings, getMarketSnapshots,
} from "./storage";
import { refreshAllMarkets, refreshSignals } from "./services/scheduler";
import { fetchAllCryptoPrices } from "./services/cryptoMarketData";

export async function registerRoutes(httpServer: Server, app: Express): Promise<void> {

  // ── Markets ──────────────────────────────────────────────────────────────
  app.get("/api/markets", async (_req, res) => {
    try {
      const data = await getMarketsWithOutcomes();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/markets/crypto", async (_req, res) => {
    try {
      const data = await getMarketsWithOutcomes("crypto");
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/markets/sports", async (req, res) => {
    try {
      const sport = req.query.sport as string | undefined;
      const all = await getMarketsWithOutcomes("sports");
      const data = sport ? all.filter(m => m.sport === sport) : all;
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/markets/:id/snapshots", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const data = await getMarketSnapshots(id, 30);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Signals ──────────────────────────────────────────────────────────────
  app.get("/api/signals/today", async (_req, res) => {
    try {
      const data = await getTodaySignals();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/signals/top", async (_req, res) => {
    try {
      const data = await getTodaySignals();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/signals/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const data = await getSignalById(id);
      if (!data) return res.status(404).json({ message: "Signal not found" });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Alerts ───────────────────────────────────────────────────────────────
  app.get("/api/alerts", async (_req, res) => {
    try {
      const data = await getRecentAlerts(30);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/alerts/test", async (_req, res) => {
    try {
      const alert = await createAlert({
        alertType: "test",
        message: "Test alert — Blue Water Predictions notification system working.",
      });
      res.json(alert);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Settings ─────────────────────────────────────────────────────────────
  app.get("/api/settings", async (_req, res) => {
    try {
      const data = await getSettings();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/settings", async (req, res) => {
    try {
      const { bankrollAmount, emailNotifications, minConfidenceAlert } = req.body;
      const data = await updateSettings({ bankrollAmount, emailNotifications, minConfidenceAlert });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Crypto Prices ────────────────────────────────────────────────────────
  app.get("/api/crypto/prices", async (_req, res) => {
    try {
      const prices = await fetchAllCryptoPrices();
      res.json(prices);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Manual Refresh ───────────────────────────────────────────────────────
  app.post("/api/markets/refresh", async (_req, res) => {
    try {
      await refreshAllMarkets();
      await refreshSignals();
      const signals = await getTodaySignals();
      res.json({ success: true, signalCount: signals.length });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });
}
