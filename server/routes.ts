import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { healthResponse, historyResponse, live, modelResponse, predictionsResponse } from "./btc/service";
import { buildInfo } from "./btc/build-info";
import { sources } from "./btc/source";
import { economicsFeed } from "./btc/economics-feed";
import { accuracyExport, accuracyReport, type ExportCollection } from "./btc/reporting";
import {
  chartEventsAfter, chartReplayPlan, chartSeries, checkChartFreshness, latestChartEventId,
  subscribeChartEvents,
} from "./btc/chart";
import { persistedComparisonHistory } from "./btc/chart-history";

const defaults = { refreshSeconds: 5 };
const settingsSchema = z.object({
  refreshSeconds: z.union([z.literal(5),z.literal(10),z.literal(30)]),
}).strict();

function safe(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) =>
    void handler(req, res).catch(next);
}
export function registerRoutes(app: Express) {
  app.get("/health/live", (_req, res) => res.json({ status: "ok", readOnly: true }));
  app.get("/api/live", safe(async (_req, res) => {
    res.set("Cache-Control", "no-store").json(await live());
  }));
  app.get("/api/economics", safe(async (_req, res) => {
    const snapshot = await live();
    if (!snapshot.round) {
      res.set("Cache-Control", "no-store").json({
        status: "UNAVAILABLE", reason: snapshot.reason || "No verified active round.",
        marketId: null, expiryMs: null, up: null, down: null,
      });
      return;
    }
    res.set("Cache-Control", "no-store").json(await economicsFeed.get({
      marketId: snapshot.round.id, expiryMs: snapshot.round.expiryMs,
    }));
  }));
  app.get("/api/history", safe(async (_req, res) => {
    const page = Math.min(5000, Math.max(1, Number.parseInt(String(_req.query.page ?? "1"),10) || 1));
    const size = Math.min(100, Math.max(1, Number.parseInt(String(_req.query.pageSize ?? "20"),10) || 20));
    res.set("Cache-Control", "no-store").json(await historyResponse(page,size));
  }));
  app.get("/api/model", safe(async (_req, res) => { res.set("Cache-Control","no-store").json(await modelResponse()); }));
  app.get("/api/health", safe(async (_req,res) => {
    res.set("Cache-Control","no-store").json({ ...await healthResponse(), build: buildInfo() });
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
    const archived = await persistedComparisonHistory(windowMinutes);
    res.set("Cache-Control", "no-store").json({
      windowMinutes,
      source: "Coinbase comparison only; not settlement oracle",
      points: chartSeries(archived, now, windowMinutes * 60_000),
    });
  }));
  app.get("/api/chart/stream", (req, res) => {
    const requestedId = String(req.get("Last-Event-ID") ?? req.query.after ?? "0");
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
      { name: "DeepBook Predict mainnet SDK", url: sources.sdk,
        role: "Official on-chain active markets, reference strike, indicative on-chain digital probability, and known-ID settlement read." },
      { name: "Sui mainnet public fullnode", url: sources.chain,
        role: "Read-only market simulations; not an authenticated session or a trade execution endpoint." },
      { name: "Coinbase Exchange BTC-USD", url: sources.comparison,
        role: "Independent comparison tick only, never substituted for the DeepBook settlement oracle." },
    ],
    limitations: [
      "No historical round enumeration in the documented Predict SDK. History begins when this app starts capturing; there is no complete backfill.",
      "The SDK active-market list does not explicitly identify 1m cadence; consecutive 60-second expiries are an inference. Ambiguous rounds must remain HOLD.",
      "An indicative on-chain probability is not an executable purchase quote; actual cost, fees, slippage and payout are not verified anonymously.",
      "No canonical current BTC oracle spot-price read is wired. Coinbase is a comparison feed, not settlement evidence.",
      "An unsettled result or missing reference is not DOWN. Equality and void contract rules remain unverified, so an exact equal settlement remains UNKNOWN.",
      "Without a verified pre-decision quote and enough later settled rounds, no calibrated probability or proven profitable signal can be claimed.",
      "Manual decisions only. No wallet, transaction, signing, automated hedge, or trade execution exists in this application.",
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