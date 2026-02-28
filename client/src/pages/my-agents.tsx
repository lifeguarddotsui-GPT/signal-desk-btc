import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
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
import type { AgentWithSignalAgent, Signal, Position, InstructionBundleRecord } from "@shared/schema";
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
  ExternalLink,
  Wallet,
  Shield,
  Zap,
  Copy,
  ArrowDownToLine,
  Loader2,
  AlertTriangle,
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
  Eye,
} from "lucide-react";

const VENUE_LABELS: Record<string, string> = {
  typus: "Typus Perps",
};

function TxLink({ txDigest, label }: { txDigest: string | null | undefined; label?: string }) {
  if (!txDigest) return null;
  const syntheticLabels: Record<string, { text: string; icon: "settled" | "liquidated" }> = {
    "liquidated_onchain": { text: "Liquidated", icon: "liquidated" },
    "settled_onchain": { text: "Settled", icon: "settled" },
    "prior_fill": { text: "Filled", icon: "settled" },
    "closed_externally": { text: "Settled", icon: "settled" },
  };
  const synthetic = syntheticLabels[txDigest];
  if (synthetic) {
    const isLiq = synthetic.icon === "liquidated";
    return (
      <span className={`flex items-center gap-1 text-[9px] ${isLiq ? "text-red-400" : "text-teal-400"}`} data-testid={isLiq ? "text-tx-liquidated" : "text-tx-settled"}>
        {isLiq ? <AlertTriangle className="h-2.5 w-2.5 shrink-0" /> : <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />}
        {label ? `${label}: ${synthetic.text}` : synthetic.text}
      </span>
    );
  }
  return (
    <a
      href={`https://suivision.xyz/txblock/${txDigest}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1 text-[9px] text-emerald-500 hover:underline"
      data-testid="link-tx-onchain"
    >
      <ExternalLink className="h-2.5 w-2.5 shrink-0" />
      {label ? `${label}` : txDigest.slice(0, 12) + "..."}
    </a>
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
    <button onClick={copy} className="text-muted-foreground hover:text-foreground transition-colors" data-testid="button-copy">
      {copied ? <CheckCircle className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

const THINKING_PHRASES = [
  "Scanning market microstructure...",
  "Cross-referencing RSI divergence signals...",
  "Evaluating momentum indicators...",
  "Analyzing order flow patterns...",
  "Computing Connors RSI confluence...",
  "Checking DEMA/TEMA crossover signals...",
  "Measuring volatility regime...",
  "Scoring condition matrix...",
  "Validating signal strength margin...",
  "Assessing trend direction consensus...",
];

function ActiveThinkingBanner({ reasoning }: { reasoning: any }) {
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [dots, setDots] = useState(1);

  useEffect(() => {
    const phraseTimer = setInterval(() => setPhraseIdx(i => (i + 1) % THINKING_PHRASES.length), 3500);
    const dotTimer = setInterval(() => setDots(d => d >= 3 ? 1 : d + 1), 600);
    return () => { clearInterval(phraseTimer); clearInterval(dotTimer); };
  }, []);

  const side = reasoning?.side;
  const signal = reasoning?.signal || "ANALYZING";
  const longScore = reasoning?.longScore ?? 0;
  const shortScore = reasoning?.shortScore ?? 0;
  const total = longScore + shortScore;
  const longPct = total === 0 ? 50 : Math.round((longScore / total) * 100);

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-3" data-testid="active-thinking-banner">
      <div className="flex items-center gap-2 mb-2">
        <div className="relative">
          <Brain className="h-4 w-4 text-primary animate-pulse" />
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full animate-ping" />
        </div>
        <p className="text-[10px] text-muted-foreground">
          {THINKING_PHRASES[phraseIdx]}{".".repeat(dots)}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="h-2 rounded-full bg-muted overflow-hidden flex">
            {total === 0 ? (
              <div className="h-full w-full bg-muted-foreground/20" />
            ) : (
              <>
                <div className="h-full bg-emerald-500/70 transition-all duration-700" style={{ width: `${longPct}%` }} />
                <div className="h-full bg-red-500/70 transition-all duration-700" style={{ width: `${100 - longPct}%` }} />
              </>
            )}
          </div>
          <div className="flex justify-between mt-0.5">
            <span className="text-[8px] font-mono text-emerald-500">LONG {longScore}</span>
            <span className="text-[8px] font-mono text-red-500">SHORT {shortScore}</span>
          </div>
        </div>
        <div className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase font-mono ${
          side === "long" ? "bg-emerald-500/20 text-emerald-400" :
          side === "short" ? "bg-red-500/20 text-red-400" :
          "bg-muted text-muted-foreground"
        }`} data-testid="text-signal-decision">
          {signal}
        </div>
      </div>
    </div>
  );
}

function ThinkingProcess({ agentId, reasoning }: { agentId: string; reasoning: any }) {
  if (!reasoning) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <div className="relative mb-3">
          <Brain className="h-10 w-10 text-muted-foreground/40" />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="w-3 h-3 rounded-full bg-primary/30 animate-ping" />
          </span>
        </div>
        <p className="text-xs text-muted-foreground">Waiting for signal analysis...</p>
        <p className="text-[10px] text-muted-foreground/60 mt-1">The sub-agent will analyze when the market engine ticks</p>
      </div>
    );
  }

  const sideColor = reasoning.side === "long" ? "text-emerald-500" : reasoning.side === "short" ? "text-red-500" : "text-muted-foreground";
  const SideIcon = reasoning.side === "long" ? TrendingUp : reasoning.side === "short" ? TrendingDown : Minus;
  const metConditions = reasoning.conditions?.filter((c: any) => c.met) || [];
  const totalConditions = reasoning.conditions?.length || 7;

  return (
    <div className="space-y-3" data-testid="agent-thinking-process">
      <ActiveThinkingBanner reasoning={reasoning} />

      <div className="flex items-center gap-3 bg-card/60 rounded-lg p-2.5 border border-border/30">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
          reasoning.side === "long" ? "bg-emerald-500/15 ring-1 ring-emerald-500/30" :
          reasoning.side === "short" ? "bg-red-500/15 ring-1 ring-red-500/30" :
          "bg-muted ring-1 ring-border"
        }`}>
          <SideIcon className={`h-4 w-4 ${sideColor}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-bold uppercase ${sideColor}`}>{reasoning.signal}</span>
            <Badge variant="outline" className="text-[8px]">{metConditions.length}/{totalConditions}</Badge>
          </div>
          <p className="text-[10px] text-muted-foreground font-mono truncate">{reasoning.reason}</p>
        </div>
      </div>

      {reasoning.conditions && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
            <Activity className="h-3 w-3" />
            Conditions ({metConditions.length}/{totalConditions} met)
          </p>
          <div className="grid gap-0.5">
            {reasoning.conditions.map((cond: any, i: number) => (
              <div key={i} className={`flex items-center gap-2 rounded px-2.5 py-1.5 ${
                cond.met ? "bg-emerald-500/5 border border-emerald-500/10" : "bg-card/30"
              }`}>
                {cond.met ? (
                  <CheckCircle className="h-3 w-3 text-emerald-500 shrink-0" />
                ) : (
                  <XCircle className="h-3 w-3 text-muted-foreground/40 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className={`text-[10px] font-medium truncate ${cond.met ? "text-foreground" : "text-muted-foreground/60"}`}>{cond.name}</p>
                </div>
                <span className={`text-[8px] font-mono font-bold shrink-0 ${
                  cond.direction === "long" ? "text-emerald-500" :
                  cond.direction === "short" ? "text-red-500" :
                  "text-muted-foreground/50"
                }`}>
                  {(cond.direction || "—").toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {reasoning.indicators && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
            <SignalIcon className="h-3 w-3" />
            Indicators
          </p>
          <div className="grid grid-cols-2 gap-0.5">
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
              const isBullish = displayVal === "Bullish" || displayVal === "up";
              const isBearish = displayVal === "Bearish" || displayVal === "down";

              return (
                <div key={key} className="flex items-center justify-between px-2.5 py-1.5 rounded bg-card/30">
                  <span className="text-[9px] text-muted-foreground uppercase">{key}</span>
                  <span className={`text-[11px] font-mono font-bold ${
                    isBullish ? "text-emerald-500" : isBearish ? "text-red-500" : ""
                  }`}>{displayVal}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
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
          {closeMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} className="text-[9px] h-6 px-1" data-testid={`button-cancel-close-${positionId}`}>
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
      title={!account?.address ? "Connect wallet to close" : "Close this position on-chain"}
      data-testid={`button-close-position-${positionId}`}
    >
      <X className="h-3 w-3 mr-0.5" />Close
    </Button>
  );
}

function PositionsPanel({ positions, livePrice, leverage, agentId }: { positions: Position[]; livePrice: number; leverage: number; agentId: string }) {
  if (!positions || positions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Activity className="h-8 w-8 text-muted-foreground/30 mb-2" />
        <p className="text-xs text-muted-foreground">No positions yet</p>
        <p className="text-[10px] text-muted-foreground/60 mt-1">Positions appear when the agent opens trades on-chain</p>
      </div>
    );
  }

  const openPositions = positions.filter((p) => p.status === "open");
  const closedPositions = positions.filter((p) => p.status === "closed");

  return (
    <div className="space-y-4" data-testid="positions-panel">
      {openPositions.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
              <Lock className="h-3 w-3 text-primary" />
              Open Positions ({openPositions.length})
            </p>
          </div>
          {openPositions.map((pos) => {
            const pnl = livePrice > 0
              ? (pos.side === "long"
                ? (livePrice - pos.entryPrice) * pos.sizeSui / livePrice
                : (pos.entryPrice - livePrice) * pos.sizeSui / livePrice)
              : 0;
            const collateral = pos.collateral || (pos.sizeSui / leverage);
            const cappedPnl = Math.max(-collateral, pnl);
            const pnlPercent = pos.entryPrice > 0
              ? (pos.side === "long"
                ? ((livePrice - pos.entryPrice) / pos.entryPrice) * 100
                : ((pos.entryPrice - livePrice) / pos.entryPrice) * 100)
              : 0;
            const liqDenom = pos.liquidationPrice && pos.liquidationPrice > 0
              ? (pos.side === "long"
                ? pos.entryPrice - pos.liquidationPrice
                : pos.liquidationPrice - pos.entryPrice)
              : 0;
            const collateralLossPct = liqDenom > 0
              ? Math.min(100, Math.max(0, (
                  pos.side === "long"
                    ? (pos.entryPrice - livePrice) / liqDenom
                    : (livePrice - pos.entryPrice) / liqDenom
                ) * 100))
              : (cappedPnl < 0 ? Math.min(100, (-cappedPnl / collateral) * 100) : 0);

            return (
              <div key={pos.id} className="rounded-lg border border-border/40 bg-card/50 p-3 space-y-2" data-testid={`position-open-${pos.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant={pos.side === "long" ? "default" : "destructive"} className="text-[10px]">
                      {pos.side.toUpperCase()}
                    </Badge>
                    <span className="text-xs font-mono font-bold">{pos.sizeSui.toFixed(2)} SUI</span>
                    <Badge variant="outline" className="text-[8px] font-mono" data-testid={`badge-leverage-${pos.id}`}>
                      {leverage}x
                    </Badge>
                  </div>
                  <ClosePositionButton agentId={agentId} positionId={pos.id} side={pos.side} sizeSui={pos.sizeSui} />
                </div>

                <div className="flex items-center justify-between">
                  <span className={`text-sm font-mono font-bold ${cappedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid={`text-pnl-${pos.id}`}>
                    {cappedPnl >= 0 ? "+" : ""}{cappedPnl.toFixed(4)} SUI
                    <span className="text-[10px] ml-1 opacity-70">({pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(2)}%)</span>
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[9px]">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Entry</span>
                    <span className="font-mono">${pos.entryPrice.toFixed(4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Mark</span>
                    <span className="font-mono">${livePrice.toFixed(4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Collateral</span>
                    <span className="font-mono text-primary">{collateral.toFixed(4)} SUI <Lock className="h-2 w-2 inline" /></span>
                  </div>
                  {pos.liquidationPrice && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Liquidation</span>
                      <span className="font-mono text-red-400">${pos.liquidationPrice.toFixed(4)}</span>
                    </div>
                  )}
                </div>

                {collateralLossPct > 0 && (
                  <div className="space-y-0.5">
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          collateralLossPct > 50 ? "bg-red-500" : collateralLossPct > 25 ? "bg-amber-500" : "bg-primary"
                        }`}
                        style={{ width: `${Math.min(100, collateralLossPct)}%` }}
                      />
                    </div>
                    <p className="text-[8px] text-muted-foreground text-right">{collateralLossPct.toFixed(1)}% collateral at risk</p>
                  </div>
                )}

                <TxLink txDigest={pos.txDigest} label="Open TX" />
              </div>
            );
          })}
        </div>
      )}

      {closedPositions.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Closed ({closedPositions.length})</p>
            {(() => {
              const wins = closedPositions.filter(p => (p.unrealizedPnl || 0) > 0).length;
              const totalPnl = closedPositions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
              return (
                <div className="flex items-center gap-2 text-[9px]">
                  <span className={`font-mono font-bold ${totalPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                    {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(4)} SUI
                  </span>
                  <Badge variant="outline" className="text-[8px]">{wins}W/{closedPositions.length - wins}L</Badge>
                </div>
              );
            })()}
          </div>
          {closedPositions.map((pos) => {
            const collateral = pos.collateral || (pos.sizeSui / leverage);
            const pnl = pos.unrealizedPnl || 0;
            const isLiquidated = pos.closeReason === "liquidated" || pos.closeTxDigest === "liquidated_onchain";
            const returned = isLiquidated ? 0 : Math.max(0, collateral + pnl);
            const collateralLossPct = Math.min(100, Math.max(0, (-pnl / collateral) * 100));
            const priceMovePct = pos.entryPrice > 0
              ? (pos.side === "long"
                ? ((pos.markPrice - pos.entryPrice) / pos.entryPrice) * 100
                : ((pos.entryPrice - pos.markPrice) / pos.entryPrice) * 100)
              : 0;

            const closeReasonLabel: Record<string, string> = {
              "stop-loss": "Stop Loss",
              "take-profit": "Take Profit",
              "emergency-liquidation-prevent": "Emergency Close",
              "max-collateral-loss": "Max Loss Cap",
              "manual": "Manual Close",
              "agent-shutdown": "Agent Shutdown",
              "agent-deletion": "Agent Deleted",
              "withdrawal": "Withdrawal",
              "recovery": "Recovery",
              "liquidated": "Liquidated",
              "settled_onchain": "Settled On-Chain",
            };

            return (
              <div key={pos.id} className="rounded bg-card/30 px-3 py-2 space-y-1.5" data-testid={`position-closed-${pos.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Badge variant={pos.side === "long" ? "default" : "destructive"} className="text-[9px] opacity-70">
                      {pos.side.toUpperCase()}
                    </Badge>
                    {isLiquidated && <Badge variant="destructive" className="text-[7px]" data-testid={`badge-liquidated-${pos.id}`}>LIQ</Badge>}
                    <span className="text-[10px] font-mono">{pos.sizeSui.toFixed(2)} SUI</span>
                    {pos.closeReason && (
                      <Badge variant="outline" className="text-[7px] opacity-60">
                        {closeReasonLabel[pos.closeReason] || pos.closeReason}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className={`text-[11px] font-mono font-bold ${pnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                      {pnl >= 0 ? "+" : ""}{pnl.toFixed(4)}
                    </span>
                    {pos.closeTxDigest && !["settled_onchain", "liquidated_onchain", "prior_fill", "closed_externally"].includes(pos.closeTxDigest) && (
                      <a
                        href={`https://suivision.xyz/txblock/${pos.closeTxDigest}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:text-primary/80"
                        title="Verify PnL on-chain"
                        data-testid={`link-pnl-verify-${pos.id}`}
                      >
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[8px]">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Collateral</span>
                    <span className="font-mono">{collateral.toFixed(4)} SUI</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Price Move</span>
                    <span className={`font-mono ${priceMovePct >= 0 ? "text-emerald-500" : "text-red-400"}`}>
                      {priceMovePct >= 0 ? "+" : ""}{priceMovePct.toFixed(3)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Entry</span>
                    <span className="font-mono">${pos.entryPrice.toFixed(4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Exit</span>
                    <span className="font-mono">${pos.markPrice.toFixed(4)}</span>
                  </div>
                </div>

                <div className="text-[8px] text-muted-foreground border-t border-border/20 pt-1">
                  {isLiquidated ? (
                    <span className="text-red-400">Collateral lost: -{collateral.toFixed(4)} SUI (100%)</span>
                  ) : pnl < 0 ? (
                    <span className="text-red-400">
                      Loss: {priceMovePct.toFixed(3)}% × {leverage}x lev = {(Math.abs(priceMovePct) * leverage).toFixed(1)}% of collateral → -{Math.min(collateral, Math.abs(pnl)).toFixed(4)} SUI | Returned: {returned.toFixed(4)} SUI
                    </span>
                  ) : (
                    <span className="text-emerald-500">
                      Gain: +{priceMovePct.toFixed(3)}% × {leverage}x lev → +{pnl.toFixed(4)} SUI | Returned: {returned.toFixed(4)} SUI
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <TxLink txDigest={pos.txDigest} label="Open" />
                  <TxLink txDigest={pos.closeTxDigest} label="Close" />
                  {pos.closedAt && <span className="text-[8px] text-muted-foreground/50">{new Date(pos.closedAt).toLocaleString()}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FundStatus({ agent, positions, livePrice, activity }: {
  agent: AgentWithSignalAgent;
  positions: Position[];
  livePrice: number;
  activity: any;
}) {
  const { toast } = useToast();
  const [recovering, setRecovering] = useState(false);

  const recoverMutation = useMutation({
    mutationFn: async () => {
      const [orphanRes, pnlRes] = await Promise.all([
        apiRequest("POST", `/api/agents/${agent.id}/recover-orphaned-orders`).then(r => r.json()),
        apiRequest("POST", `/api/agents/${agent.id}/recalculate-pnl`).then(r => r.json()),
      ]);
      return { orphan: orphanRes, pnl: pnlRes };
    },
    onSuccess: (data: any) => {
      const parts: string[] = [];
      if (data.orphan?.cancelled > 0) parts.push(`Recovered ${data.orphan.cancelled} orphaned orders.`);
      if (data.pnl?.corrected > 0) {
        const corrections = (data.pnl.corrections || []).map((c: any) => `${c.side}: ${c.oldPnl.toFixed(2)} → ${c.newPnl.toFixed(2)} SUI`).join("; ");
        parts.push(`Fixed ${data.pnl.corrected} position PnL${corrections ? `: ${corrections}` : ""}.`);
      }
      if (data.pnl?.rewardsCreated > 0) parts.push(`Created ${data.pnl.rewardsCreated} missing reward(s).`);
      if (parts.length === 0) parts.push("No issues found. All positions and orders verified.");
      toast({ title: "Recovery & verification complete", description: parts.join(" ") });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id, "activity"] });
      setRecovering(false);
    },
    onError: (err: Error) => {
      toast({ title: "Recovery failed", description: err.message, variant: "destructive" });
      setRecovering(false);
    },
  });

  const openPositions = positions.filter(p => p.status === "open");
  const leverage = agent.leverage;

  const totalLocked = openPositions.reduce((s, p) => s + (p.collateral || p.sizeSui / leverage), 0);

  const deposited = agent.totalDeposited || 0;
  const fees = agent.protocolFeePaid || 0;
  const netDeposited = deposited - fees;

  const onChainWallet = activity?.onChainWalletSui ?? Math.max(0, agent.balance - totalLocked);
  const pendingOrderCollateral = activity?.pendingOrderCollateral ?? 0;
  const pendingOrders = activity?.pendingOrders ?? [];
  const gasCosts = activity?.gasCosts ?? 0;
  const lostCollateral = activity?.lostCollateral ?? 0;
  const realizedPnl = (activity?.realizedGain || 0) + (activity?.realizedLoss || 0);

  let liveUnrealizedPnl = 0;
  for (const pos of openPositions) {
    if (livePrice > 0) {
      const rawPnl = pos.side === "long"
        ? (livePrice - pos.entryPrice) * pos.sizeSui / livePrice
        : (pos.entryPrice - livePrice) * pos.sizeSui / livePrice;
      const posCollateral = pos.collateral || (pos.sizeSui / leverage);
      liveUnrealizedPnl += Math.max(-posCollateral, rawPnl);
    } else {
      liveUnrealizedPnl += pos.unrealizedPnl || 0;
    }
  }

  const totalPortfolioValue = onChainWallet + totalLocked + liveUnrealizedPnl + pendingOrderCollateral;

  return (
    <div className="space-y-3" data-testid="fund-status">
      <div className="rounded-lg border border-border/30 bg-card/40 p-3 space-y-3">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <Eye className="h-3 w-3" />
          Where Your SUI Is
        </p>

        <div className="rounded-lg bg-primary/5 border border-primary/20 p-2.5 flex items-center justify-between">
          <div>
            <p className="text-[8px] text-muted-foreground">Total Portfolio Value</p>
            <p className="text-[7px] text-muted-foreground/60">On-chain verified</p>
          </div>
          <p className="text-lg font-mono font-bold" data-testid="text-total-portfolio">{totalPortfolioValue.toFixed(2)} <span className="text-xs text-muted-foreground">SUI</span></p>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between rounded bg-card/60 border border-border/20 px-2.5 py-1.5">
            <span className="text-[9px] text-muted-foreground flex items-center gap-1">
              <Wallet className="h-2.5 w-2.5" />On-Chain Wallet
            </span>
            <span className="text-[11px] font-mono font-bold" data-testid="text-onchain-wallet">{onChainWallet.toFixed(4)} SUI</span>
          </div>

          <div className="flex items-center justify-between rounded bg-card/60 border border-border/20 px-2.5 py-1.5">
            <span className="text-[9px] text-muted-foreground flex items-center gap-1">
              <Lock className="h-2.5 w-2.5 text-primary" />In Positions
            </span>
            <span className="text-[11px] font-mono font-bold text-primary" data-testid="text-locked">
              {totalLocked.toFixed(4)} SUI
              <span className="text-[8px] text-muted-foreground ml-1">({openPositions.length} pos)</span>
            </span>
          </div>

          {pendingOrderCollateral > 0.001 && (
            <div className="flex items-center justify-between rounded bg-amber-500/5 border border-amber-500/20 px-2.5 py-1.5">
              <span className="text-[9px] text-amber-400 flex items-center gap-1">
                <Clock className="h-2.5 w-2.5" />In Pending Orders
              </span>
              <span className="text-[11px] font-mono font-bold text-amber-400" data-testid="text-pending-orders">
                {pendingOrderCollateral.toFixed(4)} SUI
                <span className="text-[8px] text-amber-400/60 ml-1">({pendingOrders.length} orders)</span>
              </span>
            </div>
          )}

          {liveUnrealizedPnl !== 0 && (
            <div className="flex items-center justify-between rounded bg-card/60 border border-border/20 px-2.5 py-1.5">
              <span className="text-[9px] text-muted-foreground flex items-center gap-1">
                <TrendingUp className="h-2.5 w-2.5" />Unrealized PnL
              </span>
              <span className={`text-[11px] font-mono font-bold ${liveUnrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid="text-unrealized-pnl">
                {liveUnrealizedPnl >= 0 ? "+" : ""}{liveUnrealizedPnl.toFixed(4)} SUI
              </span>
            </div>
          )}
        </div>

        <div className="border-t border-border/20 pt-2 space-y-1">
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider">Accounting</p>
          <div className="flex items-center justify-between text-[9px]">
            <span className="text-muted-foreground">Net Deposited</span>
            <span className="font-mono" data-testid="text-deposited">{netDeposited.toFixed(2)} SUI</span>
          </div>
          {fees > 0 && (
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-muted-foreground/60">Protocol Fee</span>
              <span className="font-mono text-muted-foreground/60">-{fees.toFixed(4)} SUI</span>
            </div>
          )}
          {realizedPnl !== 0 && (
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-muted-foreground">Realized PnL</span>
              <span className={`font-mono font-bold ${realizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid="text-realized-pnl">
                {realizedPnl >= 0 ? "+" : ""}{realizedPnl.toFixed(4)} SUI
              </span>
            </div>
          )}
          {gasCosts > 0.001 && (
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-muted-foreground">Gas Costs</span>
              <span className="font-mono text-orange-400" data-testid="text-gas-costs">-{gasCosts.toFixed(4)} SUI</span>
            </div>
          )}
          {lostCollateral > 0.01 && (
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-red-400">Unrecovered</span>
              <span className="font-mono font-bold text-red-500" data-testid="text-lost-collateral">-{lostCollateral.toFixed(4)} SUI</span>
            </div>
          )}
          <div className="flex items-center justify-between text-[9px] pt-1">
            <button
              className="text-[9px] px-2 py-1 rounded bg-teal-500/20 hover:bg-teal-500/40 text-teal-300 border border-teal-500/30 transition-colors disabled:opacity-50 w-full"
              data-testid="button-recover-collateral"
              disabled={recoverMutation.isPending}
              onClick={() => {
                setRecovering(true);
                recoverMutation.mutate();
              }}
            >
              {recoverMutation.isPending ? "Verifying & Recovering..." : "Verify & Recover"}
            </button>
          </div>
        </div>
      </div>

      {openPositions.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Collateral per Position</p>
          {openPositions.map((pos) => {
            const collateral = pos.collateral || (pos.sizeSui / leverage);
            const pnl = livePrice > 0
              ? (pos.side === "long"
                ? (livePrice - pos.entryPrice) * pos.sizeSui / livePrice
                : (pos.entryPrice - livePrice) * pos.sizeSui / livePrice)
              : 0;
            const cappedPnl = Math.max(-collateral, pnl);
            const riskPct = cappedPnl < 0 ? Math.min(100, (-cappedPnl / collateral) * 100) : 0;

            return (
              <div key={pos.id} className="flex items-center gap-2 rounded bg-card/40 px-2.5 py-1.5 border border-border/20" data-testid={`collateral-row-${pos.id}`}>
                <Badge variant={pos.side === "long" ? "default" : "destructive"} className="text-[8px] px-1 py-0 shrink-0">
                  {pos.side.toUpperCase()}
                </Badge>
                <span className="text-[9px] font-mono flex-1">{collateral.toFixed(2)} SUI locked</span>
                <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full ${riskPct > 25 ? "bg-red-500" : riskPct > 10 ? "bg-amber-500" : "bg-emerald-500"}`}
                    style={{ width: `${Math.max(2, riskPct)}%` }}
                  />
                </div>
                <span className={`text-[8px] font-mono shrink-0 ${riskPct > 25 ? "text-red-500" : "text-muted-foreground"}`}>
                  {riskPct > 0 ? `-${riskPct.toFixed(0)}%` : "safe"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {pendingOrders.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-amber-400 uppercase tracking-wider flex items-center gap-1">
            <Clock className="h-3 w-3" />Pending Orders (Awaiting Match)
          </p>
          {pendingOrders.map((order: any) => (
            <div key={order.orderId} className="flex items-center gap-2 rounded bg-amber-500/5 px-2.5 py-1.5 border border-amber-500/10" data-testid={`pending-order-${order.orderId}`}>
              <Badge variant={order.direction === "long" ? "default" : "destructive"} className="text-[8px] px-1 py-0 shrink-0">
                {order.direction.toUpperCase()}
              </Badge>
              <span className="text-[9px] font-mono flex-1">{order.collateral.toFixed(2)} SUI collateral</span>
              <span className="text-[8px] font-mono text-amber-400/60">#{order.orderId}</span>
              <span className="text-[8px] text-muted-foreground">{order.ageSeconds}s ago</span>
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
        <SignalIcon className="h-8 w-8 text-muted-foreground/30 mb-2" />
        <p className="text-xs text-muted-foreground">No signals recorded</p>
      </div>
    );
  }

  return (
    <div className="space-y-0.5" data-testid="signals-panel">
      {signals.map((sig) => (
        <div key={sig.id} className="flex items-center gap-2 rounded px-2.5 py-1.5 bg-card/30">
          {sig.signal === "long" ? (
            <TrendingUp className="h-3 w-3 text-emerald-500 shrink-0" />
          ) : sig.signal === "short" ? (
            <TrendingDown className="h-3 w-3 text-red-500 shrink-0" />
          ) : (
            <Minus className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
          <span className={`text-[10px] font-bold uppercase w-10 shrink-0 ${sig.signal === "long" ? "text-emerald-500" : sig.signal === "short" ? "text-red-500" : "text-muted-foreground"}`}>
            {sig.signal}
          </span>
          <span className="text-[9px] font-mono text-muted-foreground">${sig.price.toFixed(4)}</span>
          <span className="text-[9px] font-mono text-muted-foreground ml-auto shrink-0">
            RSI:{sig.rsi.toFixed(0)}
          </span>
          <span className="text-[8px] text-muted-foreground/50 shrink-0">
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

function BundlesPanel({ agentId, suiPrice }: { agentId: string; suiPrice: number }) {
  const { data: bundles, isLoading } = useQuery<InstructionBundleRecord[]>({
    queryKey: ["/api/bundles", agentId, "latest"],
    refetchInterval: 5000,
  });

  if (isLoading) return <Skeleton className="h-32 w-full" />;

  if (!bundles || bundles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Package className="h-8 w-8 text-muted-foreground/30 mb-2" />
        <p className="text-xs text-muted-foreground">No execution bundles</p>
        <p className="text-[10px] text-muted-foreground/60 mt-1">Created when the agent detects actionable signals</p>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="bundles-panel">
      <div className="flex items-center gap-1.5 flex-wrap">
        {Object.entries(bundles.reduce((acc, b) => { acc[b.status] = (acc[b.status] || 0) + 1; return acc; }, {} as Record<string, number>)).map(([status, count]) => {
          const config = BUNDLE_STATUS_CONFIG[status] || BUNDLE_STATUS_CONFIG.pending;
          const Icon = config.icon;
          return (
            <Badge key={status} variant="outline" className="text-[8px] gap-0.5">
              <Icon className={`h-2 w-2 ${config.color}`} />{config.label}: {count}
            </Badge>
          );
        })}
      </div>

      <div className="space-y-1">
        {bundles.slice(0, 15).map((bundle) => {
          const config = BUNDLE_STATUS_CONFIG[bundle.status] || BUNDLE_STATUS_CONFIG.pending;
          const StatusIcon = config.icon;
          const actions = (bundle.actions as any[]) || [];

          return (
            <div key={bundle.id} className="rounded bg-card/30 px-2.5 py-2 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <StatusIcon className={`h-3 w-3 ${config.color} shrink-0`} />
                  <span className="text-[9px] font-mono truncate" data-testid={`text-bundle-id-${bundle.id}`}>
                    {bundle.bundleId.slice(0, 8)}
                  </span>
                  {actions.map((action: any, i: number) => (
                    <Badge key={i} variant="outline" className="text-[8px] gap-0.5">
                      {action.type === "OPEN" && (
                        <>{action.side === "LONG" ? <TrendingUp className="h-2 w-2 text-emerald-500" /> : <TrendingDown className="h-2 w-2 text-red-500" />}{action.side} {action.leverage}x</>
                      )}
                      {action.type === "CLOSE" && <><XCircle className="h-2 w-2" />Close</>}
                      {action.type === "SET_SLTP" && "SL/TP"}
                      {action.type === "NOOP" && (action.reason || "Skip")}
                    </Badge>
                  ))}
                </div>
                <Badge
                  variant={bundle.status === "completed" || bundle.status === "recorded" ? "default" : bundle.status === "failed" || bundle.status === "rejected" ? "destructive" : "secondary"}
                  className="text-[7px]"
                  data-testid={`badge-bundle-status-${bundle.id}`}
                >
                  {config.label}
                </Badge>
              </div>

              {(bundle as any).executionError && (bundle.status === "rejected" || bundle.status === "failed") && (
                <p className="text-[8px] text-red-400 bg-red-500/10 rounded px-2 py-1 font-mono break-all" data-testid={`text-bundle-error-${bundle.id}`}>
                  {(bundle as any).executionError}
                </p>
              )}

              <span className="text-[8px] text-muted-foreground/50">
                {bundle.createdAt ? new Date(bundle.createdAt).toLocaleString() : ""}
              </span>
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
      const [authCoin] = tx.splitCoins(tx.gas, [authAmount]);
      tx.transferObjects([authCoin], PROTOCOL_FEE_ADDRESS);

      setWithdrawStatus("signing");

      const result = await new Promise<{ digest: string }>((resolve, reject) => {
        signAndExecute(
          { transaction: tx },
          { onSuccess: (data) => resolve(data), onError: (err) => reject(err) }
        );
      });

      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction signing failed");

      setWithdrawStatus("verifying");
      const verification = await waitForFinalized(txDigest);
      if (verification.status !== "success") throw new Error(verification.error || "Authorization failed on-chain");

      setWithdrawStatus("processing");
      const res = await apiRequest("POST", `/api/agents/${agent.id}/withdraw`, {
        amount: amt,
        toAddress: account.address,
        authTxDigest: txDigest,
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Withdrawal successful", description: `${data.amount.toFixed(4)} SUI sent. Tx: ${data.txDigest.slice(0, 12)}...` });
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

  const statusLabel = withdrawStatus === "signing" ? "Approve in wallet..." : withdrawStatus === "verifying" ? "Verifying on-chain..." : withdrawStatus === "processing" ? "Processing..." : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Withdraw from {agent.name}</DialogTitle>
          <DialogDescription>Withdraw SUI from this agent to your wallet.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">On-chain balance</span>
            <span className="text-sm font-mono font-bold">{onChainSui.toFixed(4)} SUI</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Max withdrawable</span>
            <span className="text-sm font-mono font-bold text-primary">{maxWithdrawable.toFixed(4)} SUI</span>
          </div>
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
            <Button variant="outline" size="sm" onClick={() => setWithdrawAmount(maxWithdrawable.toFixed(4))} data-testid="button-withdraw-max">
              Max
            </Button>
          </div>
          {statusLabel && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />{statusLabel}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-withdraw-cancel">Cancel</Button>
          <Button
            onClick={() => withdrawMutation.mutate()}
            disabled={withdrawMutation.isPending || !account?.address || !withdrawAmount || parseFloat(withdrawAmount) <= 0}
            data-testid="button-withdraw-confirm"
          >
            {withdrawMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ArrowDownToLine className="h-4 w-4 mr-1" />}
            Withdraw
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
      if (!onChainData || onChainData.onChainSui <= 0.002) throw new Error("On-chain balance too low for gas");

      const authAmount = BigInt(1000);
      const tx = new Transaction();
      const [authCoin] = tx.splitCoins(tx.gas, [authAmount]);
      tx.transferObjects([authCoin], PROTOCOL_FEE_ADDRESS);

      setRefundStatus("signing");
      const result = await new Promise<{ digest: string }>((resolve, reject) => {
        signAndExecute(
          { transaction: tx },
          { onSuccess: (data) => resolve(data), onError: (err) => reject(err) }
        );
      });

      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction signing failed");

      setRefundStatus("verifying");
      const verification = await waitForFinalized(txDigest);
      if (verification.status !== "success") throw new Error(verification.error || "Authorization failed on-chain");

      setRefundStatus("processing");
      const res = await apiRequest("POST", `/api/agents/${agent.id}/refund`, {
        toAddress: account.address,
        authTxDigest: txDigest,
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Refund successful", description: `${data.amount.toFixed(4)} SUI returned. Tx: ${data.txDigest.slice(0, 12)}...` });
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

  const statusLabel = refundStatus === "signing" ? "Approve in wallet..." : refundStatus === "verifying" ? "Verifying..." : refundStatus === "processing" ? "Processing..." : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Recover Funds from {agent.name}</DialogTitle>
          <DialogDescription>Return all remaining on-chain SUI to your wallet.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">On-Chain Balance</span>
            <span className="text-sm font-mono font-bold">{onChainData ? `${onChainData.onChainSui.toFixed(4)} SUI` : "Loading..."}</span>
          </div>
          {onChainData?.mismatch && (
            <div className="flex items-center gap-2 text-xs text-amber-500">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />Balance mismatch detected
            </div>
          )}
          {onChainData && onChainData.onChainSui <= 0.002 && (
            <p className="text-xs text-red-500">Balance too low to cover gas for refund</p>
          )}
          {statusLabel && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />{statusLabel}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-refund-cancel">Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => refundMutation.mutate()}
            disabled={refundMutation.isPending || !account?.address || !onChainData || onChainData.onChainSui <= 0.002}
            data-testid="button-refund-confirm"
          >
            {refundMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ArrowDownToLine className="h-4 w-4 mr-1" />}
            Refund All
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
      const [authCoin] = tx.splitCoins(tx.gas, [authAmount]);
      tx.transferObjects([authCoin], PROTOCOL_FEE_ADDRESS);

      setRemoveStatus("signing");
      const result = await new Promise<{ digest: string }>((resolve, reject) => {
        signAndExecute(
          { transaction: tx },
          { onSuccess: (data) => resolve(data), onError: (err) => reject(err) }
        );
      });

      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction signing failed");

      setRemoveStatus("verifying");
      const verification = await waitForFinalized(txDigest);
      if (verification.status !== "success") throw new Error(verification.error || "Authorization failed on-chain");

      setRemoveStatus("processing");
      const res = await apiRequest("POST", `/api/agents/${agent.id}/remove-collateral`, {
        toAddress: account.address,
        authTxDigest: txDigest,
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.withdrawFailed) {
        toast({ title: "Transfer failed", description: "Positions closed but on-chain transfer failed. Try Withdraw instead.", variant: "destructive" });
      } else {
        const desc = [
          data.closedPositions > 0 ? `Closed ${data.closedPositions} position(s)` : "",
          data.withdrawnAmount > 0 ? `Withdrew ${data.withdrawnAmount.toFixed(4)} SUI` : "",
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
      toast({ title: "Failed", description: err.message, variant: "destructive" });
      setRemoveStatus("idle");
    },
  });

  const statusLabel = removeStatus === "signing" ? "Approve in wallet..." : removeStatus === "verifying" ? "Verifying..." : removeStatus === "processing" ? "Closing positions & withdrawing..." : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove All Collateral</DialogTitle>
          <DialogDescription>Closes all positions, stops the agent, and withdraws everything to your wallet.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">You will receive</span>
            <span className="text-sm font-mono font-bold text-emerald-500">~{estimatedReceive.toFixed(4)} SUI</span>
          </div>
          <div className="bg-destructive/10 border border-destructive/20 rounded-md p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="text-xs text-muted-foreground">
                <p className="font-medium text-destructive">This will:</p>
                <ul className="list-disc list-inside mt-1 space-y-0.5">
                  <li>Close all open positions at market price</li>
                  <li>Stop the agent from trading</li>
                  <li>Transfer all remaining SUI to your wallet</li>
                </ul>
              </div>
            </div>
          </div>
          {statusLabel && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />{statusLabel}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-remove-cancel">Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => removeCollateralMutation.mutate()}
            disabled={removeCollateralMutation.isPending || !account?.address}
            data-testid="button-remove-confirm"
          >
            {removeCollateralMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Unlock className="h-4 w-4 mr-1" />}
            Remove All
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
        toast({ title: "Balance synced", description: `${data.previousBalance.toFixed(4)} → ${data.newBalance.toFixed(4)} SUI` });
      } else {
        toast({ title: "Already in sync", description: data.message });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id] });
    },
    onError: (err: any) => toast({ title: "Sync failed", description: err.message, variant: "destructive" }),
  });

  const resumeMutation = useMutation({
    mutationFn: async () => {
      const walletParam = account?.address ? `?wallet=${account.address}` : "";
      const res = await apiRequest("POST", `/api/agents/${agent.id}/resume${walletParam}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Agent resumed" });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
    },
    onError: (err: any) => toast({ title: "Resume failed", description: err.message, variant: "destructive" }),
  });

  const isRunning = agent.status === "running";
  const openPositions = activity?.positions?.filter(p => p.status === "open") || [];
  const hasOpenPositions = openPositions.length > 0;

  let liveUnrealizedPnl = 0;
  let liveLockedCollateral = 0;
  if (currentPrice > 0 && openPositions.length > 0) {
    for (const pos of openPositions) {
      const rawPnl = pos.side === "long"
        ? (currentPrice - pos.entryPrice) * pos.sizeSui / currentPrice
        : (pos.entryPrice - currentPrice) * pos.sizeSui / currentPrice;
      const posCollateral = pos.sizeSui / agent.leverage;
      liveUnrealizedPnl += Math.max(-posCollateral, rawPnl);
      liveLockedCollateral += posCollateral;
    }
  } else {
    liveUnrealizedPnl = activity?.totalUnrealizedPnl ?? 0;
    liveLockedCollateral = activity?.lockedCollateral ?? 0;
  }

  const onChainWallet = activity?.onChainWalletSui ?? Math.max(0, agent.balance - liveLockedCollateral);
  const pendingOrderCollateral = activity?.pendingOrderCollateral ?? 0;
  const livePortfolioValue = onChainWallet + liveLockedCollateral + liveUnrealizedPnl + pendingOrderCollateral;
  const realizedPnlFromPositions = (activity?.realizedGain || 0) + (activity?.realizedLoss || 0);
  const liveTotalPnl = activity ? realizedPnlFromPositions + liveUnrealizedPnl - (activity.gasCosts || 0) - (activity.lostCollateral || 0) : agent.totalPnl + liveUnrealizedPnl;
  const winRate = activity?.liveWinRate ?? agent.winRate;
  const rewardSharePct = agent.rewardSharePct ?? 50;

  return (
    <div className="space-y-3" data-testid={`agent-detail-${agent.id}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isRunning ? "bg-primary/20" : "bg-muted"}`}>
            <Bot className={`h-4 w-4 ${isRunning ? "text-primary" : "text-muted-foreground"}`} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold truncate" data-testid={`text-agent-name-${agent.id}`}>{agent.name}</h3>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-muted-foreground font-mono">{VENUE_LABELS[agent.venue] || agent.venue}</span>
              <Badge variant={isRunning ? "default" : "secondary"} className="text-[8px]">
                {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1 animate-pulse" />}
                {agent.status}
              </Badge>
            </div>
          </div>
        </div>
        <button
          onClick={() => syncBalanceMutation.mutate()}
          disabled={syncBalanceMutation.isPending}
          className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors"
          title="Sync on-chain balance"
          data-testid="button-sync-balance"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${syncBalanceMutation.isPending ? "animate-spin" : ""}`} />
        </button>
      </div>

      {agent.status === "paused" && account?.address && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-[10px] min-w-0">
                <p className="font-medium text-amber-500">Agent Paused</p>
                {agent.lastExecutionError && <p className="text-muted-foreground truncate">{agent.lastExecutionError}</p>}
              </div>
            </div>
            <Button size="sm" onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending} data-testid="button-resume-agent">
              {resumeMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5 mr-1" />}
              Resume
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-card/60 border border-border/30 p-2.5 text-center">
          <p className="text-[8px] text-muted-foreground mb-0.5">Portfolio</p>
          <p className="text-sm font-mono font-bold" data-testid="text-portfolio-value">{livePortfolioValue.toFixed(2)}</p>
          <p className="text-[8px] text-muted-foreground">SUI</p>
        </div>
        <div className="rounded-lg bg-card/60 border border-border/30 p-2.5 text-center">
          <p className="text-[8px] text-muted-foreground mb-0.5">Total PnL</p>
          <p className={`text-sm font-mono font-bold ${liveTotalPnl > 0 ? "text-emerald-500" : liveTotalPnl < 0 ? "text-red-500" : ""}`} data-testid="text-total-pnl">
            {liveTotalPnl === 0 ? "0.00" : `${liveTotalPnl >= 0 ? "+" : ""}${liveTotalPnl.toFixed(2)}`}
          </p>
          {liveUnrealizedPnl !== 0 && (
            <p className={`text-[8px] ${liveUnrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {liveUnrealizedPnl >= 0 ? "+" : ""}{liveUnrealizedPnl.toFixed(2)} open
            </p>
          )}
        </div>
        <div className="rounded-lg bg-card/60 border border-border/30 p-2.5 text-center">
          <p className="text-[8px] text-muted-foreground mb-0.5">Win Rate</p>
          <p className="text-sm font-mono font-bold" data-testid="text-win-rate">{(winRate * 100).toFixed(0)}%</p>
          <p className="text-[8px] text-muted-foreground">{agent.totalTrades} trades</p>
        </div>
      </div>

      <FundStatus agent={agent} positions={activity?.positions || []} livePrice={currentPrice} activity={activity} />

      <div className="rounded-lg border border-border/30 bg-card/40 p-3 space-y-2">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <Zap className="h-3 w-3" />
          Rewards ({rewardSharePct}% profit share)
        </p>
        <div className="grid grid-cols-3 gap-1.5">
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center">
            <p className="text-[8px] text-muted-foreground">Claimable</p>
            <p className="text-xs font-mono font-bold text-emerald-500" data-testid="text-pending-rewards">
              {(activity?.pendingRewards || 0).toFixed(4)}
            </p>
          </div>
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center">
            <p className="text-[8px] text-muted-foreground">Reinvested</p>
            <p className="text-xs font-mono font-bold text-primary" data-testid="text-reinvested">
              {(activity?.reinvestedAmount || 0).toFixed(4)}
            </p>
          </div>
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center">
            <p className="text-[8px] text-muted-foreground">Claimed</p>
            <p className="text-xs font-mono font-bold" data-testid="text-claimed-rewards">
              {(activity?.claimedRewards || 0).toFixed(4)}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border/30 bg-card/40 p-3 space-y-2">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <Shield className="h-3 w-3" />
          Configuration
        </p>
        <div className="grid grid-cols-4 gap-1.5">
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center" data-testid="config-leverage">
            <p className="text-[8px] text-muted-foreground">Leverage</p>
            <p className="text-sm font-bold font-mono">{agent.leverage}x</p>
          </div>
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center" data-testid="config-max-position">
            <p className="text-[8px] text-muted-foreground">Max Coll</p>
            <p className="text-sm font-bold font-mono">{agent.maxQty}</p>
          </div>
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center" data-testid="config-stop-loss">
            <p className="text-[8px] text-muted-foreground">Stop Loss</p>
            <p className="text-sm font-bold font-mono text-red-500">{agent.stopLossBps}bp</p>
          </div>
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center" data-testid="config-take-profit">
            <p className="text-[8px] text-muted-foreground">Take Profit</p>
            <p className="text-sm font-bold font-mono text-emerald-500">{agent.takeProfitBps ? `${agent.takeProfitBps}bp` : "---"}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[9px] text-muted-foreground pt-1 border-t border-border/20">
          <span>Max collateral loss: 25%</span>
          <span>Emergency close: 35%</span>
          {agent.walletAddress && (
            <span className="flex items-center gap-1 ml-auto">
              <Wallet className="h-2.5 w-2.5" />
              <span className="font-mono">{agent.walletAddress.slice(0, 6)}...{agent.walletAddress.slice(-4)}</span>
              <CopyButton text={agent.walletAddress} />
            </span>
          )}
        </div>
      </div>

      {account?.address && (livePortfolioValue > 0 || agent.balance > 0 || hasOpenPositions) && (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="destructive" size="sm" onClick={() => setShowRemoveCollateral(true)} className="w-full" data-testid="button-remove-collateral">
            <Unlock className="h-3.5 w-3.5 mr-1 shrink-0" /><span className="truncate text-xs">Remove All</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowWithdraw(true)} className="w-full" data-testid="button-withdraw-open">
            <ArrowDownToLine className="h-3.5 w-3.5 mr-1 shrink-0" /><span className="truncate text-xs">Withdraw</span>
          </Button>
        </div>
      )}

      {account?.address && agent.balance < 0.1 && (agent.totalDeposited || 0) > 1 && !hasOpenPositions && (
        <Button variant="outline" size="sm" onClick={() => setShowRefund(true)} className="w-full" data-testid="button-refund-open">
          <ArrowDownToLine className="h-3.5 w-3.5 mr-1.5" />Recover Remaining Funds
        </Button>
      )}

      {account?.address && agent.balance <= 0 && (agent.totalDeposited || 0) <= 1 && agent.walletAddress && !hasOpenPositions && (
        <Button variant="outline" size="sm" onClick={() => setShowRefund(true)} className="w-full" data-testid="button-refund-open">
          <ArrowDownToLine className="h-3.5 w-3.5 mr-1.5" />Recover Remaining Funds
        </Button>
      )}

      <WithdrawDialog agent={agent} open={showWithdraw} onOpenChange={setShowWithdraw} />
      <RefundDialog agent={agent} open={showRefund} onOpenChange={setShowRefund} />
      <RemoveCollateralDialog agent={agent} open={showRemoveCollateral} onOpenChange={setShowRemoveCollateral} />

      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <Tabs defaultValue="positions" className="w-full">
          <TabsList className="w-full grid grid-cols-4 gap-0.5">
            <TabsTrigger value="positions" className="text-[9px] px-1" data-testid="tab-positions">
              <Activity className="h-3 w-3 mr-0.5 shrink-0" />
              <span className="text-[8px]">Positions</span>
            </TabsTrigger>
            <TabsTrigger value="thinking" className="text-[9px] px-1" data-testid="tab-thinking">
              <Brain className="h-3 w-3 mr-0.5 shrink-0" />
              <span className="text-[8px]">Signals</span>
            </TabsTrigger>
            <TabsTrigger value="signals" className="text-[9px] px-1" data-testid="tab-signals">
              <SignalIcon className="h-3 w-3 mr-0.5 shrink-0" />
              <span className="text-[8px]">History</span>
            </TabsTrigger>
            <TabsTrigger value="bundles" className="text-[9px] px-1" data-testid="tab-bundles">
              <Package className="h-3 w-3 mr-0.5 shrink-0" />
              <span className="text-[8px]">Exec</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="positions" className="mt-2">
            <PositionsPanel positions={activity?.positions || []} livePrice={currentPrice} leverage={agent.leverage} agentId={agent.id} />
          </TabsContent>
          <TabsContent value="thinking" className="mt-2">
            <ThinkingProcess agentId={agent.id} reasoning={activity?.reasoning} />
          </TabsContent>
          <TabsContent value="signals" className="mt-2">
            <SignalsPanel signals={activity?.signals || []} />
          </TabsContent>
          <TabsContent value="bundles" className="mt-2">
            <BundlesPanel agentId={agent.id} suiPrice={currentPrice} />
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

  if (isLoading) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (!data) return null;

  const portfolioTotal = data.totalFreeBalance + data.totalLockedCollateral + data.totalUnrealizedPnl;

  return (
    <div className="rounded-xl border border-border/40 bg-card/50 p-3 space-y-2.5" data-testid="card-wallet-summary">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center">
            <Wallet className="h-3.5 w-3.5 text-primary" />
          </div>
          <div>
            <p className="text-xs font-semibold">My Wallet</p>
            <p className="text-[9px] font-mono text-muted-foreground">{address.slice(0, 6)}...{address.slice(-4)}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-base font-bold font-mono" data-testid="text-wallet-portfolio">{Math.max(0, portfolioTotal).toFixed(2)}</p>
          <p className="text-[8px] text-muted-foreground">SUI Portfolio</p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1">
        <div className="rounded p-1.5 text-center bg-card/60">
          <p className="text-[7px] text-muted-foreground">Deposited</p>
          <p className="text-[11px] font-mono font-bold" data-testid="text-wallet-deposited">{data.totalDepositedNet.toFixed(2)}</p>
        </div>
        <div className="rounded p-1.5 text-center bg-card/60">
          <p className="text-[7px] text-muted-foreground">Realized</p>
          <p className={`text-[11px] font-mono font-bold ${data.totalRealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
            {data.totalRealizedPnl >= 0 ? "+" : ""}{data.totalRealizedPnl.toFixed(2)}
          </p>
        </div>
        <div className="rounded p-1.5 text-center bg-card/60">
          <p className="text-[7px] text-muted-foreground">Open PnL</p>
          <p className={`text-[11px] font-mono font-bold ${data.totalUnrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
            {data.totalUnrealizedPnl >= 0 ? "+" : ""}{data.totalUnrealizedPnl.toFixed(2)}
          </p>
        </div>
        <div className="rounded p-1.5 text-center bg-card/60">
          <p className="text-[7px] text-muted-foreground">Rewards</p>
          <p className="text-[11px] font-mono font-bold text-emerald-500" data-testid="text-wallet-rewards">{data.totalPendingRewards.toFixed(2)}</p>
        </div>
      </div>

      <div className="flex items-center justify-between text-[8px] text-muted-foreground/60 pt-0.5 border-t border-border/20">
        <span>{data.verifiedOpenPositions} open + {data.verifiedClosedPositions} closed</span>
        <span>{data.agentIds.length} agent{data.agentIds.length !== 1 ? "s" : ""}</span>
      </div>
    </div>
  );
}

export default function MyAgents() {
  usePageSEO({
    title: "My Agents",
    description: "View your active AI trading agents, positions, signals, and fund status",
  });

  const account = useCurrentAccount();
  const { subscribe } = useWS();

  const { data: agents, isLoading } = useQuery<AgentWithSignalAgent[]>({
    queryKey: ["/api/agents"],
    refetchInterval: 5000,
  });

  useEffect(() => {
    const unsub1 = subscribe("agent:updated", () => queryClient.invalidateQueries({ queryKey: ["/api/agents"] }));
    const unsub2 = subscribe("agent:created", () => queryClient.invalidateQueries({ queryKey: ["/api/agents"] }));
    const unsub3 = subscribe("agent:deleted", () => queryClient.invalidateQueries({ queryKey: ["/api/agents"] }));
    const unsub4 = subscribe("agents:refresh", () => queryClient.invalidateQueries({ queryKey: ["/api/agents"] }));
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); };
  }, [subscribe]);

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const allAgents = agents || [];
  const activeAgents = allAgents.filter((a) => a.status === "running");

  useEffect(() => {
    if (!selectedAgentId && activeAgents.length > 0) {
      setSelectedAgentId(activeAgents[0].id);
    } else if (!selectedAgentId && allAgents.length > 0) {
      setSelectedAgentId(allAgents[0].id);
    }
  }, [agents, selectedAgentId]);

  const selectedAgent = allAgents.find((a) => a.id === selectedAgentId);

  return (
    <div className="p-3 md:p-6 space-y-4 max-w-3xl mx-auto overflow-x-hidden" data-testid="page-my-agents">
      {account?.address && <WalletSummaryPanel address={account.address} />}

      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold tracking-tight">My Agents</h2>
          <p className="text-[10px] text-muted-foreground">Monitor positions, signals, and fund status</p>
        </div>
        {allAgents.length > 1 && (
          <Select value={selectedAgentId || ""} onValueChange={setSelectedAgentId}>
            <SelectTrigger className="w-[180px]" data-testid="select-agent">
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
            <Bot className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <h3 className="text-sm font-medium mb-1">No agents deployed</h3>
            <p className="text-xs text-muted-foreground">Deploy an agent to start trading</p>
          </CardContent>
        </Card>
      ) : selectedAgent ? (
        <Card className="rounded-xl overflow-hidden">
          <CardContent className="p-3 pt-3">
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
        <div className="grid grid-cols-4 gap-1.5">
          <div className="rounded-lg bg-card/40 border border-border/20 p-2 text-center">
            <p className="text-[7px] text-muted-foreground">Active</p>
            <p className="text-sm font-bold font-mono" data-testid="text-active-count">{activeAgents.length}</p>
          </div>
          <div className="rounded-lg bg-card/40 border border-border/20 p-2 text-center">
            <p className="text-[7px] text-muted-foreground">Balance</p>
            <p className="text-sm font-bold font-mono truncate">{allAgents.reduce((s, a) => s + a.balance, 0).toFixed(2)}</p>
          </div>
          <div className="rounded-lg bg-card/40 border border-border/20 p-2 text-center">
            <p className="text-[7px] text-muted-foreground">PnL</p>
            <p className={`text-sm font-bold font-mono truncate ${allAgents.reduce((s, a) => s + a.totalPnl, 0) >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {allAgents.reduce((s, a) => s + a.totalPnl, 0).toFixed(2)}
            </p>
          </div>
          <div className="rounded-lg bg-card/40 border border-border/20 p-2 text-center">
            <p className="text-[7px] text-muted-foreground">Trades</p>
            <p className="text-sm font-bold font-mono">{allAgents.reduce((s, a) => s + a.totalTrades, 0)}</p>
          </div>
        </div>
      )}
    </div>
  );
}
