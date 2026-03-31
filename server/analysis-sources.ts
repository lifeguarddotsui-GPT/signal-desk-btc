/**
 * Analysis Sources — pluggable source adapters for market intelligence.
 *
 * Each adapter is isolated. If one fails the others still run.
 * Crypto news via CryptoCompare News API (free, no auth) + CoinGecko status.
 * Twitter/Reddit stubs: return empty arrays until real credentials are available.
 */

export interface SourceItem {
  source: string;
  title: string;
  body: string;
  url?: string;
  timestamp: number;
  author?: string;
  engagement?: number;
  symbol?: string;
}

const NEWS_TTL_MS = 5 * 60 * 1000; // 5-minute cache
let newsCache: { items: SourceItem[]; fetchedAt: number } | null = null;

export async function fetchNewsItems(): Promise<SourceItem[]> {
  if (newsCache && Date.now() - newsCache.fetchedAt < NEWS_TTL_MS) {
    return newsCache.items;
  }

  try {
    const res = await Promise.race([
      fetch("https://data-api.coindesk.com/news/v1/article/list?lang=EN&limit=20&categories=BTC,ETH,DeFi,Crypto&sourceIds=coindesk,cointelegraph,decrypt,thedefiant"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 6000)),
    ]) as Response;

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as any;
    const articles = json?.Data ?? [];

    const items: SourceItem[] = articles.slice(0, 20).map((a: any) => ({
      source: a.SOURCE_DATA?.INTERNAL_NAME ?? "coindesk-api",
      title: a.TITLE ?? "",
      body: (a.BODY ?? "").slice(0, 400),
      url: a.URL ?? undefined,
      timestamp: (a.PUBLISHED_ON ?? Math.floor(Date.now() / 1000)) * 1000,
      symbol: detectSymbol(a.TITLE ?? ""),
    }));

    newsCache = { items, fetchedAt: Date.now() };
    return items;
  } catch (e: any) {
    // Graceful degradation — return cached stale data if available
    if (newsCache) return newsCache.items;
    return buildFallbackNewsItems();
  }
}

export async function fetchCryptoCompareNews(): Promise<SourceItem[]> {
  try {
    const res = await Promise.race([
      fetch("https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=BTC,SUI,DeFi&excludeCategories=Sponsored"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]) as Response;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as any;
    const articles = (json?.Data ?? []).slice(0, 15);
    return articles.map((a: any) => ({
      source: a.source_info?.name ?? "cryptocompare",
      title: a.title ?? "",
      body: (a.body ?? "").slice(0, 400),
      url: a.url ?? undefined,
      timestamp: (a.published_on ?? Math.floor(Date.now() / 1000)) * 1000,
      symbol: detectSymbol(a.title ?? ""),
    }));
  } catch {
    return [];
  }
}

export async function fetchTwitterItems(): Promise<SourceItem[]> {
  return [];
}

export async function fetchRedditItems(): Promise<SourceItem[]> {
  return [];
}

export async function fetchMacroItems(): Promise<SourceItem[]> {
  return [];
}

function detectSymbol(title: string): string | undefined {
  const t = title.toUpperCase();
  if (t.includes("SUI")) return "SUI";
  if (t.includes("BTC") || t.includes("BITCOIN")) return "BTC";
  if (t.includes("ETH") || t.includes("ETHEREUM")) return "ETH";
  if (t.includes("SOL") || t.includes("SOLANA")) return "SOL";
  return undefined;
}

function buildFallbackNewsItems(): SourceItem[] {
  return [
    {
      source: "system",
      title: "Market data fetching unavailable — using technical signals only",
      body: "News sources temporarily unavailable. Sentiment analysis will rely on on-chain and technical data.",
      timestamp: Date.now(),
    },
  ];
}
