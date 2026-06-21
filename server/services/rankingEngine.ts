import { fetchCryptoAnalysis, CryptoAnalysis } from "./cryptoMarketData";
import { getEventById, findEventByTeams, SportEvent } from "./sportsResearch";
import { db } from "../db";
import { markets, outcomes, marketSnapshots } from "../../shared/schema";
import { upsertSignalForMarket, pruneStaleSignals } from "../storage";
import { eq, desc } from "drizzle-orm";

export interface RankedSignal {
  marketId: number;
  title: string;
  category: string;
  asset?: string | null;
  sport?: string | null;
  recommendedSide: string;
  confidenceScore: number;
  edgeScore: number;
  riskScore: number;
  reasoning: string;
  supportingDataJson: Record<string, unknown>;
  rankToday: number;
  maxBetPct: number;
  yesPrice: number;
  noPrice: number;
  expirationTime: Date | null;
}

function maxBetFromScore(score: number): number {
  if (score >= 9) return 3;
  if (score >= 8) return 2;
  if (score >= 7) return 1;
  if (score >= 6.5) return 0.5;
  return 0;
}

function riskLevel(score: number): number {
  if (score >= 8.5) return 2;
  if (score >= 7) return 4;
  return 7;
}

async function scoreCryptoMarket(
  marketRow: typeof markets.$inferSelect,
  cryptoData: CryptoAnalysis
): Promise<{ score: number; edge: number; reasoning: string; supporting: Record<string, unknown>; side: string } | null> {
  const spotPrice = cryptoData.price;

  // Fetch outcomes for yesPrice
  const outcomeRows = await db.select().from(outcomes).where(eq(outcomes.marketId, marketRow.id));
  if (outcomeRows.length === 0) return null;
  const yesOutcome = outcomeRows.find(o => o.label === "YES");
  if (!yesOutcome) return null;
  const yesPrice = parseFloat(String(yesOutcome.price));

  // Fetch targetPrice from most recent snapshot
  const snaps = await db.select().from(marketSnapshots)
    .where(eq(marketSnapshots.marketId, marketRow.id))
    .orderBy(desc(marketSnapshots.createdAt))
    .limit(1);
  let targetPrice = snaps[0]?.targetPrice ? parseFloat(String(snaps[0].targetPrice)) : 0;
  if (!targetPrice || isNaN(targetPrice)) {
    const m = marketRow.title.match(/\$([0-9,]+\.?\d*)/);
    targetPrice = m ? parseFloat(m[1].replace(/,/g, "")) : spotPrice * 1.002;
  }

  // ── Determine signal direction from TECHNICALS (not from spot vs target) ──
  // Bullish when RSI above midline AND short EMA above long OR positive momentum
  const bullishSignal = cryptoData.rsi > 53 || (cryptoData.trendUp && cryptoData.momentum5m >= 0);
  const bearishSignal = cryptoData.rsi < 47 || (!cryptoData.trendUp && cryptoData.momentum5m <= 0);

  // "above" markets: YES = price finishes above target; pick YES if bullish, NO if bearish
  const isAboveMarket = marketRow.title.toLowerCase().includes("above");
  const isYesFavored = isAboveMarket ? bullishSignal : bearishSignal;
  const side = isYesFavored ? "YES" : "NO";

  // ── Determine price direction intent ──
  // "above" YES = bullish (price UP); "below" YES = bearish (price DOWN)
  // priceDirection: +1 = expecting price to go UP, -1 = DOWN
  const priceDirection = (isAboveMarket === isYesFavored) ? 1 : -1;

  // ── 30% Momentum: RSI divergence from 50 + momentum direction ──
  const rsiDivergence = Math.abs(cryptoData.rsi - 50); // 0–50 scale
  const momentumAligned = priceDirection > 0
    ? cryptoData.momentum5m >= 0
    : cryptoData.momentum5m <= 0;
  const rsiScore = Math.min(10, rsiDivergence / 5); // 10 at RSI=0 or RSI=100
  const momentumScore = Math.max(2, rsiScore * (momentumAligned ? 1.2 : 0.6));

  // ── 20% Distance to target: 0.05–2% = sweet spot ──
  const distFromTarget = (spotPrice - targetPrice) / targetPrice;
  const absDist = Math.abs(distFromTarget);
  const distanceScore = absDist < 0.0005 ? 2
    : absDist < 0.005 ? 9
    : absDist < 0.015 ? 8
    : absDist < 0.03 ? 6 : 4;

  // ── 20% Volume confirmation ──
  const volScore = cryptoData.volumeChange > 1.3 ? 9
    : cryptoData.volumeChange > 1.1 ? 7
    : cryptoData.volumeChange > 0.9 ? 5
    : cryptoData.volumeChange > 0.7 ? 3 : 1;

  // ── 15% Volatility quality (ATR in healthy range for 15m moves) ──
  const atrPct = cryptoData.atr / spotPrice;
  const volatilityScore = atrPct > 0.002 && atrPct < 0.02 ? 8
    : atrPct >= 0.02 ? 6 : 4;

  // ── 15% Trend alignment ──
  // +1 direction needs trendUp; -1 direction needs trendDown
  const trendAligned = priceDirection > 0 ? cryptoData.trendUp : !cryptoData.trendUp;
  const trendScore = trendAligned ? 9 : 3;

  const finalScore =
    momentumScore * 0.30 +
    distanceScore * 0.20 +
    volScore * 0.20 +
    volatilityScore * 0.15 +
    trendScore * 0.15;

  const clampedScore = Math.max(0, Math.min(10, finalScore));
  if (clampedScore < 4.5) return null;

  // Compute display edge: how strongly the technical signal favors this side
  const signalEdge = parseFloat(((rsiDivergence / 50) * 20 + (momentumAligned ? 5 : 0)).toFixed(1));

  const trendLabel = cryptoData.trendUp ? "bullish" : "bearish";
  const rsiLabel = cryptoData.rsi > 65 ? "overbought" : cryptoData.rsi < 35 ? "oversold" : `RSI ${cryptoData.rsi.toFixed(0)}`;
  const volLabel = cryptoData.volumeChange > 1.1
    ? `volume +${((cryptoData.volumeChange - 1) * 100).toFixed(0)}% vs avg`
    : cryptoData.volumeChange < 0.9
    ? `volume -${((1 - cryptoData.volumeChange) * 100).toFixed(0)}% vs avg`
    : "normal volume";
  const distLabel = `${(absDist * 100).toFixed(2)}% ${distFromTarget > 0 ? "above" : "below"} target`;
  const sideLabel = isAboveMarket ? (isYesFavored ? "YES (bullish)" : "NO (bearish)") : (isYesFavored ? "YES (bearish)" : "NO (bullish)");

  const reasoning = `${cryptoData.symbol} ${trendLabel} — ${rsiLabel}, ${volLabel}. Price ${distLabel} ($${spotPrice.toLocaleString()} vs target $${targetPrice.toLocaleString()}). EMA5 ${cryptoData.trendUp ? ">" : "<"} EMA20, ${trendAligned ? "confirming" : "diverging from"} ${sideLabel} recommendation. ATR ${(atrPct * 100).toFixed(2)}% (${atrPct < 0.02 ? "healthy" : "elevated"} volatility for 15m window).`;

  return {
    score: clampedScore, edge: signalEdge, reasoning, side,
    supporting: {
      asset: cryptoData.symbol, spotPrice, targetPrice,
      rsi: parseFloat(cryptoData.rsi.toFixed(1)),
      momentum5m: parseFloat(cryptoData.momentum5m.toFixed(4)),
      trendUp: cryptoData.trendUp,
      volumeChange: parseFloat(cryptoData.volumeChange.toFixed(3)),
      atr: parseFloat(cryptoData.atr.toFixed(4)),
      vwap: parseFloat(cryptoData.vwap.toFixed(2)),
      isAboveMarket, yesPrice, signalEdge,
      scoreBreakdown: {
        "Momentum (30%)": parseFloat(momentumScore.toFixed(1)),
        "Distance to Target (20%)": parseFloat(distanceScore.toFixed(1)),
        "Volume Confirmation (20%)": parseFloat(volScore.toFixed(1)),
        "Volatility Quality (15%)": parseFloat(volatilityScore.toFixed(1)),
        "Trend Alignment (15%)": parseFloat(trendScore.toFixed(1)),
      },
    },
  };
}

function scoreSportsMarket(
  marketRow: typeof markets.$inferSelect,
  event: SportEvent,
  yesPrice: number
): { score: number; edge: number; reasoning: string; supporting: Record<string, unknown>; side: string } | null {
  const coinbaseImplied = parseFloat(String(yesPrice));
  const externalProb = event.homeExternalOdds;
  // Guard against NaN/null external odds (can happen if odds data is missing)
  if (externalProb == null || isNaN(externalProb) || isNaN(coinbaseImplied)) return null;
  const edge = externalProb - coinbaseImplied;

  if (Math.abs(edge) < 0.01) return null;
  const side = edge > 0 ? "YES" : "NO";
  const favoredTeam = edge > 0 ? event.homeTeam : event.awayTeam;
  const edgeOnFavored = Math.abs(edge);

  // 25% External odds edge
  const oddsEdgeScore = Math.min(10, edgeOnFavored * 45);

  // 20% Recent form
  const form = edge > 0 ? event.homeForm : event.awayForm;
  const wins = form.filter(r => r === "W").length;
  const formScore = form.length > 0 ? (wins / form.length) * 10 : 5; // default 5 when no form data

  // 15% Injury advantage
  const ourInjuries = edge > 0 ? event.homeInjuries : event.awayInjuries;
  const theirInjuries = edge > 0 ? event.awayInjuries : event.homeInjuries;
  const injuryScore = ourInjuries.length === 0 && theirInjuries.length > 0 ? 9
    : ourInjuries.length === 0 ? 7
    : ourInjuries.length === 1 ? 5 : 3;

  // 15% Market mispricing (same as edge)
  const mispricingScore = oddsEdgeScore;

  // 10% Volume/liquidity
  const volumeScore = event.marketVolume > 200000 ? 9
    : event.marketVolume > 100000 ? 7
    : event.marketVolume > 50000 ? 5 : 3;

  // 10% Time to event: live/imminent = best (most info, highest liquidity), far future = less certain
  const hoursToEvent = (event.startTime.getTime() - Date.now()) / 3600000;
  const timeScore = hoursToEvent < 0 ? 9   // live event — best opportunity
    : hoursToEvent < 3 ? 8                  // starting very soon
    : hoursToEvent < 24 ? 9                 // today
    : hoursToEvent < 48 ? 7 : 5;           // tomorrow / later

  // 5% Sentiment/narrative
  const sentimentScore = theirInjuries.length > 0 ? 8 : 6;

  const finalScore =
    oddsEdgeScore * 0.25 + formScore * 0.20 + injuryScore * 0.15 +
    mispricingScore * 0.15 + volumeScore * 0.10 + timeScore * 0.10 +
    sentimentScore * 0.05;

  const clampedScore = Math.max(0, Math.min(10, finalScore));
  if (clampedScore < 4.5) return null;

  const injuryNote = theirInjuries.length > 0 ? ` Key opponent injury: ${theirInjuries[0]}.` : "";
  const formWinPct = form.length > 0 ? (wins / form.length * 100).toFixed(0) : "n/a";
  const formNote = form.length > 0 ? `Recent form: ${wins}/${form.length} wins (${formWinPct}%). ` : "";
  const reasoning = `${favoredTeam} backed at ${(edgeOnFavored * 100).toFixed(1)}% edge. DraftKings consensus: ${(externalProb * 100).toFixed(0)}% — market-implied probability ${(coinbaseImplied * 100).toFixed(0)}%.${injuryNote} ${formNote}H2H: ${event.headToHead}. ${event.context}`;

  return {
    score: clampedScore, edge: parseFloat((edgeOnFavored * 100).toFixed(1)), reasoning, side,
    supporting: {
      sport: event.sport, homeTeam: event.homeTeam, awayTeam: event.awayTeam,
      event: event.event, coinbaseImpliedProb: coinbaseImplied.toFixed(3),
      externalOdds: externalProb.toFixed(3), edge: edgeOnFavored.toFixed(3),
      homeForm: event.homeForm, awayForm: event.awayForm,
      injuries: [...event.homeInjuries, ...event.awayInjuries],
      headToHead: event.headToHead, marketVolume: event.marketVolume,
      startTime: event.startTime.toISOString(), context: event.context,
      coinbaseLink: (event as any).coinbaseLink ?? null,
      homeProfile: (event as any).homeProfile ?? null,
      awayProfile: (event as any).awayProfile ?? null,
      scoreBreakdown: {
        "Odds Edge (25%)": parseFloat(oddsEdgeScore.toFixed(1)),
        "Recent Form (20%)": parseFloat(formScore.toFixed(1)),
        "Injury Advantage (15%)": parseFloat(injuryScore.toFixed(1)),
        "Market Mispricing (15%)": parseFloat(mispricingScore.toFixed(1)),
        "Volume/Liquidity (10%)": parseFloat(volumeScore.toFixed(1)),
        "Time to Event (10%)": parseFloat(timeScore.toFixed(1)),
        "Sentiment (5%)": parseFloat(sentimentScore.toFixed(1)),
      },
    },
  };
}

export async function recalculateAllSignals(): Promise<number> {
  const allMarkets = await db.select().from(markets).where(eq(markets.status, "active"));
  const rankedSignals: Array<RankedSignal & { rawScore: number }> = [];

  // Cache crypto analysis per symbol to avoid repeated API calls
  const cryptoCache = new Map<string, CryptoAnalysis>();

  for (const market of allMarkets) {
    try {
      const outcomeRows = await db.select().from(outcomes).where(eq(outcomes.marketId, market.id));
      const yesOutcome = outcomeRows.find(o => o.label === "YES");
      const noOutcome = outcomeRows.find(o => o.label === "NO");
      if (!yesOutcome || !noOutcome) continue;

      let result: { score: number; edge: number; reasoning: string; supporting: Record<string, unknown>; side: string } | null = null;

      if (market.category === "crypto" && market.asset) {
        let crypto = cryptoCache.get(market.asset);
        if (!crypto) {
          crypto = await fetchCryptoAnalysis(market.asset);
          cryptoCache.set(market.asset, crypto);
        }
        result = await scoreCryptoMarket(market, crypto);
      } else if (market.category === "sports") {
        // Try exact ID match first, then fall back to team-name parsing from market title
        let event = getEventById(market.coinbaseMarketId);
        if (!event) {
          // Parse "⚽ Soccer: Will England win vs Germany?" → home="England", away="Germany"
          const m = market.title.match(/Will (.+?) win vs (.+?)[\?]?\s*$/i);
          if (m) event = findEventByTeams(m[1].trim(), m[2].trim());
        }
        if (event) {
          result = scoreSportsMarket(market, event, parseFloat(String(yesOutcome.price)));
        }
      }

      if (!result || isNaN(result.score) || isNaN(result.edge)) continue;

      rankedSignals.push({
        marketId: market.id,
        title: market.title,
        category: market.category,
        asset: market.asset,
        sport: market.sport,
        recommendedSide: result.side,
        confidenceScore: parseFloat(result.score.toFixed(1)),
        edgeScore: result.edge,
        riskScore: riskLevel(result.score),
        reasoning: result.reasoning,
        supportingDataJson: result.supporting,
        rankToday: 0,
        maxBetPct: maxBetFromScore(result.score),
        yesPrice: parseFloat(String(yesOutcome.price)),
        noPrice: parseFloat(String(noOutcome.price)),
        expirationTime: market.expirationTime,
        rawScore: result.score,
      });
    } catch (err) {
      console.warn(`[RankingEngine] Failed to score market ${market.id}:`, (err as Error).message);
    }
  }

  // Up to 20 sports + 5 crypto slots — keep all scoreable picks so Tomorrow/This Week tabs are always populated
  const cryptoPool = rankedSignals.filter(s => s.category === "crypto").sort((a, b) => b.rawScore - a.rawScore);
  const sportsPool = rankedSignals.filter(s => s.category === "sports").sort((a, b) => b.rawScore - a.rawScore);
  const sportsSlots = Math.min(20, sportsPool.length);
  const cryptoSlots = Math.min(5, cryptoPool.length);
  const topSignals = [...sportsPool.slice(0, sportsSlots), ...cryptoPool.slice(0, cryptoSlots)]
    .sort((a, b) => b.rawScore - a.rawScore);

  // Upsert each signal (stable IDs — same marketId+today row is UPDATED, not deleted+recreated)
  const keepMarketIds: number[] = [];
  for (let i = 0; i < topSignals.length; i++) {
    const s = topSignals[i];
    await upsertSignalForMarket({
      marketId: s.marketId,
      recommendedSide: s.recommendedSide,
      confidenceScore: s.confidenceScore,
      edgeScore: s.edgeScore,
      riskScore: s.riskScore,
      reasoning: s.reasoning,
      supportingDataJson: s.supportingDataJson,
      rankToday: i + 1,
      maxBetPct: s.maxBetPct,
    });
    keepMarketIds.push(s.marketId);
  }

  // Remove signals for markets that fell out of the active pool
  await pruneStaleSignals(keepMarketIds);

  console.log(`[RankingEngine] Scored ${rankedSignals.length} markets (${sportsPool.length} sports, ${cryptoPool.length} crypto), stored top ${topSignals.length}`);
  return topSignals.length;
}
