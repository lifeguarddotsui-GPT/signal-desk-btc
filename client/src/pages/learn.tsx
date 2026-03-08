import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { usePageSEO } from "@/lib/seo";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery } from "@tanstack/react-query";
import { useState, useEffect, useMemo } from "react";
import {
  Brain,
  Cpu,
  Target,
  TrendingUp,
  TrendingDown,
  Zap,
  Activity,
  BarChart3,
  BookOpen,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Gauge,
  LineChart,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
} from "lucide-react";

interface CloseOutcome {
  id: number;
  agentId: string;
  positionDbId: string;
  closeMethod: string;
  regime: string;
  side: string;
  label: string;
  latencyMs: number | null;
  slippageBps: number | null;
  pnlSui: number | null;
  entryPrice: number | null;
  closePrice: number | null;
  leverage: number | null;
  collateral: number | null;
  createdAt: string;
  agentName?: string;
  walletAddress?: string;
  closeTxDigest?: string;
  onChainPositionId?: string;
}

interface AgentBreakdownEntry {
  agentId: string;
  winRate: number;
  count: number;
  avgPnl: number;
  totalPnl: number;
  avgReward: number;
  agentName?: string;
  walletAddress?: string;
}

interface PolicyWeight {
  id: number;
  market: string;
  regime: string;
  actionKey: string;
  trials: number;
  wins: number;
  avgReward: number;
  updatedAt: string;
}

interface QualityMetric {
  agentId: string;
  agentName: string;
  avgLatencyMs: number;
  avgSlippageBps: number;
  fillRate: number;
  gasEfficiency: number;
  tradeCount: number;
  onChainVerifiedRate: number;
  regimeBlocking: Array<{ regime: string; side: string; winRate: number; blocked: boolean; samples: number }>;
  adaptiveScoreAdjustment: number;
  qualityScore: number;
}

interface CapitalPlan {
  agentId: string;
  agentName?: string;
  recommendedMaxPositions: number;
  sizeMultiplier: number;
  freeSuiReserveTarget: number;
  hedgeEligible: boolean;
  hedgeReason: string;
  profitReinvestmentRate: number;
  adaptiveScoreBonus: number;
  reasoning: string[];
}

interface LearningStats {
  outcomes: { label: string; count: number; avgPnl: number }[];
  byRegime: { regime: string; count: number; winRate: number; avgReward: number }[];
  weights: PolicyWeight[];
  recentOutcomes: CloseOutcome[];
  entryStats: { key: string; winRate: number; count: number; avgReward: number }[];
  agentBreakdown?: AgentBreakdownEntry[];
  qualityMetrics?: QualityMetric[];
  capitalPlans?: CapitalPlan[];
}

function PulsingDot({ color }: { color: string }) {
  return (
    <span className="relative flex h-2.5 w-2.5">
      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-50 ${color}`} />
      <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${color}`} />
    </span>
  );
}

function NeuralNode({ active, delay }: { active: boolean; delay: number }) {
  return (
    <div
      className={`w-3 h-3 rounded-full transition-all duration-700 ${
        active ? "bg-primary shadow-[0_0_8px_rgba(20,184,166,0.6)] scale-110" : "bg-muted-foreground/20 scale-90"
      }`}
      style={{ transitionDelay: `${delay}ms` }}
    />
  );
}

function NeuralActivityViz({ outcomes }: { outcomes: CloseOutcome[] }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1200);
    return () => clearInterval(interval);
  }, []);

  const nodes = useMemo(() => {
    const layers = [5, 7, 9, 7, 5, 3];
    return layers.map((count, layerIdx) =>
      Array.from({ length: count }, (_, nodeIdx) => ({
        active: ((tick + layerIdx * 2 + nodeIdx) % 7) < 3,
        delay: layerIdx * 80 + nodeIdx * 40,
      }))
    );
  }, [tick]);

  const lastOutcome = outcomes[0];
  const lastLabel = lastOutcome?.label || "IDLE";
  const lastPnl = lastOutcome?.pnlSui || 0;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Brain className="h-4 w-4 text-primary" />
          Neural Processing Activity
          <PulsingDot color="bg-primary" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-center gap-2 py-3 bg-gradient-to-r from-background via-primary/5 to-background rounded-lg">
          {nodes.map((layer, li) => (
            <div key={li} className="flex flex-col gap-1 items-center">
              {layer.map((node, ni) => (
                <NeuralNode key={ni} active={node.active} delay={node.delay} />
              ))}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-md bg-muted/50 p-2 text-center">
            <p className="text-[8px] text-muted-foreground uppercase">Input Layer</p>
            <p className="text-xs font-mono text-primary">Price + Indicators</p>
          </div>
          <div className="rounded-md bg-muted/50 p-2 text-center">
            <p className="text-[8px] text-muted-foreground uppercase">Hidden Layers</p>
            <p className="text-xs font-mono text-primary">EWMA + UCB</p>
          </div>
          <div className="rounded-md bg-muted/50 p-2 text-center">
            <p className="text-[8px] text-muted-foreground uppercase">Output</p>
            <p className={`text-xs font-mono ${lastPnl > 0 ? "text-emerald-500" : lastPnl < 0 ? "text-red-500" : "text-muted-foreground"}`}>
              {lastLabel}
            </p>
          </div>
        </div>

        {lastOutcome && (
          <div className="flex items-center gap-2 p-2 rounded-md bg-card border border-border/30 text-[10px]">
            <Activity className="h-3 w-3 text-primary shrink-0" />
            <span className="text-muted-foreground">Latest signal:</span>
            <Badge variant={lastPnl > 0 ? "default" : "destructive"} className="text-[9px]">
              {lastOutcome.side} {lastOutcome.regime}
            </Badge>
            <span className={`font-mono ${lastPnl > 0 ? "text-emerald-500" : "text-red-500"}`}>
              {lastPnl >= 0 ? "+" : ""}{lastPnl.toFixed(4)} SUI
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OutcomeDistribution({ outcomes }: { outcomes: { label: string; count: number; avgPnl: number }[] }) {
  const total = outcomes.reduce((s, o) => s + o.count, 0);
  if (total === 0) return null;

  const labelConfig: Record<string, { color: string; icon: any }> = {
    SUCCESS: { color: "bg-emerald-500", icon: CheckCircle2 },
    PARTIAL: { color: "bg-amber-500", icon: AlertTriangle },
    TIMEOUT: { color: "bg-orange-500", icon: Clock },
    FAIL: { color: "bg-red-500", icon: XCircle },
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <BarChart3 className="h-4 w-4 text-primary" />
          Outcome Distribution
          <Badge variant="outline" className="text-[9px] ml-auto">{total} total</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex h-4 rounded-full overflow-hidden bg-muted">
          {outcomes.map((o) => {
            const pct = (o.count / total) * 100;
            if (pct < 1) return null;
            const cfg = labelConfig[o.label] || { color: "bg-muted-foreground" };
            return (
              <div
                key={o.label}
                className={`${cfg.color} transition-all duration-500`}
                style={{ width: `${pct}%` }}
                title={`${o.label}: ${o.count} (${pct.toFixed(1)}%)`}
              />
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-2">
          {outcomes.map((o) => {
            const cfg = labelConfig[o.label] || { color: "bg-muted-foreground", icon: Minus };
            const Icon = cfg.icon;
            const pct = total > 0 ? ((o.count / total) * 100).toFixed(1) : "0";
            return (
              <div key={o.label} className="flex items-center gap-2 p-2 rounded-md bg-muted/40">
                <Icon className={`h-3.5 w-3.5 shrink-0 ${o.label === "SUCCESS" ? "text-emerald-500" : o.label === "FAIL" ? "text-red-500" : "text-amber-500"}`} />
                <div className="min-w-0">
                  <p className="text-[10px] font-medium">{o.label}</p>
                  <p className="text-[9px] text-muted-foreground">{o.count} ({pct}%)</p>
                </div>
                <p className={`text-[10px] font-mono ml-auto ${o.avgPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {o.avgPnl >= 0 ? "+" : ""}{o.avgPnl.toFixed(3)}
                </p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function RegimePerformance({ byRegime }: { byRegime: { regime: string; count: number; winRate: number; avgReward: number }[] }) {
  if (byRegime.length === 0) return null;

  const sorted = [...byRegime].sort((a, b) => b.avgReward - a.avgReward);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Gauge className="h-4 w-4 text-primary" />
          Regime Performance
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {sorted.map((r) => {
          const winPct = (r.winRate * 100).toFixed(0);
          const isPositive = r.avgReward > 0;
          return (
            <div key={r.regime} className="p-2.5 rounded-md bg-muted/40 border border-border/20 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[9px] font-mono">{r.regime}</Badge>
                  <span className="text-[9px] text-muted-foreground">{r.count} trades</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {isPositive ? (
                    <ArrowUpRight className="h-3 w-3 text-emerald-500" />
                  ) : (
                    <ArrowDownRight className="h-3 w-3 text-red-500" />
                  )}
                  <span className={`text-xs font-mono font-bold ${isPositive ? "text-emerald-500" : "text-red-500"}`}>
                    {r.avgReward >= 0 ? "+" : ""}{r.avgReward.toFixed(2)}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${
                      r.winRate >= 0.5 ? "bg-emerald-500" : r.winRate >= 0.35 ? "bg-amber-500" : "bg-red-500"
                    }`}
                    style={{ width: `${Math.min(100, r.winRate * 100)}%` }}
                  />
                </div>
                <span className="text-[9px] font-mono text-muted-foreground w-8 text-right">{winPct}%</span>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function formatActionKey(actionKey: string): string {
  let key = actionKey.replace("entry:", "");
  key = key.replace(/^agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:/, "");
  return key;
}

function PolicyWeightsViz({ weights }: { weights: PolicyWeight[] }) {
  const entryWeights = weights.filter(w => w.actionKey.startsWith("entry:"));
  const closeWeights = weights.filter(w => !w.actionKey.startsWith("entry:") && !w.actionKey.startsWith("agent:"));

  if (weights.length === 0) return null;

  const renderWeightRow = (w: PolicyWeight) => {
    const winRate = w.trials > 0 ? (w.wins / w.trials) : 0;
    const isPositive = w.avgReward > 0;
    const displayKey = formatActionKey(w.actionKey);
    const regime = w.regime || "ALL";
    const winColor = winRate >= 0.5 ? "text-emerald-500" : winRate >= 0.35 ? "text-amber-500" : "text-red-500";

    return (
      <div key={w.id} className="flex items-center gap-2 p-2 rounded-md bg-muted/30 border border-border/10">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-mono text-foreground truncate">{displayKey}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <Badge variant="outline" className="text-[8px]">{regime}</Badge>
            <span className="text-[8px] text-muted-foreground">{w.trials} trials</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-[10px] font-mono font-bold ${isPositive ? "text-emerald-500" : "text-red-500"}`}>
            {w.avgReward >= 0 ? "+" : ""}{w.avgReward.toFixed(3)}
          </p>
          <p className={`text-[8px] ${winColor}`}>{(winRate * 100).toFixed(0)}% win</p>
        </div>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Cpu className="h-4 w-4 text-primary" />
          Policy Weights (EWMA + UCB)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {entryWeights.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1">
              <Target className="h-3 w-3" />
              Entry Patterns
            </p>
            <div className="space-y-1">
              {entryWeights.sort((a, b) => b.avgReward - a.avgReward).map(renderWeightRow)}
            </div>
          </div>
        )}
        {closeWeights.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1">
              <Zap className="h-3 w-3" />
              Close Methods
            </p>
            <div className="space-y-1">
              {closeWeights.sort((a, b) => b.avgReward - a.avgReward).map(renderWeightRow)}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EntryPatternAnalysis({ entryStats }: { entryStats: { key: string; winRate: number; count: number; avgReward: number }[] }) {
  if (entryStats.length === 0) return null;

  const sorted = [...entryStats].sort((a, b) => b.avgReward - a.avgReward);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Target className="h-4 w-4 text-primary" />
          Entry Pattern Win Rates
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {sorted.map((e) => {
            const parts = e.key.replace("entry:", "").split(":");
            const regime = parts[0] && parts[0] !== "UNKNOWN" ? parts[0] : "Mixed";
            const side = parts[1] && parts[1] !== "UNKNOWN" ? parts[1] : "any";
            const isBlocked = e.winRate < 0.20 && e.count >= 10;
            const isPenalized = e.winRate < 0.35 && e.count >= 5;

            return (
              <div key={e.key} className={`flex items-center gap-2 p-2 rounded-md border ${isBlocked ? "border-red-500/30 bg-red-500/5" : isPenalized ? "border-amber-500/20 bg-amber-500/5" : "border-border/20 bg-muted/30"}`}>
                <div className="flex items-center gap-1.5 min-w-0">
                  {side === "long" || side === "LONG" ? (
                    <TrendingUp className="h-3 w-3 text-emerald-500 shrink-0" />
                  ) : (
                    <TrendingDown className="h-3 w-3 text-red-500 shrink-0" />
                  )}
                  <span className="text-[10px] font-mono">{regime}</span>
                  <Badge variant="outline" className={`text-[8px] ${side === "long" || side === "LONG" ? "text-emerald-500" : "text-red-500"}`}>
                    {side.toUpperCase()}
                  </Badge>
                </div>
                <div className="flex items-center gap-2 ml-auto shrink-0">
                  {isBlocked && <Badge variant="destructive" className="text-[7px]">BLOCKED</Badge>}
                  {isPenalized && !isBlocked && <Badge className="text-[7px] bg-amber-500">PENALIZED</Badge>}
                  <div className="text-right">
                    <p className={`text-[10px] font-mono font-bold ${e.winRate >= 0.5 ? "text-emerald-500" : e.winRate >= 0.35 ? "text-amber-500" : "text-red-500"}`}>
                      {(e.winRate * 100).toFixed(0)}%
                    </p>
                    <p className="text-[8px] text-muted-foreground">{e.count} samples</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function AgentPerformance({ breakdown }: { breakdown: AgentBreakdownEntry[] }) {
  if (!breakdown || breakdown.length === 0) return null;

  const sorted = [...breakdown].sort((a, b) => b.totalPnl - a.totalPnl);

  function truncateAddress(addr: string): string {
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
  }

  return (
    <Card data-testid="card-agent-performance">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Target className="h-4 w-4 text-primary" />
          Agent Performance
          <Badge variant="outline" className="text-[9px] ml-auto">{sorted.length} agents</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {sorted.map((agent) => {
            const winPct = (agent.winRate * 100).toFixed(0);
            const winColor = agent.winRate > 0.5 ? "text-emerald-500" : agent.winRate < 0.35 ? "text-red-500" : "text-amber-500";
            const pnlColor = agent.totalPnl >= 0 ? "text-emerald-500" : "text-red-500";

            return (
              <div
                key={agent.agentId}
                className="p-2.5 rounded-md bg-muted/40 border border-border/20 space-y-1.5"
                data-testid={`card-agent-breakdown-${agent.agentId}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold truncate" data-testid={`text-agent-name-${agent.agentId}`}>
                    {agent.agentName || agent.agentId.slice(0, 8)}
                  </span>
                  <span className={`text-xs font-mono font-bold ${winColor}`} data-testid={`text-agent-winrate-${agent.agentId}`}>
                    {winPct}%
                  </span>
                </div>
                {agent.walletAddress && (
                  <p className="text-[9px] font-mono text-muted-foreground" data-testid={`text-agent-wallet-${agent.agentId}`}>
                    {truncateAddress(agent.walletAddress)}
                  </p>
                )}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[9px] text-muted-foreground" data-testid={`text-agent-trades-${agent.agentId}`}>
                    {agent.count} trades
                  </span>
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-mono font-bold ${pnlColor}`} data-testid={`text-agent-totalpnl-${agent.agentId}`}>
                      {agent.totalPnl >= 0 ? "+" : ""}{agent.totalPnl.toFixed(3)} SUI
                    </span>
                    <span className="text-[9px] font-mono text-muted-foreground" data-testid={`text-agent-avgpnl-${agent.agentId}`}>
                      avg {agent.avgPnl >= 0 ? "+" : ""}{agent.avgPnl.toFixed(4)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function RecentTradeOutcomes({ outcomes }: { outcomes: CloseOutcome[] }) {
  if (outcomes.length === 0) return null;

  return (
    <Card data-testid="card-recent-trade-outcomes">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <LineChart className="h-4 w-4 text-primary" />
          Recent Trade Outcomes
          <Badge variant="outline" className="text-[9px] ml-auto">Last {outcomes.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {outcomes.map((o, i) => {
            const pnl = o.pnlSui || 0;
            const isWin = pnl > 0;
            const age = o.createdAt ? getTimeAgo(o.createdAt) : "";

            return (
              <div key={o.id || i} className="flex items-center gap-2 p-1.5 rounded-md hover:bg-muted/30 transition-colors" data-testid={`row-trade-outcome-${o.id || i}`}>
                <div className={`w-1 h-6 rounded-full ${isWin ? "bg-emerald-500" : "bg-red-500"}`} />
                <div className="flex items-center gap-1 min-w-0 flex-1 flex-wrap">
                  {o.agentName && (
                    <span className="text-[10px] font-bold shrink-0" data-testid={`text-outcome-agent-${o.id || i}`}>
                      {o.agentName}
                    </span>
                  )}
                  {o.side === "long" ? (
                    <TrendingUp className="h-3 w-3 text-emerald-500 shrink-0" />
                  ) : (
                    <TrendingDown className="h-3 w-3 text-red-500 shrink-0" />
                  )}
                  <span className="text-[9px] font-mono text-muted-foreground truncate">
                    {o.regime && o.regime !== "UNKNOWN" ? o.regime : "N/A"} {o.closeMethod || "market"}
                  </span>
                  {o.onChainPositionId && (
                    <Badge variant="outline" className="text-[7px] font-mono" data-testid={`badge-position-${o.id || i}`}>
                      {o.onChainPositionId.slice(0, 8)}...
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {o.closeTxDigest && (
                    <a
                      href={`https://suiscan.xyz/mainnet/tx/${o.closeTxDigest}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[8px] font-mono text-primary hover:underline"
                      data-testid={`link-tx-${o.id || i}`}
                    >
                      TX
                    </a>
                  )}
                  {o.latencyMs != null && (
                    <span className="text-[8px] text-muted-foreground">{o.latencyMs < 1000 ? `${o.latencyMs}ms` : `${(o.latencyMs / 1000).toFixed(1)}s`}</span>
                  )}
                  <span className={`text-[10px] font-mono font-bold ${isWin ? "text-emerald-500" : "text-red-500"}`} data-testid={`text-pnl-${o.id || i}`}>
                    {pnl >= 0 ? "+" : ""}{pnl.toFixed(4)}
                  </span>
                  <span className="text-[8px] text-muted-foreground w-10 text-right" data-testid={`text-age-${o.id || i}`}>{age}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-3 p-2 rounded-md bg-muted/30 border border-border/20">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-[8px] text-muted-foreground">Avg PnL</p>
              <p className={`text-xs font-mono font-bold ${outcomes.reduce((s, o) => s + (o.pnlSui || 0), 0) >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid="text-summary-avg-pnl">
                {(outcomes.reduce((s, o) => s + (o.pnlSui || 0), 0) / Math.max(1, outcomes.length)).toFixed(4)}
              </p>
            </div>
            <div>
              <p className="text-[8px] text-muted-foreground">Win Rate</p>
              <p className="text-xs font-mono font-bold text-primary" data-testid="text-summary-win-rate">
                {((outcomes.filter(o => (o.pnlSui || 0) > 0).length / outcomes.length) * 100).toFixed(0)}%
              </p>
            </div>
            <div>
              <p className="text-[8px] text-muted-foreground">Avg Latency</p>
              <p className="text-xs font-mono font-bold text-muted-foreground" data-testid="text-summary-avg-latency">
                {(outcomes.filter(o => o.latencyMs).reduce((s, o) => s + (o.latencyMs || 0), 0) / Math.max(1, outcomes.filter(o => o.latencyMs).length) / 1000).toFixed(1)}s
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CapitalPlansDisplay({ plans }: { plans: CapitalPlan[] }) {
  if (!plans || plans.length === 0) return null;

  return (
    <Card data-testid="card-capital-plans">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <BarChart3 className="h-4 w-4 text-primary" />
          Capital Management Plans
          <Badge variant="outline" className="text-[9px] ml-auto">{plans.length} agents</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3">
          {plans.map((plan) => {
            const sizeColor = plan.sizeMultiplier >= 0.75 ? "text-emerald-500" : plan.sizeMultiplier >= 0.5 ? "text-amber-500" : "text-red-500";
            return (
              <div
                key={plan.agentId}
                className="p-3 rounded-lg bg-muted/40 border border-border/20 space-y-2.5"
                data-testid={`card-capital-plan-${plan.agentId}`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold" data-testid={`text-plan-agent-${plan.agentId}`}>
                    {plan.agentName || plan.agentId.slice(0, 8)}
                  </span>
                  <div className="flex items-center gap-2">
                    {plan.hedgeEligible && (
                      <Badge variant="outline" className="text-[7px] border-primary/40 text-primary">HEDGE</Badge>
                    )}
                    <Badge variant="outline" className="text-[7px]">
                      {plan.recommendedMaxPositions} max pos
                    </Badge>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-1.5">
                  <div className="p-1.5 rounded bg-card/60 text-center">
                    <p className="text-[7px] text-muted-foreground">Max Positions</p>
                    <p className="text-xs font-mono font-bold text-primary">{plan.recommendedMaxPositions}</p>
                  </div>
                  <div className="p-1.5 rounded bg-card/60 text-center">
                    <p className="text-[7px] text-muted-foreground">Size Mult</p>
                    <p className={`text-xs font-mono font-bold ${sizeColor}`}>{plan.sizeMultiplier.toFixed(2)}x</p>
                  </div>
                  <div className="p-1.5 rounded bg-card/60 text-center">
                    <p className="text-[7px] text-muted-foreground">Reserve</p>
                    <p className="text-xs font-mono font-bold">{plan.freeSuiReserveTarget.toFixed(2)}</p>
                  </div>
                  <div className="p-1.5 rounded bg-card/60 text-center">
                    <p className="text-[7px] text-muted-foreground">Reinvest</p>
                    <p className="text-xs font-mono font-bold">{(plan.profitReinvestmentRate * 100).toFixed(0)}%</p>
                  </div>
                </div>

                {plan.adaptiveScoreBonus !== 0 && (
                  <div className={`flex items-center gap-2 p-1.5 rounded text-[9px] ${plan.adaptiveScoreBonus > 0 ? "bg-red-500/5 border border-red-500/20" : "bg-emerald-500/5 border border-emerald-500/20"}`}>
                    <Zap className="h-3 w-3 shrink-0" />
                    <span>Signal threshold adjustment:</span>
                    <span className={`font-mono font-bold ${plan.adaptiveScoreBonus > 0 ? "text-red-500" : "text-emerald-500"}`}>
                      {plan.adaptiveScoreBonus > 0 ? "+" : ""}{plan.adaptiveScoreBonus}
                    </span>
                  </div>
                )}

                <div className="space-y-1">
                  <p className="text-[8px] text-muted-foreground uppercase tracking-wider">AI Reasoning</p>
                  <div className="space-y-0.5">
                    {plan.reasoning.map((r, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-[9px] text-muted-foreground">
                        <span className="text-primary mt-0.5 shrink-0">&#8226;</span>
                        <span>{r}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function LearningOverview({ stats }: { stats: LearningStats }) {
  const totalOutcomes = stats.outcomes.reduce((s, o) => s + o.count, 0);
  const totalPnl = stats.outcomes.reduce((s, o) => s + o.avgPnl * o.count, 0);

  const profitableCount = stats.recentOutcomes
    ? stats.recentOutcomes.filter(o => (o.pnlSui || 0) > 0).length
    : 0;
  const totalRecent = stats.recentOutcomes?.length || 0;
  const winRate = totalRecent > 0 ? (profitableCount / totalRecent) * 100 : 0;

  const allBreakdownWinRate = stats.agentBreakdown && stats.agentBreakdown.length > 0
    ? (() => {
        const totalTrades = stats.agentBreakdown.reduce((s, a) => s + a.count, 0);
        const totalWins = stats.agentBreakdown.reduce((s, a) => s + Math.round(a.winRate * a.count), 0);
        return totalTrades > 0 ? (totalWins / totalTrades) * 100 : winRate;
      })()
    : winRate;

  const bestRegime = stats.byRegime.length > 0
    ? [...stats.byRegime].sort((a, b) => b.avgReward - a.avgReward)[0]
    : null;

  const winRateColor = allBreakdownWinRate >= 50 ? "text-emerald-500" : allBreakdownWinRate >= 35 ? "text-amber-500" : "text-red-500";

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <Card className="bg-gradient-to-br from-primary/10 to-background border-primary/20">
        <CardContent className="p-3 text-center">
          <p className="text-[8px] text-muted-foreground uppercase">Trades Analyzed</p>
          <p className="text-lg font-bold font-mono text-primary" data-testid="text-total-trades">{totalOutcomes}</p>
        </CardContent>
      </Card>
      <Card className={`bg-gradient-to-br ${allBreakdownWinRate >= 50 ? "from-emerald-500/10 border-emerald-500/20" : allBreakdownWinRate >= 35 ? "from-amber-500/10 border-amber-500/20" : "from-red-500/10 border-red-500/20"} to-background`}>
        <CardContent className="p-3 text-center">
          <p className="text-[8px] text-muted-foreground uppercase">Win Rate</p>
          <p className={`text-lg font-bold font-mono ${winRateColor}`} data-testid="text-success-rate">{allBreakdownWinRate.toFixed(0)}%</p>
        </CardContent>
      </Card>
      <Card className={`bg-gradient-to-br ${totalPnl >= 0 ? "from-emerald-500/10 border-emerald-500/20" : "from-red-500/10 border-red-500/20"} to-background`}>
        <CardContent className="p-3 text-center">
          <p className="text-[8px] text-muted-foreground uppercase">Total PnL</p>
          <p className={`text-lg font-bold font-mono ${totalPnl >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid="text-total-pnl">
            {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)}
          </p>
        </CardContent>
      </Card>
      <Card className="bg-gradient-to-br from-primary/10 to-background border-primary/20">
        <CardContent className="p-3 text-center">
          <p className="text-[8px] text-muted-foreground uppercase">Best Regime</p>
          <p className="text-sm font-bold font-mono text-primary truncate" data-testid="text-best-regime">
            {bestRegime ? bestRegime.regime : "--"}
          </p>
          {bestRegime && (
            <p className="text-[8px] text-muted-foreground">{(bestRegime.winRate * 100).toFixed(0)}% win</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 space-y-4">
      <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
        <Brain className="h-8 w-8 text-primary" />
      </div>
      <div className="text-center space-y-1">
        <h3 className="text-sm font-medium">Learning Engine Initializing</h3>
        <p className="text-xs text-muted-foreground max-w-xs">
          The AI is waiting for trade data. Once agents start closing positions, the learning engine will analyze outcomes and optimize strategies.
        </p>
      </div>
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20">
        <PulsingDot color="bg-primary" />
        <span className="text-[10px] text-primary font-medium">Awaiting first trade data</span>
      </div>
    </div>
  );
}

export default function Learn() {
  usePageSEO({
    title: "Learning Engine - Blue Water Agents",
    description: "Watch the AI Learning Engine analyze trades, optimize strategies, and get smarter over time with EWMA reward scoring and UCB bandit algorithms.",
  });

  const { data: stats, isLoading } = useQuery<LearningStats>({
    queryKey: ["/api/learning/stats"],
    refetchInterval: 15000,
  });

  const totalOutcomes = stats?.outcomes?.reduce((s, o) => s + o.count, 0) || 0;

  return (
    <div className="p-3 md:p-6 space-y-4 max-w-4xl mx-auto" data-testid="page-learning-engine">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg md:text-xl font-bold tracking-tight flex items-center gap-2" data-testid="text-learning-title">
            <Brain className="h-5 w-5 text-primary" />
            Learning Engine
          </h2>
          <p className="text-xs text-muted-foreground">AI-powered trade analysis, pattern recognition, and strategy optimization</p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/20 shrink-0">
          <PulsingDot color="bg-primary" />
          <span className="text-[9px] text-primary font-medium">LIVE</span>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : !stats || totalOutcomes === 0 ? (
        <EmptyState />
      ) : (
        <Tabs defaultValue="dashboard">
          <TabsList className="w-full grid grid-cols-6" data-testid="tabs-learning">
            <TabsTrigger value="dashboard" className="text-[10px] sm:text-xs px-0.5 sm:px-2" data-testid="tab-dashboard">
              <Activity className="h-3 w-3 mr-0.5 shrink-0 hidden sm:inline" />
              Dashboard
            </TabsTrigger>
            <TabsTrigger value="patterns" className="text-[10px] sm:text-xs px-0.5 sm:px-2" data-testid="tab-patterns">
              <Target className="h-3 w-3 mr-0.5 shrink-0 hidden sm:inline" />
              Patterns
            </TabsTrigger>
            <TabsTrigger value="trades" className="text-[10px] sm:text-xs px-0.5 sm:px-2" data-testid="tab-trades">
              <LineChart className="h-3 w-3 mr-0.5 shrink-0 hidden sm:inline" />
              Trades
            </TabsTrigger>
            <TabsTrigger value="capital" className="text-[10px] sm:text-xs px-0.5 sm:px-2" data-testid="tab-capital">
              <BarChart3 className="h-3 w-3 mr-0.5 shrink-0 hidden sm:inline" />
              Capital
            </TabsTrigger>
            <TabsTrigger value="quality" className="text-[10px] sm:text-xs px-0.5 sm:px-2" data-testid="quality-tab">
              <Gauge className="h-3 w-3 mr-0.5 shrink-0 hidden sm:inline" />
              Quality
            </TabsTrigger>
            <TabsTrigger value="about" className="text-[10px] sm:text-xs px-0.5 sm:px-2" data-testid="tab-about">
              <BookOpen className="h-3 w-3 mr-0.5 shrink-0 hidden sm:inline" />
              About
            </TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard" className="mt-3 space-y-3">
            <LearningOverview stats={stats} />
            <NeuralActivityViz outcomes={stats.recentOutcomes} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <OutcomeDistribution outcomes={stats.outcomes} />
              <RegimePerformance byRegime={stats.byRegime} />
            </div>
          </TabsContent>

          <TabsContent value="patterns" className="mt-3 space-y-3">
            <PolicyWeightsViz weights={stats.weights} />
            <EntryPatternAnalysis entryStats={stats.entryStats} />
          </TabsContent>

          <TabsContent value="trades" className="mt-3 space-y-3">
            <AgentPerformance breakdown={stats.agentBreakdown || []} />
            <RecentTradeOutcomes outcomes={stats.recentOutcomes} />
          </TabsContent>

          <TabsContent value="capital" className="mt-3 space-y-3" data-testid="capital-content">
            {stats.capitalPlans && stats.capitalPlans.length > 0 ? (
              <CapitalPlansDisplay plans={stats.capitalPlans} />
            ) : (
              <div className="flex flex-col items-center justify-center py-12 space-y-3">
                <div className="w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center">
                  <BarChart3 className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-xs text-muted-foreground">No capital plans available yet. Active agents need trade data to generate plans.</p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="quality" className="mt-3 space-y-3" data-testid="quality-content">
            {stats.qualityMetrics && stats.qualityMetrics.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {stats.qualityMetrics.map((qm) => {
                  const scoreColor = qm.qualityScore > 60 ? "text-emerald-500" : qm.qualityScore >= 40 ? "text-amber-500" : "text-red-500";
                  return (
                    <Card key={qm.agentId} data-testid={`quality-card-${qm.agentId}`}>
                      <CardHeader className="pb-2">
                        <CardTitle className="flex items-center justify-between gap-2 text-sm">
                          <span className="font-bold truncate">{qm.agentName || qm.agentId.slice(0, 8)}</span>
                          <span className={`text-2xl font-mono font-bold ${scoreColor}`} data-testid={`quality-score-${qm.agentId}`}>
                            {qm.qualityScore.toFixed(0)}
                          </span>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                          <div className="p-2 rounded-md bg-muted/40">
                            <p className="text-[8px] text-muted-foreground uppercase">Avg Latency</p>
                            <p className="text-xs font-mono font-bold" data-testid={`text-latency-${qm.agentId}`}>{qm.avgLatencyMs.toFixed(0)} ms</p>
                          </div>
                          <div className="p-2 rounded-md bg-muted/40">
                            <p className="text-[8px] text-muted-foreground uppercase">Avg Slippage</p>
                            <p className="text-xs font-mono font-bold" data-testid={`text-slippage-${qm.agentId}`}>{qm.avgSlippageBps.toFixed(1)} bps</p>
                          </div>
                          <div className="p-2 rounded-md bg-muted/40">
                            <p className="text-[8px] text-muted-foreground uppercase">Fill Rate</p>
                            <p className="text-xs font-mono font-bold" data-testid={`text-fillrate-${qm.agentId}`}>{(qm.fillRate * 100).toFixed(0)}%</p>
                          </div>
                          <div className="p-2 rounded-md bg-muted/40">
                            <p className="text-[8px] text-muted-foreground uppercase">Gas Efficiency</p>
                            <p className="text-xs font-mono font-bold" data-testid={`text-gaseff-${qm.agentId}`}>{qm.gasEfficiency.toFixed(2)}</p>
                          </div>
                          <div className="p-2 rounded-md bg-muted/40">
                            <p className="text-[8px] text-muted-foreground uppercase">On-chain Verified</p>
                            <p className="text-xs font-mono font-bold" data-testid={`text-onchain-${qm.agentId}`}>{(qm.onChainVerifiedRate * 100).toFixed(0)}%</p>
                          </div>
                          <div className="p-2 rounded-md bg-muted/40">
                            <p className="text-[8px] text-muted-foreground uppercase">Trade Count</p>
                            <p className="text-xs font-mono font-bold" data-testid={`text-tradecount-${qm.agentId}`}>{qm.tradeCount}</p>
                          </div>
                        </div>

                        {qm.adaptiveScoreAdjustment !== 0 && (
                          <div className={`flex items-center gap-2 p-2 rounded-md border ${qm.adaptiveScoreAdjustment > 0 ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"}`} data-testid={`text-adjustment-${qm.agentId}`}>
                            <Zap className="h-3 w-3 shrink-0" />
                            <span className="text-[10px]">Adaptive Score Adjustment:</span>
                            <span className={`text-xs font-mono font-bold ${qm.adaptiveScoreAdjustment > 0 ? "text-emerald-500" : "text-red-500"}`}>
                              {qm.adaptiveScoreAdjustment > 0 ? "+" : ""}{qm.adaptiveScoreAdjustment.toFixed(1)}
                            </span>
                            <span className="text-[9px] text-muted-foreground ml-auto">
                              {qm.adaptiveScoreAdjustment > 0 ? "Boosted by recent performance" : "Penalized by recent losses"}
                            </span>
                          </div>
                        )}

                        {qm.regimeBlocking && qm.regimeBlocking.length > 0 && (
                          <div className="space-y-1.5">
                            <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Regime Blocking</p>
                            <div className="space-y-1">
                              {qm.regimeBlocking.map((rb) => {
                                const winColor = rb.winRate >= 0.5 ? "text-emerald-500" : rb.winRate >= 0.35 ? "text-amber-500" : "text-red-500";
                                return (
                                  <div
                                    key={`${rb.regime}-${rb.side}`}
                                    className={`flex items-center gap-2 p-1.5 rounded-md border ${rb.blocked ? "border-red-500/30 bg-red-500/5" : "border-border/20 bg-muted/30"}`}
                                    data-testid={`regime-block-${rb.regime}-${rb.side}-${qm.agentId}`}
                                  >
                                    <span className="text-[10px] font-mono font-medium">{rb.regime} + {rb.side}</span>
                                    <span className={`text-[10px] font-mono font-bold ${winColor}`}>{(rb.winRate * 100).toFixed(0)}%</span>
                                    {rb.blocked && <Badge variant="destructive" className="text-[7px]">BLOCKED</Badge>}
                                    <span className="text-[8px] text-muted-foreground ml-auto">{rb.samples} samples</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 space-y-3">
                <div className="w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center">
                  <Gauge className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-xs text-muted-foreground">No quality metrics available yet. Trade data is needed to generate quality scores.</p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="about" className="mt-3 space-y-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Brain className="h-4 w-4 text-primary" />
                  How the Learning Engine Works
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground leading-relaxed space-y-3">
                <p>
                  The Learning Engine uses <span className="text-foreground font-medium">reinforcement learning</span> principles
                  to continuously improve trading performance. Every closed position is analyzed to compute a reward score, which
                  updates the system's policy weights.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="p-2.5 rounded-md bg-muted/50 space-y-1">
                    <p className="text-[10px] font-medium text-foreground flex items-center gap-1">
                      <Cpu className="h-3 w-3 text-primary" />
                      EWMA Reward Scoring
                    </p>
                    <p className="text-[10px]">
                      Exponentially Weighted Moving Average with alpha=0.15. Recent outcomes are weighted more heavily,
                      allowing fast adaptation to changing market conditions while retaining long-term knowledge.
                    </p>
                  </div>
                  <div className="p-2.5 rounded-md bg-muted/50 space-y-1">
                    <p className="text-[10px] font-medium text-foreground flex items-center gap-1">
                      <Target className="h-3 w-3 text-primary" />
                      UCB Bandit Algorithm
                    </p>
                    <p className="text-[10px]">
                      Upper Confidence Bound (C=1.5) balances exploration of untested strategies with exploitation of
                      proven winners. This prevents the engine from getting stuck on suboptimal patterns.
                    </p>
                  </div>
                </div>

                <div className="p-2.5 rounded-md bg-muted/50 space-y-1">
                  <p className="text-[10px] font-medium text-foreground flex items-center gap-1">
                    <Zap className="h-3 w-3 text-primary" />
                    Entry Pattern Feedback
                  </p>
                  <p className="text-[10px]">
                    Tracks win rates per regime+side combination (e.g., TREND+long, RANGE+short). Combos with less than
                    35% win rate receive a score penalty. Combos below 20% win rate with 10+ samples are blocked entirely,
                    preventing the engine from repeating failed strategies.
                  </p>
                </div>

                <div className="p-2.5 rounded-md bg-muted/50 space-y-1">
                  <p className="text-[10px] font-medium text-foreground flex items-center gap-1">
                    <Activity className="h-3 w-3 text-primary" />
                    Reward Composition
                  </p>
                  <div className="grid grid-cols-2 gap-1.5 mt-1">
                    <div className="text-[9px]"><span className="text-emerald-500">+2.5</span> Successful close</div>
                    <div className="text-[9px]"><span className="text-emerald-500">+1.0</span> PnL {"> "}0.5 SUI</div>
                    <div className="text-[9px]"><span className="text-emerald-500">+0.5</span> Fast execution {"<"}3s</div>
                    <div className="text-[9px]"><span className="text-emerald-500">+0.3</span> Low slippage {"<"}20bps</div>
                    <div className="text-[9px]"><span className="text-red-500">-2.5</span> Failed close</div>
                    <div className="text-[9px]"><span className="text-red-500">-1.0</span> PnL {"< "}-0.5 SUI</div>
                    <div className="text-[9px]"><span className="text-red-500">-0.3</span> Slow execution {">"}30s</div>
                    <div className="text-[9px]"><span className="text-red-500">-0.5</span> High slippage {">"}100bps</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
