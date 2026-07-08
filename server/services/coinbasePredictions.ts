import { fetchCryptoAnalysis, getCachedPrice } from "./cryptoMarketData";
import type { CryptoAnalysis } from "./cryptoMarketData";
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

// ── Oracle Edge Market (new Coinbase-style format) ──────────────────────────

export interface OracleMarket {
  symbol: string;
  title: string;
  targetPrice: number;
  oraclePrice: number;
  oracleSource: string;
  expirationTime: string;
  timeRemainingSeconds: number;
  overMultiplier: number;
  underMultiplier: number;
  fairProbOver: number;
  fairProbUnder: number;
  marketImpliedOver: number;
  marketImpliedUnder: number;
  overEdge: number;
  underEdge: number;
  suggestedSide: "Over" | "Under" | "No Edge";
  edgeScore: number;
  edgeLabel: string;
  pctDistFromTarget: number;
  atr: number;
  rsi: number;
  momentum5m: number;
  trendUp: boolean;
  volumeChange: number;
}

// Standard normal CDF (Abramowitz & Stegun approximation, max error 7.5e-8)
function normalCDF(z: number): number {
  const sign = z >= 0 ? 1 : -1;
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const poly = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const y = 1 - poly * Math.exp(-z * z / 2);
  return (1 + sign * y) / 2;
}

function scoreToLabel(score: number): string {
  if (score >= 80) return "Excellent Edge";
  if (score >= 60) return "Strong Edge";
  if (score >= 40) return "Moderate Edge";
  if (score >= 20) return "Weak Edge";
  return "No Edge";
}

function computeOracleMarket(analysis: CryptoAnalysis): OracleMarket {
  const { symbol, price: oraclePrice, candles, rsi, momentum5m, trendUp, volumeChange } = analysis;

  const MS15 = 15 * 60 * 1000;
  const windowStartMs = Math.floor(Date.now() / MS15) * MS15;
  const expiryMs = windowStartMs + MS15;
  const timeRemainingSeconds = Math.max(5, (expiryMs - Date.now()) / 1000);

  // Target = price at the exact START of this 15-min window.
  // A 5-min candle at timestamp T covers [T, T+5min). Its close = price at T+5min.
  // To get the price at windowStartMs we want the candle whose close IS windowStart,
  // i.e. the candle at (windowStartMs - 5min). Using strict < avoids picking up the
  // in-progress candle (timestamp = windowStartMs) whose "close" tracks the live price.
  const GRAN_MS = 5 * 60 * 1000;
  let targetPrice = oraclePrice;
  for (const c of candles) {
    if (c.timestamp < windowStartMs) targetPrice = c.close; // strictly before window
  }

  // % distance current price is from the window-open target
  const pctDist = (oraclePrice - targetPrice) / Math.max(1, targetPrice);

  // ── Calibrated volatility model ───────────────────────────────────────────
  // Use close-to-close return std dev (not ATR which measures the bar range).
  // ATR overestimates realised vol and produces multipliers that are 3-4x too low.
  // Per-5-min close stdDev → per-minute vol → scale to remaining window.
  const recentCloses = candles.slice(-24).map(c => c.close);
  let sumSqRet = 0;
  let retCount = 0;
  for (let i = 1; i < recentCloses.length; i++) {
    const ret = (recentCloses[i] - recentCloses[i - 1]) / recentCloses[i - 1];
    sumSqRet += ret * ret;
    retCount++;
  }
  const stdDev5min = retCount > 0 ? Math.sqrt(sumSqRet / retCount) : 0.0008;
  // Convert to per-minute and scale to remaining minutes via random-walk √t law
  const stdDev1min = stdDev5min / Math.sqrt(5);
  const minsRemaining = timeRemainingSeconds / 60;
  const effectiveVol = Math.max(0.00005, stdDev1min * Math.sqrt(minsRemaining));

  const zScore = pctDist / effectiveVol;
  const baseFairOver = normalCDF(zScore);

  // Model adjustments: RSI extremes and 5m momentum give additional signal
  const rsiAdj = (rsi - 50) / 1000;
  const momAdj = momentum5m * 1.2;
  const volAdj = (volumeChange - 1) * 0.015;

  const modelFairOver = Math.max(0.005, Math.min(0.995, baseFairOver - rsiAdj + momAdj + volAdj));
  const modelFairUnder = 1 - modelFairOver;

  // Market multipliers — Coinbase applies vig on each side independently.
  // For extreme probabilities (> 92%) the market naturally offers high multiples.
  // We keep the simple model as the "market baseline" and our RSI/momentum
  // adjustments drive the edge calculation.
  const simpleFairOver = Math.max(0.005, Math.min(0.995, baseFairOver));
  const VIG = 0.03; // ~3% per side — calibrated to Coinbase observation
  const ovMktProb = Math.min(0.97, simpleFairOver + VIG);
  const unMktProb = Math.min(0.97, (1 - simpleFairOver) + VIG);
  const overMultiplier = parseFloat(Math.max(1.05, 1 / ovMktProb).toFixed(1));
  const underMultiplier = parseFloat(Math.max(1.05, 1 / unMktProb).toFixed(1));

  // Edge = model fair prob − market implied prob (positive = model sees value)
  const overEdge = modelFairOver - (1 / overMultiplier);
  const underEdge = modelFairUnder - (1 / underMultiplier);

  const suggestedSide: "Over" | "Under" | "No Edge" =
    overEdge > underEdge && overEdge > 0.005 ? "Over"
    : underEdge > overEdge && underEdge > 0.005 ? "Under"
    : "No Edge";

  // Score only counts POSITIVE bettor edge — no score when market has full vig advantage
  const positiveEdge = Math.max(0, overEdge, underEdge);
  const edgeScore = Math.round(Math.min(100, positiveEdge * 700));
  const decimals = symbol === "SOL" ? 4 : 2;

  return {
    symbol,
    title: `15 min ${symbol === "BTC" ? "Bitcoin" : symbol === "ETH" ? "Ethereum" : "Solana"}`,
    targetPrice: parseFloat(targetPrice.toFixed(decimals)),
    oraclePrice: parseFloat(oraclePrice.toFixed(decimals)),
    oracleSource: "Coinbase Exchange",
    expirationTime: new Date(expiryMs).toISOString(),
    timeRemainingSeconds: Math.round(timeRemainingSeconds),
    overMultiplier,
    underMultiplier,
    fairProbOver: parseFloat(modelFairOver.toFixed(3)),
    fairProbUnder: parseFloat(modelFairUnder.toFixed(3)),
    marketImpliedOver: parseFloat((1 / overMultiplier).toFixed(3)),
    marketImpliedUnder: parseFloat((1 / underMultiplier).toFixed(3)),
    overEdge: parseFloat(overEdge.toFixed(3)),
    underEdge: parseFloat(underEdge.toFixed(3)),
    suggestedSide,
    edgeScore,
    edgeLabel: scoreToLabel(edgeScore),
    pctDistFromTarget: parseFloat((pctDist * 100).toFixed(4)),
    atr: parseFloat(analysis.atr.toFixed(4)),
    rsi: parseFloat(rsi.toFixed(1)),
    momentum5m: parseFloat(momentum5m.toFixed(4)),
    trendUp,
    volumeChange: parseFloat(volumeChange.toFixed(3)),
  };
}

export async function computeAllOracleMarkets(): Promise<OracleMarket[]> {
  const results: OracleMarket[] = [];
  for (const symbol of ["BTC", "ETH", "SOL"]) {
    try {
      const analysis = await fetchCryptoAnalysis(symbol);
      results.push(computeOracleMarket(analysis));
    } catch (err) {
      console.warn(`[Oracle] Failed for ${symbol}:`, (err as Error).message);
    }
  }
  return results.sort((a, b) => b.edgeScore - a.edgeScore);
}

// ── Crypto 15-minute market generator (legacy — for DB / signal system) ─────

function next15mBoundary(): Date {
  const now = Date.now();
  const ms15 = 15 * 60 * 1000;
  return new Date(Math.ceil(now / ms15) * ms15);
}

function generateCryptoMarkets(symbol: string, spotPrice: number): CoinbasePredictionMarket[] {
  const expiry = next15mBoundary();
  const offsets = [0.0005, -0.0005];
  return offsets.map((offset, i) => {
    const decimals = symbol === "BTC" ? 0 : symbol === "ETH" ? 2 : 4;
    const targetPrice = parseFloat((spotPrice * (1 + offset)).toFixed(decimals));
    const distFromTarget = (spotPrice - targetPrice) / targetPrice;
    let yesBase = 0.50 + distFromTarget * 12;
    yesBase = Math.max(0.30, Math.min(0.70, yesBase));
    const noise = (Math.random() - 0.5) * 0.06;
    const yesPrice = parseFloat(Math.max(0.30, Math.min(0.70, yesBase + noise)).toFixed(2));
    const noPrice = parseFloat((1 - yesPrice).toFixed(2));
    const dirLabel = offset < 0 ? "below" : "above";
    const formattedTarget = symbol === "BTC" ? `$${targetPrice.toLocaleString()}` : symbol === "ETH" ? `$${targetPrice.toFixed(2)}` : `$${targetPrice.toFixed(4)}`;
    const expStr = new Date(expiry).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    return {
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

  // Expiration: give ample time after event starts (4h for MMA fights, 3h for soccer)
  const graceHours = event.sport === "mma" ? 4 : 3;
  const expirationTime = new Date(event.startTime.getTime() + graceHours * 3600 * 1000);

  return {
    coinbaseMarketId: event.id,
    title,
    category: "sports" as const,
    sport: event.sport,
    yesPrice,
    noPrice,
    volume: event.marketVolume,
    expirationTime,
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
