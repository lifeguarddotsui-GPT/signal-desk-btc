import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePageSEO } from "@/lib/seo";
import {
  Trophy,
  Medal,
  Bot,
  Users,
  TrendingUp,
  Wallet,
  BarChart3,
} from "lucide-react";

interface AgentLeaderboard {
  id: string;
  name: string;
  userId: string;
  venue: string;
  status: string;
  balance: number;
  totalPnl: number;
  totalTrades: number;
  winRate: number;
  totalDeposited: number;
  totalRewards: number;
  claimedRewards: number;
  createdAt: string;
}

interface UserLeaderboard {
  walletAddress: string;
  nsName: string | null;
  totalRewards: number;
  claimedRewards: number;
  agentCount: number;
  totalPnl: number;
  totalTrades: number;
}

interface LeaderboardData {
  agents: AgentLeaderboard[];
  users: UserLeaderboard[];
}

function getRankIcon(rank: number) {
  if (rank === 0) return <Trophy className="h-4 w-4 text-chart-4" />;
  if (rank === 1) return <Medal className="h-4 w-4 text-muted-foreground" />;
  if (rank === 2) return <Medal className="h-4 w-4 text-chart-5" />;
  return <span className="text-xs font-mono text-muted-foreground w-4 text-center">{rank + 1}</span>;
}

function shortenAddress(addr: string) {
  if (!addr || addr.length < 16) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export default function Leaderboard() {
  usePageSEO({
    title: "Leaderboard - Blue Water Agents",
    description: "Top performing AI trading agents and users on the Blue Water Agents platform",
  });

  const { data, isLoading } = useQuery<LeaderboardData>({
    queryKey: ["/api/leaderboard"],
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="p-3 md:p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Card key={i}><CardContent className="py-4"><Skeleton className="h-6 w-full" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  const agentsList = data?.agents || [];
  const usersList = data?.users || [];

  return (
    <div className="p-3 md:p-6 space-y-4" data-testid="page-leaderboard">
      <div>
        <h2 className="text-lg md:text-xl font-bold tracking-tight" data-testid="text-leaderboard-title">Leaderboard</h2>
        <p className="text-xs text-muted-foreground">Top performing agents and users ranked by PnL and rewards</p>
      </div>

      <Tabs defaultValue="agents">
        <TabsList data-testid="tabs-leaderboard">
          <TabsTrigger value="agents" data-testid="tab-agents">
            <Bot className="h-3.5 w-3.5 mr-1" />
            Top Agents
          </TabsTrigger>
          <TabsTrigger value="users" data-testid="tab-users">
            <Users className="h-3.5 w-3.5 mr-1" />
            Top Users
          </TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="mt-3 space-y-2">
          {agentsList.length === 0 ? (
            <Card>
              <CardContent className="text-center py-10">
                <Trophy className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <h3 className="text-sm font-medium mb-1">No agents yet</h3>
                <p className="text-xs text-muted-foreground">
                  Deploy an agent to appear on the leaderboard
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="hidden md:grid grid-cols-[2.5rem_1fr_5rem_5rem_5rem_5rem_5rem] gap-2 px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                <span>#</span>
                <span>Agent</span>
                <span className="text-right">PnL</span>
                <span className="text-right">Trades</span>
                <span className="text-right">Win %</span>
                <span className="text-right">Rewards</span>
                <span className="text-right">Status</span>
              </div>
              {agentsList.map((agent, i) => (
                <Card key={agent.id} data-testid={`agent-rank-${i}`}>
                  <CardContent className="py-3">
                    <div className="grid grid-cols-[2.5rem_1fr] md:grid-cols-[2.5rem_1fr_5rem_5rem_5rem_5rem_5rem] gap-2 items-center">
                      <div className="flex items-center justify-center">
                        {getRankIcon(i)}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate" data-testid={`text-agent-name-${i}`}>{agent.name}</p>
                        <p className="text-[10px] text-muted-foreground font-mono">{agent.venue}</p>
                      </div>
                      <div className="text-right hidden md:block">
                        <span className={`text-xs font-mono font-bold ${agent.totalPnl >= 0 ? "text-chart-3" : "text-chart-5"}`}>
                          {agent.totalPnl >= 0 ? "+" : ""}{agent.totalPnl.toFixed(2)}
                        </span>
                      </div>
                      <div className="text-right hidden md:block">
                        <span className="text-xs font-mono">{agent.totalTrades}</span>
                      </div>
                      <div className="text-right hidden md:block">
                        <span className="text-xs font-mono">{(agent.winRate * 100).toFixed(0)}%</span>
                      </div>
                      <div className="text-right hidden md:block">
                        <span className="text-xs font-mono text-primary">{agent.totalRewards.toFixed(2)}</span>
                      </div>
                      <div className="text-right hidden md:block">
                        <Badge variant={agent.status === "running" ? "default" : "secondary"} className="text-[10px]">
                          {agent.status}
                        </Badge>
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-2 mt-2 md:hidden">
                      <div className="text-center">
                        <p className="text-[9px] text-muted-foreground">PnL</p>
                        <p className={`text-xs font-mono font-bold ${agent.totalPnl >= 0 ? "text-chart-3" : "text-chart-5"}`}>
                          {agent.totalPnl >= 0 ? "+" : ""}{agent.totalPnl.toFixed(2)}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-[9px] text-muted-foreground">Trades</p>
                        <p className="text-xs font-mono">{agent.totalTrades}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[9px] text-muted-foreground">Win</p>
                        <p className="text-xs font-mono">{(agent.winRate * 100).toFixed(0)}%</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[9px] text-muted-foreground">Rewards</p>
                        <p className="text-xs font-mono text-primary">{agent.totalRewards.toFixed(2)}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </TabsContent>

        <TabsContent value="users" className="mt-3 space-y-2">
          {usersList.length === 0 ? (
            <Card>
              <CardContent className="text-center py-10">
                <Users className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <h3 className="text-sm font-medium mb-1">No users yet</h3>
                <p className="text-xs text-muted-foreground">
                  Connect a wallet and deploy agents to appear here
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="hidden md:grid grid-cols-[2.5rem_1fr_5rem_5rem_5rem_5rem] gap-2 px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                <span>#</span>
                <span>Wallet</span>
                <span className="text-right">Rewards</span>
                <span className="text-right">PnL</span>
                <span className="text-right">Agents</span>
                <span className="text-right">Trades</span>
              </div>
              {usersList.map((user, i) => (
                <Card key={user.walletAddress} data-testid={`user-rank-${i}`}>
                  <CardContent className="py-3">
                    <div className="grid grid-cols-[2.5rem_1fr] md:grid-cols-[2.5rem_1fr_5rem_5rem_5rem_5rem] gap-2 items-center">
                      <div className="flex items-center justify-center">
                        {getRankIcon(i)}
                      </div>
                      <div className="min-w-0">
                        {user.nsName && (
                          <p className="text-sm font-semibold text-primary truncate" data-testid={`text-user-ns-${i}`}>
                            {user.nsName}
                          </p>
                        )}
                        <p className="text-[11px] font-mono text-muted-foreground truncate" data-testid={`text-user-wallet-${i}`}>
                          {user.walletAddress}
                        </p>
                        <p className="text-[10px] text-muted-foreground">{user.agentCount} agent{user.agentCount !== 1 ? "s" : ""}</p>
                      </div>
                      <div className="text-right hidden md:block">
                        <span className="text-xs font-mono font-bold text-primary">{user.totalRewards.toFixed(2)}</span>
                      </div>
                      <div className="text-right hidden md:block">
                        <span className={`text-xs font-mono ${user.totalPnl >= 0 ? "text-chart-3" : "text-chart-5"}`}>
                          {user.totalPnl >= 0 ? "+" : ""}{user.totalPnl.toFixed(2)}
                        </span>
                      </div>
                      <div className="text-right hidden md:block">
                        <span className="text-xs font-mono">{user.agentCount}</span>
                      </div>
                      <div className="text-right hidden md:block">
                        <span className="text-xs font-mono">{user.totalTrades}</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-2 mt-2 md:hidden">
                      <div className="text-center">
                        <p className="text-[9px] text-muted-foreground">Rewards</p>
                        <p className="text-xs font-mono font-bold text-primary">{user.totalRewards.toFixed(2)}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[9px] text-muted-foreground">PnL</p>
                        <p className={`text-xs font-mono ${user.totalPnl >= 0 ? "text-chart-3" : "text-chart-5"}`}>
                          {user.totalPnl >= 0 ? "+" : ""}{user.totalPnl.toFixed(2)}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-[9px] text-muted-foreground">Agents</p>
                        <p className="text-xs font-mono">{user.agentCount}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[9px] text-muted-foreground">Trades</p>
                        <p className="text-xs font-mono">{user.totalTrades}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
