import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLivePrice } from "@/lib/ws-context";

type TradeRecord = {
  id: string;
  symbol: string;
  side: "long" | "short";
  status: "open" | "closed";
  entryReason: string;
  exitReason?: string;
  entryTs: number;
  exitTs?: number;
  entryPrice: number;
  exitPrice?: number;
  leverage: number;
  collateralSui: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  pnlSui?: number;
  pnlBps?: number;
  win?: boolean;
  atrRatioAtEntry: number;
  volumeRatioAtEntry: number;
  trendBiasAtEntry: "bullish" | "bearish" | "neutral";
  breakoutLevel: number;
};

type EngineState = {
  isEnabled: boolean;
  lastScanTs: number | null;
  cooldownUntilTs: number | null;
  currentTradeId: string | null;
  consecutiveLosses: number;
  dailyRealizedPnlSui: number;
  dailyResetTs: number | null;
  lastError?: string;
};

type ScanDecision = {
  regime: {
    tradeable: boolean;
    atrRatio: number;
    volumeRatio: number;
    trendBias: string;
    blockReason?: string;
  };
  decision: {
    shouldTrade: boolean;
    reason?: string;
    side?: string;
    breakoutLevel?: number;
  };
  atTs: number;
};

function fmt(n: number | undefined | null, digits = 4): string {
  if (n == null) return "--";
  return n.toFixed(digits);
}

function fmtTs(ts: number | null | undefined): string {
  if (!ts) return "--";
  return new Date(ts).toLocaleTimeString();
}

function pnlColor(v: number | undefined) {
  if (v == null) return "";
  return v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-muted-foreground";
}

function sideColor(side: "long" | "short") {
  return side === "long" ? "text-emerald-400" : "text-red-400";
}

export default function Dashboard() {
  const qc = useQueryClient();
  const livePrice = useLivePrice();
  const currentPrice = livePrice?.price ?? livePrice?.blended ?? null;

  const { data: engineData, isLoading: engineLoading } = useQuery<{ state: EngineState; scanDecision: ScanDecision | null }>({
    queryKey: ["/api/engine/state"],
    refetchInterval: 3000,
  });

  const { data: trades = [], isLoading: tradesLoading } = useQuery<TradeRecord[]>({
    queryKey: ["/api/engine/trades"],
    refetchInterval: 5000,
  });

  const { data: summary } = useQuery<{
    total: number;
    wins: number;
    losses: number;
    winRate: number;
    pnlSui: number;
    avgWinner: number;
    avgLoser: number;
  }>({
    queryKey: ["/api/engine/summary"],
    refetchInterval: 10000,
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest("POST", "/api/engine/toggle", { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/engine/state"] });
    },
  });

  const engineState = engineData?.state;
  const scanDecision = engineData?.scanDecision;
  const currentTrade = engineState?.currentTradeId
    ? trades.find(t => t.id === engineState.currentTradeId)
    : null;
  const closedTrades = trades.filter(t => t.status === "closed").slice(0, 20);

  const unrealizedPnl = currentTrade && currentPrice
    ? (() => {
        const raw = currentTrade.side === "long"
          ? currentPrice - currentTrade.entryPrice
          : currentTrade.entryPrice - currentPrice;
        return currentTrade.collateralSui * currentTrade.leverage * (raw / currentTrade.entryPrice);
      })()
    : null;

  const nowTs = Date.now();
  const inCooldown = engineState?.cooldownUntilTs && engineState.cooldownUntilTs > nowTs;
  const cooldownRemainingS = inCooldown
    ? Math.ceil((engineState!.cooldownUntilTs! - nowTs) / 1000)
    : 0;

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Breakout Engine</h1>
          <p className="text-xs text-muted-foreground">SUI-USDC Perpetual · Typus Finance · 30x</p>
        </div>
        <div className="flex items-center gap-2">
          {currentPrice && (
            <Badge variant="outline" className="font-mono text-xs" data-testid="badge-current-price">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse mr-1.5" />
              ${currentPrice.toFixed(4)}
            </Badge>
          )}
          <Button
            data-testid="button-engine-toggle"
            size="sm"
            variant={engineState?.isEnabled ? "destructive" : "default"}
            disabled={toggleMutation.isPending || engineLoading}
            onClick={() => toggleMutation.mutate(!engineState?.isEnabled)}
          >
            {engineState?.isEnabled ? "Stop Engine" : "Start Engine"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card data-testid="card-engine-status">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Engine Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">State</span>
              <Badge
                variant="outline"
                className={engineState?.isEnabled ? "text-emerald-400 border-emerald-400/30" : "text-muted-foreground"}
                data-testid="badge-engine-state"
              >
                {engineState?.isEnabled ? "RUNNING" : "STOPPED"}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Daily PnL</span>
              <span className={`font-mono font-semibold ${pnlColor(engineState?.dailyRealizedPnlSui)}`} data-testid="text-daily-pnl">
                {engineState ? `${engineState.dailyRealizedPnlSui >= 0 ? "+" : ""}${fmt(engineState.dailyRealizedPnlSui, 3)} SUI` : "--"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Consec. Losses</span>
              <span className={`font-mono ${(engineState?.consecutiveLosses ?? 0) >= 3 ? "text-orange-400" : ""}`} data-testid="text-consec-losses">
                {engineState?.consecutiveLosses ?? "--"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Cooldown</span>
              <span className="font-mono" data-testid="text-cooldown">
                {inCooldown ? `${cooldownRemainingS}s` : "–"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last scan</span>
              <span className="font-mono" data-testid="text-last-scan">{fmtTs(engineState?.lastScanTs)}</span>
            </div>
            {engineState?.lastError && (
              <div className="text-red-400 text-[10px] break-all" data-testid="text-last-error">{engineState.lastError}</div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-regime-filter">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Last Scan</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {!scanDecision ? (
              <p className="text-muted-foreground">Waiting for first scan…</p>
            ) : (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Regime</span>
                  <Badge
                    variant="outline"
                    className={scanDecision.regime.tradeable ? "text-emerald-400 border-emerald-400/30" : "text-orange-400 border-orange-400/30"}
                    data-testid="badge-regime"
                  >
                    {scanDecision.regime.tradeable ? "TRADEABLE" : "BLOCKED"}
                  </Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">ATR ratio</span>
                  <span className="font-mono" data-testid="text-atr-ratio">{fmt(scanDecision.regime.atrRatio, 2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Vol ratio</span>
                  <span className="font-mono" data-testid="text-vol-ratio">{fmt(scanDecision.regime.volumeRatio, 2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Trend bias</span>
                  <span className="font-mono capitalize" data-testid="text-trend-bias">{scanDecision.regime.trendBias}</span>
                </div>
                {scanDecision.regime.blockReason && (
                  <div className="text-orange-400 text-[10px]" data-testid="text-block-reason">{scanDecision.regime.blockReason}</div>
                )}
                {!scanDecision.decision.shouldTrade ? (
                  <div className="text-muted-foreground text-[10px]">{scanDecision.decision.reason}</div>
                ) : (
                  <div className={`font-semibold uppercase ${sideColor(scanDecision.decision.side as any)}`} data-testid="text-signal">
                    ▲ {scanDecision.decision.side?.toUpperCase()} SIGNAL
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-current-position">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Current Position</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {!currentTrade ? (
              <p className="text-muted-foreground">No open position</p>
            ) : (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Side</span>
                  <span className={`font-semibold uppercase font-mono ${sideColor(currentTrade.side)}`} data-testid="text-pos-side">
                    {currentTrade.side}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Entry</span>
                  <span className="font-mono" data-testid="text-pos-entry">${fmt(currentTrade.entryPrice)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">TP</span>
                  <span className="font-mono text-emerald-400" data-testid="text-pos-tp">${fmt(currentTrade.takeProfitPrice)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">SL</span>
                  <span className="font-mono text-red-400" data-testid="text-pos-sl">${fmt(currentTrade.stopLossPrice)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Size</span>
                  <span className="font-mono" data-testid="text-pos-size">{currentTrade.collateralSui} SUI × {currentTrade.leverage}x</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Unreal. PnL</span>
                  <span className={`font-mono font-semibold ${pnlColor(unrealizedPnl)}`} data-testid="text-pos-upnl">
                    {unrealizedPnl != null ? `${unrealizedPnl >= 0 ? "+" : ""}${fmt(unrealizedPnl, 3)} SUI` : "--"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Opened</span>
                  <span className="font-mono" data-testid="text-pos-opened">{fmtTs(currentTrade.entryTs)}</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-metrics">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Session Metrics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {!summary ? (
              <p className="text-muted-foreground">No trades yet</p>
            ) : (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total trades</span>
                  <span className="font-mono" data-testid="text-total-trades">{summary.total}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Win rate</span>
                  <span className="font-mono" data-testid="text-win-rate">
                    {summary.total ? `${(summary.winRate * 100).toFixed(1)}%` : "--"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">W / L</span>
                  <span className="font-mono" data-testid="text-wl">
                    <span className="text-emerald-400">{summary.wins}</span> / <span className="text-red-400">{summary.losses}</span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total PnL</span>
                  <span className={`font-mono font-semibold ${pnlColor(summary.pnlSui)}`} data-testid="text-total-pnl">
                    {`${summary.pnlSui >= 0 ? "+" : ""}${fmt(summary.pnlSui, 3)} SUI`}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Avg winner</span>
                  <span className="font-mono text-emerald-400" data-testid="text-avg-winner">+{fmt(summary.avgWinner, 3)} SUI</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Avg loser</span>
                  <span className="font-mono text-red-400" data-testid="text-avg-loser">{fmt(summary.avgLoser, 3)} SUI</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card data-testid="card-recent-trades">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Recent Closed Trades</CardTitle>
        </CardHeader>
        <CardContent>
          {tradesLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : closedTrades.length === 0 ? (
            <p className="text-xs text-muted-foreground">No closed trades yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-1.5 pr-3 font-medium">Time</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Side</th>
                    <th className="text-right py-1.5 pr-3 font-medium">Entry</th>
                    <th className="text-right py-1.5 pr-3 font-medium">Exit</th>
                    <th className="text-right py-1.5 pr-3 font-medium">PnL (SUI)</th>
                    <th className="text-right py-1.5 pr-3 font-medium">PnL (bps)</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Reason</th>
                    <th className="text-right py-1.5 font-medium">ATR</th>
                  </tr>
                </thead>
                <tbody>
                  {closedTrades.map(t => (
                    <tr
                      key={t.id}
                      className="border-b border-border/50 hover:bg-muted/30 transition-colors"
                      data-testid={`row-trade-${t.id}`}
                    >
                      <td className="py-1.5 pr-3 font-mono text-muted-foreground">{fmtTs(t.entryTs)}</td>
                      <td className={`py-1.5 pr-3 font-semibold uppercase ${sideColor(t.side)}`}>{t.side}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">${fmt(t.entryPrice)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">${fmt(t.exitPrice)}</td>
                      <td className={`py-1.5 pr-3 text-right font-mono font-semibold ${pnlColor(t.pnlSui)}`}>
                        {t.pnlSui != null ? `${t.pnlSui >= 0 ? "+" : ""}${fmt(t.pnlSui, 3)}` : "--"}
                      </td>
                      <td className={`py-1.5 pr-3 text-right font-mono ${pnlColor(t.pnlBps)}`}>
                        {t.pnlBps != null ? `${t.pnlBps >= 0 ? "+" : ""}${fmt(t.pnlBps, 1)}` : "--"}
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground capitalize">{t.exitReason?.replace(/_/g, " ")}</td>
                      <td className="py-1.5 text-right font-mono text-muted-foreground">{fmt(t.atrRatioAtEntry, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
