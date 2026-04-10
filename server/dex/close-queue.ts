/**
 * Close Queue V2 — Durable, idempotent close request manager.
 *
 * Every close action passes through this queue.
 * Guarantees:
 *  - No duplicate submits for the same position (idempotency)
 *  - DB-backed persistence — survives server restarts
 *  - Retry with exponential backoff
 *  - Escalation ladder: normal → high urgency → partial emergency → full emergency
 *  - Marks positions as "stuck" after too many retries so exit-engine can escalate
 */

import { db } from "../db";
import { closeQueue as closeQueueTable } from "@shared/schema";
import { eq, inArray, lt, and } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CloseRequest {
  positionId: string;
  agentId: string;
  side: "long" | "short";
  sizePct: number;            // 1.0 = full close, 0.45 = partial
  reason: string;
  urgency: "normal" | "high";
}

export interface QueueItem extends CloseRequest {
  id: string;
  requestedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  status: "queued" | "submitted" | "confirmed" | "failed" | "stuck";
  txDigest?: string;
  errorMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backoff schedule (ms)
// ─────────────────────────────────────────────────────────────────────────────
const RETRY_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
const MAX_RETRIES = 5;
const STUCK_AFTER_RETRIES = 4;

// ─────────────────────────────────────────────────────────────────────────────
// In-memory mirror (DB is source of truth; memory is the fast path)
// ─────────────────────────────────────────────────────────────────────────────

class CloseQueueManager {
  // positionId → queue item
  private items = new Map<string, QueueItem>();
  private initialized = false;

  // ── Bootstrap: load in-flight items from DB on startup ──────────────────
  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const active = await db.select().from(closeQueueTable)
        .where(inArray(closeQueueTable.status, ["queued", "submitted"]));

      for (const row of active) {
        this.items.set(row.positionId, {
          id: row.id,
          positionId: row.positionId,
          agentId: row.agentId,
          side: row.side as "long" | "short",
          sizePct: row.sizePct,
          reason: row.reason,
          urgency: row.urgency as "normal" | "high",
          requestedAt: row.requestedAt,
          retryCount: row.retryCount,
          lastAttemptAt: row.lastAttemptAt ?? undefined,
          status: row.status as QueueItem["status"],
          txDigest: row.txDigest ?? undefined,
        });
      }
      console.log(`[CloseQueue] Loaded ${active.length} in-flight close request(s) from DB`);
    } catch (err) {
      console.error("[CloseQueue] Failed to load from DB:", err);
    }
    this.initialized = true;
  }

  // ── Enqueue — idempotent ────────────────────────────────────────────────
  async enqueue(req: CloseRequest): Promise<boolean> {
    await this.init();

    const existing = this.items.get(req.positionId);
    if (existing && existing.status !== "confirmed" && existing.status !== "failed" && existing.status !== "stuck") {
      // Already queued or in-flight — idempotent no-op
      // Upgrade urgency if requested
      if (req.urgency === "high" && existing.urgency !== "high") {
        existing.urgency = "high";
        await db.update(closeQueueTable)
          .set({ urgency: "high" })
          .where(eq(closeQueueTable.positionId, req.positionId));
      }
      return false;
    }

    const now = Date.now();
    const [inserted] = await db.insert(closeQueueTable).values({
      positionId: req.positionId,
      agentId: req.agentId,
      requestedAt: now,
      side: req.side,
      sizePct: req.sizePct,
      reason: req.reason,
      urgency: req.urgency,
      retryCount: 0,
      status: "queued",
    }).returning();

    const item: QueueItem = { ...req, id: inserted.id, requestedAt: now, retryCount: 0, status: "queued" };
    this.items.set(req.positionId, item);
    return true;
  }

  // ── Get items ready to execute this tick ────────────────────────────────
  getExecutable(urgencyFilter?: "normal" | "high"): QueueItem[] {
    const now = Date.now();
    const results: QueueItem[] = [];

    for (const item of this.items.values()) {
      if (item.status !== "queued") continue;
      if (urgencyFilter && item.urgency !== urgencyFilter) continue;

      // Backoff check
      if (item.lastAttemptAt) {
        const delay = RETRY_BACKOFF_MS[Math.min(item.retryCount, RETRY_BACKOFF_MS.length - 1)];
        if (now - item.lastAttemptAt < delay) continue;
      }

      results.push(item);
    }

    // High urgency first
    return results.sort((a, b) => {
      if (a.urgency === "high" && b.urgency !== "high") return -1;
      if (b.urgency === "high" && a.urgency !== "high") return 1;
      return a.requestedAt - b.requestedAt;
    });
  }

  // ── Mark submitted ───────────────────────────────────────────────────────
  async markSubmitted(positionId: string, txDigest?: string): Promise<void> {
    const item = this.items.get(positionId);
    if (!item) return;

    item.status = "submitted";
    item.lastAttemptAt = Date.now();
    item.retryCount++;
    if (txDigest) item.txDigest = txDigest;

    await db.update(closeQueueTable).set({
      status: "submitted",
      lastAttemptAt: item.lastAttemptAt,
      retryCount: item.retryCount,
      txDigest: txDigest ?? null,
      updatedAt: new Date(),
    }).where(eq(closeQueueTable.positionId, positionId));
  }

  // ── Mark confirmed ───────────────────────────────────────────────────────
  async markConfirmed(positionId: string, txDigest?: string): Promise<void> {
    const item = this.items.get(positionId);
    if (!item) return;

    item.status = "confirmed";
    this.items.delete(positionId);

    await db.update(closeQueueTable).set({
      status: "confirmed",
      txDigest: txDigest ?? item.txDigest ?? null,
      updatedAt: new Date(),
    }).where(eq(closeQueueTable.positionId, positionId));
  }

  // ── Mark failed (bump retry) ─────────────────────────────────────────────
  async markFailed(positionId: string, error: string): Promise<void> {
    const item = this.items.get(positionId);
    if (!item) return;

    item.retryCount++;
    item.lastAttemptAt = Date.now();
    item.errorMessage = error;

    const newStatus: QueueItem["status"] = item.retryCount >= STUCK_AFTER_RETRIES ? "stuck" : "queued";
    item.status = newStatus;

    if (newStatus === "stuck") {
      console.warn(`[CloseQueue] Position ${positionId} stuck after ${item.retryCount} retries — escalating`);
    }

    await db.update(closeQueueTable).set({
      status: newStatus,
      retryCount: item.retryCount,
      lastAttemptAt: item.lastAttemptAt,
      errorMessage: error,
      updatedAt: new Date(),
    }).where(eq(closeQueueTable.positionId, positionId));
  }

  // ── Check if position is stuck ───────────────────────────────────────────
  isStuck(positionId: string): boolean {
    return this.items.get(positionId)?.status === "stuck";
  }

  // ── Remove from queue (e.g. position already found closed on-chain) ──────
  async remove(positionId: string): Promise<void> {
    this.items.delete(positionId);
    await db.update(closeQueueTable).set({
      status: "confirmed",
      updatedAt: new Date(),
    }).where(eq(closeQueueTable.positionId, positionId));
  }

  // ── Requeue stuck items (called by position monitor) ─────────────────────
  async requeueStuck(): Promise<number> {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.status !== "stuck") continue;
      if (item.retryCount >= MAX_RETRIES) {
        // Give up — mark failed permanently
        item.status = "failed";
        await db.update(closeQueueTable).set({ status: "failed", updatedAt: new Date() })
          .where(eq(closeQueueTable.positionId, item.positionId));
        console.error(`[CloseQueue] Position ${item.positionId} PERMANENTLY FAILED after ${item.retryCount} retries`);
        continue;
      }
      // Escalate urgency and re-queue
      item.status = "queued";
      item.urgency = "high";
      await db.update(closeQueueTable).set({
        status: "queued", urgency: "high", updatedAt: new Date(),
      }).where(eq(closeQueueTable.positionId, item.positionId));
      count++;
    }
    return count;
  }

  // ── Purge old completed records from DB ─────────────────────────────────
  async purgeOldRecords(olderThanMs = 24 * 60 * 60 * 1000): Promise<void> {
    const cutoff = new Date(Date.now() - olderThanMs);
    try {
      await db.delete(closeQueueTable)
        .where(and(
          inArray(closeQueueTable.status, ["confirmed", "failed"]),
          lt(closeQueueTable.createdAt, cutoff),
        ));
    } catch {}
  }

  /** Get all in-flight position IDs (useful for blocking duplicate opens) */
  getInFlightPositionIds(): Set<string> {
    const ids = new Set<string>();
    for (const [posId, item] of this.items.entries()) {
      if (item.status === "queued" || item.status === "submitted") {
        ids.add(posId);
      }
    }
    return ids;
  }
}

export const closeQueueManager = new CloseQueueManager();
