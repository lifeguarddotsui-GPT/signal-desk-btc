import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { usePageSEO } from "@/lib/seo";
import { useQuery } from "@tanstack/react-query";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Brain,
  Cpu,
  Shield,
  Zap,
  Activity,
  Target,
  TrendingUp,
  TrendingDown,
  Gauge,
  Layers,
  Timer,
  AlertTriangle,
  Lock,
  ArrowRightLeft,
  Fuel,
  RefreshCw,
  BarChart3,
  Loader2,
} from "lucide-react";

interface LearningStats {
  outcomes: { label: string; count: number; avgPnl: number }[];
  byRegime: { regime: string; count: number; winRate: number; avgReward: number }[];
  weights: { id: number; market: string; regime: string; actionKey: string; trials: number; wins: number; avgReward: number; updatedAt: string }[];
  recentOutcomes: any[];
  entryStats: { key: string; winRate: number; count: number; avgReward: number }[];
}

function ParamCard({ label, value, color = "text-primary" }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-md bg-muted/50 p-2.5 text-center">
      <p className="text-[8px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-sm font-mono font-bold ${color}`}>{value}</p>
    </div>
  );
}

function SectionIcon({ icon: Icon, color = "text-primary" }: { icon: any; color?: string }) {
  return (
    <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
      <Icon className={`h-4 w-4 ${color}`} />
    </div>
  );
}

export default function SystemGuide() {
  usePageSEO({
    title: "System Guide - Blue Water Agents",
    description: "Comprehensive guide to the Blue Water Agents platform architecture, signal engine, risk management, and on-chain execution.",
  });

  const { data: stats, isLoading } = useQuery<LearningStats>({
    queryKey: ["/api/learning/stats"],
    refetchInterval: 30000,
  });

  const totalTrades = stats?.outcomes?.reduce((s, o) => s + o.count, 0) || 0;
  const successRate = totalTrades > 0
    ? ((stats?.outcomes?.find(o => o.label === "SUCCESS")?.count || 0) / totalTrades * 100)
    : 0;

  return (
    <div className="p-3 md:p-6 space-y-4 max-w-4xl mx-auto" data-testid="page-system-guide">
      <div>
        <h2 className="text-lg md:text-xl font-bold tracking-tight" data-testid="text-guide-title">System Guide</h2>
        <p className="text-xs text-muted-foreground">Architecture, signal engine, risk management, and execution details</p>
      </div>

      <Accordion type="multiple" defaultValue={["architecture", "signal-engine"]} className="space-y-2">
        <AccordionItem value="architecture" className="border rounded-md px-0">
          <AccordionTrigger className="px-4 py-3 hover:no-underline" data-testid="accordion-architecture">
            <div className="flex items-center gap-3">
              <SectionIcon icon={Layers} />
              <div className="text-left">
                <p className="text-sm font-bold">Dual-Agent Architecture</p>
                <p className="text-[10px] text-muted-foreground">Execution Agent + Signal Sub-Agent roles</p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Cpu className="h-4 w-4 text-primary" />
                    Execution Agent
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-xs text-muted-foreground">
                  <p>The main agent responsible for on-chain transaction execution. It manages wallet funds, submits keeper-based orders to Typus DEX, handles gas coin selection, and monitors position lifecycle.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <ParamCard label="Role" value="Executor" />
                    <ParamCard label="Chain" value="SUI Mainnet" />
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Brain className="h-4 w-4 text-primary" />
                    Signal Sub-Agent (Triton)
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-xs text-muted-foreground">
                  <p>Analyzes market data using technical indicators (EMA, RSI, ADX, ATR, Bollinger Bands) and produces scored trade signals. Works independently from execution, enabling modular strategy upgrades.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <ParamCard label="Role" value="Signal Gen" />
                    <ParamCard label="Engine" value="Triton v4" />
                  </div>
                </CardContent>
              </Card>
            </div>
            <div className="p-3 rounded-md bg-muted/30 border border-border/20">
              <div className="flex items-center justify-center gap-3 text-xs">
                <Badge variant="outline" className="font-mono">Market Data</Badge>
                <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" />
                <Badge variant="outline" className="font-mono text-primary">Triton Signal</Badge>
                <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" />
                <Badge variant="outline" className="font-mono">Execution Agent</Badge>
                <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" />
                <Badge variant="outline" className="font-mono text-emerald-500">On-Chain TX</Badge>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="signal-engine" className="border rounded-md px-0">
          <AccordionTrigger className="px-4 py-3 hover:no-underline" data-testid="accordion-signal-engine">
            <div className="flex items-center gap-3">
              <SectionIcon icon={Target} />
              <div className="text-left">
                <p className="text-sm font-bold">Triton Signal Engine</p>
                <p className="text-[10px] text-muted-foreground">Modes, regime detection, scoring formula</p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4 space-y-3">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">The signal engine operates in three modes, each with different score thresholds and risk appetite.</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <Card>
                  <CardContent className="p-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Zap className="h-4 w-4 text-red-500" />
                      <span className="text-sm font-bold">AGGRESSIVE</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground">Lower thresholds, more trades, higher risk tolerance</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <ParamCard label="Weak Score" value="40" color="text-red-500" />
                      <ParamCard label="Strong Score" value="52" color="text-red-500" />
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Target className="h-4 w-4 text-blue-500" />
                      <span className="text-sm font-bold">PRECISION</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground">Higher thresholds, fewer trades, lower risk</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <ParamCard label="Weak Score" value="48" color="text-blue-500" />
                      <ParamCard label="Strong Score" value="60" color="text-blue-500" />
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Gauge className="h-4 w-4 text-primary" />
                      <span className="text-sm font-bold">AUTO</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground">Dynamically selects mode based on market conditions</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <ParamCard label="Mode" value="Dynamic" />
                      <ParamCard label="Adapts" value="Per-Tick" />
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Regime Detection</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <p>Market regime is determined by ADX (Average Directional Index). This classification drives which entry paths and thresholds are applied.</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex items-center gap-2 p-2.5 rounded-md bg-muted/50">
                    <TrendingUp className="h-4 w-4 text-emerald-500 shrink-0" />
                    <div>
                      <p className="text-[10px] font-bold text-foreground">TREND</p>
                      <p className="text-[9px]">ADX &gt; 25 &mdash; directional momentum confirmed</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 p-2.5 rounded-md bg-muted/50">
                    <Activity className="h-4 w-4 text-amber-500 shrink-0" />
                    <div>
                      <p className="text-[10px] font-bold text-foreground">RANGE</p>
                      <p className="text-[9px]">ADX &le; 25 &mdash; sideways, mean-reversion preferred</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Key Thresholds</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <ParamCard label="EMA Dist Max" value="1.8%" />
                  <ParamCard label="RSI Long" value="25-45" color="text-emerald-500" />
                  <ParamCard label="RSI Short" value="55-75" color="text-red-500" />
                  <ParamCard label="ADX Trend" value="> 25" />
                  <ParamCard label="Vol Confirm" value="Required" />
                  <ParamCard label="BB Squeeze" value="0.8x Band" />
                  <ParamCard label="Strong Trend RSI" value="< 22 / > 78" color="text-amber-500" />
                  <ParamCard label="Strong Trend ADX" value="> 30" color="text-amber-500" />
                </div>
              </CardContent>
            </Card>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="risk-management" className="border rounded-md px-0">
          <AccordionTrigger className="px-4 py-3 hover:no-underline" data-testid="accordion-risk-management">
            <div className="flex items-center gap-3">
              <SectionIcon icon={Shield} color="text-amber-500" />
              <div className="text-left">
                <p className="text-sm font-bold">Risk Management</p>
                <p className="text-[10px] text-muted-foreground">Stop-losses, trailing SL, anti-liquidation tiers</p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <TrendingDown className="h-4 w-4 text-amber-500" />
                    Trailing Stop-Loss
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-xs text-muted-foreground">Dynamically tightens as profit grows to lock in gains.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <ParamCard label="Activation" value="+0.30%" color="text-emerald-500" />
                    <ParamCard label="Breakeven" value="+0.15%" color="text-amber-500" />
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <BarChart3 className="h-4 w-4 text-amber-500" />
                    ATR-Based Stop-Loss
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-xs text-muted-foreground">Uses Average True Range for volatility-adaptive stops.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <ParamCard label="ATR Multiplier" value="1.2x" />
                    <ParamCard label="Type" value="Volatility" />
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                  Emergency & Safety Limits
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <ParamCard label="Emergency Close" value="28% Loss" color="text-red-500" />
                  <ParamCard label="Max Collateral Loss" value="20%" color="text-red-500" />
                  <ParamCard label="Age Tightening" value="20% @ 5min" color="text-amber-500" />
                  <ParamCard label="Anti-Liquidation" value="3-Tier" color="text-red-500" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Anti-Liquidation System (3 Tiers)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 p-2 rounded-md bg-amber-500/5 border border-amber-500/20">
                    <Badge className="text-[9px] bg-amber-500">Tier 1</Badge>
                    <span className="text-xs text-muted-foreground">Early warning &mdash; tighten stop-loss parameters</span>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded-md bg-orange-500/5 border border-orange-500/20">
                    <Badge className="text-[9px] bg-orange-500">Tier 2</Badge>
                    <span className="text-xs text-muted-foreground">Urgent &mdash; reduce position size or begin closing</span>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded-md bg-red-500/5 border border-red-500/20">
                    <Badge className="text-[9px] bg-red-500">Tier 3</Badge>
                    <span className="text-xs text-muted-foreground">Critical &mdash; force emergency close to preserve capital</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="learning-engine" className="border rounded-md px-0">
          <AccordionTrigger className="px-4 py-3 hover:no-underline" data-testid="accordion-learning-engine">
            <div className="flex items-center gap-3">
              <SectionIcon icon={Brain} color="text-emerald-500" />
              <div className="text-left">
                <p className="text-sm font-bold">Learning Engine Overview</p>
                <p className="text-[10px] text-muted-foreground">EWMA rewards, UCB bandits, entry feedback</p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4 space-y-3">
            <p className="text-xs text-muted-foreground">The learning engine uses Exponentially Weighted Moving Average (EWMA) reward scoring combined with Upper Confidence Bound (UCB) bandit exploration to optimize trading strategies over time.</p>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <ParamCard label="EWMA Alpha" value="0.15" />
              <ParamCard label="UCB C" value="1.5" />
              <ParamCard label="Penalty Threshold" value="35% WR" color="text-amber-500" />
              <ParamCard label="Block Threshold" value="20% WR" color="text-red-500" />
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Entry Pattern Feedback</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <p>Each entry pattern (regime + side combination) is tracked independently. Poor-performing patterns receive penalties or are blocked entirely.</p>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
                    <Badge variant="outline" className="text-[9px]">Win Rate &ge; 35%</Badge>
                    <span className="text-[10px]">Normal operation, no penalty applied</span>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded-md bg-amber-500/5 border border-amber-500/20">
                    <Badge className="text-[9px] bg-amber-500">Win Rate &lt; 35%</Badge>
                    <span className="text-[10px]">35% penalty applied to signal score</span>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded-md bg-red-500/5 border border-red-500/20">
                    <Badge variant="destructive" className="text-[9px]">Win Rate &lt; 20%</Badge>
                    <span className="text-[10px]">Pattern blocked &mdash; signal rejected entirely</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Reward Composition</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2 p-2 rounded-md bg-muted/50">
                    <span className="text-muted-foreground">Base PnL reward</span>
                    <span className="font-mono text-foreground">pnlSui normalized</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 p-2 rounded-md bg-muted/50">
                    <span className="text-muted-foreground">Chain verification bonus</span>
                    <span className="font-mono text-emerald-500">+0.5</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 p-2 rounded-md bg-muted/50">
                    <span className="text-muted-foreground">Consecutive loss cooldown</span>
                    <span className="font-mono text-red-500">Exponential backoff</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 p-2 rounded-md bg-muted/50">
                    <span className="text-muted-foreground">Risk-adjusted (PnL/Collateral)</span>
                    <span className="font-mono text-foreground">Scaled bonus/penalty</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="on-chain" className="border rounded-md px-0">
          <AccordionTrigger className="px-4 py-3 hover:no-underline" data-testid="accordion-on-chain">
            <div className="flex items-center gap-3">
              <SectionIcon icon={Lock} color="text-blue-500" />
              <div className="text-left">
                <p className="text-sm font-bold">On-Chain Execution</p>
                <p className="text-[10px] text-muted-foreground">Keeper orders, gas management, transaction safety</p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <ArrowRightLeft className="h-4 w-4 text-blue-500" />
                    Keeper-Based Orders
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground space-y-2">
                  <p>Orders are submitted as keeper instructions on the SUI blockchain via Typus DEX. The keeper system ensures atomic execution with built-in slippage protection.</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Fuel className="h-4 w-4 text-blue-500" />
                    Gas Management
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground space-y-2">
                  <p>Two-tier gas policy ensures transactions succeed without overpaying. Normal operations use standard gas, while emergency closes use elevated gas budgets.</p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <RefreshCw className="h-4 w-4 text-blue-500" />
                  Transaction Safety
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <ParamCard label="Dry-Run" value="Preflight" color="text-blue-500" />
                  <ParamCard label="Retries" value="Safe-Execute" color="text-blue-500" />
                  <ParamCard label="Close Cooldown" value="5s" />
                  <ParamCard label="Emergency CD" value="1.5s" color="text-red-500" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Close Timing Parameters</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <ParamCard label="Close Cooldown" value="5s" />
                  <ParamCard label="Emergency Close" value="1.5s" color="text-red-500" />
                  <ParamCard label="Position TTL" value="12s" />
                  <ParamCard label="Retry Gap" value="3s" />
                </div>
              </CardContent>
            </Card>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="live-status" className="border rounded-md px-0">
          <AccordionTrigger className="px-4 py-3 hover:no-underline" data-testid="accordion-live-status">
            <div className="flex items-center gap-3">
              <SectionIcon icon={Activity} color="text-emerald-500" />
              <div className="text-left">
                <p className="text-sm font-bold">Live System Status</p>
                <p className="text-[10px] text-muted-foreground">Real-time engine metrics from learning data</p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4 space-y-3">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  <Card className="bg-gradient-to-br from-primary/10 to-background border-primary/20">
                    <CardContent className="p-3 text-center">
                      <p className="text-[8px] text-muted-foreground uppercase">Total Trades</p>
                      <p className="text-lg font-bold font-mono text-primary" data-testid="text-guide-total-trades">{totalTrades}</p>
                    </CardContent>
                  </Card>
                  <Card className="bg-gradient-to-br from-emerald-500/10 to-background border-emerald-500/20">
                    <CardContent className="p-3 text-center">
                      <p className="text-[8px] text-muted-foreground uppercase">Success Rate</p>
                      <p className="text-lg font-bold font-mono text-emerald-500" data-testid="text-guide-success-rate">{successRate.toFixed(0)}%</p>
                    </CardContent>
                  </Card>
                  <Card className="bg-gradient-to-br from-primary/10 to-background border-primary/20">
                    <CardContent className="p-3 text-center">
                      <p className="text-[8px] text-muted-foreground uppercase">Policy Weights</p>
                      <p className="text-lg font-bold font-mono text-primary" data-testid="text-guide-weights">{stats?.weights?.length || 0}</p>
                    </CardContent>
                  </Card>
                </div>

                {stats?.byRegime && stats.byRegime.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Regime Breakdown</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-1.5">
                        {stats.byRegime.map((r) => (
                          <div key={r.regime} className="flex items-center justify-between gap-2 p-2 rounded-md bg-muted/40">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-[9px] font-mono">{r.regime}</Badge>
                              <span className="text-[10px] text-muted-foreground">{r.count} trades</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className={`text-[10px] font-mono ${r.winRate >= 0.5 ? "text-emerald-500" : r.winRate >= 0.35 ? "text-amber-500" : "text-red-500"}`}>
                                {(r.winRate * 100).toFixed(0)}% win
                              </span>
                              <span className={`text-[10px] font-mono font-bold ${r.avgReward >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                                {r.avgReward >= 0 ? "+" : ""}{r.avgReward.toFixed(3)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                <div className="p-3 rounded-md bg-muted/30 border border-border/20 text-center">
                  <p className="text-[10px] text-muted-foreground">Data refreshes every 30 seconds from the Learning Engine API</p>
                </div>
              </>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}