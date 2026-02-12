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
  const [showIframe, setShowIframe] = useState(true);
  const [iframeLoaded, setIframeLoaded] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!iframeLoaded) {
        setShowIframe(false);
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, [iframeLoaded]);

  return (
    <Card data-testid="card-sudo-chart">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">SUI-PERP 15m Chart</CardTitle>
        <a
          href="https://app.sudo.finance/trade"
          target="_blank"
          rel="noreferrer"
          data-testid="link-sudo-chart"
        >
          <Button size="sm" variant="outline">
            <ExternalLink className="h-3 w-3 mr-1" />
            Sudo Finance
          </Button>
        </a>
      </CardHeader>
      <CardContent>
        {showIframe ? (
          <div className="w-full aspect-[16/9] max-h-[400px] rounded-md overflow-hidden bg-muted relative">
            {!iframeLoaded && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center space-y-2">
                  <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
                  <p className="text-xs text-muted-foreground">Loading chart...</p>
                </div>
              </div>
            )}
            <iframe
              title="Sudo 15m chart"
              src="https://app.sudo.finance/trade"
              className="w-full h-full border-0"
              onLoad={() => setIframeLoaded(true)}
              onError={() => setShowIframe(false)}
              sandbox="allow-scripts allow-same-origin"
            />
          </div>
        ) : (
          <div className="w-full aspect-[16/9] max-h-[200px] rounded-md bg-muted flex items-center justify-center">
            <div className="text-center space-y-2">
              <BarChart3 className="h-6 w-6 text-muted-foreground mx-auto" />
              <p className="text-xs text-muted-foreground">
                Chart embed unavailable
              </p>
              <a
                href="https://app.sudo.finance/trade"
                target="_blank"
                rel="noreferrer"
              >
                <Button size="sm" variant="outline">
                  <ExternalLink className="h-3 w-3 mr-1" />
                  Open on Sudo Finance
                </Button>
              </a>
            </div>
          </div>
        )}
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
      <div className="p-4 md:p-6 space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
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
    <div className="p-4 md:p-6 space-y-4" data-testid="page-market-dashboard">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="space-y-0.5">
          <h2 className="text-lg md:text-xl font-bold tracking-tight">Market Dashboard</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">SUI-PERP</span>
            <Badge variant="outline" className="text-[10px] gap-1" data-testid="badge-price-source">
              <Radio className="h-2.5 w-2.5" />
              {priceSource === "pyth" ? "Pyth Oracle" : priceSource === "sudo" ? "Sudo Finance" : "Simulated"}
            </Badge>
            {livePrice && (
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-[10px] text-muted-foreground">Live</span>
              </div>
            )}
          </div>
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card data-testid="stat-price">
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[10px] text-muted-foreground mb-1">Price</p>
            <p className="text-lg font-bold font-mono" data-testid="stat-price-value">
              ${(marketData?.price ?? 0).toFixed(4)}
            </p>
            <p className={`text-[10px] mt-0.5 ${change >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {change >= 0 ? "+" : ""}{change.toFixed(2)}%
            </p>
          </CardContent>
        </Card>
        <Card data-testid="stat-high">
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[10px] text-muted-foreground mb-1">24h High</p>
            <p className="text-lg font-bold font-mono" data-testid="stat-high-value">
              ${(marketData?.high24h ?? 0).toFixed(4)}
            </p>
          </CardContent>
        </Card>
        <Card data-testid="stat-low">
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[10px] text-muted-foreground mb-1">24h Low</p>
            <p className="text-lg font-bold font-mono" data-testid="stat-low-value">
              ${(marketData?.low24h ?? 0).toFixed(4)}
            </p>
          </CardContent>
        </Card>
        <Card data-testid="stat-volume">
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[10px] text-muted-foreground mb-1">24h Volume</p>
            <p className="text-lg font-bold font-mono" data-testid="stat-volume-value">
              ${((marketData?.volume24h ?? 0) / 1e6).toFixed(1)}M
            </p>
          </CardContent>
        </Card>
      </div>

      {livePrice && (
        <div className="flex items-center gap-4 px-1 flex-wrap" data-testid="card-price-sources">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Blended:</span>
            <span className="font-mono font-medium">${livePrice.blended?.toFixed(4)}</span>
          </div>
          {livePrice.pyth && (
            <div className="flex items-center gap-1.5 text-xs" data-testid="text-pyth-price">
              <Badge variant="outline" className="text-[10px]">Pyth</Badge>
              <span className="font-mono">${livePrice.pyth.price?.toFixed(4)}</span>
            </div>
          )}
          {livePrice.sudo && (
            <div className="flex items-center gap-1.5 text-xs" data-testid="text-sudo-price">
              <Badge variant="outline" className="text-[10px]">Sudo</Badge>
              <span className="font-mono">${livePrice.sudo.price?.toFixed(4)}</span>
            </div>
          )}
        </div>
      )}

      <Card data-testid="chart-price">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Price</CardTitle>
          <Badge variant="outline" className="text-[10px] font-mono">SUI-PERP</Badge>
        </CardHeader>
        <CardContent>
          <div className="h-48 md:h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={priceHistory || []}>
                <defs>
                  <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={cc.chart1} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={cc.chart1} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={cc.border} />
                <XAxis dataKey="time" tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} domain={["auto", "auto"]} tickFormatter={(v: number) => `$${v.toFixed(2)}`} width={50} />
                <RechartsTooltip
                  contentStyle={{ backgroundColor: cc.bg, border: `1px solid ${cc.border}`, borderRadius: "6px", fontSize: "11px" }}
                  labelStyle={{ color: cc.muted }}
                  formatter={(value: number) => [`$${value.toFixed(4)}`, "Price"]}
                />
                <Area type="monotone" dataKey="price" stroke={cc.chart1} strokeWidth={1.5} fill="url(#priceGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <SudoChartEmbed />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card data-testid="chart-rsi">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">RSI / Connors RSI</CardTitle>
            {latestSignal && (
              <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
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
                  <XAxis dataKey="time" tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} interval="preserveStartEnd" />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} width={28} />
                  <RechartsTooltip
                    contentStyle={{ backgroundColor: cc.bg, border: `1px solid ${cc.border}`, borderRadius: "6px", fontSize: "11px" }}
                    formatter={(value: number, name: string) => [value.toFixed(1), name === "rsi" ? "RSI" : "Connors RSI"]}
                  />
                  <ReferenceLine y={70} stroke={cc.chart5} strokeDasharray="3 3" strokeOpacity={0.4} />
                  <ReferenceLine y={30} stroke={cc.chart3} strokeDasharray="3 3" strokeOpacity={0.4} />
                  <Line type="monotone" dataKey="rsi" stroke={cc.chart4} strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey="connorsRsi" stroke={cc.chart6} strokeWidth={1.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{ background: cc.chart4 }} />
                <span className="text-[10px] text-muted-foreground">RSI 14</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{ background: cc.chart6 }} />
                <span className="text-[10px] text-muted-foreground">Connors RSI</span>
              </div>
              <span className="text-[10px] text-muted-foreground font-mono ml-auto">OB:70 / OS:30</span>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="chart-ema">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">EMA / DEMA / TEMA</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-40 md:h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={indicatorData || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke={cc.border} />
                  <XAxis dataKey="time" tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} domain={["auto", "auto"]} tickFormatter={(v: number) => `$${v.toFixed(2)}`} width={50} />
                  <RechartsTooltip
                    contentStyle={{ backgroundColor: cc.bg, border: `1px solid ${cc.border}`, borderRadius: "6px", fontSize: "11px" }}
                    formatter={(value: number, name: string) => {
                      const labels: Record<string, string> = { ema9: "EMA 9", ema21: "EMA 21", dema20: "DEMA 20", tema20: "TEMA 20" };
                      return [`$${value.toFixed(4)}`, labels[name] || name];
                    }}
                  />
                  <Line type="monotone" dataKey="ema9" stroke={cc.chart3} strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey="ema21" stroke={cc.chart5} strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey="dema20" stroke={cc.chart2} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                  <Line type="monotone" dataKey="tema20" stroke={cc.chart6} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{ background: cc.chart3 }} />
                <span className="text-[10px] text-muted-foreground">EMA9</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{ background: cc.chart5 }} />
                <span className="text-[10px] text-muted-foreground">EMA21</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{ background: cc.chart2 }} />
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
          <div className="h-28 md:h-36">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={priceHistory || []}>
                <CartesianGrid strokeDasharray="3 3" stroke={cc.border} />
                <XAxis dataKey="time" tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} tickFormatter={(v: number) => `${(v / 1e3).toFixed(0)}K`} width={36} />
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
            <Zap className="h-3.5 w-3.5 text-primary" />
            Signal Feed
          </CardTitle>
          <Badge variant="outline" className="text-[10px]">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5 animate-pulse" />
            Live
          </Badge>
        </CardHeader>
        <CardContent>
          {signalsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          ) : (
            <div className="space-y-0.5 max-h-56 overflow-y-auto">
              {(signals || []).slice(0, 8).map((s, i) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between py-1.5 border-b border-border last:border-0 gap-2"
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
                <div className="text-center py-6 text-muted-foreground text-xs">
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
