import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePageSEO } from "@/lib/seo";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowRight,
  AlertTriangle,
  ExternalLink,
  Fuel,
  Wallet,
  TrendingUp,
  TrendingDown,
  Gift,
  XCircle,
  RotateCcw,
  Filter,
  ArrowDownToLine,
  ArrowUpFromLine,
} from "lucide-react";

interface SuiFlowTransaction {
  digest: string;
  timestamp: string;
  type: string;
  amountSui: number;
  gasSui: number;
  direction: "in" | "out";
  status: "success" | "failure";
  events: string[];
  relatedOrderId?: string;
  relatedPositionId?: string;
  explorerUrl: string;
}

interface SuiFlowSummary {
  totalIn: number;
  totalOut: number;
  totalGas: number;
  totalLocked: number;
  totalReturned: number;
  totalRewards: number;
  unexplainedGap: number;
  currentlyLockedOnChain: number;
  currentWalletBalance: number;
}

interface ChainDerivedStats {
  tradeCount: number;
  wins: number;
  losses: number;
  liquidations: number;
  winRate: number;
  totalPnl: number;
  realizedGain: number;
  realizedLoss: number;
  openTrades: number;
  cancelledTrades: number;
}

interface ChainTrade {
  openDigest: string;
  closeDigest: string | null;
  collateral: number;
  returned: number;
  pnlSui: number;
  outcome: "win" | "loss" | "liquidated" | "cancelled" | "open";
  openTimestamp: string | null;
  closeTimestamp: string | null;
}

interface SuiFlowData {
  transactions: SuiFlowTransaction[];
  summary: SuiFlowSummary;
  chainDerivedStats?: ChainDerivedStats;
  chainTrades?: ChainTrade[];
  errors: string[];
  walletAddress: string;
}

interface AgentListItem {
  id: string;
  name: string;
  walletAddress: string;
  status: string;
}

const TYPE_CONFIG: Record<string, { label: string; color: string; filterKey: string }> = {
  deposit_in: { label: "Deposit", color: "bg-emerald-500/15 text-emerald-500 border-emerald-500/20", filterKey: "deposits" },
  order_create: { label: "Order Create", color: "bg-amber-500/15 text-amber-500 border-amber-500/20", filterKey: "orders" },
  order_cancel: { label: "Order Cancel", color: "bg-sky-500/15 text-sky-500 border-sky-500/20", filterKey: "closes" },
  close_fill: { label: "Close/Fill", color: "bg-teal-500/15 text-teal-500 border-teal-500/20", filterKey: "closes" },
  reward_escrow: { label: "Reward Paid", color: "bg-violet-500/15 text-violet-500 border-violet-500/20", filterKey: "rewards" },
  failed_close: { label: "Failed Close", color: "bg-orange-500/15 text-orange-400 border-orange-500/20", filterKey: "errors" },
  gas_spent: { label: "Gas", color: "bg-zinc-500/15 text-zinc-400 border-zinc-500/20", filterKey: "all" },
  unknown_outflow: { label: "Unknown", color: "bg-red-500/15 text-red-500 border-red-500/20", filterKey: "errors" },
};

function TypeBadge({ type }: { type: string }) {
  const config = TYPE_CONFIG[type] || { label: type, color: "bg-muted text-muted-foreground" };
  return (
    <Badge variant="outline" className={`text-[9px] ${config.color}`} data-testid={`badge-type-${type}`}>
      {config.label}
    </Badge>
  );
}

function TxDigestLink({ digest }: { digest: string }) {
  return (
    <a
      href={`https://suiscan.xyz/mainnet/tx/${digest}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary text-[10px] font-mono hover:underline flex items-center gap-1"
      data-testid={`link-tx-${digest.slice(0, 8)}`}
    >
      {digest.slice(0, 10)}...{digest.slice(-4)}
      <ExternalLink className="h-2.5 w-2.5" />
    </a>
  );
}

function SummaryCards({ summary }: { summary: SuiFlowSummary }) {
  const cards = [
    { label: "Net Deposits", value: summary.totalIn, color: "text-emerald-500", icon: ArrowDownToLine },
    { label: "Collateral Posted", value: summary.totalLocked, color: "text-amber-500", icon: ArrowUpFromLine, subtitle: "cumulative" },
    { label: "Settlements Received", value: summary.totalReturned, color: "text-emerald-500", icon: RotateCcw },
    { label: "Rewards Paid", value: summary.totalRewards, color: "text-primary", icon: Gift },
    { label: "Gas Burned", value: summary.totalGas, color: "text-muted-foreground", icon: Fuel },
    { label: "Unexplained Gap", value: summary.unexplainedGap, color: summary.unexplainedGap > 0.01 ? "text-red-500" : "text-muted-foreground", icon: AlertTriangle },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2" data-testid="summary-cards">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent className="p-3 text-center space-y-1">
            <div className="flex items-center justify-center gap-1">
              <card.icon className={`h-3 w-3 ${card.color}`} />
              <p className="text-[9px] text-muted-foreground">{card.label}</p>
            </div>
            <p className={`text-sm font-mono font-bold ${card.color}`} data-testid={`text-summary-${card.label.toLowerCase().replace(/\s+/g, "-")}`}>
              {card.value.toFixed(4)}
            </p>
            {card.label === "Unexplained Gap" && card.value > 0.01 && (
              <div className="flex items-center justify-center gap-1">
                <AlertTriangle className="h-2.5 w-2.5 text-red-500 animate-pulse" />
                <span className="text-[8px] text-red-500">Discrepancy</span>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function FlowDiagram({ summary }: { summary: SuiFlowSummary }) {
  const steps = [
    { label: "User Wallet", amount: summary.totalIn, color: "bg-emerald-500", direction: "in" as const, sublabel: "Net Deposits" },
    { label: "Agent Wallet", amount: summary.currentWalletBalance ?? null, color: "bg-primary", direction: null as any, sublabel: "On-Chain Balance" },
    { label: "Typus DEX", amount: summary.currentlyLockedOnChain ?? 0, color: "bg-amber-500", direction: "out" as const, sublabel: "Currently Locked" },
    { label: "Settlements", amount: summary.totalReturned, color: "bg-emerald-500", direction: "in" as const, sublabel: "Total Returned" },
    { label: "Reward Wallet", amount: summary.totalRewards, color: "bg-violet-500", direction: "out" as const, sublabel: "Rewards Paid" },
  ];

  return (
    <Card data-testid="flow-diagram">
      <CardContent className="p-4">
        <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wider flex items-center gap-1">
          <Activity className="h-3 w-3" />
          Flow Diagram
        </p>
        <div className="flex flex-col md:flex-row items-center gap-1 md:gap-0">
          {steps.map((step, i) => (
            <div key={i} className="flex flex-col md:flex-row items-center gap-1 md:gap-0 w-full md:w-auto">
              <div className="flex flex-col items-center gap-1 min-w-[100px]">
                <div className={`w-3 h-3 rounded-full ${step.color}`} />
                <span className="text-[10px] font-medium text-center">{step.label}</span>
                {(step as any).sublabel && (
                  <span className="text-[7px] text-muted-foreground">{(step as any).sublabel}</span>
                )}
                {step.amount !== null && (
                  <span className={`text-[10px] font-mono font-bold ${step.direction === "in" ? "text-emerald-500" : step.direction === "out" ? "text-amber-500" : "text-primary"}`}>
                    {step.amount.toFixed(4)} SUI
                  </span>
                )}
              </div>
              {i < steps.length - 1 && (
                <div className="flex items-center justify-center md:flex-1 md:min-w-[40px]">
                  <ArrowRight className="h-4 w-4 text-muted-foreground hidden md:block" />
                  <ArrowDown className="h-4 w-4 text-muted-foreground md:hidden" />
                </div>
              )}
            </div>
          ))}
        </div>
        {summary.totalGas > 0 && (
          <div className="flex items-center justify-center gap-1 mt-3 text-[10px] text-muted-foreground">
            <Fuel className="h-3 w-3" />
            <span className="font-mono">{summary.totalGas.toFixed(6)} SUI burned as gas</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ErrorAlerts({ errors }: { errors: string[] }) {
  if (!errors || errors.length === 0) return null;

  const liquidationErrors = errors.filter(e => e.startsWith("LIKELY LIQUIDATION:"));
  const otherErrors = errors.filter(e => !e.startsWith("LIKELY LIQUIDATION:"));

  return (
    <div className="space-y-2" data-testid="alert-errors">
      {liquidationErrors.map((err, i) => (
        <Alert key={`liq-${i}`} variant="destructive" className="border-red-500/40 bg-red-500/10">
          <AlertTriangle className="h-4 w-4 text-red-500 animate-pulse" />
          <AlertTitle className="text-sm font-bold text-red-500">Position Likely Liquidated</AlertTitle>
          <AlertDescription className="mt-2 space-y-2">
            <p className="text-xs text-red-400">{err.replace("LIKELY LIQUIDATION: ", "")}</p>
            <div className="text-[10px] text-muted-foreground space-y-1 border-t border-red-500/20 pt-2 mt-2">
              <p><span className="font-medium">What happened:</span> The trading order was filled by the Typus keeper (creating an open position), but the system could not detect the fill event. Without knowing the position existed, no close order was ever submitted. The position was left unmanaged with high leverage and was likely liquidated — consuming all collateral.</p>
              <p><span className="font-medium">Root cause:</span> Keeper fill events live in the keeper's transactions, not the agent's. The global event query couldn't find the fill within its pagination window.</p>
            </div>
          </AlertDescription>
        </Alert>
      ))}
      {otherErrors.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle className="text-sm">Flow Issues Detected</AlertTitle>
          <AlertDescription>
            <ul className="list-disc list-inside space-y-0.5 mt-1">
              {otherErrors.map((err, i) => (
                <li key={i} className="text-xs">{err}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function ChainTradeStats({ stats, trades }: { stats: ChainDerivedStats; trades: ChainTrade[] }) {
  return (
    <Card data-testid="chain-trade-stats">
      <CardContent className="p-4 space-y-3">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <TrendingUp className="h-3 w-3" />
          On-Chain Trade Reconstruction
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="rounded-lg bg-card/60 border border-border/30 p-2.5 text-center">
            <p className="text-[8px] text-muted-foreground">Closed Trades</p>
            <p className="text-lg font-mono font-bold" data-testid="text-chain-trade-count">{stats.tradeCount}</p>
          </div>
          <div className="rounded-lg bg-card/60 border border-border/30 p-2.5 text-center">
            <p className="text-[8px] text-muted-foreground">Win Rate</p>
            <p className={`text-lg font-mono font-bold ${stats.winRate > 0.5 ? "text-emerald-500" : stats.winRate > 0 ? "text-amber-500" : "text-muted-foreground"}`} data-testid="text-chain-win-rate">
              {(stats.winRate * 100).toFixed(0)}%
            </p>
            <p className="text-[8px] text-muted-foreground">{stats.wins}W / {stats.losses}L</p>
          </div>
          <div className="rounded-lg bg-card/60 border border-border/30 p-2.5 text-center">
            <p className="text-[8px] text-muted-foreground">Total PnL</p>
            <p className={`text-lg font-mono font-bold ${stats.totalPnl >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid="text-chain-total-pnl">
              {stats.totalPnl >= 0 ? "+" : ""}{stats.totalPnl.toFixed(4)}
            </p>
            <p className="text-[8px] text-muted-foreground">SUI</p>
          </div>
          <div className="rounded-lg bg-card/60 border border-border/30 p-2.5 text-center">
            <p className="text-[8px] text-muted-foreground">Liquidations</p>
            <p className={`text-lg font-mono font-bold ${stats.liquidations > 0 ? "text-red-500" : "text-muted-foreground"}`} data-testid="text-chain-liquidations">
              {stats.liquidations}
            </p>
          </div>
        </div>

        {trades.length > 0 && (
          <div className="space-y-1">
            <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Trade Details</p>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {trades.map((trade, i) => (
                <div key={i} className={`flex items-center gap-2 rounded px-2.5 py-1.5 text-[9px] border ${
                  trade.outcome === "win" ? "bg-emerald-500/5 border-emerald-500/20" :
                  trade.outcome === "loss" ? "bg-red-500/5 border-red-500/20" :
                  trade.outcome === "liquidated" ? "bg-red-500/10 border-red-500/30" :
                  trade.outcome === "cancelled" ? "bg-sky-500/5 border-sky-500/20" :
                  "bg-amber-500/5 border-amber-500/20"
                }`} data-testid={`chain-trade-${i}`}>
                  <Badge variant="outline" className={`text-[8px] shrink-0 ${
                    trade.outcome === "win" ? "text-emerald-500 border-emerald-500/30" :
                    trade.outcome === "loss" ? "text-red-500 border-red-500/30" :
                    trade.outcome === "liquidated" ? "text-red-500 border-red-500/30 bg-red-500/10" :
                    trade.outcome === "cancelled" ? "text-sky-500 border-sky-500/30" :
                    "text-amber-500 border-amber-500/30"
                  }`}>
                    {trade.outcome === "win" ? "WIN" : trade.outcome === "loss" ? "LOSS" : trade.outcome === "liquidated" ? "LIQ" : trade.outcome === "cancelled" ? "CANCEL" : "OPEN"}
                  </Badge>
                  <span className="font-mono">{trade.collateral.toFixed(4)} SUI</span>
                  <ArrowRight className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                  <span className="font-mono">{trade.returned.toFixed(4)} SUI</span>
                  <span className={`font-mono font-bold ml-auto ${trade.pnlSui >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                    {trade.pnlSui >= 0 ? "+" : ""}{trade.pnlSui.toFixed(4)}
                  </span>
                  {trade.openTimestamp && (
                    <span className="text-muted-foreground/60 shrink-0">{new Date(trade.openTimestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type FilterKey = "all" | "deposits" | "orders" | "closes" | "rewards" | "errors";

function TransactionTimeline({ transactions }: { transactions: SuiFlowTransaction[] }) {
  const [filter, setFilter] = useState<FilterKey>("all");

  const filterButtons: { key: FilterKey; label: string }[] = [
    { key: "all", label: "All" },
    { key: "deposits", label: "Deposits" },
    { key: "orders", label: "Orders" },
    { key: "closes", label: "Closes" },
    { key: "rewards", label: "Rewards" },
    { key: "errors", label: "Errors" },
  ];

  const filtered = transactions.filter((tx) => {
    if (filter === "all") return true;
    if (filter === "errors") return tx.status === "failure" || tx.type === "unknown_outflow" || tx.type === "failed_close";
    const config = TYPE_CONFIG[tx.type];
    return config?.filterKey === filter;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (!a.timestamp || !b.timestamp) return 0;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  return (
    <Card data-testid="transaction-timeline">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
            <Filter className="h-3 w-3" />
            Transaction Timeline ({sorted.length})
          </p>
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          {filterButtons.map((btn) => (
            <Button
              key={btn.key}
              size="sm"
              variant={filter === btn.key ? "default" : "outline"}
              onClick={() => setFilter(btn.key)}
              data-testid={`button-filter-${btn.key}`}
            >
              {btn.label}
            </Button>
          ))}
        </div>

        <ScrollArea className="max-h-[500px]">
          <div className="space-y-1">
            {sorted.length === 0 && (
              <div className="text-center py-8 text-muted-foreground text-xs" data-testid="text-no-transactions">
                No transactions match this filter
              </div>
            )}
            {sorted.map((tx) => {
              const isError = tx.status === "failure" || tx.type === "unknown_outflow" || tx.type === "failed_close";
              return (
                <div
                  key={tx.digest + tx.type}
                  className={`flex items-center gap-2 rounded-md px-3 py-2 ${isError ? "bg-red-500/5 border border-red-500/15" : "bg-card/50"}`}
                  data-testid={`row-tx-${tx.digest.slice(0, 8)}`}
                >
                  <div className="shrink-0">
                    {tx.direction === "in" ? (
                      <ArrowDown className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <ArrowUp className="h-3.5 w-3.5 text-red-500" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <TypeBadge type={tx.type} />
                      <span className={`text-xs font-mono font-bold ${tx.direction === "in" ? "text-emerald-500" : "text-red-500"}`}>
                        {tx.direction === "in" ? "+" : "-"}{tx.amountSui.toFixed(4)} SUI
                      </span>
                      {tx.status === "failure" && (
                        <Badge variant="destructive" className="text-[8px]">
                          <XCircle className="h-2 w-2 mr-0.5" />Failed
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[9px] text-muted-foreground">
                        {tx.timestamp ? new Date(tx.timestamp).toLocaleString() : "Unknown time"}
                      </span>
                      <TxDigestLink digest={tx.digest} />
                      {tx.relatedOrderId && (
                        <span className="text-[8px] text-muted-foreground font-mono">Order: {tx.relatedOrderId}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

export default function SuiFlow() {
  usePageSEO({
    title: "SUI Flow Tracker",
    description: "Track all SUI movements for each agent — deposits, orders, fills, rewards, gas",
  });

  const [selectedAgentId, setSelectedAgentId] = useState<string>("");

  const { data: agents, isLoading: agentsLoading } = useQuery<AgentListItem[]>({
    queryKey: ["/api/agents"],
  });

  const { data: flowData, isLoading: flowLoading } = useQuery<SuiFlowData>({
    queryKey: ["/api/agents", selectedAgentId, "sui-flow"],
    enabled: !!selectedAgentId,
  });

  return (
    <div className="p-4 md:p-6 pb-20 md:pb-6 space-y-4 max-w-5xl mx-auto" data-testid="page-sui-flow">
      <div className="space-y-0.5">
        <h2 className="text-lg md:text-xl font-bold tracking-tight flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          SUI Flow Tracker
        </h2>
        <p className="text-xs text-muted-foreground">
          Trace every SUI movement for each agent — deposits, orders, fills, rewards, and gas
        </p>
      </div>

      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Wallet className="h-4 w-4 text-primary shrink-0" />
            <span className="text-xs text-muted-foreground shrink-0">Select Agent:</span>
            {agentsLoading ? (
              <Skeleton className="h-9 w-[200px]" />
            ) : (
              <Select value={selectedAgentId} onValueChange={setSelectedAgentId} data-testid="select-agent">
                <SelectTrigger className="w-[250px]" data-testid="select-agent-trigger">
                  <SelectValue placeholder="Choose an agent..." />
                </SelectTrigger>
                <SelectContent>
                  {(agents || []).map((agent) => (
                    <SelectItem key={agent.id} value={agent.id} data-testid={`select-agent-${agent.id}`}>
                      {agent.name} ({agent.status})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardContent>
      </Card>

      {selectedAgentId && flowLoading && (
        <div className="space-y-3" data-testid="loading-flow">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {flowData && (
        <>
          <ErrorAlerts errors={flowData.errors} />
          <SummaryCards summary={flowData.summary} />
          {flowData.chainDerivedStats && flowData.chainDerivedStats.tradeCount > 0 && (
            <ChainTradeStats stats={flowData.chainDerivedStats} trades={flowData.chainTrades || []} />
          )}
          <FlowDiagram summary={flowData.summary} />
          <TransactionTimeline transactions={flowData.transactions} />
        </>
      )}

      {selectedAgentId && !flowLoading && !flowData && (
        <div className="text-center py-12 text-muted-foreground" data-testid="text-no-data">
          <Activity className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No flow data available for this agent</p>
          <p className="text-xs mt-1">The agent may not have any on-chain transactions yet</p>
        </div>
      )}

      {!selectedAgentId && (
        <div className="text-center py-12 text-muted-foreground" data-testid="text-select-prompt">
          <Activity className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Select an agent to view its SUI flow</p>
        </div>
      )}
    </div>
  );
}