import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Clock, ExternalLink, AlertTriangle } from "lucide-react";

function timeUntil(expiry: string | null): string {
  if (!expiry) return "—";
  const ms = new Date(expiry).getTime() - Date.now();
  if (ms <= 0) return "Expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function confidenceColor(score: number) {
  if (score >= 8) return { ring: "#34d399", label: "STRONG BUY", labelCls: "bg-emerald-400/15 border border-emerald-400/30 text-emerald-300" };
  if (score >= 7) return { ring: "#3b82f6", label: "BUY", labelCls: "bg-blue-400/15 border border-blue-400/30 text-blue-300" };
  if (score >= 6.5) return { ring: "#fbbf24", label: "WATCH", labelCls: "bg-yellow-400/15 border border-yellow-400/30 text-yellow-300" };
  return { ring: "#6b7280", label: "MONITOR", labelCls: "bg-muted border border-border text-muted-foreground" };
}

function ConfidenceRingLarge({ score }: { score: number }) {
  const size = 96;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const filled = (score / 10) * circ;
  const { ring } = confidenceColor(score);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(228 35% 16%)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ring}
          strokeWidth={stroke} strokeDasharray={`${filled} ${circ}`} strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-black text-white">{score.toFixed(1)}</span>
        <span className="text-[8px] uppercase tracking-widest text-muted-foreground">/10</span>
      </div>
    </div>
  );
}

function DataRow({ label, value, highlight }: { label: string; value: string | React.ReactNode; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-border last:border-0">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("text-sm font-semibold text-right", highlight ? "text-white" : "text-muted-foreground")}>
        {value}
      </span>
    </div>
  );
}

function FormRow({ form, label }: { form: string[]; label: string }) {
  const wins = form.filter(r => r === "W").length;
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-border last:border-0">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label} Form</span>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{wins}/{form.length} wins</span>
        <div className="flex gap-0.5">
          {form.map((r, i) => (
            <span key={i} className={cn(
              "w-5 h-5 rounded text-[8px] font-black flex items-center justify-center",
              r === "W" ? "bg-emerald-400/20 text-emerald-400" :
              r === "L" ? "bg-red-400/20 text-red-400" :
              "bg-yellow-400/20 text-yellow-400"
            )}>{r}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ScoreBar({ label, value, max = 10 }: { label: string; value: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = pct >= 70 ? "#34d399" : pct >= 45 ? "#3b82f6" : "#f59e0b";
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className="text-[11px] font-bold text-white">{value.toFixed(1)}/10</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

export default function SignalDetail() {
  const { id } = useParams<{ id: string }>();
  const [timeStr, setTimeStr] = useState("");

  const { data: signal, isLoading, error } = useQuery({
    queryKey: ["/api/signals", id],
    queryFn: async () => {
      const res = await fetch(`/api/signals/${id}`);
      if (!res.ok) throw new Error("Signal not found");
      return res.json();
    },
    retry: 1,
  });

  const { data: settings } = useQuery({ queryKey: ["/api/settings"] });

  useEffect(() => {
    if (signal?.market?.expirationTime) {
      const expiry = signal.market.expirationTime;
      setTimeStr(timeUntil(expiry));
      const timer = setInterval(() => setTimeStr(timeUntil(expiry)), 1000);
      return () => clearInterval(timer);
    }
  }, [signal?.market?.expirationTime]);

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  if (!signal || error) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center space-y-4">
        <p className="text-4xl">📊</p>
        <p className="text-white font-semibold">Signal not available</p>
        <p className="text-sm text-muted-foreground">This signal may have been refreshed. Return to the dashboard for the latest picks.</p>
        <Link href="/">
          <Button variant="outline" className="mt-2">← Back to Daily Picks</Button>
        </Link>
      </div>
    );
  }

  const s = signal;
  const market = s.market;
  const sup = s.supportingDataJson as any ?? {};
  const isCrypto = market?.category === "crypto";
  const isSports = market?.category === "sports";
  const { label: confidenceLabel, labelCls } = confidenceColor(s.confidenceScore);
  const bankroll = (settings as any)?.bankrollAmount ?? 1000;
  const maxBet = parseFloat(((s.maxBetPct / 100) * bankroll).toFixed(2));
  const yesPrice = parseFloat(String(s.yesPrice ?? 0.5));
  const noPrice = parseFloat(String(s.noPrice ?? 0.5));
  const contractPrice = s.recommendedSide === "YES" ? yesPrice : noPrice;
  const scoreBreakdown: Record<string, number> = sup.scoreBreakdown ?? {};
  const startTime = sup.startTime ? new Date(sup.startTime) : null;

  return (
    <div className="min-h-full">
      {/* Hero banner */}
      <div className="halftone-bg bg-[#0052FF] px-5 py-7 md:px-10">
        <div className="max-w-3xl mx-auto">
          <Link href="/" className="inline-flex items-center gap-1.5 text-blue-200 hover:text-white text-xs font-medium mb-5 transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Daily Picks
          </Link>
          <div className="flex items-start gap-5">
            <ConfidenceRingLarge score={s.confidenceScore} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className="text-[9px] font-bold uppercase tracking-widest bg-white/15 text-white px-2 py-1 rounded">
                  #{s.rankToday} Pick Today
                </span>
                <span className={cn("text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded", labelCls)}>
                  {confidenceLabel}
                </span>
                {isCrypto && <span className="text-[9px] font-bold text-blue-200 uppercase tracking-wider">{market.asset} 15m</span>}
                {isSports && <span className="text-[9px] font-bold text-blue-200 uppercase tracking-wider">{market.sport}</span>}
              </div>
              <h1 className="text-base md:text-lg font-black text-white leading-tight mb-2">{market?.title}</h1>
              <div className="flex items-center gap-3 text-blue-200 text-xs flex-wrap">
                <span>Side: <strong className={s.recommendedSide === "YES" ? "text-emerald-300" : "text-red-300"}>{s.recommendedSide}</strong></span>
                <span>·</span>
                <span>Edge: <strong className="text-white">+{s.edgeScore}%</strong></span>
                {startTime && <><span>·</span><span>Starts: <strong className="text-white">{startTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</strong></span></>}
                <span>·</span>
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {timeStr || timeUntil(market?.expirationTime)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 md:px-6 py-5 space-y-4">

        {/* Signal analysis */}
        <div className="p-5 rounded-xl border border-[#0052FF]/25 bg-[#0052FF]/5">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-[#4D8FFF] mb-3">Why This Pick</h2>
          <p className="text-sm text-white leading-relaxed">{s.reasoning}</p>
        </div>

        {/* Score breakdown */}
        {Object.keys(scoreBreakdown).length > 0 && (
          <div className="p-5 rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Score Breakdown</h2>
              <span className="text-lg font-black text-white">{s.confidenceScore}/10</span>
            </div>
            {Object.entries(scoreBreakdown).map(([label, val]) => (
              <ScoreBar key={label} label={label} value={val} />
            ))}
          </div>
        )}

        {/* Key metrics grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Confidence", value: `${s.confidenceScore}/10`, color: "text-white" },
            { label: "Edge", value: `+${s.edgeScore}%`, color: "text-emerald-400" },
            { label: "Risk", value: s.riskScore <= 3 ? "LOW" : s.riskScore <= 6 ? "MEDIUM" : "HIGH",
              color: s.riskScore <= 3 ? "text-emerald-400" : s.riskScore <= 6 ? "text-yellow-400" : "text-red-400" },
            { label: "Max Bet", value: s.maxBetPct > 0 ? `${s.maxBetPct}%` : "Watch", color: "text-[#4D8FFF]" },
          ].map(({ label, value, color }) => (
            <div key={label} className="p-4 rounded-xl bg-card border border-border text-center">
              <p className="text-[9px] uppercase tracking-widest text-muted-foreground mb-1">{label}</p>
              <p className={cn("text-xl font-black", color)}>{value}</p>
            </div>
          ))}
        </div>

        {/* Contract prices */}
        <div className="p-5 rounded-xl border border-border bg-card">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-4">Contract Prices</h2>
          <div className="grid grid-cols-2 gap-3">
            <div className={cn("p-4 rounded-xl text-center border", s.recommendedSide === "YES" ? "border-emerald-400/40 bg-emerald-400/5" : "border-border bg-muted/10")}>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">YES</p>
              <p className="text-3xl font-black text-emerald-400 font-mono">{(yesPrice * 100).toFixed(0)}¢</p>
              <p className="text-[10px] text-muted-foreground mt-1">{(yesPrice * 100).toFixed(0)}% implied</p>
              {s.recommendedSide === "YES" && (
                <div className="mt-2 text-[9px] font-bold text-emerald-400 uppercase tracking-wider">← Recommended</div>
              )}
            </div>
            <div className={cn("p-4 rounded-xl text-center border", s.recommendedSide === "NO" ? "border-red-400/40 bg-red-400/5" : "border-border bg-muted/10")}>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">NO</p>
              <p className="text-3xl font-black text-red-400 font-mono">{(noPrice * 100).toFixed(0)}¢</p>
              <p className="text-[10px] text-muted-foreground mt-1">{(noPrice * 100).toFixed(0)}% implied</p>
              {s.recommendedSide === "NO" && (
                <div className="mt-2 text-[9px] font-bold text-red-400 uppercase tracking-wider">← Recommended</div>
              )}
            </div>
          </div>
        </div>

        {/* Crypto technical data */}
        {isCrypto && Object.keys(sup).length > 0 && (
          <div className="p-5 rounded-xl border border-border bg-card">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-4">Technical Data</h2>
            <DataRow label="Spot Price" value={`$${parseFloat(String(sup.spotPrice ?? 0)).toLocaleString()}`} highlight />
            <DataRow label="Target Price" value={`$${parseFloat(String(sup.targetPrice ?? 0)).toLocaleString()}`} highlight />
            <DataRow label="RSI (15m)" value={String(sup.rsi ?? "—")}
              highlight={parseFloat(String(sup.rsi)) > 65 || parseFloat(String(sup.rsi)) < 35} />
            <DataRow label="5m Momentum" value={`${(parseFloat(String(sup.momentum5m ?? 0.5)) * 100).toFixed(0)}%`} />
            <DataRow label="Volume Change" value={
              parseFloat(String(sup.volumeChange ?? 1)) > 1
                ? `+${((parseFloat(String(sup.volumeChange)) - 1) * 100).toFixed(0)}%`
                : `${((parseFloat(String(sup.volumeChange ?? 1)) - 1) * 100).toFixed(0)}%`
            } />
            <DataRow label="Trend" value={sup.trendUp ? "▲ Bullish" : "▼ Bearish"} />
            <DataRow label="VWAP" value={`$${parseFloat(String(sup.vwap ?? 0)).toLocaleString()}`} />
            <DataRow label="Model Probability" value={`${(parseFloat(String(sup.modelProbability ?? 0.5)) * 100).toFixed(1)}%`} highlight />
            <DataRow label="Contract Price" value={`${(contractPrice * 100).toFixed(0)}¢`} highlight />
          </div>
        )}

        {/* Sports research panel */}
        {isSports && (
          <div className="p-5 rounded-xl border border-border bg-card">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-4">Research Panel</h2>
            {sup.event && <DataRow label="Event" value={sup.event} highlight />}
            {startTime && <DataRow label="Kickoff / Start" value={startTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", weekday: "short" })} highlight />}
            <DataRow label="Coinbase Implied" value={`${(parseFloat(String(sup.coinbaseImpliedProb ?? 0.5)) * 100).toFixed(1)}%`} />
            <DataRow label="External Books Consensus" value={`${(parseFloat(String(sup.externalOdds ?? 0.5)) * 100).toFixed(1)}%`} highlight />
            <DataRow label="Edge vs Market" value={`+${(parseFloat(String(sup.edge ?? 0)) * 100).toFixed(1)}%`} highlight />
            <DataRow label="Market Volume" value={`$${((Number(sup.marketVolume ?? 0)) / 1000).toFixed(0)}k`} />
            {sup.homeTeam && sup.homeForm && <FormRow form={sup.homeForm} label={sup.homeTeam} />}
            {sup.awayTeam && sup.awayForm && <FormRow form={sup.awayForm} label={sup.awayTeam} />}
            {sup.headToHead && <DataRow label="Head to Head" value={sup.headToHead} />}
            {Array.isArray(sup.injuries) && sup.injuries.length > 0 && (
              <div className="pt-3">
                <p className="text-[9px] uppercase tracking-wider text-orange-400 font-bold mb-2">⚠ Injury Report</p>
                {(sup.injuries as string[]).map((inj: string, i: number) => (
                  <p key={i} className="text-xs text-orange-200/80 mb-1">• {inj}</p>
                ))}
              </div>
            )}
            {sup.context && (
              <div className="mt-3 pt-3 border-t border-border">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-2">Analyst Context</p>
                <p className="text-xs text-white/80 leading-relaxed">{sup.context}</p>
              </div>
            )}
          </div>
        )}

        {/* Bankroll sizing */}
        {s.maxBetPct > 0 && (
          <div className="p-5 rounded-xl border border-[#0052FF]/25 bg-[#0052FF]/5">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-[#4D8FFF] mb-3">Suggested Bet Sizing</h2>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="text-2xl font-black text-white">{s.maxBetPct}% bankroll</p>
                <p className="text-sm text-muted-foreground">= <strong className="text-white">${maxBet}</strong> of your ${bankroll.toLocaleString()} bankroll</p>
              </div>
              <div className={cn(
                "text-[10px] font-bold px-3 py-2 rounded-lg uppercase tracking-wider",
                s.confidenceScore >= 9 ? "bg-emerald-400/20 text-emerald-300" :
                s.confidenceScore >= 8 ? "bg-blue-400/20 text-blue-300" : "bg-yellow-400/20 text-yellow-300"
              )}>
                {s.confidenceScore >= 9 ? "Max 3% — Score 9+" :
                 s.confidenceScore >= 8 ? "Max 2% — Score 8+" :
                 s.confidenceScore >= 7 ? "Max 1% — Score 7+" : "Watchlist Only"}
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-3">
              Update your bankroll in{" "}
              <Link href="/settings" className="text-[#4D8FFF] underline">Settings</Link>
              {" "}to see personalized sizing.
            </p>
          </div>
        )}

        {/* CTA */}
        <a href="https://www.coinbase.com/predictions" target="_blank" rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 py-3.5 rounded-xl bg-[#0052FF] hover:bg-[#0041CC] text-white font-bold text-sm transition-colors w-full" data-testid="link-coinbase">
          <ExternalLink className="w-4 h-4" />
          View on Coinbase Predictions
        </a>

        {/* Disclaimer */}
        <div className="p-4 rounded-xl border border-yellow-400/20 bg-yellow-400/5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 shrink-0 mt-0.5" />
            <p className="text-[10px] text-yellow-200/60 leading-relaxed">
              <strong className="text-yellow-300">Research only.</strong> Generated by a quantitative model using public market data. Prediction contracts can expire worthless. Past accuracy does not guarantee future results. Always bet responsibly.
            </p>
          </div>
        </div>

      </div>
    </div>
  );
}
