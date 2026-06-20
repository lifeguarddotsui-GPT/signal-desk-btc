import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, TrendingUp, Users, Zap } from "lucide-react";

interface SportsMarket {
  id: number;
  coinbaseMarketId: string;
  title: string;
  sport: string | null;
  yesPrice: number;
  noPrice: number;
  volume: number;
  expirationTime: string | null;
}

interface Signal {
  id: number;
  marketId: number;
  recommendedSide: string;
  confidenceScore: number;
  edgeScore: number;
  reasoning: string;
  supportingDataJson: Record<string, any> | null;
}

const SPORT_FILTERS = [
  { key: "", label: "All Sports" },
  { key: "soccer", label: "⚽ Soccer" },
  { key: "football", label: "🏈 Football" },
  { key: "mma", label: "🥊 MMA" },
  { key: "boxing", label: "🥊 Boxing" },
  { key: "basketball", label: "🏀 Basketball" },
];

function timeUntil(expiry: string | null): string {
  if (!expiry) return "—";
  const ms = new Date(expiry).getTime() - Date.now();
  if (ms <= 0) return "Live";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function sportStyle(sport: string | null) {
  const styles: Record<string, string> = {
    soccer: "sport-soccer",
    football: "sport-football",
    mma: "sport-mma",
    boxing: "sport-boxing",
    basketball: "sport-basketball",
  };
  return styles[sport ?? ""] ?? "bg-muted text-muted-foreground border-border";
}

function sportLabel(sport: string | null) {
  const labels: Record<string, string> = {
    soccer: "⚽ Soccer",
    football: "🏈 Football",
    mma: "🥊 MMA",
    boxing: "🥊 Boxing",
    basketball: "🏀 Basketball",
  };
  return labels[sport ?? ""] ?? sport ?? "Unknown";
}

function FormBadges({ form }: { form: string[] }) {
  return (
    <div className="flex gap-0.5">
      {form.map((r, i) => (
        <span key={i} className={cn(
          "w-4 h-4 rounded text-[8px] font-black flex items-center justify-center",
          r === "W" ? "bg-emerald-400/20 text-emerald-400" :
          r === "L" ? "bg-red-400/20 text-red-400" :
          "bg-yellow-400/20 text-yellow-400"
        )}>{r}</span>
      ))}
    </div>
  );
}

function SportsCard({ market, signal }: { market: SportsMarket; signal?: Signal }) {
  const supporting = signal?.supportingDataJson as any;
  const hasResearch = !!supporting?.homeTeam;

  return (
    <div className={cn(
      "p-5 rounded-xl border bg-card transition-all",
      signal ? "border-[#0052FF]/30 hover:border-[#0052FF]/50" : "border-border"
    )}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <span className={cn("text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border", sportStyle(market.sport))}>
              {sportLabel(market.sport)}
            </span>
            {supporting?.event && (
              <span className="text-[10px] text-muted-foreground">{supporting.event}</span>
            )}
          </div>
          <p className="text-sm font-bold text-white leading-snug">{market.title}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="flex items-center gap-1 text-xs text-muted-foreground justify-end mb-1">
            <Clock className="w-3 h-3" />
            <span>{timeUntil(market.expirationTime)}</span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Vol: ${(market.volume / 1000).toFixed(0)}k
          </p>
        </div>
      </div>

      {/* Teams + form (if sports research available) */}
      {hasResearch && (
        <div className="flex items-center gap-4 mb-4 p-3 rounded-lg bg-muted/30">
          <div className="flex-1">
            <p className="text-xs font-bold text-white">{supporting.homeTeam}</p>
            <FormBadges form={supporting.homeForm ?? []} />
          </div>
          <span className="text-xs font-black text-muted-foreground">VS</span>
          <div className="flex-1 text-right">
            <p className="text-xs font-bold text-white">{supporting.awayTeam}</p>
            <div className="flex justify-end">
              <FormBadges form={supporting.awayForm ?? []} />
            </div>
          </div>
        </div>
      )}

      {/* Prices + signal */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-2">
          <div className="text-center">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">YES</p>
            <div className="px-3 py-1.5 rounded-lg bg-emerald-400/10 border border-emerald-400/20">
              <span className="text-sm font-black text-emerald-400 font-mono">{(market.yesPrice * 100).toFixed(0)}¢</span>
            </div>
          </div>
          <div className="text-center">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">NO</p>
            <div className="px-3 py-1.5 rounded-lg bg-red-400/10 border border-red-400/20">
              <span className="text-sm font-black text-red-400 font-mono">{(market.noPrice * 100).toFixed(0)}¢</span>
            </div>
          </div>
        </div>

        {hasResearch && supporting.externalOdds && (
          <div className="text-center">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Books</p>
            <p className="text-xs font-bold text-[#4D8FFF] font-mono">{(parseFloat(supporting.externalOdds) * 100).toFixed(0)}%</p>
          </div>
        )}

        {signal && (
          <Link href={`/signal/${signal.id}`} className={cn(
            "ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors",
            signal.recommendedSide === "YES"
              ? "bg-emerald-400/15 text-emerald-300 hover:bg-emerald-400/25 border-emerald-400/25"
              : "bg-red-400/15 text-red-300 hover:bg-red-400/25 border-red-400/25"
          )}>
            <Zap className="w-3 h-3" />
            {signal.recommendedSide} · {signal.confidenceScore}/10
          </Link>
        )}
      </div>

      {/* Injuries */}
      {hasResearch && (supporting.injuries?.length > 0) && (
        <div className="mt-3 pt-3 border-t border-border">
          <p className="text-[9px] uppercase tracking-wider text-orange-400 font-semibold mb-1">Injury Report</p>
          {(supporting.injuries as string[]).map((inj: string, i: number) => (
            <p key={i} className="text-[10px] text-muted-foreground">⚠ {inj}</p>
          ))}
        </div>
      )}

      {/* Signal reasoning */}
      {signal && (
        <p className="text-[10px] text-muted-foreground mt-3 leading-relaxed line-clamp-2 border-t border-border pt-3">
          {signal.reasoning}
        </p>
      )}
    </div>
  );
}

export default function SportsScanner() {
  const [activeSport, setActiveSport] = useState("");

  const { data: markets = [], isLoading } = useQuery<SportsMarket[]>({
    queryKey: ["/api/markets/sports", activeSport],
    queryFn: async () => {
      const url = activeSport ? `/api/markets/sports?sport=${activeSport}` : "/api/markets/sports";
      const res = await fetch(url);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const { data: signals = [] } = useQuery<Signal[]>({
    queryKey: ["/api/signals/today"],
    refetchInterval: 60_000,
  });

  const signalsByMarketId = Object.fromEntries(signals.map(s => [s.marketId, s]));

  const soccerCount = markets.filter(m => m.sport === "soccer").length;
  const fightCount = markets.filter(m => m.sport === "mma" || m.sport === "boxing").length;

  return (
    <div className="min-h-full">
      {/* Hero */}
      <div className="halftone-bg bg-[#0052FF] px-6 py-7 md:px-10">
        <div className="max-w-5xl mx-auto flex items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] uppercase tracking-[0.2em] text-blue-200 font-bold">Sports Markets</span>
            </div>
            <h1 className="text-2xl md:text-3xl font-black text-white mb-1">Sports Opportunities</h1>
            <p className="text-blue-200 text-sm">Soccer · Football · MMA · Boxing — Coinbase prediction markets with edge analysis</p>
          </div>
          <div className="hidden md:grid grid-cols-2 gap-2 shrink-0">
            <div className="bg-white/10 rounded-xl px-3 py-2 text-center border border-white/15">
              <p className="text-lg font-black text-white">{soccerCount}</p>
              <p className="text-[9px] text-blue-200 uppercase tracking-wider">Soccer</p>
            </div>
            <div className="bg-white/10 rounded-xl px-3 py-2 text-center border border-white/15">
              <p className="text-lg font-black text-white">{fightCount}</p>
              <p className="text-[9px] text-blue-200 uppercase tracking-wider">Combat</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6">
        {/* Sport filter tabs */}
        <div className="flex gap-2 flex-wrap mb-6">
          {SPORT_FILTERS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveSport(key)}
              data-testid={`filter-sport-${key || "all"}`}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border",
                activeSport === key
                  ? "bg-[#0052FF] text-white border-[#0052FF]"
                  : "bg-card text-muted-foreground border-border hover:border-[#0052FF]/40 hover:text-white"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* World Cup highlight banner */}
        {(activeSport === "" || activeSport === "soccer") && (
          <div className="halftone-bg halftone-dense bg-gradient-to-r from-emerald-500/20 to-[#0052FF]/20 rounded-xl border border-emerald-500/20 p-4 mb-5">
            <div className="flex items-center gap-3">
              <span className="text-3xl">🏆</span>
              <div>
                <p className="text-sm font-black text-white">FIFA World Cup 2026</p>
                <p className="text-xs text-emerald-300">Round of 32 · USA / Canada / Mexico</p>
              </div>
              <div className="ml-auto text-right">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Live Now</p>
                <p className="text-sm font-bold text-white">{markets.filter(m => m.sport === "soccer").length} Matches</p>
              </div>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-44 rounded-xl" />)}
          </div>
        ) : markets.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-border rounded-xl text-muted-foreground">
            <Users className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p>No {activeSport || "sports"} markets available. Check back soon.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {markets.map(m => (
              <SportsCard key={m.id} market={m} signal={signalsByMarketId[m.id]} />
            ))}
          </div>
        )}

        {/* Ranking methodology */}
        <div className="mt-8 p-5 rounded-xl border border-[#0052FF]/20 bg-[#0052FF]/5">
          <h3 className="text-sm font-bold text-[#4D8FFF] mb-3">Sports Ranking Formula</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { pct: "25%", label: "Odds Edge" },
              { pct: "20%", label: "Recent Form" },
              { pct: "15%", label: "Injuries / News" },
              { pct: "15%", label: "Mispricing" },
              { pct: "10%", label: "Liquidity" },
              { pct: "10%", label: "Time to Event" },
              { pct: "5%",  label: "Sentiment" },
            ].map(({ pct, label }) => (
              <div key={label} className="flex items-center gap-2">
                <span className="text-[11px] font-black text-[#0052FF] w-7 shrink-0">{pct}</span>
                <span className="text-[11px] text-white">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
