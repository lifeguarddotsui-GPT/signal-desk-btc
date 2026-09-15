import type { Express, Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { campaigns } from "../shared/schema";
import { getAccumulationDashboard, getAccumulationOperations } from "./services/accumulationStatus";
import { latestResearchSnapshot, saveResearchProposal } from "./services/researchService";

function ownerControl(req: Request, res: Response): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  if ((req.session as any).ownerAuthenticated === true) return true;
  res.status(401).json({ code: "OWNER_SESSION_REQUIRED", message: "An authenticated owner session is required." });
  return false;
}

function verifyOwnerToken(req: Request, res: Response): boolean {
  const configured = process.env.OWNER_CONTROL_TOKEN;
  if (!configured) {
    res.status(503).json({
      code: "OWNER_CONTROL_UNCONFIGURED",
      message: "Owner control is unavailable until OWNER_CONTROL_TOKEN is configured.",
    });
    return false;
  }
  const supplied = typeof req.body?.token === "string" ? req.body.token : "";
  const expected = Buffer.from(configured);
  const actual = Buffer.from(supplied);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    res.status(401).json({ code: "OWNER_CONTROL_REQUIRED", message: "A valid owner control token is required." });
    return false;
  }
  return true;
}

async function updateCampaign(mode: "OBSERVE" | "PAPER", paused: boolean, res: Response) {
  try {
    const [campaign] = await db.select().from(campaigns)
      .orderBy(desc(campaigns.updatedAt)).limit(1);
    if (!campaign) {
      res.status(409).json({ code: "CAMPAIGN_UNCONFIGURED", message: "No accumulation campaign is configured." });
      return;
    }
    const [updated] = await db.update(campaigns).set({
      mode,
      status: paused ? "paused" : "active",
      updatedAt: new Date(),
    }).where(eq(campaigns.id, campaign.id)).returning();
    res.json({ ok: true, campaign: updated });
  } catch (error) {
    res.status(503).json({ code: "CAMPAIGN_STORE_UNAVAILABLE", message: error instanceof Error ? error.message : "Campaign store unavailable." });
  }
}

const proposalSchema = z.object({
  proposedVersion: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
  summary: z.string().trim().min(1).max(2_000),
  changes: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  evidenceSnapshotId: z.string().trim().min(1).max(200),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export async function registerRoutes(_httpServer: import("node:http").Server, app: Express): Promise<void> {
  app.get("/api/auth/status", (req, res) => {
    res.json({
      authenticated: process.env.NODE_ENV !== "production" || (req.session as any).ownerAuthenticated === true,
      ownerControlConfigured: Boolean(process.env.OWNER_CONTROL_TOKEN),
    });
  });

  app.post("/api/auth/login", (req, res) => {
    if (!verifyOwnerToken(req, res)) return;
    (req.session as any).ownerAuthenticated = true;
    req.session.save(() => res.json({ authenticated: true }));
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => res.json({ authenticated: false }));
  });

  app.get("/api/accumulation/dashboard", async (req, res) => {
    if (!ownerControl(req, res)) return;
    res.json(await getAccumulationDashboard());
  });

  app.get("/api/accumulation/operations", async (req, res) => {
    if (!ownerControl(req, res)) return;
    res.json(await getAccumulationOperations());
  });

  app.post("/api/accumulation/pause", async (req, res) => {
    if (!ownerControl(req, res)) return;
    await updateCampaign("OBSERVE", true, res);
  });

  app.post("/api/accumulation/resume-paper", async (req, res) => {
    if (!ownerControl(req, res)) return;
    await updateCampaign("PAPER", false, res);
  });

  app.post("/api/accumulation/withdraw-all", (req, res) => {
    if (!ownerControl(req, res)) return;
    res.status(503).json({
      code: "WITHDRAWAL_UNAVAILABLE",
      message: "Withdraw All is refused: wallet and signer are not configured.",
      walletConfigured: false,
      signerConfigured: false,
    });
  });

  app.get("/api/research/snapshot", async (req, res) => {
    if (!ownerControl(req, res)) return;
    const snapshot = await latestResearchSnapshot();
    if (!snapshot) {
      res.json({
        status: "unavailable",
        value: null,
        reason: "No research snapshot is available.",
      });
      return;
    }
    res.json(snapshot);
  });

  app.post("/api/research/proposals", async (req, res) => {
    if (!ownerControl(req, res)) return;
    const parsed = proposalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: "INVALID_RESEARCH_PROPOSAL",
        message: "Proposal does not match the strict schema.",
        issues: parsed.error.issues,
      });
      return;
    }
    const idempotencyKey = req.header("idempotency-key");
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
      res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "A valid Idempotency-Key header is required." });
      return;
    }
    try {
      const id = `proposal-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
      const proposal = await saveResearchProposal({ id, idempotencyKey, ...parsed.data });
      res.status(201).json({ ...proposal, signerAccess: false });
    } catch (error) {
      res.status(409).json({
        code: "RESEARCH_PROPOSAL_NOT_ACCEPTED",
        message: error instanceof Error ? error.message : "Proposal could not be persisted.",
      });
    }
  });
}