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
  const [discoveryCheckpoint] = await db.select().from(collectorCheckpoints)
    .where(eq(collectorCheckpoints.collectorName, "suipump-mainnet")).limit(1);
  const [eventCheckpoint] = await db.select().from(collectorCheckpoints)
    .where(eq(collectorCheckpoints.collectorName, "suipump-events-mainnet")).limit(1);
  const [lease] = await db.select().from(workerLeases)
    .where(eq(workerLeases.workerName, "suipump-events-mainnet")).limit(1);
  const [events] = await db.select({ value: count() }).from(marketEvents)
    .where(eq(marketEvents.provider, "sui-mainnet-graphql"));
  const [observations] = await db.select({ value: count() }).from(marketObservations)
    .where(eq(marketObservations.provider, "suipump-public-api+sui-rpc"));
  const lagSeconds = eventCheckpoint?.lastSuccessAt ? Math.max(0, Math.floor((now - eventCheckpoint.lastSuccessAt.getTime()) / 1000)) : null;
  const leaseCurrent = Boolean(lease && lease.expiresAt.getTime() > now);
  const eventsPersisted = (events?.value ?? 0) > 0;
  const replayFunctional = eventCheckpoint?.replayStatus === "CONTIGUOUS" && eventCheckpoint.gapCount === 0;
  const collectorReason = !leaseCurrent ? "Collector lease is absent or expired."
    : !eventsPersisted ? "No chain-derived raw events have been persisted."
    : !replayFunctional ? `Raw events are current, but replay is ${eventCheckpoint?.replayStatus || "UNPROVEN"} from checkpoint ${eventCheckpoint?.replayFromCheckpoint || "Unavailable"}.`
    : lagSeconds === null || lagSeconds > 120 ? "Newest verified data exceeds the permitted lag."
    : null;
  const collector = health({
    status: collectorReason ? (eventsPersisted ? "DEGRADED" : "BLOCKED") : "HEALTHY",
    lastSuccessAt: eventCheckpoint?.lastSuccessAt?.toISOString() ?? null,
    lastCheckpoint: eventCheckpoint?.lastCompleteCheckpoint ?? null,
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
    status: "BLOCKED" as const, lastSuccessAt: null, lastCheckpoint: eventCheckpoint?.lastCompleteCheckpoint ?? null,
    lagSeconds, evidenceCount: 0, reason,
  }, version);
  const providerStatus = eventsPersisted && lagSeconds !== null && lagSeconds <= 120 ? "HEALTHY" : "BLOCKED";
  const replay = health({
    status: replayFunctional ? "HEALTHY" : eventsPersisted ? "DEGRADED" : "BLOCKED",
    lastSuccessAt: eventCheckpoint?.lastSuccessAt?.toISOString() ?? null,
    lastCheckpoint: eventCheckpoint?.lastCompleteCheckpoint ?? null,
    lagSeconds,
    evidenceCount: events?.value ?? 0,
    reason: replayFunctional ? null : eventCheckpoint?.replayStatus === "CONTIGUOUS_FROM_BOOTSTRAP"
      ? `Restart-safe replay is active from bootstrap checkpoint ${eventCheckpoint.replayFromCheckpoint}; earlier package history is not yet backfilled.`
      : "Durable raw-event checkpoint replay has not completed.",
  }, "replay-v2");
  return {
    checkedAt: checkedAt(),
    collector,
    database,
    suiProvider: health({
      status: providerStatus,
      lastSuccessAt: eventCheckpoint?.lastSuccessAt?.toISOString() ?? null,
      lastCheckpoint: eventCheckpoint?.lastCompleteCheckpoint ?? null,
      lagSeconds,
      evidenceCount: events?.value ?? 0,
      reason: providerStatus === "HEALTHY" ? null : "No recent successful Sui GraphQL event ingestion is available.",
    }, "sui-provider-v2"),
    suipumpAdapter: health({
      status: eventsPersisted ? "DEGRADED" : "BLOCKED",
      lastSuccessAt: eventCheckpoint?.lastSuccessAt?.toISOString() ?? discoveryCheckpoint?.lastSuccessAt?.toISOString() ?? null,
      lastCheckpoint: eventCheckpoint?.lastCompleteCheckpoint ?? discoveryCheckpoint?.lastCheckpoint ?? null,
      lagSeconds,
      evidenceCount: events?.value ?? 0,
      reason: "Discovery and raw trade events are reconciled by curve, but executable buy/sell builders remain unverified.",
    }, "suipump-adapter-v2"),
    replay,
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

const STRATEGY_VERSION = "candidate-v2";
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
export async function getCandidates(limit?: number) {
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
  const [rows, manifests, chainEvents, eventCheckpoint] = await Promise.all([
    db.select({ asset: assets, observation: marketObservations })
      .from(assets).innerJoin(marketObservations, eq(marketObservations.assetId, assets.id))
      .orderBy(desc(marketObservations.observedAt)).limit(5000),
    db.select().from(protocolManifests),
    db.select().from(marketEvents).where(eq(marketEvents.provider, "sui-mainnet-graphql"))
      .orderBy(desc(marketEvents.occurredAt)).limit(5000),
    db.select().from(collectorCheckpoints).where(eq(collectorCheckpoints.collectorName, "suipump-events-mainnet")).limit(1),
  ]);
  const eventsByAsset = new Map<string, typeof chainEvents>();
  for (const event of chainEvents) {
    if (!event.assetId) continue;
    const current = eventsByAsset.get(event.assetId) || [];
    current.push(event);
    eventsByAsset.set(event.assetId, current);
  }
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
    const events = (eventsByAsset.get(row.asset.id) || []).filter((event) => event.occurredAt.getTime() <= row.observation.observedAt.getTime());
    const anchor = row.observation.observedAt.getTime();
    const eventPayload = (event: typeof chainEvents[number]) => event.payload as Record<string, unknown>;
    const eventSui = (event: typeof chainEvents[number]) => {
      const payload = eventPayload(event);
      const raw = payload.sui_in ?? payload.sui_out;
      const value = typeof raw === "string" ? Number(raw) / 1_000_000_000 : 0;
      return Number.isFinite(value) ? value : 0;
    };
    const within = (minutes: number) => events.filter((event) => anchor - event.occurredAt.getTime() <= minutes * 60_000);
    const events1m = within(1);
    const events5m = within(5);
    const events15m = within(15);
    const buys5m = events5m.filter((event) => event.eventType.endsWith("::TokensPurchased"));
    const sells5m = events5m.filter((event) => event.eventType.endsWith("::TokensSold"));
    const buyVolume5m = buys5m.reduce((sum, event) => sum + eventSui(event), 0);
    const sellVolume5m = sells5m.reduce((sum, event) => sum + eventSui(event), 0);
    const volume1m = events1m.reduce((sum, event) => sum + eventSui(event), 0);
    const volume15m = events15m.reduce((sum, event) => sum + eventSui(event), 0);
    const uniqueBuyers = (input: typeof chainEvents) => new Set(input.map((event) => {
      const payload = eventPayload(event);
      return typeof payload.buyer === "string" ? payload.buyer : null;
    }).filter(Boolean)).size;
    const buyers5m = uniqueBuyers(buys5m);
    const buyers15m = uniqueBuyers(events15m.filter((event) => event.eventType.endsWith("::TokensPurchased")));
    const newestEvent = events[0];
    const recencySeconds = newestEvent ? Math.max(0, Math.floor((anchor - newestEvent.occurredAt.getTime()) / 1000)) : null;
    const createdAt = Number(token.createdAt);
    const launchAgeMinutes = Number.isFinite(createdAt) ? Math.max(0, (anchor - createdAt) / 60_000) : null;
    const reserve = Number(token.stats?.reserve_sui);
    const graduationTarget = Number(token.stats?.grad_threshold_sui ?? token.graduationTarget);
    const newestPayload = newestEvent ? eventPayload(newestEvent) : null;
    const chainReserve = newestPayload && typeof newestPayload.new_sui_reserve === "string"
      ? Number(newestPayload.new_sui_reserve) / 1_000_000_000 : null;
    const replayCoverageProven = eventCheckpoint[0]?.replayStatus === "CONTIGUOUS";
    const reservesReconciled = replayCoverageProven && chainReserve != null && Number.isFinite(reserve)
      && Math.abs(chainReserve - reserve) <= Math.max(0.000001, reserve * 0.000001);
    const lineageVerified = manifestAuthorizesCheckpoint(verifiedManifests, row.asset.packageId, row.observation.checkpoint);
    const components = {
      executableLiquidityExitDepth: 0,
      volumeAcceleration: volume15m > 0 ? Math.min(15, Math.round((volume1m / Math.max(volume15m / 15, 0.000001)) * 3)) : 0,
      uniqueBuyerGrowth: buyers15m > 0 ? Math.min(15, Math.round((buyers5m / buyers15m) * 15)) : 0,
      buySellFlow: buyVolume5m + sellVolume5m > 0 ? Math.min(10, Math.round((buyVolume5m / (buyVolume5m + sellVolume5m)) * 10)) : 0,
      tradeRecency: recencySeconds == null ? 0 : recencySeconds <= 60 ? 10 : recencySeconds <= 300 ? 8 : recencySeconds <= 900 ? 5 : 0,
      holderDistribution: 0,
      creatorAndClusterBehavior: 0,
      launchAge: launchAgeMinutes == null ? 0 : launchAgeMinutes <= 15 ? 5 : launchAgeMinutes <= 60 ? 4 : launchAgeMinutes <= 360 ? 2 : 1,
      graduation: Number.isFinite(reserve) && Number.isFinite(graduationTarget) && graduationTarget > 0
        ? Math.min(5, Math.round((reserve / graduationTarget) * 5)) : 0,
    };
    const hardVetoes = [
      ...(!lineageVerified ? ["UNVERIFIED_PROTOCOL_LINEAGE"] : []),
      "SELL_TRANSACTION_UNCONSTRUCTABLE",
      "EXIT_QUOTE_UNAVAILABLE",
      "HOLDER_DATA_UNAVAILABLE",
      ...(!reservesReconciled ? ["EVENT_HISTORY_UNRECONCILED"] : []),
    ];
    const score = Object.values(components).reduce((a, b) => a + b, 0);
    const snapshot = {
      curveId: row.asset.curveId,
      tokenType: row.asset.coinType,
      packageId: row.asset.packageId,
      module: "UNAVAILABLE",
      creatorAddress: token.creator ?? null,
      launchTransactionDigest: null,
      creationCheckpoint: null,
      creationTimestamp: token.createdAt ?? null,
      initialSharedVersion: token.initialSharedVersion ?? null,
      graduationState: token.graduated === true ? "GRADUATED" : token.graduated === false ? "BONDING_CURVE" : null,
      reserveLiquidity: Number.isFinite(reserve) ? reserve : null,
      chainReserveLiquidity: chainReserve,
      reservesReconciled,
      entryQuote: null,
      exitQuote: null,
      quoteCheckpoint: null,
      quoteAgeSeconds: null,
      priceImpactPct: null,
      holderConcentration: null,
      uniqueBuyers: buyers15m || null,
      buySellImbalance: token.stats?.buys != null && token.stats?.sells != null ? token.stats.buys - token.stats.sells : null,
      volumeSui: token.stats?.volume_sui ?? null,
      lastTradeTimestamp: token.stats?.last_trade_time ?? null,
      verifiedLineage: lineageVerified,
      explorerUrl: `https://suiscan.xyz/mainnet/object/${row.asset.curveId}`,
      asOf: row.observation.observedAt.toISOString(),
      checkpoint: newestEvent?.checkpoint ?? row.observation.checkpoint,
      source: events.length ? ["sui-mainnet-graphql", "suipump-public-api"] : ["suipump-public-api"],
      evidence: {
        rawEventCount: events.length,
        latestDigest: newestEvent?.txDigest ?? null,
        latestEventSequence: newestEvent ? eventPayload(newestEvent).eventSequence ?? null : null,
      },
      freshness: { ageSeconds: Math.max(0, Math.floor((Date.now() - row.observation.observedAt.getTime()) / 1000)) },
    };
    const rankingCheckpoint = `${row.observation.checkpoint}:${row.observation.observedAt.getTime()}`;
    const id = `rank-${createHash("sha256").update(`${row.asset.id}:${rankingCheckpoint}:${strategyVersion}`).digest("hex").slice(0, 40)}`;
    const inserted = await db.insert(candidateRankings).values({
      id, assetId: row.asset.id, checkpoint: rankingCheckpoint, strategyVersion,
      score, components, hardVetoes, snapshot,
    }).onConflictDoNothing().returning();
    const persisted = inserted[0] ?? (await db.select().from(candidateRankings).where(eq(candidateRankings.id, id)).limit(1))[0];
    const persistedSnapshot = persisted.snapshot as typeof snapshot;
    const persistedVetoes = persisted.hardVetoes as string[];
    candidates.push({ id: persisted.id, assetId: persisted.assetId, score: persisted.score, components: persisted.components, hardVetoes: persistedVetoes, eligible: persistedVetoes.length === 0, ...persistedSnapshot });
  }
  candidates.sort((a, b) => b.score - a.score || a.curveId.localeCompare(b.curveId));
  const generatedAt = checkedAt();
  const eligibleCandidates = candidates.filter((candidate) => candidate.eligible);
  const selected = typeof limit === "number"
    ? eligibleCandidates.slice(0, Math.max(0, Math.min(limit, 100)))
    : candidates;
  return {
    strategyVersion,
    generatedAt,
    asOf: generatedAt,
    checkpoint: eventCheckpoint[0]?.lastCompleteCheckpoint ?? null,
    source: ["sui-mainnet-graphql", "suipump-public-api"],
    evidence: { rawEventCount: chainEvents.length, candidateCount: candidates.length },
    freshness: { ageSeconds: eventCheckpoint[0]?.lastSuccessAt ? Math.max(0, Math.floor((Date.now() - eventCheckpoint[0].lastSuccessAt!.getTime()) / 1000)) : null },
    disposition: eligibleCandidates.length ? "QUALIFIED_ENTRIES_AVAILABLE" : "HOLD_SUI_NO_QUALIFIED_ENTRY",
    candidates: selected,
  };
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