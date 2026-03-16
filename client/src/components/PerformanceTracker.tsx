import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, CartesianGrid,
} from "recharts";
import { TrendingDown, TrendingUp, Minus, AlertTriangle, ChevronDown, ChevronUp, Brain } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type Interval = "5m" | "15m" | "30m" | "1h";

interface PerfRow {
  id: number;
  ts: string;
  portfolioValue: number;
  economicValue: number | null;
  netDeposited: number;
  totalPnl: number;
  winRate: number | null;
  openPositions: number | null;
  regime: string | null;
  htfBias: string | null;
  signalScore: number | null;
  signalSide: string | null;
  activeAgents: number | null;
  lossReason: string | null;
  deltaPnl5m: number | null;
  deltaEv5m: number | null;
}

interface AnalysisData {
  topLossReasons: Array<{ reason: string; count: number; totalEvLost: number }>;
  regimePerformance: Array<{ regime: string; avgDeltaEv: number; count: number }>;
  worstPeriods: PerfRow[];
  recentTrend: "improving" | "declining" | "stable";
  recommendation: string;
}

function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(digits);
}

function fmtTs(ts: string, interval: Interval): string {
  const d = new Date(ts);
  if (interval === "1h") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return interval === "5m" || interval === "15m" || interval === "30m"
    ? `${hh}:${min}`
    : `${mm}/${dd} ${hh}:${min}`;
}

const INTERVAL_LABELS: Record<Interval, string> = {
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
};

export function PerformanceTracker({ netDeposited }: { netDeposited: number }) {
  const [interval, setIntervalVal] = useState<Interval>("30m");
  const [showChart, setShowChart] = useState(false);
  const [view, setView] = useState<"ev" | "pnl">("ev");

  const { data: logData, isLoading: logLoading } = useQuery<{
    interval: string;
    count: number;
    rows: PerfRow[];
  }>({
    queryKey: ["/api/performance/log", interval],
    queryFn: () => fetch(`/api/performance/log?interval=${interval}`).then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 55_000,
    enabled: showChart,
  });

  const { data: analysis } = useQuery<AnalysisData>({
    queryKey: ["/api/performance/analysis"],
    queryFn: () => fetch("/api/performance/analysis").then(r => r.json()),
    refetchInterval: 120_000,
    staleTime: 100_000,
  });

  const rows = logData?.rows ?? [];
  const hasData = rows.length >= 2;

  // Build chart data
  const chartData = rows.map(r => ({
    ts: fmtTs(r.ts, interval),
    ev: r.economicValue != null ? Number(r.economicValue.toFixed(3)) : null,
    pv: Number(r.portfolioValue.toFixed(3)),
    pnl: Number(r.totalPnl.toFixed(3)),
    netDep: r.netDeposited,
    deltaEv: r.deltaEv5m,
    regime: r.regime,
    lossReason: r.lossReason,
  }));

  // Recent EV trend
  const latest = rows[rows.length - 1];
  const earliest = rows[0];
  const evDelta = (latest?.economicValue != null && earliest?.economicValue != null)
    ? (latest.economicValue - earliest.economicValue)
    : null;

  const trendIcon = analysis?.recentTrend === "improving"
    ? <TrendingUp className="h-3 w-3 text-emerald-400" />
    : analysis?.recentTrend === "declining"
      ? <TrendingDown className="h-3 w-3 text-red-400" />
      : <Minus className="h-3 w-3 text-muted-foreground" />;

  const trendColor = analysis?.recentTrend === "improving" ? "text-emerald-400"
    : analysis?.recentTrend === "declining" ? "text-red-400"
    : "text-muted-foreground";

  const topReason = analysis?.topLossReasons?.[0];

  return (
    <div className="rounded-xl border border-border/20 bg-card/30 p-3 space-y-2" data-testid="performance-tracker">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Brain className="h-3 w-3 text-teal-400" />
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Performance Tracker</span>
          <div className="flex items-center gap-0.5 ml-1">
            {trendIcon}
            <span className={`text-[9px] font-mono ${trendColor}`}>
              {analysis?.recentTrend ?? "…"}
            </span>
          </div>
        </div>
        <button
          onClick={() => setShowChart(v => !v)}
          className="text-[9px] text-muted-foreground flex items-center gap-0.5 hover:text-foreground transition-colors"
          data-testid="button-toggle-perf-chart"
        >
          {showChart ? <><ChevronUp className="h-3 w-3" />hide</> : <><ChevronDown className="h-3 w-3" />show</>}
        </button>
      </div>

      {/* Top loss reason + recommendation (always visible) */}
      {topReason && (
        <div className="flex items-start gap-1.5 p-2 rounded-lg bg-red-500/5 border border-red-500/20">
          <AlertTriangle className="h-3 w-3 text-red-400 mt-0.5 shrink-0" />
          <div className="space-y-0.5">
            <p className="text-[9px] text-red-400 font-medium">Top loss driver: {topReason.reason}</p>
            <p className="text-[9px] text-muted-foreground">{analysis?.recommendation}</p>
          </div>
        </div>
      )}
      {!topReason && analysis && (
        <p className="text-[9px] text-muted-foreground px-1">{analysis.recommendation}</p>
      )}

      {/* Expandable chart section */}
      {showChart && (
        <div className="space-y-2 pt-1">
          {/* Controls */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-1">
              {(["5m", "15m", "30m", "1h"] as Interval[]).map(iv => (
                <button
                  key={iv}
                  onClick={() => setIntervalVal(iv)}
                  className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${
                    interval === iv
                      ? "bg-teal-500/20 text-teal-400 border border-teal-500/30"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid={`button-interval-${iv}`}
                >
                  {INTERVAL_LABELS[iv]}
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => setView("ev")}
                className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${view === "ev" ? "bg-teal-500/20 text-teal-400 border border-teal-500/30" : "text-muted-foreground"}`}
                data-testid="button-view-ev"
              >
                EV
              </button>
              <button
                onClick={() => setView("pnl")}
                className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${view === "pnl" ? "bg-teal-500/20 text-teal-400 border border-teal-500/30" : "text-muted-foreground"}`}
                data-testid="button-view-pnl"
              >
                PnL
              </button>
            </div>
          </div>

          {/* Chart */}
          {logLoading && (
            <div className="h-32 flex items-center justify-center text-[9px] text-muted-foreground animate-pulse">
              Loading…
            </div>
          )}
          {!logLoading && !hasData && (
            <div className="h-32 flex items-center justify-center text-[9px] text-muted-foreground">
              Collecting data — first snapshot in ~5m
            </div>
          )}
          {!logLoading && hasData && (
            <div className="h-36">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
                  <defs>
                    <linearGradient id="evGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#14b8a6" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                  <XAxis
                    dataKey="ts"
                    tick={{ fontSize: 8, fill: "rgba(255,255,255,0.35)" }}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 8, fill: "rgba(255,255,255,0.35)" }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => v.toFixed(1)}
                    domain={["auto", "auto"]}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 6,
                      fontSize: 9,
                      padding: "4px 8px",
                    }}
                    formatter={(val: number, name: string) => [
                      val != null ? val.toFixed(3) + " SUI" : "—",
                      name === "ev" ? "Economic Value" : name === "pv" ? "Portfolio Value" : "Total PnL",
                    ]}
                    labelStyle={{ color: "rgba(255,255,255,0.5)", fontSize: 8 }}
                  />
                  {/* Net deposited reference line */}
                  <ReferenceLine
                    y={netDeposited}
                    stroke="rgba(255,255,255,0.2)"
                    strokeDasharray="3 3"
                    label={{ value: "Net", fontSize: 8, fill: "rgba(255,255,255,0.3)", position: "insideTopRight" }}
                  />
                  {view === "ev" ? (
                    <>
                      <Area
                        type="monotone"
                        dataKey="ev"
                        stroke="#14b8a6"
                        strokeWidth={1.5}
                        fill="url(#evGrad)"
                        dot={false}
                        connectNulls
                      />
                      <Area
                        type="monotone"
                        dataKey="pv"
                        stroke="rgba(148,163,184,0.5)"
                        strokeWidth={1}
                        fill="none"
                        dot={false}
                        connectNulls
                        strokeDasharray="3 3"
                      />
                    </>
                  ) : (
                    <Area
                      type="monotone"
                      dataKey="pnl"
                      stroke={latest?.totalPnl >= 0 ? "#10b981" : "#f43f5e"}
                      strokeWidth={1.5}
                      fill={`url(#${latest?.totalPnl >= 0 ? "evGrad" : "pnlGrad"})`}
                      dot={false}
                      connectNulls
                    />
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* EV delta summary */}
          {hasData && evDelta !== null && (
            <div className="flex items-center justify-between px-1">
              <span className="text-[8px] text-muted-foreground">
                EV over {interval} period ({rows.length} points)
              </span>
              <span className={`text-[9px] font-mono font-bold ${evDelta >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {fmt(evDelta)} SUI
              </span>
            </div>
          )}

          {/* Regime performance */}
          {(analysis?.regimePerformance?.length ?? 0) > 0 && (
            <div className="space-y-1">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide px-1">EV Δ by regime (24h)</p>
              <div className="flex gap-2 flex-wrap">
                {analysis!.regimePerformance.map(rp => (
                  <div
                    key={rp.regime}
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] border ${
                      rp.avgDeltaEv >= 0
                        ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400"
                        : "border-red-500/30 bg-red-500/5 text-red-400"
                    }`}
                  >
                    <span className="font-medium">{rp.regime}</span>
                    <span className="font-mono">{fmt(rp.avgDeltaEv, 3)}/5m</span>
                    <span className="text-muted-foreground">×{rp.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Learning engine hint */}
          {(analysis?.topLossReasons?.length ?? 0) > 1 && (
            <div className="space-y-1">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide px-1">Top loss drivers (24h)</p>
              {analysis!.topLossReasons.slice(0, 3).map((r, i) => (
                <div key={i} className="flex items-center justify-between px-1.5 py-1 rounded bg-card/60 border border-border/20">
                  <span className="text-[8px] text-muted-foreground flex-1 mr-2">{r.reason}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge variant="outline" className="text-[7px] text-red-400 border-red-400/30 py-0 px-1">
                      {r.count}×
                    </Badge>
                    <span className="text-[8px] font-mono text-red-400">{r.totalEvLost.toFixed(2)} SUI</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
