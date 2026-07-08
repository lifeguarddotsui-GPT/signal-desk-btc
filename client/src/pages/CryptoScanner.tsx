import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Clock, RefreshCw, ExternalLink, Zap, TrendingDown, TrendingUp, ArrowRight } from "lucide-react";
import { useState, useEffect } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Config ────────────────────────────────────────────────────────────────────

const ASSET = {
  BTC: {
    bg: "bg-[#F7931A]",
    border: "border-orange-500/30",
    glow: "shadow-[0_0_30px_rgba(247,147,26,0.15)]",
    text: "text-orange-400",
    name: "Bitcoin",
    logo: "https://assets.coingecko.com/coins/images/1/large/bitcoin.png",
  },
  ETH: {
    bg: "bg-[#627EEA]",
    border: "border-blue-500/30",
    glow: "shadow-[0_0_30px_rgba(98,126,234,0.15)]",
    text: "text-blue-400",
    name: "Ethereum",
    logo: "https://assets.coingecko.com/coins/images/279/large/ethereum.png",
  },
  SOL: {
    bg: "bg-[#9945FF]",
    border: "border-purple-500/30",
    glow: "shadow-[0_0_30px_rgba(153,69,255,0.15)]",
    text: "text-purple-400",
    name: "Solana",
    logo: "https://assets.coingecko.com/coins/images/4128/large/solana.png",
  },
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPrice(val: number, sym: string) {
  if (sym === "SOL") return `$${val.toFixed(4)}`;
  return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDiff(diff: number, sym: string) {
  const abs = Math.abs(diff);
  const str = sym === "SOL"
    ? abs.toFixed(4)
    : abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `$${str}`;
}

function useCountdown(iso: string) {
  const calc = () => {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return "0:00";
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  const [t, setT] = useState(calc);
  useEffect(() => {
    const id = setInterval(() => setT(calc()), 1000);
    return () => clearInterval(id);
  }, [iso]);
  return t;
}

function edgeOneLiner(m: OracleMarket): string {
  const diff = m.oraclePrice - m.targetPrice;
  const dir = diff >= 0 ? "above" : "below";
  const absDiffStr = fmtDiff(diff, m.symbol);
  const mins = Math.floor(m.timeRemainingSeconds / 60);
  const secs = m.timeRemainingSeconds % 60;
  const timeLeft = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  if (Math.abs(m.pctDistFromTarget) < 0.02) {
    return `Oracle very close to target — both sides roughly even with ${timeLeft} left.`;
  }
  if (m.suggestedSide === "No Edge") {
    return `Oracle ${absDiffStr} ${dir} target — market vig offsets signal. No clear edge with ${timeLeft} left.`;
  }
  const edgePct = Math.round(Math.max(m.overEdge, m.underEdge) * 100);
  return `Oracle is ${absDiffStr} ${dir} the $${m.targetPrice.toLocaleString()} target with ${timeLeft} left.`;
}

// ── Best Pick Banner ──────────────────────────────────────────────────────────

function BestPickBanner({ market }: { market: OracleMarket }) {
  const cfg = ASSET[market.symbol as keyof typeof ASSET] ?? ASSET.BTC;
  const isOver = market.suggestedSide === "Over";
  const multiplier = isOver ? market.overMultiplier : market.underMultiplier;
  const edgePct = Math.round(Math.max(market.overEdge, market.underEdge) * 100);
  const diff = market.oraclePrice - market.targetPrice;
  const absDiff = fmtDiff(diff, market.symbol);
  const dir = diff >= 0 ? "above" : "below";
  const countdown = useCountdown(market.expirationTime);
  const mins = Math.floor(market.timeRemainingSeconds / 60);

  return (
    <div className={cn(
      "rounded-2xl border-2 overflow-hidden",
      isOver ? "border-emerald-500/50" : "border-red-500/50"
    )} data-testid="best-pick-banner">
      {/* Label strip */}
      <div className={cn(
        "px-4 py-2 flex items-center justify-between",
        isOver ? "bg-emerald-500/20" : "bg-red-500/20"
      )}>
        <div className="flex items-center gap-2">
          <Zap className={cn("w-3.5 h-3.5", isOver ? "text-emerald-400" : "text-red-400")} />
          <span className={cn("text-[11px] font-black uppercase tracking-[0.15em]",
            isOver ? "text-emerald-300" : "text-red-300"
          )}>
            Best Pick Right Now
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground font-mono">{countdown} left</span>
      </div>

      {/* Main body */}
      <div className="bg-[#0d1117] px-5 py-4 flex items-center gap-4">
        {/* Token */}
        <div className={cn("w-12 h-12 rounded-xl overflow-hidden flex items-center justify-center shrink-0", cfg.bg)}>
          <img src={cfg.logo} alt={market.symbol} className="w-9 h-9 object-contain" />
        </div>

        {/* Pick details */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-2xl font-black text-white">{market.symbol}</span>
            <span className={cn(
              "text-2xl font-black",
              isOver ? "text-emerald-400" : "text-red-400"
            )}>{market.suggestedSide.toUpperCase()}</span>
            <span className={cn(
              "text-[11px] font-black px-2 py-0.5 rounded-md",
              isOver ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
            )}>+{edgePct}% edge</span>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Oracle {absDiff} {dir} the {fmtPrice(market.targetPrice, market.symbol)} target
            {" · "}{market.edgeLabel}
          </p>
        </div>

        {/* Multiplier */}
        <div className={cn(
          "shrink-0 text-center px-5 py-3 rounded-xl font-black",
          isOver
            ? "bg-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.4)]"
            : "bg-red-500 shadow-[0_0_20px_rgba(239,68,68,0.4)]"
        )}>
          <p className="text-3xl text-white leading-none">{multiplier}x</p>
          <p className="text-[10px] text-white/70 mt-0.5 font-semibold">payout</p>
        </div>
      </div>

      {/* Footer: what this means */}
      <div className={cn(
        "px-5 py-2.5 flex items-center justify-between text-[11px]",
        isOver ? "bg-emerald-500/5 border-t border-emerald-500/20" : "bg-red-500/5 border-t border-red-500/20"
      )}>
        <span className="text-muted-foreground">
          Bet $10 on {market.suggestedSide} → win <strong className="text-white">${(10 * multiplier).toFixed(2)}</strong> if 15 min {market.symbol} ends {isOver ? "above" : "below"} target
        </span>
        <a
          href="https://www.coinbase.com/en-us/predict"
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "flex items-center gap-1 font-bold shrink-0 ml-3",
            isOver ? "text-emerald-400" : "text-red-400"
          )}
        >
          Trade <ArrowRight className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}

function ScanningBanner() {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 bg-[#0d1117] px-5 py-5 flex items-center gap-4"
      data-testid="scanning-banner">
      <div className="w-10 h-10 rounded-full border-2 border-white/10 flex items-center justify-center shrink-0">
        <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
      </div>
      <div>
        <p className="text-sm font-bold text-white">Scanning for edge…</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          All three markets are priced near their targets. Edge builds as prices move. Check back as the window progresses.
        </p>
      </div>
    </div>
  );
}

// ── Market Card ───────────────────────────────────────────────────────────────

function Countdown({ iso, secs }: { iso: string; secs: number }) {
  const t = useCountdown(iso);
  const urgent = secs < 120;
  return (
    <div className={cn(
      "flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-bold font-mono shrink-0",
      urgent
        ? "border-yellow-500/60 bg-yellow-500/10 text-yellow-300"
        : "border-white/15 bg-white/5 text-white/80"
    )}>
      <Clock className="w-3 h-3 opacity-50" />
      {t}
    </div>
  );
}

function MarketCard({ market }: { market: OracleMarket }) {
  const cfg = ASSET[market.symbol as keyof typeof ASSET] ?? ASSET.BTC;
  const diff = market.oraclePrice - market.targetPrice;
  const priceAbove = diff >= 0;
  const hasEdge = market.suggestedSide !== "No Edge";
  const overEdgePct = Math.round(market.overEdge * 100);
  const underEdgePct = Math.round(market.underEdge * 100);
  const isOverBest = market.suggestedSide === "Over";
  const isUnderBest = market.suggestedSide === "Under";

  return (
    <div className={cn(
      "rounded-2xl border overflow-hidden",
      hasEdge ? cn("border-white/15 bg-[#0d1117]", cfg.glow) : "border-border bg-card"
    )} data-testid={`market-card-${market.symbol}`}>

      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <div className={cn("w-10 h-10 rounded-xl overflow-hidden flex items-center justify-center shrink-0", cfg.bg)}>
          <img src={cfg.logo} alt={market.symbol} className="w-7 h-7 object-contain" />
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-white font-bold text-sm leading-tight">15 min {cfg.name}</p>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {/* Oracle price coloured by direction */}
            <span className={cn("text-[11px] font-mono font-semibold flex items-center gap-0.5",
              priceAbove ? "text-emerald-400" : "text-red-400"
            )}>
              {priceAbove ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {fmtPrice(market.oraclePrice, market.symbol)}
            </span>
            <span className="text-muted-foreground text-[10px]">oracle</span>
            <span className="text-muted-foreground text-[10px]">·</span>
            <span className="text-muted-foreground text-[10px] font-mono">
              {fmtPrice(market.targetPrice, market.symbol)} target
            </span>
            <span className={cn("text-[10px] font-bold font-mono",
              priceAbove ? "text-emerald-400" : "text-red-400"
            )}>
              ({priceAbove ? "+" : ""}{market.pctDistFromTarget.toFixed(3)}%)
            </span>
          </div>
        </div>

        <Countdown iso={market.expirationTime} secs={market.timeRemainingSeconds} />
      </div>

      {/* Over row */}
      <div className={cn(
        "mx-3 mb-1.5 rounded-xl transition-all",
        isOverBest
          ? "bg-emerald-500/10 border border-emerald-500/30 p-0.5"
          : "border border-transparent"
      )}>
        <div className="flex items-center justify-between px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className={cn("text-base font-bold w-11",
              isOverBest ? "text-emerald-300" : "text-white/70"
            )}>Over</span>
            {isOverBest && overEdgePct > 0 && (
              <span className="text-[10px] font-black bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded uppercase tracking-wide">
                ★ +{overEdgePct}%
              </span>
            )}
            <span className="text-[10px] text-muted-foreground hidden sm:inline">
              {(market.fairProbOver * 100).toFixed(0)}% fair est.
            </span>
          </div>
          <div className={cn(
            "px-6 py-2 rounded-full font-black text-white text-lg text-center min-w-[68px] transition-all",
            isOverBest
              ? "bg-emerald-500 shadow-[0_0_16px_rgba(16,185,129,0.5)]"
              : "bg-emerald-700/50"
          )}>
            {market.overMultiplier}x
          </div>
        </div>
      </div>

      {/* Under row */}
      <div className={cn(
        "mx-3 mb-3 rounded-xl transition-all",
        isUnderBest
          ? "bg-red-500/10 border border-red-500/30 p-0.5"
          : "border border-transparent"
      )}>
        <div className="flex items-center justify-between px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className={cn("text-base font-bold w-11",
              isUnderBest ? "text-red-300" : "text-white/70"
            )}>Under</span>
            {isUnderBest && underEdgePct > 0 && (
              <span className="text-[10px] font-black bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded uppercase tracking-wide">
                ★ +{underEdgePct}%
              </span>
            )}
            <span className="text-[10px] text-muted-foreground hidden sm:inline">
              {(market.fairProbUnder * 100).toFixed(0)}% fair est.
            </span>
          </div>
          <div className={cn(
            "px-6 py-2 rounded-full font-black text-white text-lg text-center min-w-[68px] transition-all",
            isUnderBest
              ? "bg-red-500 shadow-[0_0_16px_rgba(239,68,68,0.5)]"
              : "bg-red-700/50"
          )}>
            {market.underMultiplier}x
          </div>
        </div>
      </div>

      {/* One-liner explanation */}
      <div className={cn(
        "mx-3 mb-3 px-3 py-2.5 rounded-xl text-[11px] leading-relaxed",
        hasEdge
          ? "bg-[#0052FF]/10 border border-[#0052FF]/20 text-blue-200"
          : "bg-black/20 text-muted-foreground"
      )}>
        {edgeOneLiner(market)}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map(i => (
        <div key={i} className="rounded-2xl border border-border bg-card p-4 animate-pulse space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/5" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3.5 bg-white/5 rounded w-28" />
              <div className="h-2.5 bg-white/5 rounded w-44" />
            </div>
            <div className="h-6 w-12 bg-white/5 rounded-full" />
          </div>
          <div className="space-y-1.5">
            <div className="h-12 bg-white/5 rounded-xl" />
            <div className="h-12 bg-white/5 rounded-xl" />
          </div>
          <div className="h-8 bg-white/5 rounded-xl" />
        </div>
      ))}
    </div>
  );
}

function ExplainerPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3.5 text-left"
        onClick={() => setOpen(!open)}
        data-testid="explainer-toggle"
      >
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-[#4D8FFF]" />
          <span className="text-sm font-semibold text-white">How to read this page</span>
        </div>
        <span className="text-muted-foreground text-xs">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
          <div className="grid sm:grid-cols-3 gap-2.5">
            {[
              {
                label: "Target price",
                text: "Locked at the start of each 15-min window. The market pays out based on where the price ends relative to this.",
              },
              {
                label: "Oracle price",
                text: "Live price from Coinbase Exchange. Red = below target → Under is likely. Green = above → Over is likely.",
              },
              {
                label: "Multiplier (e.g. 2.1x)",
                text: "Bet $10 on Over → win $21 if price ends above target at expiry. Higher multiplier = market thinks it's less likely.",
              },
            ].map(({ label, text }) => (
              <div key={label} className="p-3 rounded-xl bg-black/20 border border-white/5">
                <p className="text-xs font-bold text-white mb-1">{label}</p>
                <p className="text-[11px] text-muted-foreground leading-relaxed">{text}</p>
              </div>
            ))}
          </div>

          <div className="p-3 rounded-xl bg-[#0052FF]/10 border border-[#0052FF]/20">
            <p className="text-xs font-bold text-[#4D8FFF] mb-1">What is "edge"?</p>
            <p className="text-[11px] text-blue-200 leading-relaxed">
              Our model estimates fair probability using live oracle price, recent volatility, RSI, and momentum — then compares it to the market's implied probability from the payout multiplier.
              A <strong>positive edge %</strong> means our model thinks one side is more likely than the market is pricing.{" "}
              <span className="text-yellow-300">Not a guarantee — prediction markets carry risk.</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CryptoScanner() {
  const { data: markets = [], isLoading, refetch, dataUpdatedAt } = useQuery<OracleMarket[]>({
    queryKey: ["/api/oracle/markets"],
    refetchInterval: 20_000,
  });

  const sorted = [...markets].sort((a, b) => b.edgeScore - a.edgeScore);
  const topMarket = sorted[0];
  const hasStrongEdge = topMarket && topMarket.suggestedSide !== "No Edge" && topMarket.edgeScore > 0;
  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  return (
    <div className="min-h-full">

      {/* ── Page Header ── */}
      <div className="bg-[#0052FF] px-5 py-5 md:px-8">
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-blue-200 font-bold">Live · Oracle Edge Scanner</span>
            </div>
            <h1 className="text-xl md:text-2xl font-black text-white">Crypto 15m Markets</h1>
            <p className="text-blue-200/80 text-xs mt-0.5">BTC · ETH · SOL — oracle vs target, where's the edge?</p>
          </div>

          {/* Token icons row */}
          <div className="hidden sm:flex items-center gap-2 shrink-0">
            {(["BTC", "ETH", "SOL"] as const).map(sym => (
              <div key={sym} className={cn("w-9 h-9 rounded-xl overflow-hidden flex items-center justify-center", ASSET[sym].bg)}>
                <img src={ASSET[sym].logo} alt={sym} className="w-6 h-6 object-contain" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="max-w-2xl mx-auto px-4 md:px-6 py-4 space-y-4">

        {/* Refresh bar */}
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground">
            {lastUpdated ? `Updated ${lastUpdated} · refreshes every 20s` : "Connecting…"}
          </p>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-white transition-colors"
            data-testid="refresh-btn"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
        </div>

        {/* ── BEST PICK (top of page, most prominent element) ── */}
        {!isLoading && (
          hasStrongEdge && topMarket
            ? <BestPickBanner market={topMarket} />
            : <ScanningBanner />
        )}

        {/* ── Market cards ── */}
        <div>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2 px-0.5">All Markets · Ranked by Edge</p>
          {isLoading ? (
            <LoadingSkeleton />
          ) : sorted.length === 0 ? (
            <div className="text-center py-12 border border-dashed border-border rounded-2xl text-muted-foreground">
              <RefreshCw className="w-6 h-6 mx-auto mb-2 opacity-30" />
              <p className="text-sm">Connecting to Coinbase Exchange…</p>
            </div>
          ) : (
            <div className="space-y-3">
              {sorted.map((m) => (
                <MarketCard key={m.symbol} market={m} />
              ))}
            </div>
          )}
        </div>

        {/* Explainer */}
        <ExplainerPanel />

        {/* Coinbase CTA */}
        <a
          href="https://www.coinbase.com/en-us/predict"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 p-4 rounded-xl border border-[#0052FF]/20 hover:border-[#0052FF]/60 transition-colors bg-[#0052FF]/5 group"
          data-testid="coinbase-link"
        >
          <div className="w-9 h-9 rounded-xl bg-[#0052FF] flex items-center justify-center shrink-0 font-black text-white text-sm">CB</div>
          <div className="flex-1">
            <p className="text-sm font-bold text-white">Trade on Coinbase Predictions</p>
            <p className="text-[11px] text-muted-foreground">Open the real 15-minute market to act on these signals</p>
          </div>
          <ExternalLink className="w-4 h-4 text-muted-foreground group-hover:text-white transition-colors shrink-0" />
        </a>

      </div>
    </div>
  );
}
