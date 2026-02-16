import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { usePageSEO } from "@/lib/seo";
import { useLivePrice, useWS } from "@/lib/ws-context";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { waitForFinalized } from "@/lib/tx-verify";
import type { AgentWithSignalAgent, Signal, Order, Position, InstructionBundleRecord } from "@shared/schema";
import { PROTOCOL_FEE_ADDRESS } from "@shared/schema";
import {
  Bot,
  Brain,
  Activity,
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle,
  XCircle,
  Signal as SignalIcon,
  FileText,
  ExternalLink,
  Wallet,
  Shield,
  Zap,
  Copy,
  ArrowDownToLine,
  Loader2,
  AlertTriangle,
  Banknote,
  ArrowUpRight,
  ArrowDownRight,
  Lock,
  Unlock,
  Package,
  Clock,
  PlayCircle,
  CheckCircle2,
  XOctagon,
  Timer,
  RefreshCw,
  X,
} from "lucide-react";

const VENUE_LABELS: Record<string, string> = {
  typus: "Typus Perps",
};

function TxStatus({ txDigest }: { txDigest: string | null | undefined }) {
  if (!txDigest) return null;
  return (
    <div className="flex items-center gap-1 text-[9px] min-w-0">
      <CheckCircle className="h-2.5 w-2.5 text-emerald-500 shrink-0" />
      <a
        href={`https://suiscan.xyz/mainnet/tx/${txDigest}`}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-primary truncate hover:underline min-w-0"
        data-testid="link-tx-onchain"
      >
        {txDigest.slice(0, 20)}...{txDigest.slice(-6)}
      </a>
      <Badge variant="outline" className="text-[8px] py-0 text-emerald-500 border-emerald-500/30 shrink-0">On-Chain</Badge>
      <CopyButton text={txDigest} />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
    }
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Button size="icon" variant="ghost" onClick={copy} data-testid="button-copy">
      {copied ? <CheckCircle className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

function ThinkingProcess({ agentId, reasoning }: { agentId: string; reasoning: any }) {
  if (!reasoning) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Brain className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-xs text-muted-foreground">Waiting for signal analysis...</p>
        <p className="text-[10px] text-muted-foreground mt-1">The agent will begin analyzing when the market engine ticks</p>
      </div>
    );
  }

  const sideColor = reasoning.side === "long" ? "text-emerald-500" : reasoning.side === "short" ? "text-red-500" : "text-muted-foreground";
  const sideIcon = reasoning.side === "long" ? TrendingUp : reasoning.side === "short" ? TrendingDown : Minus;
  const SideIcon = sideIcon;

  return (
    <div className="space-y-3" data-testid="agent-thinking-process">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div className={`w-6 h-6 rounded-md flex items-center justify-center bg-muted`}>
            <SideIcon className={`h-3.5 w-3.5 ${sideColor}`} />
          </div>
          <div>
            <span className={`text-sm font-bold uppercase ${sideColor}`} data-testid="text-signal-decision">{reasoning.signal}</span>
            <p className="text-[10px] text-muted-foreground font-mono">{reasoning.reason}</p>
          </div>
        </div>
        <div className="flex gap-1.5">
          <Badge variant="default" className="text-[10px] font-mono" data-testid="badge-long-score">
            L{reasoning.longScore}
          </Badge>
          <Badge variant="destructive" className="text-[10px] font-mono" data-testid="badge-short-score">
            S{reasoning.shortScore}
          </Badge>
        </div>
      </div>

      {reasoning.indicators && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
          {Object.entries(reasoning.indicators).map(([key, val]: [string, any]) => {
            let displayVal: string;
            if (typeof val === "number") {
              displayVal = val.toFixed(2);
            } else if (val && typeof val === "object") {
              if ("bullish" in val) {
                displayVal = val.bullish ? "Bullish" : val.bearish ? "Bearish" : "None";
              } else {
                displayVal = JSON.stringify(val);
              }
            } else {
              displayVal = String(val);
            }
            return (
              <div key={key} className="bg-muted rounded-md p-1.5 text-center overflow-hidden">
                <p className="text-[8px] text-muted-foreground uppercase truncate">{key}</p>
                <p className="text-[11px] font-mono font-bold truncate">{displayVal}</p>
              </div>
            );
          })}
        </div>
      )}

      {reasoning.conditions && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Condition Analysis</p>
          {reasoning.conditions.map((cond: any, i: number) => (
            <div key={i} className="flex items-center gap-2 bg-muted rounded-md px-2 py-1.5">
              {cond.met ? (
                <CheckCircle className="h-3 w-3 text-emerald-500 shrink-0" />
              ) : (
                <XCircle className="h-3 w-3 text-muted-foreground shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-medium truncate">{cond.name}</p>
                <p className="text-[9px] text-muted-foreground truncate">{cond.detail || cond.description}</p>
              </div>
              <Badge variant={cond.direction === "long" ? "default" : cond.direction === "short" ? "destructive" : "secondary"} className="text-[8px] shrink-0">
                {cond.direction || "neutral"}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OrdersPanel({ orders }: { orders: Order[] }) {
  if (!orders || orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <FileText className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-xs text-muted-foreground">No orders yet</p>
        <p className="text-[10px] text-muted-foreground mt-1">Orders will appear when the agent executes trades</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5" data-testid="orders-panel">
      {orders.map((order) => (
        <div key={order.id} className="bg-muted rounded-md px-3 py-2 space-y-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Badge variant={order.side === "long" ? "default" : "destructive"} className="text-[10px]">
                {order.side.toUpperCase()}
              </Badge>
              <span className="text-[10px] font-mono">{order.qty?.toFixed(4)} SUI</span>
              <span className="text-[10px] text-muted-foreground">@ ${order.price?.toFixed(4)}</span>
            </div>
            <Badge
              variant={order.status === "filled" ? "default" : order.status === "open" ? "secondary" : "destructive"}
              className="text-[8px]"
              data-testid={`badge-order-status-${order.id}`}
            >
              {order.status}
            </Badge>
          </div>
          <div className="flex items-center gap-3 text-[9px] text-muted-foreground flex-wrap">
            <span>{order.type}</span>
            <span>{order.leverage}x</span>
            {order.stopLossPrice && <span>SL: ${order.stopLossPrice.toFixed(4)}</span>}
            {order.takeProfitPrice && <span>TP: ${order.takeProfitPrice.toFixed(4)}</span>}
            <span>{VENUE_LABELS[order.venue] || order.venue}</span>
          </div>
          <TxStatus txDigest={order.txDigest} />
          <div className="text-[9px] text-muted-foreground">
            {order.createdAt ? new Date(order.createdAt).toLocaleString() : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

function ClosePositionButton({ agentId, positionId, side, sizeSui }: { agentId: string; positionId: string; side: string; sizeSui: number }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const [confirming, setConfirming] = useState(false);

  const closeMutation = useMutation({
    mutationFn: async () => {
      const walletParam = account?.address ? `?wallet=${account.address}` : "";
      const res = await apiRequest("POST", `/api/agents/${agentId}/close-position/${positionId}${walletParam}`);
      return res.json();
    },
    onSuccess: (data) => {
      const pnlStr = data.pnl >= 0 ? `+${data.pnl.toFixed(4)}` : data.pnl.toFixed(4);
      const txInfo = data.txDigest ? ` | Tx: ${data.txDigest.slice(0, 12)}...` : "";
      toast({ title: "Position closed", description: `${side.toUpperCase()} ${sizeSui.toFixed(2)} SUI closed. PnL: ${pnlStr} SUI${txInfo}` });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agentId, "activity"] });
      setConfirming(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to close position", description: err.message, variant: "destructive" });
      setConfirming(false);
    },
  });

  if (confirming) {
    return (
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="destructive"
          onClick={() => closeMutation.mutate()}
          disabled={closeMutation.isPending}
          className="text-[9px] h-6 px-2"
          data-testid={`button-confirm-close-${positionId}`}
        >
          {closeMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Close"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirming(false)}
          className="text-[9px] h-6 px-1"
          data-testid={`button-cancel-close-${positionId}`}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => setConfirming(true)}
      disabled={!account?.address}
      className="text-[9px] h-6 px-2"
      title={!account?.address ? "Connect wallet to close" : "Close this position"}
      data-testid={`button-close-position-${positionId}`}
    >
      <X className="h-3 w-3 mr-0.5" />
      Close
    </Button>
  );
}

function PositionsPanel({ positions, livePrice, leverage, agentId }: { positions: Position[]; livePrice: number; leverage: number; agentId: string }) {
  if (!positions || positions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Activity className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-xs text-muted-foreground">No positions</p>
        <p className="text-[10px] text-muted-foreground mt-1">Positions will appear when orders are filled</p>
      </div>
    );
  }

  const openPositions = positions.filter((p) => p.status === "open");
  const closedPositions = positions.filter((p) => p.status === "closed");

  return (
    <div className="space-y-3" data-testid="positions-panel">
      {openPositions.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Open Positions</p>
          {openPositions.map((pos) => {
            const pnl = livePrice > 0
              ? (pos.side === "long"
                ? (livePrice - pos.entryPrice) * pos.sizeSui / livePrice
                : (pos.entryPrice - livePrice) * pos.sizeSui / livePrice)
              : 0;
            const pnlPercent = pos.side === "long"
              ? ((livePrice - pos.entryPrice) / pos.entryPrice) * 100
              : ((pos.entryPrice - livePrice) / pos.entryPrice) * 100;
            const collateral = pos.sizeSui / leverage;
            const effectiveLev = pos.sizeSui / collateral;

            return (
              <div key={pos.id} className="bg-muted rounded-md px-3 py-2 space-y-1.5">
                <div className="flex items-center justify-between gap-1 flex-wrap">
                  <div className="flex items-center gap-1.5">
                    <Badge variant={pos.side === "long" ? "default" : "destructive"} className="text-[10px]">
                      {pos.side.toUpperCase()}
                    </Badge>
                    <span className="text-[10px] font-mono">{pos.sizeSui.toFixed(2)} SUI</span>
                    <Badge variant="outline" className="text-[9px] font-mono" data-testid={`badge-leverage-${pos.id}`}>
                      {effectiveLev.toFixed(0)}x
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[11px] font-mono font-bold ${pnl >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid={`text-pnl-${pos.id}`}>
                      {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} ({pnlPercent.toFixed(1)}%)
                    </span>
                    <ClosePositionButton agentId={agentId} positionId={pos.id} side={pos.side} sizeSui={pos.sizeSui} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] text-muted-foreground">
                  <span>Entry: ${pos.entryPrice.toFixed(4)}</span>
                  <span>Mark: ${livePrice.toFixed(4)}</span>
                  {pos.liquidationPrice && <span>Liq: ${pos.liquidationPrice.toFixed(4)}</span>}
                  <span>Coll: {collateral.toFixed(2)} SUI</span>
                </div>
                <TxStatus txDigest={pos.txDigest} />
              </div>
            );
          })}
        </div>
      )}

      {closedPositions.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Closed Positions</p>
            {(() => {
              const totalGain = closedPositions.filter(p => (p.unrealizedPnl || 0) > 0).reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
              const totalLoss = closedPositions.filter(p => (p.unrealizedPnl || 0) < 0).reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
              const wins = closedPositions.filter(p => (p.unrealizedPnl || 0) > 0).length;
              return (
                <div className="flex items-center gap-2 text-[9px]">
                  {totalGain > 0 && <span className="text-emerald-500 font-mono" data-testid="text-total-realized-gain">+{totalGain.toFixed(4)} SUI</span>}
                  {totalLoss < 0 && <span className="text-red-500 font-mono">{totalLoss.toFixed(4)} SUI</span>}
                  <Badge variant="outline" className="text-[8px]">{wins}W / {closedPositions.length - wins}L</Badge>
                </div>
              );
            })()}
          </div>
          {closedPositions.map((pos) => {
            const collateral = pos.sizeSui / leverage;

            return (
              <div key={pos.id} className="bg-muted rounded-md px-3 py-2 space-y-1.5 opacity-70">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Badge variant={pos.side === "long" ? "default" : "destructive"} className="text-[10px]">
                      {pos.side.toUpperCase()}
                    </Badge>
                    <span className="text-[10px] font-mono">{pos.sizeSui.toFixed(4)} SUI</span>
                    <Badge variant="outline" className="text-[9px] font-mono">
                      {leverage}x
                    </Badge>
                  </div>
                  <span className={`text-xs font-mono font-bold ${(pos.unrealizedPnl || 0) >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                    {(pos.unrealizedPnl || 0) >= 0 ? "+" : ""}{(pos.unrealizedPnl || 0).toFixed(4)} SUI
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[9px] text-muted-foreground flex-wrap">
                  <span>Entry: ${pos.entryPrice.toFixed(4)}</span>
                  <span>Close: ${pos.markPrice.toFixed(4)}</span>
                  <span>Collateral: {collateral.toFixed(4)} SUI</span>
                  {pos.closedAt && <span>{new Date(pos.closedAt).toLocaleString()}</span>}
                </div>
                <TxStatus txDigest={pos.txDigest} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SignalsPanel({ signals }: { signals: Signal[] }) {
  if (!signals || signals.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <SignalIcon className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-xs text-muted-foreground">No signals recorded yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-1" data-testid="signals-panel">
      {signals.map((sig) => (
        <div key={sig.id} className="flex items-center gap-2 bg-muted rounded-md px-2.5 py-1.5">
          {sig.signal === "long" ? (
            <TrendingUp className="h-3 w-3 text-emerald-500 shrink-0" />
          ) : sig.signal === "short" ? (
            <TrendingDown className="h-3 w-3 text-red-500 shrink-0" />
          ) : (
            <Minus className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[10px] font-bold uppercase ${sig.signal === "long" ? "text-emerald-500" : sig.signal === "short" ? "text-red-500" : "text-muted-foreground"}`}>
                {sig.signal}
              </span>
              <span className="text-[9px] font-mono text-muted-foreground">${sig.price.toFixed(4)}</span>
              {sig.signalScore && (
                <span className="text-[9px] font-mono text-muted-foreground">{sig.signalScore}</span>
              )}
            </div>
          </div>
          <div className="flex gap-1 text-[9px] text-muted-foreground shrink-0">
            <span>RSI:{sig.rsi.toFixed(0)}</span>
          </div>
          <span className="text-[9px] text-muted-foreground shrink-0">
            {sig.createdAt ? new Date(sig.createdAt).toLocaleTimeString() : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

const BUNDLE_STATUS_CONFIG: Record<string, { icon: typeof CheckCircle; color: string; label: string }> = {
  pending: { icon: Clock, color: "text-yellow-500", label: "Pending" },
  executing: { icon: PlayCircle, color: "text-blue-500", label: "Executing" },
  completed: { icon: CheckCircle2, color: "text-emerald-500", label: "Completed" },
  recorded: { icon: CheckCircle2, color: "text-teal-500", label: "Recorded" },
  rejected: { icon: XOctagon, color: "text-orange-500", label: "Rejected" },
  failed: { icon: XOctagon, color: "text-red-500", label: "Failed" },
  expired: { icon: Timer, color: "text-muted-foreground", label: "Expired" },
};

const ACTION_TYPE_LABELS: Record<string, string> = {
  OPEN: "Open Position",
  CLOSE: "Close Position",
  SET_SLTP: "Update SL/TP",
  CLAIM_REWARDS: "Claim Rewards",
  NOOP: "No Action",
};

function BundlesPanel({ agentId }: { agentId: string }) {
  const { data: bundles, isLoading } = useQuery<InstructionBundleRecord[]>({
    queryKey: ["/api/bundles", agentId, "latest"],
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (!bundles || bundles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Package className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-xs text-muted-foreground">No execution bundles yet</p>
        <p className="text-[10px] text-muted-foreground mt-1">Bundles are created when the agent detects strong trading signals</p>
      </div>
    );
  }

  const statusCounts = bundles.reduce((acc, b) => {
    acc[b.status] = (acc[b.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="space-y-3" data-testid="bundles-panel">
      <div className="flex items-center gap-2 flex-wrap">
        {Object.entries(statusCounts).map(([status, count]) => {
          const config = BUNDLE_STATUS_CONFIG[status] || BUNDLE_STATUS_CONFIG.pending;
          const Icon = config.icon;
          return (
            <Badge key={status} variant="outline" className="text-[9px] gap-1">
              <Icon className={`h-2.5 w-2.5 ${config.color}`} />
              {config.label}: {count}
            </Badge>
          );
        })}
      </div>

      <div className="space-y-1.5">
        {bundles.slice(0, 20).map((bundle) => {
          const config = BUNDLE_STATUS_CONFIG[bundle.status] || BUNDLE_STATUS_CONFIG.pending;
          const StatusIcon = config.icon;
          const actions = (bundle.actions as any[]) || [];
          const risk = bundle.risk as any;
          const isExpired = Date.now() > bundle.expiresAtMs;

          return (
            <div key={bundle.id} className="bg-muted rounded-md px-2.5 py-2 space-y-1.5 min-w-0">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <StatusIcon className={`h-3.5 w-3.5 ${config.color} shrink-0`} />
                  <span className="text-[10px] font-mono font-medium truncate" data-testid={`text-bundle-id-${bundle.id}`}>
                    {bundle.bundleId.slice(0, 8)}...
                  </span>
                </div>
                <Badge
                  variant={bundle.status === "completed" || bundle.status === "recorded" ? "default" : bundle.status === "failed" || bundle.status === "rejected" ? "destructive" : "secondary"}
                  className="text-[8px]"
                  data-testid={`badge-bundle-status-${bundle.id}`}
                >
                  {config.label}
                  {isExpired && bundle.status === "pending" ? " (Expired)" : ""}
                </Badge>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {actions.map((action: any, i: number) => (
                  <Badge key={i} variant="outline" className="text-[9px] gap-1">
                    {action.type === "OPEN" && (
                      <>
                        {action.side === "LONG" ? (
                          <TrendingUp className="h-2.5 w-2.5 text-emerald-500" />
                        ) : (
                          <TrendingDown className="h-2.5 w-2.5 text-red-500" />
                        )}
                        {action.side} {action.leverage}x
                      </>
                    )}
                    {action.type === "CLOSE" && (
                      <>
                        <XCircle className="h-2.5 w-2.5" />
                        Close {(action.pct * 100).toFixed(0)}%
                      </>
                    )}
                    {action.type === "SET_SLTP" && (
                      <>
                        <Shield className="h-2.5 w-2.5" />
                        SL/TP
                      </>
                    )}
                    {action.type === "CLAIM_REWARDS" && "Claim"}
                    {action.type === "NOOP" && action.reason}
                  </Badge>
                ))}
              </div>

              {(bundle as any).executionError && (bundle.status === "rejected" || bundle.status === "failed") && (
                <div className="text-[9px] text-red-400 bg-red-500/10 rounded px-2 py-1 font-mono break-all whitespace-normal" data-testid={`text-bundle-error-${bundle.id}`}>
                  {(bundle as any).executionError}
                </div>
              )}

              {risk && (
                <div className="flex items-center gap-2 text-[9px] text-muted-foreground flex-wrap">
                  <span className="whitespace-nowrap">Max Notional: ${risk.maxNotionalUsd?.toFixed(2)}</span>
                  <span className="whitespace-nowrap">Max Lev: {risk.maxLeverage}x</span>
                  <span className="whitespace-nowrap">Max Daily Loss: ${risk.maxDailyLossUsd?.toFixed(2)}</span>
                </div>
              )}

              <div className="text-[9px] text-muted-foreground">
                {bundle.createdAt ? new Date(bundle.createdAt).toLocaleString() : ""}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WithdrawDialog({ agent, open, onOpenChange }: { agent: AgentWithSignalAgent; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawStatus, setWithdrawStatus] = useState<"idle" | "signing" | "verifying" | "processing">("idle");
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const { data: onChainData } = useQuery<{ onChainSui: number; dbBalance: number }>({
    queryKey: ["/api/agents", agent.id, "on-chain-balance"],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${agent.id}/on-chain-balance`);
      if (!res.ok) return { onChainSui: 0, dbBalance: agent.balance };
      return res.json();
    },
    enabled: open,
    refetchInterval: open ? 10000 : false,
  });

  const gasBudgetSui = 0.05;
  const onChainSui = onChainData?.onChainSui ?? 0;
  const maxWithdrawable = Math.max(0, onChainSui - gasBudgetSui);

  const withdrawMutation = useMutation({
    mutationFn: async () => {
      const amt = parseFloat(withdrawAmount);
      if (!amt || amt <= 0) throw new Error("Enter a valid amount");
      if (amt > maxWithdrawable + 0.001) throw new Error(`Amount exceeds max withdrawable (${maxWithdrawable.toFixed(4)} SUI on-chain after gas)`);
      if (!account?.address) throw new Error("Connect your wallet first");

      const authAmount = BigInt(1000);
      const tx = new Transaction();
      tx.setSender(account.address);
      const [authCoin] = tx.splitCoins(tx.gas, [authAmount]);
      tx.transferObjects([authCoin], PROTOCOL_FEE_ADDRESS);

      setWithdrawStatus("signing");

      const result = await new Promise<{ digest: string }>((resolve, reject) => {
        signAndExecute(
          { transaction: tx },
          {
            onSuccess: (data) => resolve(data),
            onError: (err) => reject(err),
          }
        );
      });

      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction signing failed");

      setWithdrawStatus("verifying");
      const verification = await waitForFinalized(txDigest);
      if (verification.status !== "success") {
        throw new Error(verification.error || "Authorization transaction did not finalize on-chain");
      }

      setWithdrawStatus("processing");
      const res = await apiRequest("POST", `/api/agents/${agent.id}/withdraw`, {
        amount: amt,
        toAddress: account.address,
        authTxDigest: txDigest,
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Withdrawal successful", description: `${data.amount.toFixed(4)} SUI sent to your wallet. Tx: ${data.txDigest.slice(0, 12)}...` });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id, "activity"] });
      onOpenChange(false);
      setWithdrawAmount("");
      setWithdrawStatus("idle");
    },
    onError: (err: Error) => {
      toast({ title: "Withdrawal failed", description: err.message, variant: "destructive" });
      setWithdrawStatus("idle");
    },
  });

  const statusLabel = withdrawStatus === "signing" ? "Approve in wallet..." : withdrawStatus === "verifying" ? "Verifying on-chain..." : withdrawStatus === "processing" ? "Processing withdrawal..." : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Withdraw from {agent.name}</DialogTitle>
          <DialogDescription>
            Withdraw SUI from this agent to your connected wallet.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">On-chain balance</span>
            <span className="text-sm font-mono font-bold">{onChainSui.toFixed(4)} SUI</span>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Max withdrawable</span>
            <span className="text-sm font-mono font-bold text-primary">{maxWithdrawable.toFixed(4)} SUI</span>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Gas reserved</span>
            <span className="text-xs font-mono text-muted-foreground">{gasBudgetSui} SUI</span>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Destination</span>
            <span className="text-xs font-mono">{account?.address ? `${account.address.slice(0, 8)}...${account.address.slice(-6)}` : "Not connected"}</span>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">Amount (SUI)</label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="0.01"
                min="0"
                max={maxWithdrawable}
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="0.00"
                data-testid="input-withdraw-amount"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setWithdrawAmount(maxWithdrawable.toFixed(4))}
                data-testid="button-withdraw-max"
              >
                Max
              </Button>
            </div>
          </div>
          {parseFloat(withdrawAmount) > 0 && (
            <div className="bg-card border rounded-md p-3 space-y-1">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">You will receive</span>
                <span className="text-sm font-mono font-bold">{parseFloat(withdrawAmount).toFixed(4)} SUI</span>
              </div>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">Remaining on-chain</span>
                <span className="text-xs font-mono">{Math.max(0, onChainSui - parseFloat(withdrawAmount)).toFixed(4)} SUI</span>
              </div>
            </div>
          )}
          <div className="bg-primary/5 border border-primary/20 rounded-md p-3">
            <div className="text-xs text-muted-foreground space-y-1.5">
              <p className="font-medium">How this works:</p>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>Your wallet will ask you to approve a small authorization fee (~0.05 SUI gas)</li>
                <li>After approval, the agent automatically sends your SUI to your wallet</li>
              </ol>
            </div>
          </div>
          {statusLabel && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {statusLabel}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-withdraw-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => withdrawMutation.mutate()}
            disabled={withdrawMutation.isPending || !account?.address || !withdrawAmount || parseFloat(withdrawAmount) <= 0}
            data-testid="button-withdraw-confirm"
          >
            {withdrawMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                {withdrawStatus === "idle" ? "Signing..." : statusLabel}
              </>
            ) : (
              <>
                <ArrowDownToLine className="h-4 w-4 mr-1" />
                Withdraw
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RefundDialog({ agent, open, onOpenChange }: { agent: AgentWithSignalAgent; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const [refundStatus, setRefundStatus] = useState<"idle" | "signing" | "verifying" | "processing">("idle");
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const { data: onChainData } = useQuery<{ onChainSui: number; dbBalance: number; mismatch: boolean }>({
    queryKey: ["/api/agents", agent.id, "on-chain-balance"],
    enabled: open,
    refetchInterval: false,
  });

  const refundMutation = useMutation({
    mutationFn: async () => {
      if (!account?.address) throw new Error("Connect your wallet first");
      if (!onChainData || onChainData.onChainSui <= 0.002) throw new Error("No refundable balance on-chain — balance is less than the gas fee needed to send a transaction");

      const authAmount = BigInt(1000);
      const tx = new Transaction();
      tx.setSender(account.address);
      const [authCoin] = tx.splitCoins(tx.gas, [authAmount]);
      tx.transferObjects([authCoin], PROTOCOL_FEE_ADDRESS);

      setRefundStatus("signing");

      const result = await new Promise<{ digest: string }>((resolve, reject) => {
        signAndExecute(
          { transaction: tx },
          {
            onSuccess: (data) => resolve(data),
            onError: (err) => reject(err),
          }
        );
      });

      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction signing failed");

      setRefundStatus("verifying");
      const verification = await waitForFinalized(txDigest);
      if (verification.status !== "success") {
        throw new Error(verification.error || "Authorization transaction did not finalize on-chain");
      }

      setRefundStatus("processing");
      const res = await apiRequest("POST", `/api/agents/${agent.id}/refund`, {
        toAddress: account.address,
        authTxDigest: txDigest,
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Refund successful", description: `${data.amount.toFixed(4)} SUI returned to your wallet. Tx: ${data.txDigest.slice(0, 12)}...` });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id] });
      onOpenChange(false);
      setRefundStatus("idle");
    },
    onError: (err: Error) => {
      toast({ title: "Refund failed", description: err.message, variant: "destructive" });
      setRefundStatus("idle");
    },
  });

  const statusLabel = refundStatus === "signing" ? "Approve in wallet..." : refundStatus === "verifying" ? "Verifying on-chain..." : refundStatus === "processing" ? "Processing refund..." : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Refund Stuck Funds from {agent.name}</DialogTitle>
          <DialogDescription>
            Return all on-chain SUI from this agent's wallet back to your connected wallet. This is for recovering funds when the agent's database balance is out of sync.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">DB Balance</span>
            <span className="text-sm font-mono">{agent.balance.toFixed(4)} SUI</span>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">On-Chain Balance</span>
            <span className="text-sm font-mono font-bold">{onChainData ? `${onChainData.onChainSui.toFixed(4)} SUI` : "Loading..."}</span>
          </div>
          {onChainData?.mismatch && (
            <div className="flex items-center gap-2 text-xs text-amber-500">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>Balance mismatch detected between database and on-chain records</span>
            </div>
          )}
          {onChainData && onChainData.onChainSui <= 0.002 && (
            <div className="flex items-center gap-2 text-xs text-red-500">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>On-chain balance ({onChainData.onChainSui.toFixed(6)} SUI) is too low to cover the gas fee for a refund transaction</span>
            </div>
          )}
          {onChainData && onChainData.onChainSui > 0.002 && onChainData.onChainSui <= 0.05 && (
            <div className="flex items-center gap-2 text-xs text-amber-500">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>After gas fees, you will receive approximately {Math.max(0, onChainData.onChainSui - 0.002).toFixed(4)} SUI</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Destination</span>
            <span className="text-xs font-mono">{account?.address ? `${account.address.slice(0, 8)}...${account.address.slice(-6)}` : "Not connected"}</span>
          </div>
          <div className="bg-primary/5 border border-primary/20 rounded-md p-3">
            <div className="text-xs text-muted-foreground space-y-1.5">
              <p className="font-medium">How this works:</p>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>Your wallet will ask you to approve a small authorization fee (~0.05 SUI gas)</li>
                <li>After approval, the agent automatically sends {onChainData ? `~${onChainData.onChainSui.toFixed(2)}` : "your"} SUI to your wallet</li>
              </ol>
            </div>
          </div>
          {statusLabel && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {statusLabel}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-refund-cancel">
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => refundMutation.mutate()}
            disabled={refundMutation.isPending || !account?.address || !onChainData || onChainData.onChainSui <= 0.002}
            data-testid="button-refund-confirm"
          >
            {refundMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                {refundStatus === "idle" ? "Signing..." : statusLabel}
              </>
            ) : (
              <>
                <ArrowDownToLine className="h-4 w-4 mr-1" />
                Refund All
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveCollateralDialog({ agent, open, onOpenChange }: { agent: AgentWithSignalAgent; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const [removeStatus, setRemoveStatus] = useState<"idle" | "signing" | "verifying" | "processing">("idle");
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const { data: onChainData } = useQuery<{ onChainSui: number; dbBalance: number; mismatch: boolean }>({
    queryKey: ["/api/agents", agent.id, "on-chain-balance"],
    enabled: open,
    refetchInterval: false,
  });

  const estimatedReceive = onChainData ? Math.max(onChainData.onChainSui - 0.02, 0) : agent.balance;

  const removeCollateralMutation = useMutation({
    mutationFn: async () => {
      if (!account?.address) throw new Error("Connect your wallet first");

      const authAmount = BigInt(1000);
      const tx = new Transaction();
      tx.setSender(account.address);
      const [authCoin] = tx.splitCoins(tx.gas, [authAmount]);
      tx.transferObjects([authCoin], PROTOCOL_FEE_ADDRESS);

      setRemoveStatus("signing");

      const result = await new Promise<{ digest: string }>((resolve, reject) => {
        signAndExecute(
          { transaction: tx },
          {
            onSuccess: (data) => resolve(data),
            onError: (err) => reject(err),
          }
        );
      });

      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction signing failed");

      setRemoveStatus("verifying");
      const verification = await waitForFinalized(txDigest);
      if (verification.status !== "success") {
        throw new Error(verification.error || "Authorization transaction did not finalize on-chain");
      }

      setRemoveStatus("processing");
      const res = await apiRequest("POST", `/api/agents/${agent.id}/remove-collateral`, {
        toAddress: account.address,
        authTxDigest: txDigest,
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.withdrawFailed) {
        toast({
          title: "Withdrawal failed",
          description: "Positions were closed but the on-chain transfer failed. Your balance has been preserved. Try using the Withdraw or Refund option instead.",
          variant: "destructive",
        });
      } else {
        const desc = [
          data.closedPositions > 0 ? `Closed ${data.closedPositions} position(s)` : "",
          data.withdrawnAmount > 0 ? `Withdrew ${data.withdrawnAmount.toFixed(4)} SUI` : "",
          data.txDigest ? `Tx: ${data.txDigest.slice(0, 12)}...` : "",
        ].filter(Boolean).join(". ");
        toast({ title: "Collateral removed", description: desc });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      onOpenChange(false);
      setRemoveStatus("idle");
    },
    onError: (err: Error) => {
      toast({ title: "Failed to remove collateral", description: err.message, variant: "destructive" });
      setRemoveStatus("idle");
    },
  });

  const statusLabel = removeStatus === "signing" ? "Approve in wallet..." : removeStatus === "verifying" ? "Verifying on-chain..." : removeStatus === "processing" ? "Processing removal..." : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove All Collateral</DialogTitle>
          <DialogDescription>
            This will close all open positions, stop the agent, and withdraw the full remaining balance to your wallet.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Agent</span>
            <span className="text-sm font-medium">{agent.name}</span>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">You will receive</span>
            <span className="text-sm font-mono font-bold text-emerald-500">~{estimatedReceive.toFixed(4)} SUI</span>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Destination</span>
            <span className="text-xs font-mono">{account?.address ? `${account.address.slice(0, 8)}...${account.address.slice(-6)}` : "Not connected"}</span>
          </div>
          <div className="bg-primary/5 border border-primary/20 rounded-md p-3">
            <div className="text-xs text-muted-foreground space-y-1.5">
              <p className="font-medium">How this works:</p>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>Your wallet will ask you to approve a small authorization fee (~0.05 SUI gas)</li>
                <li>All open positions will be closed at market price</li>
                <li>After approval, the agent sends ~{estimatedReceive.toFixed(2)} SUI to your wallet</li>
              </ol>
            </div>
          </div>
          {statusLabel && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {statusLabel}
            </div>
          )}
          <div className="bg-destructive/10 border border-destructive/20 rounded-md p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="text-xs text-muted-foreground">
                <p className="font-medium text-destructive">This action will:</p>
                <ul className="list-disc list-inside mt-1 space-y-0.5">
                  <li>Close all open positions at current market price</li>
                  <li>Stop the agent from trading</li>
                  <li>Transfer all remaining SUI to your wallet</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-remove-cancel">
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => removeCollateralMutation.mutate()}
            disabled={removeCollateralMutation.isPending || !account?.address}
            data-testid="button-remove-confirm"
          >
            {removeCollateralMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                {removeStatus === "idle" ? "Processing..." : statusLabel}
              </>
            ) : (
              <>
                <Unlock className="h-4 w-4 mr-1" />
                Remove All Collateral
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentDetail({ agent }: { agent: AgentWithSignalAgent }) {
  const livePrice = useLivePrice();
  const currentPrice = livePrice?.blended || 0;
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showRemoveCollateral, setShowRemoveCollateral] = useState(false);
  const [showRefund, setShowRefund] = useState(false);
  const account = useCurrentAccount();
  const { toast } = useToast();

  const { data: activity, isLoading } = useQuery<{
    orders: Order[];
    positions: Position[];
    signals: Signal[];
    reasoning: any;
    portfolioValue: number;
    lockedCollateral: number;
    totalUnrealizedPnl: number;
    liveWinRate: number;
    realizedGain: number;
    realizedLoss: number;
    pendingRewards: number;
    claimedRewards: number;
    reinvestedAmount: number;
  }>({
    queryKey: ["/api/agents", agent.id, "activity"],
    refetchInterval: 5000,
  });

  const syncBalanceMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/agents/${agent.id}/sync-balance`);
      return res.json();
    },
    onSuccess: (data) => {
      if (data.synced) {
        toast({ title: "Balance synced", description: `Updated from ${data.previousBalance.toFixed(4)} to ${data.newBalance.toFixed(4)} SUI` });
      } else {
        toast({ title: "Already in sync", description: data.message });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id] });
    },
    onError: (err: any) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  const recalcStatsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/agents/${agent.id}/recalculate-stats`);
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Stats recalculated", description: `PnL: ${data.totalPnl.toFixed(2)}, Win Rate: ${(data.winRate * 100).toFixed(0)}%, Trades: ${data.totalTrades}` });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id] });
    },
    onError: (err: any) => {
      toast({ title: "Recalculation failed", description: err.message, variant: "destructive" });
    },
  });

  const isRunning = agent.status === "running";
  const venueLabel = agent.venue === "typus" ? "Typus Perps" : agent.venue;

  const openPositions = activity?.positions?.filter(p => p.status === "open") || [];
  const hasOpenPositions = openPositions.length > 0;
  const isStopped = agent.status !== "running";
  const canWithdraw = !!(account?.address && agent.balance > 0);

  const portfolioValue = activity?.portfolioValue ?? agent.balance;
  const lockedCollateral = activity?.lockedCollateral ?? 0;
  const unrealizedPnl = activity?.totalUnrealizedPnl ?? 0;
  const winRate = activity?.liveWinRate ?? agent.winRate;
  const rewardSharePct = agent.rewardSharePct ?? 50;

  let liveUnrealizedPnl = 0;
  if (currentPrice > 0 && openPositions.length > 0) {
    for (const pos of openPositions) {
      const rawPnl = pos.side === "long"
        ? (currentPrice - pos.entryPrice) * pos.sizeSui / currentPrice
        : (pos.entryPrice - currentPrice) * pos.sizeSui / currentPrice;
      const posCollateral = pos.sizeSui / agent.leverage;
      liveUnrealizedPnl += Math.max(-posCollateral, rawPnl);
    }
  } else {
    liveUnrealizedPnl = unrealizedPnl;
  }

  let liveLockedCollateral = 0;
  for (const pos of openPositions) {
    liveLockedCollateral += pos.sizeSui / agent.leverage;
  }

  const livePortfolioValue = Math.max(0, agent.balance) + liveLockedCollateral + liveUnrealizedPnl;
  const liveTotalPnl = agent.totalPnl + liveUnrealizedPnl;

  return (
    <div className="space-y-3" data-testid={`agent-detail-${agent.id}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${isRunning ? "bg-primary/20" : "bg-muted"}`}>
            <Bot className={`h-4 w-4 ${isRunning ? "text-primary" : "text-muted-foreground"}`} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold truncate" data-testid={`text-agent-name-${agent.id}`}>{agent.name}</h3>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] text-muted-foreground font-mono">{venueLabel}</span>
              <Badge variant={isRunning ? "default" : "secondary"} className="text-[8px]">
                {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1 animate-pulse" />}
                {agent.status}
              </Badge>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <div className="bg-muted rounded-md p-2 text-center">
          <p className="text-[9px] text-muted-foreground">Portfolio</p>
          <p className="text-xs font-mono font-bold truncate" data-testid="text-portfolio-value">{livePortfolioValue.toFixed(2)}</p>
          {liveLockedCollateral > 0 && (
            <p className="text-[7px] text-muted-foreground truncate">{agent.balance.toFixed(1)} + {liveLockedCollateral.toFixed(1)}</p>
          )}
        </div>
        <div className="bg-muted rounded-md p-2 text-center">
          <p className="text-[9px] text-muted-foreground">Total PnL</p>
          <p className={`text-xs font-mono font-bold truncate ${liveTotalPnl > 0 ? "text-emerald-500" : liveTotalPnl < 0 ? "text-red-500" : "text-muted-foreground"}`} data-testid="text-total-pnl">
            {liveTotalPnl === 0 ? "0.00" : `${liveTotalPnl >= 0 ? "+" : ""}${liveTotalPnl.toFixed(2)}`}
          </p>
          {liveUnrealizedPnl !== 0 && (
            <p className={`text-[7px] truncate ${liveUnrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {liveUnrealizedPnl >= 0 ? "+" : ""}{liveUnrealizedPnl.toFixed(2)} unreal.
            </p>
          )}
        </div>
        <div className="bg-muted rounded-md p-2 text-center">
          <p className="text-[9px] text-muted-foreground">Win Rate</p>
          <p className="text-xs font-mono font-bold" data-testid="text-win-rate">{(winRate * 100).toFixed(0)}%</p>
          <p className="text-[7px] text-muted-foreground">{agent.totalTrades} trades</p>
        </div>
      </div>

      <div className="bg-muted rounded-md p-3 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
            <Banknote className="h-3 w-3" />
            Collateral Flow
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => syncBalanceMutation.mutate()}
              disabled={syncBalanceMutation.isPending}
              className="text-muted-foreground hover-elevate rounded p-0.5 text-[8px] flex items-center gap-0.5"
              title="Sync with on-chain balance"
              data-testid="button-sync-balance"
            >
              <RefreshCw className={`h-2.5 w-2.5 ${syncBalanceMutation.isPending ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={() => recalcStatsMutation.mutate()}
              disabled={recalcStatsMutation.isPending}
              className="text-muted-foreground hover-elevate rounded p-0.5 text-[8px] flex items-center gap-0.5"
              title="Recalculate stats from positions"
              data-testid="button-recalc-stats"
            >
              <Activity className={`h-2.5 w-2.5 ${recalcStatsMutation.isPending ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-1 text-[10px]">
          <div className="bg-background rounded p-1.5 text-center min-w-0">
            <p className="text-muted-foreground text-[8px] flex items-center justify-center gap-0.5"><ArrowDownRight className="h-2 w-2 text-emerald-500" />Deposit</p>
            <p className="font-mono truncate text-[11px]">{(agent.totalDeposited || 0).toFixed(2)}</p>
          </div>
          <div className="bg-background rounded p-1.5 text-center min-w-0">
            <p className="text-muted-foreground text-[8px] flex items-center justify-center gap-0.5"><Shield className="h-2 w-2 text-chart-4" />Fees</p>
            <p className="font-mono truncate text-[11px]">{(agent.protocolFeePaid || 0).toFixed(4)}</p>
          </div>
          <div className="bg-background rounded p-1.5 text-center min-w-0">
            <p className="text-muted-foreground text-[8px] flex items-center justify-center gap-0.5"><Lock className="h-2 w-2 text-primary" />Locked</p>
            <p className="font-mono truncate text-[11px]">{liveLockedCollateral.toFixed(2)}</p>
          </div>
          <div className="bg-background rounded p-1.5 text-center min-w-0">
            <p className="text-muted-foreground text-[8px] flex items-center justify-center gap-0.5"><Unlock className="h-2 w-2" />Free</p>
            <p className="font-mono truncate text-[11px]">{Math.max(0, agent.balance).toFixed(2)}</p>
          </div>
          <div className="bg-background rounded p-1.5 text-center min-w-0">
            <p className="text-muted-foreground text-[8px] flex items-center justify-center gap-0.5">
              <ArrowUpRight className="h-2 w-2 text-emerald-500" />Realized
            </p>
            <p className={`font-mono truncate text-[11px] ${(activity?.realizedGain || 0) > 0 ? "text-emerald-500" : "text-muted-foreground"}`} data-testid="text-realized-gain">
              +{(activity?.realizedGain || 0).toFixed(4)}
            </p>
          </div>
          <div className="bg-background rounded p-1.5 text-center min-w-0">
            <p className="text-muted-foreground text-[8px] flex items-center justify-center gap-0.5">
              {liveUnrealizedPnl >= 0 ? <ArrowUpRight className="h-2 w-2 text-emerald-500" /> : <ArrowDownRight className="h-2 w-2 text-red-500" />}Unreal
            </p>
            <p className={`font-mono truncate text-[11px] ${liveUnrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>{liveUnrealizedPnl >= 0 ? "+" : ""}{liveUnrealizedPnl.toFixed(2)}</p>
          </div>
        </div>
      </div>

      <div className="bg-muted rounded-md p-3 space-y-2">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <Zap className="h-3 w-3" />
          Rewards &amp; Profit Split
        </p>
        <div className="grid grid-cols-3 gap-1 text-[10px]">
          <div className="bg-background rounded p-1.5 text-center min-w-0">
            <p className="text-muted-foreground text-[8px] flex items-center justify-center gap-0.5">
              <ArrowUpRight className="h-2 w-2 text-emerald-500" />Claimable
            </p>
            <p className="font-mono truncate text-[11px] text-emerald-500 font-bold" data-testid="text-pending-rewards">
              {(activity?.pendingRewards || 0).toFixed(4)}
            </p>
            <p className="text-[7px] text-muted-foreground">{rewardSharePct}% of profit</p>
          </div>
          <div className="bg-background rounded p-1.5 text-center min-w-0">
            <p className="text-muted-foreground text-[8px] flex items-center justify-center gap-0.5">
              <TrendingUp className="h-2 w-2 text-primary" />Reinvested
            </p>
            <p className="font-mono truncate text-[11px] text-primary font-bold" data-testid="text-reinvested">
              {(activity?.reinvestedAmount || 0).toFixed(4)}
            </p>
            <p className="text-[7px] text-muted-foreground">{100 - rewardSharePct}% of profit</p>
          </div>
          <div className="bg-background rounded p-1.5 text-center min-w-0">
            <p className="text-muted-foreground text-[8px] flex items-center justify-center gap-0.5">
              <CheckCircle className="h-2 w-2 text-muted-foreground" />Claimed
            </p>
            <p className="font-mono truncate text-[11px]" data-testid="text-claimed-rewards">
              {(activity?.claimedRewards || 0).toFixed(4)}
            </p>
            <p className="text-[7px] text-muted-foreground">withdrawn</p>
          </div>
        </div>
      </div>

      <div className="bg-muted rounded-md p-3 space-y-2">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <Shield className="h-3 w-3" />
          Trading Configuration
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-background rounded-md p-2 text-center" data-testid="config-leverage">
            <p className="text-[9px] text-muted-foreground">Leverage</p>
            <p className="text-sm font-bold font-mono">{agent.leverage}x</p>
            <div className="mt-1 h-1 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.min(100, (agent.leverage / 50) * 100)}%` }}
              />
            </div>
            <p className="text-[8px] text-muted-foreground mt-0.5">max 50x</p>
          </div>
          <div className="bg-background rounded-md p-2 text-center" data-testid="config-max-position">
            <p className="text-[9px] text-muted-foreground">Max Collateral</p>
            <p className="text-sm font-bold font-mono">{agent.maxQty} SUI</p>
            <p className="text-[8px] text-muted-foreground mt-0.5 truncate">per trade ({(agent.maxQty * agent.leverage).toFixed(0)} SUI pos)</p>
          </div>
          <div className="bg-background rounded-md p-2 text-center" data-testid="config-stop-loss">
            <p className="text-[9px] text-muted-foreground">Stop Loss</p>
            <p className="text-sm font-bold font-mono text-red-500">{agent.stopLossBps}bps</p>
            <p className="text-[8px] text-muted-foreground mt-0.5">{(agent.stopLossBps / 100).toFixed(2)}%</p>
          </div>
          <div className="bg-background rounded-md p-2 text-center" data-testid="config-take-profit">
            <p className="text-[9px] text-muted-foreground">Take Profit</p>
            <p className="text-sm font-bold font-mono text-emerald-500">{agent.takeProfitBps ? `${agent.takeProfitBps}bps` : "---"}</p>
            <p className="text-[8px] text-muted-foreground mt-0.5">{agent.takeProfitBps ? `${(agent.takeProfitBps / 100).toFixed(2)}%` : "none"}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[9px] text-muted-foreground flex-wrap">
          <div className="flex items-center gap-1">
            <TrendingUp className="h-2.5 w-2.5" />
            <span>{rewardSharePct}% rewards / {100 - rewardSharePct}% reinvest</span>
          </div>
          {agent.walletAddress && (
            <div className="flex items-center gap-1">
              <Wallet className="h-2.5 w-2.5" />
              <span className="font-mono truncate max-w-[100px]">{agent.walletAddress.slice(0, 6)}...{agent.walletAddress.slice(-4)}</span>
              <CopyButton text={agent.walletAddress} />
            </div>
          )}
        </div>
      </div>

      {account?.address && (livePortfolioValue > 0 || agent.balance > 0 || hasOpenPositions) && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowRemoveCollateral(true)}
            className="w-full"
            data-testid="button-remove-collateral"
          >
            <Unlock className="h-3.5 w-3.5 mr-1 shrink-0" />
            <span className="truncate text-xs">Remove Collateral</span>
          </Button>
          {canWithdraw && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowWithdraw(true)}
              className="w-full"
              data-testid="button-withdraw-open"
            >
              <ArrowDownToLine className="h-3.5 w-3.5 mr-1 shrink-0" />
              <span className="truncate text-xs">Withdraw</span>
            </Button>
          )}
        </div>
      )}

      {account?.address && agent.balance < 0.1 && (agent.totalDeposited || 0) > 1 && !hasOpenPositions && (
        <div className="space-y-2">
          <div className="bg-red-500/10 border border-red-500/20 rounded-md p-2.5">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
              <div className="text-[10px] space-y-1">
                <p className="font-medium text-red-500">Low Balance</p>
                <p className="text-muted-foreground">
                  This agent deposited {(agent.totalDeposited || 0).toFixed(2)} SUI but the balance is now {Math.max(0, agent.balance).toFixed(4)} SUI.
                  {agent.totalPnl < -1 && ` Trading losses of ${Math.abs(agent.totalPnl).toFixed(2)} SUI at ${agent.leverage}x leverage consumed the collateral.`}
                  {agent.totalPnl >= -1 && agent.totalTrades > 0 && ` Leveraged positions and gas fees consumed the collateral.`}
                </p>
              </div>
            </div>
          </div>
          {agent.walletAddress && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRefund(true)}
              className="w-full"
              data-testid="button-refund-open"
            >
              <ArrowDownToLine className="h-3.5 w-3.5 mr-1.5" />
              Recover Remaining Funds
            </Button>
          )}
        </div>
      )}

      {account?.address && agent.balance <= 0 && (agent.totalDeposited || 0) <= 1 && agent.walletAddress && !hasOpenPositions && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRefund(true)}
            className="flex-1"
            data-testid="button-refund-open"
          >
            <ArrowDownToLine className="h-3.5 w-3.5 mr-1.5" />
            Recover Remaining Funds
          </Button>
        </div>
      )}

      <WithdrawDialog agent={agent} open={showWithdraw} onOpenChange={setShowWithdraw} />
      <RefundDialog agent={agent} open={showRefund} onOpenChange={setShowRefund} />
      <RemoveCollateralDialog agent={agent} open={showRemoveCollateral} onOpenChange={setShowRemoveCollateral} />

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <Tabs defaultValue="thinking" className="w-full">
          <TabsList className="w-full grid grid-cols-5 gap-0.5">
            <TabsTrigger value="thinking" className="text-[9px] px-1" data-testid="tab-thinking">
              <Brain className="h-3 w-3 shrink-0" />
              <span className="hidden sm:inline ml-1">Thinking</span>
            </TabsTrigger>
            <TabsTrigger value="orders" className="text-[9px] px-1" data-testid="tab-orders">
              <FileText className="h-3 w-3 shrink-0" />
              <span className="hidden sm:inline ml-1">Orders</span>
            </TabsTrigger>
            <TabsTrigger value="positions" className="text-[9px] px-1" data-testid="tab-positions">
              <Activity className="h-3 w-3 shrink-0" />
              <span className="hidden sm:inline ml-1">Pos</span>
            </TabsTrigger>
            <TabsTrigger value="signals" className="text-[9px] px-1" data-testid="tab-signals">
              <SignalIcon className="h-3 w-3 shrink-0" />
              <span className="hidden sm:inline ml-1">Signals</span>
            </TabsTrigger>
            <TabsTrigger value="bundles" className="text-[9px] px-1" data-testid="tab-bundles">
              <Package className="h-3 w-3 shrink-0" />
              <span className="hidden sm:inline ml-1">Bundles</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="thinking" className="mt-2">
            <ThinkingProcess agentId={agent.id} reasoning={activity?.reasoning} />
          </TabsContent>
          <TabsContent value="orders" className="mt-2">
            <OrdersPanel orders={activity?.orders || []} />
          </TabsContent>
          <TabsContent value="positions" className="mt-2">
            <PositionsPanel positions={activity?.positions || []} livePrice={currentPrice} leverage={agent.leverage} agentId={agent.id} />
          </TabsContent>
          <TabsContent value="signals" className="mt-2">
            <SignalsPanel signals={activity?.signals || []} />
          </TabsContent>
          <TabsContent value="bundles" className="mt-2">
            <BundlesPanel agentId={agent.id} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

interface WalletSummary {
  wallet: string;
  totalDepositedGross: number;
  totalDepositedNet: number;
  totalFeesPaid: number;
  totalFreeBalance: number;
  totalLockedCollateral: number;
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  totalClaimedVerified: number;
  totalPendingRewards: number;
  verifiedOpenPositions: number;
  verifiedClosedPositions: number;
  depositsCount: number;
  claimsCount: number;
  agentIds: string[];
}

function WalletSummaryPanel({ address }: { address: string }) {
  const { data, isLoading } = useQuery<WalletSummary>({
    queryKey: ["/api/wallet", address, "summary"],
    refetchInterval: 15000,
    enabled: !!address,
  });

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!data) return null;

  const portfolioTotal = data.totalFreeBalance + data.totalLockedCollateral + data.totalUnrealizedPnl;

  return (
    <Card data-testid="card-wallet-summary">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Wallet className="h-4 w-4 text-primary" />
          My Wallet Summary
        </CardTitle>
        <Badge variant="outline" className="text-[8px] font-mono">
          {address.slice(0, 6)}...{address.slice(-4)}
        </Badge>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-3 gap-1">
          <div className="bg-muted rounded-md p-1.5 text-center min-w-0">
            <p className="text-[8px] text-muted-foreground">Deposited</p>
            <p className="text-[11px] font-mono font-bold truncate" data-testid="text-wallet-deposited">{data.totalDepositedNet.toFixed(2)}</p>
            <p className="text-[7px] text-muted-foreground">{data.depositsCount} dep.</p>
          </div>
          <div className="bg-muted rounded-md p-1.5 text-center min-w-0">
            <p className="text-[8px] text-muted-foreground">Fees</p>
            <p className="text-[11px] font-mono font-bold text-chart-4 truncate" data-testid="text-wallet-fees">{data.totalFeesPaid.toFixed(4)}</p>
            <p className="text-[7px] text-muted-foreground">2% protocol</p>
          </div>
          <div className="bg-muted rounded-md p-1.5 text-center min-w-0">
            <p className="text-[8px] text-muted-foreground">Portfolio</p>
            <p className="text-[11px] font-mono font-bold truncate" data-testid="text-wallet-portfolio">{Math.max(0, portfolioTotal).toFixed(2)}</p>
            <p className="text-[7px] text-muted-foreground truncate">{Math.max(0, data.totalFreeBalance).toFixed(1)} + {data.totalLockedCollateral.toFixed(1)}</p>
          </div>
          <div className="bg-muted rounded-md p-1.5 text-center min-w-0">
            <p className="text-[8px] text-muted-foreground">Rewards</p>
            <p className="text-[11px] font-mono font-bold text-emerald-500 truncate" data-testid="text-wallet-rewards">{data.totalPendingRewards.toFixed(4)}</p>
            <p className="text-[7px] text-muted-foreground truncate">{data.totalClaimedVerified.toFixed(2)} claimed</p>
          </div>
          <div className="bg-muted rounded-md p-1.5 text-center min-w-0">
            <p className="text-[8px] text-muted-foreground flex items-center justify-center gap-0.5">
              {data.totalRealizedPnl >= 0 ? <ArrowUpRight className="h-2 w-2 text-emerald-500" /> : <ArrowDownRight className="h-2 w-2 text-red-500" />}PnL
            </p>
            <p className={`text-[11px] font-mono font-bold truncate ${data.totalRealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {data.totalRealizedPnl >= 0 ? "+" : ""}{data.totalRealizedPnl.toFixed(2)}
            </p>
          </div>
          <div className="bg-muted rounded-md p-1.5 text-center min-w-0">
            <p className="text-[8px] text-muted-foreground flex items-center justify-center gap-0.5">
              {data.totalUnrealizedPnl >= 0 ? <ArrowUpRight className="h-2 w-2 text-emerald-500" /> : <ArrowDownRight className="h-2 w-2 text-red-500" />}Unreal
            </p>
            <p className={`text-[11px] font-mono font-bold truncate ${data.totalUnrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {data.totalUnrealizedPnl >= 0 ? "+" : ""}{data.totalUnrealizedPnl.toFixed(2)}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-2">
          <span>{data.verifiedOpenPositions} open + {data.verifiedClosedPositions} closed positions</span>
          <span>{data.agentIds.length} agent{data.agentIds.length !== 1 ? "s" : ""}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export default function MyAgents() {
  usePageSEO({
    title: "My Agents",
    description: "View your active AI trading agents, their thinking process, open orders, positions, and blockchain activity",
  });

  const account = useCurrentAccount();

  const { subscribe } = useWS();

  const { data: agents, isLoading } = useQuery<AgentWithSignalAgent[]>({
    queryKey: ["/api/agents"],
    refetchInterval: 5000,
  });

  useEffect(() => {
    const unsub1 = subscribe("agent:updated", () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
    });
    const unsub2 = subscribe("agent:created", () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
    });
    const unsub3 = subscribe("agent:deleted", () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
    });
    const unsub4 = subscribe("agents:refresh", () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
    });
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); };
  }, [subscribe]);

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const activeAgents = agents?.filter((a) => a.status === "running") || [];
  const allAgents = agents || [];

  useEffect(() => {
    if (!selectedAgentId && activeAgents.length > 0) {
      setSelectedAgentId(activeAgents[0].id);
    } else if (!selectedAgentId && allAgents.length > 0) {
      setSelectedAgentId(allAgents[0].id);
    }
  }, [agents, selectedAgentId]);

  const selectedAgent = allAgents.find((a) => a.id === selectedAgentId);

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-3xl mx-auto" data-testid="page-my-agents">
      {account?.address && <WalletSummaryPanel address={account.address} />}

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="space-y-0.5">
          <h2 className="text-lg md:text-xl font-bold tracking-tight">My Agents</h2>
          <p className="text-xs text-muted-foreground">Monitor your agents' thinking, orders, and blockchain activity</p>
        </div>
        {allAgents.length > 1 && (
          <Select value={selectedAgentId || ""} onValueChange={setSelectedAgentId}>
            <SelectTrigger className="w-[200px]" data-testid="select-agent">
              <SelectValue placeholder="Select agent" />
            </SelectTrigger>
            <SelectContent>
              {allAgents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <div className="flex items-center gap-2">
                    {a.status === "running" && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
                    <span>{a.name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : allAgents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Bot className="h-10 w-10 text-muted-foreground mb-3" />
            <h3 className="text-sm font-medium mb-1">No agents deployed</h3>
            <p className="text-xs text-muted-foreground mb-4">
              Deploy an agent from the Deploy Agent page to see it here
            </p>
          </CardContent>
        </Card>
      ) : selectedAgent ? (
        <Card>
          <CardContent className="pt-4">
            <AgentDetail agent={selectedAgent} />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-xs text-muted-foreground">Select an agent to view details</p>
          </CardContent>
        </Card>
      )}

      {activeAgents.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <Card>
            <CardContent className="p-2 text-center">
              <p className="text-[9px] text-muted-foreground">Active Agents</p>
              <p className="text-base font-bold font-mono" data-testid="text-active-count">{activeAgents.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-2 text-center">
              <p className="text-[9px] text-muted-foreground">Total Balance</p>
              <p className="text-base font-bold font-mono truncate">{allAgents.reduce((s, a) => s + a.balance, 0).toFixed(2)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-2 text-center">
              <p className="text-[9px] text-muted-foreground">Total PnL</p>
              <p className={`text-base font-bold font-mono truncate ${allAgents.reduce((s, a) => s + a.totalPnl, 0) >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                {allAgents.reduce((s, a) => s + a.totalPnl, 0).toFixed(2)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-2 text-center">
              <p className="text-[9px] text-muted-foreground">Total Trades</p>
              <p className="text-base font-bold font-mono">{allAgents.reduce((s, a) => s + a.totalTrades, 0)}</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
