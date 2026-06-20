import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { Clock, Users, ExternalLink, Youtube, Trophy, Zap, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SportsMarket {
  id: number;
  coinbaseMarketId: string;
  title: string;
  sport: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  yesPrice: number;
  noPrice: number;
  volume: number;
  expirationTime: string | null;
}

interface FighterProfile {
  name: string;
  record: string;
  wins: number;
  losses: number;
  draws: number;
  koPct: number;
  subPct: number;
  decPct: number;
  height: string;
  reach: string;
  stance: string;
  nationality: string;
  weightClass: string;
  age?: number;
  lastFights: Array<{ opponent: string; result: "W" | "L"; method: string; round?: number; date: string }>;
  strengths: string[];
  ytLink: string;
}

interface TeamProfile {
  name: string;
  ranking: string;
  formation: string;
  lastFiveGames: Array<{ opponent: string; result: "W" | "L" | "D"; score: string; competition: string; date: string }>;
  goalsFor: number;
  goalsAgainst: number;
  topScorer: string;
  keyPlayer: string;
  manager: string;
  strengths: string[];
  ytLink: string;
}

interface Signal {
  id: number;
  marketId: number;
  recommendedSide: string;
  confidenceScore: number;
  edgeScore: number;
  reasoning: string;
  riskScore: number;
  rankToday: number;
  supportingDataJson: Record<string, any> | null;
}

const SPORT_FILTERS = [
  { key: "", label: "All Sports" },
  { key: "soccer", label: "⚽ Soccer" },
  { key: "mma", label: "🥊 MMA" },
  { key: "boxing", label: "🥊 Boxing" },
];

function parseVsNames(title: string): { home: string; away: string } | null {
  // "🥊 Boxing: Will Tyson Fury win vs Anthony Joshua?"
  // "⚽ Soccer: Will Germany win vs Ivory Coast?"
  const m = title.match(/Will (.+?) win vs (.+?)\?/i);
  if (m) return { home: m[1].trim(), away: m[2].trim() };
  return null;
}

function timeUntil(expiry: string | null): string {
  if (!expiry) return "—";
  const ms = new Date(expiry).getTime() - Date.now();
  if (ms <= 0) return "Live / Imminent";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function sportStyle(sport: string | null) {
  const styles: Record<string, string> = {
    soccer: "sport-soccer", mma: "sport-mma", boxing: "sport-boxing",
  };
  return styles[sport ?? ""] ?? "bg-muted text-muted-foreground border-border";
}

function sportLabel(sport: string | null) {
  return { soccer: "⚽ Soccer", mma: "🥊 MMA", boxing: "🥊 Boxing" }[sport ?? ""] ?? sport ?? "—";
}

function FormBadges({ form }: { form: string[] }) {
  return (
    <div className="flex gap-0.5">
      {form.slice(0, 5).map((r, i) => (
        <span key={i} className={cn(
          "w-5 h-5 rounded text-[8px] font-black flex items-center justify-center",
          r === "W" ? "bg-emerald-400/20 text-emerald-400" :
          r === "L" ? "bg-red-400/20 text-red-400" :
          "bg-yellow-400/20 text-yellow-400"
        )}>{r}</span>
      ))}
    </div>
  );
}

function ConfidenceRing({ score }: { score: number }) {
  const size = 48, stroke = 4;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const filled = (score / 10) * circ;
  const color = score >= 8 ? "#34d399" : score >= 7 ? "#3b82f6" : score >= 6.5 ? "#fbbf24" : "#6b7280";
  const textColor = score >= 8 ? "text-emerald-400" : score >= 7 ? "text-blue-400" : score >= 6.5 ? "text-yellow-400" : "text-muted-foreground";
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(228 35% 16%)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color}
          strokeWidth={stroke} strokeDasharray={`${filled} ${circ}`} strokeLinecap="round" />
      </svg>
      <div className={cn("absolute inset-0 flex items-center justify-center font-bold text-xs", textColor)}>
        {score.toFixed(1)}
      </div>
    </div>
  );
}

function StatBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[9px] text-muted-foreground">{label}</span>
        <span className="text-[9px] font-bold text-white">{value}%</span>
      </div>
      <div className="h-1 bg-muted rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full", color)} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

// ── Fighter card (MMA / Boxing) ───────────────────────────────────────────────

function FighterCard({ profile }: { profile: FighterProfile }) {
  const totalWins = profile.wins;
  return (
    <div className="flex-1 min-w-0 p-3 rounded-lg bg-muted/20 border border-border">
      {/* Name + record */}
      <p className="text-sm font-black text-white leading-tight mb-0.5">{profile.name}</p>
      <p className="text-[10px] font-bold text-[#4D8FFF] mb-2">{profile.record} · {profile.weightClass}</p>

      {/* Win method breakdown */}
      {totalWins > 0 && (
        <div className="space-y-1 mb-3">
          <StatBar label={`KO/TKO (${Math.round(profile.koPct * totalWins / 100)} wins)`} value={profile.koPct} color="bg-red-400" />
          {profile.subPct > 0 && <StatBar label={`Submission (${Math.round(profile.subPct * totalWins / 100)} wins)`} value={profile.subPct} color="bg-purple-400" />}
          <StatBar label={`Decision (${Math.round(profile.decPct * totalWins / 100)} wins)`} value={profile.decPct} color="bg-blue-400" />
        </div>
      )}

      {/* Stats row */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mb-3">
        {profile.height !== "—" && <span className="text-[9px] text-muted-foreground">📏 {profile.height}</span>}
        {profile.reach !== "—" && <span className="text-[9px] text-muted-foreground">🦅 {profile.reach}</span>}
        {profile.stance !== "—" && <span className="text-[9px] text-muted-foreground">🥊 {profile.stance}</span>}
        {profile.nationality !== "—" && <span className="text-[9px] text-muted-foreground">🌍 {profile.nationality}</span>}
        {profile.age && <span className="text-[9px] text-muted-foreground">Age {profile.age}</span>}
      </div>

      {/* Strengths */}
      {profile.strengths.length > 0 && (
        <div className="mb-3">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">Strengths</p>
          <div className="flex flex-wrap gap-1">
            {profile.strengths.map((s, i) => (
              <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-[#0052FF]/10 text-[#4D8FFF] border border-[#0052FF]/20">{s}</span>
            ))}
          </div>
        </div>
      )}

      {/* Last fights */}
      {profile.lastFights.length > 0 && (
        <div className="mb-3">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">Last Fights</p>
          <div className="space-y-0.5">
            {profile.lastFights.slice(0, 4).map((f, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className={cn("w-4 h-4 rounded text-[7px] font-black flex items-center justify-center shrink-0",
                  f.result === "W" ? "bg-emerald-400/20 text-emerald-400" : "bg-red-400/20 text-red-400"
                )}>{f.result}</span>
                <span className="text-[10px] text-white truncate flex-1">{f.opponent}</span>
                <span className="text-[9px] text-muted-foreground shrink-0">{f.method}{f.round ? ` R${f.round}` : ""}</span>
                <span className="text-[9px] text-muted-foreground/60 shrink-0">{f.date}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* YouTube link */}
      <a href={profile.ytLink} target="_blank" rel="noopener noreferrer"
        className="flex items-center gap-1.5 text-[10px] text-red-400 hover:text-red-300 transition-colors font-semibold">
        <Youtube className="w-3 h-3" />
        Watch {profile.name} highlights
        <ExternalLink className="w-2.5 h-2.5" />
      </a>
    </div>
  );
}

// ── Team card (Soccer) ────────────────────────────────────────────────────────

function TeamCard({ profile }: { profile: TeamProfile }) {
  return (
    <div className="flex-1 min-w-0 p-3 rounded-lg bg-muted/20 border border-border">
      <p className="text-sm font-black text-white leading-tight mb-0.5">{profile.name}</p>
      <p className="text-[10px] font-bold text-[#4D8FFF] mb-2">{profile.ranking} · {profile.formation}</p>

      {/* Goals last 5 */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="text-center p-1.5 rounded-lg bg-emerald-400/10 border border-emerald-400/15">
          <p className="text-lg font-black text-emerald-400">{profile.goalsFor}</p>
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider">Goals For</p>
        </div>
        <div className="text-center p-1.5 rounded-lg bg-red-400/10 border border-red-400/15">
          <p className="text-lg font-black text-red-400">{profile.goalsAgainst}</p>
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider">Goals Against</p>
        </div>
      </div>

      {/* Last 5 games */}
      {profile.lastFiveGames.length > 0 && (
        <div className="mb-3">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">Last 5 Games</p>
          <div className="space-y-0.5">
            {profile.lastFiveGames.map((g, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className={cn("w-4 h-4 rounded text-[7px] font-black flex items-center justify-center shrink-0",
                  g.result === "W" ? "bg-emerald-400/20 text-emerald-400" :
                  g.result === "L" ? "bg-red-400/20 text-red-400" :
                  "bg-yellow-400/20 text-yellow-400"
                )}>{g.result}</span>
                <span className="text-[10px] text-white truncate flex-1">{g.opponent}</span>
                <span className="text-[9px] font-bold text-white font-mono shrink-0">{g.score}</span>
                <span className="text-[9px] text-muted-foreground/60 shrink-0">{g.date}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Key info */}
      <div className="space-y-0.5 mb-3">
        <p className="text-[10px] text-muted-foreground">⚽ <span className="text-white">{profile.topScorer}</span></p>
        <p className="text-[10px] text-muted-foreground">⭐ Key player: <span className="text-white">{profile.keyPlayer}</span></p>
        <p className="text-[10px] text-muted-foreground">👔 Manager: <span className="text-white">{profile.manager}</span></p>
      </div>

      {/* Strengths */}
      {profile.strengths.length > 0 && (
        <div className="mb-3">
          <div className="flex flex-wrap gap-1">
            {profile.strengths.map((s, i) => (
              <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-[#0052FF]/10 text-[#4D8FFF] border border-[#0052FF]/20">{s}</span>
            ))}
          </div>
        </div>
      )}

      {/* YouTube highlights */}
      <a href={profile.ytLink} target="_blank" rel="noopener noreferrer"
        className="flex items-center gap-1.5 text-[10px] text-red-400 hover:text-red-300 transition-colors font-semibold">
        <Youtube className="w-3 h-3" />
        Watch {profile.name} highlights
        <ExternalLink className="w-2.5 h-2.5" />
      </a>
    </div>
  );
}

// ── Main sports card ──────────────────────────────────────────────────────────

function SportsCard({ market, signal }: { market: SportsMarket; signal?: Signal }) {
  const [expanded, setExpanded] = useState(false);
  const sup = signal?.supportingDataJson as any ?? {};
  const parsed = parseVsNames(market.title);
  const homeLabel = sup.homeTeam ?? market.homeTeam ?? parsed?.home ?? "—";
  const awayLabel = sup.awayTeam ?? market.awayTeam ?? parsed?.away ?? "—";
  const homeProfile: FighterProfile | TeamProfile | null = sup.homeProfile ?? null;
  const awayProfile: FighterProfile | TeamProfile | null = sup.awayProfile ?? null;
  const coinbaseLink: string = sup.coinbaseLink ?? "https://www.coinbase.com/en-us/predict";
  const isFight = market.sport === "mma" || market.sport === "boxing";
  const scoreBreakdown: Record<string, number> = sup.scoreBreakdown ?? {};
  const hasResearch = !!(homeProfile || awayProfile);

  const confidenceLabel = signal
    ? signal.confidenceScore >= 8 ? "STRONG BUY" : signal.confidenceScore >= 7 ? "BUY" : signal.confidenceScore >= 6.5 ? "WATCH" : "MONITOR"
    : null;
  const confidenceCls = signal
    ? signal.confidenceScore >= 8 ? "bg-emerald-400/15 text-emerald-300 border-emerald-400/25"
    : signal.confidenceScore >= 7 ? "bg-blue-400/15 text-blue-300 border-blue-400/25"
    : "bg-yellow-400/15 text-yellow-300 border-yellow-400/25"
    : "";

  return (
    <div className={cn(
      "rounded-xl border bg-card overflow-hidden transition-all",
      signal ? "border-[#0052FF]/30" : "border-border"
    )} data-testid={`sports-card-${market.id}`}>
      {/* ── Card header ── */}
      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border", sportStyle(market.sport))}>
              {sportLabel(market.sport)}
            </span>
            {sup.event && <span className="text-[10px] text-muted-foreground">{sup.event}</span>}
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <Clock className="w-3 h-3" />
            <span>{timeUntil(market.expirationTime)}</span>
          </div>
        </div>

        <p className="text-sm font-bold text-white leading-snug mb-3">{market.title}</p>

        {/* Teams / fighters VS bar */}
        <div className="flex items-center gap-3 mb-4 p-3 rounded-lg bg-muted/30">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-black text-white truncate">{homeLabel}</p>
            {sup.homeForm && <FormBadges form={sup.homeForm} />}
          </div>
          <div className="text-center shrink-0">
            <span className="text-xs font-black text-muted-foreground">VS</span>
            {signal && (
              <div className="mt-1">
                <ConfidenceRing score={signal.confidenceScore} />
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0 text-right">
            <p className="text-xs font-black text-white truncate">{awayLabel}</p>
            {sup.awayForm && (
              <div className="flex justify-end">
                <FormBadges form={sup.awayForm} />
              </div>
            )}
          </div>
        </div>

        {/* Prices + edge + signal */}
        <div className="flex items-center gap-3 flex-wrap mb-3">
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
            {sup.externalOdds && (
              <div className="text-center">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">Books</p>
                <div className="px-3 py-1.5 rounded-lg border border-border">
                  <span className="text-sm font-black text-[#4D8FFF] font-mono">{(parseFloat(sup.externalOdds) * 100).toFixed(0)}%</span>
                </div>
              </div>
            )}
          </div>

          {signal && (
            <div className="ml-auto flex items-center gap-2">
              <div className={cn("text-[9px] font-bold uppercase tracking-wider px-2 py-1 rounded border", confidenceCls)}>
                {signal.recommendedSide} · {confidenceLabel}
              </div>
              <Link href={`/signal/${signal.id}`}
                className="flex items-center gap-1 text-[11px] text-[#4D8FFF] hover:text-white transition-colors font-medium">
                <Zap className="w-3 h-3" />
                Analysis
              </Link>
            </div>
          )}
        </div>

        {/* Score breakdown */}
        {signal && Object.keys(scoreBreakdown).length > 0 && (
          <div className="mb-3 p-3 rounded-lg bg-muted/20 border border-border/50">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-2 font-semibold">Score Breakdown</p>
            <div className="grid grid-cols-2 gap-1.5">
              {Object.entries(scoreBreakdown).map(([key, val]) => (
                <div key={key} className="flex items-center justify-between gap-2">
                  <span className="text-[9px] text-muted-foreground truncate">{key}</span>
                  <span className={cn("text-[9px] font-bold shrink-0",
                    val >= 8 ? "text-emerald-400" : val >= 6 ? "text-blue-400" : val >= 4 ? "text-yellow-400" : "text-red-400"
                  )}>{val}/10</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reasoning */}
        {signal && (
          <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2 mb-3">
            {signal.reasoning}
          </p>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          <a href={coinbaseLink} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-[#0052FF] hover:bg-[#0044DD] text-white transition-colors"
            data-testid={`coinbase-link-${market.id}`}>
            <div className="w-3.5 h-3.5 rounded bg-white/20 flex items-center justify-center">
              <span className="text-[7px] font-black text-white">CB</span>
            </div>
            Open in Coinbase
            <ExternalLink className="w-3 h-3" />
          </a>

          {hasResearch && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-border text-muted-foreground hover:text-white hover:border-white/20 transition-colors"
              data-testid={`expand-research-${market.id}`}>
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {expanded ? "Hide" : "Show"} Research
            </button>
          )}

          {isFight && homeProfile && (
            <a href={(homeProfile as FighterProfile).ytLink} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs text-red-400 hover:text-red-300 border border-red-400/20 hover:border-red-400/40 transition-colors">
              <Youtube className="w-3 h-3" />
              Highlights
            </a>
          )}
          {!isFight && homeProfile && (
            <a href={(homeProfile as TeamProfile).ytLink} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs text-red-400 hover:text-red-300 border border-red-400/20 hover:border-red-400/40 transition-colors">
              <Youtube className="w-3 h-3" />
              Match Highlights
            </a>
          )}
        </div>
      </div>

      {/* ── Expanded research panel ── */}
      {expanded && hasResearch && (
        <div className="border-t border-border p-5 bg-muted/10">
          <p className="text-xs font-bold text-white mb-3">
            {isFight ? "Fighter Research" : "Team Research"}
          </p>
          <div className="flex gap-3 flex-col sm:flex-row">
            {homeProfile && (
              isFight
                ? <FighterCard profile={homeProfile as FighterProfile} />
                : <TeamCard profile={homeProfile as TeamProfile} />
            )}
            {awayProfile && (
              isFight
                ? <FighterCard profile={awayProfile as FighterProfile} />
                : <TeamCard profile={awayProfile as TeamProfile} />
            )}
          </div>

          {/* Head to head note */}
          {sup.headToHead && (
            <div className="mt-3 p-3 rounded-lg bg-muted/20 border border-border/50">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">Head to Head</p>
              <p className="text-[11px] text-white">{sup.headToHead}</p>
            </div>
          )}

          {/* Context note */}
          {sup.context && (
            <div className="mt-2 p-3 rounded-lg bg-[#0052FF]/5 border border-[#0052FF]/15">
              <p className="text-[10px] text-blue-200/80 leading-relaxed">{sup.context}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SportsScanner() {
  const [activeSport, setActiveSport] = useState("");
  const qc = useQueryClient();

  const { data: markets = [], isLoading } = useQuery<SportsMarket[]>({
    queryKey: ["/api/markets/sports", activeSport],
    queryFn: async () => {
      const url = activeSport ? `/api/markets/sports?sport=${activeSport}` : "/api/markets/sports";
      const res = await fetch(url);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const { data: allSignals = [] } = useQuery<Signal[]>({
    queryKey: ["/api/signals/today"],
    refetchInterval: 60_000,
  });

  const refresh = useMutation({
    mutationFn: () => apiRequest("POST", "/api/markets/refresh"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/signals/today"] }),
  });

  const sportsSignals = allSignals.filter(s => (s as any).category === "sports");
  const signalsByMarketId = Object.fromEntries(sportsSignals.map(s => [s.marketId, s]));

  const soccerCount = markets.filter(m => m.sport === "soccer").length;
  const mmaCount = markets.filter(m => m.sport === "mma").length;
  const boxingCount = markets.filter(m => m.sport === "boxing").length;

  return (
    <div className="min-h-full">
      {/* Hero */}
      <div className="halftone-bg bg-[#0052FF] px-6 py-7 md:px-10">
        <div className="max-w-5xl mx-auto flex items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Trophy className="w-4 h-4 text-blue-200" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-blue-200 font-bold">Sports Research</span>
            </div>
            <h1 className="text-2xl md:text-3xl font-black text-white mb-1">Sports & Fights</h1>
            <p className="text-blue-200 text-sm">Soccer · MMA · Boxing — ranked research with fighter profiles, stats &amp; Coinbase links</p>
          </div>
          <div className="hidden md:flex gap-3 shrink-0">
            {[
              { label: "Soccer", count: soccerCount, icon: "⚽" },
              { label: "MMA", count: mmaCount, icon: "🥊" },
              { label: "Boxing", count: boxingCount, icon: "🥊" },
            ].map(({ label, count, icon }) => (
              <div key={label} className="bg-white/10 rounded-xl px-3 py-2 text-center border border-white/15">
                <p className="text-lg font-black text-white">{count}</p>
                <p className="text-[9px] text-blue-200 uppercase tracking-wider">{icon} {label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6">
        {/* Sport filter + refresh */}
        <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
          <div className="flex gap-2 flex-wrap">
            {SPORT_FILTERS.map(({ key, label }) => (
              <button key={key} onClick={() => setActiveSport(key)}
                data-testid={`filter-sport-${key || "all"}`}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border",
                  activeSport === key
                    ? "bg-[#0052FF] text-white border-[#0052FF]"
                    : "bg-card text-muted-foreground border-border hover:border-[#0052FF]/40 hover:text-white"
                )}>
                {label}
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => refresh.mutate()} disabled={refresh.isPending}
            data-testid="button-refresh-sports" className="gap-1.5 text-xs shrink-0">
            <RefreshCw className={cn("w-3.5 h-3.5", refresh.isPending && "animate-spin")} />
            {refresh.isPending ? "Refreshing..." : "Refresh"}
          </Button>
        </div>

        {/* World Cup banner */}
        {(activeSport === "" || activeSport === "soccer") && soccerCount > 0 && (
          <div className="halftone-bg halftone-dense bg-gradient-to-r from-emerald-500/15 to-[#0052FF]/15 rounded-xl border border-emerald-500/20 p-4 mb-5">
            <div className="flex items-center gap-3">
              <span className="text-3xl">🏆</span>
              <div>
                <p className="text-sm font-black text-white">FIFA World Cup 2026</p>
                <p className="text-xs text-emerald-300">Live on Coinbase Predictions · USA / Canada / Mexico</p>
              </div>
              <div className="ml-auto text-right">
                <p className="text-sm font-bold text-white">{soccerCount} matches</p>
                <p className="text-[10px] text-muted-foreground">Click cards to expand research</p>
              </div>
            </div>
          </div>
        )}

        {/* Cards */}
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-52 rounded-xl" />)}
          </div>
        ) : markets.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-border rounded-xl text-muted-foreground">
            <Users className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p className="mb-3">No {activeSport || "sports"} markets available.</p>
            <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Generate Markets
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
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
              { pct: "15%", label: "Injury Advantage" },
              { pct: "15%", label: "Market Mispricing" },
              { pct: "10%", label: "Volume / Liquidity" },
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
