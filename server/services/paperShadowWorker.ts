import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, lte, or } from "drizzle-orm";
import { db } from "../db";
import {
  campaigns,
  collectorCheckpoints,
  decisions,
  executionRecords,
  ledgerEntries,
  marketEvents,
  positions,
  workerLeases,
} from "../../shared/schema";

const WORKER = "paper-shadow-replay";
const HOLDER = `paper-shadow-${randomUUID()}`;
const LEASE_MS = 45_000;
const INTERVAL_MS = 15_000;
const MAX_ORDER_MIST = BigInt(100_000_000);
const MAX_OPEN_POSITIONS = 2;

type EventRow = typeof marketEvents.$inferSelect;

function payload(event: EventRow) {
  return event.payload as Record<string, unknown>;
}

function positiveBase(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > BigInt(0) ? parsed : null;
}

async function acquireLease(): Promise<string | null> {
  const now = new Date();
  const fencingToken = randomUUID();
  const rows = await db.insert(workerLeases).values({
    id: `lease-${WORKER}`, workerName: WORKER, holder: HOLDER, fencingToken,
    expiresAt: new Date(now.getTime() + LEASE_MS), renewedAt: now,
  }).onConflictDoUpdate({
    target: workerLeases.workerName,
    set: { holder: HOLDER, fencingToken, expiresAt: new Date(now.getTime() + LEASE_MS), renewedAt: now },
    setWhere: or(lte(workerLeases.expiresAt, now), eq(workerLeases.holder, HOLDER)),
  }).returning({ holder: workerLeases.holder });
  return rows[0]?.holder === HOLDER ? fencingToken : null;
}

async function renewLease(fencingToken: string) {
  const now = new Date();
  const rows = await db.update(workerLeases).set({
    expiresAt: new Date(now.getTime() + LEASE_MS), renewedAt: now,
  }).where(and(
    eq(workerLeases.workerName, WORKER), eq(workerLeases.holder, HOLDER),
    eq(workerLeases.fencingToken, fencingToken), gt(workerLeases.expiresAt, now),
  )).returning({ id: workerLeases.id });
  return rows.length === 1;
}

function cashMist(entries: Array<typeof ledgerEntries.$inferSelect>) {
  return entries.reduce((total, entry) => {
    if (entry.entryType === "PAPER_INITIAL_BALANCE" || entry.entryType === "PAPER_SELL_FILL") {
      return total + BigInt(entry.suiMist);
    }
    if (entry.entryType === "PAPER_BUY_FILL") return total - BigInt(entry.suiMist);
    return total;
  }, BigInt(0));
}

async function enterPosition(
  campaign: typeof campaigns.$inferSelect,
  signal: EventRow,
  fill: EventRow,
  availableMist: bigint,
) {
  const fillPayload = payload(fill);
  const sourceSui = positiveBase(fillPayload.sui_in);
  const sourceTokens = positiveBase(fillPayload.tokens_out);
  const digest = fill.txDigest;
  if (!sourceSui || !sourceTokens || !digest || !fill.assetId) return false;
  const orderMist = availableMist < MAX_ORDER_MIST ? availableMist : MAX_ORDER_MIST;
  if (orderMist <= BigInt(0)) return false;
  const units = orderMist * sourceTokens / sourceSui;
  if (units <= BigInt(0)) return false;
  const assetId = fill.assetId as string;
  const key = `${campaign.id}:shadow-buy:${fill.eventId}`;
  await db.transaction(async (tx) => {
    const [decision] = await tx.insert(decisions).values({
      id: `decision-${key}`,
      campaignId: campaign.id,
      assetId,
      decisionKey: key,
      policyVersion: "paper-shadow-v1",
      action: "PAPER_SHADOW_BUY",
      featureSnapshot: {
        model: "FORWARD_CHAIN_EVENT_REPLAY",
        signalEventId: signal.eventId,
        signalDigest: signal.txDigest,
        fillReferenceEventId: fill.eventId,
        fillReferenceDigest: digest,
        fillReferenceCheckpoint: fill.checkpoint,
        maxOrderMist: MAX_ORDER_MIST.toString(),
      },
      quote: {
        executable: false,
        sourceSuiMist: sourceSui.toString(),
        sourceTokenBase: sourceTokens.toString(),
        simulatedSuiMist: orderMist.toString(),
        simulatedTokenBase: units.toString(),
      },
      rejectionReasons: [],
      outcome: "SHADOW_FILLED",
    }).onConflictDoNothing().returning();
    if (!decision) return;
    await tx.insert(executionRecords).values({
      id: `execution-${key}`,
      campaignId: campaign.id,
      decisionId: decision.id,
      assetId,
      kind: "FILL",
      state: "SHADOW_FILLED",
      idempotencyKey: key,
      checkpoint: fill.checkpoint,
      evidence: {
        mode: "PAPER",
        model: "FORWARD_CHAIN_EVENT_REPLAY",
        referenceDigest: digest,
        referenceEventId: fill.eventId,
        simulatedSuiMist: orderMist.toString(),
        simulatedTokenBase: units.toString(),
        executableTransaction: false,
      },
    });
    await tx.insert(ledgerEntries).values({
      id: `ledger-${key}`,
      campaignId: campaign.id,
      idempotencyKey: `ledger:${key}`,
      entryType: "PAPER_BUY_FILL",
      suiMist: orderMist.toString(),
      tokenAmountBase: units.toString(),
      assetId,
      referenceType: "CHAIN_EVENT_SHADOW_REPLAY",
      referenceId: fill.eventId,
      createdAt: fill.occurredAt,
    });
    await tx.insert(positions).values({
      id: `position-${campaign.id}-${assetId}`,
      campaignId: campaign.id,
      assetId,
      unitsBase: units.toString(),
      costMist: orderMist.toString(),
      realizedMist: "0",
      status: "OPEN",
      openedAt: fill.occurredAt,
      updatedAt: fill.occurredAt,
    }).onConflictDoNothing();
  });
  return true;
}

async function exitPosition(
  campaign: typeof campaigns.$inferSelect,
  position: typeof positions.$inferSelect,
  fill: EventRow,
) {
  const fillPayload = payload(fill);
  const sourceSui = positiveBase(fillPayload.sui_out);
  const sourceTokens = positiveBase(fillPayload.tokens_in);
  const digest = fill.txDigest;
  if (!sourceSui || !sourceTokens || !digest) return;
  const units = BigInt(position.unitsBase);
  const proceeds = units * sourceSui / sourceTokens;
  const realized = proceeds - BigInt(position.costMist);
  const key = `${campaign.id}:shadow-sell:${fill.eventId}`;
  await db.transaction(async (tx) => {
    const [decision] = await tx.insert(decisions).values({
      id: `decision-${key}`,
      campaignId: campaign.id,
      assetId: position.assetId,
      decisionKey: key,
      policyVersion: "paper-shadow-v1",
      action: "PAPER_SHADOW_SELL",
      featureSnapshot: {
        model: "FORWARD_CHAIN_EVENT_REPLAY",
        fillReferenceEventId: fill.eventId,
        fillReferenceDigest: digest,
        fillReferenceCheckpoint: fill.checkpoint,
      },
      quote: {
        executable: false,
        sourceSuiMist: sourceSui.toString(),
        sourceTokenBase: sourceTokens.toString(),
        simulatedSuiMist: proceeds.toString(),
        simulatedTokenBase: units.toString(),
      },
      rejectionReasons: [],
      outcome: "SHADOW_FILLED",
    }).onConflictDoNothing().returning();
    if (!decision) return;
    await tx.insert(executionRecords).values({
      id: `execution-${key}`,
      campaignId: campaign.id,
      decisionId: decision.id,
      assetId: position.assetId,
      kind: "FILL",
      state: "SHADOW_FILLED",
      idempotencyKey: key,
      checkpoint: fill.checkpoint,
      evidence: {
        mode: "PAPER",
        model: "FORWARD_CHAIN_EVENT_REPLAY",
        referenceDigest: digest,
        referenceEventId: fill.eventId,
        simulatedSuiMist: proceeds.toString(),
        simulatedTokenBase: units.toString(),
        realizedMist: realized.toString(),
        executableTransaction: false,
      },
    });
    await tx.insert(ledgerEntries).values({
      id: `ledger-${key}`,
      campaignId: campaign.id,
      idempotencyKey: `ledger:${key}`,
      entryType: "PAPER_SELL_FILL",
      suiMist: proceeds.toString(),
      tokenAmountBase: units.toString(),
      assetId: position.assetId,
      referenceType: "CHAIN_EVENT_SHADOW_REPLAY",
      referenceId: fill.eventId,
      createdAt: fill.occurredAt,
    });
    await tx.update(positions).set({
      status: "CLOSED",
      realizedMist: realized.toString(),
      updatedAt: fill.occurredAt,
    }).where(and(eq(positions.id, position.id), eq(positions.status, "OPEN")));
  });
}

export async function runPaperShadowOnce() {
  const fencingToken = await acquireLease();
  if (!fencingToken) return;
  const [activeCampaigns, eventCheckpoint, events] = await Promise.all([
    db.select().from(campaigns).where(and(eq(campaigns.mode, "PAPER"), eq(campaigns.status, "active"))),
    db.select().from(collectorCheckpoints).where(eq(collectorCheckpoints.collectorName, "suipump-events-mainnet")).limit(1),
    db.select().from(marketEvents).where(eq(marketEvents.provider, "sui-mainnet-graphql"))
      .orderBy(asc(marketEvents.occurredAt), asc(marketEvents.eventId)),
  ]);
  const replay = eventCheckpoint[0];
  if (!replay || replay.status !== "RUNNING" || replay.gapCount !== 0
    || !["CONTIGUOUS", "CONTIGUOUS_FROM_BOOTSTRAP"].includes(replay.replayStatus)
    || !replay.lastCompleteCheckpoint
    || !replay.lastSuccessAt || Date.now() - replay.lastSuccessAt.getTime() > 120_000) return;
  const byAsset = new Map<string, EventRow[]>();
  for (const event of events) {
    if (!event.assetId || BigInt(event.checkpoint) > BigInt(replay.lastCompleteCheckpoint)) continue;
    const list = byAsset.get(event.assetId) || [];
    list.push(event);
    byAsset.set(event.assetId, list);
  }
  for (const campaign of activeCampaigns) {
    if (!await renewLease(fencingToken)) return;
    let [ledger, campaignPositions] = await Promise.all([
      db.select().from(ledgerEntries).where(eq(ledgerEntries.campaignId, campaign.id)),
      db.select().from(positions).where(eq(positions.campaignId, campaign.id)),
    ]);
    for (const position of campaignPositions.filter((item) => item.status === "OPEN")) {
      const exit = (byAsset.get(position.assetId) || []).find((event) =>
        event.occurredAt > position.openedAt && event.eventType.endsWith("::TokensSold"));
      if (exit) await exitPosition(campaign, position, exit);
    }
    [ledger, campaignPositions] = await Promise.all([
      db.select().from(ledgerEntries).where(eq(ledgerEntries.campaignId, campaign.id)),
      db.select().from(positions).where(eq(positions.campaignId, campaign.id)),
    ]);
    let openCount = campaignPositions.filter((item) => item.status === "OPEN").length;
    let available = cashMist(ledger);
    for (const [assetId, assetEvents] of Array.from(byAsset.entries())) {
      if (openCount >= MAX_OPEN_POSITIONS || available <= BigInt(0)) break;
      if (campaignPositions.some((item) => item.assetId === assetId)) continue;
      const buys = assetEvents.filter((event) => event.eventType.endsWith("::TokensPurchased"));
      if (buys.length < 2) continue;
      if (await enterPosition(campaign, buys[0], buys[1], available)) {
        available -= available < MAX_ORDER_MIST ? available : MAX_ORDER_MIST;
        openCount++;
      }
    }
  }
}

let timer: NodeJS.Timeout | undefined;
let running = false;
export function startPaperShadowWorker() {
  if (process.env.PAPER_SHADOW_WORKER_ENABLED === "false" || timer) return;
  const run = async () => {
    if (running) return;
    running = true;
    try { await runPaperShadowOnce(); } catch (error) {
      console.error(`[paper-shadow] ${error instanceof Error ? error.message : "unknown error"}`);
    } finally { running = false; }
  };
  void run();
  timer = setInterval(() => void run(), INTERVAL_MS);
  timer.unref();
}