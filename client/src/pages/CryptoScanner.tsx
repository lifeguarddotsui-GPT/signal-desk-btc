import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Clock, RefreshCw, ExternalLink, Zap, TrendingDown, TrendingUp } from "lucide-react";
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const ASSET = {
  BTC: {
    bg: "bg-[#F7931A]",
    text: "text-orange-400",
    glow: "shadow-orange-500/20",
    name: "Bitcoin",
    logo: "https://assets.coingecko.com/coins/images/1/large/bitcoin.png",
  },
  ETH: {
    bg: "bg-[#627EEA]",
    text: "text-blue-400",
    glow: "shadow-blue-500/20",
    name: "Ethereum",
    logo: "https://assets.coingecko.com/coins/images/279/large/ethereum.png",
  },
  SOL: {
    bg: "bg-[#9945FF]",
    text: "text-purple-400",
    glow: "shadow-purple-500/20",
    name: "Solana",
    logo: "https://assets.coingecko.com/coins/images/4128/large/solana.png",
  },
} as const;

function fmtPrice(val: number, sym: string) {
  if (sym === "SOL") return `$${val.toFixed(4)}`;
  return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDiff(diff: number, sym: string) {
  const abs = Math.abs(diff);
  const str = sym === "SOL" ? abs.toFixed(4) : abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

// Plain-English sentence explaining what's happening
function edgeSentence(m: OracleMarket): string {
  const diff = m.oraclePrice - m.targetPrice;
  const sym = m.symbol;
  const absDiffStr = fmtDiff(diff, sym);
  const dir = diff >= 0 ? "above" : "below";
  const mins = Math.floor(m.timeRemainingSeconds / 60);
  const secs = m.timeRemainingSeconds % 60;
  const timeLeft = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  if (Math.abs(m.pctDistFromTarget) < 0.02) {
    return `Oracle is very close to target — both sides are roughly even with ${timeLeft} left.`;
  }
  if (m.suggestedSide === "No Edge") {
    return `Oracle is ${absDiffStr} ${dir} target — market vig offsets the signal. No clear model edge with ${timeLeft} left.`;
  }
  const edgePct = Math.round(Math.max(m.overEdge, m.underEdge) * 100);
  return `Oracle is ${absDiffStr} ${dir} the target price with ${timeLeft} left — ${m.suggestedSide} carries a +${edgePct}% model edge.`;
}

// ── Components ────────────────────────────────────────────────────────────────

function Countdown({ iso, secs }: { iso: string; secs: number }) {
  const t = useCountdown(iso);
  const urgent = secs < 120;
  return (
    <div className={cn(
      "flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-bold font-mono",
      urgent
        ? "border-yellow-500/60 bg-yellow-500/10 text-yellow-300"
        : "border-white/15 bg-white/5 text-white"
    )}>
      <Clock className="w-3.5 h-3.5 opacity-60" />
      {t}
    </div>
  );
}

function MultiplierRow({
  side,
  multiplier,
  edgePct,
  isBest,
  fairProb,
}: {
  side: "Over" | "Under";
  multiplier: number;
  edgePct: number;
  isBest: boolean;
  fairProb: number;
}) {
  const isOver = side === "Over";
  const label = isOver ? "Over" : "Under";
  const pillBase = isOver ? "bg-emerald-600/70" : "bg-red-600/70";
  const pillBest = isOver
    ? "bg-emerald-500 shadow-[0_0_16px_rgba(16,185,129,0.5)]"
    : "bg-red-500 shadow-[0_0_16px_rgba(239,68,68,0.5)]";

  return (
    <div className={cn(
      "flex items-center justify-between px-4 py-3 rounded-xl transition-all",
      isBest ? "bg-white/5 border border-white/10" : ""
    )}>
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold text-white w-12">{label}</span>
        {isBest && edgePct > 0 && (
          <span className={cn(
            "text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded",
            isOver ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
          )}>
            ★ +{edgePct}% edge
          </span>
        )}
        <span className="text-[10px] text-muted-foreground hidden sm:inline">
          ({(fairProb * 100).toFixed(0)}% fair est.)
        </span>
      </div>
      <div className={cn(
        "px-7 py-2.5 rounded-full text-white font-black text-lg min-w-[76px] text-center transition-all",
        isBest ? pillBest : pillBase
      )}>
        {multiplier}x
      </div>
    </div>
  );
}

function MarketCard({ market, rank }: { market: OracleMarket; rank: number }) {
  const cfg = ASSET[market.symbol as keyof typeof ASSET] ?? ASSET.BTC;
  const diff = market.oraclePrice - market.targetPrice;
  const priceAbove = diff >= 0;
  const hasEdge = market.suggestedSide !== "No Edge";
  const overEdgePct = Math.round(market.overEdge * 100);
  const underEdgePct = Math.round(market.underEdge * 100);
  const sentence = edgeSentence(market);

  return (
    <div className={cn(
      "rounded-2xl border overflow-hidden transition-all",
      hasEdge
        ? "border-white/20 bg-[#111827]"
        : "border-border bg-card"
    )} data-testid={`market-card-${market.symbol}`}>

      {/* Top bar: rank + asset + countdown */}
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <div className={cn("w-11 h-11 rounded-xl overflow-hidden flex items-center justify-center shrink-0", cfg.bg)}>
          <img src={cfg.logo} alt={market.symbol} className="w-8 h-8 object-contain" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {rank === 1 && hasEdge && (
              <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#0052FF]/30 text-[#4D8FFF]">
                BEST EDGE
              </span>
            )}
            <p className="text-white font-bold text-base">15 min {cfg.name}</p>
          </div>
          {/* Oracle vs Target in one readable line */}
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className={cn("text-xs font-mono font-semibold", priceAbove ? "text-emerald-400" : "text-red-400")}>
              {priceAbove ? <TrendingUp className="w-3 h-3 inline mr-0.5" /> : <TrendingDown className="w-3 h-3 inline mr-0.5" />}
              {fmtPrice(market.oraclePrice, market.symbol)}
            </span>
            <span className="text-muted-foreground text-[10px]">oracle</span>
            <span className="text-muted-foreground text-[10px]">·</span>
            <span className="text-muted-foreground text-[10px] font-mono">
              {fmtPrice(market.targetPrice, market.symbol)} target
            </span>
            <span className={cn(
              "text-[10px] font-bold font-mono",
              priceAbove ? "text-emerald-400" : "text-red-400"
            )}>
              ({priceAbove ? "+" : ""}{market.pctDistFromTarget.toFixed(3)}%)
            </span>
          </div>
        </div>
        <Countdown iso={market.expirationTime} secs={market.timeRemainingSeconds} />
      </div>

      {/* Divider */}
      <div className="mx-5 border-t border-white/5" />

      {/* Over / Under multiplier rows */}
      <div className="px-2 py-3 space-y-1">
        <MultiplierRow
          side="Over"
          multiplier={market.overMultiplier}
          edgePct={overEdgePct}
          isBest={market.suggestedSide === "Over"}
          fairProb={market.fairProbOver}
        />
        <MultiplierRow
          side="Under"
          multiplier={market.underMultiplier}
          edgePct={underEdgePct}
          isBest={market.suggestedSide === "Under"}
          fairProb={market.fairProbUnder}
        />
      </div>

      {/* Plain-English explanation */}
      <div className={cn(
        "mx-5 mb-5 mt-1 px-4 py-3 rounded-xl text-xs leading-relaxed",
        hasEdge
          ? "bg-[#0052FF]/10 border border-[#0052FF]/20 text-blue-200"
          : "bg-black/20 text-muted-foreground"
      )}>
        {sentence}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map(i => (
        <div key={i} className="rounded-2xl border border-border bg-card p-5 animate-pulse">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-11 h-11 rounded-xl bg-white/5" />
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-white/5 rounded w-32" />
              <div className="h-3 bg-white/5 rounded w-48" />
            </div>
            <div className="h-8 w-16 bg-white/5 rounded-full" />
          </div>
          <div className="space-y-2 mb-4">
            <div className="flex justify-between items-center p-3 rounded-xl bg-white/5">
              <div className="h-4 w-12 bg-white/5 rounded" />
              <div className="h-10 w-20 bg-emerald-900/30 rounded-full" />
            </div>
            <div className="flex justify-between items-center p-3 rounded-xl bg-white/5">
              <div className="h-4 w-12 bg-white/5 rounded" />
              <div className="h-10 w-20 bg-red-900/30 rounded-full" />
            </div>
          </div>
          <div className="h-10 bg-white/5 rounded-xl" />
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
        className="w-full flex items-center justify-between px-5 py-4 text-left"
        onClick={() => setOpen(!open)}
        data-testid="explainer-toggle"
      >
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-[#4D8FFF]" />
          <span className="text-sm font-semibold text-white">How to read this page</span>
        </div>
        <span className="text-muted-foreground text-xs">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4 border-t border-border pt-4">
          <div className="grid sm:grid-cols-3 gap-3">
            {[
              {
                label: "Target price",
                text: "Set at the start of each 15-minute window. The market closes above or below this price.",
                color: "text-white",
              },
              {
                label: "Oracle price",
                text: "The live price from Coinbase Exchange. Red = below target (favors Under). Green = above (favors Over).",
                color: "text-white",
              },
              {
                label: "Multiplier (2.1x)",
                text: "Bet $1 on Over → win $2.10 if price ends above target. Higher multiplier = market thinks it's less likely.",
                color: "text-white",
              },
            ].map(({ label, text }) => (
              <div key={label} className="p-3 rounded-xl bg-black/20 border border-white/5">
                <p className="text-xs font-bold text-white mb-1.5">{label}</p>
                <p className="text-[11px] text-muted-foreground leading-relaxed">{text}</p>
              </div>
            ))}
          </div>

          <div className="p-3 rounded-xl bg-[#0052FF]/10 border border-[#0052FF]/20">
            <p className="text-xs font-bold text-[#4D8FFF] mb-1.5">What is "edge"?</p>
            <p className="text-[11px] text-blue-200 leading-relaxed">
              Our model estimates the fair probability of Over/Under using the oracle price, recent volatility (ATR),
              RSI, and 5-minute momentum — then compares it to what the market implies from the payout multiplier.
              A positive edge means our model thinks a side is more likely than the market is pricing.
              <span className="text-yellow-300 font-medium"> This is an estimate, not a guarantee.</span>
            </p>
          </div>

          <div className="grid grid-cols-5 gap-1.5">
            {[
              { range: "0–20", label: "No Edge",   color: "bg-white/5 text-muted-foreground" },
              { range: "21–40", label: "Weak",     color: "bg-yellow-500/10 text-yellow-400" },
              { range: "41–60", label: "Moderate", color: "bg-blue-500/10 text-blue-400" },
              { range: "61–80", label: "Strong",   color: "bg-green-500/10 text-green-400" },
              { range: "81–100", label: "Excellent",color: "bg-emerald-500/10 text-emerald-400" },
            ].map(({ range, label, color }) => (
              <div key={range} className={cn("rounded-lg px-2 py-2 text-center border border-white/5", color)}>
                <p className="text-[10px] font-bold">{label}</p>
                <p className="text-[9px] opacity-70 mt-0.5">{range}</p>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground italic">
            Best estimated edge only — prediction markets carry risk. Contracts may expire worthless.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CryptoScanner() {
  const { data: markets = [], isLoading, refetch, dataUpdatedAt } = useQuery<OracleMarket[]>({
    queryKey: ["/api/oracle/markets"],
    refetchInterval: 30_000,
  });

  const sorted = [...markets].sort((a, b) => b.edgeScore - a.edgeScore);
  const topMarket = sorted[0];
  const hasAnyEdge = topMarket && topMarket.edgeScore >= 20;
  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  return (
    <div className="min-h-full">

      {/* ── Header ── */}
      <div className="bg-[#0052FF] halftone-bg px-5 py-6 md:px-8">
        <div className="max-w-2xl mx-auto flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-blue-200 font-bold">Live · Oracle Edge Scanner</span>
            </div>
            <h1 className="text-2xl md:text-3xl font-black text-white">Crypto 15m Markets</h1>
            <p className="text-blue-200/80 text-sm mt-1">
              BTC · ETH · SOL — where is the best edge right now?
            </p>
          </div>

          {/* Status widget */}
          <div className="hidden sm:flex flex-col items-center bg-white/10 backdrop-blur rounded-xl px-4 py-3 border border-white/15 text-center shrink-0 min-w-[110px]">
            {isLoading ? (
              <>
                <p className="text-[9px] uppercase tracking-widest text-blue-200">Loading</p>
                <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin mt-1 mb-0.5" />
              </>
            ) : hasAnyEdge ? (
              <>
                <p className="text-[9px] uppercase tracking-widest text-blue-200 font-bold">Best Edge</p>
                <p className="text-2xl font-black text-white mt-0.5">{topMarket.edgeScore}</p>
                <p className="text-[10px] text-blue-200 font-semibold">{topMarket.symbol} · {topMarket.suggestedSide}</p>
              </>
            ) : (
              <>
                <p className="text-[9px] uppercase tracking-widest text-blue-200 font-bold">Scanning</p>
                <p className="text-lg font-black text-blue-300 mt-0.5">—</p>
                <p className="text-[10px] text-blue-200">Near target</p>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="max-w-2xl mx-auto px-4 md:px-6 py-5 space-y-5">

        {/* Refresh bar */}
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground">
            {lastUpdated ? `Updated ${lastUpdated}` : "Fetching live prices…"}
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

        {/* Market cards */}
        {isLoading ? (
          <LoadingSkeleton />
        ) : sorted.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-border rounded-2xl text-muted-foreground">
            <RefreshCw className="w-7 h-7 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">Connecting to Coinbase Exchange…</p>
          </div>
        ) : (
          <div className="space-y-4">
            {sorted.map((m, i) => (
              <MarketCard key={m.symbol} market={m} rank={i + 1} />
            ))}
          </div>
        )}

        {/* Explainer */}
        <ExplainerPanel />

        {/* Coinbase link */}
        <a
          href="https://www.coinbase.com/en-us/predict"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 p-4 rounded-xl border border-[#0052FF]/20 hover:border-[#0052FF]/50 transition-colors bg-[#0052FF]/5 group"
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
