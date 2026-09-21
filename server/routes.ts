import type { Express, Request, Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { campaigns, decisions, ledgerEntries, walletAuthChallenges } from "../shared/schema";
import { getAccumulationDashboard, getAccumulationOperations } from "./services/accumulationStatus";
import { latestResearchSnapshot, saveResearchProposal } from "./services/researchService";

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
function allowLoginAttempt(req: Request, res: Response): boolean {
  const key = req.ip || "unknown";
  const now = Date.now();
  const current = loginAttempts.get(key);
  const attempt = !current || current.resetAt <= now ? { count: 1, resetAt: now + 15 * 60_000 } : { ...current, count: current.count + 1 };
  loginAttempts.set(key, attempt);
  if (attempt.count <= 5) return true;
  res.setHeader("Retry-After", String(Math.ceil((attempt.resetAt - now) / 1000)));
  res.status(429).json({ code: "WALLET_LOGIN_RATE_LIMITED", message: "Too many wallet authentication attempts." });
  return false;
}

const suiAddress = z.string().regex(/^0x[0-9a-f]{64}$/i);
type WalletChallenge = { address: string; message: string; expiresAt: number };
const challengeAttempts = new Map<string, { count: number; resetAt: number }>();
function allowChallenge(req: Request, res: Response): boolean {
  const key = req.ip || "unknown";
  const now = Date.now();
  const current = challengeAttempts.get(key);
  const attempt = !current || current.resetAt <= now ? { count: 1, resetAt: now + 15 * 60_000 } : { ...current, count: current.count + 1 };
  challengeAttempts.set(key, attempt);
  if (attempt.count <= 20) return true;
  res.setHeader("Retry-After", String(Math.ceil((attempt.resetAt - now) / 1000)));
  res.status(429).json({ code: "WALLET_CHALLENGE_RATE_LIMITED", message: "Too many wallet challenges requested." });
  return false;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function walletSession(req: Request, res: Response): string | null {
  const address = (req.session as any).walletAddress;
  if (typeof address === "string" && suiAddress.safeParse(address).success) return address;
  res.status(401).json({ code: "WALLET_SESSION_REQUIRED", message: "Connect and authenticate a Sui wallet." });
  return null;
}

function campaignId(address: string) {
  return `paper-${createHash("sha256").update(address.toLowerCase()).digest("hex").slice(0, 32)}`;
}

async function ensureWalletCampaign(address: string) {
  const id = campaignId(address);
  const [campaign] = await db.insert(campaigns).values({
    id,
    name: "Paper Agent",
    network: "mainnet",
    mode: "PAPER",
    status: "active",
    ownerAddress: address.toLowerCase(),
  }).onConflictDoUpdate({
    target: campaigns.id,
    set: { ownerAddress: address.toLowerCase(), updatedAt: new Date() },
  }).returning();
  await db.insert(ledgerEntries).values({
    id: `paper-opening-${id}`,
    campaignId: id,
    idempotencyKey: `paper-opening:${id}:10-sui`,
    entryType: "PAPER_INITIAL_BALANCE",
    suiMist: "10000000000",
    referenceType: "PAPER_SIMULATION",
    referenceId: "paper-genesis-v1",
  }).onConflictDoNothing();
  await db.insert(decisions).values({
    id: `paper-opening-decision-${id}`,
    campaignId: id,
    decisionKey: `paper-opening:${id}:strategy-observe-v1`,
    policyVersion: "observe-v1",
    action: "HOLD_SUI",
    featureSnapshot: {
      source: "wallet-authentication",
      startingVirtualSuiMist: "10000000000",
      network: "mainnet",
      immutableDecision: true,
    },
    rejectionReasons: [
      "EXECUTABLE_BUY_ROUTE_UNVERIFIED",
      "EXECUTABLE_FULL_EXIT_QUOTE_UNAVAILABLE",
      "PAPER_TRANSACTION_SIMULATION_UNAVAILABLE",
    ],
    outcome: "HELD",
  }).onConflictDoNothing();
  return campaign;
}

async function updateCampaign(address: string, mode: "OBSERVE" | "PAPER", paused: boolean, res: Response) {
  try {
    const campaign = await ensureWalletCampaign(address);
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
    const walletAddress = (req.session as any).walletAddress;
    res.json({
      authenticated: typeof walletAddress === "string",
      walletAddress: typeof walletAddress === "string" ? walletAddress : null,
      network: "mainnet",
    });
  });

  app.get("/api/auth/challenge", async (req, res) => {
    if (!allowChallenge(req, res)) return;
    const parsed = suiAddress.safeParse(req.query.address);
    if (!parsed.success) return res.status(400).json({ code: "INVALID_SUI_ADDRESS", message: "A valid Sui address is required." });
    const now = new Date();
    const expires = new Date(now.getTime() + 5 * 60_000);
    const nonce = randomBytes(24).toString("base64url");
    const domain = process.env.AUTH_CANONICAL_DOMAIN || (process.env.NODE_ENV === "production" ? "bluewaterai.app" : req.hostname);
    const message = [
      "Blue Water Agents",
      "Network: Mainnet",
      `Connected wallet address: ${parsed.data.toLowerCase()}`,
      `Domain: ${domain}`,
      `Nonce: ${nonce}`,
      `Issued time: ${now.toISOString()}`,
      `Expiration time: ${expires.toISOString()}`,
      "Purpose: Authenticate to manage my Blue Water Agent",
    ].join("\n");
    const nonceHash = hash(nonce);
    const sessionHash = hash(req.sessionID);
    try {
      await db.delete(walletAuthChallenges).where(lt(walletAuthChallenges.expiresAt, now));
      await db.delete(walletAuthChallenges).where(eq(walletAuthChallenges.sessionHash, sessionHash));
      await db.insert(walletAuthChallenges).values({
        nonceHash,
        sessionHash,
        walletAddress: parsed.data.toLowerCase(),
        message,
        expiresAt: expires,
      });
    } catch {
      return res.status(503).json({ code: "CHALLENGE_STORE_UNAVAILABLE", message: "Wallet authentication is temporarily unavailable." });
    }
    (req.session as any).walletChallenge = { address: parsed.data.toLowerCase(), message, expiresAt: expires.getTime() } satisfies WalletChallenge;
    req.session.save((error) => {
      if (error) {
        void db.delete(walletAuthChallenges).where(eq(walletAuthChallenges.nonceHash, nonceHash));
        return res.status(503).json({ code: "SESSION_UNAVAILABLE", message: "Authentication challenge could not be persisted." });
      }
      res.json({ message, expiresAt: expires.toISOString(), network: "mainnet" });
    });
  });

  app.post("/api/auth/verify", async (req, res) => {
    if (!allowLoginAttempt(req, res)) return;
    const parsed = z.object({ address: suiAddress, signature: z.string().min(20).max(4096) }).safeParse(req.body);
    const challenge = (req.session as any).walletChallenge as WalletChallenge | undefined;
    const nonce = challenge?.message.match(/^Nonce: (.+)$/m)?.[1];
    if (!parsed.success || !challenge || !nonce || challenge.expiresAt <= Date.now() || challenge.address !== parsed.data.address.toLowerCase()) {
      return res.status(401).json({ code: "INVALID_WALLET_CHALLENGE", message: "Request a fresh wallet authentication message." });
    }
    const consumed = await db.update(walletAuthChallenges).set({ consumedAt: new Date() }).where(and(
      eq(walletAuthChallenges.nonceHash, hash(nonce)),
      eq(walletAuthChallenges.sessionHash, hash(req.sessionID)),
      eq(walletAuthChallenges.walletAddress, challenge.address),
      gt(walletAuthChallenges.expiresAt, new Date()),
      isNull(walletAuthChallenges.consumedAt),
    )).returning({ nonceHash: walletAuthChallenges.nonceHash });
    if (consumed.length !== 1) {
      return res.status(401).json({ code: "INVALID_WALLET_CHALLENGE", message: "This wallet challenge is expired or already used." });
    }
    delete (req.session as any).walletChallenge;
    try {
      await verifyPersonalMessageSignature(new TextEncoder().encode(challenge.message), parsed.data.signature, { address: challenge.address });
      await ensureWalletCampaign(challenge.address);
    } catch {
      return res.status(401).json({ code: "INVALID_WALLET_SIGNATURE", message: "The wallet signature did not verify." });
    }
    req.session.regenerate((error) => {
      if (error) return res.status(503).json({ code: "OWNER_SESSION_UNAVAILABLE", message: "Owner session could not be established." });
      (req.session as any).walletAddress = challenge.address;
      req.session.save((saveError) => {
        if (saveError) return res.status(503).json({ code: "OWNER_SESSION_UNAVAILABLE", message: "Owner session could not be persisted." });
        res.json({ authenticated: true, walletAddress: challenge.address });
      });
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((error) => {
      if (error) return res.status(503).json({ code: "OWNER_SESSION_UNAVAILABLE", message: "Owner session could not be closed." });
      res.json({ authenticated: false });
    });
  });

  app.get("/api/accumulation/dashboard", async (req, res) => {
    const address = walletSession(req, res); if (!address) return;
    await ensureWalletCampaign(address);
    res.json(await getAccumulationDashboard(address));
  });

  app.get("/api/accumulation/operations", async (req, res) => {
    res.json(await getAccumulationOperations());
  });

  app.post("/api/accumulation/pause", async (req, res) => {
    const address = walletSession(req, res); if (!address) return;
    await updateCampaign(address, "PAPER", true, res);
  });

  app.post("/api/accumulation/resume-paper", async (req, res) => {
    const address = walletSession(req, res); if (!address) return;
    await updateCampaign(address, "PAPER", false, res);
  });

  app.post("/api/accumulation/withdraw-all", (req, res) => {
    const address = walletSession(req, res); if (!address) return;
    res.status(503).json({
      code: "WITHDRAWAL_UNAVAILABLE",
      message: "Withdraw All is refused: wallet and signer are not configured.",
      walletConfigured: false,
      signerConfigured: false,
    });
  });

  app.get("/api/research/snapshot", async (req, res) => {
    const address = walletSession(req, res); if (!address) return;
    res.status(403).json({ code: "OPERATOR_ROUTE_UNAVAILABLE", message: "Global research controls are not available to wallet sessions." });
  });

  app.post("/api/research/proposals", async (req, res) => {
    const address = walletSession(req, res); if (!address) return;
    res.status(403).json({ code: "OPERATOR_ROUTE_UNAVAILABLE", message: "Wallet sessions cannot create global policy proposals." });
  });
}