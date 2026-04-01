import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from "recharts";
import {
  Brain,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Newspaper,
  Activity,
  BarChart2,
  Target,
  Zap,
  Shield,
  Info,
  FlaskConical,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface SentimentSnapshot {
  available: boolean;
  timestamp?: number;
  overallScore?: number;
  btcScore?: number;
  suiScore?: number;
  marketRiskScore?: number;
  eventRiskScore?: number;
  confidence?: number;
  bias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  headlineSummary?: string[];
  keyDrivers?: string[];
  warnings?: string[];
  sourcesUsed?: string[];
  reportText?: string;
  shortSummary?: string;
}

interface AgentEval {
  available: boolean;
  agentId?: string;
  timestamp?: number;
  winRate10?: number;
  winRate25?: number;
  winRate50?: number;
  avgPnl10?: number;
  avgPnlPerRisk10?: number;
  avgSlippageBps10?: number;
  avgLatencyMs10?: number;
  drawdownPct?: number;
  modelCalibrationScore?: number;
  regimeFitScore?: number;
  sideBiasScore?: number;
  executionQualityScore?: number;
  deploymentStatus?: "GREEN" | "YELLOW" | "RED";
  recommendations?: string[];
  sampleCount?: number;
}

interface AgentRecord {
  id: string;
  name: string;
}

interface CalibrationBucket {
  probabilityPct: number;
  label: string;
  total: number;
  actualWinRate: number;
  avgExpectedEdgeBps: number;
}

interface VerdictAccuracy {
  verdict: string;
  total: number;
  winRate: number;
}

interface CalibrationData {
  calibrationBuckets: CalibrationBucket[];
  totalResolved: number;
  overallWinRate: number;
  verdictAccuracy: VerdictAccuracy[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function scoreToPercent(v: number | undefined, min = -1, max = 1): number {
  if (v === undefined) return 50;
  return Math.round(((v - min) / (max - min)) * 100);
}

function formatScore(v: number | undefined): string {
  if (v === undefined) return "—";
  const s = (v * 100).toFixed(0);
  return v > 0 ? `+${s}` : s;
}

function formatPct(v: number | undefined): string {
  if (v === undefined) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function biasColor(bias?: string) {
  if (bias === "BULLISH") return "text-emerald-400";
  if (bias === "BEARISH") return "text-red-400";
  return "text-slate-400";
}

function biasBadgeVariant(bias?: string): "default" | "destructive" | "secondary" | "outline" {
  if (bias === "BULLISH") return "default";
  if (bias === "BEARISH") return "destructive";
  return "secondary";
}

function statusColor(status?: string) {
  if (status === "GREEN") return "text-emerald-400";
  if (status === "YELLOW") return "text-yellow-400";
  if (status === "RED") return "text-red-400";
  return "text-slate-400";
}

function statusBadge(status?: string): "default" | "destructive" | "secondary" | "outline" {
  if (status === "GREEN") return "default";
  if (status === "RED") return "destructive";
  return "secondary";
}

function timeAgo(ts?: number): string {
  if (!ts) return "—";
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ScoreBar({
  label,
  value,
  min = -1,
  max = 1,
  icon: Icon,
}: {
  label: string;
  value: number | undefined;
  min?: number;
  max?: number;
  icon?: React.ElementType;
}) {
  const pct = scoreToPercent(value, min, max);
  const barColor =
    pct > 60 ? "bg-emerald-500" : pct < 40 ? "bg-red-500" : "bg-yellow-500";

  return (
    <div className="space-y-1" data-testid={`score-bar-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          {Icon && <Icon className="h-3 w-3" />}
          {label}
        </span>
        <span className="font-mono font-medium">{formatScore(value)}</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function AgentEvalCard({ agentId, agentName }: { agentId: string; agentName: string }) {
  const { data, isLoading } = useQuery<AgentEval>({
    queryKey: ["/api/evaluations", agentId],
    queryFn: () => apiRequest("GET", `/api/evaluations/${agentId}`).then(r => r.json()),
    staleTime: 60000,
    refetchInterval: 120000,
  });

  const status = data?.deploymentStatus;

  return (
    <Card
      className="border-border/40 bg-card/60"
      data-testid={`card-agent-eval-${agentId}`}
    >
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Brain className="h-3.5 w-3.5 text-teal-400" />
            {agentName}
          </CardTitle>
          {status && (
            <Badge variant={statusBadge(status)} className="text-xs" data-testid={`badge-status-${agentId}`}>
              {status}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {isLoading && (
          <div className="text-xs text-muted-foreground animate-pulse">Evaluating…</div>
        )}
        {!isLoading && !data?.available && (
          <div className="text-xs text-muted-foreground">No evaluation data yet</div>
        )}
        {!isLoading && data?.available && (
          <>
            {/* Win rates */}
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: "W/R 10", v: data.winRate10 },
                { label: "W/R 25", v: data.winRate25 },
                { label: "W/R 50", v: data.winRate50 },
              ].map(({ label, v }) => (
                <div key={label} className="bg-muted/30 rounded-md p-2">
                  <div className="text-[10px] text-muted-foreground">{label}</div>
                  <div
                    className={`text-sm font-bold font-mono ${
                      (v ?? 0) >= 0.5 ? "text-emerald-400" : "text-red-400"
                    }`}
                    data-testid={`text-winrate-${label.replace(/\s/g, "").toLowerCase()}-${agentId}`}
                  >
                    {v !== undefined ? `${(v * 100).toFixed(0)}%` : "—"}
                  </div>
                </div>
              ))}
            </div>

            {/* Quality scores */}
            <div className="space-y-1.5">
              <ScoreBar label="Model Calibration" value={data.modelCalibrationScore} min={0} max={1} icon={Target} />
              <ScoreBar label="Regime Fit" value={data.regimeFitScore} min={0} max={1} icon={BarChart2} />
              <ScoreBar label="Execution Quality" value={data.executionQualityScore} min={0} max={1} icon={Zap} />
              <ScoreBar label="Side Bias" value={data.sideBiasScore} min={0} max={1} icon={Activity} />
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
              <div>
                <span className="block text-[10px] uppercase tracking-wide">Avg PnL</span>
                <span
                  className={`font-mono font-medium ${
                    (data.avgPnl10 ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"
                  }`}
                  data-testid={`text-avgpnl-${agentId}`}
                >
                  {data.avgPnl10 !== undefined ? `${data.avgPnl10.toFixed(3)} SUI` : "—"}
                </span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wide">Drawdown</span>
                <span className="font-mono font-medium text-foreground" data-testid={`text-drawdown-${agentId}`}>
                  {data.drawdownPct !== undefined ? `${(data.drawdownPct * 100).toFixed(1)}%` : "—"}
                </span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wide">Samples</span>
                <span className="font-mono font-medium text-foreground">{data.sampleCount ?? "—"}</span>
              </div>
            </div>

            {/* Recommendations */}
            {data.recommendations && data.recommendations.length > 0 && (
              <div className="space-y-1 pt-1 border-t border-border/30">
                {data.recommendations.slice(0, 3).map((r, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Info className="h-3 w-3 mt-0.5 shrink-0 text-teal-500" />
                    <span>{r}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="text-[10px] text-muted-foreground/50 pt-0.5">
              Updated {timeAgo(data.timestamp)}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function MarketIntel() {
  const queryClient = useQueryClient();
  const [showReport, setShowReport] = useState(false);

  const { data: sentiment, isLoading: sentimentLoading } = useQuery<SentimentSnapshot>({
    queryKey: ["/api/analysis/sentiment"],
    queryFn: () => apiRequest("GET", "/api/analysis/sentiment").then(r => r.json()),
    staleTime: 60000,
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: agentsData } = useQuery<AgentRecord[]>({
    queryKey: ["/api/agents"],
    staleTime: 60000,
  });

  const { data: calibration, isLoading: calibrationLoading } = useQuery<CalibrationData>({
    queryKey: ["/api/win-probability/calibration"],
    queryFn: () => apiRequest("GET", "/api/win-probability/calibration").then(r => r.json()),
    staleTime: 2 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  const refreshMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/analysis/refresh").then(r => r.json()),
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/analysis/sentiment"], { available: true, ...data });
    },
  });

  const agents: AgentRecord[] = agentsData ?? [];

  const BiasIcon =
    sentiment?.bias === "BULLISH"
      ? TrendingUp
      : sentiment?.bias === "BEARISH"
      ? TrendingDown
      : Minus;

  return (
    <div className="min-h-screen bg-background p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Brain className="h-6 w-6 text-teal-400" />
            Market Intelligence
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Analysis agent sentiment, continuous agent evaluations & win probability context
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refreshMut.mutate()}
          disabled={refreshMut.isPending}
          data-testid="button-refresh-sentiment"
          className="gap-1.5"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshMut.isPending ? "animate-spin" : ""}`} />
          {refreshMut.isPending ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {/* ── Analysis Agent Sentiment ───────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Newspaper className="h-4 w-4 text-teal-400" />
          <h2 className="text-base font-semibold">Analysis Agent — Market Sentiment</h2>
          {sentiment?.available && sentiment.timestamp && (
            <span className="text-xs text-muted-foreground ml-auto">{timeAgo(sentiment.timestamp)}</span>
          )}
        </div>

        {sentimentLoading && (
          <Card className="border-border/40 bg-card/60">
            <CardContent className="py-8 text-center text-sm text-muted-foreground animate-pulse">
              Loading sentiment data…
            </CardContent>
          </Card>
        )}

        {!sentimentLoading && !sentiment?.available && (
          <Card className="border-border/40 bg-card/60">
            <CardContent className="py-8 text-center">
              <div className="text-sm text-muted-foreground mb-2">No sentiment data yet</div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => refreshMut.mutate()}
                disabled={refreshMut.isPending}
                data-testid="button-refresh-sentiment-empty"
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Run Analysis
              </Button>
            </CardContent>
          </Card>
        )}

        {!sentimentLoading && sentiment?.available && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {/* Bias card */}
            <Card className="border-border/40 bg-card/60 md:col-span-1" data-testid="card-sentiment-bias">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-medium text-muted-foreground">Overall Bias</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className={`flex items-center gap-2 text-2xl font-bold mb-3 ${biasColor(sentiment.bias)}`}>
                  <BiasIcon className="h-6 w-6" />
                  <span data-testid="text-sentiment-bias">{sentiment.bias ?? "—"}</span>
                </div>
                <div className="space-y-2">
                  <ScoreBar label="Overall Score" value={sentiment.overallScore} icon={Activity} />
                  <ScoreBar label="BTC Signal" value={sentiment.btcScore} icon={TrendingUp} />
                  <ScoreBar label="SUI Signal" value={sentiment.suiScore} icon={BarChart2} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="bg-muted/30 rounded-md p-2">
                    <div className="text-[10px] text-muted-foreground mb-0.5">Market Risk</div>
                    <div
                      className={`font-bold font-mono ${
                        (sentiment.marketRiskScore ?? 0) > 0.6 ? "text-red-400" : "text-emerald-400"
                      }`}
                      data-testid="text-market-risk"
                    >
                      {formatPct(sentiment.marketRiskScore)}
                    </div>
                  </div>
                  <div className="bg-muted/30 rounded-md p-2">
                    <div className="text-[10px] text-muted-foreground mb-0.5">Event Risk</div>
                    <div
                      className={`font-bold font-mono ${
                        (sentiment.eventRiskScore ?? 0) > 0.6 ? "text-red-400" : "text-emerald-400"
                      }`}
                      data-testid="text-event-risk"
                    >
                      {formatPct(sentiment.eventRiskScore)}
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-xs text-muted-foreground flex items-center gap-1">
                  <Shield className="h-3 w-3" />
                  Confidence: {formatPct(sentiment.confidence)}
                </div>
              </CardContent>
            </Card>

            {/* Headlines card */}
            <Card className="border-border/40 bg-card/60" data-testid="card-sentiment-headlines">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-medium text-muted-foreground">Top Headlines</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-2">
                {sentiment.headlineSummary && sentiment.headlineSummary.length > 0 ? (
                  sentiment.headlineSummary.slice(0, 5).map((h, i) => (
                    <div key={i} className="text-xs border-l-2 border-teal-500/40 pl-2 py-0.5 text-muted-foreground leading-relaxed">
                      {h}
                    </div>
                  ))
                ) : (
                  <div className="text-xs text-muted-foreground">No headlines available</div>
                )}
              </CardContent>
            </Card>

            {/* Drivers + Warnings card */}
            <Card className="border-border/40 bg-card/60" data-testid="card-sentiment-drivers">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-medium text-muted-foreground">Key Drivers & Warnings</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                {sentiment.keyDrivers && sentiment.keyDrivers.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">Key Drivers</div>
                    <div className="space-y-1">
                      {sentiment.keyDrivers.slice(0, 4).map((d, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-xs text-emerald-400">
                          <CheckCircle2 className="h-3 w-3 shrink-0" />
                          <span>{d}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {sentiment.warnings && sentiment.warnings.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">Warnings</div>
                    <div className="space-y-1">
                      {sentiment.warnings.slice(0, 3).map((w, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-xs text-yellow-400">
                          <AlertTriangle className="h-3 w-3 shrink-0" />
                          <span>{w}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {sentiment.sourcesUsed && (
                  <div className="text-[10px] text-muted-foreground/50 pt-1 border-t border-border/30">
                    Sources: {sentiment.sourcesUsed.join(", ")}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Short summary + report toggle */}
            {sentiment.shortSummary && (
              <Card className="border-border/40 bg-card/60 md:col-span-2 lg:col-span-3" data-testid="card-sentiment-summary">
                <CardContent className="px-4 py-3">
                  <div className="text-sm text-foreground leading-relaxed">{sentiment.shortSummary}</div>
                  {sentiment.reportText && (
                    <div className="mt-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs text-teal-400 h-auto p-0"
                        onClick={() => setShowReport(v => !v)}
                        data-testid="button-toggle-report"
                      >
                        {showReport ? "Hide full report" : "Show full report →"}
                      </Button>
                      {showReport && (
                        <div className="mt-3 p-3 bg-muted/30 rounded-md text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">
                          {sentiment.reportText}
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </section>

      <Separator className="opacity-30" />

      {/* ── Agent Continuous Evaluations ──────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Activity className="h-4 w-4 text-teal-400" />
          <h2 className="text-base font-semibold">Agent Continuous Evaluations</h2>
          <span className="text-xs text-muted-foreground ml-1">— live performance snapshots</span>
        </div>

        {agents.length === 0 && (
          <Card className="border-border/40 bg-card/60">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No agents deployed yet. Deploy an agent to see evaluations here.
            </CardContent>
          </Card>
        )}

        {agents.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map(agent => (
              <AgentEvalCard key={agent.id} agentId={agent.id} agentName={agent.name} />
            ))}
          </div>
        )}
      </section>

      <Separator className="opacity-30" />

      {/* ── Win Probability Calibration ──────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <FlaskConical className="h-4 w-4 text-teal-400" />
          <h2 className="text-base font-semibold">Model Calibration</h2>
          <span className="text-xs text-muted-foreground ml-1">— predicted win % vs actual win rate</span>
        </div>

        {calibrationLoading && (
          <Card className="border-border/40 bg-card/60">
            <CardContent className="py-8 text-center text-sm text-muted-foreground animate-pulse">Loading calibration data…</CardContent>
          </Card>
        )}

        {!calibrationLoading && (
          <div className="grid gap-4 lg:grid-cols-3">
            {/* Main calibration chart */}
            <Card className="border-border/40 bg-card/60 lg:col-span-2" data-testid="card-calibration-chart">
              <CardHeader className="pb-2 pt-4 px-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Probability Bucket Accuracy
                  </CardTitle>
                  {calibration && (
                    <span className="text-xs text-muted-foreground">{calibration.totalResolved} resolved predictions</span>
                  )}
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {(!calibration || calibration.totalResolved === 0) ? (
                  <div className="text-center py-8 space-y-2">
                    <FlaskConical className="h-8 w-8 text-muted-foreground/30 mx-auto" />
                    <div className="text-sm text-muted-foreground">No resolved predictions yet</div>
                    <div className="text-xs text-muted-foreground/60">
                      Calibration data builds as agents open and close trades. Each trade's predicted probability is compared to the actual outcome.
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={calibration.calibrationBuckets.map(b => ({
                            ...b,
                            expectedPct: b.probabilityPct + 2.5,
                            actualPct: Math.round(b.actualWinRate * 100),
                          }))}
                          margin={{ top: 4, right: 8, left: -16, bottom: 4 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis
                            dataKey="label"
                            tick={{ fontSize: 8, fill: "var(--muted-foreground)" }}
                            interval={0}
                          />
                          <YAxis
                            tickFormatter={(v) => `${v}%`}
                            tick={{ fontSize: 9, fill: "var(--muted-foreground)" }}
                            domain={[0, 100]}
                          />
                          <Tooltip
                            formatter={(value: number, name: string) => [
                              `${value}%`,
                              name === "actualPct" ? "Actual win rate" : "Expected mid",
                            ]}
                            labelFormatter={(label) => `Bucket: ${label}`}
                            contentStyle={{
                              backgroundColor: "var(--card)",
                              border: "1px solid var(--border)",
                              fontSize: 11,
                            }}
                          />
                          <ReferenceLine
                            y={50}
                            stroke="rgba(255,255,255,0.15)"
                            strokeDasharray="4 4"
                          />
                          <Bar dataKey="actualPct" name="Actual Win Rate" radius={[2, 2, 0, 0]}>
                            {calibration.calibrationBuckets.map((b, i) => (
                              <Cell
                                key={i}
                                fill={
                                  b.actualWinRate >= 0.65
                                    ? "#10b981"
                                    : b.actualWinRate >= 0.5
                                    ? "#f59e0b"
                                    : "#ef4444"
                                }
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500 inline-block" /> ≥65% actual</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500 inline-block" /> 50–65% actual</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500 inline-block" /> &lt;50% actual</span>
                      <span className="ml-auto">Bar = actual win rate per predicted probability bucket</span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Verdict accuracy + overall stats */}
            <div className="space-y-4">
              {/* Overall stats */}
              <Card className="border-border/40 bg-card/60" data-testid="card-calibration-overall">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Overall Accuracy</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-3">
                  {(!calibration || calibration.totalResolved === 0) ? (
                    <div className="text-xs text-muted-foreground">No data yet</div>
                  ) : (
                    <>
                      <div className="text-center">
                        <div
                          className={`text-3xl font-bold font-mono ${
                            calibration.overallWinRate >= 0.55 ? "text-emerald-400" : "text-amber-400"
                          }`}
                          data-testid="text-overall-win-rate"
                        >
                          {(calibration.overallWinRate * 100).toFixed(1)}%
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">actual win rate</div>
                      </div>
                      <Separator className="opacity-20" />
                      <div className="space-y-2">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">By Verdict</div>
                        {calibration.verdictAccuracy.map((v) => (
                          <div key={v.verdict} className="flex items-center gap-2" data-testid={`verdict-accuracy-${v.verdict.toLowerCase()}`}>
                            <Badge
                              variant="outline"
                              className={`text-[8px] w-12 justify-center shrink-0 ${
                                v.verdict === "STRONG"
                                  ? "border-emerald-500 text-emerald-400"
                                  : v.verdict === "WEAK"
                                  ? "border-amber-500 text-amber-400"
                                  : "border-red-500 text-red-400"
                              }`}
                            >
                              {v.verdict}
                            </Badge>
                            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${
                                  v.winRate >= 0.65 ? "bg-emerald-500" : v.winRate >= 0.5 ? "bg-amber-500" : "bg-red-500"
                                }`}
                                style={{ width: `${Math.round(v.winRate * 100)}%` }}
                              />
                            </div>
                            <span className="text-[9px] font-mono font-medium shrink-0 w-8 text-right">
                              {(v.winRate * 100).toFixed(0)}%
                            </span>
                            <span className="text-[8px] text-muted-foreground/60 shrink-0">({v.total})</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* How calibration improves quality */}
              <Card className="border-border/40 bg-card/60" data-testid="card-calibration-info">
                <CardContent className="px-4 py-3 text-xs text-muted-foreground space-y-2">
                  <div className="font-medium text-foreground text-xs">How the feedback loop works</div>
                  <p>Every trade opens with a win probability score. When it closes, the actual outcome (WIN/LOSS) is recorded against the prediction.</p>
                  <p>The calibration chart shows whether STRONG predictions (≥72%) actually win more than WEAK ones (55–72%). A well-calibrated model's bars should rise from left to right.</p>
                  <p>The model uses these outcomes to continuously recalibrate its probability estimates, improving trade quality over time.</p>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </section>

      <Separator className="opacity-30" />

      {/* ── Intelligence Legend ──────────────────────────────────────────── */}
      <section>
        <Card className="border-border/40 bg-card/60">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5" />
              How This Works
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs text-muted-foreground">
              <div>
                <div className="font-medium text-foreground mb-1">Analysis Agent</div>
                <p>Polls CoinDesk and CryptoCompare every 5 minutes. Uses keyword scoring to derive BTC, SUI, and overall market bias. Feeds an ±8pt modifier into each trade signal.</p>
              </div>
              <div>
                <div className="font-medium text-foreground mb-1">Continuous Evaluator</div>
                <p>Runs every 10 minutes per agent. Measures rolling win rates (10 / 25 / 50 trades), model calibration, regime fit, side bias, and execution quality. Issues GREEN / YELLOW / RED status.</p>
              </div>
              <div>
                <div className="font-medium text-foreground mb-1">Win Probability Model</div>
                <p>wpm-v1 sigmoid model. Scores each pre-trade setup from features assembled by the Feature Store (market conditions, agent history, signal quality). Cold-start blend with neutral prior until 5+ trades.</p>
              </div>
              <div>
                <div className="font-medium text-foreground mb-1">Risk Management Agent</div>
                <p>Pre-trade gate that checks probability, drawdown, tradability, event risk, and slippage. Can hard-block, reduce size (sizeMultiplier), or reduce leverage (leverageMultiplier).</p>
              </div>
              <div>
                <div className="font-medium text-foreground mb-1">Risk-Adjusted Rewards</div>
                <p>Reward engine replaces flat PnL labels with a multi-component score: edge efficiency, slippage penalty, latency grade, regime bonus, and on-chain verification bonus.</p>
              </div>
              <div>
                <div className="font-medium text-foreground mb-1">Prediction Resolution</div>
                <p>Every open trade stores a predictionId. When the trade closes, the outcome is fed back to the win probability model to update calibration records.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
