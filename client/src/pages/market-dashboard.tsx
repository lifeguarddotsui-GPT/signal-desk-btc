import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Radio,
  ExternalLink,
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
  ReferenceLine,
} from "recharts";
import type { Signal } from "@shared/schema";
import { usePageSEO } from "@/lib/seo";
import { useLivePrice } from "@/lib/ws-context";

function useChartColors() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => setTick((t) => t + 1));
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const root = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const get = (v: string, fb: string) => {
    const raw = root?.getPropertyValue(v).trim();
    return raw ? `hsl(${raw})` : fb;
  };
  return {
    chart1: get("--chart-1", "hsl(173 80% 40%)"),
    chart2: get("--chart-2", "hsl(199 85% 45%)"),
    chart3: get("--chart-3", "hsl(142 70% 45%)"),
    chart4: get("--chart-4", "hsl(38 92% 50%)"),
    chart5: get("--chart-5", "hsl(0 85% 55%)"),
    chart6: get("--chart-6", "hsl(280 70% 55%)"),
    muted: get("--muted-foreground", "hsl(210 15% 55%)"),
    border: get("--border", "hsl(222 25% 16%)"),
    bg: get("--card", "hsl(222 28% 11%)"),
  };
}

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
        <div className="text-lg md:text-2xl font-bold font-mono" data-testid={`${testId}-value`}>{value}</div>
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

type IndicatorData = {
  time: string;
  rsi: number;
  connorsRsi: number;
  ema9: number;
  ema21: number;
  dema20: number;
  tema20: number;
};

function SudoChartEmbed() {
  const [iframeError, setIframeError] = useState(false);

  return (
    <Card data-testid="card-sudo-chart">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">15m SUI Perp Chart</CardTitle>
        <a
          href="https://app.sudo.finance/trade"
          target="_blank"
          rel="noreferrer"
          data-testid="link-sudo-chart"
        >
          <Button size="sm" variant="outline">
            <ExternalLink className="h-3 w-3 mr-1" />
            Open Sudo
          </Button>
        </a>
      </CardHeader>
      <CardContent>
        {!iframeError ? (
          <div className="w-full h-[320px] md:h-[360px] rounded-md overflow-hidden bg-muted">
            <iframe
              title="Sudo 15m chart"
              src="https://app.sudo.finance/trade"
              className="w-full h-full border-0"
              onError={() => setIframeError(true)}
              sandbox="allow-scripts allow-same-origin"
            />
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground mt-2">
          If the chart does not load, Sudo may block embeds. Use "Open Sudo" to view in a new tab.
        </p>
      </CardContent>
    </Card>
  );
}

export default function MarketDashboard() {
  const { data: marketData, isLoading: marketLoading } = useQuery<any>({
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

  const { data: indicatorData } = useQuery<IndicatorData[]>({
    queryKey: ["/api/market/indicators"],
    refetchInterval: 10000,
  });

  const livePrice = useLivePrice();

  usePageSEO({
    title: "Market Dashboard",
    description: "Real-time SUI-PERP market data with RSI, EMA indicators and AI trading signals powered by Lifeguard.sui",
  });

  const latestSignal = signals && signals.length > 0 ? signals[0] : null;
  const cc = useChartColors();

  if (marketLoading) {
    return (
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader className="pb-2"><Skeleton className="h-4 w-20" /></CardHeader>
              <CardContent><Skeleton className="h-6 w-24" /></CardContent>
            </Card>
          ))}
        </div>
        <Card><CardContent className="pt-6"><Skeleton className="h-48 w-full" /></CardContent></Card>
      </div>
    );
  }

  const change = marketData?.change24h ?? 0;
  const trendDir = change >= 0 ? "up" : "down";
  const priceSource = marketData?.priceSource || "simulated";

  return (
    <div className="p-3 md:p-6 space-y-3 md:space-y-4" data-testid="page-market-dashboard">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg md:text-xl font-bold tracking-tight">Market Dashboard</h2>
          <p className="text-xs md:text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
            <span>SUI-PERP real-time indicators</span>
            <Badge variant="outline" className="text-[10px] gap-1" data-testid="badge-price-source">
              <Radio className="h-3 w-3" />
              {priceSource === "pyth" ? "Pyth Oracle" : priceSource === "sudo" ? "Sudo Finance" : "Simulated"}
            </Badge>
          </p>
        </div>
        {latestSignal && (
          <div className="flex items-center gap-2">
            {latestSignal.signalScore && (
              <span className="text-xs font-mono text-muted-foreground" data-testid="text-signal-score">
                {latestSignal.signalScore}
              </span>
            )}
            <SignalBadge signal={latestSignal.signal} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-3">
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

      {livePrice && (
        <Card data-testid="card-price-sources">
          <CardContent className="flex flex-wrap items-center gap-3 py-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground text-xs">Blended:</span>
              <span className="font-mono font-bold text-sm">${livePrice.blended?.toFixed(4)}</span>
            </div>
            {livePrice.pyth && (
              <div className="flex items-center gap-1.5 text-sm" data-testid="text-pyth-price">
                <Badge variant="outline" className="text-[10px]">Pyth</Badge>
                <span className="font-mono text-xs">${livePrice.pyth.price?.toFixed(4)}</span>
              </div>
            )}
            {livePrice.sudo && (
              <div className="flex items-center gap-1.5 text-sm" data-testid="text-sudo-price">
                <Badge variant="outline" className="text-[10px]">Sudo</Badge>
                <span className="font-mono text-xs">${livePrice.sudo.price?.toFixed(4)}</span>
              </div>
            )}
            <div className="ml-auto flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs text-muted-foreground">Live</span>
            </div>
          </CardContent>
        </Card>
      )}

      <SudoChartEmbed />

      <Card data-testid="chart-price">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Price Chart</CardTitle>
          <Badge variant="outline" className="text-xs font-mono">SUI-PERP</Badge>
        </CardHeader>
        <CardContent>
          <div className="h-48 md:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={priceHistory || []}>
                <defs>
                  <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={cc.chart1} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={cc.chart1} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={cc.border} />
                <XAxis dataKey="time" tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} />
                <YAxis tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} domain={["auto", "auto"]} tickFormatter={(v: number) => `$${v.toFixed(2)}`} width={55} />
                <RechartsTooltip
                  contentStyle={{ backgroundColor: cc.bg, border: `1px solid ${cc.border}`, borderRadius: "6px", fontSize: "11px" }}
                  labelStyle={{ color: cc.muted }}
                  formatter={(value: number) => [`$${value.toFixed(4)}`, "Price"]}
                />
                <Area type="monotone" dataKey="price" stroke={cc.chart1} strokeWidth={2} fill="url(#priceGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
        <Card data-testid="chart-rsi">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">RSI / Connors RSI</CardTitle>
            {latestSignal && (
              <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                <span>RSI: {latestSignal.rsi?.toFixed(1)}</span>
                {latestSignal.connorsRsi != null && <span>CRSI: {latestSignal.connorsRsi.toFixed(1)}</span>}
              </div>
            )}
          </CardHeader>
          <CardContent>
            <div className="h-40 md:h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={indicatorData || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke={cc.border} />
                  <XAxis dataKey="time" tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} width={30} />
                  <RechartsTooltip
                    contentStyle={{ backgroundColor: cc.bg, border: `1px solid ${cc.border}`, borderRadius: "6px", fontSize: "11px" }}
                    formatter={(value: number, name: string) => [value.toFixed(1), name === "rsi" ? "RSI" : "Connors RSI"]}
                  />
                  <ReferenceLine y={70} stroke={cc.chart5} strokeDasharray="3 3" strokeOpacity={0.5} />
                  <ReferenceLine y={30} stroke={cc.chart3} strokeDasharray="3 3" strokeOpacity={0.5} />
                  <Line type="monotone" dataKey="rsi" stroke={cc.chart4} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="connorsRsi" stroke={cc.chart6} strokeWidth={1.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-chart-4" />
                <span className="text-[10px] text-muted-foreground">RSI 14</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{ background: cc.chart6 }} />
                <span className="text-[10px] text-muted-foreground">Connors RSI</span>
              </div>
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground font-mono ml-auto">
                <span>OB:70</span>
                <span>OS:30</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="chart-ema">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">EMA / DEMA / TEMA</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-40 md:h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={indicatorData || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke={cc.border} />
                  <XAxis dataKey="time" tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} />
                  <YAxis tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} domain={["auto", "auto"]} tickFormatter={(v: number) => `$${v.toFixed(2)}`} width={55} />
                  <RechartsTooltip
                    contentStyle={{ backgroundColor: cc.bg, border: `1px solid ${cc.border}`, borderRadius: "6px", fontSize: "11px" }}
                    formatter={(value: number, name: string) => {
                      const labels: Record<string, string> = { ema9: "EMA 9", ema21: "EMA 21", dema20: "DEMA 20", tema20: "TEMA 20" };
                      return [`$${value.toFixed(4)}`, labels[name] || name];
                    }}
                  />
                  <Line type="monotone" dataKey="ema9" stroke={cc.chart3} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="ema21" stroke={cc.chart5} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="dema20" stroke={cc.chart2} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                  <Line type="monotone" dataKey="tema20" stroke={cc.chart6} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-chart-3" />
                <span className="text-[10px] text-muted-foreground">EMA9</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-chart-5" />
                <span className="text-[10px] text-muted-foreground">EMA21</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-chart-2" />
                <span className="text-[10px] text-muted-foreground">DEMA</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{ background: cc.chart6 }} />
                <span className="text-[10px] text-muted-foreground">TEMA</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card data-testid="chart-volume">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Volume</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-32 md:h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={priceHistory || []}>
                <CartesianGrid strokeDasharray="3 3" stroke={cc.border} />
                <XAxis dataKey="time" tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} />
                <YAxis tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} tickFormatter={(v: number) => `${(v / 1e3).toFixed(0)}K`} width={40} />
                <RechartsTooltip
                  contentStyle={{ backgroundColor: cc.bg, border: `1px solid ${cc.border}`, borderRadius: "6px", fontSize: "11px" }}
                  formatter={(value: number) => [`${value.toLocaleString()}`, "Volume"]}
                />
                <Bar dataKey="volume" fill={cc.chart2} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="signal-feed">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            Signal Feed
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
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {(signals || []).slice(0, 10).map((s, i) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between py-2 border-b border-border last:border-0 gap-2"
                  data-testid={`signal-row-${i}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                      {s.createdAt ? new Date(s.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--"}
                    </span>
                    <span className="text-xs font-mono">${s.price.toFixed(4)}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] text-muted-foreground font-mono hidden sm:inline">
                      RSI:{s.rsi?.toFixed(0)}
                    </span>
                    {s.signalScore && (
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {s.signalScore}
                      </span>
                    )}
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
