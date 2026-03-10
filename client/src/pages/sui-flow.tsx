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
  hasLiquidateEvent?: boolean;
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
  liquidationLosses?: number;
  tradingLosses?: number;
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
  outcome: "win" | "loss" | "liquidated" | "cancelled" | "open" | "pending_order";
  openTimestamp: string | null;
  closeTimestamp: string | null;
  dbPositionMatch?: "tracked" | "untracked";
}

interface SuiFlowData {
  transactions: SuiFlowTransaction[];
  summary: SuiFlowSummary;
  chainDerivedStats?: ChainDerivedStats;
  chainTrades?: ChainTrade[];
  dbTradeCount?: number;
  untrackedChainTrades?: number;
  errors: string[];
  walletAddress: string;
  rpcWarning?: string;
  dataSource?: string;
}

interface AgentListItem {
  id: string;
  name: string;
  walletAddress: string;
  status: string;
}

const TYPE_CONFIG: Record<string, { label: string; color: string; filterKey: string }> = {
  deposit_in: { label: "Deposit", color: "bg-emerald-500/15 text-emerald-500 border-emerald-500/20", filterKey: "deposits" },
  order_create: { label: "Open Order", color: "bg-amber-500/15 text-amber-500 border-amber-500/20", filterKey: "orders" },
  order_cancel: { label: "Order Cancel", color: "bg-sky-500/15 text-sky-500 border-sky-500/20", filterKey: "closes" },
  close_order: { label: "Close Order", color: "bg-teal-500/15 text-teal-400 border-teal-500/20", filterKey: "closes" },
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

function SummaryCards({ summary, chainDerivedStats }: { summary: SuiFlowSummary; chainDerivedStats?: ChainDerivedStats }) {
  const netTradingPnl = chainDerivedStats && chainDerivedStats.tradeCount > 0 ? chainDerivedStats.totalPnl : (summary.totalReturned - summary.totalLocked);
  const cards = [
    { label: "Free SUI", value: summary.currentWalletBalance, color: "text-emerald-400", icon: Wallet },
    { label: "Net Deposits", value: summary.totalIn, color: "text-emerald-500", icon: ArrowDownToLine },
    { label: "Net Trading PnL", value: netTradingPnl, color: netTradingPnl >= 0 ? "text-emerald-500" : "text-red-500", icon: netTradingPnl >= 0 ? TrendingUp : TrendingDown, signed: true },
    { label: "Gas Burned", value: summary.totalGas, color: "text-muted-foreground", icon: Fuel },
    { label: "Rewards Paid", value: summary.totalRewards, color: "text-primary", icon: Gift },
    ...(summary.unexplainedGap > 1.0 ? [{ label: "Accounting Discrepancy", value: summary.unexplainedGap, color: "text-yellow-500", icon: AlertTriangle }] : []),
  ];

  const expectedBalance = summary.totalIn + netTradingPnl - summary.totalGas - summary.totalRewards;

  return (
    <div className="space-y-3" data-testid="summary-cards">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {cards.map((card) => (
          <Card key={card.label}>
            <CardContent className="p-3 text-center space-y-1">
              <div className="flex items-center justify-center gap-1">
                <card.icon className={`h-3 w-3 ${card.color}`} />
                <p className="text-[9px] text-muted-foreground">{card.label}</p>
              </div>
              <p className={`text-sm font-mono font-bold ${card.color}`} data-testid={`text-summary-${card.label.toLowerCase().replace(/\s+/g, "-")}`}>
                {(card as any).signed && card.value >= 0 ? "+" : ""}{card.value.toFixed(4)}
              </p>
              {card.label === "Accounting Discrepancy" && card.value > 1.0 && (
                <div className="flex items-center justify-center gap-1">
                  <AlertTriangle className="h-2.5 w-2.5 text-yellow-500" />
                  <span className="text-[8px] text-yellow-500">Under review</span>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border/30">
        <CardContent className="p-3">
          <div className="flex flex-col sm:flex-row items-center justify-center gap-1 text-[10px] font-mono text-muted-foreground">
            <span>Deposits ({summary.totalIn.toFixed(2)})</span>
            <span>{netTradingPnl >= 0 ? "+" : "−"} Trading ({Math.abs(netTradingPnl).toFixed(2)})</span>
            <span>− Gas ({summary.totalGas.toFixed(4)})</span>
            {summary.totalRewards > 0 && <span>− Rewards ({summary.totalRewards.toFixed(2)})</span>}
            <span>=</span>
            <span className="text-primary font-bold">{expectedBalance.toFixed(2)} SUI expected</span>
            <span className="text-muted-foreground/50">vs</span>
            <span className="text-primary font-bold">{(summary.currentWalletBalance + summary.currentlyLockedOnChain).toFixed(2)} SUI actual</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2">
        <Card className="border-border/20">
          <CardContent className="p-2.5 text-center space-y-0.5">
            <p className="text-[8px] text-muted-foreground">Collateral Posted (cumulative)</p>
            <p className="text-xs font-mono text-amber-500" data-testid="text-summary-collateral-posted">{summary.totalLocked.toFixed(4)} SUI</p>
            <p className="text-[7px] text-muted-foreground/60">Same SUI recycled across trades</p>
          </CardContent>
        </Card>
        <Card className="border-border/20">
          <CardContent className="p-2.5 text-center space-y-0.5">
            <p className="text-[8px] text-muted-foreground">Settlements Received (cumulative)</p>
            <p className="text-xs font-mono text-emerald-500" data-testid="text-summary-settlements-received">{summary.totalReturned.toFixed(4)} SUI</p>
            <p className="text-[7px] text-muted-foreground/60">Returns from all closed trades</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function AccountingBreakdown({ summary, chainDerivedStats }: { summary: SuiFlowSummary; chainDerivedStats?: ChainDerivedStats }) {
  const deposits = summary.totalIn;
  const tradingGains = chainDerivedStats ? chainDerivedStats.realizedGain : Math.max(0, summary.totalReturned - summary.totalLocked);
  const liquidationLosses = summary.liquidationLosses ?? 0;
  const totalRealizedLoss = chainDerivedStats ? Math.abs(chainDerivedStats.realizedLoss) : 0;
  const tradingLosses = Math.max(0, totalRealizedLoss - liquidationLosses);
  const gasCosts = summary.totalGas;
  const rewardsPaid = summary.totalRewards;
  const currentBalance = summary.currentWalletBalance + summary.currentlyLockedOnChain;

  const rows: Array<{ label: string; value: number; type: "add" | "subtract" | "result"; detail?: string }> = [
    { label: "Starting Deposits", value: deposits, type: "add", detail: "SUI deposited into agent wallet" },
    { label: "Trading Gains", value: tradingGains, type: "add", detail: "Profit from winning trades" },
    { label: "Trading Losses", value: tradingLosses, type: "subtract", detail: "Losses from losing trades" },
  ];

  if (liquidationLosses > 0.001) {
    rows.push({ label: "Liquidation Losses", value: liquidationLosses, type: "subtract", detail: "Collateral lost to liquidations" });
  }

  rows.push({ label: "Gas Costs", value: gasCosts, type: "subtract", detail: "Network transaction fees" });

  if (rewardsPaid > 0.001) {
    rows.push({ label: "Rewards Paid", value: rewardsPaid, type: "subtract", detail: "Protocol fees sent to reward wallet" });
  }

  rows.push({ label: "Current Balance", value: currentBalance, type: "result", detail: "Wallet balance + locked in positions" });

  return (
    <Card data-testid="accounting-breakdown">
      <CardContent className="p-4 space-y-3">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <ArrowDownToLine className="h-3 w-3" />
          Where Your SUI Went
        </p>

        <div className="space-y-0">
          {rows.map((row, i) => {
            const isResult = row.type === "result";
            return (
              <div
                key={row.label}
                className={`flex items-center justify-between gap-2 px-3 py-2 ${
                  isResult ? "border-t-2 border-border mt-1 pt-3" : ""
                } ${i > 0 && !isResult ? "border-t border-border/20" : ""}`}
                data-testid={`row-accounting-${row.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    isResult ? "bg-primary" :
                    row.type === "add" ? "bg-emerald-500" : "bg-red-500"
                  }`} />
                  <div className="min-w-0">
                    <p className={`text-xs ${isResult ? "font-bold" : "font-medium"}`}>{row.label}</p>
                    {row.detail && (
                      <p className="text-[8px] text-muted-foreground/70 truncate">{row.detail}</p>
                    )}
                  </div>
                </div>
                <span className={`text-sm font-mono font-bold shrink-0 ${
                  isResult ? "text-primary" :
                  row.type === "add" ? "text-emerald-500" : "text-red-500"
                }`}>
                  {row.type === "add" ? "+" : row.type === "subtract" ? "−" : ""}{row.value.toFixed(4)} SUI
                </span>
              </div>
            );
          })}
        </div>

        <div className="text-center pt-1">
          <p className="text-[8px] text-muted-foreground/60">
            All values derived from on-chain transaction data
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function FlowDiagram({ summary, chainDerivedStats }: { summary: SuiFlowSummary; chainDerivedStats?: ChainDerivedStats }) {
  const netTradingPnl = chainDerivedStats && chainDerivedStats.tradeCount > 0 ? chainDerivedStats.totalPnl : (summary.totalReturned - summary.totalLocked);

  return (
    <Card data-testid="flow-diagram">
      <CardContent className="p-4">
        <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wider flex items-center gap-1">
          <Activity className="h-3 w-3" />
          Where Is Your SUI?
        </p>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 justify-center flex-wrap">
            <FlowNode label="Deposited" sublabel="From Your Wallet" amount={summary.totalIn} color="bg-emerald-500" textColor="text-emerald-500" />
            <ArrowRight className="h-4 w-4 text-muted-foreground hidden sm:block" />
            <ArrowDown className="h-4 w-4 text-muted-foreground sm:hidden" />
            <FlowNode label="Free SUI" sublabel="Available in Wallet" amount={summary.currentWalletBalance} color="bg-emerald-500" textColor="text-emerald-400" />
          </div>

          {summary.currentlyLockedOnChain > 0.001 && (
            <div className="flex items-center gap-3 justify-center flex-wrap">
              <div className="w-[100px]" />
              <div className="w-4" />
              <FlowNode label="In Positions" sublabel="Currently Locked on DEX" amount={summary.currentlyLockedOnChain} color="bg-amber-500" textColor="text-amber-500" />
            </div>
          )}

          <div className="border-t border-border/20 pt-3">
            <p className="text-[8px] text-muted-foreground text-center mb-2 uppercase tracking-wider">Where SUI was spent</p>
            <div className="flex items-center gap-3 justify-center flex-wrap">
              <div className="flex flex-col items-center gap-1 min-w-[90px]">
                <div className={`w-2.5 h-2.5 rounded-full ${netTradingPnl >= 0 ? "bg-emerald-500" : "bg-red-500"}`} />
                <span className="text-[10px] font-medium">Trading PnL</span>
                <span className="text-[7px] text-muted-foreground">Net result of all trades</span>
                <span className={`text-sm font-mono font-bold ${netTradingPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {netTradingPnl >= 0 ? "+" : ""}{netTradingPnl.toFixed(4)} SUI
                </span>
              </div>
              <div className="flex flex-col items-center gap-1 min-w-[90px]">
                <div className="w-2.5 h-2.5 rounded-full bg-zinc-500" />
                <span className="text-[10px] font-medium">Gas</span>
                <span className="text-[7px] text-muted-foreground">Transaction fees</span>
                <span className="text-sm font-mono font-bold text-muted-foreground">
                  -{summary.totalGas.toFixed(4)} SUI
                </span>
              </div>
              {summary.totalRewards > 0.001 && (
                <div className="flex flex-col items-center gap-1 min-w-[90px]">
                  <div className="w-2.5 h-2.5 rounded-full bg-violet-500" />
                  <span className="text-[10px] font-medium">Rewards</span>
                  <span className="text-[7px] text-muted-foreground">Paid to reward wallet</span>
                  <span className="text-sm font-mono font-bold text-violet-500">
                    -{summary.totalRewards.toFixed(4)} SUI
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function FlowNode({ label, sublabel, amount, color, textColor }: { label: string; sublabel: string; amount: number; color: string; textColor: string }) {
  return (
    <div className="flex flex-col items-center gap-1 min-w-[100px]">
      <div className={`w-3 h-3 rounded-full ${color}`} />
      <span className="text-[10px] font-medium text-center">{label}</span>
      <span className="text-[7px] text-muted-foreground">{sublabel}</span>
      <span className={`text-sm font-mono font-bold ${textColor}`}>
        {amount.toFixed(4)} SUI
      </span>
    </div>
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

function ChainTradeStats({ stats, trades, dbTradeCount, untrackedChainTrades }: { stats: ChainDerivedStats; trades: ChainTrade[]; dbTradeCount?: number; untrackedChainTrades?: number }) {
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
            {dbTradeCount !== undefined && dbTradeCount !== stats.tradeCount && (
              <p className="text-[7px] text-muted-foreground" data-testid="text-db-trade-count">DB: {dbTradeCount}</p>
            )}
            {(untrackedChainTrades ?? 0) > 0 && (
              <p className="text-[7px] text-amber-500" data-testid="text-untracked-count">{untrackedChainTrades} untracked</p>
            )}
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
                    {trade.outcome === "win" ? "WIN" : trade.outcome === "loss" ? "LOSS" : trade.outcome === "liquidated" ? "LIQ" : trade.outcome === "cancelled" ? "CANCEL" : trade.outcome === "pending_order" ? "PENDING" : "OPEN"}
                  </Badge>
                  <span className="font-mono">{trade.collateral.toFixed(4)} SUI</span>
                  <ArrowRight className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                  <span className="font-mono">{trade.returned.toFixed(4)} SUI</span>
                  <span className={`font-mono font-bold ml-auto ${trade.pnlSui >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                    {trade.pnlSui >= 0 ? "+" : ""}{trade.pnlSui.toFixed(4)}
                  </span>
                  {trade.dbPositionMatch === "untracked" && (
                    <Badge variant="outline" className="text-[7px] text-amber-500 border-amber-500/30 shrink-0" data-testid={`badge-untracked-${i}`}>UNTRACKED</Badge>
                  )}
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
                      {tx.type === "order_create" && tx.direction === "out" && (
                        <Badge variant="outline" className="text-[8px] bg-amber-500/10 text-amber-500 border-amber-500/20" data-testid={`badge-collateral-${tx.digest.slice(0, 8)}`}>
                          Collateral: {tx.amountSui.toFixed(4)}
                        </Badge>
                      )}
                      {tx.type === "close_fill" && tx.hasLiquidateEvent && (
                        <Badge variant="outline" className="text-[8px] bg-red-500/15 text-red-500 border-red-500/30" data-testid={`badge-liquidation-${tx.digest.slice(0, 8)}`}>
                          <AlertTriangle className="h-2 w-2 mr-0.5" />Liquidation
                        </Badge>
                      )}
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

function RewardsSection({ agentId }: { agentId: string }) {
  const { data: rewardsSummary, isLoading } = useQuery<{
    agentClaimableBalances: Array<{
      agentId: string;
      agentName: string;
      claimableBalance: number;
      totalEarned: number;
      venue: string;
      status: string;
    }>;
    totalClaimed: number;
    totalClaimable: number;
    totalEarned: number;
  }>({
    queryKey: ["/api/rewards/summary"],
    staleTime: 30_000,
  });

  const agentRewardInfo = rewardsSummary?.agentClaimableBalances?.find(a => a.agentId === agentId);
  const totalClaimable = rewardsSummary?.totalClaimable || 0;
  const totalClaimed = rewardsSummary?.totalClaimed || 0;

  if (isLoading) {
    return (
      <Card data-testid="rewards-section-loading">
        <CardContent className="p-4">
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="rewards-section">
      <CardContent className="p-4 space-y-3">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <Gift className="h-3 w-3" />
          Rewards
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div className="rounded-lg bg-card/60 border border-border/30 p-2.5 text-center">
            <p className="text-[8px] text-muted-foreground">Pending Rewards</p>
            <p className="text-lg font-mono font-bold text-violet-500" data-testid="text-pending-rewards">
              {agentRewardInfo ? agentRewardInfo.totalEarned.toFixed(4) : totalClaimable.toFixed(4)}
            </p>
            <p className="text-[7px] text-muted-foreground">SUI</p>
          </div>
          <div className="rounded-lg bg-card/60 border border-border/30 p-2.5 text-center">
            <p className="text-[8px] text-muted-foreground">Claimable Now</p>
            <p className="text-lg font-mono font-bold text-emerald-500" data-testid="text-claimable-rewards">
              {agentRewardInfo ? agentRewardInfo.claimableBalance.toFixed(4) : "0.0000"}
            </p>
            <p className="text-[7px] text-muted-foreground">SUI</p>
          </div>
          <div className="rounded-lg bg-card/60 border border-border/30 p-2.5 text-center">
            <p className="text-[8px] text-muted-foreground">Total Claimed</p>
            <p className="text-lg font-mono font-bold text-primary" data-testid="text-claimed-rewards">
              {totalClaimed.toFixed(4)}
            </p>
            <p className="text-[7px] text-muted-foreground">SUI</p>
          </div>
        </div>

        {agentRewardInfo && (
          <div className="flex items-center gap-2 text-[9px] text-muted-foreground border-t border-border/20 pt-2">
            <Badge variant="outline" className={`text-[8px] ${agentRewardInfo.status === "active" ? "text-emerald-500 border-emerald-500/30" : "text-muted-foreground"}`}>
              {agentRewardInfo.status}
            </Badge>
            <span>Venue: {agentRewardInfo.venue || "Typus"}</span>
          </div>
        )}

        {!agentRewardInfo && (
          <p className="text-[9px] text-muted-foreground text-center pt-1">
            No pending rewards for this agent
          </p>
        )}
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

  const { data: flowData, isLoading: flowLoading, error: flowError } = useQuery<SuiFlowData>({
    queryKey: ["/api/agents", selectedAgentId, "sui-flow"],
    enabled: !!selectedAgentId,
    retry: 2,
    retryDelay: 3000,
    staleTime: 60_000,
  });

  const { data: onChainPortfolio } = useQuery<{
    agents: Array<{
      agentId: string;
      freeSui: number;
      totalLocked: number;
      pendingOrderCollateral: number;
      portfolioValue: number;
      totalUnrealizedPnl: number;
    }>;
  }>({
    queryKey: ["/api/agents/on-chain-portfolio"],
    refetchInterval: 10000,
    staleTime: 8000,
  });

  const chainData = selectedAgentId ? onChainPortfolio?.agents?.find(a => a.agentId === selectedAgentId) : undefined;

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
          {flowData.rpcWarning && (
            <Card>
              <CardContent className="p-3 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
                <p className="text-xs text-muted-foreground">
                  {flowData.dataSource === "database"
                    ? "Showing trade history from local records. On-chain verification temporarily unavailable."
                    : `Some on-chain data may be incomplete: ${flowData.rpcWarning}`}
                </p>
              </CardContent>
            </Card>
          )}
          <ErrorAlerts errors={flowData.errors} />
          <SummaryCards summary={{
            ...flowData.summary,
            currentWalletBalance: chainData?.freeSui ?? flowData.summary.currentWalletBalance,
            currentlyLockedOnChain: chainData?.totalLocked ?? flowData.summary.currentlyLockedOnChain,
          }} chainDerivedStats={flowData.chainDerivedStats} />
          {flowData.chainDerivedStats && flowData.chainDerivedStats.tradeCount > 0 && (
            <ChainTradeStats stats={flowData.chainDerivedStats} trades={flowData.chainTrades || []} dbTradeCount={flowData.dbTradeCount} untrackedChainTrades={flowData.untrackedChainTrades} />
          )}
          <FlowDiagram summary={{
            ...flowData.summary,
            currentWalletBalance: chainData?.freeSui ?? flowData.summary.currentWalletBalance,
            currentlyLockedOnChain: chainData?.totalLocked ?? flowData.summary.currentlyLockedOnChain,
          }} chainDerivedStats={flowData.chainDerivedStats} />
          <AccountingBreakdown summary={{
            ...flowData.summary,
            currentWalletBalance: chainData?.freeSui ?? flowData.summary.currentWalletBalance,
            currentlyLockedOnChain: chainData?.totalLocked ?? flowData.summary.currentlyLockedOnChain,
          }} chainDerivedStats={flowData.chainDerivedStats} />
          <RewardsSection agentId={selectedAgentId} />
          <TransactionTimeline transactions={flowData.transactions} />
        </>
      )}

      {selectedAgentId && flowError && !flowLoading && (
        <Card>
          <CardContent className="p-4 text-center">
            <AlertTriangle className="h-5 w-5 text-yellow-500 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              SUI Flow data temporarily unavailable — the blockchain RPC may be rate-limited. Try again in a few seconds.
            </p>
          </CardContent>
        </Card>
      )}

      {selectedAgentId && !flowLoading && !flowData && !flowError && (
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