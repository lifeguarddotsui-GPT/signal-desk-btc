/**
 * Probability Calibration Engine
 *
 * Tracks how well each probability bucket (01-49, 50-59, 60-69, 70-79, 80-89, 90-99)
 * performs vs expectations in live trading. Used to:
 *   1. Show calibration stats in the UI (is the 80+ bucket actually winning 80%+ of the time?)
 *   2. Apply haircuts to overconfident bands in win-probability-model.ts
 *
 * Rules:
 *   - Only real closed trades from positions table are used
 *   - entryProbabilityDisplay is the frozen score at entry — never overwritten
 *   - Stats rebuild fully from scratch each updateProbabilityCalibrationStats() call
 */

import { db } from "./db";
import { probabilityCalibrationStats, positions } from "@shared/schema";
import { eq, and, isNotNull, desc } from "drizzle-orm";
import { resolveProbabilityBucket, resolveCalibrationStatus, ORDERED_BUCKETS } from "./probability-buckets";
import type { ProbabilityCalibrationRow } from "@shared/probability-types";

// ─────────────────────────────────────────────────────────────────────────────
// Record outcome for a single closed trade
// Finds the bucket from entryProbabilityDisplay and upserts the calibration row
// ─────────────────────────────────────────────────────────────────────────────

export async function recordProbabilityOutcome(input: {
  agentId: string;
  entryProbabilityDisplay: number;
  entryProbability: number;
  entryConfidence: number;
  resultWin: boolean;
  realizedPnlBps: number;
  realizedPnlUsd: number;
}): Promise<void> {
  try {
    const bucket = resolveProbabilityBucket(input.entryProbabilityDisplay);

    const existing = await db
      .select()
      .from(probabilityCalibrationStats)
      .where(
        and(
          eq(probabilityCalibrationStats.agentId, input.agentId),
          eq(probabilityCalibrationStats.bucketLabel, bucket.label)
        )
      )
      .limit(1);

    if (existing.length === 0) {
      // First trade in this bucket
      const actualWinRate = input.resultWin ? 1.0 : 0.0;
      const expectedWinRate = bucket.midpointProbability;
      await db.insert(probabilityCalibrationStats).values({
        agentId: input.agentId,
        bucketLabel: bucket.label,
        bucketMinDisplay: bucket.minDisplay,
        bucketMaxDisplay: bucket.maxDisplay,
        sampleSize: 1,
        winCount: input.resultWin ? 1 : 0,
        lossCount: input.resultWin ? 0 : 1,
        actualWinRate,
        expectedWinRate,
        calibrationGap: actualWinRate - expectedWinRate,
        avgPnlBps: input.realizedPnlBps,
        avgPnlUsd: input.realizedPnlUsd,
        updatedAt: new Date(),
      });
    } else {
      const row = existing[0];
      const newSampleSize = row.sampleSize + 1;
      const newWinCount = row.winCount + (input.resultWin ? 1 : 0);
      const newLossCount = row.lossCount + (input.resultWin ? 0 : 1);
      const newActualWinRate = newWinCount / newSampleSize;
      const expectedWinRate = bucket.midpointProbability;
      // Rolling average PnL
      const newAvgPnlBps = (row.avgPnlBps * row.sampleSize + input.realizedPnlBps) / newSampleSize;
      const newAvgPnlUsd = (row.avgPnlUsd * row.sampleSize + input.realizedPnlUsd) / newSampleSize;

      await db
        .update(probabilityCalibrationStats)
        .set({
          sampleSize: newSampleSize,
          winCount: newWinCount,
          lossCount: newLossCount,
          actualWinRate: newActualWinRate,
          expectedWinRate,
          calibrationGap: newActualWinRate - expectedWinRate,
          avgPnlBps: newAvgPnlBps,
          avgPnlUsd: newAvgPnlUsd,
          updatedAt: new Date(),
        })
        .where(eq(probabilityCalibrationStats.id, row.id));
    }
  } catch (err: any) {
    console.warn("[CalibrationEngine] recordProbabilityOutcome error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Full rebuild from closed positions — idempotent, run after close if needed
// ─────────────────────────────────────────────────────────────────────────────

export async function updateProbabilityCalibrationStats(agentId: string): Promise<void> {
  try {
    // Get all closed positions with frozen probability for this agent
    const closedPositions = await db
      .select({
        entryProbabilityDisplay: positions.entryProbabilityDisplay,
        unrealizedPnl: positions.unrealizedPnl,
        collateral: positions.collateral,
        entryPrice: positions.entryPrice,
        markPrice: positions.markPrice,
        side: positions.side,
        sizeSui: positions.sizeSui,
      })
      .from(positions)
      .where(
        and(
          eq(positions.agentId, agentId),
          eq(positions.status, "closed"),
          isNotNull(positions.entryProbabilityDisplay)
        )
      );

    if (closedPositions.length === 0) return;

    // Group by bucket
    const bucketMap = new Map<string, {
      wins: number; losses: number; pnlBpsSum: number; pnlUsdSum: number;
      bucket: typeof ORDERED_BUCKETS[0];
    }>();

    for (const pos of closedPositions) {
      const display = pos.entryProbabilityDisplay!;
      const bucket = resolveProbabilityBucket(display);
      const pnlSui = pos.unrealizedPnl ?? 0;
      const collateral = pos.collateral ?? (pos.sizeSui / 10); // fallback
      const resultWin = pnlSui >= 0;
      const pnlBps = collateral > 0
        ? (pnlSui / collateral) * 10000
        : 0;

      if (!bucketMap.has(bucket.label)) {
        bucketMap.set(bucket.label, { wins: 0, losses: 0, pnlBpsSum: 0, pnlUsdSum: 0, bucket });
      }
      const row = bucketMap.get(bucket.label)!;
      if (resultWin) row.wins++; else row.losses++;
      row.pnlBpsSum += pnlBps;
      row.pnlUsdSum += pnlSui;
    }

    // Upsert each bucket
    for (const [label, data] of bucketMap.entries()) {
      const total = data.wins + data.losses;
      const actualWinRate = total > 0 ? data.wins / total : 0;
      const expectedWinRate = data.bucket.midpointProbability;

      const existing = await db
        .select({ id: probabilityCalibrationStats.id })
        .from(probabilityCalibrationStats)
        .where(
          and(
            eq(probabilityCalibrationStats.agentId, agentId),
            eq(probabilityCalibrationStats.bucketLabel, label)
          )
        )
        .limit(1);

      const vals = {
        agentId,
        bucketLabel: label,
        bucketMinDisplay: data.bucket.minDisplay,
        bucketMaxDisplay: data.bucket.maxDisplay,
        sampleSize: total,
        winCount: data.wins,
        lossCount: data.losses,
        actualWinRate,
        expectedWinRate,
        calibrationGap: actualWinRate - expectedWinRate,
        avgPnlBps: total > 0 ? data.pnlBpsSum / total : 0,
        avgPnlUsd: total > 0 ? data.pnlUsdSum / total : 0,
        updatedAt: new Date(),
      };

      if (existing.length > 0) {
        await db.update(probabilityCalibrationStats).set(vals).where(eq(probabilityCalibrationStats.id, existing[0].id));
      } else {
        await db.insert(probabilityCalibrationStats).values(vals);
      }
    }
  } catch (err: any) {
    console.warn("[CalibrationEngine] updateProbabilityCalibrationStats error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read calibration rows for an agent (UI consumption)
// ─────────────────────────────────────────────────────────────────────────────

export async function getProbabilityCalibrationRows(agentId: string): Promise<ProbabilityCalibrationRow[]> {
  try {
    const rows = await db
      .select()
      .from(probabilityCalibrationStats)
      .where(eq(probabilityCalibrationStats.agentId, agentId));

    return rows.map((r) => ({
      bucketLabel: r.bucketLabel,
      bucketMinDisplay: r.bucketMinDisplay,
      bucketMaxDisplay: r.bucketMaxDisplay,
      sampleSize: r.sampleSize,
      winCount: r.winCount,
      lossCount: r.lossCount,
      actualWinRate: r.actualWinRate,
      expectedWinRate: r.expectedWinRate,
      calibrationGap: r.calibrationGap,
      avgPnlBps: r.avgPnlBps,
      avgPnlUsd: r.avgPnlUsd,
      status: resolveCalibrationStatus(r.calibrationGap),
    }));
  } catch (err: any) {
    console.warn("[CalibrationEngine] getProbabilityCalibrationRows error:", err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch a single bucket's calibration for use in the win probability model
// Returns null if no data (< minSamples)
// ─────────────────────────────────────────────────────────────────────────────

export async function getCalibrationForBucket(
  agentId: string,
  bucketLabel: string,
  minSamples = 8
): Promise<{ calibrationGap: number; sampleSize: number } | null> {
  try {
    const rows = await db
      .select({
        calibrationGap: probabilityCalibrationStats.calibrationGap,
        sampleSize: probabilityCalibrationStats.sampleSize,
      })
      .from(probabilityCalibrationStats)
      .where(
        and(
          eq(probabilityCalibrationStats.agentId, agentId),
          eq(probabilityCalibrationStats.bucketLabel, bucketLabel)
        )
      )
      .limit(1);

    if (rows.length === 0 || rows[0].sampleSize < minSamples) return null;
    return rows[0];
  } catch {
    return null;
  }
}
