import { fetchCryptoAnalysis, CryptoAnalysis } from "./cryptoMarketData";
import { getEventById, SportEvent } from "./sportsResearch";
import { db } from "../db";
import { markets, outcomes } from "../../shared/schema";
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
  const spotPrice = marketRow.coinbaseMarketId.includes("btc") ?
    cryptoData.price : cryptoData.price;

  // Get the target from the market title
  const outcomeRows = await db.select().from(outcomes).where(eq(outcomes.marketId, marketRow.id));
  if (outcomeRows.length === 0) return null;

  const yesOutcome = outcomeRows.find(o => o.label === "YES");
  if (!yesOutcome) return null;
  const yesPrice = yesOutcome.price;

  // Extract target price from market's stored data (we'll use the coinbaseMarketId parts)
  const snapshot = await db.query.marketSnapshots?.findFirst?.({
    where: (s: any) => eq(s.marketId, marketRow.id),
    orderBy: (s: any) => [desc(s.createdAt)],
  });

  const targetPrice = snapshot?.targetPrice ?? spotPrice * 1.001;
  const distFromTarget = (spotPrice - targetPrice) / targetPrice;

  // Determine recommended side
  const isYesFavored = spotPrice > targetPrice || (cryptoData.rsi > 55 && cryptoData.trendUp);
  const side = isYesFavored ? "YES" : "NO";

  // ── Scoring components ──
  // 30% Momentum: RSI position + price direction
  const rsiMomentum = isYesFavored
    ? Math.min(10, (cryptoData.rsi - 45) / 0.6)
    : Math.min(10, (55 - cryptoData.rsi) / 0.6);
  const momentumScore = Math.max(0, rsiMomentum * (0.5 + cryptoData.momentum5m * 0.5));

  // 20% Distance to target: sweet spot 0.1-2%
  const absDist = Math.abs(distFromTarget);
  const distanceScore = absDist < 0.001 ? 3
    : absDist < 0.01 ? 9
    : absDist < 0.02 ? 7
    : absDist < 0.04 ? 5 : 3;

  // 15% Volume confirmation
  const volumeScore = Math.min(10, (cryptoData.volumeChange - 0.8) * 15);

  // 15% Volatility quality
  const atrPct = cryptoData.atr / spotPrice;
  const volatilityScore = atrPct > 0.002 && atrPct < 0.025 ? 8 : atrPct < 0.002 ? 4 : 5;

  // 10% Trend alignment
  const trendAligned = (isYesFavored && cryptoData.trendUp) || (!isYesFavored && !cryptoData.trendUp);
  const trendScore = trendAligned ? 9 : 3;

  // 10% Mispricing edge
  const modelProb = isYesFavored
    ? 0.4 + (cryptoData.rsi / 100) * 0.3 + (cryptoData.momentum5m * 0.2)
    : 0.6 - (cryptoData.rsi / 100) * 0.3;
  const contractPrice = isYesFavored ? yesPrice : (1 - yesPrice);
  const edgePct = modelProb - contractPrice;
  const mispricingScore = Math.max(0, Math.min(10, edgePct * 60));

  const finalScore =
    momentumScore * 0.30 +
    distanceScore * 0.20 +
    volumeScore * 0.15 +
    volatilityScore * 0.15 +
    trendScore * 0.10 +
    mispricingScore * 0.10;

  const clampedScore = Math.max(0, Math.min(10, finalScore));

  if (clampedScore < 5.5) return null;

  const edge = parseFloat((Math.abs(edgePct) * 100).toFixed(1));

  const trendLabel = cryptoData.trendUp ? "bullish" : "bearish";
  const rsiLabel = cryptoData.rsi > 65 ? "overbought zone" : cryptoData.rsi < 35 ? "oversold zone" : `neutral (${cryptoData.rsi.toFixed(0)})`;
  const volLabel = cryptoData.volumeChange > 1.15 ? `volume up ${((cryptoData.volumeChange - 1) * 100).toFixed(0)}%` : "normal volume";
  const distLabel = `${(Math.abs(distFromTarget) * 100).toFixed(2)}% ${distFromTarget > 0 ? "above" : "below"} target`;

  const reasoning = `${cryptoData.symbol} ${trendLabel} with RSI ${rsiLabel}. Price is ${distLabel}. ${volLabel.charAt(0).toUpperCase() + volLabel.slice(1)}. Model probability: ${(modelProb * 100).toFixed(0)}% vs market implied ${(contractPrice * 100).toFixed(0)}% — edge of ${edge}%. EMA slope ${cryptoData.trendUp ? "rising" : "falling"}, ${trendAligned ? "confirming" : "diverging from"} ${side} signal.`;

  return {
    score: clampedScore, edge, reasoning, side,
    supporting: {
      asset: cryptoData.symbol, spotPrice, targetPrice,
      rsi: cryptoData.rsi.toFixed(1), momentum5m: cryptoData.momentum5m.toFixed(2),
      trendUp: cryptoData.trendUp, volumeChange: cryptoData.volumeChange.toFixed(2),
      atr: cryptoData.atr.toFixed(4), vwap: cryptoData.vwap.toFixed(2),
      modelProbability: modelProb.toFixed(3), yesPrice, edgePct: edge,
      scoreBreakdown: {
        "Momentum (30%)": parseFloat(momentumScore.toFixed(1)),
        "Distance to Target (20%)": parseFloat(distanceScore.toFixed(1)),
        "Volume Confirmation (15%)": parseFloat(Math.max(0, volumeScore).toFixed(1)),
        "Volatility Quality (15%)": parseFloat(volatilityScore.toFixed(1)),
        "Trend Alignment (10%)": parseFloat(trendScore.toFixed(1)),
        "Mispricing Edge (10%)": parseFloat(mispricingScore.toFixed(1)),
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
  const edge = externalProb - coinbaseImplied;

  if (Math.abs(edge) < 0.015) return null;
  const side = edge > 0 ? "YES" : "NO";
  const favoredTeam = edge > 0 ? event.homeTeam : event.awayTeam;
  const edgeOnFavored = Math.abs(edge);

  // 25% External odds edge
  const oddsEdgeScore = Math.min(10, edgeOnFavored * 45);

  // 20% Recent form
  const form = edge > 0 ? event.homeForm : event.awayForm;
  const wins = form.filter(r => r === "W").length;
  const formScore = (wins / form.length) * 10;

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

  // 10% Time to event: 1-24 hours optimal
  const hoursToEvent = (event.startTime.getTime() - Date.now()) / 3600000;
  const timeScore = hoursToEvent < 0.5 ? 4
    : hoursToEvent < 2 ? 7
    : hoursToEvent < 24 ? 9
    : hoursToEvent < 48 ? 7 : 5;

  // 5% Sentiment/narrative
  const sentimentScore = theirInjuries.length > 0 ? 8 : 6;

  const finalScore =
    oddsEdgeScore * 0.25 + formScore * 0.20 + injuryScore * 0.15 +
    mispricingScore * 0.15 + volumeScore * 0.10 + timeScore * 0.10 +
    sentimentScore * 0.05;

  const clampedScore = Math.max(0, Math.min(10, finalScore));
  if (clampedScore < 5.5) return null;

  const injuryNote = theirInjuries.length > 0 ? ` Key opponent injury: ${theirInjuries[0]}.` : "";
  const formWinPct = (wins / form.length * 100).toFixed(0);
  const reasoning = `${favoredTeam} backed at ${(edgeOnFavored * 100).toFixed(1)}% edge over Coinbase implied odds. External sportsbook consensus: ${(externalProb * 100).toFixed(0)}% vs Coinbase ${(coinbaseImplied * 100).toFixed(0)}%.${injuryNote} Recent form: ${wins}/${form.length} wins (${formWinPct}%). H2H: ${event.headToHead}. ${event.context}`;

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
        const event = getEventById(market.coinbaseMarketId);
        if (event) {
          result = scoreSportsMarket(market, event, yesOutcome.price);
        }
      }

      if (!result) continue;

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

  // 7 sports + 3 crypto slots (sports-first, fill remaining with best crypto)
  const cryptoPool = rankedSignals.filter(s => s.category === "crypto").sort((a, b) => b.rawScore - a.rawScore);
  const sportsPool = rankedSignals.filter(s => s.category === "sports").sort((a, b) => b.rawScore - a.rawScore);
  const sportsSlots = Math.min(7, sportsPool.length);
  const cryptoSlots = Math.min(10 - sportsSlots, cryptoPool.length);
  const top10 = [...sportsPool.slice(0, sportsSlots), ...cryptoPool.slice(0, cryptoSlots)]
    .sort((a, b) => b.rawScore - a.rawScore)
    .slice(0, 10);

  // Upsert each signal (stable IDs — same marketId+today row is UPDATED, not deleted+recreated)
  const keepMarketIds: number[] = [];
  for (let i = 0; i < top10.length; i++) {
    const s = top10[i];
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

  // Remove signals for markets that fell out of top 10
  await pruneStaleSignals(keepMarketIds);

  console.log(`[RankingEngine] Scored ${rankedSignals.length} markets (${sportsPool.length} sports, ${cryptoPool.length} crypto), stored top ${top10.length}`);
  return top10.length;
}
