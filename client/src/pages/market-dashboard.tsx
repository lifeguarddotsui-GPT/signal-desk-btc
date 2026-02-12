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
  Brain,
  ChevronUp,
  ChevronDown,
  Activity,
  BarChart3,
  CircleDot,
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
import type { SignalCondition } from "@shared/indicators";
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
    const marginLeft = 60;
    const marginRight = 12;
    const marginTop = 12;
    const marginBottom = 32;
    const volHeight = 40;
    const chartW = w - marginLeft - marginRight;
    const priceH = h - marginTop - marginBottom - volHeight;

    ctx.clearRect(0, 0, w, h);

    const { allHigh, allLow, padding, maxVol } = chartMetrics;
    const pMin = allLow - padding;
    const pMax = allHigh + padding;
    const pRange = pMax - pMin || 1;

    const toY = (price: number) => marginTop + priceH * (1 - (price - pMin) / pRange);

    const isDark = document.documentElement.classList.contains("dark");
    const gridColor = isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)";
    const textColor = isDark ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.35)";
    const bullColor = "#16a34a";
    const bearColor = "#dc2626";
    const bullColorDim = isDark ? "rgba(22,163,74,0.18)" : "rgba(22,163,74,0.12)";
    const bearColorDim = isDark ? "rgba(220,38,38,0.18)" : "rgba(220,38,38,0.12)";

    const gridLines = 6;
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    for (let i = 0; i <= gridLines; i++) {
      const y = marginTop + (priceH / gridLines) * i;
      ctx.beginPath();
      ctx.moveTo(marginLeft, y);
      ctx.lineTo(w - marginRight, y);
      ctx.stroke();
    }

    ctx.fillStyle = textColor;
    ctx.font = "11px ui-monospace, SFMono-Regular, monospace";
    ctx.textAlign = "right";
    for (let i = 0; i <= gridLines; i++) {
      const y = marginTop + (priceH / gridLines) * i;
      const price = pMax - (pRange / gridLines) * i;
      ctx.fillText(`$${price.toFixed(4)}`, marginLeft - 8, y + 4);
    }

    const candleCount = candles.length;
    const candleSpacing = chartW / candleCount;
    const candleW = Math.max(3, Math.min(candleSpacing * 0.65, 14));
    const wickW = Math.max(1, Math.min(candleW * 0.15, 2));

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
      const bodyH = Math.max(1, bodyBottom - bodyTop);

      if (isBull) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(x - candleW / 2, bodyTop, candleW, bodyH);
        ctx.fillStyle = isDark ? "rgba(22,163,74,0.15)" : "rgba(22,163,74,0.08)";
        ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
      }

      const volBarH = (c.volume / (maxVol || 1)) * volHeight;
      const volY = h - marginBottom - volBarH;
      ctx.fillStyle = isBull ? bullColorDim : bearColorDim;
      ctx.fillRect(x - candleW / 2, volY, candleW, volBarH);
    });

    if (indicators && indicators.length > 1) {
      const emaConfigs = [
        { key: "ema7" as const, color: "#eab308", width: 1.2, dash: [] as number[] },
        { key: "ema30" as const, color: "#a855f7", width: 1.2, dash: [] as number[] },
        { key: "ema200" as const, color: "#06b6d4", width: 1.5, dash: [4, 3] },
      ];

      ctx.save();
      ctx.beginPath();
      ctx.rect(marginLeft, marginTop, chartW, priceH);
      ctx.clip();

      emaConfigs.forEach(({ key, color, width, dash }) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(dash);
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
        ctx.setLineDash([]);
      });

      ctx.restore();
    }

    ctx.fillStyle = textColor;
    ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
    ctx.textAlign = "center";
    const labelEvery = Math.max(1, Math.floor(candleCount / 6));
    candles.forEach((c, i) => {
      if (i % labelEvery === 0 || i === candleCount - 1) {
        const x = marginLeft + candleSpacing * i + candleSpacing / 2;
        ctx.fillText(c.time, x, h - marginBottom + 16);
      }
    });

    if (hoveredCandle) {
      const idx = candles.findIndex((c) => c.timestamp === hoveredCandle.timestamp);
      if (idx >= 0) {
        const x = marginLeft + candleSpacing * idx + candleSpacing / 2;
        ctx.strokeStyle = isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.12)";
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

        ctx.fillStyle = isDark ? "rgba(255,255,255,0.8)" : "rgba(0,0,0,0.8)";
        ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
        ctx.textAlign = "left";
        ctx.fillText(`$${hoveredCandle.close.toFixed(4)}`, w - marginRight + 2, closeY + 3);
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
      const marginLeft = 60;
      const marginRight = 12;
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
          <div className="h-80 md:h-[32rem] flex items-center justify-center">
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

  return (
    <Card data-testid="card-candle-chart" className="overflow-visible">
      <CardHeader className="space-y-2 pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <CardTitle className="text-base font-semibold tracking-tight">SUI-PERP</CardTitle>
            <Badge variant="outline" className="text-[10px] font-mono gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              15m
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xl font-mono font-bold tracking-tight" data-testid="text-chart-price">
              ${lastCandle.close.toFixed(4)}
            </span>
            <Badge
              variant={isBull ? "default" : "destructive"}
              className="text-[10px] font-mono"
              data-testid="badge-chart-change"
            >
              {candleChange >= 0 ? "+" : ""}{candleChange.toFixed(2)}%
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-4 text-[10px] font-mono flex-wrap" data-testid="ema-legend">
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded" style={{ backgroundColor: "#eab308" }} />
            <span className="text-muted-foreground">MA(7)</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded" style={{ backgroundColor: "#a855f7" }} />
            <span className="text-muted-foreground">MA(30)</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded" style={{ backgroundColor: "#06b6d4", borderBottom: "1px dashed #06b6d4" }} />
            <span className="text-muted-foreground">MA(200)</span>
          </div>
          <div className="flex items-center gap-1 ml-auto">
            <BarChart3 className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">Vol</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-2 md:px-4">
        <div ref={containerRef} className="relative h-80 md:h-[32rem]" data-testid="candle-chart-container">
          <canvas
            ref={canvasRef}
            className="w-full h-full cursor-crosshair"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            data-testid="candle-chart-canvas"
          />
          {hoveredCandle && (
            <div
              className="absolute pointer-events-none z-10 rounded-md border border-border bg-card/95 backdrop-blur-sm px-3 py-2 shadow-lg"
              style={{
                left: Math.min(tooltipPos.x + 14, (containerRef.current?.clientWidth ?? 300) - 200),
                top: Math.max(8, tooltipPos.y - 100),
              }}
              data-testid="candle-tooltip"
            >
              <p className="text-[10px] text-muted-foreground mb-1.5 font-medium">{hoveredCandle.time}</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] font-mono">
                <span className="text-muted-foreground">Open</span>
                <span>${hoveredCandle.open.toFixed(4)}</span>
                <span className="text-muted-foreground">High</span>
                <span className="text-emerald-500">${hoveredCandle.high.toFixed(4)}</span>
                <span className="text-muted-foreground">Low</span>
                <span className="text-red-500">${hoveredCandle.low.toFixed(4)}</span>
                <span className="text-muted-foreground">Close</span>
                <span className={hoveredCandle.close >= hoveredCandle.open ? "text-emerald-500" : "text-red-500"}>
                  ${hoveredCandle.close.toFixed(4)}
                </span>
                <span className="text-muted-foreground">Vol</span>
                <span>{(hoveredCandle.volume / 1e6).toFixed(2)}M</span>
              </div>
              {hoveredIndicator && (
                <div className="mt-1.5 pt-1.5 border-t border-border/50 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] font-mono">
                  <span style={{ color: "#eab308" }}>MA(7)</span>
                  <span>${hoveredIndicator.ema7?.toFixed(4)}</span>
                  <span style={{ color: "#a855f7" }}>MA(30)</span>
                  <span>${hoveredIndicator.ema30?.toFixed(4)}</span>
                  <span style={{ color: "#06b6d4" }}>MA(200)</span>
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
  const rsiZone = latestRsi !== null
    ? latestRsi > 70 ? "Overbought" : latestRsi < 30 ? "Oversold" : "Neutral"
    : null;

  return (
    <Card data-testid="chart-rsi">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">RSI(14)</CardTitle>
        </div>
        {latestRsi !== null && (
          <div className="flex items-center gap-2">
            <span
              className={`text-xs font-mono font-medium ${
                latestRsi > 70 ? "text-red-500" : latestRsi < 30 ? "text-emerald-500" : "text-muted-foreground"
              }`}
              data-testid="text-rsi-value"
            >
              {latestRsi.toFixed(1)}
            </span>
            {rsiZone && (
              <Badge
                variant={rsiZone === "Overbought" ? "destructive" : rsiZone === "Oversold" ? "default" : "secondary"}
                className="text-[9px]"
              >
                {rsiZone}
              </Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="h-36 md:h-44">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke={cc.border} />
              <XAxis dataKey="time" tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 9, fill: cc.muted }} stroke={cc.border} domain={[0, 100]} ticks={[30, 50, 70]} width={30} />
              <RechartsTooltip
                contentStyle={{ backgroundColor: cc.bg, border: `1px solid ${cc.border}`, borderRadius: "6px", fontSize: "11px" }}
                formatter={(value: number) => [value.toFixed(2), "RSI"]}
              />
              <ReferenceLine y={70} stroke="#dc2626" strokeDasharray="3 3" strokeOpacity={0.4} label={{ value: "70", position: "right", fill: "#dc2626", fontSize: 9 }} />
              <ReferenceLine y={30} stroke="#16a34a" strokeDasharray="3 3" strokeOpacity={0.4} label={{ value: "30", position: "right", fill: "#16a34a", fontSize: 9 }} />
              <ReferenceLine y={50} stroke={cc.muted} strokeDasharray="3 3" strokeOpacity={0.2} />
              <Line type="monotone" dataKey="rsi" stroke={cc.chart4} strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function MACDChart({ data, cc }: { data: IndicatorData[]; cc: ReturnType<typeof useChartColors> }) {
  const latest = data.length > 0 ? data[data.length - 1] : null;
  const macdTrend = latest ? (latest.macdHist > 0 ? "Bullish" : "Bearish") : null;

  return (
    <Card data-testid="chart-macd">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">MACD(12,26,9)</CardTitle>
        </div>
        {latest && (
          <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground" data-testid="text-macd-values">
            <span style={{ color: "#eab308" }}>DIF {latest.macdDif?.toFixed(4)}</span>
            <span style={{ color: "#06b6d4" }}>DEA {latest.macdDea?.toFixed(4)}</span>
            {macdTrend && (
              <Badge variant={macdTrend === "Bullish" ? "default" : "destructive"} className="text-[9px]">
                {macdTrend}
              </Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="h-36 md:h-44">
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
              <Bar dataKey="macdHist" name="macdHist" maxBarSize={5}>
                {data.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.macdHist >= 0 ? "#16a34a" : "#dc2626"} fillOpacity={0.65} />
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
              <Line type="monotone" dataKey="macdDif" stroke="#eab308" strokeWidth={1} dot={false} />
              <Line type="monotone" dataKey="macdDea" stroke="#06b6d4" strokeWidth={1} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground -mt-1 flex-wrap">
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded" style={{ backgroundColor: "#eab308" }} />
            <span>DIF</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded" style={{ backgroundColor: "#06b6d4" }} />
            <span>DEA</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-1 rounded bg-emerald-500" />
            <span>Histogram</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ConditionRow({ condition }: { condition: SignalCondition }) {
  const dirColors = {
    long: "text-emerald-500",
    short: "text-red-500",
    neutral: "text-muted-foreground",
  };
  const dirIcons = {
    long: <ChevronUp className="h-3.5 w-3.5 text-emerald-500" />,
    short: <ChevronDown className="h-3.5 w-3.5 text-red-500" />,
    neutral: <Minus className="h-3.5 w-3.5 text-muted-foreground" />,
  };

  return (
    <div className="flex items-start gap-3 py-2" data-testid={`condition-${condition.name.replace(/\s+/g, '-').toLowerCase()}`}>
      <div className="mt-0.5 flex-shrink-0">
        {condition.met ? (
          <CircleDot className={`h-4 w-4 ${condition.direction === "long" ? "text-emerald-500" : condition.direction === "short" ? "text-red-500" : "text-muted-foreground"}`} />
        ) : (
          <CircleDot className="h-4 w-4 text-muted-foreground/30" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium">{condition.name}</span>
          {dirIcons[condition.direction]}
          <Badge
            variant={condition.direction === "long" ? "default" : condition.direction === "short" ? "destructive" : "secondary"}
            className="text-[9px] ml-auto"
          >
            {condition.direction === "long" ? "LONG" : condition.direction === "short" ? "SHORT" : "NEUTRAL"}
          </Badge>
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{condition.description}</p>
        <div className="flex items-center gap-3 mt-1 text-[10px] font-mono">
          <span className={dirColors[condition.direction]}>Value: {condition.value}</span>
          <span className="text-muted-foreground/70">Threshold: {condition.threshold}</span>
        </div>
      </div>
    </div>
  );
}

function SignalReasoningPanel() {
  const { data: reasoning } = useQuery<SignalReasoning>({
    queryKey: ["/api/signals/reasoning"],
    refetchInterval: 5000,
  });

  if (!reasoning || !reasoning.available || !reasoning.conditions) {
    return (
      <Card data-testid="card-signal-reasoning">
        <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-2">
          <Brain className="h-4 w-4 text-primary" />
          <CardTitle className="text-sm font-medium">AI Signal Reasoning</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="text-center space-y-2">
              <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-xs text-muted-foreground">Waiting for signal analysis...</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const totalConditions = reasoning.conditions.length;
  const longCount = reasoning.conditions.filter((c) => c.direction === "long").length;
  const shortCount = reasoning.conditions.filter((c) => c.direction === "short").length;
  const neutralCount = reasoning.conditions.filter((c) => c.direction === "neutral").length;

  return (
    <Card data-testid="card-signal-reasoning">
      <CardHeader className="space-y-3 pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm font-medium">AI Signal Reasoning</CardTitle>
          </div>
          <SignalBadge signal={reasoning.signal || "no_trade"} />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">Signal Score: <span className="font-mono font-medium text-foreground">{reasoning.reason}</span></span>
            <span className="text-muted-foreground">{totalConditions} conditions evaluated</span>
          </div>

          <div className="flex gap-1 h-2 rounded-full overflow-hidden" data-testid="signal-score-bar">
            {longCount > 0 && (
              <div
                className="bg-emerald-500 rounded-full transition-all duration-500"
                style={{ width: `${(longCount / totalConditions) * 100}%` }}
              />
            )}
            {neutralCount > 0 && (
              <div
                className="bg-muted-foreground/30 rounded-full transition-all duration-500"
                style={{ width: `${(neutralCount / totalConditions) * 100}%` }}
              />
            )}
            {shortCount > 0 && (
              <div
                className="bg-red-500 rounded-full transition-all duration-500"
                style={{ width: `${(shortCount / totalConditions) * 100}%` }}
              />
            )}
          </div>

          <div className="flex items-center gap-4 text-[10px]">
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="text-muted-foreground">Long ({longCount})</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />
              <span className="text-muted-foreground">Neutral ({neutralCount})</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-red-500" />
              <span className="text-muted-foreground">Short ({shortCount})</span>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <div className="divide-y divide-border/50" data-testid="conditions-list">
          {reasoning.conditions.map((condition, i) => (
            <ConditionRow key={i} condition={condition} />
          ))}
        </div>

        <div className="mt-4 pt-3 border-t border-border/50">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            {reasoning.side === "long" && (
              <>Analysis indicates <span className="text-emerald-500 font-medium">bullish conditions</span> with {longCount} of {totalConditions} indicators favoring long positions. Momentum strategy requires 4+ aligned conditions to generate a trade signal.</>
            )}
            {reasoning.side === "short" && (
              <>Analysis indicates <span className="text-red-500 font-medium">bearish conditions</span> with {shortCount} of {totalConditions} indicators favoring short positions. Momentum strategy requires 4+ aligned conditions to generate a trade signal.</>
            )}
            {reasoning.side === "flat" && (
              <>Analysis shows <span className="text-muted-foreground font-medium">mixed conditions</span> with no clear directional bias. Conditions are split L{reasoning.longScore}/S{reasoning.shortScore}. Waiting for stronger alignment before generating a signal.</>
            )}
          </p>
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
            <p className="text-lg font-bold font-mono text-emerald-500" data-testid="stat-high-value">
              ${(marketData?.high24h ?? 0).toFixed(4)}
            </p>
          </CardContent>
        </Card>
        <Card data-testid="stat-low">
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[10px] text-muted-foreground mb-1">24h Low</p>
            <p className="text-lg font-bold font-mono text-red-500" data-testid="stat-low-value">
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {indicatorData && indicatorData.length > 0 && (
          <>
            <RSIChart data={indicatorData} cc={cc} />
            <MACDChart data={indicatorData} cc={cc} />
          </>
        )}
      </div>

      <SignalReasoningPanel />
    </div>
  );
}
