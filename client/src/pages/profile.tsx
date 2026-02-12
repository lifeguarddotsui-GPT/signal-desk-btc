import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageSEO } from "@/lib/seo";
import {
  Wallet,
  Bot,
  Activity,
  Shield,
  AlertTriangle,
} from "lucide-react";
import type { AgentWithSignalAgent } from "@shared/schema";

export default function Profile() {
  const acct = useCurrentAccount();
  const address = acct?.address;

  const [suiBalance, setSuiBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  usePageSEO({
    title: "Profile",
    description: "View your wallet connection status, SUI balance, and connected trading agents.",
  });

  useEffect(() => {
    if (!address) {
      setSuiBalance(null);
      return;
    }
    let alive = true;
    setBalanceLoading(true);

    async function fetchBalance() {
      try {
        const r = await fetch(`/api/balance/${address}`);
        const j = await r.json();
        if (alive && j.sui !== undefined) setSuiBalance(j.sui);
      } catch {
        if (alive) setSuiBalance(null);
      } finally {
        if (alive) setBalanceLoading(false);
      }
    }

    fetchBalance();
    return () => { alive = false; };
  }, [address]);

  const { data: agents, isLoading: agentsLoading } = useQuery<AgentWithSignalAgent[]>({
    queryKey: ["/api/agents"],
  });

  if (!address) {
    return (
      <div className="p-4 md:p-6" data-testid="page-profile">
        <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
          <div className="w-14 h-14 rounded-md bg-muted flex items-center justify-center">
            <Wallet className="h-7 w-7 text-muted-foreground" />
          </div>
          <div>
            <h2 className="text-lg font-bold mb-1" data-testid="text-connect-prompt">
              Connect Your Wallet
            </h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              Connect a SUI wallet using the button in the header to view your profile, balance, and connected agents.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="page-profile">
      <div className="space-y-1">
        <h2 className="text-lg md:text-xl font-bold tracking-tight" data-testid="profile-heading">
          Profile
        </h2>
        <p className="text-xs text-muted-foreground">
          Wallet and agent overview
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card data-testid="card-wallet-info">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Wallet</CardTitle>
            <Badge variant="default" className="text-[10px] gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Connected
            </Badge>
          </CardHeader>
          <CardContent>
            <p className="text-xs font-mono truncate" data-testid="text-wallet-address">
              {address}
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-sui-balance">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">SUI Balance</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {balanceLoading ? (
              <Skeleton className="h-7 w-28" />
            ) : (
              <p className="text-xl font-bold font-mono" data-testid="text-sui-balance">
                {suiBalance !== null ? suiBalance.toFixed(4) : "--"} SUI
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium" data-testid="agents-heading">
          Connected Agents
        </h3>

        {agentsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[1, 2].map((i) => (
              <Card key={i}>
                <CardHeader className="pb-2"><Skeleton className="h-4 w-24" /></CardHeader>
                <CardContent><Skeleton className="h-16 w-full" /></CardContent>
              </Card>
            ))}
          </div>
        ) : !agents || agents.length === 0 ? (
          <Card>
            <CardContent className="text-center py-10">
              <Bot className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <h3 className="text-sm font-medium mb-1" data-testid="text-no-agents">No agents deployed</h3>
              <p className="text-xs text-muted-foreground">
                Deploy an agent from the Deploy Agent page to get started.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {agents.map((agent) => {
              const isRunning = agent.status === "running";
              return (
                <Card key={agent.id} data-testid={`profile-agent-card-${agent.id}`}>
                  <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${isRunning ? "bg-primary/20" : "bg-muted"}`}>
                        <Bot className={`h-3.5 w-3.5 ${isRunning ? "text-primary" : "text-muted-foreground"}`} />
                      </div>
                      <CardTitle className="text-sm font-medium truncate" data-testid={`text-agent-name-${agent.id}`}>
                        {agent.name}
                      </CardTitle>
                    </div>
                    <Badge
                      variant={isRunning ? "default" : "secondary"}
                      className="text-[10px]"
                      data-testid={`badge-agent-status-${agent.id}`}
                    >
                      {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1 animate-pulse" />}
                      {agent.status}
                    </Badge>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="text-center">
                        <p className="text-[10px] text-muted-foreground">Balance</p>
                        <p className="text-xs font-mono font-bold" data-testid={`text-agent-balance-${agent.id}`}>
                          {agent.balance.toFixed(2)} SUI
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] text-muted-foreground">PnL</p>
                        <p
                          className={`text-xs font-mono font-bold ${agent.totalPnl > 0 ? "text-emerald-500" : agent.totalPnl < 0 ? "text-red-500" : "text-muted-foreground"}`}
                          data-testid={`text-agent-pnl-${agent.id}`}
                        >
                          {agent.totalPnl === 0 ? "0.00" : `${agent.totalPnl >= 0 ? "+" : ""}${agent.totalPnl.toFixed(2)}`}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] text-muted-foreground">Trades</p>
                        <p className="text-xs font-mono font-bold" data-testid={`text-agent-trades-${agent.id}`}>
                          {agent.totalTrades}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-2 text-[10px] text-muted-foreground flex-wrap">
                      <div className="flex items-center gap-1">
                        <Activity className="h-3 w-3" />
                        <span className="font-mono">{agent.venue}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Shield className="h-3 w-3" />
                        <span className="font-mono">{agent.leverage}x</span>
                      </div>
                      {agent.balance === 0 && (
                        <div className="flex items-center gap-1 text-chart-4">
                          <AlertTriangle className="h-3 w-3" />
                          <span>Unfunded</span>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
