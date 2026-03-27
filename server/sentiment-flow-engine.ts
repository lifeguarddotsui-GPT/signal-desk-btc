/**
 * SentimentFlowEngine — Venue crowd intelligence for improved agent win rate.
 *
 * Collects and synthesizes crowd positioning data from:
 *   1. Typus Perps on-chain events (CreateTradingOrderEvent tape flow)
 *   2. ZO Finance REST API (OI / net rate / tape feed) — graceful fallback if unavailable
 *   3. Derived signals from our own candle/volume history
 *
 * Outputs a SentimentSignal consumed by the signal engine as a ±8 point
 * score modifier — keeping it as a secondary layer, not the primary driver.
 *
 * Phase implementation:
 *   Phase 1 → data collection + scoring (this build)
 *   Phase 2 → UI display (SentimentFlow card on Market Dashboard)
 *   Phase 3 → score integration (signal engine modifier)
 *   Phase 4 → contrarian entries with reduced size (future)
 */

import { db } from "./db";
import { marketSentimentSnapshots } from "../shared/schema";
import { getThrottledSuiClient } from "./rpc-throttle";
import type { SentimentContext } from "./signal-engine";

const MIST_PER_SUI = 1_000_000_000;
const PERP_TRADING_PACKAGE = "0x9003219180252ae6b81d2893b41d430488669027219537236675c0c2924c94d9";
const POLL_INTERVAL_MS = 60_000;
const DB_SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const ZO_API_TIMEOUT_MS = 5_000;

export interface SentimentSignal extends SentimentContext {
  symbol: string;
  trendFollowBias: "long" | "short" | "neutral";
  contrarianBias: "long" | "short" | "neutral";
  sentimentAdjustment: number; // computed for last known side — raw adjustment for signal engine use
  notes: string[];
  typus?: {
    tapeBuyCount: number;
    tapeSellCount: number;
    tapeBuyNotionalSui: number;
    tapeSellNotionalSui: number;
    largestBuy: number;
    largestSell: number;
  };
  zo?: {
    oiLongPct: number;
    oiShortPct: number;
    netRateLong: number;
    netRateShort: number;
    oiLongUsd: number;
    oiShortUsd: number;
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

// Mark price provided externally by market-engine (avoids circular import)
let lastMarkPrice = 0;
export function updateMarkPrice(price: number): void { lastMarkPrice = price; }

// Rolling OI skew tracker (from ZO data, updated each cycle)
let zoOiLongPct = 50;
let zoOiShortPct = 50;
let prevOiLongPct = 50;
let oiTrend = 0; // + = longs growing, - = shorts growing

// ── Typus tape fetcher ─────────────────────────────────────────────────────────

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

      // Only count new position opens, not closes or stop orders
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

// ── ZO Finance fetcher ─────────────────────────────────────────────────────────

interface ZoData {
  oiLongPct: number;
  oiShortPct: number;
  netRateLong: number;
  netRateShort: number;
  oiLongUsd: number;
  oiShortUsd: number;
}

const ZO_ENDPOINTS = [
  "https://api.zofai.io/v1/markets/SUI-USD",
  "https://api.zofai.io/markets/SUI-USD",
  "https://api.zofai.io/v1/market/SUI-USD/stats",
  "https://api.zofai.io/v2/markets",
];

async function fetchZoData(): Promise<ZoData | null> {
  for (const url of ZO_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ZO_API_TIMEOUT_MS);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "Accept": "application/json", "Origin": "https://app.zofai.io" },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json() as any;

      // Parse various possible response shapes
      const oiLong = data.openInterestLong || data.oi_long || data.longOI || data.long_oi || 0;
      const oiShort = data.openInterestShort || data.oi_short || data.shortOI || data.short_oi || 0;
      const oiTotal = oiLong + oiShort;
      if (oiTotal <= 0) continue;

      return {
        oiLongPct: (oiLong / oiTotal) * 100,
        oiShortPct: (oiShort / oiTotal) * 100,
        netRateLong: data.netRateLong || data.net_rate_long || data.fundingLong || 0,
        netRateShort: data.netRateShort || data.net_rate_short || data.fundingShort || 0,
        oiLongUsd: oiLong,
        oiShortUsd: oiShort,
      };
    } catch {
      continue;
    }
  }
  return null;
}

// ── Score computation ──────────────────────────────────────────────────────────

function computeTapeScore(tape: TapeData): number {
  const total = tape.buyNotionalSui + tape.sellNotionalSui;
  if (total < 0.5) return 0;
  return Math.max(-100, Math.min(100, ((tape.buyNotionalSui - tape.sellNotionalSui) / total) * 100));
}

function computeCrowdingScore(
  tapeScore: number,
  zoOiLongPct: number,
  fundingPressureScore: number,
  oiExpansionScore: number,
): number {
  // Crowding formula (from design doc):
  //   35 * normalizedOiSkew + 25 * normalizedFundingExtreme + 20 * normalizedTapeImbalance + 20 * normalizedOiExpansion
  const oiSkew = Math.abs(zoOiLongPct - 50) / 50;           // 0-1
  const fundingExtreme = Math.min(1, Math.abs(fundingPressureScore) / 100);  // 0-1
  const tapeImbalance = Math.abs(tapeScore) / 100;           // 0-1
  const oiExpansion = Math.min(1, Math.abs(oiExpansionScore) / 100);        // 0-1
  return Math.min(100, Math.round(35 * oiSkew + 25 * fundingExtreme + 20 * tapeImbalance + 20 * oiExpansion));
}

function computeFundingPressureScore(zo: ZoData | null): number {
  if (!zo) return 0;
  // Positive = longs pay (long-crowded), Negative = shorts pay
  const netRateDiff = zo.netRateLong - zo.netRateShort;
  return Math.max(-100, Math.min(100, netRateDiff * 10_000)); // Scale bps to -100..+100
}

function computeOiExpansionScore(currentLongPct: number, prevLongPct: number): number {
  const delta = currentLongPct - prevLongPct;
  return Math.max(-100, Math.min(100, delta * 10)); // Scale 1% delta → 10 pts
}

function classifyRegime(
  crowdingScore: number,
  tapeScore: number,
  fundingPressureScore: number,
): "momentum_continuation" | "exhaustion" | "contrarian_squeeze" | "neutral" {
  // Contrarian squeeze: extreme crowd AND funding extreme
  if (crowdingScore > 75 && Math.abs(fundingPressureScore) > 30) {
    return "contrarian_squeeze";
  }
  // Exhaustion: high crowding, tape slowing, funding building
  if (crowdingScore > 60 && Math.abs(tapeScore) < 20 && Math.abs(fundingPressureScore) > 20) {
    return "exhaustion";
  }
  // Momentum continuation: directional tape, manageable crowding, funding not extreme
  if (Math.abs(tapeScore) > 25 && crowdingScore < 65 && Math.abs(fundingPressureScore) < 35) {
    return "momentum_continuation";
  }
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

  // 1. Typus tape
  const tape = await fetchTypusTape();
  let tapeScore = 0;
  if (tape) {
    tapeScore = computeTapeScore(tape);
    confidence += 50;
    notes.push(`Typus tape: ${tape.buyCount}↑/${tape.sellCount}↓ opens (${tape.eventCount} events, score ${tapeScore.toFixed(0)})`);
  } else {
    notes.push("Typus tape: unavailable (RPC or rate limit)");
  }

  // 2. ZO Finance OI / funding
  const zo = await fetchZoData();
  let fundingPressureScore = 0;
  if (zo) {
    prevOiLongPct = zoOiLongPct;
    zoOiLongPct = zo.oiLongPct;
    zoOiShortPct = zo.oiShortPct;
    fundingPressureScore = computeFundingPressureScore(zo);
    oiTrend = zo.oiLongPct - prevOiLongPct;
    confidence += 50;
    notes.push(`ZO OI: L${zo.oiLongPct.toFixed(1)}% / S${zo.oiShortPct.toFixed(1)}% | netRate L${(zo.netRateLong * 100).toFixed(4)}%`);
  } else {
    // Fallback: ZO data unavailable — use tape-derived OI proxy
    if (tape && tape.eventCount > 10) {
      const tapeLongPct = tape.buyCount / Math.max(1, tape.buyCount + tape.sellCount) * 100;
      prevOiLongPct = zoOiLongPct;
      zoOiLongPct = zoOiLongPct * 0.9 + tapeLongPct * 0.1; // Slow-blend tape into OI estimate
      zoOiShortPct = 100 - zoOiLongPct;
      confidence += 10;
      notes.push(`ZO: unavailable — using tape-derived OI estimate (L${zoOiLongPct.toFixed(1)}%)`);
    } else {
      notes.push("ZO: unavailable, insufficient tape for OI estimate");
    }
  }

  // 3. Derived scores
  const oiExpansionScore = computeOiExpansionScore(zoOiLongPct, prevOiLongPct);
  const crowdingScore = computeCrowdingScore(tapeScore, zoOiLongPct, fundingPressureScore, oiExpansionScore);
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
    sentimentAdjustment: 0, // will be computed per-trade in signal engine
    confidence,
    regime,
    dataAge: 0,
    note: notes[0] || "No data",
    notes,
    updatedAt: Date.now(),
    typus: tape ? {
      tapeBuyCount: tape.buyCount,
      tapeSellCount: tape.sellCount,
      tapeBuyNotionalSui: tape.buyNotionalSui,
      tapeSellNotionalSui: tape.sellNotionalSui,
      largestBuy: tape.largestBuy,
      largestSell: tape.largestSell,
    } : undefined,
    zo: zo ? {
      oiLongPct: zo.oiLongPct,
      oiShortPct: zo.oiShortPct,
      netRateLong: zo.netRateLong,
      netRateShort: zo.netRateShort,
      oiLongUsd: zo.oiLongUsd,
      oiShortUsd: zo.oiShortUsd,
    } : undefined,
  };

  currentSignal = newSignal;
  lastPollAt = Date.now();

  const regimeEmoji = regime === "momentum_continuation" ? "▲" :
    regime === "exhaustion" ? "⚠" :
    regime === "contrarian_squeeze" ? "↔" : "─";

  console.log(`[SentimentFlow] ${regimeEmoji} tape=${tapeScore.toFixed(0)} crowd=${crowdingScore} funding=${fundingPressureScore.toFixed(0)} regime=${regime} confidence=${confidence} | ${notes.slice(0, 2).join(" | ")}`);

  // DB snapshot every 5 minutes
  if (Date.now() - lastDbSnapshotAt > DB_SNAPSHOT_INTERVAL_MS && markPrice > 0) {
    try {
      await db.insert(marketSentimentSnapshots).values({
        venue: zo ? "typus+zo" : tape ? "typus" : "derived",
        symbol: "SUI-USDC",
        markPrice,
        oiLongPct: zoOiLongPct,
        oiShortPct: zoOiShortPct,
        fundingRate: zo?.netRateLong ?? null,
        netRateLong: zo?.netRateLong ?? null,
        netRateShort: zo?.netRateShort ?? null,
        tapeBuyNotional: tape?.buyNotionalSui ?? null,
        tapeSellNotional: tape?.sellNotionalSui ?? null,
        tapeBuyCount: tape?.buyCount ?? null,
        tapeSellCount: tape?.sellCount ?? null,
        largestBuy: tape?.largestBuy ?? null,
        largestSell: tape?.largestSell ?? null,
        crowdingScore,
        tapeScore,
        oiExpansionScore,
        fundingPressureScore,
        sentimentAdjustment: 0,
        regime,
        notes,
      });
      lastDbSnapshotAt = Date.now();
    } catch (dbErr: any) {
      // Non-blocking — DB snapshot is best-effort
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function getSentimentSignal(_symbol = "SUI-USDC"): SentimentSignal {
  const age = Date.now() - (currentSignal.updatedAt || 0);
  return { ...currentSignal, dataAge: age };
}

export function getSentimentContext(_symbol = "SUI-USDC"): SentimentContext | null {
  if (lastPollAt === 0) return null; // Not yet polled
  const age = Date.now() - lastPollAt;
  if (age > 10 * 60_000) return null; // Data older than 10 min — don't influence trading
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
  console.log("[SentimentFlow] Started — polling venues every 60s for crowd intelligence");

  // Initial poll after 15s (let other engines start first)
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
