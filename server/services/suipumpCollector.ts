import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
const HOLDER = `collector-${randomUUID()}`;
const LEASE_MS = 90_000;
const INTERVAL_MS = 30_000;

const tokenSchema = z.object({
  curveId: z.string().regex(/^0x[0-9a-f]{64}$/i),
  tokenType: z.string().min(1),
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

async function acquireLease(): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const fencingToken = randomUUID();
  const [existing] = await db.select().from(workerLeases)
    .where(eq(workerLeases.workerName, COLLECTOR)).limit(1);
  if (existing && existing.expiresAt > now && existing.holder !== HOLDER) return false;
  await db.insert(workerLeases).values({
    id: `lease-${COLLECTOR}`,
    workerName: COLLECTOR,
    holder: HOLDER,
    fencingToken,
    expiresAt,
    renewedAt: now,
  }).onConflictDoUpdate({
    target: workerLeases.workerName,
    set: { holder: HOLDER, fencingToken, expiresAt, renewedAt: now },
  });
  return true;
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
  return {
    verified: packageExists && curveIsShared && curveMatchesPackage,
    packageExists,
    curveIsShared,
    curveMatchesPackage,
    curveType,
    curveVersion: curve?.version || null,
    packageVersion: pkg?.version || null,
  };
}

async function collectOnce(): Promise<void> {
  if (!await acquireLease()) return;
  const startedAt = new Date();
  try {
    const [rawTokens, rawStats] = await Promise.all([fetchJson("/tokens"), fetchJson("/stats")]);
    const tokens = z.array(tokenSchema).parse(rawTokens);
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
    let collectedObservationCount = 0;

    for (const token of tokens.slice(0, 50)) {
      const verification = await verifyOnChain(graphqlUrl, token).catch(() => null);
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
      await db.insert(marketObservations).values({
        id: `obs-${checkpoint}-${token.curveId.slice(2)}`,
        assetId: id,
        checkpoint,
        observedAt: startedAt,
        provider: "suipump-public-api+sui-rpc",
        coverageStatus: "PARTIAL",
        data: { token, verification, providerTotals: { totalTrades: stats.totalTrades, tokenCount: stats.tokenCount } },
      }).onConflictDoNothing();
      collectedObservationCount++;

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

    await db.insert(collectorCheckpoints).values({
      collectorName: COLLECTOR,
      source: SOURCE,
      status: "RUNNING",
      lastCheckpoint: checkpoint,
      providerEventCount: String(stats.totalTrades),
      collectedObservationCount,
      verifiedAssetCount,
      startedAt,
      lastSuccessAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: collectorCheckpoints.collectorName,
      set: {
        status: "RUNNING",
        lastCheckpoint: checkpoint,
        providerEventCount: String(stats.totalTrades),
        collectedObservationCount: sql`${collectorCheckpoints.collectedObservationCount} + ${collectedObservationCount}`,
        verifiedAssetCount,
        lastSuccessAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown collector error";
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
export function startSuipumpCollector(): void {
  if (process.env.ACCUMULATION_COLLECTOR_ENABLED === "false" || timer) return;
  void collectOnce();
  timer = setInterval(() => void collectOnce(), INTERVAL_MS);
  timer.unref();
}