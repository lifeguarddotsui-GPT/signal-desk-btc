import type { Express, Request } from "express";
import type { createVisitorActivityGate } from "./visitor-activity";

type VisitorGate = ReturnType<typeof createVisitorActivityGate>;

export function registerVisitorPresence(app: Express, gate: VisitorGate) {
  const sameOrigin = (req: Request) => {
    if (req.get("sec-fetch-site") === "cross-site") return false;
    const origin = req.get("origin");
    if (!origin) return true;
    try { return new URL(origin).host.toLowerCase() === (req.get("host") ?? "").toLowerCase(); }
    catch { return false; }
  };
  app.post("/api/visitor/heartbeat", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!sameOrigin(req)) { res.status(403).json({ error: "Cross-origin activity forbidden" }); return; }
    try {
      const result = gate.beat(req.body?.sessionId);
      if (result !== "accepted") {
        res.status(result === "invalid" ? 400 : 429).json({ error: result }); return;
      }
      res.json({ mode: "visitor-only", ...gate.status() });
    } catch {
      res.status(503).json({ error: "Visitor collection cannot start on this deployment" });
    }
  });
  app.post("/api/visitor/leave", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!sameOrigin(req)) { res.status(403).json({ error: "Cross-origin activity forbidden" }); return; }
    gate.leave(req.body?.sessionId);
    res.status(204).end();
  });
  app.get("/api/visitor/status", (_req, res) =>
    res.set("Cache-Control", "no-store").json({ mode: "visitor-only", ...gate.status() }));
  // HTTP health/version pages stay passive. API polling, crawlers and bot
  // traffic cannot query production PostgreSQL in the absence of a lease.
  app.use("/api", (req, res, next) => {
    if (!gate.status().ready) {
      res.status(503).set("Cache-Control", "no-store")
        .set("Retry-After", "3")
        .json({ error: "Live collection paused: no visible visitor is active." });
      return;
    }
    next();
  });
}

