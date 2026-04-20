import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useLivePrice } from "@/lib/ws-context";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { useToast } from "@/hooks/use-toast";
import {
  Bot, Play, Square, Gift, Coins, CheckCircle, Clock, TrendingUp,
  Wallet, Plus, Activity, Shield, Zap, AlertTriangle, BarChart2,
} from "lucide-react";

// ─── types ────────────────────────────────────────────────────────────────────

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
  regime: { tradeable: boolean; atrRatio: number; volumeRatio: number; trendBias: string; blockReason?: string };
  decision: { shouldTrade: boolean; reason?: string; side?: string; breakoutLevel?: number };
  atTs: number;
};

type Agent = {
  id: string;
  userId: string;
  name: string;
  status: string;
  autoTrade: boolean;
  totalPnl: number;
  totalTrades: number;
  winRate: number;
  leverage: number;
  stopLossBps: number;
  takeProfitBps: number | null;
  createdAt: string;
};

type Reward = {
  id: string;
  userId: string;
  agentId: string;
  amount: number;
  status: "pending" | "claimed";
  claimedAt: string | null;
  createdAt: string;
};

type RewardSummary = {
  totalPending: number;
  totalClaimed: number;
  totalEarned: number;
  rewards: Reward[];
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number | undefined | null, digits = 4): string {
  if (n == null) return "--";
  return n.toFixed(digits);
}

function fmtTs(ts: number | string | null | undefined): string {
  if (!ts) return "--";
  return new Date(ts as any).toLocaleTimeString();
}

function fmtDate(ts: string | null | undefined): string {
  if (!ts) return "--";
  return new Date(ts).toLocaleDateString();
}

function pnlColor(v: number | undefined | null) {
  if (v == null) return "text-muted-foreground";
  return v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-muted-foreground";
}

function sideColor(side: "long" | "short") {
  return side === "long" ? "text-emerald-400" : "text-red-400";
}

function WalletGate({ children }: { children: React.ReactNode }) {
  const account = useCurrentAccount();
  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
          <Wallet className="h-8 w-8 text-primary" />
        </div>
        <div>
          <h3 className="text-base font-semibold mb-1">Connect your wallet</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            Connect your SUI wallet using the button in the top-right corner to access your agent.
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

// ─── My Agent tab ─────────────────────────────────────────────────────────────

function MyAgentTab() {
  const account = useCurrentAccount();
  const wallet = account?.address ?? "";
  const qc = useQueryClient();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [agentName, setAgentName] = useState("");

  const livePrice = useLivePrice();
  const currentPrice = livePrice?.price ?? livePrice?.blended ?? null;

  const { data: agentList = [], isLoading: agentsLoading } = useQuery<Agent[]>({
    queryKey: ["/api/agents", wallet],
    queryFn: () => fetch(`/api/agents?wallet=${encodeURIComponent(wallet)}`).then(r => r.json()),
    enabled: !!wallet,
    refetchInterval: 5000,
  });

  const agent = agentList[0] ?? null;

  const { data: trades = [] } = useQuery<TradeRecord[]>({
    queryKey: ["/api/engine/trades", agent?.id],
    queryFn: () => fetch(`/api/engine/trades?agentId=${agent!.id}&limit=20`).then(r => r.json()),
    enabled: !!agent,
    refetchInterval: 5000,
  });

  const { data: summary } = useQuery<{ total: number; wins: number; losses: number; winRate: number; pnlSui: number; avgWinner: number; avgLoser: number }>({
    queryKey: ["/api/engine/summary", agent?.id],
    queryFn: () => fetch(`/api/engine/summary?agentId=${agent!.id}`).then(r => r.json()),
    enabled: !!agent,
    refetchInterval: 10000,
  });

  const { data: engineData } = useQuery<{ state: EngineState; scanDecision: ScanDecision | null }>({
    queryKey: ["/api/engine/state"],
    refetchInterval: 3000,
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => apiRequest("POST", "/api/agents", { name, userId: wallet }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agents", wallet] });
      toast({ title: "Agent created" });
      setCreateOpen(false);
      setAgentName("");
    },
    onError: (e: any) => {
      const msg = e?.message ?? "Failed to create agent";
      toast({ title: "Error", description: msg, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (agent: Agent) => {
      const isActive = agent.status === "active" && agent.autoTrade;
      return apiRequest("PATCH", `/api/agents/${agent.id}`, {
        status: isActive ? "idle" : "active",
        autoTrade: !isActive,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agents", wallet] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/agents/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agents", wallet] });
      toast({ title: "Agent deleted" });
    },
  });

  if (!wallet) return null;

  if (agentsLoading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const engineState = engineData?.state;
  const currentTrade = engineState?.currentTradeId ? trades.find(t => t.id === engineState.currentTradeId) : null;
  const isAgentActive = agent?.status === "active" && agent?.autoTrade;
  const isEngineRunning = engineState?.isEnabled;

  const unrealizedPnl = currentTrade && currentPrice
    ? (() => {
        const raw = currentTrade.side === "long"
          ? currentPrice - currentTrade.entryPrice
          : currentTrade.entryPrice - currentPrice;
        return currentTrade.collateralSui * currentTrade.leverage * (raw / currentTrade.entryPrice);
      })()
    : null;

  const closedTrades = trades.filter(t => t.status === "closed");

  if (!agent) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center gap-4">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
          <Bot className="h-8 w-8 text-primary" />
        </div>
        <div>
          <h3 className="text-base font-semibold mb-1">No agent yet</h3>
          <p className="text-sm text-muted-foreground max-w-xs mb-4">
            Create your breakout trading agent for SUI-USDC perpetuals on Typus Finance.
          </p>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-create-agent">
                <Plus className="h-4 w-4 mr-1.5" />
                Create Agent
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Trading Agent</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-2">
                <div className="space-y-1.5">
                  <Label htmlFor="agent-name">Agent name</Label>
                  <Input
                    id="agent-name"
                    placeholder="e.g. Breakout Alpha"
                    value={agentName}
                    onChange={e => setAgentName(e.target.value)}
                    data-testid="input-agent-name"
                  />
                </div>
                <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground space-y-1">
                  <p className="font-medium text-foreground mb-1">Fixed configuration</p>
                  <p>Strategy: ATR + Volume breakout</p>
                  <p>Leverage: 30x · Collateral: 3–4 SUI/trade</p>
                  <p>Take Profit: 50bps · Stop Loss: 35bps</p>
                  <p>Max hold: 15 min · Cooldown: 5 min</p>
                  <p>Daily loss stop: 2.5 SUI · Max 4 consec. losses</p>
                </div>
                <Button
                  className="w-full"
                  disabled={agentName.trim().length < 2 || createMutation.isPending}
                  onClick={() => createMutation.mutate(agentName.trim())}
                  data-testid="button-confirm-create"
                >
                  {createMutation.isPending ? "Creating…" : "Deploy Agent"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-md flex items-center justify-center ${isAgentActive ? "bg-primary/20" : "bg-muted"}`}>
            <Bot className={`h-5 w-5 ${isAgentActive ? "text-primary" : "text-muted-foreground"}`} />
          </div>
          <div>
            <h2 className="text-base font-semibold">{agent.name}</h2>
            <p className="text-xs text-muted-foreground font-mono">{wallet.slice(0, 8)}…{wallet.slice(-6)}</p>
          </div>
          <Badge
            variant="outline"
            className={isAgentActive ? "text-emerald-400 border-emerald-400/30" : "text-muted-foreground"}
            data-testid="badge-agent-status"
          >
            {isAgentActive && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse" />}
            {isAgentActive ? "ACTIVE" : "IDLE"}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={isAgentActive ? "destructive" : "default"}
            size="sm"
            disabled={toggleMutation.isPending || (!isEngineRunning && !isAgentActive)}
            onClick={() => toggleMutation.mutate(agent)}
            data-testid="button-toggle-agent"
          >
            {isAgentActive ? <><Square className="h-3.5 w-3.5 mr-1" />Deactivate</> : <><Play className="h-3.5 w-3.5 mr-1" />Activate</>}
          </Button>
        </div>
      </div>

      {!isEngineRunning && (
        <div className="flex items-center gap-2 rounded-md border border-orange-400/20 bg-orange-400/5 px-3 py-2 text-xs text-orange-400">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          Engine is stopped — go to the Engine tab to start it before activating your agent.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Total PnL</p>
            <p className={`text-lg font-bold font-mono ${pnlColor(summary?.pnlSui)}`} data-testid="text-agent-pnl">
              {summary ? `${(summary.pnlSui >= 0 ? "+" : "")}${fmt(summary.pnlSui, 3)} SUI` : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Trades</p>
            <p className="text-lg font-bold font-mono" data-testid="text-agent-trades">{summary?.total ?? "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Win Rate</p>
            <p className="text-lg font-bold font-mono" data-testid="text-agent-winrate">
              {summary?.total ? `${(summary.winRate * 100).toFixed(1)}%` : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">W / L</p>
            <p className="text-lg font-bold font-mono" data-testid="text-agent-wl">
              {summary ? <><span className="text-emerald-400">{summary.wins}</span> / <span className="text-red-400">{summary.losses}</span></> : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card data-testid="card-current-position">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5" />
            Current Position
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!currentTrade ? (
            <p className="text-xs text-muted-foreground">No open position</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-xs">
              <div className="flex justify-between md:flex-col gap-1">
                <span className="text-muted-foreground">Side</span>
                <span className={`font-semibold uppercase font-mono ${sideColor(currentTrade.side)}`} data-testid="text-pos-side">{currentTrade.side}</span>
              </div>
              <div className="flex justify-between md:flex-col gap-1">
                <span className="text-muted-foreground">Entry</span>
                <span className="font-mono" data-testid="text-pos-entry">${fmt(currentTrade.entryPrice)}</span>
              </div>
              <div className="flex justify-between md:flex-col gap-1">
                <span className="text-muted-foreground">Take Profit</span>
                <span className="font-mono text-emerald-400" data-testid="text-pos-tp">${fmt(currentTrade.takeProfitPrice)}</span>
              </div>
              <div className="flex justify-between md:flex-col gap-1">
                <span className="text-muted-foreground">Stop Loss</span>
                <span className="font-mono text-red-400" data-testid="text-pos-sl">${fmt(currentTrade.stopLossPrice)}</span>
              </div>
              <div className="flex justify-between md:flex-col gap-1">
                <span className="text-muted-foreground">Size</span>
                <span className="font-mono" data-testid="text-pos-size">{currentTrade.collateralSui} SUI × {currentTrade.leverage}x</span>
              </div>
              <div className="flex justify-between md:flex-col gap-1">
                <span className="text-muted-foreground">Unrealized PnL</span>
                <span className={`font-mono font-semibold ${pnlColor(unrealizedPnl)}`} data-testid="text-pos-upnl">
                  {unrealizedPnl != null ? `${unrealizedPnl >= 0 ? "+" : ""}${fmt(unrealizedPnl, 3)} SUI` : "--"}
                </span>
              </div>
              <div className="flex justify-between md:flex-col gap-1">
                <span className="text-muted-foreground">Opened</span>
                <span className="font-mono" data-testid="text-pos-opened">{fmtTs(currentTrade.entryTs)}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-trade-history">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
            <BarChart2 className="h-3.5 w-3.5" />
            Trade History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {closedTrades.length === 0 ? (
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
                    <th className="text-right py-1.5 pr-3 font-medium">PnL</th>
                    <th className="text-left py-1.5 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {closedTrades.map(t => (
                    <tr key={t.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors" data-testid={`row-trade-${t.id}`}>
                      <td className="py-1.5 pr-3 font-mono text-muted-foreground">{fmtTs(t.entryTs)}</td>
                      <td className={`py-1.5 pr-3 font-semibold uppercase ${sideColor(t.side)}`}>{t.side}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">${fmt(t.entryPrice)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">${fmt(t.exitPrice)}</td>
                      <td className={`py-1.5 pr-3 text-right font-mono font-semibold ${pnlColor(t.pnlSui)}`}>
                        {t.pnlSui != null ? `${t.pnlSui >= 0 ? "+" : ""}${fmt(t.pnlSui, 3)}` : "--"}
                      </td>
                      <td className="py-1.5 text-muted-foreground capitalize">{t.exitReason?.replace(/_/g, " ")}</td>
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

// ─── Rewards tab ──────────────────────────────────────────────────────────────

function RewardsTab() {
  const account = useCurrentAccount();
  const wallet = account?.address ?? "";
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: summary, isLoading } = useQuery<RewardSummary>({
    queryKey: ["/api/rewards/summary", wallet],
    queryFn: () => fetch(`/api/rewards/summary?userId=${encodeURIComponent(wallet)}`).then(r => r.json()),
    enabled: !!wallet,
    refetchInterval: 10000,
  });

  const claimAllMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/rewards/claim-all", { userId: wallet }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/rewards/summary", wallet] });
      toast({ title: "All rewards claimed" });
    },
    onError: () => toast({ title: "Failed to claim", variant: "destructive" }),
  });

  const claimOneMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/rewards/${id}/claim`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/rewards/summary", wallet] });
      toast({ title: "Reward claimed" });
    },
  });

  if (!wallet) return null;

  if (isLoading) {
    return (
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-3 gap-4">{[1,2,3].map(i => <Skeleton key={i} className="h-24" />)}</div>
        <Skeleton className="h-40" />
      </div>
    );
  }

  const totalPending = summary?.totalPending ?? 0;
  const totalClaimed = summary?.totalClaimed ?? 0;
  const totalEarned = summary?.totalEarned ?? 0;
  const pendingList = (summary?.rewards ?? []).filter(r => r.status === "pending");
  const claimedList = (summary?.rewards ?? []).filter(r => r.status === "claimed");

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold">Rewards</h2>
          <p className="text-xs text-muted-foreground">10% of winning trade PnL accumulates here</p>
        </div>
        {pendingList.length > 0 && (
          <Button
            size="sm"
            onClick={() => claimAllMutation.mutate()}
            disabled={claimAllMutation.isPending}
            data-testid="button-claim-all"
          >
            <Gift className="h-3.5 w-3.5 mr-1.5" />
            {claimAllMutation.isPending ? "Claiming…" : `Claim All (${pendingList.length})`}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card data-testid="stat-pending">
          <CardContent className="pt-4 pb-3 flex items-start gap-3">
            <div className="w-9 h-9 rounded-md bg-yellow-500/10 flex items-center justify-center flex-shrink-0">
              <Clock className="h-4.5 w-4.5 text-yellow-400" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Pending</p>
              <p className="text-xl font-bold font-mono text-yellow-400" data-testid="text-pending-amount">{totalPending.toFixed(4)} SUI</p>
              <p className="text-[10px] text-muted-foreground">{pendingList.length} reward{pendingList.length !== 1 ? "s" : ""}</p>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="stat-claimed">
          <CardContent className="pt-4 pb-3 flex items-start gap-3">
            <div className="w-9 h-9 rounded-md bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
              <CheckCircle className="h-4.5 w-4.5 text-emerald-400" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Claimed</p>
              <p className="text-xl font-bold font-mono text-emerald-400" data-testid="text-claimed-amount">{totalClaimed.toFixed(4)} SUI</p>
              <p className="text-[10px] text-muted-foreground">{claimedList.length} claimed</p>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="stat-total">
          <CardContent className="pt-4 pb-3 flex items-start gap-3">
            <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
              <TrendingUp className="h-4.5 w-4.5 text-primary" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Total Earned</p>
              <p className="text-xl font-bold font-mono" data-testid="text-total-earned">{totalEarned.toFixed(4)} SUI</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {totalPending > 0 && (
        <Card className="border-primary/20 bg-primary/5" data-testid="card-claim-hero">
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div className="flex items-center gap-3">
              <Coins className="h-6 w-6 text-primary" />
              <div>
                <p className="font-bold font-mono">{totalPending.toFixed(4)} SUI ready to claim</p>
                <p className="text-xs text-muted-foreground">From {pendingList.length} winning trade{pendingList.length !== 1 ? "s" : ""}</p>
              </div>
            </div>
            <Button size="sm" onClick={() => claimAllMutation.mutate()} disabled={claimAllMutation.isPending} data-testid="button-claim-hero">
              Claim All
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Reward History</CardTitle>
        </CardHeader>
        <CardContent>
          {(summary?.rewards ?? []).length === 0 ? (
            <div className="text-center py-10">
              <Gift className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No rewards yet — activate your agent to start earning</p>
            </div>
          ) : (
            <div className="space-y-2">
              {(summary?.rewards ?? []).map(r => (
                <div key={r.id} className="flex items-center justify-between text-xs py-2 border-b border-border/50 last:border-0" data-testid={`row-reward-${r.id}`}>
                  <div>
                    <span className="font-mono font-semibold text-emerald-400">+{r.amount.toFixed(4)} SUI</span>
                    <span className="text-muted-foreground ml-2">{fmtDate(r.createdAt)}</span>
                  </div>
                  {r.status === "pending" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] px-2"
                      onClick={() => claimOneMutation.mutate(r.id)}
                      disabled={claimOneMutation.isPending}
                      data-testid={`button-claim-${r.id}`}
                    >
                      Claim
                    </Button>
                  ) : (
                    <Badge variant="secondary" className="text-[10px]">Claimed {fmtDate(r.claimedAt)}</Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Engine tab (existing monitoring) ─────────────────────────────────────────

function EngineTab() {
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

  const { data: summary } = useQuery<{ total: number; wins: number; losses: number; winRate: number; pnlSui: number; avgWinner: number; avgLoser: number }>({
    queryKey: ["/api/engine/summary"],
    refetchInterval: 10000,
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => apiRequest("POST", "/api/engine/toggle", { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/engine/state"] }),
  });

  const engineState = engineData?.state;
  const scanDecision = engineData?.scanDecision;
  const currentTrade = engineState?.currentTradeId ? trades.find(t => t.id === engineState.currentTradeId) : null;
  const closedTrades = trades.filter(t => t.status === "closed").slice(0, 20);
  const nowTs = Date.now();
  const inCooldown = engineState?.cooldownUntilTs && engineState.cooldownUntilTs > nowTs;
  const cooldownRemainingS = inCooldown ? Math.ceil((engineState!.cooldownUntilTs! - nowTs) / 1000) : 0;

  const unrealizedPnl = currentTrade && currentPrice
    ? (() => {
        const raw = currentTrade.side === "long" ? currentPrice - currentTrade.entryPrice : currentTrade.entryPrice - currentPrice;
        return currentTrade.collateralSui * currentTrade.leverage * (raw / currentTrade.entryPrice);
      })()
    : null;

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold">Breakout Engine</h2>
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
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Engine Status</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">State</span>
              <Badge variant="outline" className={engineState?.isEnabled ? "text-emerald-400 border-emerald-400/30" : "text-muted-foreground"} data-testid="badge-engine-state">
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
              <span className="font-mono" data-testid="text-cooldown">{inCooldown ? `${cooldownRemainingS}s` : "–"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last scan</span>
              <span className="font-mono" data-testid="text-last-scan">{fmtTs(engineState?.lastScanTs)}</span>
            </div>
            {engineState?.lastError && <div className="text-red-400 text-[10px] break-all">{engineState.lastError}</div>}
          </CardContent>
        </Card>

        <Card data-testid="card-regime-filter">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Last Scan</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs">
            {!scanDecision ? (
              <p className="text-muted-foreground">Waiting for first scan…</p>
            ) : (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Regime</span>
                  <Badge variant="outline" className={scanDecision.regime.tradeable ? "text-emerald-400 border-emerald-400/30" : "text-orange-400 border-orange-400/30"} data-testid="badge-regime">
                    {scanDecision.regime.tradeable ? "TRADEABLE" : "BLOCKED"}
                  </Badge>
                </div>
                <div className="flex justify-between"><span className="text-muted-foreground">ATR ratio</span><span className="font-mono" data-testid="text-atr-ratio">{fmt(scanDecision.regime.atrRatio, 2)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Vol ratio</span><span className="font-mono" data-testid="text-vol-ratio">{fmt(scanDecision.regime.volumeRatio, 2)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Trend bias</span><span className="font-mono capitalize">{scanDecision.regime.trendBias}</span></div>
                {scanDecision.regime.blockReason && <div className="text-orange-400 text-[10px]">{scanDecision.regime.blockReason}</div>}
                {!scanDecision.decision.shouldTrade
                  ? <div className="text-muted-foreground text-[10px]">{scanDecision.decision.reason}</div>
                  : <div className={`font-semibold uppercase ${sideColor(scanDecision.decision.side as any)}`} data-testid="text-signal">▲ {scanDecision.decision.side?.toUpperCase()} SIGNAL</div>}
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-current-position">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Current Position</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs">
            {!currentTrade ? (
              <p className="text-muted-foreground">No open position</p>
            ) : (
              <>
                <div className="flex justify-between"><span className="text-muted-foreground">Side</span><span className={`font-semibold uppercase font-mono ${sideColor(currentTrade.side)}`}>{currentTrade.side}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Entry</span><span className="font-mono">${fmt(currentTrade.entryPrice)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">TP</span><span className="font-mono text-emerald-400">${fmt(currentTrade.takeProfitPrice)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">SL</span><span className="font-mono text-red-400">${fmt(currentTrade.stopLossPrice)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Size</span><span className="font-mono">{currentTrade.collateralSui} SUI × {currentTrade.leverage}x</span></div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Unreal. PnL</span>
                  <span className={`font-mono font-semibold ${pnlColor(unrealizedPnl)}`}>
                    {unrealizedPnl != null ? `${unrealizedPnl >= 0 ? "+" : ""}${fmt(unrealizedPnl, 3)} SUI` : "--"}
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-metrics">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Session Metrics</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs">
            {!summary ? (
              <p className="text-muted-foreground">No trades yet</p>
            ) : (
              <>
                <div className="flex justify-between"><span className="text-muted-foreground">Total trades</span><span className="font-mono">{summary.total}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Win rate</span><span className="font-mono">{summary.total ? `${(summary.winRate * 100).toFixed(1)}%` : "--"}</span></div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">W / L</span>
                  <span className="font-mono"><span className="text-emerald-400">{summary.wins}</span> / <span className="text-red-400">{summary.losses}</span></span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total PnL</span>
                  <span className={`font-mono font-semibold ${pnlColor(summary.pnlSui)}`}>{`${summary.pnlSui >= 0 ? "+" : ""}${fmt(summary.pnlSui, 3)} SUI`}</span>
                </div>
                <div className="flex justify-between"><span className="text-muted-foreground">Avg winner</span><span className="font-mono text-emerald-400">+{fmt(summary.avgWinner, 3)} SUI</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Avg loser</span><span className="font-mono text-red-400">{fmt(summary.avgLoser, 3)} SUI</span></div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card data-testid="card-recent-trades">
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">All Recent Trades</CardTitle></CardHeader>
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
                    <tr key={t.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors" data-testid={`row-trade-global-${t.id}`}>
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

// ─── Root ──────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const account = useCurrentAccount();

  return (
    <Tabs defaultValue="engine" className="flex flex-col h-full">
      <div className="border-b px-4 pt-1">
        <TabsList className="h-9" data-testid="tabs-main">
          <TabsTrigger value="my-agent" className="text-xs" data-testid="tab-my-agent">My Agent</TabsTrigger>
          <TabsTrigger value="rewards" className="text-xs" data-testid="tab-rewards">Rewards</TabsTrigger>
          <TabsTrigger value="engine" className="text-xs" data-testid="tab-engine">Engine</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="my-agent" className="mt-0 flex-1 overflow-y-auto">
        <WalletGate>
          <MyAgentTab />
        </WalletGate>
      </TabsContent>

      <TabsContent value="rewards" className="mt-0 flex-1 overflow-y-auto">
        <WalletGate>
          <RewardsTab />
        </WalletGate>
      </TabsContent>

      <TabsContent value="engine" className="mt-0 flex-1 overflow-y-auto">
        <EngineTab />
      </TabsContent>
    </Tabs>
  );
}
