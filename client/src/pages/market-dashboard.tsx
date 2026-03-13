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

function TritonPanel({ triton }: { triton: TritonSignal }) {
  const sideColor = triton.side === "LONG" ? "text-emerald-500" : triton.side === "SHORT" ? "text-red-500" : "text-muted-foreground";
  const sideLabel = triton.side === "NONE" ? "No Trade" : triton.side;

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
              <p className="text-[10px] text-muted-foreground">Regime-aware multi-TF analysis</p>
            </div>
            <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${triton.activeMode === "AGGRESSIVE" ? "bg-orange-500/20 text-orange-400 border-orange-500/30" : "bg-cyan-500/20 text-cyan-400 border-cyan-500/30"}`} data-testid="triton-mode">
              {triton.activeMode}
            </Badge>
          </div>
          <span className={`text-sm font-bold font-mono ${sideColor}`} data-testid="text-triton-side">{sideLabel}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-4 gap-2">
          <div className="rounded-md border border-border/30 px-2 py-1.5 text-center" data-testid="triton-regime">
            <p className="text-[9px] text-muted-foreground uppercase mb-0.5">Regime</p>
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${regimeColor(triton.regime)}`}>{triton.regime}</Badge>
          </div>
          <div className="rounded-md border border-border/30 px-2 py-1.5 text-center" data-testid="triton-htf">
            <p className="text-[9px] text-muted-foreground uppercase mb-0.5">HTF Bias</p>
            <span className={`text-sm font-bold font-mono ${htfColor(triton.htfBias)}`}>{triton.htfBias}</span>
          </div>
          <div className="rounded-md border border-border/30 px-2 py-1.5 text-center" data-testid="triton-score">
            <p className="text-[9px] text-muted-foreground uppercase mb-0.5">Score</p>
            <span className={`text-sm font-bold font-mono ${scoreColor(triton.score)}`}>{triton.score}</span>
          </div>
          <div className="rounded-md border border-border/30 px-2 py-1.5 text-center" data-testid="triton-rr">
            <p className="text-[9px] text-muted-foreground uppercase mb-0.5">R:R</p>
            <span className="text-sm font-bold font-mono">{triton.rr.toFixed(2)}</span>
          </div>
        </div>

        {triton.side !== "NONE" && (
          <div className="grid grid-cols-3 gap-2">
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

        <div className="rounded-md border border-border/30 px-2 py-1.5" data-testid="triton-size">
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-muted-foreground uppercase">Size Mult</span>
            <span className="text-xs font-mono font-bold">{(triton.sizeMultiplier * 100).toFixed(0)}%</span>
          </div>
          <div className="w-full h-1.5 bg-muted/30 rounded-full mt-1">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${triton.sizeMultiplier * 100}%` }} />
          </div>
        </div>

        {triton.reasons.length > 0 && (
          <div className="space-y-1" data-testid="triton-reasons">
            <p className="text-[9px] text-muted-foreground uppercase font-medium">Signal Reasoning</p>
            {triton.reasons.map((reason, i) => (
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

      {reasoning.triton && <TritonPanel triton={reasoning.triton} />}

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
    </div>
  );
}
