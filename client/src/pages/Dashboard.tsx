import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { RefreshCw, Clock, ChevronRight, AlertTriangle, Target, Trophy, Swords, Zap } from "lucide-react";

interface Signal {
  id: number;
  rankToday: number;
  marketTitle: string;
  category: string;
  asset: string | null;
  sport: string | null;
  recommendedSide: string;
  confidenceScore: number;
  edgeScore: number;
  riskScore: number;
  reasoning: string;
  maxBetPct: number;
  yesPrice: number;
  noPrice: number;
  expirationTime: string | null;
  supportingDataJson: Record<string, any> | null;
}

function timeUntil(expiry: string | null): string {
  if (!expiry) return "—";
  const ms = new Date(expiry).getTime() - Date.now();
  if (ms <= 0) return "Expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function confidenceColor(score: number) {
  if (score >= 8) return { text: "text-emerald-400", border: "border-emerald-400/40", bg: "bg-emerald-400/8", label: "STRONG BUY", labelBg: "bg-emerald-400/15 text-emerald-300" };
  if (score >= 7) return { text: "text-blue-400", border: "border-blue-400/40", bg: "bg-blue-400/5", label: "BUY", labelBg: "bg-blue-400/15 text-blue-300" };
  if (score >= 6.5) return { text: "text-yellow-400", border: "border-yellow-400/30", bg: "bg-yellow-400/5", label: "WATCH", labelBg: "bg-yellow-400/15 text-yellow-300" };
  return { text: "text-muted-foreground", border: "border-border", bg: "", label: "MONITOR", labelBg: "bg-muted text-muted-foreground" };
}

function riskLabel(score: number): { label: string; cls: string } {
  if (score <= 3) return { label: "LOW", cls: "text-emerald-400 bg-emerald-400/10" };
  if (score <= 6) return { label: "MEDIUM", cls: "text-yellow-400 bg-yellow-400/10" };
  return { label: "HIGH", cls: "text-red-400 bg-red-400/10" };
}

function rankBadgeClass(rank: number) {
  if (rank === 1) return "rank-badge-1";
  if (rank === 2) return "rank-badge-2";
  if (rank === 3) return "rank-badge-3";
  return "rank-badge-n";
}

function SportIcon({ sport }: { sport: string | null }) {
  const icons: Record<string, string> = { soccer: "⚽", mma: "🥊" };
  return <span className="text-base">{icons[sport ?? ""] ?? "🎯"}</span>;
}

function SportBadge({ sport }: { sport: string | null }) {
  const labels: Record<string, string> = { soccer: "⚽ Soccer", mma: "🥊 UFC Fight Night" };
  const styles: Record<string, string> = {
    soccer: "sport-soccer", mma: "sport-mma",
  };
  return (
    <span className={cn("text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border", styles[sport ?? ""] ?? "bg-muted text-muted-foreground border-border")}>
      {labels[sport ?? ""] ?? sport}
    </span>
  );
}

function ConfidenceRing({ score }: { score: number }) {
  const { text } = confidenceColor(score);
  const size = 52;
  const stroke = 4;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const filled = (score / 10) * circ;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(228 35% 16%)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={score >= 8 ? "#34d399" : score >= 7 ? "#3b82f6" : score >= 6.5 ? "#fbbf24" : "#6b7280"}
          strokeWidth={stroke} strokeDasharray={`${filled} ${circ}`} strokeLinecap="round" />
      </svg>
      <div className={cn("absolute inset-0 flex items-center justify-center font-bold text-sm", text)}>
        {Number(score).toFixed(1)}
      </div>
    </div>
  );
}

function SignalCard({ signal, settings }: { signal: Signal; settings: any }) {
  const { border, bg, label, labelBg } = confidenceColor(signal.confidenceScore);
  const risk = riskLabel(signal.riskScore);
  const contractPrice = signal.recommendedSide === "YES" ? signal.yesPrice : signal.noPrice;
  const bankroll = settings?.bankrollAmount ?? 1000;
  const maxBet = parseFloat(((signal.maxBetPct / 100) * bankroll).toFixed(2));
  const [timeStr, setTimeStr] = useState(timeUntil(signal.expirationTime));
  const sup = signal.supportingDataJson as any ?? {};

  useEffect(() => {
    const id = setInterval(() => setTimeStr(timeUntil(signal.expirationTime)), 1000);
    return () => clearInterval(id);
  }, [signal.expirationTime]);

  return (
    <Link href={`/signal/${signal.id}`} className={cn(
      "block p-5 rounded-xl border bg-card hover:border-[#0052FF]/40 transition-all duration-200 cursor-pointer group",
      border, bg
    )} data-testid={`signal-card-${signal.id}`}>
      <div className="flex items-start gap-4">
        {/* Rank + Ring */}
        <div className="flex flex-col items-center gap-2 shrink-0">
          <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center text-xs font-black", rankBadgeClass(signal.rankToday))}>
            {signal.rankToday}
          </div>
          <ConfidenceRing score={signal.confidenceScore} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Sport + event label + timer */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              <SportIcon sport={signal.sport} />
              <SportBadge sport={signal.sport} />
              {sup.event && <span className="text-[10px] text-muted-foreground hidden sm:inline">{sup.event}</span>}
              <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded tracking-widest", labelBg)}>{label}</span>
            </div>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
              <Clock className="w-3 h-3" />
              <span className={cn(signal.expirationTime && new Date(signal.expirationTime).getTime() - Date.now() < 86400000 ? "text-yellow-400" : "")}>{timeStr}</span>
            </div>
          </div>

          {/* Title */}
          <p className="text-sm font-semibold text-white leading-snug mb-2.5 group-hover:text-blue-200 transition-colors line-clamp-2">
            {signal.marketTitle}
          </p>

          {/* Fighter/Team matchup (sports only) */}
          {sup.homeTeam && sup.awayTeam && (
            <div className="flex items-center gap-2 mb-2.5 text-[11px]">
              <span className="font-bold text-white truncate max-w-[100px]">{sup.homeTeam}</span>
              <span className="text-muted-foreground font-black text-[9px]">VS</span>
              <span className="font-bold text-white truncate max-w-[100px]">{sup.awayTeam}</span>
            </div>
          )}

          {/* Stats strip */}
          <div className="flex flex-wrap items-center gap-3 mb-2.5">
            <div className="flex flex-col">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Side</span>
              <span className={cn("text-sm font-bold", signal.recommendedSide === "YES" ? "text-emerald-400" : "text-red-400")}>
                {signal.recommendedSide}
              </span>
            </div>
            <div className="w-px h-7 bg-border" />
            <div className="flex flex-col">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Price</span>
              <span className="text-sm font-bold text-white font-mono">{(contractPrice * 100).toFixed(0)}¢</span>
            </div>
            <div className="w-px h-7 bg-border" />
            <div className="flex flex-col">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Edge</span>
              <span className="text-sm font-bold text-emerald-400 font-mono">+{signal.edgeScore}%</span>
            </div>
            <div className="w-px h-7 bg-border" />
            <div className="flex flex-col">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Risk</span>
              <span className={cn("text-xs font-bold px-1.5 py-0.5 rounded", risk.cls)}>{risk.label}</span>
            </div>
            {signal.maxBetPct > 0 && (
              <>
                <div className="w-px h-7 bg-border" />
                <div className="flex flex-col">
                  <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Max Bet</span>
                  <span className="text-xs font-bold text-[#4D8FFF] font-mono">{signal.maxBetPct}% · ${maxBet}</span>
                </div>
              </>
            )}
          </div>

          <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">{signal.reasoning}</p>
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-white transition-colors mt-1 shrink-0" />
      </div>
    </Link>
  );
}

const DATE_FILTERS = [
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "week", label: "This Week" },
];

function inDateWindow(expirationTime: string | null, filter: string): boolean {
  if (!expirationTime) return true;
  const now = Date.now();
  const t = new Date(expirationTime).getTime();
  if (t < now - 3 * 3600 * 1000) return false;
  if (filter === "today")    return t <= now + 28 * 3600 * 1000;
  if (filter === "tomorrow") return t > now + 12 * 3600 * 1000 && t <= now + 52 * 3600 * 1000;
  if (filter === "week")     return t <= now + 7 * 24 * 3600 * 1000;
  return true;
}

export default function Dashboard() {
  const qc = useQueryClient();
  const [dateFilter, setDateFilter] = useState("today");

  const { data: allSignals = [], isLoading } = useQuery<Signal[]>({
    queryKey: ["/api/signals/today"],
    refetchInterval: 60_000,
  });
  const { data: settings } = useQuery({ queryKey: ["/api/settings"] });
  const { data: alerts = [] } = useQuery<any[]>({ queryKey: ["/api/alerts"], refetchInterval: 30_000 });

  const refresh = useMutation({
    mutationFn: () => apiRequest("POST", "/api/markets/refresh"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/signals/today"] }),
  });

  // ── Sports only on main page, filtered by date ──
  const signals = allSignals
    .filter(s => s.category === "sports")
    .filter(s => inDateWindow(s.expirationTime, dateFilter));
  const soccerCount = signals.filter(s => s.sport === "soccer").length;
  const mmaCount = signals.filter(s => s.sport === "mma").length;
  const topSignal = signals[0];
  const dateLabel = DATE_FILTERS.find(d => d.key === dateFilter)?.label ?? "Today";
  const todayAlerts = alerts.filter(a => new Date(a.createdAt).toDateString() === new Date().toDateString());

  return (
    <div className="min-h-full">
      {/* ── Hero Banner ── */}
      <div className="halftone-bg bg-[#0052FF] px-6 py-8 md:px-10 md:py-10">
        <div className="max-w-5xl mx-auto flex items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-200/80 bg-white/10 px-2 py-0.5 rounded">
                {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-blue-200/80 bg-white/10 px-2 py-0.5 rounded">
                Sports Predictions
              </span>
            </div>
            <h1 className="text-3xl md:text-4xl font-black text-white leading-tight mb-2">
              {dateLabel}'s Top Picks
            </h1>
            <p className="text-blue-200 text-sm md:text-base max-w-lg">
              {signals.length} sports opportunities ranked by our model — Soccer · UFC Fight Night. Updated live.
            </p>
          </div>
          {topSignal && (
            <div className="hidden md:flex items-center gap-4 bg-white/10 backdrop-blur rounded-2xl px-5 py-4 border border-white/20 shrink-0">
              <div>
                <p className="text-[9px] uppercase tracking-widest text-blue-200 font-bold">#1 Pick Today</p>
                <p className="text-white font-bold text-sm max-w-[200px] leading-snug line-clamp-1 mt-0.5">{topSignal.marketTitle}</p>
                <p className="text-blue-200 text-xs mt-0.5">{topSignal.recommendedSide} · {topSignal.confidenceScore != null ? `${Number(topSignal.confidenceScore).toFixed(1)}/10` : "—"} confidence</p>
              </div>
              <div className="text-3xl font-black text-white">{topSignal.confidenceScore != null ? Number(topSignal.confidenceScore).toFixed(1) : "—"}</div>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6">
        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            { label: "Total Picks", value: signals.length.toString(), icon: Target, color: "text-[#4D8FFF]" },
            { label: "⚽ Soccer", value: soccerCount.toString(), icon: Trophy, color: "text-emerald-400" },
            { label: "🥊 UFC Fight Night", value: mmaCount.toString(), icon: Swords, color: "text-orange-400" },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="p-4 rounded-xl border border-border bg-card flex items-center gap-3">
              <Icon className={cn("w-5 h-5 shrink-0", color)} />
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
                <p className="text-xl font-black text-white">{value}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Date filter + header */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h2 className="text-base font-bold text-white">Ranked Sports Picks</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Score ≥ 8 = Strong Buy · 7–7.9 = Buy · 6.5–6.9 = Watch · Click any card for full research
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-1 p-1 rounded-lg bg-muted/40 border border-border">
              {DATE_FILTERS.map(({ key, label }) => (
                <button key={key} onClick={() => setDateFilter(key)}
                  data-testid={`dash-filter-date-${key}`}
                  className={cn(
                    "px-3 py-1 rounded-md text-[11px] font-bold transition-all",
                    dateFilter === key
                      ? "bg-[#0052FF] text-white"
                      : "text-muted-foreground hover:text-white"
                  )}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => refresh.mutate()} disabled={refresh.isPending}
            data-testid="button-refresh-signals" className="gap-1.5 text-xs">
            <RefreshCw className={cn("w-3.5 h-3.5", refresh.isPending && "animate-spin")} />
            {refresh.isPending ? "Refreshing..." : "Refresh"}
          </Button>
        </div>

        {/* Signal cards — sports only */}
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-40 w-full rounded-xl" />)}
          </div>
        ) : signals.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground">
            <Target className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No sports picks for {dateLabel}</p>
            {dateFilter === "today" && (
              <p className="text-sm mt-1">
                No active markets today. Try{" "}
                <button className="underline text-[#4D8FFF]" onClick={() => setDateFilter("week")}>This Week</button>{" "}
                to see upcoming events.
              </p>
            )}
            <Button className="mt-4" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              {refresh.isPending ? "Refreshing..." : "Refresh Markets"}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {signals.map(s => <SignalCard key={s.id} signal={s} settings={settings} />)}
          </div>
        )}

        {/* Crypto tab promo */}
        <Link href="/crypto" className="block mt-6 p-4 rounded-xl border border-[#0052FF]/20 bg-[#0052FF]/5 hover:border-[#0052FF]/40 transition-colors group">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Zap className="w-5 h-5 text-[#4D8FFF]" />
              <div>
                <p className="text-sm font-bold text-white">Crypto 15m Markets</p>
                <p className="text-[11px] text-muted-foreground">BTC · ETH · SOL probability scores — ranked by our model</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-white transition-colors" />
          </div>
        </Link>

        {/* Disclaimer */}
        <div className="mt-4 p-4 rounded-xl border border-yellow-400/20 bg-yellow-400/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
            <p className="text-[11px] text-yellow-200/70 leading-relaxed">
              <strong className="text-yellow-300">Research only — not financial advice.</strong> Prediction market contracts can expire worthless. Coinbase warns these products involve substantial risk. Always bet within your means.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
