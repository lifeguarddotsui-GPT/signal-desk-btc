import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { historyResponse, live, modelResponse } from "./btc/service";
import { sources } from "./btc/source";

const defaults = { edgeThreshold: .05, refreshSeconds: 5, unit: "USD" };
const settingsSchema = z.object({
  edgeThreshold: z.number().finite().min(0).max(.25),
  refreshSeconds: z.union([z.literal(5),z.literal(10),z.literal(30)]),
  unit: z.enum(["USD","BTC"]),
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
  app.get("/api/history", safe(async (_req, res) => {
    res.set("Cache-Control", "no-store").json(await historyResponse());
  }));
  app.get("/api/model", safe(async (_req, res) => { res.json(await modelResponse()); }));
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
      "A missing reference strike or unsettled result is not a DOWN outcome. UP means strictly above the reference; DOWN includes equality.",
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
    res.attachment("signal-desk-rounds.json").json(await historyResponse());
  }));
  app.get("/api/exports/rounds.csv", safe(async (_req,res) => {
    const { rows } = await historyResponse();
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