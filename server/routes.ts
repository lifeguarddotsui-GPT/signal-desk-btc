import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { healthResponse, historyResponse, live, modelResponse, predictionsResponse } from "./btc/service";
import { buildInfo } from "./btc/build-info";
import { accuracyExport, accuracyReport, type ExportCollection } from "./btc/reporting";
import {
  chartEventsAfter, chartReplayPlan, chartSeries, checkChartFreshness, GAP_AFTER_MS, latestChartEventId,
  subscribeChartEvents,
} from "./btc/chart";
import { comparisonSeriesCoverage, persistedComparisonArchive } from "./btc/chart-history";
import { getWaterxHistory, getWaterxLearning, getWaterxSettlementHealth } from "./waterx/learning";
import { getLiveWaterx, getWaterxDiagnostics } from "./waterx/service";
import type { WaterxInterval } from "./waterx/types";
import { waterxLatencyReport } from "./waterx/latency";
import { latestCandidateStatus } from "./waterx/candidate-status";

const defaults = { refreshSeconds: 5 };
const settingsSchema = z.object({
  refreshSeconds: z.union([z.literal(5),z.literal(10),z.literal(30)]),
}).strict();

function safe(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) =>
    void handler(req, res).catch(next);
}
function waterxInterval(req: Request, res: Response): WaterxInterval | null {
  const value = String(req.query.interval ?? "");
  if (value === "5" || value === "15") return Number(value) as WaterxInterval;
  res.status(400).json({ error: "interval must be 5 or 15 minutes." });
  return null;
}
export function registerRoutes(app: Express) {
  app.get("/health/live", (_req, res) => res.json({ status: "ok", readOnly: true }));
  app.get("/api/live", safe(async (_req, res) => {
    res.set("Cache-Control", "no-store").json(await live());
  }));
  app.get("/api/economics", safe(async (_req, res) => {
    res.status(503).set("Cache-Control", "no-store").json({
      status: "UNAVAILABLE",
      reason: "Executable WaterX quotes, fees, slippage, and net payouts have not been verified. No order economics are available.",
      marketId: null, expiryMs: null, up: null, down: null,
    });
  }));
  app.get("/api/waterx/live", safe(async (req, res) => {
    const interval = waterxInterval(req, res);
    if (!interval) return;
    // The shared collector refresh is bounded. Model queries cannot delay live prices.
    res.set("Cache-Control", "no-store").json(await getLiveWaterx(interval));
  }));
  app.get("/api/waterx/version", (_req, res) => {
    const build = buildInfo();
    res.set("Cache-Control", "no-store").json({
      build: {
        status: build.status, id: build.id, sourceCommit: build.sourceCommit,
        builtAt: build.builtAt, schemaVersion: build.schemaVersion,
        apiVersion: "waterx-research-v2",
      },
      source: {
        repository: "Current workspace checkout; no public GitHub remote verified",
        provenance: build.sourceCommit ? "packaged-source-commit" : "source-commit-unavailable",
      },
      model: { status: "No promoted WaterX model", version: null },
      legacyModelArtifactVersion: build.modelArtifactVersion,
    });
  });
  app.get("/api/waterx/health", safe(async (req, res) => {
    const interval = waterxInterval(req, res);
    if (!interval) return;
    const backlogByInterval = {
      "5": await getWaterxSettlementHealth(5),
      "15": await getWaterxSettlementHealth(15),
    };
    const snapshot = await getLiveWaterx(interval);
    res.set("Cache-Control", "no-store").json({
      intervalMinutes: interval, status: snapshot.status, collectorHealth: snapshot.status,
      collector: getWaterxDiagnostics(interval), backlogByInterval,
      note: "Autoscaling does not prove continuous capture while idle; round coverage is prospective only.",
    });
  }));
  app.get("/api/waterx/latency", safe(async (req, res) => {
    const interval = waterxInterval(req, res);
    if (!interval) return;
    res.set("Cache-Control", "no-store").json(await waterxLatencyReport(interval));
  }));
  app.get("/api/waterx/history", safe(async (req, res) => {
    const interval = waterxInterval(req, res);
    if (!interval) return;
    res.set("Cache-Control", "no-store").json({
      intervalMinutes: interval, ...(await getWaterxHistory(interval)),
    });
  }));
  app.get("/api/waterx/model", safe(async (req, res) => {
    const interval = waterxInterval(req, res);
    if (!interval) return;
    res.set("Cache-Control", "no-store").json({
      intervalMinutes: interval, ...(await getWaterxLearning(interval)),
      candidateTraining: await latestCandidateStatus(interval),
    });
  }));
  app.get("/api/waterx/chart", safe(async (req, res) => {
    const interval = waterxInterval(req, res);
    if (!interval) return;
    const requestedWindow = String(req.query.window ?? interval);
    if (requestedWindow !== "5" && requestedWindow !== "15") {
      res.status(400).json({ error: "window must be 5 or 15 minutes." });
      return;
    }
    const windowMinutes = Number(requestedWindow) as WaterxInterval;
    const now = Date.now();
    const archived = await persistedComparisonArchive(windowMinutes, now);
    const requestedStart = now - windowMinutes * 60_000;
    const points = chartSeries(archived.points, now, windowMinutes * 60_000);
    const coverage = comparisonSeriesCoverage(points, archived.coverage, requestedStart, now, GAP_AFTER_MS);
    res.set("Cache-Control", "no-store").json({
      intervalMinutes: interval,
      windowMinutes,
      source: "Coinbase comparison only; not WaterX settlement evidence",
      points,
      coverage: { ...coverage, partial: coverage.status !== "available" },
    });
  }));
  app.get("/api/history", safe(async (_req, res) => {
    const page = Math.min(5000, Math.max(1, Number.parseInt(String(_req.query.page ?? "1"),10) || 1));
    const size = Math.min(100, Math.max(1, Number.parseInt(String(_req.query.pageSize ?? "20"),10) || 20));
    res.set("Cache-Control", "no-store").json(await historyResponse(page,size));
  }));
  app.get("/api/model", safe(async (_req, res) => {
    res.set("Cache-Control","no-store").set("X-Data-Scope", "legacy-btc-not-waterx")
      .json({ ...await modelResponse(), marketSystem: "Legacy BTC research; not WaterX performance" });
  }));
  app.get("/api/health", safe(async (_req,res) => {
    res.set("Cache-Control","no-store").set("X-Data-Scope", "legacy-btc-not-waterx")
      .json({ ...await healthResponse(), build: buildInfo(),
        marketSystem: "Legacy BTC research; use /api/waterx/health for WaterX" });
  }));
  app.get("/api/predictions", safe(async (req,res) => {
    const limit = Math.min(100, Math.max(1,Number.parseInt(String(req.query.limit ?? "20"),10) || 20));
    res.set("Cache-Control","no-store").json(await predictionsResponse(limit));
  }));
  app.get("/api/chart", safe(async (req, res) => {
    const windowText = String(req.query.window ?? "5");
    if (windowText !== "5" && windowText !== "15") {
      res.status(400).json({ error: "window must be 5 or 15 minutes." });
      return;
    }
    const windowMinutes = Number(windowText) as 5 | 15;
    const now = Date.now();
    const archived = await persistedComparisonArchive(windowMinutes, now);
    const requestedStart = now - windowMinutes * 60_000;
    const points = chartSeries(archived.points, now, windowMinutes * 60_000);
    const coverage = comparisonSeriesCoverage(points, archived.coverage, requestedStart, now, GAP_AFTER_MS);
    res.set("Cache-Control", "no-store").json({
      windowMinutes,
      source: "Coinbase comparison only; not settlement oracle",
      points,
      coverage: { ...coverage, partial: coverage.status !== "available" },
    });
  }));
  app.get("/api/chart/stream", (req, res) => {
    const requestedId = String(req.query.lastEventId ?? req.query.after ?? req.get("Last-Event-ID") ?? "0");
    if (!/^\d{1,16}$/.test(requestedId)) {
      res.status(400).json({ error: "Last-Event-ID must be a non-negative integer." });
      return;
    }
    let cursor = Number(requestedId);
    if (!Number.isSafeInteger(cursor)) {
      res.status(400).json({ error: "Last-Event-ID is outside the supported range." });
      return;
    }
    res.status(200).set({
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const write = (event: { id: number; type: string; data: unknown }) => {
      if (res.writableEnded || res.destroyed) return;
      const envelope = {
        ...(event.data as Record<string, unknown>),
        serverSentAt: new Date().toISOString(),
      };
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(envelope)}\n\n`);
      cursor = event.id;
    };

    const retainedEvents = chartEventsAfter(0);
    const plan = chartReplayPlan(cursor, latestChartEventId(), retainedEvents[0]?.id);
    if (plan.reset === "restart") {
      write({
        id: plan.cursor,
        type: "reset",
        data: { at: Date.now(), price: null, gap: true,
          reason: "Chart stream restarted; reload comparison history before continuing." },
      });
      cursor = plan.cursor;
    } else if (plan.reset === "buffer-exhausted") {
      const at = Date.now();
      write({
        id: plan.cursor,
        type: "gap",
        data: { at, price: null, gap: true, reason: "SSE replay buffer exhausted; reload chart history." },
      });
      cursor = plan.cursor;
    }
    const unsubscribe = subscribeChartEvents(write);
    for (const event of chartEventsAfter(cursor)) write(event);
    const freshnessTimer = setInterval(() => {
      checkChartFreshness();
      if (!res.writableEnded && !res.destroyed) res.write(`: keepalive ${Date.now()}\n\n`);
    }, 5_000);
    freshnessTimer.unref?.();
    res.on("close", () => {
      clearInterval(freshnessTimer);
      unsubscribe();
    });
  });
  app.get("/api/accuracy", safe(async (_req, res) => {
    res.set("Cache-Control", "no-store").json(await accuracyReport());
  }));
  app.get("/api/accuracy/export", safe(async (req, res) => {
    const collection = String(req.query.collection ?? "");
    const format = String(req.query.format ?? "json");
    const limitText = String(req.query.limit ?? "50");
    const cursor = req.query.cursor === undefined ? null : String(req.query.cursor);
    if (!["predictions", "outcomes", "scores"].includes(collection) ||
        !["json", "csv"].includes(format) ||
        !/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 100 ||
        (cursor !== null && cursor.length > 512)) {
      res.status(400).json({ error: "Use collection=predictions|outcomes|scores, format=json|csv, and limit=1..100." });
      return;
    }
    try {
      const { csv, ...page } = await accuracyExport(collection as ExportCollection, {
        cursor, limit: Number(limitText),
      });
      res.set("Cache-Control", "no-store");
      if (format === "csv") {
        if (page.nextCursor) res.set("X-Next-Cursor", page.nextCursor);
        res.type("text/csv; charset=utf-8").set("Content-Disposition",
          `attachment; filename="btc-${collection}-${new Date().toISOString().slice(0,10)}.csv"`).send(csv);
      } else res.json(page);
    } catch (error) {
      if (error instanceof Error && /cursor/i.test(error.message)) {
        res.status(400).json({ error: "Invalid or mismatched pagination cursor." });
        return;
      }
      throw error;
    }
  }));
  app.get("/api/about", (_req, res) => res.json({
    sources: [
      { name: "WaterX public BTC up/down markets", url: "https://api.waterx.app/predict/markets/crypto",
        role: "Read-only 5m/15m metadata, reported beginning price-to-beat, market odds, and provider-reported outcomes for previously observed rounds." },
      { name: "Coinbase Exchange BTC-USD", url: "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
        role: "Comparison price and chart only; never the WaterX beginning reference or Chainlink settlement." },
    ],
    limitations: [
      "History starts with prospective observations. It is not a complete archive of WaterX rounds.",
      "Only active rounds with the requested exact 5m or 15m cadence are shown.",
      "WaterX anchorPrice is its reported beginning price-to-beat; anchorPriceConfirmed may be false. Do not substitute Coinbase.",
      "WaterX states that Chainlink BTC/USD TWAP determines settlement: Up when the ending TWAP is greater than or equal to the beginning reference, Down otherwise.",
      "Settlement data is provider-reported, not independently verified against Chainlink. Missing or contradictory evidence remains withheld.",
      "WaterX public odds are not executable quotes. Fees, slippage, and net payout are unverified.",
      "The available WaterX chart endpoint provides probability history, not an authenticated, timestamped BTC price trace.",
      "No calibrated forecast is promoted. The application makes no orders, wallet calls, or trading recommendations.",
    ],
  }));
  app.get("/api/settings", (_req,res) => res.json(defaults));
  // Validation only. Preferences are stored privately in this browser by the UI,
  // never as shared settings affecting other visitors.
  app.put("/api/settings", (req,res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid preferences" });
    return res.json(parsed.data);
  });
  app.get("/api/exports/rounds.json", safe(async (_req,res) => {
    const first = await historyResponse(1,500);
    const rows = [...first.rows];
    for (let page = 2; page <= first.totalPages; page++)
      rows.push(...(await historyResponse(page,500)).rows);
    res.attachment("signal-desk-rounds.json").json({ ...first,rows });
  }));
  app.get("/api/exports/rounds.csv", safe(async (_req,res) => {
    const first = await historyResponse(1,500);
    const rows = [...first.rows];
    for (let page = 2; page <= first.totalPages; page++)
      rows.push(...(await historyResponse(page,500)).rows);
    const headings = ["id","expiryMs","referencePrice","settlementPrice","outcome","firstSeenAt","lastSeenAt","quoteCount","quality"];
    const esc = (value: unknown) => `"${String(value ?? "").replaceAll('"','""')}"`;
    const content = [headings.join(","),...rows.map(row => headings.map(key => esc((row as Record<string, unknown>)[key])).join(","))].join("\r\n");
    res.type("text/csv").attachment("signal-desk-rounds.csv").send(content);
  }));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api]", err.message);
    res.status(503).json({ error: "Required data is unavailable. No recommendation was generated." });
  });
}