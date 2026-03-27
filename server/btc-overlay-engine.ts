/**
 * BTC Correlation Overlay Engine — Multi-timeframe BTC momentum as a leading indicator
 * for SUI/USDC directional bias.
 *
 * BTC and SUI are highly correlated on short timeframes. When BTC exhibits strong,
 * consistent momentum across 5m/15m/1h windows, it provides predictive signal for
 * SUI direction. This engine tracks BTC price via the Pyth Hermes feed (same source
 * already used for SUI), computes momentum across three timeframes, classifies bias,
 * and exposes a BtcOverlayContext consumed by the signal engine as a ±10pt modifier.
 *
 * Architecture mirrors SentimentFlowEngine:
 *   - Polls Pyth every 60s
 *   - Maintains in-memory circular buffer (75 points = 75 min)
 *   - Snapshots to DB every 5 minutes
 *   - Graceful fallback — returns unusable context if data unavailable
 *   - No circular imports — BtcOverlayContext type lives in signal-engine.ts
 */

import { db } from "./db";
import { btcOverlaySnapshots } from "../shared/schema";
import type { BtcOverlayContext } from "./signal-engine";

const PYTH_BTC_FEED_ID = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const POLL_INTERVAL_MS = 60_000;
const DB_SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const MAX_HISTORY = 75;

interface BtcPricePoint {
  timestamp: number;
  price: number;
}

let priceHistory: BtcPricePoint[] = [];
let latestOverlay: BtcOverlayContext | null = null;
let lastDbSnapshotAt = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastPollAt = 0;

async function fetchBtcPrice(): Promise<number | null> {
  try {
    const res = await fetch(
      `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_BTC_FEED_ID}`,
      { signal: AbortSignal.timeout(6_000) },
    );
    if (!res.ok) return null;
    const data = await res.json() as { parsed?: Array<{ price: { price: string; expo: number } }> };
    const p = data?.parsed?.[0]?.price;
    if (!p) return null;
    const price = parseFloat(p.price) * Math.pow(10, p.expo);
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

function closestPrice(targetMs: number): number | undefined {
  if (priceHistory.length === 0) return undefined;
  const now = Date.now();
  const targetTime = now - targetMs;
  let best = priceHistory[0];
  for (const p of priceHistory) {
    if (Math.abs(p.timestamp - targetTime) < Math.abs(best.timestamp - targetTime)) {
      best = p;
    }
  }
  // Only accept if within 1.8× of the target window (avoids using stale data for short windows)
  return Math.abs(best.timestamp - targetTime) < targetMs * 1.8 ? best.price : undefined;
}

function pctChange(nowP: number, thenP: number | undefined): number {
  if (!thenP || thenP === 0) return 0;
  return ((nowP - thenP) / thenP) * 100;
}

function directionFromChange(change: number, threshold: number): "UP" | "DOWN" | "FLAT" {
  if (change > threshold) return "UP";
  if (change < -threshold) return "DOWN";
  return "FLAT";
}

function computeOverlay(): BtcOverlayContext {
  const now = Date.now();

  if (priceHistory.length === 0) {
    return {
      btcPrice: 0,
      change5m: 0, change15m: 0, change60m: 0,
      direction5m: "FLAT", direction15m: "FLAT", direction60m: "FLAT",
      bias: "neutral", strength: 0, agreementScore: 0,
      usable: false, dataAge: 0, note: "Engine warming up — no BTC data yet",
    };
  }

  const latest = priceHistory[priceHistory.length - 1];
  const btcPrice = latest.price;
  const dataAge = now - latest.timestamp;

  const p5m = closestPrice(5 * 60_000);
  const p15m = closestPrice(15 * 60_000);
  const p60m = closestPrice(60 * 60_000);

  const change5m = p5m !== undefined ? pctChange(btcPrice, p5m) : 0;
  const change15m = p15m !== undefined ? pctChange(btcPrice, p15m) : 0;
  const change60m = p60m !== undefined ? pctChange(btcPrice, p60m) : 0;

  // Thresholds: 5m needs 0.05%, 15m needs 0.12%, 60m needs 0.25% to be directional
  const direction5m = p5m !== undefined ? directionFromChange(change5m, 0.05) : "FLAT";
  const direction15m = p15m !== undefined ? directionFromChange(change15m, 0.12) : "FLAT";
  const direction60m = p60m !== undefined ? directionFromChange(change60m, 0.25) : "FLAT";

  const dirs = [direction5m, direction15m, direction60m];
  const upCount = dirs.filter(d => d === "UP").length;
  const downCount = dirs.filter(d => d === "DOWN").length;
  const flatCount = dirs.filter(d => d === "FLAT").length;

  let bias: "bull" | "bear" | "neutral" = "neutral";
  if (upCount >= 2) bias = "bull";
  else if (downCount >= 2) bias = "bear";

  const domCount = Math.max(upCount, downCount);
  const agreementScore = flatCount === 3 ? 0 : Math.round((domCount / 3) * 100);

  // Strength combines magnitude of moves and consistency across timeframes
  const rawMagnitude = Math.abs(change5m) * 0.25 + Math.abs(change15m) * 0.35 + Math.abs(change60m) * 0.40;
  const consistencyBonus = domCount === 3 ? 25 : domCount === 2 ? 10 : 0;
  const strength = Math.min(100, Math.round(rawMagnitude * 12 + consistencyBonus));

  // Usable when we have enough history and fresh data
  const enoughHistory = priceHistory.length >= 6;
  const fresh = dataAge < 3 * 60_000;
  const usable = enoughHistory && fresh;

  let note = "";
  if (!enoughHistory) {
    note = `Warming up — ${priceHistory.length}/6 samples collected`;
  } else if (!fresh) {
    note = `Data stale (${Math.round(dataAge / 60_000)}m old)`;
  } else if (bias === "neutral") {
    note = flatCount === 3
      ? "BTC flat across all timeframes — no directional edge"
      : `BTC mixed: ${upCount}↑ ${downCount}↓ ${flatCount}→ across 5m/15m/1h`;
  } else {
    const adj = bias === "bull" ? "bullish" : "bearish";
    note = `BTC ${adj} — ${domCount}/3 timeframes confirm direction (strength ${strength})`;
  }

  return {
    btcPrice, change5m, change15m, change60m,
    direction5m, direction15m, direction60m,
    bias, strength, agreementScore, usable, dataAge, note,
  };
}

async function poll() {
  const price = await fetchBtcPrice();
  const now = Date.now();
  lastPollAt = now;

  if (price !== null && price > 0) {
    priceHistory.push({ timestamp: now, price });
    if (priceHistory.length > MAX_HISTORY) {
      priceHistory = priceHistory.slice(priceHistory.length - MAX_HISTORY);
    }
  }

  latestOverlay = computeOverlay();

  // DB snapshot every 5 minutes
  if (price !== null && now - lastDbSnapshotAt >= DB_SNAPSHOT_INTERVAL_MS) {
    try {
      const ov = latestOverlay;
      await db.insert(btcOverlaySnapshots).values({
        btcPrice: price,
        change5m: ov.change5m,
        change15m: ov.change15m,
        change60m: ov.change60m,
        direction5m: ov.direction5m,
        direction15m: ov.direction15m,
        direction60m: ov.direction60m,
        bias: ov.bias,
        strength: ov.strength,
        agreementScore: ov.agreementScore,
      });
      lastDbSnapshotAt = now;
    } catch {
      // Non-fatal — DB snapshot is optional
    }
  }
}

export function getBtcOverlayContext(): BtcOverlayContext | null {
  return latestOverlay;
}

export interface BtcPriceHistory {
  timestamp: number;
  price: number;
}

export function getBtcPriceHistory(): BtcPriceHistory[] {
  return priceHistory.slice(-61); // Last 61 points = ~60 min
}

export function startBtcOverlayEngine(): void {
  console.log("[BtcOverlay] Starting BTC Correlation Overlay Engine (Pyth feed)");
  poll().catch(e => console.error("[BtcOverlay] Initial poll error:", e));
  pollTimer = setInterval(() => {
    poll().catch(e => console.error("[BtcOverlay] Poll error:", e));
  }, POLL_INTERVAL_MS);
}

export function stopBtcOverlayEngine(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
