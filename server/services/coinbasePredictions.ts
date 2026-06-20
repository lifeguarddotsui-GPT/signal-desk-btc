import { fetchCryptoAnalysis, getCachedPrice } from "./cryptoMarketData";
import { getUpcomingSportsEvents } from "./sportsResearch";
import type { SportEvent } from "./sportsResearch";

export interface CoinbasePredictionMarket {
  coinbaseMarketId: string;
  title: string;
  category: "crypto" | "sports";
  asset?: string;
  sport?: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  expirationTime: Date;
  spotPrice?: number;
  targetPrice?: number;
  homeTeam?: string;
  awayTeam?: string;
  event?: string;
}

// ── Crypto 15-minute market generator ──────────────────────────────────────
// Real Coinbase 15m markets: binary "Will [ASSET] be above $TARGET in 15 min?"
// When real Coinbase API is available, replace generateCryptoMarkets() with
// a real fetch to https://www.coinbase.com/api/v3/brokerage/market/products
// filtered by product_type=PREDICTION and contract_expiry_type=MINUTE_15.

function next15mBoundary(): Date {
  const now = Date.now();
  const ms15 = 15 * 60 * 1000;
  return new Date(Math.ceil(now / ms15) * ms15);
}

function generateCryptoMarkets(symbol: string, spotPrice: number): CoinbasePredictionMarket[] {
  const expiry = next15mBoundary();

  // Generate 2 target price scenarios (above/below) — stable IDs keyed to expiry boundary
  const offsets = [0.002, -0.002]; // +0.2% above, -0.2% below spot
  return offsets.map((offset, i) => {
    const targetPrice = parseFloat((spotPrice * (1 + offset)).toFixed(symbol === "BTC" ? 0 : 2));
    const distFromTarget = (spotPrice - targetPrice) / targetPrice;

    let yesBase = 0.50 + distFromTarget * 8;
    yesBase = Math.max(0.10, Math.min(0.90, yesBase));
    const noise = (Math.random() - 0.5) * 0.08;
    const yesPrice = parseFloat(Math.max(0.10, Math.min(0.90, yesBase + noise)).toFixed(2));
    const noPrice = parseFloat((1 - yesPrice).toFixed(2));

    const dirLabel = offset < 0 ? "below" : "above";
    const formattedTarget =
      symbol === "BTC" ? `$${targetPrice.toLocaleString()}` :
      symbol === "ETH" ? `$${targetPrice.toFixed(0)}` :
      `$${targetPrice.toFixed(2)}`;

    const expStr = new Date(expiry).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    return {
      // Stable ID: keyed to expiry boundary — same window = same row in DB (upsert updates price)
      coinbaseMarketId: `${symbol.toLowerCase()}-15m-${expiry.getTime()}-${i}`,
      title: `Will ${symbol} be ${dirLabel} ${formattedTarget} at ${expStr}?`,
      category: "crypto" as const,
      asset: symbol,
      yesPrice,
      noPrice,
      volume: Math.floor(50000 + Math.random() * 200000),
      expirationTime: expiry,
      spotPrice,
      targetPrice,
    };
  });
}

// ── Sports market generator ─────────────────────────────────────────────────
// When real Coinbase sports API is available, replace with real fetch.

function sportEventToMarket(event: SportEvent): CoinbasePredictionMarket {
  // Deliberately introduce a 4–10% mis-price vs external odds (simulating Coinbase market inefficiency)
  const direction = Math.random() > 0.5 ? 1 : -1;
  const mispricePct = 0.04 + Math.random() * 0.06; // 4% to 10% off
  const coinbaseImpliedProb = event.homeExternalOdds + direction * mispricePct;
  const clampedProb = Math.max(0.15, Math.min(0.85, coinbaseImpliedProb));
  const yesPrice = parseFloat(clampedProb.toFixed(2));
  const noPrice = parseFloat((1 - yesPrice).toFixed(2));

  const sportLabels: Record<string, string> = {
    soccer: "⚽ Soccer",
    mma: "🥊 MMA",
    boxing: "🥊 Boxing",
    football: "🏈 Football",
    basketball: "🏀 Basketball",
  };

  const label = sportLabels[event.sport] || event.sport;
  const title = `${label}: Will ${event.homeTeam} win vs ${event.awayTeam}?`;

  return {
    coinbaseMarketId: event.id,
    title,
    category: "sports" as const,
    sport: event.sport,
    yesPrice,
    noPrice,
    volume: event.marketVolume,
    expirationTime: event.startTime,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    event: event.event,
  };
}

// ── Main refresh function ───────────────────────────────────────────────────

export async function fetchAllPredictionMarkets(): Promise<CoinbasePredictionMarket[]> {
  const cryptoMarkets: CoinbasePredictionMarket[] = [];

  for (const symbol of ["BTC", "ETH", "SOL"]) {
    try {
      const analysis = await fetchCryptoAnalysis(symbol);
      const markets = generateCryptoMarkets(symbol, analysis.price);
      cryptoMarkets.push(...markets);
    } catch (err) {
      console.warn(`[CoinbasePredictions] Failed to generate ${symbol} markets:`, (err as Error).message);
    }
  }

  const sportsEvents = await getUpcomingSportsEvents();
  const sportMarkets = sportsEvents.map(sportEventToMarket);

  return [...cryptoMarkets, ...sportMarkets];
}

export async function fetchCryptoMarkets(): Promise<CoinbasePredictionMarket[]> {
  const allMarkets = await fetchAllPredictionMarkets();
  return allMarkets.filter(m => m.category === "crypto");
}

export async function fetchSportsMarkets(sport?: string): Promise<CoinbasePredictionMarket[]> {
  const allMarkets = await fetchAllPredictionMarkets();
  const sports = allMarkets.filter(m => m.category === "sports");
  return sport ? sports.filter(m => m.sport === sport) : sports;
}
