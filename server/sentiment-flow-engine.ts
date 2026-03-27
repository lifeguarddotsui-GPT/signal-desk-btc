/**
 * SentimentFlowEngine — Venue crowd intelligence for improved agent win rate.
 *
 * Collects and synthesizes crowd positioning data from:
 *   1. Bybit Futures REST API — OI long/short ratio + funding rate (public, no auth needed)
 *   2. Typus Perps on-chain events (CreateTradingOrderEvent tape flow) — graceful fallback
 *   3. Derived signals from our own candle/volume history
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
const BYBIT_API_TIMEOUT_MS = 7_000;

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
  bybit?: {
    oiLongPct: number;
    oiShortPct: number;
    fundingRate: number;
    openInterest: number;
    longShortRatio: number;
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

// Rolling OI skew tracker (from Bybit data, updated each cycle)
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

// ── Bybit Futures fetcher ──────────────────────────────────────────────────────
// Uses Bybit's public REST API — no authentication required.
// Endpoints: ticker (funding rate + OI), account-ratio (long/short split)

interface BybitData {
  oiLongPct: number;
  oiShortPct: number;
  fundingRate: number;    // Current funding rate (positive = longs pay)
  openInterest: number;   // Total OI in USD
  longShortRatio: number; // long accounts / short accounts
}

async function fetchBybitData(): Promise<BybitData | null> {
  try {
    // 1. Fetch ticker for funding rate and OI
    const tickerRes = await fetch(
      "https://api.bybit.com/v5/market/tickers?category=linear&symbol=SUIUSDT",
      { signal: AbortSignal.timeout(BYBIT_API_TIMEOUT_MS) },
    );
    if (!tickerRes.ok) return null;
    const tickerData = await tickerRes.json() as any;
    const ticker = tickerData?.result?.list?.[0];
    if (!ticker) return null;

    const fundingRate = parseFloat(ticker.fundingRate ?? "0") || 0;
    const openInterest = parseFloat(ticker.openInterestValue ?? ticker.openInterest ?? "0") || 0;

    // 2. Fetch long/short ratio for OI split
    let oiLongPct = 50;
    let oiShortPct = 50;
    let longShortRatio = 1.0;
    try {
      const ratioRes = await fetch(
        "https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=SUIUSDT&period=5min&limit=1",
        { signal: AbortSignal.timeout(BYBIT_API_TIMEOUT_MS) },
      );
      if (ratioRes.ok) {
        const ratioData = await ratioRes.json() as any;
        const ratioItem = ratioData?.result?.list?.[0];
        if (ratioItem) {
          const buyRatio = parseFloat(ratioItem.buyRatio ?? "0.5") || 0.5;
          const sellRatio = parseFloat(ratioItem.sellRatio ?? "0.5") || 0.5;
          const total = buyRatio + sellRatio;
          if (total > 0) {
            oiLongPct = (buyRatio / total) * 100;
            oiShortPct = (sellRatio / total) * 100;
            longShortRatio = sellRatio > 0 ? buyRatio / sellRatio : 1.0;
          }
        }
      }
    } catch {
      // Use 50/50 split if ratio fetch fails
    }

    return { oiLongPct, oiShortPct, fundingRate, openInterest, longShortRatio };
  } catch (err: any) {
    console.log(`[SentimentFlow] Bybit fetch failed: ${err.message?.slice(0, 80)}`);
    return null;
  }
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

// ── Funding pressure score via Bybit (replaces ZO Finance) ────────────────────

function computeFundingPressureFromBybit(bybit: BybitData): number {
  // Bybit funding rate: positive = longs pay (long-crowded market)
  // Scale: 0.0001 (1bp) → 100 pts
  return Math.max(-100, Math.min(100, bybit.fundingRate * 1_000_000));
}

// ── Main poll cycle ────────────────────────────────────────────────────────────

async function runPollCycle(): Promise<void> {
  const notes: string[] = [];
  let confidence = 0;
  const markPrice = lastMarkPrice;

  // 1. Bybit Futures data — OI long/short ratio + funding rate
  const bybit = await fetchBybitData();
  let fundingPressureScore = 0;
  if (bybit) {
    prevOiLongPct = zoOiLongPct;
    zoOiLongPct = bybit.oiLongPct;
    zoOiShortPct = bybit.oiShortPct;
    fundingPressureScore = computeFundingPressureFromBybit(bybit);
    oiTrend = bybit.oiLongPct - prevOiLongPct;
    confidence += 55;
    const fundingStr = (bybit.fundingRate * 100).toFixed(4);
    notes.push(`Bybit L/S: ${bybit.oiLongPct.toFixed(1)}%/${bybit.oiShortPct.toFixed(1)}% | funding=${fundingStr}% | L/S ratio=${bybit.longShortRatio.toFixed(2)}`);
  } else {
    notes.push("Bybit: unavailable — using last known OI estimate");
  }

  // 2. Typus tape — on-chain order flow (best-effort, graceful skip)
  const tape = await fetchTypusTape();
  let tapeScore = 0;
  if (tape) {
    tapeScore = computeTapeScore(tape);
    confidence += 45;
    notes.push(`Typus tape: ${tape.buyCount}↑/${tape.sellCount}↓ opens (${tape.eventCount} events, score ${tapeScore.toFixed(0)})`);
  } else if (bybit) {
    // Derive a tape proxy from the Bybit long/short ratio when on-chain tape unavailable
    const lsRatio = bybit.longShortRatio;
    tapeScore = Math.max(-60, Math.min(60, (lsRatio - 1) * 50));
    notes.push(`Tape derived from Bybit L/S ratio (${bybit.longShortRatio.toFixed(2)}): score=${tapeScore.toFixed(0)}`);
  } else {
    notes.push("Tape: no data available");
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
    sentimentAdjustment: 0,
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
    bybit: bybit ? {
      oiLongPct: bybit.oiLongPct,
      oiShortPct: bybit.oiShortPct,
      fundingRate: bybit.fundingRate,
      openInterest: bybit.openInterest,
      longShortRatio: bybit.longShortRatio,
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
        venue: bybit ? (tape ? "bybit+typus" : "bybit") : tape ? "typus" : "derived",
        symbol: "SUI-USDC",
        markPrice,
        oiLongPct: zoOiLongPct,
        oiShortPct: zoOiShortPct,
        fundingRate: bybit?.fundingRate ?? null,
        netRateLong: bybit?.fundingRate ?? null,
        netRateShort: bybit ? -(bybit.fundingRate) : null,
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
