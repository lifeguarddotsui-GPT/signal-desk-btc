import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
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
  Target,
  Gift,
  Coins,
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
  freeSui: number;
  portfolioValue: number;
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
  topRewards: AgentLeaderboard[];
  topPnl: AgentLeaderboard[];
  topWinRate: AgentLeaderboard[];
  topPortfolio: AgentLeaderboard[];
  topFreeSui: AgentLeaderboard[];
  users: UserLeaderboard[];
}

function getRankIcon(rank: number) {
  if (rank === 0) return <Trophy className="h-4 w-4 text-chart-4" />;
  if (rank === 1) return <Medal className="h-4 w-4 text-muted-foreground" />;
  if (rank === 2) return <Medal className="h-4 w-4 text-chart-5" />;
  return <span className="text-xs font-mono text-muted-foreground w-4 text-center">{rank + 1}</span>;
}

function getRankBadge(rank: number) {
  if (rank === 0) return <Badge variant="default" className="text-[9px]">1st</Badge>;
  if (rank === 1) return <Badge variant="secondary" className="text-[9px]">2nd</Badge>;
  if (rank === 2) return <Badge variant="secondary" className="text-[9px]">3rd</Badge>;
  return null;
}

function AgentRankCard({ agent, rank, primaryLabel, primaryValue, primaryColor, secondaryMetrics }: {
  agent: AgentLeaderboard;
  rank: number;
  primaryLabel: string;
  primaryValue: string;
  primaryColor?: string;
  secondaryMetrics: { label: string; value: string; color?: string }[];
}) {
  return (
    <Card data-testid={`agent-rank-${rank}`}>
      <CardContent className="py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 shrink-0">
            {getRankIcon(rank)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium truncate" data-testid={`text-agent-name-${rank}`}>{agent.name}</p>
              {getRankBadge(rank)}
              <Badge variant={agent.status === "running" ? "default" : "secondary"} className="text-[9px]">
                {agent.status}
              </Badge>
            </div>
            <p className="text-[10px] text-muted-foreground font-mono">{agent.venue}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[9px] text-muted-foreground uppercase">{primaryLabel}</p>
            <p className={`text-sm font-mono font-bold ${primaryColor || ""}`}>
              {primaryValue}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 mt-2 ml-11 flex-wrap">
          {secondaryMetrics.map((m, i) => (
            <div key={i} className="text-center">
              <p className="text-[9px] text-muted-foreground">{m.label}</p>
              <p className={`text-xs font-mono ${m.color || ""}`}>{m.value}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ icon: Icon, message }: { icon: typeof Trophy; message: string }) {
  return (
    <Card>
      <CardContent className="text-center py-10">
        <Icon className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
        <h3 className="text-sm font-medium mb-1">No agents yet</h3>
        <p className="text-xs text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
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

  const topRewards = data?.topRewards || [];
  const topPnl = data?.topPnl || [];
  const topWinRate = data?.topWinRate || [];
  const topPortfolio = data?.topPortfolio || [];
  const topFreeSui = data?.topFreeSui || [];
  const usersList = data?.users || [];

  return (
    <div className="p-3 md:p-6 space-y-4" data-testid="page-leaderboard">
      <div>
        <h2 className="text-lg md:text-xl font-bold tracking-tight" data-testid="text-leaderboard-title">Leaderboard</h2>
        <p className="text-xs text-muted-foreground">Top performing agents and users across 5 categories</p>
      </div>

      <Tabs defaultValue="rewards">
        <TabsList className="flex-wrap h-auto gap-1" data-testid="tabs-leaderboard">
          <TabsTrigger value="rewards" data-testid="tab-rewards">
            <Gift className="h-3.5 w-3.5 mr-1" />
            <span className="hidden sm:inline">Top </span>Rewards
          </TabsTrigger>
          <TabsTrigger value="pnl" data-testid="tab-pnl">
            <TrendingUp className="h-3.5 w-3.5 mr-1" />
            <span className="hidden sm:inline">Top </span>PnL
          </TabsTrigger>
          <TabsTrigger value="winrate" data-testid="tab-winrate">
            <Target className="h-3.5 w-3.5 mr-1" />
            <span className="hidden sm:inline">Top </span>Win Rate
          </TabsTrigger>
          <TabsTrigger value="portfolio" data-testid="tab-portfolio">
            <Wallet className="h-3.5 w-3.5 mr-1" />
            <span className="hidden sm:inline">Top </span>Portfolio
          </TabsTrigger>
          <TabsTrigger value="freesui" data-testid="tab-freesui">
            <Coins className="h-3.5 w-3.5 mr-1" />
            <span className="hidden sm:inline">Top </span>Free SUI
          </TabsTrigger>
          <TabsTrigger value="users" data-testid="tab-users">
            <Users className="h-3.5 w-3.5 mr-1" />
            <span className="hidden sm:inline">Top </span>Users
          </TabsTrigger>
        </TabsList>

        <TabsContent value="rewards" className="mt-3 space-y-2">
          {topRewards.length === 0 ? (
            <EmptyState icon={Gift} message="Deploy an agent to start earning rewards" />
          ) : (
            topRewards.map((agent, i) => (
              <AgentRankCard
                key={agent.id}
                agent={agent}
                rank={i}
                primaryLabel="Rewards"
                primaryValue={`${agent.totalRewards.toFixed(3)} SUI`}
                secondaryMetrics={[
                  { label: "PnL", value: `${agent.totalPnl >= 0 ? "+" : ""}${agent.totalPnl.toFixed(3)}`, color: agent.totalPnl >= 0 ? "text-chart-3" : "text-chart-5" },
                  { label: "Trades", value: `${agent.totalTrades}` },
                  { label: "Win %", value: `${(agent.winRate * 100).toFixed(0)}%` },
                ]}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="pnl" className="mt-3 space-y-2">
          {topPnl.length === 0 ? (
            <EmptyState icon={TrendingUp} message="Deploy an agent to start trading" />
          ) : (
            topPnl.map((agent, i) => (
              <AgentRankCard
                key={agent.id}
                agent={agent}
                rank={i}
                primaryLabel="PnL"
                primaryValue={`${agent.totalPnl >= 0 ? "+" : ""}${agent.totalPnl.toFixed(3)} SUI`}
                primaryColor={agent.totalPnl >= 0 ? "text-chart-3" : "text-chart-5"}
                secondaryMetrics={[
                  { label: "Rewards", value: `${agent.totalRewards.toFixed(3)}` },
                  { label: "Trades", value: `${agent.totalTrades}` },
                  { label: "Win %", value: `${(agent.winRate * 100).toFixed(0)}%` },
                ]}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="winrate" className="mt-3 space-y-2">
          {topWinRate.length === 0 ? (
            <EmptyState icon={Target} message="Agents need at least 5 trades to qualify" />
          ) : (
            topWinRate.map((agent, i) => (
              <AgentRankCard
                key={agent.id}
                agent={agent}
                rank={i}
                primaryLabel="Win Rate"
                primaryValue={`${(agent.winRate * 100).toFixed(1)}%`}
                secondaryMetrics={[
                  { label: "PnL", value: `${agent.totalPnl >= 0 ? "+" : ""}${agent.totalPnl.toFixed(3)}`, color: agent.totalPnl >= 0 ? "text-chart-3" : "text-chart-5" },
                  { label: "Trades", value: `${agent.totalTrades}` },
                  { label: "Rewards", value: `${agent.totalRewards.toFixed(3)}` },
                ]}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="portfolio" className="mt-3 space-y-2">
          {topPortfolio.length === 0 ? (
            <EmptyState icon={Wallet} message="Deploy an agent with a deposit to appear here" />
          ) : (
            topPortfolio.map((agent, i) => (
              <AgentRankCard
                key={agent.id}
                agent={agent}
                rank={i}
                primaryLabel="Portfolio"
                primaryValue={`${agent.portfolioValue.toFixed(3)} SUI`}
                secondaryMetrics={[
                  { label: "Free SUI", value: `${agent.freeSui.toFixed(3)}` },
                  { label: "PnL", value: `${agent.totalPnl >= 0 ? "+" : ""}${agent.totalPnl.toFixed(3)}`, color: agent.totalPnl >= 0 ? "text-chart-3" : "text-chart-5" },
                  { label: "Trades", value: `${agent.totalTrades}` },
                ]}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="freesui" className="mt-3 space-y-2">
          {topFreeSui.length === 0 ? (
            <EmptyState icon={Coins} message="Deploy an agent with a deposit to appear here" />
          ) : (
            topFreeSui.map((agent, i) => (
              <AgentRankCard
                key={agent.id}
                agent={agent}
                rank={i}
                primaryLabel="Free SUI"
                primaryValue={`${agent.freeSui.toFixed(3)} SUI`}
                secondaryMetrics={[
                  { label: "Portfolio", value: `${agent.portfolioValue.toFixed(3)}` },
                  { label: "PnL", value: `${agent.totalPnl >= 0 ? "+" : ""}${agent.totalPnl.toFixed(3)}`, color: agent.totalPnl >= 0 ? "text-chart-3" : "text-chart-5" },
                  { label: "Trades", value: `${agent.totalTrades}` },
                ]}
              />
            ))
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
            usersList.map((user, i) => (
              <Card key={user.walletAddress} data-testid={`user-rank-${i}`}>
                <CardContent className="py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center w-8 shrink-0">
                      {getRankIcon(i)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {user.nsName && (
                          <p className="text-sm font-semibold truncate" data-testid={`text-user-ns-${i}`}>
                            {user.nsName}
                          </p>
                        )}
                        {getRankBadge(i)}
                      </div>
                      <p className="text-[11px] font-mono text-muted-foreground truncate" data-testid={`text-user-wallet-${i}`}>
                        {user.walletAddress}
                      </p>
                      <p className="text-[10px] text-muted-foreground">{user.agentCount} agent{user.agentCount !== 1 ? "s" : ""}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[9px] text-muted-foreground uppercase">Rewards</p>
                      <p className="text-sm font-mono font-bold">{user.totalRewards.toFixed(3)} SUI</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 mt-2 ml-11 flex-wrap">
                    <div className="text-center">
                      <p className="text-[9px] text-muted-foreground">PnL</p>
                      <p className={`text-xs font-mono ${user.totalPnl >= 0 ? "text-chart-3" : "text-chart-5"}`}>
                        {user.totalPnl >= 0 ? "+" : ""}{user.totalPnl.toFixed(3)}
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
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
