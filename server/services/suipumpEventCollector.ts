import { randomUUID } from "node:crypto";
import { and, eq, gt, lte, or } from "drizzle-orm";
import { db } from "../db";
import {
  assets,
  collectorCheckpoints,
  collectorDeadLetters,
  marketEvents,
  workerLeases,
} from "../../shared/schema";

const COLLECTOR = "suipump-events-mainnet";
const DISCOVERY_COLLECTOR = "suipump-mainnet";
const PACKAGE = "0xb205fea41ccedac051bc66498e6ca68cb802c4a6ea06da12e524bed09c80d9b0";
const MODULE = "bonding_curve";
const GRAPHQL_SOURCE = "https://graphql.mainnet.sui.io/graphql";
const HOLDER = `event-collector-${randomUUID()}`;
const LEASE_MS = 45_000;
const INTERVAL_MS = 15_000;
const BOOTSTRAP_CHECKPOINTS = BigInt(2_000);
const PAGE_SIZE = 50;

type ChainEvent = {
  sequenceNumber: number;
  timestamp: string | null;
  sender?: { address?: string };
  contents?: { type?: { repr?: string }; json?: Record<string, unknown> };
  transaction?: {
    digest?: string;
    sender?: { address?: string };
    effects?: {
      status?: string;
      timestamp?: string;
      checkpoint?: { sequenceNumber?: number };
      balanceChangesJson?: Array<{ address?: string; coinType?: string; amount?: string }>;
    };
  };
  transactionModule?: { name?: string; package?: { address?: string } };
};

async function acquireLease(): Promise<string | null> {
  const now = new Date();
  const fencingToken = randomUUID();
  const acquired = await db.insert(workerLeases).values({
    id: `lease-${COLLECTOR}`, workerName: COLLECTOR, holder: HOLDER, fencingToken,
    expiresAt: new Date(now.getTime() + LEASE_MS), renewedAt: now,
  }).onConflictDoUpdate({
    target: workerLeases.workerName,
    set: { holder: HOLDER, fencingToken, expiresAt: new Date(now.getTime() + LEASE_MS), renewedAt: now },
    setWhere: or(lte(workerLeases.expiresAt, now), eq(workerLeases.holder, HOLDER)),
  }).returning({ holder: workerLeases.holder });
  return acquired[0]?.holder === HOLDER ? fencingToken : null;
}

async function renewLease(fencingToken: string) {
  const now = new Date();
  const rows = await db.update(workerLeases).set({
    expiresAt: new Date(now.getTime() + LEASE_MS), renewedAt: now,
  }).where(and(
    eq(workerLeases.workerName, COLLECTOR),
    eq(workerLeases.holder, HOLDER),
    eq(workerLeases.fencingToken, fencingToken),
    gt(workerLeases.expiresAt, now),
  )).returning({ id: workerLeases.id });
  return rows.length === 1;
}

async function queryEvents(afterCheckpoint: string, after: string | null) {
  const graphqlUrl = process.env.SUI_GRAPHQL_URL || GRAPHQL_SOURCE;
  const query = `query Events($afterCheckpoint: UInt53!, $after: String) {
    events(first: ${PAGE_SIZE}, after: $after, filter: {
      module: "${PACKAGE}::${MODULE}", afterCheckpoint: $afterCheckpoint
    }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        sequenceNumber timestamp sender { address }
        contents { type { repr } json }
        transaction {
          digest sender { address }
          effects { status timestamp checkpoint { sequenceNumber } balanceChangesJson }
        }
        transactionModule { name package { address } }
      }
    }
  }`;
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "blue-water-event-collector/1.0" },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({ query, variables: { afterCheckpoint: Number(afterCheckpoint), after } }),
  });
  if (!response.ok) throw new Error(`SUI_GRAPHQL_HTTP_${response.status}`);
  const body = await response.json() as {
    data?: { events?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: ChainEvent[] } };
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) throw new Error(`SUI_GRAPHQL_ERROR:${body.errors[0]?.message || "unknown"}`);
  if (!body.data?.events) throw new Error("SUI_GRAPHQL_EVENTS_MISSING");
  return body.data.events;
}

function eventAsset(event: ChainEvent) {
  const payload = event.contents?.json || {};
  const curveId = typeof payload.curve_id === "string" ? payload.curve_id : null;
  const changes = event.transaction?.effects?.balanceChangesJson || [];
  const tokenTypes = Array.from(new Set(changes
    .map((item) => item.coinType)
    .filter((coinType): coinType is string => typeof coinType === "string" && !coinType.endsWith("::sui::SUI"))));
  return { curveId, tokenType: tokenTypes.length === 1 ? tokenTypes[0] : null };
}

function rejectEvent(code: string, event: ChainEvent, checkpoint: string | null): never {
  const error = new Error(code) as Error & { deadLetter?: { code: string; event: ChainEvent; checkpoint: string | null } };
  error.deadLetter = { code, event, checkpoint };
  throw error;
}

async function deadLetter(errorCode: string, sourceId: string | null, payload: unknown, checkpoint: string | null, executor: any = db) {
  const id = `dead-${COLLECTOR}-${sourceId || randomUUID()}`;
  await executor.insert(collectorDeadLetters).values({
    id, collectorName: COLLECTOR, checkpoint, sourceId, errorCode, payload,
  }).onConflictDoUpdate({
    target: collectorDeadLetters.id,
    set: { attempts: 2, updatedAt: new Date(), payload },
  });
}

async function persistEvent(event: ChainEvent, executor: any = db) {
  const digest = event.transaction?.digest;
  const checkpoint = event.transaction?.effects?.checkpoint?.sequenceNumber;
  const eventType = event.contents?.type?.repr;
  const sequence = event.sequenceNumber;
  const occurredAtValue = event.timestamp || event.transaction?.effects?.timestamp;
  if (!digest || checkpoint == null || !eventType || sequence == null || !occurredAtValue) {
    rejectEvent("MALFORMED_CHAIN_EVENT", event, checkpoint == null ? null : String(checkpoint));
  }
  if (event.transaction?.effects?.status !== "SUCCESS") {
    rejectEvent("UNSUCCESSFUL_TRANSACTION_EVENT", event, String(checkpoint));
  }
  const observedPackage = event.transactionModule?.package?.address;
  if (observedPackage?.toLowerCase() !== PACKAGE) {
    rejectEvent("EVENT_PACKAGE_MISMATCH", event, String(checkpoint));
  }
  const { curveId, tokenType } = eventAsset(event);
  const isTradeEvent = eventType.endsWith("::TokensPurchased") || eventType.endsWith("::TokensSold");
  if ((isTradeEvent && (!curveId || !tokenType)) || (curveId && !/^0x[0-9a-f]{64}$/i.test(curveId))) {
    rejectEvent("EVENT_ASSET_IDENTITY_AMBIGUOUS", event, String(checkpoint));
  }
  const reconciledPackage = observedPackage as string;
  const assetId = curveId ? `suipump-${curveId.slice(2)}` : null;
  const [asset] = assetId && curveId ? await executor.select().from(assets).where(and(
    eq(assets.id, assetId), eq(assets.curveId, curveId), eq(assets.packageId, reconciledPackage),
    ...(isTradeEvent && tokenType ? [eq(assets.coinType, tokenType)] : []),
  )).limit(1) : [];
  if (!asset && isTradeEvent) {
    rejectEvent("EVENT_ASSET_NOT_RECONCILED", event, String(checkpoint));
  }
  const reconciledAssetId = asset ? assetId : null;
  const eventId = `${digest}:${sequence}`;
  const payload = event.contents?.json || {};
  const inserted = await executor.insert(marketEvents).values({
    id: `event-${digest}-${sequence}`,
    eventId,
    assetId: reconciledAssetId,
    checkpoint: String(checkpoint),
    eventType,
    txDigest: digest,
    provider: "sui-mainnet-graphql",
    payload: {
      ...payload,
      eventSequence: sequence,
      sender: event.sender?.address || event.transaction?.sender?.address || null,
      packageId: event.transactionModule?.package?.address || PACKAGE,
      module: event.transactionModule?.name || MODULE,
      balanceChanges: event.transaction?.effects?.balanceChangesJson || [],
      source: "sui-mainnet-graphql",
    },
    occurredAt: new Date(occurredAtValue as string),
  }).onConflictDoNothing().returning({ id: marketEvents.id });
  return { inserted: inserted.length, checkpoint: String(checkpoint) };
}

export async function collectSuipumpEventsOnce(): Promise<void> {
  const fencingToken = await acquireLease();
  if (!fencingToken) return;
  const [current, discovery] = await Promise.all([
    db.select().from(collectorCheckpoints).where(eq(collectorCheckpoints.collectorName, COLLECTOR)).limit(1),
    db.select().from(collectorCheckpoints).where(eq(collectorCheckpoints.collectorName, DISCOVERY_COLLECTOR)).limit(1),
  ]);
  const persisted = current[0];
  const discoveryCheckpoint = discovery[0]?.lastCheckpoint;
  if (!persisted?.lastCompleteCheckpoint && (!discoveryCheckpoint || !/^\d+$/.test(discoveryCheckpoint))) return;
  const bootstrap = !persisted?.lastCompleteCheckpoint;
  const replayFrom = bootstrap
    ? (BigInt(discoveryCheckpoint!) > BOOTSTRAP_CHECKPOINTS ? BigInt(discoveryCheckpoint!) - BOOTSTRAP_CHECKPOINTS : BigInt(0)).toString()
    : persisted.lastCompleteCheckpoint!;
  let cursor: string | null = null;
  let highest = replayFrom;
  let inserted = 0;
  const durableReplayOrigin = persisted?.replayFromCheckpoint || replayFrom;
  const completeReplayStatus = durableReplayOrigin === "0" ? "CONTIGUOUS" : "CONTIGUOUS_FROM_BOOTSTRAP";
  try {
    do {
      if (!await renewLease(fencingToken)) throw new Error("EVENT_COLLECTOR_LEASE_LOST");
      const page = await queryEvents(replayFrom, cursor);
      try {
        await db.transaction(async (tx) => {
        const now = new Date();
        const fenced = await tx.update(workerLeases).set({
          expiresAt: new Date(now.getTime() + LEASE_MS), renewedAt: now,
        }).where(and(
          eq(workerLeases.workerName, COLLECTOR), eq(workerLeases.holder, HOLDER),
          eq(workerLeases.fencingToken, fencingToken),
          gt(workerLeases.expiresAt, now),
        )).returning({ id: workerLeases.id });
        if (fenced.length !== 1) throw new Error("EVENT_COLLECTOR_LEASE_LOST_DURING_PAGE");
        for (const event of page.nodes || []) {
          const saved = await persistEvent(event, tx);
          inserted += saved.inserted;
          if (saved.checkpoint && BigInt(saved.checkpoint) > BigInt(highest)) highest = saved.checkpoint;
        }
        });
      } catch (error) {
        const detail = error as Error & { deadLetter?: { code: string; event: ChainEvent; checkpoint: string | null } };
        if (detail.deadLetter) {
          const digest = detail.deadLetter.event.transaction?.digest;
          const sequence = detail.deadLetter.event.sequenceNumber;
          await deadLetter(detail.deadLetter.code, digest ? `${digest}:${sequence}` : null, detail.deadLetter.event, detail.deadLetter.checkpoint);
        }
        throw error;
      }
      cursor = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor || null : null;
      if (page.pageInfo?.hasNextPage && !cursor) throw new Error("EVENT_CURSOR_MISSING");
    } while (cursor);
    await db.transaction(async (tx) => {
      const now = new Date();
      const fenced = await tx.update(workerLeases).set({
        expiresAt: new Date(now.getTime() + LEASE_MS), renewedAt: now,
      }).where(and(
        eq(workerLeases.workerName, COLLECTOR), eq(workerLeases.holder, HOLDER),
        eq(workerLeases.fencingToken, fencingToken), gt(workerLeases.expiresAt, now),
      )).returning({ id: workerLeases.id });
      if (fenced.length !== 1) throw new Error("EVENT_COLLECTOR_LEASE_LOST_BEFORE_COMMIT");
      await tx.insert(collectorCheckpoints).values({
      collectorName: COLLECTOR,
      source: process.env.SUI_GRAPHQL_URL || GRAPHQL_SOURCE,
      status: "RUNNING",
      lastCheckpoint: highest,
      lastCompleteCheckpoint: highest,
      replayFromCheckpoint: persisted?.replayFromCheckpoint || replayFrom,
      replayStatus: completeReplayStatus,
      gapCount: 0,
      providerEventCount: String(inserted),
      startedAt: new Date(),
      lastSuccessAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
      }).onConflictDoUpdate({
      target: collectorCheckpoints.collectorName,
      set: {
        status: "RUNNING", lastCheckpoint: highest, lastCompleteCheckpoint: highest,
        replayFromCheckpoint: persisted?.replayFromCheckpoint || replayFrom,
        replayStatus: completeReplayStatus,
        gapCount: 0, providerEventCount: String(inserted), lastSuccessAt: new Date(), lastError: null, updatedAt: new Date(),
      },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown event collector error";
    await deadLetter("EVENT_REPLAY_FAILED", replayFrom, { message }, highest);
    if (await renewLease(fencingToken)) {
      await db.insert(collectorCheckpoints).values({
        collectorName: COLLECTOR, source: process.env.SUI_GRAPHQL_URL || GRAPHQL_SOURCE,
        status: "DEGRADED", replayStatus: "INTERRUPTED", gapCount: 1, lastError: message, updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: collectorCheckpoints.collectorName,
        set: { status: "DEGRADED", replayStatus: "INTERRUPTED", gapCount: 1, lastError: message, updatedAt: new Date() },
      });
    }
    console.error(`[event-collector] ${message}`);
  }
}

let timer: NodeJS.Timeout | undefined;
let collecting = false;
async function runWithoutOverlap() {
  if (collecting) return;
  collecting = true;
  try { await collectSuipumpEventsOnce(); } finally { collecting = false; }
}

export function startSuipumpEventCollector() {
  if (process.env.ACCUMULATION_EVENT_COLLECTOR_ENABLED === "false" || timer) return;
  void runWithoutOverlap();
  timer = setInterval(() => void runWithoutOverlap(), INTERVAL_MS);
  timer.unref();
}