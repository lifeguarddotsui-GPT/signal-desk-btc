import { createHash } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  assets,
  candidateRankings,
  collectorCheckpoints,
  decisions,
  marketEvents,
  marketObservations,
  protocolManifests,
  workerLeases,
} from "../../shared/schema";

type HealthStatus = "HEALTHY" | "DEGRADED" | "BLOCKED" | "UNKNOWN";
export type HealthContract = {
  status: HealthStatus;
  checkedAt: string;
  lastSuccessAt: string | null;
  lastCheckpoint: string | null;
  lagSeconds: number | null;
  evidenceCount: number;
  reason: string | null;
  version: string;
};

const checkedAt = () => new Date().toISOString();
const health = (input: Omit<HealthContract, "checkedAt" | "version">, version = "health-v1"): HealthContract => ({
  ...input, checkedAt: checkedAt(), version,
});

export async function getOperationalHealth() {
  const now = Date.now();
  const [checkpoint] = await db.select().from(collectorCheckpoints)
    .where(eq(collectorCheckpoints.collectorName, "suipump-mainnet")).limit(1);
  const [lease] = await db.select().from(workerLeases)
    .where(eq(workerLeases.workerName, "suipump-mainnet")).limit(1);
  const [events] = await db.select({ value: count() }).from(marketEvents);
  const [observations] = await db.select({ value: count() }).from(marketObservations)
    .where(eq(marketObservations.provider, "suipump-public-api+sui-rpc"));
  const lagSeconds = checkpoint?.lastSuccessAt ? Math.max(0, Math.floor((now - checkpoint.lastSuccessAt.getTime()) / 1000)) : null;
  const leaseCurrent = Boolean(lease && lease.expiresAt.getTime() > now);
  const eventsPersisted = (events?.value ?? 0) > 0;
  const replayFunctional = false;
  const collectorReason = !leaseCurrent ? "Collector lease is absent or expired."
    : !eventsPersisted ? "No chain-derived raw events have been persisted."
    : !replayFunctional ? "Checkpoint replay is not yet proven."
    : lagSeconds === null || lagSeconds > 120 ? "Newest verified data exceeds the permitted lag."
    : null;
  const collector = health({
    status: collectorReason ? "BLOCKED" : "HEALTHY",
    lastSuccessAt: checkpoint?.lastSuccessAt?.toISOString() ?? null,
    lastCheckpoint: checkpoint?.lastCheckpoint ?? null,
    lagSeconds,
    evidenceCount: events?.value ?? 0,
    reason: collectorReason,
  }, "collector-health-v2");
  const database = health({
    status: "HEALTHY",
    lastSuccessAt: checkedAt(),
    lastCheckpoint: null,
    lagSeconds: 0,
    evidenceCount: observations?.value ?? 0,
    reason: null,
  }, "postgres-health-v1");
  const blocked = (reason: string, version: string) => health({
    status: "BLOCKED" as const, lastSuccessAt: null, lastCheckpoint: checkpoint?.lastCheckpoint ?? null,
    lagSeconds, evidenceCount: 0, reason,
  }, version);
  return {
    checkedAt: checkedAt(),
    collector,
    database,
    suiProvider: blocked("Provider-specific checkpoint advancement and agreement with raw Suipump events are not proven.", "sui-provider-v1"),
    suipumpAdapter: blocked("Discovery observations exist, but buy/sell routes and source reconciliation are unverified.", "suipump-adapter-v1"),
    replay: blocked("Durable raw-event checkpoint replay has not been implemented.", "replay-v1"),
    paperWorker: blocked("No executable quote and simulation route is verified.", "paper-worker-v1"),
    mainnetExecutor: blocked("Mainnet execution is disabled until signer custody and a funded round-trip canary pass.", "executor-v1"),
    signer: blocked("No isolated KMS/HSM-backed per-user signer is configured.", "signer-v1"),
    riskPolicy: {
      version: "canary-v1",
      maxOpenPositions: 2,
      leverageAllowed: false,
      averageDownAllowed: false,
      gasWithdrawalReserve: "max(1 SUI, 20%)",
      maxInitialOrderSui: "0.1",
      maxSlippagePct: 3,
      maxEntryImpactPct: 2,
      maxExitImpactPct: 5,
      maxQuoteAgeSeconds: 5,
      dailyLossLimitPct: 5,
      circuitBreakerFailures: 3,
    },
  };
}

const STRATEGY_VERSION = "candidate-v1";
export function validatedManifests(manifests: Array<typeof protocolManifests.$inferSelect>) {
  const valid = new Map<string, { checksum: string; validFromCheckpoint: bigint }>();
  for (const row of manifests) {
    const manifest = row.manifest as any;
    const evidence = Array.isArray(manifest?.evidenceTransactions) ? manifest.evidenceTransactions : [];
    const buyDigests = evidence.filter((item: any) => item?.kind === "BUY").map((item: any) => item?.digest);
    const sellDigests = evidence.filter((item: any) => item?.kind === "SELL").map((item: any) => item?.digest);
    const buySet = new Set(buyDigests);
    const sellSet = new Set(sellDigests);
    const rowDigests = Array.isArray(row.evidenceDigests) ? row.evidenceDigests as unknown[] : [];
    const validDigest = (value: unknown) => typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(value);
    const evidenceSet = new Set([...buyDigests, ...sellDigests]);
    const rowSet = new Set(rowDigests);
    const digestsValid = rowDigests.length >= 4
      && rowSet.size === rowDigests.length
      && rowDigests.every(validDigest)
      && buySet.size >= 2 && sellSet.size >= 2
      && Array.from(buySet).every((digest) => !sellSet.has(digest))
      && evidenceSet.size === rowSet.size
      && Array.from(evidenceSet).every((digest) => rowSet.has(digest));
    const checksumMatches = createHash("sha256").update(JSON.stringify(manifest)).digest("hex") === row.checksum;
    const complete = row.network === "mainnet"
      && row.status === "VERIFIED_ON_CHAIN"
      && manifest?.enabled === true
      && manifest?.packageId?.toLowerCase() === row.packageId.toLowerCase()
      && typeof row.definingPackageId === "string"
      && manifest?.definingPackageId?.toLowerCase() === row.definingPackageId.toLowerCase()
      && typeof manifest?.packageVersion === "string"
      && typeof manifest?.module === "string"
      && manifest?.buyFunctionTarget?.startsWith(`${row.packageId}::${manifest.module}::`)
      && manifest?.sellFunctionTarget?.startsWith(`${row.packageId}::${manifest.module}::`)
      && manifest?.buyEventType?.startsWith(`${row.packageId}::`)
      && manifest?.sellEventType?.startsWith(`${row.packageId}::`)
      && typeof manifest?.curveObjectType === "string"
      && typeof row.validFromCheckpoint === "string"
      && /^\d+$/.test(row.validFromCheckpoint)
      && digestsValid;
    if (checksumMatches && complete) valid.set(row.packageId.toLowerCase(), {
      checksum: row.checksum,
      validFromCheckpoint: BigInt(row.validFromCheckpoint!),
    });
  }
  return valid;
}

export function manifestAuthorizesCheckpoint(
  manifests: Map<string, { checksum: string; validFromCheckpoint: bigint }>,
  packageId: string,
  checkpoint: string,
) {
  const manifest = manifests.get(packageId.toLowerCase());
  return Boolean(manifest && /^\d+$/.test(checkpoint) && BigInt(checkpoint) >= manifest.validFromCheckpoint);
}
export async function getCandidates() {
  const manifestLead = {
    network: "mainnet",
    packageId: "0xb205fea41ccedac051bc66498e6ca68cb802c4a6ea06da12e524bed09c80d9b0",
    definingPackageId: null,
    packageVersion: null,
    module: null,
    buyFunctionTarget: null,
    sellFunctionTarget: null,
    buyEventType: null,
    sellEventType: null,
    launchEventType: null,
    graduationEventType: null,
    curveObjectType: "bonding_curve::Curve",
    initialSharedVersionResolution: "provider discovery corroborated by shared-object lookup",
    tokenTypeResolution: "exact generic type match from Sui object",
    requiredObjects: [],
    feeObjects: [],
    enabled: false,
  };
  const manifestChecksum = createHash("sha256").update(JSON.stringify(manifestLead)).digest("hex");
  await db.insert(protocolManifests).values({
    id: `manifest-lead-${manifestChecksum.slice(0, 24)}`,
    network: "mainnet",
    packageId: manifestLead.packageId,
    version: "lead-v1",
    manifest: manifestLead,
    checksum: manifestChecksum,
    status: "UNRESOLVED",
    evidenceDigests: [],
  }).onConflictDoNothing();
  const rows = await db.select({
    asset: assets,
    observation: marketObservations,
  }).from(assets).innerJoin(marketObservations, eq(marketObservations.assetId, assets.id))
    .orderBy(desc(marketObservations.observedAt)).limit(5000);
  const manifests = await db.select().from(protocolManifests);
  const verifiedManifests = validatedManifests(manifests);
  const manifestAuthorizationVersion = createHash("sha256").update(
    Array.from(verifiedManifests.entries()).sort().map(([pkg, item]) => `${pkg}:${item.checksum}:${item.validFromCheckpoint}`).join("|") || "no-authorized-manifests",
  ).digest("hex").slice(0, 16);
  const strategyVersion = `${STRATEGY_VERSION}-${manifestAuthorizationVersion}`;
  const seen = new Set<string>();
  const candidates = [];
  for (const row of rows) {
    if (seen.has(row.asset.id)) continue;
    seen.add(row.asset.id);
    const data = row.observation.data as any;
    const token = data?.token ?? {};
    const lineageVerified = manifestAuthorizesCheckpoint(verifiedManifests, row.asset.packageId, row.observation.checkpoint);
    const components = {
      protocolLineage: lineageVerified ? 20 : 0,
      entryExitExecutability: 0,
      liquidityDepth: 0,
      priceImpact: 0,
      volumeAcceleration: 0,
      uniqueBuyerGrowth: 0,
      buySellFlow: 0,
      tradeRecency: 0,
      creatorBehavior: 0,
      holderConcentration: 0,
      clusteringRisk: 0,
      launchAge: 0,
      graduation: 0,
    };
    const hardVetoes = [
      ...(!lineageVerified ? ["UNVERIFIED_PROTOCOL_LINEAGE"] : []),
      "SELL_TRANSACTION_UNCONSTRUCTABLE",
      "EXIT_QUOTE_UNAVAILABLE",
      "HOLDER_DATA_UNAVAILABLE",
      "EVENT_HISTORY_UNRECONCILED",
    ];
    const score = Object.values(components).reduce((a, b) => a + b, 0);
    const snapshot = {
      curveId: row.asset.curveId,
      tokenType: row.asset.coinType,
      packageId: row.asset.packageId,
      module: "UNAVAILABLE",
      creatorAddress: null,
      launchTransactionDigest: null,
      creationCheckpoint: row.observation.checkpoint,
      creationTimestamp: token.createdAt ?? null,
      initialSharedVersion: token.initialSharedVersion ?? null,
      graduationState: null,
      reserveLiquidity: null,
      entryQuote: null,
      exitQuote: null,
      quoteCheckpoint: null,
      quoteAgeSeconds: null,
      priceImpactPct: null,
      holderConcentration: null,
      uniqueBuyers: null,
      buySellImbalance: token.stats?.buys != null && token.stats?.sells != null ? token.stats.buys - token.stats.sells : null,
      volumeSui: token.stats?.volume_sui ?? null,
      lastTradeTimestamp: token.stats?.last_trade_time ?? null,
      verifiedLineage: lineageVerified,
      explorerUrl: `https://suiscan.xyz/mainnet/object/${row.asset.curveId}`,
    };
    const id = `rank-${createHash("sha256").update(`${row.asset.id}:${row.observation.checkpoint}:${strategyVersion}`).digest("hex").slice(0, 40)}`;
    const inserted = await db.insert(candidateRankings).values({
      id, assetId: row.asset.id, checkpoint: row.observation.checkpoint, strategyVersion,
      score, components, hardVetoes, snapshot,
    }).onConflictDoNothing().returning();
    const persisted = inserted[0] ?? (await db.select().from(candidateRankings).where(eq(candidateRankings.id, id)).limit(1))[0];
    const persistedSnapshot = persisted.snapshot as typeof snapshot;
    const persistedVetoes = persisted.hardVetoes as string[];
    candidates.push({ id: persisted.id, assetId: persisted.assetId, score: persisted.score, components: persisted.components, hardVetoes: persistedVetoes, eligible: persistedVetoes.length === 0, ...persistedSnapshot });
  }
  candidates.sort((a, b) => b.score - a.score || a.curveId.localeCompare(b.curveId));
  return { strategyVersion, generatedAt: checkedAt(), candidates };
}

export async function getMarkets() {
  const candidates = await getCandidates();
  return candidates.candidates.map((item) => ({
    curveId: item.curveId, tokenType: item.tokenType, packageId: item.packageId,
    lastTradeTimestamp: item.lastTradeTimestamp, volumeSui: item.volumeSui,
    verifiedLineage: item.verifiedLineage, explorerUrl: item.explorerUrl,
  }));
}

export async function getMarket(curveId: string) {
  const markets = await getCandidates();
  return markets.candidates.find((item) => item.curveId.toLowerCase() === curveId.toLowerCase()) ?? null;
}

export async function getPublicActivity() {
  const [events, recentDecisions] = await Promise.all([
    db.select().from(marketEvents).orderBy(desc(marketEvents.occurredAt)).limit(50),
    db.select().from(decisions).where(eq(decisions.campaignId, "observe-mainnet")).orderBy(desc(decisions.createdAt)).limit(50),
  ]);
  return {
    generatedAt: checkedAt(),
    events: events.map((item) => ({ id: item.eventId, type: item.eventType, checkpoint: item.checkpoint, digest: item.txDigest, occurredAt: item.occurredAt })),
    decisions: recentDecisions.map((item) => ({ id: item.id, action: item.action, policyVersion: item.policyVersion, outcome: item.outcome, createdAt: item.createdAt })),
  };
}