import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TrendingUp,
  TrendingDown,
  Activity,
  BarChart3,
  Zap,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
} from "lucide-react";
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";
import type { Signal, MarketData } from "@shared/schema";
import { usePageSEO } from "@/lib/seo";

function SignalBadge({ signal }: { signal: string }) {
  const config: Record<string, { variant: string; icon: React.ReactNode; label: string }> = {
    strong_long: { variant: "default", icon: <TrendingUp className="h-3 w-3" />, label: "Strong Long" },
    weak_long: { variant: "default", icon: <ArrowUpRight className="h-3 w-3" />, label: "Weak Long" },
    strong_short: { variant: "destructive", icon: <TrendingDown className="h-3 w-3" />, label: "Strong Short" },
    weak_short: { variant: "destructive", icon: <ArrowDownRight className="h-3 w-3" />, label: "Weak Short" },
    no_trade: { variant: "secondary", icon: <Minus className="h-3 w-3" />, label: "No Trade" },
  };
  const c = config[signal] || config.no_trade;
  return (
    <Badge variant={c.variant as any} data-testid={`badge-signal-${signal}`}>
      {c.icon}
      <span className="ml-1">{c.label}</span>
    </Badge>
  );
}

function StatCard({
  title,
  value,
  subtitle,
  icon,
  trend,
  testId,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ReactNode;
  trend?: "up" | "down" | "neutral";
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{title}</CardTitle>
        <div className="text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold font-mono" data-testid={`${testId}-value`}>{value}</div>
        {subtitle && (
          <p className={`text-xs mt-1 ${
            trend === "up" ? "text-emerald-500" : trend === "down" ? "text-red-500" : "text-muted-foreground"
          }`}>
            {trend === "up" && <TrendingUp className="inline h-3 w-3 mr-1" />}
            {trend === "down" && <TrendingDown className="inline h-3 w-3 mr-1" />}
            {subtitle}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function MarketDashboard() {
  const { data: marketData, isLoading: marketLoading } = useQuery<MarketData>({
    queryKey: ["/api/market"],
    refetchInterval: 5000,
  });

  const { data: signals, isLoading: signalsLoading } = useQuery<Signal[]>({
    queryKey: ["/api/signals"],
    refetchInterval: 5000,
  });

  const { data: priceHistory } = useQuery<Array<{ time: string; price: number; volume: number }>>({
    queryKey: ["/api/market/history"],
    refetchInterval: 10000,
  });

  const { data: indicatorData } = useQuery<Array<{ time: string; rsi: number; ema9: number; ema21: number }>>({
    queryKey: ["/api/market/indicators"],
    refetchInterval: 10000,
  });

  usePageSEO({
    title: "Market Dashboard",
    description: "Real-time SUI-PERP market data with RSI, EMA indicators and AI trading signals powered by Lifeguard.sui",
  });

  const latestSignal = signals && signals.length > 0 ? signals[0] : null;

  if (marketLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader className="pb-2"><Skeleton className="h-4 w-24" /></CardHeader>
              <CardContent><Skeleton className="h-8 w-32" /></CardContent>
            </Card>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2"><CardContent className="pt-6"><Skeleton className="h-64 w-full" /></CardContent></Card>
          <Card><CardContent className="pt-6"><Skeleton className="h-64 w-full" /></CardContent></Card>
        </div>
      </div>
    );
  }

  const change = marketData?.change24h ?? 0;
  const trendDir = change >= 0 ? "up" : "down";

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6" data-testid="page-market-dashboard">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Market Dashboard</h2>
          <p className="text-sm text-muted-foreground">SUI-PERP real-time indicators and AI signals</p>
        </div>
        {latestSignal && <SignalBadge signal={latestSignal.signal} />}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <StatCard
          title="SUI-PERP Price"
          value={`$${(marketData?.price ?? 0).toFixed(4)}`}
          subtitle={`${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
          icon={<Activity className="h-4 w-4" />}
          trend={trendDir}
          testId="stat-price"
        />
        <StatCard
          title="24h High"
          value={`$${(marketData?.high24h ?? 0).toFixed(4)}`}
          icon={<TrendingUp className="h-4 w-4" />}
          testId="stat-high"
        />
        <StatCard
          title="24h Low"
          value={`$${(marketData?.low24h ?? 0).toFixed(4)}`}
          icon={<TrendingDown className="h-4 w-4" />}
          testId="stat-low"
        />
        <StatCard
          title="24h Volume"
          value={`$${((marketData?.volume24h ?? 0) / 1e6).toFixed(1)}M`}
          icon={<BarChart3 className="h-4 w-4" />}
          testId="stat-volume"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2" data-testid="chart-price">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Price Chart</CardTitle>
            <Badge variant="outline" className="text-xs font-mono">SUI-PERP</Badge>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={priceHistory || []}>
                  <defs>
                    <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(173, 80%, 40%)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(173, 80%, 40%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(222, 25%, 16%)" />
                  <XAxis
                    dataKey="time"
                    tick={{ fontSize: 10, fill: "hsl(210, 15%, 55%)" }}
                    stroke="hsl(222, 25%, 16%)"
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "hsl(210, 15%, 55%)" }}
                    stroke="hsl(222, 25%, 16%)"
                    domain={["auto", "auto"]}
                    tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                  />
                  <RechartsTooltip
                    contentStyle={{
                      backgroundColor: "hsl(222, 28%, 11%)",
                      border: "1px solid hsl(222, 25%, 16%)",
                      borderRadius: "6px",
                      fontSize: "12px",
                    }}
                    labelStyle={{ color: "hsl(210, 15%, 55%)" }}
                    formatter={(value: number) => [`$${value.toFixed(4)}`, "Price"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="price"
                    stroke="hsl(173, 80%, 40%)"
                    strokeWidth={2}
                    fill="url(#priceGrad)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="chart-volume">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Volume</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={priceHistory || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(222, 25%, 16%)" />
                  <XAxis
                    dataKey="time"
                    tick={{ fontSize: 10, fill: "hsl(210, 15%, 55%)" }}
                    stroke="hsl(222, 25%, 16%)"
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "hsl(210, 15%, 55%)" }}
                    stroke="hsl(222, 25%, 16%)"
                    tickFormatter={(v: number) => `${(v / 1e3).toFixed(0)}K`}
                  />
                  <RechartsTooltip
                    contentStyle={{
                      backgroundColor: "hsl(222, 28%, 11%)",
                      border: "1px solid hsl(222, 25%, 16%)",
                      borderRadius: "6px",
                      fontSize: "12px",
                    }}
                    formatter={(value: number) => [`${value.toLocaleString()}`, "Volume"]}
                  />
                  <Bar dataKey="volume" fill="hsl(199, 85%, 45%)" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card data-testid="chart-rsi">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">RSI (14)</CardTitle>
            {latestSignal && (
              <span className="text-xs font-mono text-muted-foreground">
                {latestSignal.rsi.toFixed(1)}
              </span>
            )}
          </CardHeader>
          <CardContent>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={indicatorData || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(222, 25%, 16%)" />
                  <XAxis
                    dataKey="time"
                    tick={{ fontSize: 10, fill: "hsl(210, 15%, 55%)" }}
                    stroke="hsl(222, 25%, 16%)"
                  />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fontSize: 10, fill: "hsl(210, 15%, 55%)" }}
                    stroke="hsl(222, 25%, 16%)"
                  />
                  <RechartsTooltip
                    contentStyle={{
                      backgroundColor: "hsl(222, 28%, 11%)",
                      border: "1px solid hsl(222, 25%, 16%)",
                      borderRadius: "6px",
                      fontSize: "12px",
                    }}
                    formatter={(value: number) => [value.toFixed(1), "RSI"]}
                  />
                  <Line type="monotone" dataKey="rsi" stroke="hsl(38, 92%, 50%)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground font-mono">
              <span>Oversold (&lt;30)</span>
              <span>Neutral</span>
              <span>Overbought (&gt;70)</span>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="chart-ema">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">EMA Crossover</CardTitle>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-xs text-muted-foreground">EMA 9</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{ background: "hsl(0, 85%, 55%)" }} />
                <span className="text-xs text-muted-foreground">EMA 21</span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={indicatorData || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(222, 25%, 16%)" />
                  <XAxis
                    dataKey="time"
                    tick={{ fontSize: 10, fill: "hsl(210, 15%, 55%)" }}
                    stroke="hsl(222, 25%, 16%)"
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "hsl(210, 15%, 55%)" }}
                    stroke="hsl(222, 25%, 16%)"
                    domain={["auto", "auto"]}
                    tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                  />
                  <RechartsTooltip
                    contentStyle={{
                      backgroundColor: "hsl(222, 28%, 11%)",
                      border: "1px solid hsl(222, 25%, 16%)",
                      borderRadius: "6px",
                      fontSize: "12px",
                    }}
                    formatter={(value: number, name: string) => [
                      `$${value.toFixed(4)}`,
                      name === "ema9" ? "EMA 9" : "EMA 21",
                    ]}
                  />
                  <Line type="monotone" dataKey="ema9" stroke="hsl(142, 70%, 45%)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="ema21" stroke="hsl(0, 85%, 55%)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card data-testid="signal-feed">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            Live Signal Feed
          </CardTitle>
          <Badge variant="outline" className="text-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5 animate-pulse" />
            Live
          </Badge>
        </CardHeader>
        <CardContent>
          {signalsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {(signals || []).slice(0, 10).map((s, i) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between py-2 border-b border-border last:border-0"
                  data-testid={`signal-row-${i}`}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-muted-foreground w-16">
                      {s.createdAt ? new Date(s.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--"}
                    </span>
                    <span className="text-sm font-mono">${s.price.toFixed(4)}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground font-mono">
                      RSI: {s.rsi.toFixed(1)}
                    </span>
                    <SignalBadge signal={s.signal} />
                  </div>
                </div>
              ))}
              {(!signals || signals.length === 0) && (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  Waiting for market signals...
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
