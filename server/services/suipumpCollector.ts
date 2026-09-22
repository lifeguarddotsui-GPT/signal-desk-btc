import { randomUUID } from "node:crypto";
import { and, count, eq, lte, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  assets,
  campaigns,
  collectorCheckpoints,
  decisions,
  marketObservations,
  workerLeases,
} from "../../shared/schema";
import { evaluateObserveDecision } from "./observeDecision";

const COLLECTOR = "suipump-mainnet";
const SOURCE = "https://suipump-main-web.onrender.com";
const VERIFIED_WRITE_PACKAGE = "0xb205fea41ccedac051bc66498e6ca68cb802c4a6ea06da12e524bed09c80d9b0";
const HOLDER = `collector-${randomUUID()}`;
const PROCESS_STARTED_AT = new Date();
const LEASE_MS = 90_000;
const INTERVAL_MS = 30_000;
const TOKEN_BATCH_SIZE = 50;
let tokenBatchOffset = 0;

const tokenSchema = z.object({
  curveId: z.string().regex(/^0x[0-9a-f]{64}$/i),
  tokenType: z.string().min(1).nullable(),
  packageId: z.string().regex(/^0x[0-9a-f]{64}$/i),
  symbol: z.string().nullable().optional(),
  createdAt: z.union([z.string(), z.number()]).optional(),
  initialSharedVersion: z.union([z.string(), z.number()]).nullable().optional(),
  stats: z.object({
    volume_sui: z.number().nonnegative().optional(),
    trades: z.number().int().nonnegative().optional(),
    buys: z.number().int().nonnegative().optional(),
    sells: z.number().int().nonnegative().optional(),
    last_trade_time: z.number().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

const statsSchema = z.object({
  totalTrades: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
  s1PoolInflowDetail: z.object({
    lastCheckpoint: z.union([z.string(), z.number()]).nullable().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

function assetKey(curveId: string): string {
  return `suipump-${curveId.slice(2)}`;
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(`${SOURCE}${path}`, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: "application/json", "user-agent": "blue-water-observer/1.0" },
  });
  if (!response.ok) throw new Error(`SUIPUMP_HTTP_${response.status}:${path}`);
  return response.json();
}

async function acquireLease(): Promise<string | null> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const fencingToken = randomUUID();
  const acquired = await db.insert(workerLeases).values({
    id: `lease-${COLLECTOR}`,
    workerName: COLLECTOR,
    holder: HOLDER,
    fencingToken,
    expiresAt,
    renewedAt: now,
  }).onConflictDoUpdate({
    target: workerLeases.workerName,
    set: { holder: HOLDER, fencingToken, expiresAt, renewedAt: now },
    setWhere: or(lte(workerLeases.expiresAt, now), eq(workerLeases.holder, HOLDER)),
  }).returning({ holder: workerLeases.holder });
  return acquired[0]?.holder === HOLDER ? fencingToken : null;
}

async function renewLease(fencingToken: string): Promise<boolean> {
  const now = new Date();
  const renewed = await db.update(workerLeases).set({
    expiresAt: new Date(now.getTime() + LEASE_MS),
    renewedAt: now,
  }).where(and(
    eq(workerLeases.workerName, COLLECTOR),
    eq(workerLeases.holder, HOLDER),
    eq(workerLeases.fencingToken, fencingToken),
  )).returning({ id: workerLeases.id });
  return renewed.length === 1;
}

const DEFAULT_SUI_GRAPHQL = "https://graphql.mainnet.sui.io/graphql";

async function suiGetObject(graphqlUrl: string, id: string) {
  const query = `{ object(address: "${id}") {
    address version owner { __typename }
    asMoveObject { contents { type { repr } } }
    asMovePackage { modules(first: 1) { nodes { name } } }
  } }`;
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(`SUI_GRAPHQL_HTTP_${response.status}`);
  const body = await response.json() as { data?: { object?: any }; errors?: Array<{ message?: string }> };
  if (body.errors?.length) throw new Error(`SUI_GRAPHQL_ERROR:${body.errors[0]?.message || "unknown"}`);
  return body.data?.object;
}

async function verifyOnChain(graphqlUrl: string, token: z.infer<typeof tokenSchema>) {
  const [curve, pkg] = await Promise.all([
    suiGetObject(graphqlUrl, token.curveId),
    suiGetObject(graphqlUrl, token.packageId),
  ]);
  const curveType = curve?.asMoveObject?.contents?.type?.repr || "";
  const packageExists = Boolean(pkg?.asMovePackage);
  const curveIsShared = curve?.owner?.__typename === "Shared";
  const curveMatchesPackage = curveType.startsWith(`${token.packageId}::`);
  const tokenTypeMatchesCurve = curveType.endsWith(`<${token.tokenType}>`);
  const packagePinned = token.packageId.toLowerCase() === VERIFIED_WRITE_PACKAGE;
  return {
    verified: packageExists && curveIsShared && curveMatchesPackage && tokenTypeMatchesCurve && packagePinned,
    packageExists,
    curveIsShared,
    curveMatchesPackage,
    tokenTypeMatchesCurve,
    packagePinned,
    curveType,
    curveVersion: curve?.version || null,
    packageVersion: pkg?.version || null,
  };
}

async function collectOnce(): Promise<void> {
  const fencingToken = await acquireLease();
  if (!fencingToken) return;
  const startedAt = new Date();
  try {
    const [rawTokens, rawStats] = await Promise.all([fetchJson("/tokens"), fetchJson("/stats")]);
    const parsedTokens = z.array(tokenSchema).parse(rawTokens);
    const tokens = parsedTokens.filter((token): token is typeof token & { tokenType: string } => typeof token.tokenType === "string");
    if (tokens.length === 0) throw new Error("SUIPUMP_EMPTY_TOKEN_BATCH");
    const stats = statsSchema.parse(rawStats);
    const checkpoint = String(stats.s1PoolInflowDetail?.lastCheckpoint ?? "");
    if (!checkpoint) throw new Error("SUIPUMP_CHECKPOINT_UNAVAILABLE");
    const graphqlUrl = process.env.SUI_GRAPHQL_URL || DEFAULT_SUI_GRAPHQL;
    await db.insert(campaigns).values({
      id: "observe-mainnet",
      name: "Suipump mainnet observation",
      network: "mainnet",
      mode: "OBSERVE",
      status: "active",
    }).onConflictDoNothing();
    let verifiedAssetCount = 0;
    let insertedThisRun = 0;
    let verificationErrors = 0;

    const batch = Array.from({ length: Math.min(TOKEN_BATCH_SIZE, tokens.length) }, (_, index) =>
      tokens[(tokenBatchOffset + index) % tokens.length]);
    tokenBatchOffset = (tokenBatchOffset + batch.length) % tokens.length;
    for (const token of batch) {
      if (!await renewLease(fencingToken)) throw new Error("COLLECTOR_LEASE_LOST");
      const verification = await verifyOnChain(graphqlUrl, token).catch(() => {
        verificationErrors++;
        return null;
      });
      if (!verification?.verified) continue;
      verifiedAssetCount++;
      const id = assetKey(token.curveId);
      await db.insert(assets).values({
        id,
        network: "mainnet",
        coinType: token.tokenType,
        packageId: token.packageId,
        curveId: token.curveId,
        symbol: token.symbol || null,
        status: "verified_observe",
        metadata: {
          source: SOURCE,
          initialSharedVersion: token.initialSharedVersion ?? null,
          verification,
        },
      }).onConflictDoUpdate({
        target: assets.id,
        set: {
          coinType: token.tokenType,
          packageId: token.packageId,
          symbol: token.symbol || null,
          status: "verified_observe",
          metadata: { source: SOURCE, initialSharedVersion: token.initialSharedVersion ?? null, verification },
          updatedAt: startedAt,
        },
      });
      const inserted = await db.insert(marketObservations).values({
        id: `obs-${checkpoint}-${startedAt.getTime()}-${token.curveId.slice(2)}`,
        assetId: id,
        checkpoint,
        observedAt: startedAt,
        provider: "suipump-public-api+sui-rpc",
        coverageStatus: "PARTIAL",
        data: { token, verification, providerTotals: { totalTrades: stats.totalTrades, tokenCount: stats.tokenCount } },
      }).onConflictDoNothing().returning({ id: marketObservations.id });
      insertedThisRun += inserted.length;

      const decision = evaluateObserveDecision({
        observedSeconds: token.createdAt ? Math.max(0, Math.floor((startedAt.getTime() - Number(token.createdAt)) / 1000)) : null,
        netBuyingSui60s: null,
        netBuyingSui5m: null,
        distinctBuyingWallets5m: null,
        independentBuyerGroups5m: null,
        volumeSui5m: token.stats?.volume_sui != null ? String(token.stats.volume_sui) : null,
        creatorConcentrationPct: null,
        topTenConcentrationPct: null,
        hasExecutableBuyQuote: false,
        hasExecutableFullExitQuote: false,
        roundTripLossPct: null,
        trendScore: null,
      }, undefined, startedAt);
      await db.insert(decisions).values({
        id: `decision-${checkpoint}-${token.curveId.slice(2)}`,
        campaignId: "observe-mainnet",
        assetId: id,
        decisionKey: `${checkpoint}:${token.curveId}:observe-v1`,
        policyVersion: decision.policyVersion,
        action: decision.action,
        featureSnapshot: { tokenStats: token.stats ?? null, sourceCheckpoint: checkpoint },
        rejectionReasons: decision.rejectionReasons,
        outcome: "HELD",
      }).onConflictDoNothing();
    }
    const attempted = batch.length;
    if (verificationErrors >= Math.max(1, Math.ceil(attempted / 2))) {
      throw new Error(`SUI_VERIFICATION_SYSTEMIC_FAILURE:${verificationErrors}/${attempted}`);
    }
    if (verifiedAssetCount === 0) throw new Error(`SUI_VERIFICATION_ZERO_ACCEPTED:0/${attempted}`);
    if (!await renewLease(fencingToken)) throw new Error("COLLECTOR_LEASE_LOST_BEFORE_COMMIT");

    const [observationTotal] = await db.select({ value: count() }).from(marketObservations)
      .where(eq(marketObservations.provider, "suipump-public-api+sui-rpc"));
    const [verifiedTotal] = await db.select({ value: count() }).from(assets)
      .where(and(
        eq(assets.status, "verified_observe"),
        eq(assets.network, "mainnet"),
        eq(assets.packageId, VERIFIED_WRITE_PACKAGE),
      ));
    await db.insert(collectorCheckpoints).values({
      collectorName: COLLECTOR,
      source: SOURCE,
      status: "RUNNING",
      lastCheckpoint: checkpoint,
      providerEventCount: String(stats.totalTrades),
      collectedObservationCount: observationTotal?.value ?? insertedThisRun,
      verifiedAssetCount: verifiedTotal?.value ?? verifiedAssetCount,
      startedAt: PROCESS_STARTED_AT,
      lastSuccessAt: new Date(),
      lastError: verificationErrors ? `${verificationErrors}/${attempted} object verifications failed in the current run` : null,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: collectorCheckpoints.collectorName,
      set: {
        status: "RUNNING",
        lastCheckpoint: checkpoint,
        providerEventCount: String(stats.totalTrades),
        collectedObservationCount: observationTotal?.value ?? 0,
        verifiedAssetCount: verifiedTotal?.value ?? verifiedAssetCount,
        startedAt: PROCESS_STARTED_AT,
        lastSuccessAt: new Date(),
        lastError: verificationErrors ? `${verificationErrors}/${attempted} object verifications failed in the current run` : null,
        updatedAt: new Date(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown collector error";
    if (!await renewLease(fencingToken)) {
      console.error(`[collector] stale worker suppressed status update: ${message}`);
      return;
    }
    await db.insert(collectorCheckpoints).values({
      collectorName: COLLECTOR,
      source: SOURCE,
      status: "DEGRADED",
      lastError: message.slice(0, 2_000),
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: collectorCheckpoints.collectorName,
      set: { status: "DEGRADED", lastError: message.slice(0, 2_000), updatedAt: new Date() },
    });
    console.error(`[collector] ${message}`);
  }
}

let timer: NodeJS.Timeout | undefined;
let collecting = false;
async function collectWithoutOverlap() {
  if (collecting) return;
  collecting = true;
  try {
    await collectOnce();
  } finally {
    collecting = false;
  }
}
export function startSuipumpCollector(): void {
  if (process.env.ACCUMULATION_COLLECTOR_ENABLED === "false" || timer) return;
  void collectWithoutOverlap();
  timer = setInterval(() => void collectWithoutOverlap(), INTERVAL_MS);
  timer.unref();
}