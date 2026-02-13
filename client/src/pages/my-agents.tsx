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
import { useLivePrice } from "@/lib/ws-context";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCurrentAccount } from "@mysten/dapp-kit";
import type { AgentWithSignalAgent, Signal, Order, Position } from "@shared/schema";
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
  CircleDot,
  Copy,
  ArrowDownToLine,
  Loader2,
  AlertTriangle,
  Banknote,
  ArrowUpRight,
  ArrowDownRight,
  Lock,
  Unlock,
} from "lucide-react";

const VENUE_LABELS: Record<string, string> = {
  typus: "Typus Finance",
  astros: "Astros Perps",
};

function TxStatus({ txDigest }: { txDigest: string | null | undefined }) {
  if (!txDigest) return null;
  return (
    <div className="flex items-center gap-1 text-[9px]">
      <CheckCircle className="h-2.5 w-2.5 text-emerald-500 shrink-0" />
      <a
        href={`https://suiscan.xyz/mainnet/tx/${txDigest}`}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-primary truncate hover:underline"
        data-testid="link-tx-onchain"
      >
        {txDigest}
      </a>
      <Badge variant="outline" className="text-[8px] py-0 text-emerald-500 border-emerald-500/30">On-Chain</Badge>
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

function PositionsPanel({ positions, livePrice }: { positions: Position[]; livePrice: number }) {
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
            const pnl = pos.side === "long"
              ? (livePrice - pos.entryPrice) * pos.sizeSui
              : (pos.entryPrice - livePrice) * pos.sizeSui;
            const pnlPercent = pos.side === "long"
              ? ((livePrice - pos.entryPrice) / pos.entryPrice) * 100
              : ((pos.entryPrice - livePrice) / pos.entryPrice) * 100;

            return (
              <div key={pos.id} className="bg-muted rounded-md px-3 py-2 space-y-1">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Badge variant={pos.side === "long" ? "default" : "destructive"} className="text-[10px]">
                      {pos.side.toUpperCase()}
                    </Badge>
                    <span className="text-[10px] font-mono">{pos.sizeSui.toFixed(4)} SUI</span>
                  </div>
                  <span className={`text-xs font-mono font-bold ${pnl >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid={`text-pnl-${pos.id}`}>
                    {pnl >= 0 ? "+" : ""}{pnl.toFixed(4)} ({pnlPercent.toFixed(2)}%)
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[9px] text-muted-foreground flex-wrap">
                  <span>Entry: ${pos.entryPrice.toFixed(4)}</span>
                  <span>Mark: ${livePrice.toFixed(4)}</span>
                  {pos.liquidationPrice && <span>Liq: ${pos.liquidationPrice.toFixed(4)}</span>}
                </div>
                <TxStatus txDigest={pos.txDigest} />
              </div>
            );
          })}
        </div>
      )}

      {closedPositions.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Closed Positions</p>
          {closedPositions.map((pos) => (
            <div key={pos.id} className="bg-muted rounded-md px-3 py-2 space-y-1 opacity-70">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <Badge variant={pos.side === "long" ? "default" : "destructive"} className="text-[10px]">
                    {pos.side.toUpperCase()}
                  </Badge>
                  <span className="text-[10px] font-mono">{pos.sizeSui.toFixed(4)} SUI</span>
                </div>
                <span className={`text-xs font-mono font-bold ${(pos.unrealizedPnl || 0) >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {(pos.unrealizedPnl || 0) >= 0 ? "+" : ""}{(pos.unrealizedPnl || 0).toFixed(4)} SUI
                </span>
              </div>
              <div className="flex items-center gap-3 text-[9px] text-muted-foreground flex-wrap">
                <span>Entry: ${pos.entryPrice.toFixed(4)}</span>
                <span>Close: ${pos.markPrice.toFixed(4)}</span>
                {pos.closedAt && <span>{new Date(pos.closedAt).toLocaleString()}</span>}
              </div>
              <TxStatus txDigest={pos.txDigest} />
            </div>
          ))}
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

function WithdrawDialog({ agent, open, onOpenChange }: { agent: AgentWithSignalAgent; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const [withdrawAmount, setWithdrawAmount] = useState("");

  const withdrawMutation = useMutation({
    mutationFn: async () => {
      const amt = parseFloat(withdrawAmount);
      if (!amt || amt <= 0) throw new Error("Enter a valid amount");
      if (amt > agent.balance) throw new Error("Amount exceeds agent balance");
      if (!account?.address) throw new Error("Connect your wallet first");

      const res = await apiRequest("POST", `/api/agents/${agent.id}/withdraw`, {
        amount: amt,
        toAddress: account.address,
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Withdrawal successful", description: `${data.amount.toFixed(4)} SUI sent to your wallet. Tx: ${data.txDigest.slice(0, 12)}...` });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id, "activity"] });
      onOpenChange(false);
      setWithdrawAmount("");
    },
    onError: (err: Error) => {
      toast({ title: "Withdrawal failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Withdraw My Collateral from {agent.name}</DialogTitle>
          <DialogDescription>
            Transfer SUI from your agent's wallet back to your connected wallet. This is an on-chain transaction signed by the agent's keypair.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Available balance</span>
            <span className="text-sm font-mono font-bold">{agent.balance.toFixed(4)} SUI</span>
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
                max={agent.balance}
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="0.00"
                data-testid="input-withdraw-amount"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setWithdrawAmount(agent.balance.toFixed(4))}
                data-testid="button-withdraw-max"
              >
                Max
              </Button>
            </div>
          </div>
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
                Signing...
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

function RemoveCollateralDialog({ agent, open, onOpenChange }: { agent: AgentWithSignalAgent; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const account = useCurrentAccount();

  const removeCollateralMutation = useMutation({
    mutationFn: async () => {
      if (!account?.address) throw new Error("Connect your wallet first");
      const res = await apiRequest("POST", `/api/agents/${agent.id}/remove-collateral`, {
        toAddress: account.address,
      });
      return res.json();
    },
    onSuccess: (data) => {
      const desc = [
        data.closedPositions > 0 ? `Closed ${data.closedPositions} position(s)` : "",
        data.withdrawnAmount > 0 ? `Withdrew ${data.withdrawnAmount.toFixed(4)} SUI` : "",
        data.txDigest ? `Tx: ${data.txDigest.slice(0, 12)}...` : "Balance reset",
      ].filter(Boolean).join(". ");
      toast({ title: "Collateral removed", description: desc });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to remove collateral", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove All Collateral</DialogTitle>
          <DialogDescription>
            This will close all open positions at current market price, stop the agent, and withdraw the full remaining balance to your connected wallet.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Agent</span>
            <span className="text-sm font-medium">{agent.name}</span>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Free Balance</span>
            <span className="text-sm font-mono font-bold">{agent.balance.toFixed(4)} SUI</span>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Destination</span>
            <span className="text-xs font-mono">{account?.address ? `${account.address.slice(0, 8)}...${account.address.slice(-6)}` : "Not connected"}</span>
          </div>
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
                Processing...
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
  const account = useCurrentAccount();

  const { data: activity, isLoading } = useQuery<{
    orders: Order[];
    positions: Position[];
    signals: Signal[];
    reasoning: any;
    portfolioValue: number;
    lockedCollateral: number;
    totalUnrealizedPnl: number;
    liveWinRate: number;
  }>({
    queryKey: ["/api/agents", agent.id, "activity"],
    refetchInterval: 5000,
  });

  const isRunning = agent.status === "running";
  const venueLabel = VENUE_LABELS[agent.venue] || agent.venue;

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
      liveUnrealizedPnl += pos.side === "long"
        ? (currentPrice - pos.entryPrice) * pos.sizeSui
        : (pos.entryPrice - currentPrice) * pos.sizeSui;
    }
  } else {
    liveUnrealizedPnl = unrealizedPnl;
  }

  let liveLockedCollateral = 0;
  for (const pos of openPositions) {
    liveLockedCollateral += (pos.sizeSui * pos.entryPrice) / agent.leverage;
  }

  const livePortfolioValue = agent.balance + liveLockedCollateral + liveUnrealizedPnl;
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
              {agent.autoTrade && (
                <Badge variant="default" className="text-[8px] bg-amber-600">
                  <CircleDot className="h-2 w-2 mr-0.5" />
                  AUTO
                </Badge>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        <div className="bg-muted rounded-md p-2 text-center">
          <p className="text-[9px] text-muted-foreground">Portfolio Value</p>
          <p className="text-xs font-mono font-bold" data-testid="text-portfolio-value">{livePortfolioValue.toFixed(4)}</p>
          {liveLockedCollateral > 0 && (
            <p className="text-[8px] text-muted-foreground">{agent.balance.toFixed(2)} free + {liveLockedCollateral.toFixed(2)} locked</p>
          )}
        </div>
        <div className="bg-muted rounded-md p-2 text-center">
          <p className="text-[9px] text-muted-foreground">Total PnL</p>
          <p className={`text-xs font-mono font-bold ${liveTotalPnl > 0 ? "text-emerald-500" : liveTotalPnl < 0 ? "text-red-500" : "text-muted-foreground"}`} data-testid="text-total-pnl">
            {liveTotalPnl === 0 ? "0.0000" : `${liveTotalPnl >= 0 ? "+" : ""}${liveTotalPnl.toFixed(4)}`}
          </p>
          {liveUnrealizedPnl !== 0 && (
            <p className={`text-[8px] ${liveUnrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {liveUnrealizedPnl >= 0 ? "+" : ""}{liveUnrealizedPnl.toFixed(4)} unrealized
            </p>
          )}
        </div>
        <div className="bg-muted rounded-md p-2 text-center">
          <p className="text-[9px] text-muted-foreground">Win Rate</p>
          <p className="text-xs font-mono font-bold" data-testid="text-win-rate">{(winRate * 100).toFixed(0)}%</p>
          <p className="text-[8px] text-muted-foreground">{agent.totalTrades} trades</p>
        </div>
      </div>

      <div className="bg-muted rounded-md p-3 space-y-2">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <Banknote className="h-3 w-3" />
          Collateral Flow
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
          <div className="flex items-center justify-between gap-1">
            <span className="text-muted-foreground flex items-center gap-1"><ArrowDownRight className="h-2.5 w-2.5 text-emerald-500" /> Deposited</span>
            <span className="font-mono">{(agent.totalDeposited || 0).toFixed(4)}</span>
          </div>
          <div className="flex items-center justify-between gap-1">
            <span className="text-muted-foreground flex items-center gap-1"><Shield className="h-2.5 w-2.5 text-chart-4" /> Fees Paid</span>
            <span className="font-mono">{(agent.protocolFeePaid || 0).toFixed(4)}</span>
          </div>
          <div className="flex items-center justify-between gap-1">
            <span className="text-muted-foreground flex items-center gap-1"><Lock className="h-2.5 w-2.5 text-primary" /> Locked</span>
            <span className="font-mono">{liveLockedCollateral.toFixed(4)}</span>
          </div>
          <div className="flex items-center justify-between gap-1">
            <span className="text-muted-foreground flex items-center gap-1"><Unlock className="h-2.5 w-2.5" /> Free</span>
            <span className="font-mono">{agent.balance.toFixed(4)}</span>
          </div>
          <div className="flex items-center justify-between gap-1">
            <span className="text-muted-foreground flex items-center gap-1">
              {liveTotalPnl >= 0 ? <ArrowUpRight className="h-2.5 w-2.5 text-emerald-500" /> : <ArrowDownRight className="h-2.5 w-2.5 text-red-500" />}
              Realized PnL
            </span>
            <span className={`font-mono ${agent.totalPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>{agent.totalPnl >= 0 ? "+" : ""}{agent.totalPnl.toFixed(4)}</span>
          </div>
          <div className="flex items-center justify-between gap-1">
            <span className="text-muted-foreground flex items-center gap-1">
              {liveUnrealizedPnl >= 0 ? <ArrowUpRight className="h-2.5 w-2.5 text-emerald-500" /> : <ArrowDownRight className="h-2.5 w-2.5 text-red-500" />}
              Unrealized
            </span>
            <span className={`font-mono ${liveUnrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>{liveUnrealizedPnl >= 0 ? "+" : ""}{liveUnrealizedPnl.toFixed(4)}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
        <div className="flex items-center gap-1">
          <Shield className="h-3 w-3" />
          <span>{agent.leverage}x</span>
        </div>
        <div className="flex items-center gap-1">
          <Activity className="h-3 w-3" />
          <span>SL:{agent.stopLossBps}bps</span>
        </div>
        {agent.takeProfitBps && (
          <div className="flex items-center gap-1">
            <Zap className="h-3 w-3" />
            <span>TP:{agent.takeProfitBps}bps</span>
          </div>
        )}
        <div className="flex items-center gap-1">
          <TrendingUp className="h-3 w-3" />
          <span>{rewardSharePct}% rewards / {100 - rewardSharePct}% reinvest</span>
        </div>
        {agent.walletAddress && (
          <div className="flex items-center gap-1">
            <Wallet className="h-3 w-3" />
            <span className="font-mono truncate max-w-[100px]">{agent.walletAddress.slice(0, 6)}...{agent.walletAddress.slice(-4)}</span>
            <CopyButton text={agent.walletAddress} />
          </div>
        )}
      </div>

      {account?.address && (livePortfolioValue > 0 || agent.balance > 0 || hasOpenPositions) && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowRemoveCollateral(true)}
            className="flex-1"
            data-testid="button-remove-collateral"
          >
            <Unlock className="h-3.5 w-3.5 mr-1.5" />
            Remove All Collateral
          </Button>
          {canWithdraw && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowWithdraw(true)}
              className="flex-1"
              data-testid="button-withdraw-open"
            >
              <ArrowDownToLine className="h-3.5 w-3.5 mr-1.5" />
              Withdraw My Collateral
            </Button>
          )}
        </div>
      )}

      <WithdrawDialog agent={agent} open={showWithdraw} onOpenChange={setShowWithdraw} />
      <RemoveCollateralDialog agent={agent} open={showRemoveCollateral} onOpenChange={setShowRemoveCollateral} />

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <Tabs defaultValue="thinking" className="w-full">
          <TabsList className="w-full grid grid-cols-4">
            <TabsTrigger value="thinking" className="text-[10px]" data-testid="tab-thinking">
              <Brain className="h-3 w-3 mr-1" />
              Thinking
            </TabsTrigger>
            <TabsTrigger value="orders" className="text-[10px]" data-testid="tab-orders">
              <FileText className="h-3 w-3 mr-1" />
              Orders
            </TabsTrigger>
            <TabsTrigger value="positions" className="text-[10px]" data-testid="tab-positions">
              <Activity className="h-3 w-3 mr-1" />
              Positions
            </TabsTrigger>
            <TabsTrigger value="signals" className="text-[10px]" data-testid="tab-signals">
              <SignalIcon className="h-3 w-3 mr-1" />
              Signals
            </TabsTrigger>
          </TabsList>
          <TabsContent value="thinking" className="mt-2">
            <ThinkingProcess agentId={agent.id} reasoning={activity?.reasoning} />
          </TabsContent>
          <TabsContent value="orders" className="mt-2">
            <OrdersPanel orders={activity?.orders || []} />
          </TabsContent>
          <TabsContent value="positions" className="mt-2">
            <PositionsPanel positions={activity?.positions || []} livePrice={currentPrice} />
          </TabsContent>
          <TabsContent value="signals" className="mt-2">
            <SignalsPanel signals={activity?.signals || []} />
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
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="bg-muted rounded-md p-2 text-center">
            <p className="text-[9px] text-muted-foreground">Deposited (net)</p>
            <p className="text-xs font-mono font-bold" data-testid="text-wallet-deposited">{data.totalDepositedNet.toFixed(4)}</p>
            <p className="text-[8px] text-muted-foreground">{data.depositsCount} verified</p>
          </div>
          <div className="bg-muted rounded-md p-2 text-center">
            <p className="text-[9px] text-muted-foreground">Fees Paid</p>
            <p className="text-xs font-mono font-bold text-chart-4" data-testid="text-wallet-fees">{data.totalFeesPaid.toFixed(4)}</p>
            <p className="text-[8px] text-muted-foreground">2% protocol</p>
          </div>
          <div className="bg-muted rounded-md p-2 text-center">
            <p className="text-[9px] text-muted-foreground">Portfolio Value</p>
            <p className="text-xs font-mono font-bold" data-testid="text-wallet-portfolio">{portfolioTotal.toFixed(4)}</p>
            <p className="text-[8px] text-muted-foreground">{data.totalFreeBalance.toFixed(2)} free + {data.totalLockedCollateral.toFixed(2)} locked</p>
          </div>
          <div className="bg-muted rounded-md p-2 text-center">
            <p className="text-[9px] text-muted-foreground">Pending Rewards</p>
            <p className="text-xs font-mono font-bold text-emerald-500" data-testid="text-wallet-rewards">{data.totalPendingRewards.toFixed(4)}</p>
            <p className="text-[8px] text-muted-foreground">{data.totalClaimedVerified.toFixed(2)} verified claimed</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div className="flex items-center justify-between text-[10px] bg-muted rounded-md px-2 py-1.5">
            <span className="text-muted-foreground flex items-center gap-1">
              {data.totalRealizedPnl >= 0 ? <ArrowUpRight className="h-2.5 w-2.5 text-emerald-500" /> : <ArrowDownRight className="h-2.5 w-2.5 text-red-500" />}
              Realized PnL
            </span>
            <span className={`font-mono ${data.totalRealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {data.totalRealizedPnl >= 0 ? "+" : ""}{data.totalRealizedPnl.toFixed(4)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px] bg-muted rounded-md px-2 py-1.5">
            <span className="text-muted-foreground flex items-center gap-1">
              {data.totalUnrealizedPnl >= 0 ? <ArrowUpRight className="h-2.5 w-2.5 text-emerald-500" /> : <ArrowDownRight className="h-2.5 w-2.5 text-red-500" />}
              Unrealized PnL
            </span>
            <span className={`font-mono ${data.totalUnrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {data.totalUnrealizedPnl >= 0 ? "+" : ""}{data.totalUnrealizedPnl.toFixed(4)}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-2">
          <span>{data.verifiedOpenPositions} open + {data.verifiedClosedPositions} closed verified positions</span>
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

  const { data: agents, isLoading } = useQuery<AgentWithSignalAgent[]>({
    queryKey: ["/api/agents"],
    refetchInterval: 10000,
  });

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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-[10px] text-muted-foreground">Active Agents</p>
              <p className="text-lg font-bold font-mono" data-testid="text-active-count">{activeAgents.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-[10px] text-muted-foreground">Total Balance</p>
              <p className="text-lg font-bold font-mono">{allAgents.reduce((s, a) => s + a.balance, 0).toFixed(2)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-[10px] text-muted-foreground">Total PnL</p>
              <p className={`text-lg font-bold font-mono ${allAgents.reduce((s, a) => s + a.totalPnl, 0) >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                {allAgents.reduce((s, a) => s + a.totalPnl, 0).toFixed(2)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-[10px] text-muted-foreground">Total Trades</p>
              <p className="text-lg font-bold font-mono">{allAgents.reduce((s, a) => s + a.totalTrades, 0)}</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
