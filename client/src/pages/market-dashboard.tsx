import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  ReferenceLine,
  Cell,
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
  ema7: number;
  ema30: number;
  ema200: number;
  ema9: number;
  ema21: number;
  dema20: number;
  tema20: number;
  macdDif: number;
  macdDea: number;
  macdHist: number;
};

type Candle = {
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function CandlestickChart({ indicators }: { indicators: IndicatorData[] | undefined }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);
  const [hoveredIndicator, setHoveredIndicator] = useState<IndicatorData | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const { data: candles } = useQuery<Candle[]>({
    queryKey: ["/api/market/candles"],
    refetchInterval: 5000,
  });

  const chartMetrics = useMemo(() => {
    if (!candles || candles.length === 0) return null;
    const allHigh = Math.max(...candles.map((c) => c.high));
    const allLow = Math.min(...candles.map((c) => c.low));
    const priceRange = allHigh - allLow || 0.01;
    const tolerance = priceRange * 1.5;

    const emaValues: number[] = [];
    if (indicators && indicators.length > 0) {
      const lo = allLow - tolerance;
      const hi = allHigh + tolerance;
      indicators.forEach((ind) => {
        if (ind.ema7 && ind.ema7 >= lo && ind.ema7 <= hi) emaValues.push(ind.ema7);
        if (ind.ema30 && ind.ema30 >= lo && ind.ema30 <= hi) emaValues.push(ind.ema30);
        if (ind.ema200 && ind.ema200 >= lo && ind.ema200 <= hi) emaValues.push(ind.ema200);
      });
    }

    const combinedHigh = emaValues.length > 0 ? Math.max(allHigh, ...emaValues) : allHigh;
    const combinedLow = emaValues.length > 0 ? Math.min(allLow, ...emaValues) : allLow;
    const padding = (combinedHigh - combinedLow) * 0.08 || 0.01;
    const maxVol = Math.max(...candles.map((c) => c.volume));
    return { allHigh: combinedHigh, allLow: combinedLow, padding, maxVol };
  }, [candles, indicators]);

  const drawChart = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !candles || candles.length === 0 || !chartMetrics) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const marginLeft = 56;
    const marginRight = 8;
    const marginTop = 8;
    const marginBottom = 28;
    const volHeight = 36;
    const chartW = w - marginLeft - marginRight;
    const priceH = h - marginTop - marginBottom - volHeight;

    ctx.clearRect(0, 0, w, h);

    const { allHigh, allLow, padding, maxVol } = chartMetrics;
    const pMin = allLow - padding;
    const pMax = allHigh + padding;
    const pRange = pMax - pMin || 1;

    const toY = (price: number) => marginTop + priceH * (1 - (price - pMin) / pRange);

    const isDark = document.documentElement.classList.contains("dark");
    const gridColor = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)";
    const textColor = isDark ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.4)";
    const bullColor = "#10b981";
    const bearColor = "#ef4444";

    const gridLines = 5;
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    for (let i = 0; i <= gridLines; i++) {
      const y = marginTop + (priceH / gridLines) * i;
      ctx.beginPath();
      ctx.moveTo(marginLeft, y);
      ctx.lineTo(w - marginRight, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.fillStyle = textColor;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "right";
    for (let i = 0; i <= gridLines; i++) {
      const y = marginTop + (priceH / gridLines) * i;
      const price = pMax - (pRange / gridLines) * i;
      ctx.fillText(`$${price.toFixed(4)}`, marginLeft - 6, y + 3);
    }

    const candleCount = candles.length;
    const candleSpacing = chartW / candleCount;
    const candleW = Math.max(4, candleSpacing * 0.7);
    const wickW = Math.max(1, candleW * 0.2);

    candles.forEach((c, i) => {
      const x = marginLeft + candleSpacing * i + candleSpacing / 2;
      const isBull = c.close >= c.open;
      const color = isBull ? bullColor : bearColor;

      ctx.strokeStyle = color;
      ctx.lineWidth = wickW;
      ctx.beginPath();
      ctx.moveTo(x, toY(c.high));
      ctx.lineTo(x, toY(c.low));
      ctx.stroke();

      const bodyTop = toY(Math.max(c.open, c.close));
      const bodyBottom = toY(Math.min(c.open, c.close));
      const bodyH = Math.max(2, bodyBottom - bodyTop);

      ctx.fillStyle = color;
      ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);

      const volBarH = (c.volume / (maxVol || 1)) * volHeight;
      const volY = h - marginBottom - volBarH;
      ctx.fillStyle = isBull
        ? (isDark ? "rgba(16,185,129,0.25)" : "rgba(16,185,129,0.15)")
        : (isDark ? "rgba(239,68,68,0.25)" : "rgba(239,68,68,0.15)");
      ctx.fillRect(x - candleW / 2, volY, candleW, volBarH);
    });

    if (indicators && indicators.length > 1) {
      const emaConfigs = [
        { key: "ema7" as const, color: "#f59e0b", width: 1.5 },
        { key: "ema30" as const, color: "#8b5cf6", width: 1.5 },
        { key: "ema200" as const, color: "#06b6d4", width: 1.5 },
      ];

      ctx.save();
      ctx.beginPath();
      ctx.rect(marginLeft, marginTop, chartW, priceH);
      ctx.clip();

      emaConfigs.forEach(({ key, color, width }) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < candleCount; i++) {
          const indIdx = Math.min(Math.floor(i * indicators.length / candleCount), indicators.length - 1);
          const val = indicators[indIdx]?.[key];
          if (val && val > 0) {
            const x = marginLeft + candleSpacing * i + candleSpacing / 2;
            const y = toY(val);
            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
        }
        ctx.stroke();
      });

      ctx.restore();
    }

    ctx.fillStyle = textColor;
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "center";
    const labelEvery = Math.max(1, Math.floor(candleCount / 6));
    candles.forEach((c, i) => {
      if (i % labelEvery === 0 || i === candleCount - 1) {
        const x = marginLeft + candleSpacing * i + candleSpacing / 2;
        ctx.fillText(c.time, x, h - marginBottom + 14);
      }
    });

    if (hoveredCandle) {
      const idx = candles.findIndex((c) => c.timestamp === hoveredCandle.timestamp);
      if (idx >= 0) {
        const x = marginLeft + candleSpacing * idx + candleSpacing / 2;
        ctx.strokeStyle = isDark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.15)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, marginTop);
        ctx.lineTo(x, h - marginBottom);
        ctx.stroke();

        const closeY = toY(hoveredCandle.close);
        ctx.beginPath();
        ctx.moveTo(marginLeft, closeY);
        ctx.lineTo(w - marginRight, closeY);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }, [candles, chartMetrics, hoveredCandle, indicators]);

  useEffect(() => {
    drawChart();
  }, [drawChart]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => drawChart());
    observer.observe(container);
    return () => observer.disconnect();
  }, [drawChart]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container || !candles || candles.length === 0) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const marginLeft = 56;
      const marginRight = 8;
      const chartW = rect.width - marginLeft - marginRight;
      const candleSpacing = chartW / candles.length;
      const idx = Math.floor((x - marginLeft) / candleSpacing);

      if (idx >= 0 && idx < candles.length) {
        setHoveredCandle(candles[idx]);
        setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        if (indicators && indicators.length > 0) {
          const indIdx = Math.min(Math.floor(idx * indicators.length / candles.length), indicators.length - 1);
          setHoveredIndicator(indicators[indIdx]);
        }
      } else {
        setHoveredCandle(null);
        setHoveredIndicator(null);
      }
    },
    [candles, indicators]
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredCandle(null);
    setHoveredIndicator(null);
  }, []);

  if (!candles || candles.length === 0) {
    return (
      <Card data-testid="card-candle-chart">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">SUI-PERP 15m</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-80 md:h-[28rem] flex items-center justify-center">
            <div className="text-center space-y-2">
              <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-xs text-muted-foreground">Loading candle data...</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles.length > 1 ? candles[candles.length - 2] : lastCandle;
  const candleChange = prevCandle ? ((lastCandle.close - prevCandle.close) / prevCandle.close) * 100 : 0;
  const isBull = lastCandle.close >= lastCandle.open;

  const latestInd = indicators && indicators.length > 0 ? indicators[indicators.length - 1] : null;

  return (
    <Card data-testid="card-candle-chart">
      <CardHeader className="space-y-2 pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <CardTitle className="text-sm font-medium">SUI-PERP</CardTitle>
            <Badge variant="outline" className="text-[10px] font-mono gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              15m
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-mono font-bold" data-testid="text-chart-price">${lastCandle.close.toFixed(4)}</span>
            <Badge
              variant={isBull ? "default" : "destructive"}
              className="text-[10px] font-mono"
              data-testid="badge-chart-change"
            >
              {candleChange >= 0 ? "+" : ""}{candleChange.toFixed(2)}%
            </Badge>
          </div>
        </div>
        {latestInd && (
          <div className="flex items-center gap-3 text-[10px] font-mono flex-wrap" data-testid="ema-legend">
            <span style={{ color: "#f59e0b" }}>EMA(7): {latestInd.ema7?.toFixed(4)}</span>
            <span style={{ color: "#8b5cf6" }}>EMA(30): {latestInd.ema30?.toFixed(4)}</span>
            <span style={{ color: "#06b6d4" }}>EMA(200): {latestInd.ema200?.toFixed(4)}</span>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div ref={containerRef} className="relative h-80 md:h-[28rem]" data-testid="candle-chart-container">
          <canvas
            ref={canvasRef}
            className="w-full h-full cursor-crosshair"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            data-testid="candle-chart-canvas"
          />
          {hoveredCandle && (
            <div
              className="absolute pointer-events-none z-10 rounded-md border border-border bg-card px-2.5 py-1.5 shadow-md"
              style={{
                left: Math.min(tooltipPos.x + 12, (containerRef.current?.clientWidth ?? 300) - 180),
                top: Math.max(8, tooltipPos.y - 90),
              }}
              data-testid="candle-tooltip"
            >
              <p className="text-[10px] text-muted-foreground mb-1">{hoveredCandle.time}</p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono">
                <span className="text-muted-foreground">O</span>
                <span>${hoveredCandle.open.toFixed(4)}</span>
                <span className="text-muted-foreground">H</span>
                <span className="text-emerald-500">${hoveredCandle.high.toFixed(4)}</span>
                <span className="text-muted-foreground">L</span>
                <span className="text-red-500">${hoveredCandle.low.toFixed(4)}</span>
                <span className="text-muted-foreground">C</span>
                <span className={hoveredCandle.close >= hoveredCandle.open ? "text-emerald-500" : "text-red-500"}>
                  ${hoveredCandle.close.toFixed(4)}
                </span>
                <span className="text-muted-foreground">Vol</span>
                <span>{(hoveredCandle.volume / 1e6).toFixed(2)}M</span>
              </div>
              {hoveredIndicator && (
                <div className="mt-1.5 pt-1.5 border-t border-border grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono">
                  <span style={{ color: "#f59e0b" }}>EMA7</span>
                  <span>${hoveredIndicator.ema7?.toFixed(4)}</span>
                  <span style={{ color: "#8b5cf6" }}>EMA30</span>
                  <span>${hoveredIndicator.ema30?.toFixed(4)}</span>
                  <span style={{ color: "#06b6d4" }}>EMA200</span>
                  <span>${hoveredIndicator.ema200?.toFixed(4)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RSIChart({ data, cc }: { data: IndicatorData[]; cc: ReturnType<typeof useChartColors> }) {
  const latestRsi = data.length > 0 ? data[data.length - 1].rsi : null;

  return (
    <Card data-testid="chart-rsi">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">RSI(14)</CardTitle>
        {latestRsi !== null && (
          <span className="text-xs font-mono text-muted-foreground" data-testid="text-rsi-value">
            {latestRsi.toFixed(2)}
          </span>
        )}
      </CardHeader>
      <CardContent>
        <div className="h-32 md:h-40">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke={cc.border} />
              <XAxis dataKey="time" tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} domain={[0, 100]} ticks={[30, 50, 70]} width={30} />
              <RechartsTooltip
                contentStyle={{ backgroundColor: cc.bg, border: `1px solid ${cc.border}`, borderRadius: "6px", fontSize: "11px" }}
                formatter={(value: number) => [value.toFixed(2), "RSI"]}
              />
              <ReferenceLine y={70} stroke={cc.chart5} strokeDasharray="3 3" strokeOpacity={0.5} />
              <ReferenceLine y={30} stroke={cc.chart3} strokeDasharray="3 3" strokeOpacity={0.5} />
              <ReferenceLine y={50} stroke={cc.muted} strokeDasharray="3 3" strokeOpacity={0.3} />
              <Line type="monotone" dataKey="rsi" stroke={cc.chart4} strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center justify-between mt-1 text-[10px] text-muted-foreground font-mono">
          <span>Oversold &lt; 30</span>
          <span>Overbought &gt; 70</span>
        </div>
      </CardContent>
    </Card>
  );
}

function MACDChart({ data, cc }: { data: IndicatorData[]; cc: ReturnType<typeof useChartColors> }) {
  const latest = data.length > 0 ? data[data.length - 1] : null;

  return (
    <Card data-testid="chart-macd">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">MACD</CardTitle>
        {latest && (
          <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground" data-testid="text-macd-values">
            <span style={{ color: "#f59e0b" }}>DIF: {latest.macdDif?.toFixed(4)}</span>
            <span style={{ color: "#06b6d4" }}>DEA: {latest.macdDea?.toFixed(4)}</span>
            <span>MACD: {latest.macdHist?.toFixed(4)}</span>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="h-32 md:h-40">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} barCategoryGap={0} barGap={0}>
              <CartesianGrid strokeDasharray="3 3" stroke={cc.border} />
              <XAxis dataKey="time" tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} width={40} tickFormatter={(v: number) => v.toFixed(4)} />
              <RechartsTooltip
                contentStyle={{ backgroundColor: cc.bg, border: `1px solid ${cc.border}`, borderRadius: "6px", fontSize: "11px" }}
                formatter={(value: number, name: string) => {
                  const labels: Record<string, string> = { macdHist: "MACD", macdDif: "DIF", macdDea: "DEA" };
                  return [value.toFixed(6), labels[name] || name];
                }}
              />
              <ReferenceLine y={0} stroke={cc.muted} strokeOpacity={0.3} />
              <Bar dataKey="macdHist" name="macdHist" maxBarSize={4}>
                {data.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.macdHist >= 0 ? "#10b981" : "#ef4444"} fillOpacity={0.6} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="h-20 md:h-24 -mt-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <XAxis dataKey="time" hide />
              <YAxis hide />
              <Line type="monotone" dataKey="macdDif" stroke="#f59e0b" strokeWidth={1} dot={false} />
              <Line type="monotone" dataKey="macdDea" stroke="#06b6d4" strokeWidth={1} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground -mt-1 flex-wrap">
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded" style={{ backgroundColor: "#f59e0b" }} />
            <span>DIF</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded" style={{ backgroundColor: "#06b6d4" }} />
            <span>DEA</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-1 rounded bg-emerald-500" />
            <span>MACD</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function MarketDashboard() {
  const { data: marketData, isLoading: marketLoading } = useQuery<any>({
    queryKey: ["/api/market"],
    refetchInterval: 5000,
  });

  const { data: signals } = useQuery<Signal[]>({
    queryKey: ["/api/signals"],
    refetchInterval: 5000,
  });

  const { data: indicatorData } = useQuery<IndicatorData[]>({
    queryKey: ["/api/market/indicators"],
    refetchInterval: 10000,
  });

  const livePrice = useLivePrice();

  usePageSEO({
    title: "Market Dashboard",
    description: "Real-time SUI-PERP market data with candlestick charts, EMA, RSI, MACD indicators and AI trading signals on Blue Water Agents",
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
        <Card><CardContent className="pt-6"><Skeleton className="h-64 w-full" /></CardContent></Card>
      </div>
    );
  }

  const change = marketData?.change24h ?? 0;
  const priceSource = marketData?.priceSource || "simulated";

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="page-market-dashboard">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg md:text-xl font-bold tracking-tight">SUI-PERP</h2>
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
          <p className="text-xs text-muted-foreground">Perpetual Contract</p>
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

      <CandlestickChart indicators={indicatorData} />

      {indicatorData && indicatorData.length > 0 && (
        <>
          <RSIChart data={indicatorData} cc={cc} />
          <MACDChart data={indicatorData} cc={cc} />
        </>
      )}
    </div>
  );
}
