import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Radio,
  Brain,
  ChevronUp,
  ChevronDown,
  Activity,
  CircleDot,
  Zap,
  Signal,
  Bot,
  Users,
  Waves,
  Clock,
  AlertTriangle,
  ShieldCheck,
  Bitcoin,
} from "lucide-react";
import type { Signal as SignalType } from "@shared/schema";
import type { SignalCondition } from "@shared/indicators";
import { usePageSEO } from "@/lib/seo";
import { useLivePrice } from "@/lib/ws-context";

type TritonSignal = {
  side: string;
  regime: string;
  activeMode: string;
  htfBias: string;
  score: number;
  scoreBreakdown?: {
    ema: number; rsi: number; macd: number; volume: number; htf: number; penalty: number; sentiment?: number; btcOverlay?: number; total: number;
  };
  threshold?: number;
  rr: number;
  sizeMultiplier: number;
  reasons: string[];
  entry: number;
  stop: number;
  takeProfit: number;
};

type SignalReasoning = {
  available: boolean;
  signal?: string;
  side?: string;
  reason?: string;
  longScore?: number;
  shortScore?: number;
  conditions?: SignalCondition[];
  indicators?: {
    rsi: number;
    connorsRsi: number;
    ema20: number;
    dema20: number;
    tema20: number;
    rsiDivergence: { bullish: boolean; bearish: boolean };
    vol24h: number;
  };
  readiness?: {
    scoreReadinessPct: number;
    threshold: number;
    score: number;
    rrReadinessPct: number;
    minRr: number;
    currentRr: number;
    regime: string;
    blockingChecks: string[];
  } | null;
  triton?: TritonSignal | null;
};

function SignalBadge({ signal, size = "default" }: { signal: string; size?: "default" | "lg" }) {
  const config: Record<string, { variant: string; icon: React.ReactNode; label: string }> = {
    strong_long: { variant: "default", icon: <TrendingUp className={size === "lg" ? "h-4 w-4" : "h-3 w-3"} />, label: "Strong Long" },
    weak_long: { variant: "default", icon: <ArrowUpRight className={size === "lg" ? "h-4 w-4" : "h-3 w-3"} />, label: "Weak Long" },
    strong_short: { variant: "destructive", icon: <TrendingDown className={size === "lg" ? "h-4 w-4" : "h-3 w-3"} />, label: "Strong Short" },
    weak_short: { variant: "destructive", icon: <ArrowDownRight className={size === "lg" ? "h-4 w-4" : "h-3 w-3"} />, label: "Weak Short" },
    no_trade: { variant: "secondary", icon: <Minus className={size === "lg" ? "h-4 w-4" : "h-3 w-3"} />, label: "No Trade" },
  };
  const c = config[signal] || config.no_trade;
  return (
    <Badge variant={c.variant as any} className={size === "lg" ? "text-sm gap-1.5 py-1 px-3" : ""} data-testid={`badge-signal-${signal}`}>
      {c.icon}
      <span className="ml-1">{c.label}</span>
    </Badge>
  );
}

function ConditionCard({ condition, index }: { condition: SignalCondition; index: number }) {
  const dirConfig = {
    long: {
      bg: "bg-emerald-500/10 border-emerald-500/20",
      text: "text-emerald-500",
      glow: "shadow-emerald-500/5",
      label: "LONG",
      icon: <ChevronUp className="h-4 w-4 text-emerald-500" />,
    },
    short: {
      bg: "bg-red-500/10 border-red-500/20",
      text: "text-red-500",
      glow: "shadow-red-500/5",
      label: "SHORT",
      icon: <ChevronDown className="h-4 w-4 text-red-500" />,
    },
    neutral: {
      bg: "bg-muted/50 border-border/50",
      text: "text-muted-foreground",
      glow: "",
      label: "NEUTRAL",
      icon: <Minus className="h-4 w-4 text-muted-foreground" />,
    },
  };

  const cfg = dirConfig[condition.direction];
  const isActive = condition.met;

  return (
    <div
      className={`rounded-md border p-3 transition-all duration-300 ${isActive ? cfg.bg : "bg-card border-border/30 opacity-60"} ${isActive ? cfg.glow : ""}`}
      style={{ animationDelay: `${index * 80}ms` }}
      data-testid={`condition-${condition.name.replace(/\s+/g, '-').toLowerCase()}`}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${isActive ? (condition.direction === "long" ? "bg-emerald-500" : condition.direction === "short" ? "bg-red-500" : "bg-muted-foreground/50") : "bg-muted-foreground/20"}`} />
          <span className={`text-xs font-semibold truncate ${isActive ? "text-foreground" : "text-muted-foreground"}`}>{condition.name}</span>
        </div>
        <Badge
          variant={condition.direction === "long" ? "default" : condition.direction === "short" ? "destructive" : "secondary"}
          className="text-[9px] shrink-0"
        >
          {cfg.label}
        </Badge>
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed mb-2">{condition.description}</p>
      <div className="flex items-center justify-between gap-2 text-[10px] font-mono">
        <span className={isActive ? cfg.text : "text-muted-foreground/60"}>
          {condition.value}
        </span>
        <span className="text-muted-foreground/50">
          {condition.threshold}
        </span>
      </div>
    </div>
  );
}

function ScoreVisualization({ longScore, shortScore, totalConditions }: { longScore: number; shortScore: number; totalConditions: number }) {
  const neutralCount = totalConditions - longScore - shortScore;
  const longPct = (longScore / totalConditions) * 100;
  const shortPct = (shortScore / totalConditions) * 100;
  const neutralPct = (neutralCount / totalConditions) * 100;

  const dominantSide = longScore > shortScore ? "long" : shortScore > longScore ? "short" : "neutral";
  const dominantScore = Math.max(longScore, shortScore);
  const strength = dominantScore >= 4 ? "Strong" : dominantScore >= 3 ? "Moderate" : "Weak";

  return (
    <div className="space-y-4" data-testid="signal-score-visualization">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center">
            <Brain className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Signal Strength</p>
            <p className={`text-sm font-bold ${dominantSide === "long" ? "text-emerald-500" : dominantSide === "short" ? "text-red-500" : "text-muted-foreground"}`}>
              {strength} {dominantSide === "neutral" ? "Mixed" : dominantSide === "long" ? "Bullish" : "Bearish"}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold font-mono" data-testid="text-signal-score">L{longScore}/S{shortScore}</p>
          <p className="text-[10px] text-muted-foreground">{totalConditions} conditions</p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex gap-1 h-3 rounded-full overflow-hidden bg-muted/30" data-testid="signal-score-bar">
          {longScore > 0 && (
            <div
              className="bg-emerald-500 rounded-full transition-all duration-700 ease-out"
              style={{ width: `${longPct}%` }}
            />
          )}
          {neutralCount > 0 && (
            <div
              className="bg-muted-foreground/20 rounded-full transition-all duration-700 ease-out"
              style={{ width: `${neutralPct}%` }}
            />
          )}
          {shortScore > 0 && (
            <div
              className="bg-red-500 rounded-full transition-all duration-700 ease-out"
              style={{ width: `${shortPct}%` }}
            />
          )}
        </div>
        <div className="flex items-center justify-between text-[10px]">
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-muted-foreground">Long ({longScore})</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-muted-foreground/20" />
            <span className="text-muted-foreground">Neutral ({neutralCount})</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-red-500" />
            <span className="text-muted-foreground">Short ({shortScore})</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentBroadcastStatus() {
  const { data: agents } = useQuery<any[]>({
    queryKey: ["/api/agents"],
    refetchInterval: 10000,
  });

  const runningAgents = (agents || []).filter((a: any) => a.status === "running");

  if (!agents || agents.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="agent-broadcast-status">
      <div className="flex items-center gap-2">
        <Signal className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium">Signal Broadcast</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {agents.map((agent: any) => (
          <div
            key={agent.id}
            className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs ${
              agent.status === "running"
                ? "border-emerald-500/20 bg-emerald-500/5"
                : "border-border/30 opacity-60"
            }`}
            data-testid={`broadcast-agent-${agent.id}`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Bot className={`h-3 w-3 shrink-0 ${agent.status === "running" ? "text-primary" : "text-muted-foreground"}`} />
              <span className="truncate font-medium">{agent.name}</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {agent.status === "running" && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              )}
              <Badge variant={agent.status === "running" ? "default" : "secondary"} className="text-[8px]">
                {agent.status}
              </Badge>
            </div>
          </div>
        ))}
      </div>
      {runningAgents.length > 0 && (
        <p className="text-[10px] text-emerald-500/80 flex items-center gap-1">
          <Zap className="h-3 w-3" />
          {runningAgents.length} agent{runningAgents.length > 1 ? "s" : ""} receiving live signals for auto-execution
        </p>
      )}
    </div>
  );
}

type SentimentData = {
  symbol: string;
  tapeScore: number;
  crowdingScore: number;
  fundingPressureScore: number;
  oiExpansionScore: number;
  confidence: number;
  regime: string;
  dataAge: number;
  trendFollowBias: string;
  contrarianBias: string;
  notes: string[];
  updatedAt: number;
  typus?: {
    tapeBuyCount: number;
    tapeSellCount: number;
    tapeBuyNotionalSui: number;
    tapeSellNotionalSui: number;
    largestBuy: number;
    largestSell: number;
  };
  zo?: {
    oiLongPct: number;
    oiShortPct: number;
    netRateLong: number;
    netRateShort: number;
    oiLongUsd: number;
    oiShortUsd: number;
  };
};

function sentimentRegimeStyle(regime: string): string {
  switch (regime) {
    case "momentum_continuation": return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
    case "exhaustion": return "bg-amber-500/20 text-amber-400 border-amber-500/30";
    case "contrarian_squeeze": return "bg-violet-500/20 text-violet-400 border-violet-500/30";
    default: return "bg-muted/40 text-muted-foreground border-border/30";
  }
}

function sentimentRegimeLabel(regime: string): string {
  switch (regime) {
    case "momentum_continuation": return "Momentum";
    case "exhaustion": return "Exhaustion";
    case "contrarian_squeeze": return "Squeeze";
    default: return "Neutral";
  }
}

function TapeBar({ buyPct, sellPct }: { buyPct: number; sellPct: number }) {
  return (
    <div className="space-y-0.5">
      <div className="flex h-2 rounded-full overflow-hidden gap-px">
        <div className="bg-emerald-500/80 transition-all duration-700" style={{ width: `${buyPct}%` }} />
        <div className="bg-red-500/70 transition-all duration-700" style={{ width: `${sellPct}%` }} />
      </div>
      <div className="flex justify-between text-[9px] font-mono text-muted-foreground">
        <span className="text-emerald-400">L {buyPct.toFixed(0)}%</span>
        <span className="text-red-400">S {sellPct.toFixed(0)}%</span>
      </div>
    </div>
  );
}

function CrowdingGauge({ score }: { score: number }) {
  const color = score > 75 ? "bg-red-500/80" : score > 60 ? "bg-amber-500/80" : score > 40 ? "bg-teal-500/80" : "bg-blue-500/80";
  const label = score > 75 ? "Overcrowded" : score > 60 ? "Crowded" : score > 40 ? "Moderate" : "Light";
  return (
    <div className="space-y-0.5">
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${score}%` }} />
      </div>
      <div className="flex justify-between text-[9px] font-mono text-muted-foreground">
        <span>{label}</span>
        <span>{score}/100</span>
      </div>
    </div>
  );
}

// ─── BTC Correlation Overlay Panel ─────────────────────────────────────────

interface BtcOverlay {
  btcPrice: number;
  change5m: number;
  change15m: number;
  change60m: number;
  direction5m: "UP" | "DOWN" | "FLAT";
  direction15m: "UP" | "DOWN" | "FLAT";
  direction60m: "UP" | "DOWN" | "FLAT";
  bias: "bull" | "bear" | "neutral";
  strength: number;
  agreementScore: number;
  usable: boolean;
  dataAge: number;
  note: string;
}

interface BtcOverlayData {
  overlay: BtcOverlay | null;
  history: Array<{ timestamp: number; price: number }>;
}

function BtcSparkline({ history }: { history: Array<{ timestamp: number; price: number }> }) {
  if (history.length < 2) {
    return <div className="h-10 w-full flex items-center justify-center text-[9px] text-muted-foreground">collecting data…</div>;
  }
  const prices = history.map(p => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const W = 200, H = 36;
  const points = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * W;
    const y = H - ((p - min) / range) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const first = prices[0];
  const last = prices[prices.length - 1];
  const color = last > first ? "#34d399" : last < first ? "#f87171" : "#6b7280";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-10" preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={((prices.length - 1) / (prices.length - 1)) * W}
        cy={H - ((last - min) / range) * H}
        r="2"
        fill={color}
      />
    </svg>
  );
}

function btcBiasStyle(bias: string): string {
  if (bias === "bull") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (bias === "bear") return "bg-red-500/15 text-red-400 border-red-500/30";
  return "bg-muted/30 text-muted-foreground border-border";
}

function btcBiasLabel(bias: string): string {
  if (bias === "bull") return "Bullish";
  if (bias === "bear") return "Bearish";
  return "Neutral";
}

interface SuiOverlay {
  suiPrice: number;
  change5m: number;
  change15m: number;
  change60m: number;
  direction5m: "UP" | "DOWN" | "FLAT";
  direction15m: "UP" | "DOWN" | "FLAT";
  direction60m: "UP" | "DOWN" | "FLAT";
  bias: "bull" | "bear" | "neutral";
  strength: number;
  agreementScore: number;
  usable: boolean;
  dataAge: number;
  note: string;
}

interface SuiOverlayData {
  overlay: SuiOverlay | null;
  history: Array<{ timestamp: number; price: number }>;
}

function DirIcon({ dir }: { dir: "UP" | "DOWN" | "FLAT" }) {
  if (dir === "UP") return <TrendingUp className="h-3 w-3 text-emerald-400" />;
  if (dir === "DOWN") return <TrendingDown className="h-3 w-3 text-red-400" />;
  return <Minus className="h-3 w-3 text-muted-foreground" />;
}

function suiBiasStyle(bias: string): string {
  if (bias === "bull") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (bias === "bear") return "bg-red-500/15 text-red-400 border-red-500/30";
  return "bg-muted/30 text-muted-foreground border-border";
}

function suiBiasLabel(bias: string): string {
  if (bias === "bull") return "Bullish";
  if (bias === "bear") return "Bearish";
  return "Neutral";
}

function SuiSparkline({ history }: { history: Array<{ timestamp: number; price: number }> }) {
  if (history.length < 2) {
    return <div className="h-10 w-full flex items-center justify-center text-[9px] text-muted-foreground">collecting data…</div>;
  }
  const prices = history.map(p => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 0.001;
  const W = 200, H = 36;
  const points = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * W;
    const y = H - ((p - min) / range) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const first = prices[0];
  const last = prices[prices.length - 1];
  const color = last > first ? "#34d399" : last < first ? "#f87171" : "#6b7280";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-10" preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={((prices.length - 1) / (prices.length - 1)) * W}
        cy={H - ((last - min) / range) * H}
        r="2"
        fill={color}
      />
    </svg>
  );
}

function SuiOverlayPanel() {
  const { data, isLoading } = useQuery<SuiOverlayData>({
    queryKey: ["/api/market/sui-overlay"],
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <Card data-testid="card-sui-overlay-loading">
        <CardContent className="pt-4">
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  const overlay = data?.overlay;
  const history = data?.history ?? [];
  const hasNoOverlay = !overlay;
  const isStale = overlay ? overlay.dataAge > 3 * 60_000 : true;
  const dataAgeMin = overlay ? Math.floor(overlay.dataAge / 60_000) : 0;

  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}%`;
  const pctColor = (v: number) => v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-muted-foreground";

  return (
    <Card data-testid="card-sui-overlay">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
              <Activity className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-xs font-medium">SUI Momentum Overlay</CardTitle>
              <p className="text-[9px] text-muted-foreground leading-tight">Multi-TF SUI self-momentum → signal modifier</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge
              variant="outline"
              className={`text-[9px] px-1.5 py-0 ${overlay ? suiBiasStyle(overlay.bias) : "bg-muted/30 text-muted-foreground border-border"}`}
              data-testid="badge-sui-bias"
            >
              {overlay ? suiBiasLabel(overlay.bias) : "—"}
            </Badge>
            <span className="text-[9px] text-muted-foreground font-mono" data-testid="text-sui-age">
              {hasNoOverlay ? "—" : isStale ? `${dataAgeMin}m (stale)` : `${dataAgeMin}m ago`}
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0 pb-3 space-y-2.5">
        {hasNoOverlay ? (
          <div className="flex flex-col items-center justify-center py-4 gap-2 text-muted-foreground">
            <Activity className="h-5 w-5 opacity-30" />
            <p className="text-[11px] text-center">Starting SUI momentum collection…</p>
          </div>
        ) : (
          <>
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[10px] text-muted-foreground">SUI Price (Pyth)</p>
                <p className="text-lg font-mono font-bold text-primary" data-testid="text-sui-price">
                  ${overlay!.suiPrice.toFixed(4)}
                </p>
              </div>
              <div className="flex-1">
                <SuiSparkline history={history} />
              </div>
            </div>

            <div className="space-y-1">
              <div className="grid grid-cols-3 gap-1">
                {[
                  { label: "5m", dir: overlay!.direction5m, chg: overlay!.change5m },
                  { label: "15m", dir: overlay!.direction15m, chg: overlay!.change15m },
                  { label: "1h", dir: overlay!.direction60m, chg: overlay!.change60m },
                ].map(({ label, dir, chg }) => (
                  <div key={label} className="rounded-md border border-border/30 px-2 py-1.5 flex flex-col items-center gap-0.5" data-testid={`stat-sui-${label}`}>
                    <span className="text-[9px] text-muted-foreground font-mono">{label}</span>
                    <DirIcon dir={dir} />
                    <span className={`text-[9px] font-mono font-medium ${pctColor(chg)}`}>{fmtPct(chg)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <div data-testid="bar-sui-strength">
                <div className="flex justify-between text-[9px] font-mono text-muted-foreground mb-0.5">
                  <span>Momentum Strength</span>
                  <span>{overlay!.strength}/100</span>
                </div>
                <div className="h-1 rounded-full bg-muted/30 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${overlay!.bias === "bull" ? "bg-emerald-500" : overlay!.bias === "bear" ? "bg-red-500" : "bg-muted"}`}
                    style={{ width: `${Math.max(overlay!.strength, 0)}%` }}
                  />
                </div>
              </div>
              <div data-testid="bar-sui-agreement">
                <div className="flex justify-between text-[9px] font-mono text-muted-foreground mb-0.5">
                  <span>TF Agreement</span>
                  <span>{overlay!.agreementScore.toFixed(0)}%</span>
                </div>
                <div className="h-1 rounded-full bg-muted/30 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${Math.max(overlay!.agreementScore, 0)}%` }}
                  />
                </div>
              </div>
            </div>

            <div className="rounded-md bg-muted/10 border border-border/20 px-3 py-2 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">Signal modifier range</span>
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-mono text-red-400">−7pt</span>
                <span className="text-[9px] text-muted-foreground">↔</span>
                <span className="text-[10px] font-mono text-emerald-400">+8pt</span>
              </div>
            </div>

            <p className="text-[10px] text-muted-foreground text-center px-2" data-testid="text-sui-note">{overlay!.note}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BtcOverlayPanel() {
  const { data, isLoading } = useQuery<BtcOverlayData>({
    queryKey: ["/api/market/btc-overlay"],
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <Card data-testid="card-btc-overlay-loading">
        <CardContent className="pt-4">
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  const overlay = data?.overlay;
  const history = data?.history ?? [];
  const hasNoOverlay = !overlay;
  const isWarmingUp = overlay && !overlay.usable;
  const isActive = overlay && overlay.usable;
  const isStale = overlay ? overlay.dataAge > 3 * 60_000 : true;
  const dataAgeMin = overlay ? Math.floor(overlay.dataAge / 60_000) : 0;

  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}%`;
  const pctColor = (v: number) => v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-muted-foreground";

  return (
    <Card data-testid="card-btc-overlay">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-amber-500/10 flex items-center justify-center">
              <Bitcoin className="h-3.5 w-3.5 text-amber-400" />
            </div>
            <div>
              <CardTitle className="text-xs font-medium">BTC Correlation Overlay</CardTitle>
              <p className="text-[9px] text-muted-foreground leading-tight">Multi-TF BTC momentum → SUI signal modifier</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge
              variant="outline"
              className={`text-[9px] px-1.5 py-0 ${overlay ? btcBiasStyle(overlay.bias) : "bg-muted/30 text-muted-foreground border-border"}`}
              data-testid="badge-btc-bias"
            >
              {overlay ? btcBiasLabel(overlay.bias) : "—"}
            </Badge>
            <span className="text-[9px] text-muted-foreground font-mono" data-testid="text-btc-age">
              {hasNoOverlay ? "—" : isStale ? `${dataAgeMin}m (stale)` : `${dataAgeMin}m ago`}
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0 pb-3 space-y-2.5">
        {hasNoOverlay ? (
          <div className="flex flex-col items-center justify-center py-4 gap-2 text-muted-foreground">
            <Bitcoin className="h-5 w-5 opacity-30" />
            <p className="text-[11px] text-center">Starting BTC data collection…</p>
          </div>
        ) : (
          <>
            {/* BTC Price + Sparkline */}
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[10px] text-muted-foreground">BTC Price (Pyth)</p>
                <p className="text-lg font-mono font-bold text-amber-400" data-testid="text-btc-price">
                  ${overlay!.btcPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </p>
              </div>
              <div className="flex-1">
                <BtcSparkline history={history} />
              </div>
            </div>

            {/* Timeframe momentum rows */}
            <div className="space-y-1">
              <div className="grid grid-cols-3 gap-1">
                {[
                  { label: "5m", dir: overlay!.direction5m, chg: overlay!.change5m },
                  { label: "15m", dir: overlay!.direction15m, chg: overlay!.change15m },
                  { label: "1h", dir: overlay!.direction60m, chg: overlay!.change60m },
                ].map(({ label, dir, chg }) => (
                  <div key={label} className="rounded-md border border-border/30 px-2 py-1.5 flex flex-col items-center gap-0.5" data-testid={`stat-btc-${label}`}>
                    <span className="text-[9px] text-muted-foreground font-mono">{label}</span>
                    <DirIcon dir={dir} />
                    <span className={`text-[9px] font-mono font-medium ${pctColor(chg)}`}>{fmtPct(chg)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Strength + Agreement */}
            <div className="space-y-1.5">
              <div data-testid="bar-btc-strength">
                <div className="flex justify-between text-[9px] font-mono text-muted-foreground mb-0.5">
                  <span>Momentum Strength</span>
                  <span>{overlay!.strength}/100</span>
                </div>
                <div className="h-1 rounded-full bg-muted/30 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${overlay!.bias === "bull" ? "bg-emerald-500" : overlay!.bias === "bear" ? "bg-red-500" : "bg-muted"}`}
                    style={{ width: `${Math.max(overlay!.strength, 0)}%` }}
                  />
                </div>
              </div>
              <div data-testid="bar-btc-agreement">
                <div className="flex justify-between text-[9px] font-mono text-muted-foreground mb-0.5">
                  <span>TF Agreement</span>
                  <span>{overlay!.agreementScore.toFixed(0)}%</span>
                </div>
                <div className="h-1 rounded-full bg-muted/30 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-amber-400 transition-all"
                    style={{ width: `${Math.max(overlay!.agreementScore, 0)}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Signal impact summary */}
            <div className="rounded-md bg-muted/10 border border-border/20 px-3 py-2 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">Signal modifier range</span>
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-mono text-red-400">−8pt</span>
                <span className="text-[9px] text-muted-foreground">↔</span>
                <span className="text-[10px] font-mono text-emerald-400">+10pt</span>
              </div>
            </div>

            {/* Note */}
            <p className="text-[10px] text-muted-foreground text-center px-2" data-testid="text-btc-note">{overlay!.note}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SentimentFlowPanel() {
  const { data: sentiment, isLoading } = useQuery<SentimentData>({
    queryKey: ["/api/market/sentiment"],
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <Card data-testid="card-sentiment-loading">
        <CardContent className="pt-4">
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  const isStale = !sentiment || (sentiment.dataAge > 5 * 60_000) || sentiment.confidence === 0;
  const noData = !sentiment || sentiment.confidence === 0;

  const tape = sentiment?.typus;
  const zo = sentiment?.zo;

  const totalTapeNotional = tape ? tape.tapeBuyNotionalSui + tape.tapeSellNotionalSui : 0;
  const buyPct = tape && totalTapeNotional > 0 ? (tape.tapeBuyNotionalSui / totalTapeNotional) * 100 : 50;
  const sellPct = 100 - buyPct;

  const oiLongPct = zo?.oiLongPct ?? 50;
  const oiShortPct = zo?.oiShortPct ?? 50;

  const tapeScore = sentiment?.tapeScore ?? 0;
  const crowdingScore = sentiment?.crowdingScore ?? 50;
  const fundingScore = sentiment?.fundingPressureScore ?? 0;

  const dataAgeMin = sentiment ? Math.floor(sentiment.dataAge / 60_000) : 0;

  return (
    <Card data-testid="card-sentiment-flow">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-violet-500/10 flex items-center justify-center">
              <Waves className="h-3.5 w-3.5 text-violet-400" />
            </div>
            <div>
              <CardTitle className="text-xs font-medium">SentimentFlow Engine</CardTitle>
              <p className="text-[10px] text-muted-foreground">Crowd intelligence — Typus tape + OI</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {sentiment && (
              <Badge
                variant="outline"
                className={`text-[9px] px-1.5 py-0 ${sentimentRegimeStyle(sentiment.regime)}`}
                data-testid="badge-sentiment-regime"
              >
                {sentimentRegimeLabel(sentiment.regime)}
              </Badge>
            )}
            <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span data-testid="text-sentiment-age">{noData ? "—" : `${dataAgeMin}m ago`}</span>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {noData ? (
          <div className="flex flex-col items-center justify-center py-4 gap-2 text-muted-foreground">
            <Activity className="h-5 w-5 opacity-40" />
            <p className="text-[11px]">Collecting market data — polling in 15s</p>
            {sentiment?.notes?.[0] && (
              <p className="text-[10px] opacity-70 text-center px-4">{sentiment.notes[0]}</p>
            )}
          </div>
        ) : (
          <>
            {/* Tape flow: Typus CreateTradingOrderEvent aggregation */}
            {tape && (
              <div className="space-y-1.5" data-testid="section-tape-flow">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground uppercase font-medium flex items-center gap-1">
                    <Activity className="h-3 w-3" />
                    Typus Tape Flow
                  </span>
                  <span className="text-[9px] text-muted-foreground font-mono">
                    {tape.tapeBuyCount}↑ / {tape.tapeSellCount}↓ opens
                  </span>
                </div>
                <TapeBar buyPct={buyPct} sellPct={sellPct} />
                <div className="flex justify-between text-[9px] text-muted-foreground font-mono">
                  <span>{tape.tapeBuyNotionalSui.toFixed(1)} SUI long</span>
                  <span className="font-semibold" style={{ color: tapeScore > 10 ? "rgb(52,211,153)" : tapeScore < -10 ? "rgb(248,113,113)" : "" }}>
                    Score {tapeScore > 0 ? "+" : ""}{tapeScore.toFixed(0)}
                  </span>
                  <span>{tape.tapeSellNotionalSui.toFixed(1)} SUI short</span>
                </div>
              </div>
            )}

            {/* ZO OI / Funding */}
            {zo && (
              <div className="space-y-1.5" data-testid="section-oi-data">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground uppercase font-medium flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    Open Interest
                  </span>
                  <span className="text-[9px] text-muted-foreground font-mono">
                    ${((zo.oiLongUsd + zo.oiShortUsd) / 1000).toFixed(0)}K total
                  </span>
                </div>
                <div className="space-y-0.5">
                  <div className="flex h-2 rounded-full overflow-hidden gap-px">
                    <div className="bg-emerald-500/80 transition-all duration-700" style={{ width: `${oiLongPct}%` }} />
                    <div className="bg-red-500/70 transition-all duration-700" style={{ width: `${oiShortPct}%` }} />
                  </div>
                  <div className="flex justify-between text-[9px] font-mono text-muted-foreground">
                    <span className="text-emerald-400">Long {oiLongPct.toFixed(1)}%</span>
                    <span className="text-red-400">Short {oiShortPct.toFixed(1)}%</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1 mt-1">
                  <div className="rounded bg-muted/30 px-2 py-1 text-center">
                    <p className="text-[9px] text-muted-foreground">Net Rate (L)</p>
                    <p className={`text-[10px] font-mono font-bold ${zo.netRateLong > 0 ? "text-amber-400" : "text-emerald-400"}`} data-testid="text-net-rate-long">
                      {zo.netRateLong > 0 ? "+" : ""}{(zo.netRateLong * 100).toFixed(4)}%
                    </p>
                  </div>
                  <div className="rounded bg-muted/30 px-2 py-1 text-center">
                    <p className="text-[9px] text-muted-foreground">Net Rate (S)</p>
                    <p className={`text-[10px] font-mono font-bold ${zo.netRateShort < 0 ? "text-amber-400" : "text-emerald-400"}`} data-testid="text-net-rate-short">
                      {zo.netRateShort > 0 ? "+" : ""}{(zo.netRateShort * 100).toFixed(4)}%
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Crowding score */}
            <div className="space-y-1.5" data-testid="section-crowding">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground uppercase font-medium flex items-center gap-1">
                  {crowdingScore > 70 ? <AlertTriangle className="h-3 w-3 text-amber-400" /> : <ShieldCheck className="h-3 w-3" />}
                  Crowd Density
                </span>
                <span className="text-[9px] text-muted-foreground font-mono">confidence {sentiment.confidence}%</span>
              </div>
              <CrowdingGauge score={crowdingScore} />
            </div>

            {/* Bias summary */}
            <div className="flex items-center gap-2 pt-1 border-t border-border/20">
              <div className="flex-1 rounded bg-muted/30 px-2 py-1.5 text-center">
                <p className="text-[9px] text-muted-foreground mb-0.5">Trend Bias</p>
                <p className={`text-[11px] font-semibold capitalize ${sentiment.trendFollowBias === "long" ? "text-emerald-400" : sentiment.trendFollowBias === "short" ? "text-red-400" : "text-muted-foreground"}`} data-testid="text-trend-bias">
                  {sentiment.trendFollowBias}
                </p>
              </div>
              <div className="flex-1 rounded bg-muted/30 px-2 py-1.5 text-center">
                <p className="text-[9px] text-muted-foreground mb-0.5">Contrarian</p>
                <p className={`text-[11px] font-semibold capitalize ${sentiment.contrarianBias === "long" ? "text-emerald-400" : sentiment.contrarianBias === "short" ? "text-red-400" : "text-muted-foreground"}`} data-testid="text-contrarian-bias">
                  {sentiment.contrarianBias}
                </p>
              </div>
              <div className="flex-1 rounded bg-muted/30 px-2 py-1.5 text-center">
                <p className="text-[9px] text-muted-foreground mb-0.5">Funding</p>
                <p className={`text-[11px] font-semibold font-mono ${fundingScore > 20 ? "text-amber-400" : fundingScore < -20 ? "text-emerald-400" : "text-muted-foreground"}`} data-testid="text-funding-pressure">
                  {fundingScore > 0 ? "+" : ""}{fundingScore.toFixed(0)}
                </p>
              </div>
            </div>

            {/* Notes from engine */}
            {sentiment.notes?.length > 0 && (
              <div className="pt-1 border-t border-border/20 space-y-0.5">
                {sentiment.notes.slice(0, 2).map((note, i) => (
                  <p key={i} className="text-[9px] text-muted-foreground/70 pl-2 border-l border-border/30 truncate">{note}</p>
                ))}
              </div>
            )}
          </>
        )}

        {isStale && !noData && (
          <div className="flex items-center gap-1.5 text-[9px] text-amber-400/80 pt-1 border-t border-border/20">
            <Clock className="h-3 w-3" />
            <span>Data is {dataAgeMin}+ minutes old — polling next cycle</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function regimeColor(regime: string) {
  if (regime === "TREND") return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
  if (regime === "RANGE") return "bg-blue-500/20 text-blue-400 border-blue-500/30";
  return "bg-amber-500/20 text-amber-400 border-amber-500/30";
}

function htfColor(bias: string) {
  if (bias === "BULL") return "text-emerald-400";
  if (bias === "BEAR") return "text-red-400";
  return "text-muted-foreground";
}

function scoreColor(score: number) {
  if (score >= 80) return "text-emerald-400";
  if (score >= 65) return "text-blue-400";
  if (score >= 40) return "text-amber-400";
  return "text-red-400";
}

function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.round((value / max) * 100);
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] text-muted-foreground w-10 shrink-0 font-mono">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[9px] font-mono text-muted-foreground w-8 text-right shrink-0">{value}/{max}</span>
    </div>
  );
}

function TritonPanel({ triton, readiness }: { triton: TritonSignal; readiness?: any }) {
  const sideColor = triton.side === "LONG" ? "text-emerald-500" : triton.side === "SHORT" ? "text-red-500" : "text-muted-foreground";
  const sideBg = triton.side === "LONG" ? "bg-emerald-500/10 border-emerald-500/30" : triton.side === "SHORT" ? "bg-red-500/10 border-red-500/30" : "bg-muted/30 border-border/30";
  const threshold = triton.threshold ?? readiness?.threshold ?? 55;
  const isReady = triton.side !== "NONE" && triton.score >= threshold;
  const scoreBarColor = isReady ? "bg-teal-500" : triton.score >= threshold * 0.8 ? "bg-amber-400" : "bg-muted-foreground/40";
  const thresholdPct = Math.min(100, Math.round((threshold / 100) * 100));
  const scorePct = Math.min(100, Math.round((triton.score / 100) * 100));
  const bd = triton.scoreBreakdown;

  const modeStyles: Record<string, string> = {
    NOW: "bg-red-500/20 text-red-300 border-red-500/30",
    AGGRESSIVE: "bg-orange-500/20 text-orange-400 border-orange-500/30",
    AUTO: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
    PRECISION: "bg-violet-500/20 text-violet-400 border-violet-500/30",
  };

  return (
    <Card data-testid="card-triton-signal">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
              <Zap className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-xs font-medium">Triton Signal Engine</CardTitle>
              <p className="text-[10px] text-muted-foreground">Composite 0–100 score · 5m/1h/4h analysis</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${modeStyles[triton.activeMode] ?? modeStyles.AUTO}`} data-testid="triton-mode">
              {triton.activeMode}
            </Badge>
            <span className={`text-sm font-bold font-mono px-2 py-0.5 rounded border ${sideBg} ${sideColor}`} data-testid="text-triton-side">
              {triton.side === "NONE" ? "WAIT" : triton.side}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Score row */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-md border border-border/30 px-2 py-1.5 text-center" data-testid="triton-regime">
            <p className="text-[9px] text-muted-foreground uppercase mb-0.5">Regime</p>
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${regimeColor(triton.regime)}`}>{triton.regime}</Badge>
          </div>
          <div className="rounded-md border border-border/30 px-2 py-1.5 text-center" data-testid="triton-htf">
            <p className="text-[9px] text-muted-foreground uppercase mb-0.5">HTF Bias</p>
            <span className={`text-sm font-bold font-mono ${htfColor(triton.htfBias)}`}>{triton.htfBias}</span>
          </div>
          <div className="rounded-md border border-border/30 px-2 py-1.5 text-center" data-testid="triton-rr">
            <p className="text-[9px] text-muted-foreground uppercase mb-0.5">R:R</p>
            <span className="text-sm font-bold font-mono">{triton.side !== "NONE" ? triton.rr.toFixed(2) : "—"}</span>
          </div>
        </div>

        {/* Composite score bar */}
        <div className="space-y-1.5" data-testid="triton-score">
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-muted-foreground uppercase font-medium">Composite Score</span>
            <span className={`text-sm font-mono font-bold ${scoreColor(triton.score)}`}>{triton.score} / 100</span>
          </div>
          <div className="relative h-2 rounded-full bg-muted overflow-visible">
            <div className={`h-full rounded-full transition-all duration-700 ${scoreBarColor}`} style={{ width: `${scorePct}%` }} />
            {/* Threshold tick */}
            <div className="absolute top-0 bottom-0 w-0.5 bg-white/30 rounded-full" style={{ left: `${thresholdPct}%` }} />
          </div>
          <div className="flex justify-between items-center">
            {isReady ? (
              <span className="text-[9px] font-bold text-teal-400 animate-pulse">● Signal ready</span>
            ) : (
              <span className="text-[9px] text-muted-foreground font-mono">{triton.score < threshold ? `${threshold - triton.score} pts below threshold` : "No side selected"}</span>
            )}
            <span className="text-[9px] text-muted-foreground font-mono">needs {threshold}+</span>
          </div>
        </div>

        {/* Per-indicator breakdown */}
        {bd && (
          <div className="space-y-1 pt-1 border-t border-border/20">
            <p className="text-[9px] text-muted-foreground uppercase font-medium mb-1.5">Indicator Breakdown</p>
            <ScoreBar label="EMA" value={bd.ema} max={25} color="bg-blue-400/70" />
            <ScoreBar label="RSI" value={bd.rsi} max={20} color="bg-violet-400/70" />
            <ScoreBar label="MACD" value={bd.macd} max={25} color="bg-teal-400/70" />
            <ScoreBar label="Volume" value={bd.volume} max={15} color="bg-amber-400/70" />
            <ScoreBar label="HTF" value={bd.htf} max={15} color="bg-orange-400/70" />
            {bd.penalty > 0 && (
              <div className="flex items-center gap-2 mt-1 pt-1 border-t border-border/20">
                <span className="text-[9px] text-amber-400/70 w-10 shrink-0 font-mono">Penalty</span>
                <span className="flex-1 text-[9px] text-amber-400/70 font-mono">−{bd.penalty} (TRANSITION regime)</span>
              </div>
            )}
            {bd.sentiment !== undefined && bd.sentiment !== 0 && (
              <div className="flex items-center gap-2 mt-1 pt-1 border-t border-border/20">
                <span className="text-[9px] text-violet-400/80 w-10 shrink-0 font-mono">Flow</span>
                <span className={`flex-1 text-[9px] font-mono ${bd.sentiment > 0 ? "text-emerald-400/80" : "text-red-400/80"}`}>
                  {bd.sentiment > 0 ? "+" : ""}{bd.sentiment}pt SentimentFlow modifier
                </span>
              </div>
            )}
            {bd.btcOverlay !== undefined && bd.btcOverlay !== 0 && (
              <div className="flex items-center gap-2 mt-1 pt-1 border-t border-border/20">
                <span className="text-[9px] text-amber-400/80 w-10 shrink-0 font-mono">BTC</span>
                <span className={`flex-1 text-[9px] font-mono ${bd.btcOverlay > 0 ? "text-emerald-400/80" : "text-red-400/80"}`}>
                  {bd.btcOverlay > 0 ? "+" : ""}{bd.btcOverlay}pt BTC Correlation modifier
                </span>
              </div>
            )}
          </div>
        )}

        {/* Entry levels when signal active */}
        {triton.side !== "NONE" && (
          <div className="grid grid-cols-3 gap-2 pt-1">
            <div className="rounded-md border border-border/30 px-2 py-1.5 text-center" data-testid="triton-entry">
              <p className="text-[9px] text-muted-foreground uppercase mb-0.5">Entry</p>
              <span className="text-xs font-mono font-bold">${triton.entry.toFixed(4)}</span>
            </div>
            <div className="rounded-md border border-border/30 px-2 py-1.5 text-center" data-testid="triton-stop">
              <p className="text-[9px] text-muted-foreground uppercase mb-0.5">Stop</p>
              <span className="text-xs font-mono font-bold text-red-400">${triton.stop.toFixed(4)}</span>
            </div>
            <div className="rounded-md border border-border/30 px-2 py-1.5 text-center" data-testid="triton-tp">
              <p className="text-[9px] text-muted-foreground uppercase mb-0.5">Take Profit</p>
              <span className="text-xs font-mono font-bold text-emerald-400">${triton.takeProfit.toFixed(4)}</span>
            </div>
          </div>
        )}

        {/* Top reasons */}
        {triton.reasons.length > 0 && (
          <div className="space-y-1 pt-1 border-t border-border/20" data-testid="triton-reasons">
            <p className="text-[9px] text-muted-foreground uppercase font-medium">Signal Context</p>
            {triton.reasons.slice(0, 4).map((reason, i) => (
              <p key={i} className="text-[10px] text-muted-foreground/80 pl-2 border-l border-border/30">{reason}</p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SignalReasoningHero() {
  const { data: reasoning, isLoading } = useQuery<SignalReasoning>({
    queryKey: ["/api/signals/reasoning"],
    refetchInterval: 5000,
  });

  if (isLoading || !reasoning || !reasoning.available || !reasoning.conditions) {
    return (
      <Card data-testid="card-signal-reasoning">
        <CardContent className="pt-6">
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Brain className="h-6 w-6 text-primary animate-pulse" />
            </div>
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mb-3" />
            <p className="text-sm text-muted-foreground">Analyzing market conditions...</p>
            <p className="text-[10px] text-muted-foreground/60 mt-1">Evaluating 6 momentum indicators</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const totalConditions = reasoning.conditions.length;
  const longScore = reasoning.longScore ?? 0;
  const shortScore = reasoning.shortScore ?? 0;

  return (
    <div className="space-y-4" data-testid="card-signal-reasoning">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
                <Brain className="h-4 w-4 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base font-semibold">AI Signal Reasoning</CardTitle>
                <p className="text-[10px] text-muted-foreground mt-0.5">Real-time momentum analysis</p>
              </div>
            </div>
            <SignalBadge signal={reasoning.signal || "no_trade"} size="lg" />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <ScoreVisualization
            longScore={longScore}
            shortScore={shortScore}
            totalConditions={totalConditions}
          />

          <div className="border-t border-border/50 pt-4">
            <div className="flex items-center gap-2 mb-3">
              <Activity className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-medium">Condition Breakdown</span>
              <span className="text-[10px] text-muted-foreground ml-auto">{totalConditions} evaluated</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="conditions-list">
              {reasoning.conditions.map((condition, i) => (
                <ConditionCard key={i} condition={condition} index={i} />
              ))}
            </div>
          </div>

          <div className="border-t border-border/50 pt-3">
            <p className="text-xs text-muted-foreground leading-relaxed">
              {reasoning.side === "long" && (
                <>Market conditions favor <span className="text-emerald-500 font-medium">long positions</span>. {longScore} of {totalConditions} indicators align bullish. {longScore >= 4 ? "Signal threshold met - executing trade signals to connected agents." : "Threshold is 4+ aligned conditions to trigger a trade."}</>
              )}
              {reasoning.side === "short" && (
                <>Market conditions favor <span className="text-red-500 font-medium">short positions</span>. {shortScore} of {totalConditions} indicators align bearish. {shortScore >= 4 ? "Signal threshold met - executing trade signals to connected agents." : "Threshold is 4+ aligned conditions to trigger a trade."}</>
              )}
              {reasoning.side === "flat" && (
                <>Market shows <span className="font-medium">mixed signals</span> with no clear direction. Conditions split L{longScore}/S{shortScore}. Waiting for stronger alignment before broadcasting trade signals.</>
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      {reasoning.triton && <TritonPanel triton={reasoning.triton} readiness={reasoning.readiness} />}

      {reasoning.indicators && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <Activity className="h-3.5 w-3.5 text-primary" />
              <CardTitle className="text-xs font-medium">Live Indicator Values</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-1">
              {[
                { label: "RSI(14)", value: reasoning.indicators.rsi.toFixed(2), color: reasoning.indicators.rsi > 70 ? "text-red-500" : reasoning.indicators.rsi < 30 ? "text-emerald-500" : "" },
                { label: "Connors RSI", value: reasoning.indicators.connorsRsi.toFixed(2), color: reasoning.indicators.connorsRsi > 70 ? "text-red-500" : reasoning.indicators.connorsRsi < 30 ? "text-emerald-500" : "" },
                { label: "EMA(20)", value: `$${reasoning.indicators.ema20.toFixed(4)}`, color: "" },
                { label: "DEMA(20)", value: `$${reasoning.indicators.dema20.toFixed(4)}`, color: "" },
                { label: "TEMA(20)", value: `$${reasoning.indicators.tema20.toFixed(4)}`, color: "" },
                { label: "RSI Divergence", value: reasoning.indicators.rsiDivergence.bullish ? "Bullish" : reasoning.indicators.rsiDivergence.bearish ? "Bearish" : "None", color: reasoning.indicators.rsiDivergence.bullish ? "text-emerald-500" : reasoning.indicators.rsiDivergence.bearish ? "text-red-500" : "text-muted-foreground" },
                { label: "Volume 24h", value: `$${(reasoning.indicators.vol24h / 1e6).toFixed(1)}M`, color: "" },
              ].map(({ label, value, color }) => (
                <div key={label} className="flex items-center justify-between px-3 py-2 rounded bg-muted/30">
                  <span className="text-[10px] text-muted-foreground uppercase font-medium">{label}</span>
                  <span className={`text-sm font-mono font-bold ${color}`}>{value}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <AgentBroadcastStatus />
    </div>
  );
}

export default function MarketDashboard() {
  const { data: marketData, isLoading: marketLoading } = useQuery<any>({
    queryKey: ["/api/market"],
    refetchInterval: 5000,
  });

  const livePrice = useLivePrice();

  usePageSEO({
    title: "Market Dashboard",
    description: "Real-time AI signal reasoning for SUI-USDC perpetual trading with live Pyth Oracle data on Blue Water Agents",
  });

  if (marketLoading) {
    return (
      <div className="p-4 md:p-6 space-y-4">
        <Skeleton className="h-16 w-full" />
        <Card><CardContent className="pt-6"><Skeleton className="h-64 w-full" /></CardContent></Card>
      </div>
    );
  }

  const change = marketData?.change24h ?? 0;
  const priceSource = marketData?.priceSource || "simulated";
  const currentPrice = livePrice?.blended ?? marketData?.price ?? 0;

  return (
    <div className="p-3 md:p-6 space-y-4 max-w-3xl mx-auto" data-testid="page-market-dashboard">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg md:text-xl font-bold tracking-tight" data-testid="text-symbol">SUI-USDC</h2>
              <Badge variant="outline" className="text-[10px] gap-1" data-testid="badge-price-source">
                <Radio className="h-2.5 w-2.5" />
                {priceSource === "pyth" ? "Pyth Oracle" : "Simulated"}
              </Badge>
              {livePrice && (
                <div className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-[10px] text-muted-foreground">Live</span>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xl md:text-2xl font-bold font-mono" data-testid="stat-price-value">
            ${currentPrice.toFixed(4)}
          </p>
          <p className={`text-xs font-mono ${change >= 0 ? "text-emerald-500" : "text-red-500"}`}>
            {change >= 0 ? "+" : ""}{change.toFixed(2)}%
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md border border-border/30 px-3 py-2" data-testid="stat-high">
          <div className="flex items-center gap-1 mb-0.5">
            <p className="text-[10px] text-muted-foreground">24h High</p>
            {marketData?.high24hVerified && <span className="text-[8px] text-emerald-500 font-medium">✓ Pyth</span>}
          </div>
          <p className="text-sm font-mono font-bold text-emerald-500">${(marketData?.high24h ?? 0).toFixed(4)}</p>
        </div>
        <div className="rounded-md border border-border/30 px-3 py-2" data-testid="stat-low">
          <div className="flex items-center gap-1 mb-0.5">
            <p className="text-[10px] text-muted-foreground">24h Low</p>
            {marketData?.low24hVerified && <span className="text-[8px] text-emerald-500 font-medium">✓ Pyth</span>}
          </div>
          <p className="text-sm font-mono font-bold text-red-500">${(marketData?.low24h ?? 0).toFixed(4)}</p>
        </div>
        <div className="rounded-md border border-border/30 px-3 py-2" data-testid="stat-volume">
          <p className="text-[10px] text-muted-foreground">24h Volume</p>
          <p className="text-sm font-mono font-bold">${((marketData?.volume24h ?? 0) / 1e6).toFixed(1)}M</p>
        </div>
      </div>

      <SignalReasoningHero />
      <SuiOverlayPanel />
      <BtcOverlayPanel />
      <SentimentFlowPanel />
    </div>
  );
}
