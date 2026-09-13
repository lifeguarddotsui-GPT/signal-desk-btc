import type { Express } from "express";
import type { Server } from "http";
import {
  getAllMarkets, getMarketsWithOutcomes, getTodaySignals, getSignalById,
  getRecentAlerts, createAlert, getSettings, updateSettings, getMarketSnapshots,
} from "./storage";
import { refreshAllMarkets, refreshSignals } from "./services/scheduler";
import { fetchAllCryptoPrices } from "./services/cryptoMarketData";
import { computeAllOracleMarkets } from "./services/coinbasePredictions";
import { getSuiDeepSignals } from "./services/suiDeepSignals";

export async function registerRoutes(httpServer: Server, app: Express): Promise<void> {
  app.get("/api/sui-deep/overview", async (_req, res) => {
    try {
      res.json(await getSuiDeepSignals());
    } catch (err: any) {
      res.status(503).json({ message: "Live market data is temporarily unavailable.", detail: err.message });
    }
  });

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
      const dateFilter = (req.query.dateFilter as string) || "today";
      const all = await getMarketsWithOutcomes("sports");

      const now = Date.now();
      // ET-based day boundaries (EDT = UTC-4 in summer, EST = UTC-5 in winter)
      // Midnight ET = 4:00 AM UTC (EDT) / 5:00 AM UTC (EST)
      // We compute the next ET midnight as the "end of today" boundary.
      const endOfETDay = (daysAhead: number): number => {
        const d = new Date(now);
        const utcH = d.getUTCHours();
        // EDT offset: -4h → midnight ET = 04:00 UTC. Use 4 for summer (May–Oct), 5 for winter.
        const etOffsetH = (d.getUTCMonth() >= 2 && d.getUTCMonth() <= 10) ? 4 : 5;
        // Current ET day starts at the most recent etOffsetH:00 UTC
        // "daysAhead" ET midnights forward
        const startOfCurrentETDay = new Date(Date.UTC(
          d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
          etOffsetH, 0, 0, 0
        ));
        // If we haven't yet passed today's ET midnight marker (i.e., we're in the pre-dawn UTC window)
        if (utcH < etOffsetH) startOfCurrentETDay.setUTCDate(startOfCurrentETDay.getUTCDate() - 1);
        return startOfCurrentETDay.getTime() + (daysAhead + 1) * 24 * 3600 * 1000;
      };
      const todayEnd    = endOfETDay(0);   // end of today in ET
      const tomorrowEnd = endOfETDay(1);   // end of tomorrow in ET

      const matchesDateFilter = (expirationTime: any): boolean => {
        if (!expirationTime) return true;
        const t = new Date(expirationTime).getTime();
        const recentStart = now - 6 * 3600 * 1000;  // events that started up to 6h ago (live/recently started)
        if (t < recentStart) return false;           // already over, skip
        // Use 28h "today" window to capture same-day US evening events (aligns with Daily Picks)
        if (dateFilter === "today")    return t <= now + 28 * 3600 * 1000;
        if (dateFilter === "tomorrow") return t > now + 12 * 3600 * 1000 && t <= now + 52 * 3600 * 1000;
        if (dateFilter === "week")     return t <= now + 7 * 24 * 3600 * 1000;
        return true;
      };

      const dated = all.filter(m => matchesDateFilter(m.expirationTime));
      const data = sport ? dated.filter(m => m.sport === sport) : dated;
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

  // ── Oracle Edge Markets ───────────────────────────────────────────────────
  app.get("/api/oracle/markets", async (_req, res) => {
    try {
      const markets = await computeAllOracleMarkets();
      res.json(markets);
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
