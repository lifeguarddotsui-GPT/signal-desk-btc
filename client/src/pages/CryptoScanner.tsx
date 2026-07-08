import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, Zap, RefreshCw, ExternalLink, TrendingUp, TrendingDown, ChevronDown, ChevronUp } from "lucide-react";
import { useState, useEffect } from "react";

interface OracleMarket {
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

const ASSET_CONFIG: Record<string, { bg: string; iconBg: string; text: string; symbol: string; name: string }> = {
  BTC: { bg: "from-orange-500/15 to-orange-500/0", iconBg: "bg-orange-500", text: "text-orange-400", symbol: "₿", name: "Bitcoin" },
  ETH: { bg: "from-blue-500/15 to-blue-500/0", iconBg: "bg-blue-500", text: "text-blue-400", symbol: "Ξ", name: "Ethereum" },
  SOL: { bg: "from-purple-500/15 to-purple-500/0", iconBg: "bg-purple-500", text: "text-purple-400", symbol: "◎", name: "Solana" },
};

function fmt(val: number, symbol: string) {
  if (symbol === "SOL") return `$${val.toFixed(4)}`;
  if (symbol === "ETH") return `$${val.toFixed(2)}`;
  return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function useCountdown(expirationTime: string) {
  const getRemaining = () => {
    const ms = new Date(expirationTime).getTime() - Date.now();
    if (ms <= 0) return "0:00";
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  const [time, setTime] = useState(getRemaining);
  useEffect(() => {
    const id = setInterval(() => setTime(getRemaining()), 1000);
    return () => clearInterval(id);
  }, [expirationTime]);
  return time;
}

function EdgeScoreBadge({ score, label }: { score: number; label: string }) {
  const color =
    score >= 80 ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" :
    score >= 60 ? "text-green-300 border-green-500/40 bg-green-500/10" :
    score >= 40 ? "text-blue-300 border-blue-500/40 bg-blue-500/10" :
    score >= 20 ? "text-yellow-300 border-yellow-500/40 bg-yellow-500/10" :
    "text-muted-foreground border-border bg-card";
  return (
    <div className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-bold", color)}>
      <span className="font-black text-[13px] font-mono">{score}</span>
      <span className="opacity-80">{label}</span>
    </div>
  );
}

function SuggestedSideBadge({ side }: { side: "Over" | "Under" | "No Edge" }) {
  if (side === "Over") return <span className="text-[11px] font-black uppercase tracking-wider px-2 py-0.5 rounded-lg bg-emerald-500/15 text-emerald-300">▲ OVER</span>;
  if (side === "Under") return <span className="text-[11px] font-black uppercase tracking-wider px-2 py-0.5 rounded-lg bg-red-500/15 text-red-300">▼ UNDER</span>;
  return <span className="text-[11px] font-black uppercase tracking-wider px-2 py-0.5 rounded-lg bg-muted text-muted-foreground">— NEUTRAL</span>;
}

function CountdownPill({ expirationTime, timeRemainingSeconds }: { expirationTime: string; timeRemainingSeconds: number }) {
  const time = useCountdown(expirationTime);
  const urgent = timeRemainingSeconds < 180;
  return (
    <div className={cn(
      "flex items-center gap-1.5 px-3 py-1.5 rounded-full border font-mono text-sm font-bold",
      urgent
        ? "border-yellow-500/50 bg-yellow-500/10 text-yellow-300"
        : "border-white/20 bg-white/5 text-white"
    )} data-testid="countdown-pill">
      <Clock className="w-3.5 h-3.5 opacity-70" />
      {time}
    </div>
  );
}

function OracleMarketCard({ market }: { market: OracleMarket }) {
  const cfg = ASSET_CONFIG[market.symbol] ?? ASSET_CONFIG.BTC;
  const [expanded, setExpanded] = useState(false);

  const overEdgePct = Math.round(market.overEdge * 100);
  const underEdgePct = Math.round(market.underEdge * 100);
  const bestSide = market.suggestedSide;
  const priceAbove = market.oraclePrice > market.targetPrice;

  return (
    <div className={cn(
      "rounded-2xl border bg-gradient-to-br transition-all",
      cfg.bg,
      market.edgeScore >= 60
        ? "border-white/20 shadow-lg"
        : "border-border"
    )} data-testid={`oracle-card-${market.symbol}`}>

      {/* Card Header */}
      <div className="flex items-center justify-between px-5 pt-5 pb-4">
        <div className="flex items-center gap-3">
          <div className={cn("w-11 h-11 rounded-xl flex items-center justify-center text-white font-black text-lg shrink-0", cfg.iconBg)}>
            {cfg.symbol}
          </div>
          <div>
            <p className="text-white font-bold text-base leading-tight">{market.title}</p>
            <p className="text-muted-foreground text-xs mt-0.5">
              <span className="font-mono">{fmt(market.targetPrice, market.symbol)}</span>
              {" "}target · oracle: <span className={cn("font-mono font-semibold", priceAbove ? "text-emerald-400" : "text-red-400")}>
                {fmt(market.oraclePrice, market.symbol)}
              </span>
            </p>
          </div>
        </div>
        <CountdownPill expirationTime={market.expirationTime} timeRemainingSeconds={market.timeRemainingSeconds} />
      </div>

      {/* Over / Under Multiplier Rows */}
      <div className="px-5 space-y-2.5 pb-4">
        <div className="flex items-center justify-between">
          <span className="text-white text-sm font-semibold">Over</span>
          <div className="flex items-center gap-2">
            {overEdgePct > 0 && <span className="text-[10px] text-emerald-400 font-bold">+{overEdgePct}% edge</span>}
            <div className={cn(
              "px-6 py-2 rounded-full text-white font-black text-base min-w-[70px] text-center",
              bestSide === "Over" ? "bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.4)]" : "bg-emerald-600/60"
            )} data-testid={`over-multiplier-${market.symbol}`}>
              {market.overMultiplier}x
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-white text-sm font-semibold">Under</span>
          <div className="flex items-center gap-2">
            {underEdgePct > 0 && <span className="text-[10px] text-red-400 font-bold">+{underEdgePct}% edge</span>}
            <div className={cn(
              "px-6 py-2 rounded-full text-white font-black text-base min-w-[70px] text-center",
              bestSide === "Under" ? "bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.4)]" : "bg-red-600/60"
            )} data-testid={`under-multiplier-${market.symbol}`}>
              {market.underMultiplier}x
            </div>
          </div>
        </div>
      </div>

      {/* Edge Summary Bar */}
      <div className="mx-5 mb-4 px-4 py-3 rounded-xl bg-black/20 border border-white/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Best Side</span>
            <SuggestedSideBadge side={market.suggestedSide} />
          </div>
          <EdgeScoreBadge score={market.edgeScore} label={market.edgeLabel} />
        </div>
      </div>

      {/* Expand toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-center gap-1 py-2.5 border-t border-white/5 text-[11px] text-muted-foreground hover:text-white transition-colors"
        data-testid={`expand-${market.symbol}`}
      >
        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        {expanded ? "Hide" : "Show"} oracle details
      </button>

      {/* Expanded Detail */}
      {expanded && (
        <div className="px-5 pb-5 pt-1 space-y-3 border-t border-white/5">
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[
              { label: "Oracle Source", value: market.oracleSource },
              { label: "Price vs Target", value: `${market.pctDistFromTarget > 0 ? "+" : ""}${market.pctDistFromTarget.toFixed(3)}%` },
              { label: "Fair Prob (Over)", value: `${(market.fairProbOver * 100).toFixed(1)}%` },
              { label: "Fair Prob (Under)", value: `${(market.fairProbUnder * 100).toFixed(1)}%` },
              { label: "Market Implied (Over)", value: `${(market.marketImpliedOver * 100).toFixed(1)}%` },
              { label: "Market Implied (Under)", value: `${(market.marketImpliedUnder * 100).toFixed(1)}%` },
              { label: "RSI (5m)", value: market.rsi.toFixed(0) },
              { label: "5m Momentum", value: `${(market.momentum5m * 100).toFixed(2)}%` },
              { label: "ATR", value: fmt(market.atr, market.symbol) },
              { label: "Volume Ratio", value: `${market.volumeChange.toFixed(2)}x` },
              { label: "Trend", value: market.trendUp ? "▲ Bullish" : "▼ Bearish" },
              { label: "Over Edge", value: `${overEdgePct > 0 ? "+" : ""}${overEdgePct}%` },
            ].map(({ label, value }) => (
              <div key={label} className="flex justify-between bg-black/20 rounded-lg px-3 py-2">
                <span className="text-muted-foreground">{label}</span>
                <span className="text-white font-mono font-medium">{value}</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Edge model uses oracle-based distance-to-target probability adjusted with RSI ({market.rsi.toFixed(0)}),
            5m momentum ({(market.momentum5m * 100).toFixed(2)}%), and volume ratio ({market.volumeChange.toFixed(2)}x)
            vs a simple market vig model. Positive edge = model estimates better odds than market pays.
          </p>
        </div>
      )}
    </div>
  );
}

function RankingTable({ markets }: { markets: OracleMarket[] }) {
  const ranked = [...markets].sort((a, b) => b.edgeScore - a.edgeScore);
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-bold text-white">Best Opportunities Right Now</h2>
        <p className="text-[10px] text-muted-foreground mt-0.5">Ranked by oracle edge score</p>
      </div>
      <div className="divide-y divide-border">
        {ranked.map((m, i) => {
          const cfg = ASSET_CONFIG[m.symbol] ?? ASSET_CONFIG.BTC;
          return (
            <div key={m.symbol} className="flex items-center gap-3 px-4 py-3" data-testid={`rank-row-${m.symbol}`}>
              <span className="text-lg font-black text-muted-foreground w-5 shrink-0">#{i + 1}</span>
              <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center text-white font-black text-xs shrink-0", cfg.iconBg)}>
                {cfg.symbol}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white font-semibold text-sm">{m.symbol}</p>
                <p className="text-muted-foreground text-[10px]">
                  Oracle {fmt(m.oraclePrice, m.symbol)} vs target {fmt(m.targetPrice, m.symbol)}
                  <span className={cn("ml-1 font-mono font-semibold", m.pctDistFromTarget >= 0 ? "text-emerald-400" : "text-red-400")}>
                    ({m.pctDistFromTarget >= 0 ? "+" : ""}{m.pctDistFromTarget.toFixed(3)}%)
                  </span>
                </p>
              </div>
              <SuggestedSideBadge side={m.suggestedSide} />
              <EdgeScoreBadge score={m.edgeScore} label="" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HowItWorksPanel() {
  return (
    <div className="p-5 rounded-xl border border-[#0052FF]/20 bg-[#0052FF]/5">
      <h3 className="text-sm font-bold text-[#4D8FFF] mb-3 flex items-center gap-2">
        <Zap className="w-4 h-4" />
        How the Oracle Edge Model Works
      </h3>
      <div className="space-y-2.5 text-xs text-muted-foreground leading-relaxed">
        <p>
          <span className="text-white font-semibold">Target price</span> is set at the start of each 15-minute window using the
          oracle price from Coinbase Exchange. It stays fixed for the entire window.
        </p>
        <p>
          <span className="text-white font-semibold">Fair probability</span> is estimated using a log-normal model:
          how far the current price has moved from the target, divided by expected remaining volatility (ATR × √time).
        </p>
        <p>
          <span className="text-white font-semibold">Market multipliers</span> (e.g. 2.1x / 1.7x) reflect a simple
          distance model plus a 6% vig. Our model adds RSI, momentum, and volume signals.
        </p>
        <p>
          <span className="text-white font-semibold">Edge score (0–100)</span> = the gap between our model's
          fair probability and the market's implied probability. Higher = stronger opportunity.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-3">
          {[
            { range: "0–20", label: "No Edge", color: "text-muted-foreground" },
            { range: "21–40", label: "Weak", color: "text-yellow-400" },
            { range: "41–60", label: "Moderate", color: "text-blue-400" },
            { range: "61–80", label: "Strong", color: "text-green-400" },
            { range: "81–100", label: "Excellent", color: "text-emerald-400" },
          ].map(({ range, label, color }) => (
            <div key={range} className="bg-black/20 rounded-lg px-3 py-2 text-center">
              <p className={cn("text-xs font-black", color)}>{label}</p>
              <p className="text-[9px] text-muted-foreground mt-0.5">{range}</p>
            </div>
          ))}
        </div>
        <p className="text-[10px] italic mt-2">
          Best estimated edge — not a guarantee of profit. Prediction markets involve risk.
        </p>
      </div>
    </div>
  );
}

export default function CryptoScanner() {
  const { data: markets = [], isLoading, refetch } = useQuery<OracleMarket[]>({
    queryKey: ["/api/oracle/markets"],
    refetchInterval: 30_000,
  });

  const [filter, setFilter] = useState<"All" | "BTC" | "ETH" | "SOL">("All");

  const topMarket = [...markets].sort((a, b) => b.edgeScore - a.edgeScore)[0];
  const displayed = filter === "All" ? markets : markets.filter(m => m.symbol === filter);
  const hasStrongEdge = topMarket && topMarket.edgeScore >= 40;

  return (
    <div className="min-h-full">
      {/* Hero */}
      <div className="halftone-bg bg-[#0052FF] px-6 py-7 md:px-10">
        <div className="max-w-5xl mx-auto flex items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Zap className="w-4 h-4 text-blue-200" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-blue-200 font-bold">Oracle Edge Scanner</span>
            </div>
            <h1 className="text-2xl md:text-3xl font-black text-white mb-1">Crypto 15m Markets</h1>
            <p className="text-blue-200 text-sm">BTC · ETH · SOL — oracle-based edge vs Coinbase market odds · Live</p>
          </div>
          {topMarket && (
            <div className="hidden md:block bg-white/10 backdrop-blur rounded-xl px-4 py-3 border border-white/15 text-center shrink-0">
              <p className="text-[9px] uppercase tracking-widest text-blue-200 font-bold">
                {hasStrongEdge ? "Best Edge" : "Scanning"}
              </p>
              <p className={cn("text-2xl font-black mt-0.5", hasStrongEdge ? "text-white" : "text-blue-300")}>
                {hasStrongEdge ? topMarket.edgeScore : "—"}
              </p>
              <p className="text-[10px] text-blue-200">
                {hasStrongEdge ? `${topMarket.symbol} · ${topMarket.suggestedSide}` : "Prices near target"}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 space-y-6">

        {/* Filter + Refresh */}
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            {(["All", "BTC", "ETH", "SOL"] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                data-testid={`filter-${f}`}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-bold transition-colors",
                  filter === f
                    ? "bg-[#0052FF] text-white"
                    : "bg-card border border-border text-muted-foreground hover:text-white"
                )}
              >{f}</button>
            ))}
          </div>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-white transition-colors"
            data-testid="refresh-button"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>

        {/* Rankings Table */}
        {!isLoading && markets.length > 0 && filter === "All" && (
          <RankingTable markets={markets} />
        )}

        {/* Market Cards */}
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-64 rounded-2xl" />)}
          </div>
        ) : displayed.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground border border-dashed border-border rounded-2xl">
            <RefreshCw className="w-8 h-8 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">Loading oracle data...</p>
            <p className="text-xs mt-1 opacity-60">Fetching from Coinbase Exchange</p>
          </div>
        ) : (
          <div className="space-y-4">
            {displayed.map(m => (
              <OracleMarketCard key={m.symbol} market={m} />
            ))}
          </div>
        )}

        {/* How It Works */}
        <HowItWorksPanel />

        {/* Coinbase link */}
        <a
          href="https://www.coinbase.com/en-us/predict"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 p-4 rounded-xl border border-[#0052FF]/20 hover:border-[#0052FF]/50 transition-colors bg-[#0052FF]/5 group"
          data-testid="coinbase-link"
        >
          <div className="w-8 h-8 rounded-lg bg-[#0052FF] flex items-center justify-center shrink-0">
            <span className="text-white font-black text-xs">CB</span>
          </div>
          <div className="flex-1">
            <p className="text-sm font-bold text-white">Trade on Coinbase Predictions</p>
            <p className="text-[11px] text-muted-foreground">Open the real prediction market to act on these signals</p>
          </div>
          <ExternalLink className="w-4 h-4 text-muted-foreground group-hover:text-white transition-colors" />
        </a>

      </div>
    </div>
  );
}
