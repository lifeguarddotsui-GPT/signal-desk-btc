import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, Clock, Zap, RefreshCw, ExternalLink } from "lucide-react";
import { useState, useEffect } from "react";

interface CryptoMarket {
  id: number;
  coinbaseMarketId: string;
  title: string;
  asset: string | null;
  yesPrice: number;
  noPrice: number;
  volume: number;
  expirationTime: string | null;
}

interface CryptoAnalysis {
  symbol: string;
  price: number;
  change24h: number;
  rsi: number;
  momentum5m: number;
  trendUp: boolean;
  volumeChange: number;
  atr: number;
  vwap: number;
}

interface Signal {
  id: number;
  marketId: number;
  recommendedSide: string;
  confidenceScore: number;
  edgeScore: number;
  reasoning: string;
  rankToday: number;
  riskScore: number;
}

function timeUntil(expiry: string | null): string {
  if (!expiry) return "—";
  const ms = new Date(expiry).getTime() - Date.now();
  if (ms <= 0) return "Expired";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function probBar(prob: number, side: "YES" | "NO") {
  const pct = Math.round(prob * 100);
  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{side}</span>
        <span className={cn("text-sm font-black font-mono", side === "YES" ? "text-emerald-400" : "text-red-400")}>{pct}%</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full", side === "YES" ? "bg-emerald-400" : "bg-red-400")}
          style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function AssetHero({ symbol, analysis }: { symbol: string; analysis: CryptoAnalysis | undefined }) {
  const assetColors: Record<string, { bg: string; text: string; icon: string }> = {
    BTC: { bg: "from-orange-500/20 to-orange-500/5", text: "text-orange-400", icon: "₿" },
    ETH: { bg: "from-blue-500/20 to-blue-500/5", text: "text-blue-400", icon: "Ξ" },
    SOL: { bg: "from-purple-500/20 to-purple-500/5", text: "text-purple-400", icon: "◎" },
  };
  const colors = assetColors[symbol] ?? assetColors.BTC;
  const isUp = (analysis?.change24h ?? 0) >= 0;

  return (
    <div className={cn("rounded-xl border border-border bg-gradient-to-br p-4", colors.bg)}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={cn("text-2xl font-black", colors.text)}>{colors.icon}</span>
          <div>
            <p className="text-white font-bold text-base">{symbol}/USD</p>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">15-Minute Prediction Markets</p>
          </div>
        </div>
        {analysis && (
          <div className="text-right">
            <p className="text-lg font-black text-white font-mono">
              ${analysis.price.toLocaleString(undefined, { maximumFractionDigits: symbol === "BTC" ? 0 : 2 })}
            </p>
            <p className={cn("text-xs font-semibold flex items-center gap-1 justify-end", isUp ? "text-emerald-400" : "text-red-400")}>
              {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {isUp ? "+" : ""}{(analysis.change24h ?? 0).toFixed(2)}%
            </p>
          </div>
        )}
      </div>

      {analysis && (
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: "RSI", value: analysis.rsi.toFixed(0), color: analysis.rsi > 65 ? "text-red-400" : analysis.rsi < 35 ? "text-emerald-400" : "text-white" },
            { label: "5m Mom", value: `${(analysis.momentum5m * 100).toFixed(0)}%`, color: analysis.momentum5m > 0.6 ? "text-emerald-400" : "text-yellow-400" },
            { label: "Vol Δ", value: `${analysis.volumeChange > 1 ? "+" : ""}${((analysis.volumeChange - 1) * 100).toFixed(0)}%`, color: analysis.volumeChange > 1.1 ? "text-emerald-400" : "text-muted-foreground" },
            { label: "Trend", value: analysis.trendUp ? "▲ UP" : "▼ DN", color: analysis.trendUp ? "text-emerald-400" : "text-red-400" },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-black/20 rounded-lg px-2 py-1.5 text-center">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className={cn("text-xs font-bold font-mono", color)}>{value}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MarketCard({ market, signal }: { market: CryptoMarket; signal?: Signal }) {
  const [timeStr, setTimeStr] = useState(timeUntil(market.expirationTime));
  useEffect(() => {
    const id = setInterval(() => setTimeStr(timeUntil(market.expirationTime)), 1000);
    return () => clearInterval(id);
  }, [market.expirationTime]);

  const isExpiring = market.expirationTime && new Date(market.expirationTime).getTime() - Date.now() < 300000;
  const modelProb = signal
    ? (signal.recommendedSide === "YES" ? market.yesPrice + (signal.edgeScore / 100) : market.noPrice + (signal.edgeScore / 100))
    : null;

  return (
    <div className={cn(
      "p-4 rounded-xl border bg-card transition-colors",
      signal ? "border-[#0052FF]/30 hover:border-[#0052FF]/50" : "border-border"
    )} data-testid={`crypto-market-${market.id}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white leading-snug">{market.title}</p>
        </div>
        <div className={cn("flex items-center gap-1 text-xs shrink-0", isExpiring ? "text-yellow-400" : "text-muted-foreground")}>
          <Clock className="w-3 h-3" />
          <span className="font-mono">{timeStr}</span>
        </div>
      </div>

      {/* Probability bars */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        {probBar(market.yesPrice, "YES")}
        {probBar(market.noPrice, "NO")}
      </div>

      {/* Model signal */}
      {signal && (
        <div className="flex items-center justify-between pt-2.5 border-t border-border">
          <div className="flex items-center gap-2">
            <div className={cn(
              "text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-lg",
              signal.confidenceScore >= 8 ? "bg-emerald-400/15 text-emerald-300" :
              signal.confidenceScore >= 7 ? "bg-blue-400/15 text-blue-300" :
              "bg-yellow-400/15 text-yellow-300"
            )}>
              MODEL: {signal.recommendedSide}
            </div>
            <span className="text-[11px] text-muted-foreground">
              {signal.confidenceScore.toFixed(1)}/10 · +{signal.edgeScore}% edge
            </span>
          </div>
          <Link href={`/signal/${signal.id}`} className="flex items-center gap-1 text-[11px] text-[#4D8FFF] hover:text-white transition-colors">
            <Zap className="w-3 h-3" />
            Details
          </Link>
        </div>
      )}
      {signal && (
        <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed line-clamp-2">
          {signal.reasoning}
        </p>
      )}
    </div>
  );
}

export default function CryptoScanner() {
  const { data: markets = [], isLoading: marketsLoading } = useQuery<CryptoMarket[]>({
    queryKey: ["/api/markets/crypto"],
    refetchInterval: 30_000,
  });
  const { data: signals = [] } = useQuery<Signal[]>({
    queryKey: ["/api/signals/today"],
    refetchInterval: 60_000,
  });
  const { data: prices, isLoading: pricesLoading } = useQuery<Record<string, CryptoAnalysis>>({
    queryKey: ["/api/crypto/prices"],
    refetchInterval: 30_000,
  });

  const cryptoSignals = signals.filter(s => (s as any).category === "crypto");
  const signalsByMarketId = Object.fromEntries(cryptoSignals.map(s => [s.marketId, s]));
  const byAsset = (asset: string) => markets.filter(m => m.asset === asset);
  const ASSETS = ["BTC", "ETH", "SOL"];

  const topCrypto = [...cryptoSignals].sort((a, b) => b.confidenceScore - a.confidenceScore)[0];

  return (
    <div className="min-h-full">
      {/* Hero */}
      <div className="halftone-bg bg-[#0052FF] px-6 py-7 md:px-10">
        <div className="max-w-5xl mx-auto flex items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Zap className="w-4 h-4 text-blue-200" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-blue-200 font-bold">15-Minute Predictions</span>
            </div>
            <h1 className="text-2xl md:text-3xl font-black text-white mb-1">Crypto Markets</h1>
            <p className="text-blue-200 text-sm">BTC · ETH · SOL — probability scores ranked by our system · Updated every 30s</p>
          </div>
          {topCrypto && (
            <div className="hidden md:block bg-white/10 backdrop-blur rounded-xl px-4 py-3 border border-white/15 text-center shrink-0">
              <p className="text-[9px] uppercase tracking-widest text-blue-200 font-bold">Top Signal</p>
              <p className="text-2xl font-black text-white mt-0.5">{topCrypto.confidenceScore.toFixed(1)}</p>
              <p className="text-[10px] text-blue-200">{topCrypto.recommendedSide} · +{topCrypto.edgeScore}%</p>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 space-y-8">
        {ASSETS.map(asset => (
          <section key={asset}>
            <div className="mb-4">
              <AssetHero symbol={asset} analysis={prices?.[asset]} />
            </div>

            {marketsLoading ? (
              <div className="space-y-3">
                {[1, 2].map(i => <Skeleton key={i} className="h-32 rounded-xl" />)}
              </div>
            ) : byAsset(asset).length === 0 ? (
              <div className="text-center py-8 text-muted-foreground border border-dashed border-border rounded-xl">
                <RefreshCw className="w-6 h-6 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No {asset} markets yet — refreshing...</p>
              </div>
            ) : (
              <div className="space-y-3">
                {byAsset(asset).map(m => (
                  <MarketCard key={m.id} market={m} signal={signalsByMarketId[m.id]} />
                ))}
              </div>
            )}
          </section>
        ))}

        {/* How it works */}
        <div className="p-5 rounded-xl border border-[#0052FF]/20 bg-[#0052FF]/5">
          <h3 className="text-sm font-bold text-[#4D8FFF] mb-3">How Crypto 15m Ranking Works</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {[
              { pct: "30%", label: "Price Momentum", desc: "RSI + 5m direction" },
              { pct: "20%", label: "Distance to Target", desc: "Sweet spot: 0.1–2%" },
              { pct: "15%", label: "Volume Signal", desc: "Volume vs 15m avg" },
              { pct: "15%", label: "Volatility Quality", desc: "ATR in healthy range" },
              { pct: "10%", label: "Trend Alignment", desc: "EMA slope direction" },
              { pct: "10%", label: "Mispricing Edge", desc: "Model vs market prob" },
            ].map(({ pct, label, desc }) => (
              <div key={label} className="flex items-start gap-2">
                <span className="text-[11px] font-black text-[#0052FF] shrink-0 w-8">{pct}</span>
                <div>
                  <p className="text-[11px] font-semibold text-white">{label}</p>
                  <p className="text-[10px] text-muted-foreground">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Coinbase link */}
        <a href="https://www.coinbase.com/en-us/predict" target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-3 p-4 rounded-xl border border-[#0052FF]/20 hover:border-[#0052FF]/50 transition-colors bg-[#0052FF]/5 group">
          <div className="w-8 h-8 rounded-lg bg-[#0052FF] flex items-center justify-center shrink-0">
            <span className="text-white font-black text-xs">CB</span>
          </div>
          <div className="flex-1">
            <p className="text-sm font-bold text-white">Trade on Coinbase Predictions</p>
            <p className="text-[11px] text-muted-foreground">Open the real prediction market on Coinbase</p>
          </div>
          <ExternalLink className="w-4 h-4 text-muted-foreground group-hover:text-white transition-colors" />
        </a>
      </div>
    </div>
  );
}
