import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { usePageSEO } from "@/lib/seo";
import { useLivePrice } from "@/lib/ws-context";
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
} from "lucide-react";

const VENUE_LABELS: Record<string, string> = {
  typus: "Typus Finance",
  astros: "Astros Perps",
};

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
        <div className="grid grid-cols-3 gap-1.5">
          {Object.entries(reasoning.indicators).map(([key, val]: [string, any]) => (
            <div key={key} className="bg-muted rounded-md p-1.5 text-center">
              <p className="text-[9px] text-muted-foreground uppercase">{key}</p>
              <p className="text-[11px] font-mono font-bold">{typeof val === "number" ? val.toFixed(2) : String(val)}</p>
            </div>
          ))}
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
          {order.txDigest && (
            <div className="flex items-center gap-1 text-[9px]">
              <ExternalLink className="h-2.5 w-2.5 text-primary shrink-0" />
              <span className="font-mono text-primary truncate">{order.txDigest}</span>
              <CopyButton text={order.txDigest} />
            </div>
          )}
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
                {pos.txDigest && (
                  <div className="flex items-center gap-1 text-[9px]">
                    <ExternalLink className="h-2.5 w-2.5 text-primary shrink-0" />
                    <span className="font-mono text-primary truncate">{pos.txDigest}</span>
                    <CopyButton text={pos.txDigest} />
                  </div>
                )}
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
              {pos.txDigest && (
                <div className="flex items-center gap-1 text-[9px]">
                  <ExternalLink className="h-2.5 w-2.5 text-primary shrink-0" />
                  <span className="font-mono text-primary truncate">{pos.txDigest}</span>
                </div>
              )}
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

function AgentDetail({ agent }: { agent: AgentWithSignalAgent }) {
  const livePrice = useLivePrice();
  const currentPrice = livePrice?.blended || 0;

  const { data: activity, isLoading } = useQuery<{
    orders: Order[];
    positions: Position[];
    signals: Signal[];
    reasoning: any;
  }>({
    queryKey: ["/api/agents", agent.id, "activity"],
    refetchInterval: 5000,
  });

  const isRunning = agent.status === "running";
  const venueLabel = VENUE_LABELS[agent.venue] || agent.venue;

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

      <div className="grid grid-cols-4 gap-1.5">
        <div className="bg-muted rounded-md p-2 text-center">
          <p className="text-[9px] text-muted-foreground">Balance</p>
          <p className="text-xs font-mono font-bold">{agent.balance.toFixed(2)}</p>
        </div>
        <div className="bg-muted rounded-md p-2 text-center">
          <p className="text-[9px] text-muted-foreground">PnL</p>
          <p className={`text-xs font-mono font-bold ${agent.totalPnl > 0 ? "text-emerald-500" : agent.totalPnl < 0 ? "text-red-500" : "text-muted-foreground"}`}>
            {agent.totalPnl === 0 ? "0.00" : `${agent.totalPnl >= 0 ? "+" : ""}${agent.totalPnl.toFixed(2)}`}
          </p>
        </div>
        <div className="bg-muted rounded-md p-2 text-center">
          <p className="text-[9px] text-muted-foreground">Trades</p>
          <p className="text-xs font-mono font-bold">{agent.totalTrades}</p>
        </div>
        <div className="bg-muted rounded-md p-2 text-center">
          <p className="text-[9px] text-muted-foreground">Win</p>
          <p className="text-xs font-mono font-bold">{(agent.winRate * 100).toFixed(0)}%</p>
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
        {agent.walletAddress && (
          <div className="flex items-center gap-1">
            <Wallet className="h-3 w-3" />
            <span className="font-mono truncate max-w-[100px]">{agent.walletAddress.slice(0, 6)}...{agent.walletAddress.slice(-4)}</span>
            <CopyButton text={agent.walletAddress} />
          </div>
        )}
      </div>

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

export default function MyAgents() {
  usePageSEO({
    title: "My Agents",
    description: "View your active AI trading agents, their thinking process, open orders, positions, and blockchain activity",
  });

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
