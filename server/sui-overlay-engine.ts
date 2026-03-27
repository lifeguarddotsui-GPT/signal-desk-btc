/**
 * SUI Price Momentum Overlay Engine — Multi-timeframe SUI/USD self-momentum tracker.
 *
 * Tracks SUI/USD price via Pyth Hermes (same feed used for trading), computes
 * short-term momentum across 5m/15m/1h windows, and exposes a SuiOverlayContext
 * consumed by the signal engine as a ±8pt modifier.
 *
 * SUI self-momentum is a direct proxy for market microstructure on the instrument
 * we trade. When SUI has strong, consistent momentum it reinforces or contradicts
 * the Triton signal components — providing confirmation or a caution flag.
 *
 * Architecture mirrors BtcOverlayEngine:
 *   - Polls Pyth every 60s
 *   - Maintains in-memory circular buffer (75 points = 75 min)
 *   - Snapshots to DB every 5 minutes
 *   - Graceful fallback — returns unusable context if data unavailable
 *   - No circular imports — SuiOverlayContext type lives in signal-engine.ts
 */

import { db } from "./db";
import { suiOverlaySnapshots } from "../shared/schema";
import type { SuiOverlayContext } from "./signal-engine";

const PYTH_SUI_FEED_ID = "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744";
const POLL_INTERVAL_MS = 60_000;
const DB_SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const MAX_HISTORY = 75;

interface SuiPricePoint {
  timestamp: number;
  price: number;
}

let priceHistory: SuiPricePoint[] = [];
let latestOverlay: SuiOverlayContext | null = null;
let lastDbSnapshotAt = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastPollAt = 0;

async function fetchSuiPrice(): Promise<number | null> {
  try {
    const res = await fetch(
      `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_SUI_FEED_ID}`,
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

function computeOverlay(): SuiOverlayContext {
  const now = Date.now();

  if (priceHistory.length === 0) {
    return {
      suiPrice: 0,
      change5m: 0, change15m: 0, change60m: 0,
      direction5m: "FLAT", direction15m: "FLAT", direction60m: "FLAT",
      bias: "neutral", strength: 0, agreementScore: 0,
      usable: false, dataAge: 0, note: "Engine warming up — no SUI data yet",
    };
  }

  const latest = priceHistory[priceHistory.length - 1];
  const suiPrice = latest.price;
  const dataAge = now - latest.timestamp;

  const p5m = closestPrice(5 * 60_000);
  const p15m = closestPrice(15 * 60_000);
  const p60m = closestPrice(60 * 60_000);

  const change5m = p5m !== undefined ? pctChange(suiPrice, p5m) : 0;
  const change15m = p15m !== undefined ? pctChange(suiPrice, p15m) : 0;
  const change60m = p60m !== undefined ? pctChange(suiPrice, p60m) : 0;

  // SUI thresholds slightly lower than BTC (SUI is more volatile, smaller moves are meaningful)
  const direction5m = p5m !== undefined ? directionFromChange(change5m, 0.04) : "FLAT";
  const direction15m = p15m !== undefined ? directionFromChange(change15m, 0.10) : "FLAT";
  const direction60m = p60m !== undefined ? directionFromChange(change60m, 0.20) : "FLAT";

  const dirs = [direction5m, direction15m, direction60m];
  const upCount = dirs.filter(d => d === "UP").length;
  const downCount = dirs.filter(d => d === "DOWN").length;
  const flatCount = dirs.filter(d => d === "FLAT").length;

  let bias: "bull" | "bear" | "neutral" = "neutral";
  if (upCount >= 2) bias = "bull";
  else if (downCount >= 2) bias = "bear";

  const domCount = Math.max(upCount, downCount);
  const agreementScore = flatCount === 3 ? 0 : Math.round((domCount / 3) * 100);

  // Strength: magnitude + consistency
  const rawMagnitude = Math.abs(change5m) * 0.25 + Math.abs(change15m) * 0.35 + Math.abs(change60m) * 0.40;
  const consistencyBonus = domCount === 3 ? 25 : domCount === 2 ? 10 : 0;
  // SUI is more volatile — scale factor 10 vs BTC 12
  const strength = Math.min(100, Math.round(rawMagnitude * 10 + consistencyBonus));

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
      ? "SUI flat across all timeframes — no directional momentum"
      : `SUI mixed: ${upCount}↑ ${downCount}↓ ${flatCount}→ across 5m/15m/1h`;
  } else {
    const adj = bias === "bull" ? "bullish" : "bearish";
    note = `SUI ${adj} — ${domCount}/3 timeframes confirm momentum (strength ${strength})`;
  }

  return {
    suiPrice, change5m, change15m, change60m,
    direction5m, direction15m, direction60m,
    bias, strength, agreementScore, usable, dataAge, note,
  };
}

async function poll() {
  const price = await fetchSuiPrice();
  const now = Date.now();
  lastPollAt = now;

  if (price !== null && price > 0) {
    priceHistory.push({ timestamp: now, price });
    if (priceHistory.length > MAX_HISTORY) {
      priceHistory = priceHistory.slice(priceHistory.length - MAX_HISTORY);
    }
  }

  latestOverlay = computeOverlay();

  if (price !== null && now - lastDbSnapshotAt >= DB_SNAPSHOT_INTERVAL_MS) {
    try {
      const ov = latestOverlay;
      await db.insert(suiOverlaySnapshots).values({
        suiPrice: price,
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
      // Non-fatal
    }
  }
}

export function getSuiOverlayContext(): SuiOverlayContext | null {
  return latestOverlay;
}

export interface SuiPriceHistory {
  timestamp: number;
  price: number;
}

export function getSuiPriceHistory(): SuiPriceHistory[] {
  return priceHistory.slice(-61);
}

export function startSuiOverlayEngine(): void {
  console.log("[SuiOverlay] Starting SUI Price Momentum Overlay Engine (Pyth feed)");
  poll().catch(e => console.error("[SuiOverlay] Initial poll error:", e));
  pollTimer = setInterval(() => {
    poll().catch(e => console.error("[SuiOverlay] Poll error:", e));
  }, POLL_INTERVAL_MS);
}

export function stopSuiOverlayEngine(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
