/**
 * SentimentFlowEngine — Venue crowd intelligence for improved agent win rate.
 *
 * Collects and synthesizes crowd positioning data from:
 *   1. Hyperliquid REST API — OI, funding rate, live trade tape, order book L/S
 *      (FlowX Perp is powered by Hyperliquid — this is the live data source visible at flowx.finance/perp)
 *   2. Typus Perps on-chain events (CreateTradingOrderEvent tape flow) — secondary on-SUI tape
 *
 * Outputs a SentimentSignal consumed by the signal engine as a ±8 point
 * score modifier — keeping it as a secondary layer, not the primary driver.
 */

import { db } from "./db";
import { marketSentimentSnapshots } from "../shared/schema";
import { getThrottledSuiClient } from "./rpc-throttle";
import type { SentimentContext } from "./signal-engine";

const MIST_PER_SUI = 1_000_000_000;
const PERP_TRADING_PACKAGE = "0x9003219180252ae6b81d2893b41d430488669027219537236675c0c2924c94d9";
const POLL_INTERVAL_MS = 60_000;
const DB_SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const HL_API_TIMEOUT_MS = 8_000;
const HL_API_BASE = "https://api.hyperliquid.xyz/info";
// SUI asset index on Hyperliquid (confirmed: index 14)
const HL_SUI_INDEX = 14;

export interface SentimentSignal extends SentimentContext {
  symbol: string;
  trendFollowBias: "long" | "short" | "neutral";
  contrarianBias: "long" | "short" | "neutral";
  sentimentAdjustment: number;
  notes: string[];
  hyperliquid?: {
    oiLongPct: number;
    oiShortPct: number;
    fundingRate: number;
    openInterest: number;
    longShortRatio: number;
    markPx: number;
    dayVolume: number;
  };
  typus?: {
    tapeBuyCount: number;
    tapeSellCount: number;
    tapeBuyNotionalSui: number;
    tapeSellNotionalSui: number;
    largestBuy: number;
    largestSell: number;
  };
  updatedAt: number;
}

// ── Neutral fallback ───────────────────────────────────────────────────────────

function neutralSignal(reason: string, dataAge = 0): SentimentSignal {
  return {
    symbol: "SUI-USDC",
    trendFollowBias: "neutral",
    contrarianBias: "neutral",
    crowdingScore: 50,
    tapeScore: 0,
    oiExpansionScore: 0,
    fundingPressureScore: 0,
    sentimentAdjustment: 0,
    confidence: 0,
    regime: "neutral",
    dataAge,
    note: reason,
    notes: [reason],
    updatedAt: Date.now(),
  };
}

// ── State ──────────────────────────────────────────────────────────────────────

let currentSignal: SentimentSignal = neutralSignal("Engine not yet started");
let lastPollAt = 0;
let lastDbSnapshotAt = 0;
let pollHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

let lastMarkPrice = 0;
export function updateMarkPrice(price: number): void { lastMarkPrice = price; }

// Rolling OI tracker
let hlOiLongPct = 50;
let hlOiShortPct = 50;
let prevOiLongPct = 50;
let hlOpenInterest = 0;
let prevOpenInterest = 0;

// ── Typus on-chain tape fetcher ────────────────────────────────────────────────

interface TapeData {
  buyCount: number;
  sellCount: number;
  buyNotionalSui: number;
  sellNotionalSui: number;
  largestBuy: number;
  largestSell: number;
  eventCount: number;
}

async function fetchTypusTape(): Promise<TapeData | null> {
  try {
    const client = getThrottledSuiClient();
    const evtResult = await client.queryEvents({
      query: { MoveEventType: `${PERP_TRADING_PACKAGE}::position::CreateTradingOrderEvent` },
      limit: 100,
      order: "descending",
    } as any);

    if (!evtResult?.data?.length) return null;

    let buyCount = 0, sellCount = 0;
    let buyNotionalSui = 0, sellNotionalSui = 0;
    let largestBuy = 0, largestSell = 0;
    let eventCount = 0;

    for (const evt of evtResult.data) {
      const p = (evt as any).parsedJson;
      if (!p) continue;
      if (p.reduce_only === true) continue;
      if (p.is_stop_order === true) continue;

      const collateral = Number(p.collateral_amount || p.collateral || 0) / MIST_PER_SUI;
      if (collateral <= 0) continue;

      eventCount++;
      const isLong = p.is_long === true;
      if (isLong) {
        buyCount++;
        buyNotionalSui += collateral;
        if (collateral > largestBuy) largestBuy = collateral;
      } else {
        sellCount++;
        sellNotionalSui += collateral;
        if (collateral > largestSell) largestSell = collateral;
      }
    }

    if (eventCount === 0) return null;
    return { buyCount, sellCount, buyNotionalSui, sellNotionalSui, largestBuy, largestSell, eventCount };
  } catch (err: any) {
    console.log(`[SentimentFlow] Typus tape fetch failed: ${err.message?.slice(0, 80)}`);
    return null;
  }
}

// ── Hyperliquid data fetcher ───────────────────────────────────────────────────
// FlowX Perp is powered by Hyperliquid — live perp data for SUI/USD.
// Public API, no authentication required.

interface HyperliquidData {
  // From metaAndAssetCtxs
  fundingRate: number;       // Hourly funding rate (positive = longs pay)
  openInterest: number;      // Total OI in SUI units
  markPx: number;            // Mark price
  oraclePx: number;          // Oracle price
  dayVolume: number;         // 24h notional volume in USD
  premium: number;           // Mark - oracle premium
  // From order book depth analysis
  oiLongPct: number;         // Estimated % of longs based on OB pressure
  oiShortPct: number;        // Estimated % of shorts
  longShortRatio: number;    // bid depth / ask depth (top 20 levels)
  // From recent trades tape
  tapeBuyVolume: number;     // Recent buy volume in SUI
  tapeSellVolume: number;    // Recent sell volume in SUI
  tapeBuyCount: number;
  tapeSellCount: number;
}

async function fetchHyperliquidData(): Promise<HyperliquidData | null> {
  try {
    // 1. Fetch asset contexts (OI, funding, mark price)
    const ctxRes = await fetch(HL_API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      signal: AbortSignal.timeout(HL_API_TIMEOUT_MS),
    });
    if (!ctxRes.ok) {
      console.log(`[SentimentFlow] Hyperliquid metaAndAssetCtxs HTTP ${ctxRes.status}`);
      return null;
    }
    const ctxData = await ctxRes.json() as any[];
    const meta = ctxData[0];
    const ctxs = ctxData[1];

    // Verify SUI index (may shift if Hyperliquid adds new assets)
    let suiIdx = HL_SUI_INDEX;
    if (meta?.universe?.[suiIdx]?.name !== "SUI") {
      const found = meta?.universe?.findIndex((u: any) => u.name === "SUI");
      if (found < 0) {
        console.log("[SentimentFlow] SUI not found in Hyperliquid universe");
        return null;
      }
      suiIdx = found;
    }
    const ctx = ctxs[suiIdx];
    if (!ctx) return null;

    const fundingRate = parseFloat(ctx.funding ?? "0") || 0;
    const openInterest = parseFloat(ctx.openInterest ?? "0") || 0;
    const markPx = parseFloat(ctx.markPx ?? ctx.midPx ?? "0") || 0;
    const oraclePx = parseFloat(ctx.oraclePx ?? "0") || 0;
    const dayVolume = parseFloat(ctx.dayNtlVlm ?? "0") || 0;
    const premium = parseFloat(ctx.premium ?? "0") || 0;

    // 2. Fetch order book for L/S ratio estimation (bid vs ask depth)
    let oiLongPct = 50;
    let oiShortPct = 50;
    let longShortRatio = 1.0;
    try {
      const obRes = await fetch(HL_API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "l2Book", coin: "SUI", nSigFigs: 5 }),
        signal: AbortSignal.timeout(HL_API_TIMEOUT_MS),
      });
      if (obRes.ok) {
        const obData = await obRes.json() as any;
        const bids: any[] = obData.levels?.[0] ?? [];
        const asks: any[] = obData.levels?.[1] ?? [];
        // Sum top 20 price levels for each side
        const bidDepth = bids.slice(0, 20).reduce((s: number, b: any) => s + parseFloat(b.sz || 0), 0);
        const askDepth = asks.slice(0, 20).reduce((s: number, a: any) => s + parseFloat(a.sz || 0), 0);
        const totalDepth = bidDepth + askDepth;
        if (totalDepth > 0) {
          oiLongPct = (bidDepth / totalDepth) * 100;
          oiShortPct = (askDepth / totalDepth) * 100;
          longShortRatio = askDepth > 0 ? bidDepth / askDepth : 1.0;
        }
      }
    } catch {
      // Use funding-rate sign as fallback L/S proxy: positive funding = more longs
      if (fundingRate > 0) { oiLongPct = 53; oiShortPct = 47; longShortRatio = 1.13; }
      else if (fundingRate < 0) { oiLongPct = 47; oiShortPct = 53; longShortRatio = 0.89; }
    }

    // 3. Fetch recent trades for tape analysis
    let tapeBuyVolume = 0, tapeSellVolume = 0, tapeBuyCount = 0, tapeSellCount = 0;
    try {
      const tradeRes = await fetch(HL_API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "recentTrades", coin: "SUI" }),
        signal: AbortSignal.timeout(HL_API_TIMEOUT_MS),
      });
      if (tradeRes.ok) {
        const trades = await tradeRes.json() as any[];
        for (const t of trades) {
          const sz = parseFloat(t.sz || "0");
          if (t.side === "B") { tapeBuyVolume += sz; tapeBuyCount++; }
          else { tapeSellVolume += sz; tapeSellCount++; }
        }
      }
    } catch {
      // Tape unavailable — will fall back to OB-derived proxy
    }

    return {
      fundingRate,
      openInterest,
      markPx,
      oraclePx,
      dayVolume,
      premium,
      oiLongPct,
      oiShortPct,
      longShortRatio,
      tapeBuyVolume,
      tapeSellVolume,
      tapeBuyCount,
      tapeSellCount,
    };
  } catch (err: any) {
    console.log(`[SentimentFlow] Hyperliquid fetch failed: ${err.message?.slice(0, 80)}`);
    return null;
  }
}

// ── Score computation ──────────────────────────────────────────────────────────

function computeHLTapeScore(hl: HyperliquidData): number {
  const total = hl.tapeBuyVolume + hl.tapeSellVolume;
  if (total < 1) {
    // Fall back to order book imbalance when no recent trades
    const obBias = hl.oiLongPct - 50; // negative = more asks = sell pressure
    return Math.max(-60, Math.min(60, obBias * 2));
  }
  return Math.max(-100, Math.min(100, ((hl.tapeBuyVolume - hl.tapeSellVolume) / total) * 100));
}

function computeTypusTapeScore(tape: TapeData): number {
  const total = tape.buyNotionalSui + tape.sellNotionalSui;
  if (total < 0.5) return 0;
  return Math.max(-100, Math.min(100, ((tape.buyNotionalSui - tape.sellNotionalSui) / total) * 100));
}

function computeFundingPressureFromHL(hl: HyperliquidData): number {
  // HL funding is hourly. Convert to 8h equivalent for consistent scaling.
  // Positive = longs pay (long-crowded), negative = shorts pay.
  // At typical 0.01%/8h Bybit baseline: hourly = 0.000125% = 0.00000125
  // Scale: 8h equivalent * 1_000_000 → ±100 at extremes
  const eightHourEquivalent = hl.fundingRate * 8;
  return Math.max(-100, Math.min(100, eightHourEquivalent * 1_000_000));
}

function computeCrowdingScore(
  tapeScore: number,
  oiLongPct: number,
  fundingPressureScore: number,
  oiExpansionScore: number,
): number {
  const oiSkew = Math.abs(oiLongPct - 50) / 50;
  const fundingExtreme = Math.min(1, Math.abs(fundingPressureScore) / 100);
  const tapeImbalance = Math.abs(tapeScore) / 100;
  const oiExpansion = Math.min(1, Math.abs(oiExpansionScore) / 100);
  return Math.min(100, Math.round(35 * oiSkew + 25 * fundingExtreme + 20 * tapeImbalance + 20 * oiExpansion));
}

function computeOiExpansionScore(currentOiLongPct: number, prevOiLongPct: number): number {
  const delta = currentOiLongPct - prevOiLongPct;
  return Math.max(-100, Math.min(100, delta * 10));
}

function classifyRegime(
  crowdingScore: number,
  tapeScore: number,
  fundingPressureScore: number,
): "momentum_continuation" | "exhaustion" | "contrarian_squeeze" | "neutral" {
  if (crowdingScore > 75 && Math.abs(fundingPressureScore) > 30) return "contrarian_squeeze";
  if (crowdingScore > 60 && Math.abs(tapeScore) < 20 && Math.abs(fundingPressureScore) > 20) return "exhaustion";
  if (Math.abs(tapeScore) > 25 && crowdingScore < 65 && Math.abs(fundingPressureScore) < 35) return "momentum_continuation";
  return "neutral";
}

function computeBiases(tapeScore: number, crowdingScore: number): {
  trend: "long" | "short" | "neutral";
  contrarian: "long" | "short" | "neutral";
} {
  const trend: "long" | "short" | "neutral" =
    tapeScore > 20 && crowdingScore < 70 ? "long" :
    tapeScore < -20 && crowdingScore < 70 ? "short" : "neutral";

  const contrarian: "long" | "short" | "neutral" =
    crowdingScore > 75 && tapeScore > 30 ? "short" :
    crowdingScore > 75 && tapeScore < -30 ? "long" : "neutral";

  return { trend, contrarian };
}

// ── Main poll cycle ────────────────────────────────────────────────────────────

async function runPollCycle(): Promise<void> {
  const notes: string[] = [];
  let confidence = 0;
  const markPrice = lastMarkPrice;

  // 1. Hyperliquid — primary data source (FlowX Perp is powered by Hyperliquid)
  const hl = await fetchHyperliquidData();
  let tapeScore = 0;
  let fundingPressureScore = 0;

  if (hl) {
    prevOiLongPct = hlOiLongPct;
    prevOpenInterest = hlOpenInterest;
    hlOiLongPct = hl.oiLongPct;
    hlOiShortPct = hl.oiShortPct;
    hlOpenInterest = hl.openInterest;

    fundingPressureScore = computeFundingPressureFromHL(hl);
    tapeScore = computeHLTapeScore(hl);

    confidence += 70;
    const fundingPct = (hl.fundingRate * 100).toFixed(5);
    const oiM = (hl.openInterest / 1_000_000).toFixed(2);
    notes.push(
      `HL: OI=${oiM}M SUI | funding=${fundingPct}%/hr | OB L/S=${hl.oiLongPct.toFixed(1)}%/${hl.oiShortPct.toFixed(1)}%`
    );

    if (hl.tapeBuyCount + hl.tapeSellCount > 0) {
      notes.push(
        `HL tape: ${hl.tapeBuyCount}↑/${hl.tapeSellCount}↓ | buy=${hl.tapeBuyVolume.toFixed(0)} SUI sell=${hl.tapeSellVolume.toFixed(0)} SUI (score ${tapeScore.toFixed(0)})`
      );
    } else {
      notes.push(`HL tape: no recent trades — using OB imbalance proxy (score ${tapeScore.toFixed(0)})`);
    }
  } else {
    notes.push("Hyperliquid (FlowX Perp): unavailable — using last known estimates");
  }

  // 2. Typus tape — secondary on-SUI tape for cross-venue confirmation
  const typusTape = await fetchTypusTape();
  if (typusTape) {
    const typusTapeScore = computeTypusTapeScore(typusTape);
    // Blend Typus tape into primary tape score (30% weight)
    if (hl) {
      tapeScore = tapeScore * 0.7 + typusTapeScore * 0.3;
    } else {
      tapeScore = typusTapeScore;
    }
    confidence += 30;
    notes.push(`Typus tape: ${typusTape.buyCount}↑/${typusTape.sellCount}↓ opens (${typusTape.eventCount} events, score ${typusTapeScore.toFixed(0)})`);
  } else if (!hl) {
    notes.push("Typus tape: no data available");
  }

  // 3. Derived scores
  const oiExpansionScore = computeOiExpansionScore(hlOiLongPct, prevOiLongPct);
  const crowdingScore = computeCrowdingScore(tapeScore, hlOiLongPct, fundingPressureScore, oiExpansionScore);
  const regime = classifyRegime(crowdingScore, tapeScore, fundingPressureScore);
  const { trend: trendFollowBias, contrarian: contrarianBias } = computeBiases(tapeScore, crowdingScore);

  const newSignal: SentimentSignal = {
    symbol: "SUI-USDC",
    trendFollowBias,
    contrarianBias,
    crowdingScore,
    tapeScore,
    oiExpansionScore,
    fundingPressureScore,
    sentimentAdjustment: 0,
    confidence,
    regime,
    dataAge: 0,
    note: notes[0] || "No data",
    notes,
    updatedAt: Date.now(),
    hyperliquid: hl ? {
      oiLongPct: hl.oiLongPct,
      oiShortPct: hl.oiShortPct,
      fundingRate: hl.fundingRate,
      openInterest: hl.openInterest,
      longShortRatio: hl.longShortRatio,
      markPx: hl.markPx,
      dayVolume: hl.dayVolume,
    } : undefined,
    typus: typusTape ? {
      tapeBuyCount: typusTape.buyCount,
      tapeSellCount: typusTape.sellCount,
      tapeBuyNotionalSui: typusTape.buyNotionalSui,
      tapeSellNotionalSui: typusTape.sellNotionalSui,
      largestBuy: typusTape.largestBuy,
      largestSell: typusTape.largestSell,
    } : undefined,
  };

  currentSignal = newSignal;
  lastPollAt = Date.now();

  const regimeEmoji = regime === "momentum_continuation" ? "▲" :
    regime === "exhaustion" ? "⚠" :
    regime === "contrarian_squeeze" ? "↔" : "─";

  console.log(`[SentimentFlow] ${regimeEmoji} tape=${tapeScore.toFixed(0)} crowd=${crowdingScore} funding=${fundingPressureScore.toFixed(1)} regime=${regime} confidence=${confidence} | ${notes[0]}`);

  // DB snapshot every 5 minutes
  if (Date.now() - lastDbSnapshotAt > DB_SNAPSHOT_INTERVAL_MS && markPrice > 0) {
    try {
      await db.insert(marketSentimentSnapshots).values({
        venue: hl ? (typusTape ? "hyperliquid+typus" : "hyperliquid") : typusTape ? "typus" : "derived",
        symbol: "SUI-USDC",
        markPrice,
        oiLongPct: hlOiLongPct,
        oiShortPct: hlOiShortPct,
        fundingRate: hl?.fundingRate ?? null,
        netRateLong: hl?.fundingRate ?? null,
        netRateShort: hl ? -(hl.fundingRate) : null,
        tapeBuyNotional: typusTape?.buyNotionalSui ?? (hl ? hl.tapeBuyVolume * (hl.markPx || 1) : null),
        tapeSellNotional: typusTape?.sellNotionalSui ?? (hl ? hl.tapeSellVolume * (hl.markPx || 1) : null),
        tapeBuyCount: typusTape?.buyCount ?? hl?.tapeBuyCount ?? null,
        tapeSellCount: typusTape?.sellCount ?? hl?.tapeSellCount ?? null,
        largestBuy: typusTape?.largestBuy ?? null,
        largestSell: typusTape?.largestSell ?? null,
        crowdingScore,
        tapeScore,
        oiExpansionScore,
        fundingPressureScore,
        sentimentAdjustment: 0,
        regime,
        notes,
      });
      lastDbSnapshotAt = Date.now();
    } catch {
      // Non-blocking
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function getSentimentSignal(_symbol = "SUI-USDC"): SentimentSignal {
  const age = Date.now() - (currentSignal.updatedAt || 0);
  return { ...currentSignal, dataAge: age };
}

export function getSentimentContext(_symbol = "SUI-USDC"): SentimentContext | null {
  if (lastPollAt === 0) return null;
  const age = Date.now() - lastPollAt;
  if (age > 10 * 60_000) return null;
  return {
    tapeScore: currentSignal.tapeScore,
    crowdingScore: currentSignal.crowdingScore,
    fundingPressureScore: currentSignal.fundingPressureScore,
    oiExpansionScore: currentSignal.oiExpansionScore,
    confidence: currentSignal.confidence,
    regime: currentSignal.regime,
    dataAge: age,
    note: currentSignal.note,
  };
}

export function startSentimentFlowEngine(): void {
  if (running) return;
  running = true;
  console.log("[SentimentFlow] Started — polling Hyperliquid (FlowX Perp) + Typus tape every 60s");

  setTimeout(() => {
    runPollCycle().catch(e => console.log(`[SentimentFlow] Initial poll error: ${e.message}`));
  }, 15_000);

  pollHandle = setInterval(() => {
    runPollCycle().catch(e => console.log(`[SentimentFlow] Poll error: ${e.message}`));
  }, POLL_INTERVAL_MS);
}

export function stopSentimentFlowEngine(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  running = false;
}
