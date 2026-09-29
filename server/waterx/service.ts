import { latestComparison } from "../btc/chart";
import { getCurrentWaterxRound, getWaterxRoundAtEpoch, verifiedHistoricalRound, WaterxProviderError } from "./source";
import type { WaterxInterval, WaterxRound } from "./types";
import { listPendingWaterxSettlements, markWaterxSettlementAttempt, recordWaterxRound, recordWaterxSettlement } from "./learning";

type WaterxSnapshot = {
  observedAt: string | null;
  status: "LIVE" | "STALE" | "UNAVAILABLE" | "HOLD";
  round: WaterxRound | null;
  reason: string;
  sourceError: string | null;
};

const intervals: WaterxInterval[] = [5, 15];
const snapshots = new Map<WaterxInterval, WaterxSnapshot>(intervals.map(interval => [interval, {
  observedAt: null, status: "UNAVAILABLE", round: null,
  reason: "Waiting for the first WaterX public read.", sourceError: null,
}]));
const busy = new Set<WaterxInterval>();
const timers = new Map<WaterxInterval, NodeJS.Timeout>();
const running = new Set<WaterxInterval>();
const failures = new Map<WaterxInterval, number>();
const retryDelays = new Map<WaterxInterval, number>();

function validOutcome(value: string | null): "UP" | "DOWN" | null {
  const normalized = value?.trim().toUpperCase();
  return normalized === "UP" || normalized === "DOWN" ? normalized : null;
}

async function reconcileKnown(interval: WaterxInterval): Promise<void> {
  const pending = await listPendingWaterxSettlements(interval, 4);
  for (const row of pending) {
    try {
      if (!await markWaterxSettlementAttempt(interval, row.roundId)) continue;
      const closingEpoch = row.expiryMs / 1000;
      const historical = await getWaterxRoundAtEpoch(interval, closingEpoch);
      const resolved = verifiedHistoricalRound(historical, row.roundId, closingEpoch);
      const status = resolved.resolutionStatus?.trim().toLowerCase();
      if (!status) continue;
      const outcome = resolved.settlement?.outcome ?? null;
      const settledAt = resolved.settlement?.settledAt ?? null;
      if (status !== "resolved")
        continue;
      const observedAt = new Date().toISOString();
      await recordWaterxSettlement({
        intervalMinutes: interval,
        roundId: row.roundId,
        anchorPrice: resolved.anchorPrice,
        anchorConfirmed: resolved.anchorPriceConfirmed,
        settlePrice: resolved.settlePrice,
        outcome: validOutcome(outcome) ? validOutcome(outcome) : outcome,
        settledAt: settledAt === null ? null : settledAt * 1000,
        observedAt,
        resolutionStatus: status,
      });
    } catch (error) {
      // A settlement endpoint can remain unavailable while the round is not resolved.
      console.warn(`[waterx-${interval}m] settlement read failed`,
        error instanceof Error ? error.message.slice(0, 160) : "unknown error");
    }
  }
}

async function pollWaterx(interval: WaterxInterval): Promise<void> {
  if (busy.has(interval)) return;
  busy.add(interval);
  try {
    const result = await getCurrentWaterxRound(interval);
    const now = Date.now();
    const observedAt = new Date().toISOString();
    let snapshot: WaterxSnapshot;
    if (result.status === "LIVE") {
      const round = result.detail.round;
      const startMs = round.startsAt * 1000;
      const expiryMs = round.endsAt * 1000;
      const probabilityUp = round.sides.up.probabilityCents;
      try {
        await recordWaterxRound({
          intervalMinutes: interval,
          roundId: round.id,
          startMs,
          expiryMs,
          anchorPrice: round.anchorPrice,
          anchorConfirmed: round.anchorPriceConfirmed,
          probabilityUp: probabilityUp === null ? null : probabilityUp / 100,
          observedAt,
          source: "WaterX",
        });
      } catch (error) {
        snapshot = {
          observedAt, status: "LIVE", round,
          reason: `Live WaterX round; observation storage failed: ${error instanceof Error ? error.message.slice(0, 140) : "unknown error"}.`,
          sourceError: null,
        };
        snapshots.set(interval, snapshot);
        await reconcileKnown(interval);
        return;
      }
      snapshot = {
        observedAt, status: "LIVE", round,
        reason: round.anchorPriceConfirmed
          ? "Verified active WaterX round; anchor is provider-reported."
          : "Active WaterX round; provider-reported price-to-beat is UNCONFIRMED.",
        sourceError: null,
      };
    } else {
      snapshot = {
        observedAt,
        status: result.status === "STALE" ? "STALE" : "HOLD",
        round: null,
        reason: result.status === "STALE"
          ? "WaterX returned an expired round; waiting for the current interval."
          : result.detail.round.startsAt * 1000 > now
            ? "WaterX returned a future round; no active round is certified."
            : "WaterX round phase is not active; no active round is certified.",
        sourceError: null,
      };
    }
    snapshots.set(interval, snapshot);
    await reconcileKnown(interval);
  } catch (error) {
    const message = error instanceof WaterxProviderError
      ? error.message : error instanceof Error ? error.message : "Unknown provider error";
    const failureCount = Math.min((failures.get(interval) ?? 0) + 1, 8);
    failures.set(interval, failureCount);
    retryDelays.set(interval, error instanceof WaterxProviderError && error.status === 429
      ? Math.max(5_000, error.retryAfterMs ?? Math.min(60_000, 5_000 * 2 ** (failureCount - 1)))
      : Math.min(60_000, (interval === 5 ? 5_000 : 10_000) * 2 ** Math.min(failureCount - 1, 3)));
    snapshots.set(interval, {
      observedAt: new Date().toISOString(), status: "UNAVAILABLE", round: null,
      reason: message.includes("429") ? "WaterX rate limited the public read; retrying independently."
        : `WaterX public read unavailable: ${message.slice(0, 180)}`,
      sourceError: message.slice(0, 180),
    });
  } finally {
    if (!snapshots.get(interval)?.sourceError) {
      failures.delete(interval);
      retryDelays.delete(interval);
    }
    busy.delete(interval);
  }
}

/** Start independent, read-only collectors for both WaterX round durations. */
export function startWaterxCapture(): () => void {
  for (const interval of intervals) {
    if (running.has(interval)) continue;
    running.add(interval);
    const periodMs = interval === 5 ? 5_000 : 10_000;
    const tick = () => {
      void pollWaterx(interval).finally(() => {
        if (!running.has(interval)) return;
        const timer = setTimeout(tick, retryDelays.get(interval) ?? periodMs);
        timer.unref?.();
        timers.set(interval, timer);
      });
    };
    tick();
  }
  return () => {
    for (const timer of Array.from(timers.values())) clearTimeout(timer);
    timers.clear();
    running.clear();
  };
}

function providerUrl(interval: WaterxInterval, startSeconds: number): string {
  return `https://waterx.app/en/predict/market/crypto/crypto-btc-updown-${interval}m/${startSeconds}`;
}

export function waterxLive(interval: WaterxInterval) {
  const now = Date.now();
  const snapshot = snapshots.get(interval)!;
  const snapshotMs = snapshot.observedAt ? Date.parse(snapshot.observedAt) : NaN;
  const stale = !Number.isFinite(snapshotMs) || now - snapshotMs > (interval === 5 ? 16_000 : 31_000);
  const active = !stale && snapshot.status === "LIVE" && snapshot.round &&
    snapshot.round.startsAt * 1000 <= now && now < snapshot.round.endsAt * 1000;
  const round = active && snapshot.round ? snapshot.round : null;
  const comparisonTick = latestComparison();
  const comparisonTime = comparisonTick ? Date.parse(comparisonTick.asOf) : NaN;
  const comparison = comparisonTick && Number.isFinite(comparisonTime) &&
    now - comparisonTime <= 20_000 && comparisonTime <= now
    ? { price: comparisonTick.price, asOf: comparisonTick.asOf, source: comparisonTick.source } : null;
  const upPrice = round?.sides.up.oddsCents ?? null;
  const downPrice = round?.sides.down.oddsCents ?? null;
  const probabilityUp = round?.sides.up.probabilityCents ?? null;
  const probabilityDown = round?.sides.down.probabilityCents ?? null;
  const liveStatus = round ? "LIVE" : stale ? "STALE" : snapshot.status;
  const reason = round
    ? snapshot.reason
    : stale ? "WaterX round read is stale; no active round can be certified."
      : snapshot.reason;
  return {
    serverTime: new Date(now).toISOString(),
    status: liveStatus,
    intervalMinutes: interval,
    round: round ? {
      id: round.id,
      startMs: round.startsAt * 1000,
      expiryMs: round.endsAt * 1000,
      referencePrice: round.anchorPrice,
      anchorConfirmed: round.anchorPriceConfirmed,
      phase: round.phase,
      url: providerUrl(interval, round.startsAt),
    } : null,
    odds: round ? {
      up: probabilityUp === null ? null : probabilityUp / 100,
      down: probabilityDown === null ? null : probabilityDown / 100,
      upPriceCents: upPrice,
      downPriceCents: downPrice,
      asOf: snapshot.observedAt,
      source: "WaterX public market probabilities and odds",
    } : null,
    comparison,
    decision: { action: "HOLD" as const, reason: "Read-only data source; no recommendation or order is generated." },
    reason,
  };
}
