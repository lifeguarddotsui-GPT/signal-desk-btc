import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Gift,
  Wallet,
  ArrowRight,
  CheckCircle,
  Clock,
  TrendingUp,
  Coins,
  Shield,
  FileCheck,
  Loader2,
  Bot,
  Activity,
  Users,
  Trophy,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";
import type { Reward } from "@shared/schema";
import type { AgentWithSignalAgent } from "@shared/schema";
import { PROTOCOL_FEE_ADDRESS } from "@shared/schema";
import { usePageSEO } from "@/lib/seo";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { waitForFinalized } from "@/lib/tx-verify";

interface RewardSummary {
  totalPending: number;
  totalClaimed: number;
  totalEarned: number;
  rewards: Reward[];
}

interface AgentLeaderboard {
  id: string;
  name: string;
  venue: string;
  status: string;
  totalPnl: number;
  totalTrades: number;
  winRate: number;
  totalRewards: number;
  claimedRewards: number;
}

interface LeaderboardData {
  agents: AgentLeaderboard[];
  users: { walletAddress: string; nsName: string | null; totalRewards: number; agentCount: number; totalPnl: number }[];
}

export default function ClaimRewards() {
  const { toast } = useToast();
  const [claimDialog, setClaimDialog] = useState<{ open: boolean; rewardId?: string; isAll?: boolean; amount?: number }>({ open: false });
  const [claimStatus, setClaimStatus] = useState<"idle" | "signing" | "verifying" | "transferring">("idle");
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  usePageSEO({
    title: "Claim Rewards",
    description: "View and claim your pending SUI trading rewards earned by AI agents on Blue Water Agents",
  });

  const { data: rewardSummary, isLoading } = useQuery<RewardSummary>({
    queryKey: ["/api/rewards/summary"],
    refetchInterval: 10000,
  });

  const { data: agents } = useQuery<AgentWithSignalAgent[]>({
    queryKey: ["/api/agents"],
  });

  const { data: leaderboard } = useQuery<LeaderboardData>({
    queryKey: ["/api/leaderboard"],
    refetchInterval: 30000,
  });

  const claimMutation = useMutation({
    mutationFn: async ({ rewardId, amount }: { rewardId: string; amount: number }) => {
      if (!account?.address) throw new Error("Please connect your SUI wallet first");

      const minTransfer = BigInt(1000);

      const tx = new Transaction();

      const [claimReceipt] = tx.splitCoins(tx.gas, [minTransfer]);
      tx.transferObjects([claimReceipt], PROTOCOL_FEE_ADDRESS);

      setClaimStatus("signing");

      const result = await signAndExecute({ transaction: tx });
      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction signing failed");

      setClaimStatus("verifying");

      const verification = await waitForFinalized(txDigest);
      if (verification.status !== "success") {
        throw new Error(verification.error || "Claim transaction did not finalize on-chain");
      }

      setClaimStatus("transferring");

      const response = await apiRequest("POST", `/api/rewards/${rewardId}/claim`, { txDigest, walletAddress: account.address });
      const data = await response.json();
      return data;
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      const transferredAmount = data.transferredAmount ? Number(data.transferredAmount).toFixed(4) : "0";
      const txDigest = data.transferTxDigest || "";
      toast({
        title: `${transferredAmount} SUI claimed successfully`,
        description: txDigest ? `TX: ${txDigest.slice(0, 12)}...` : "Reward claimed on-chain",
      });
      setClaimDialog({ open: false });
      setClaimStatus("idle");
    },
    onError: (error: Error) => {
      toast({ title: "Claim failed", description: error.message, variant: "destructive" });
      setClaimStatus("idle");
    },
  });

  const claimAllMutation = useMutation({
    mutationFn: async ({ totalAmount }: { totalAmount: number }) => {
      if (!account?.address) throw new Error("Please connect your SUI wallet first");

      const minTransfer = BigInt(1000);

      const tx = new Transaction();

      const [claimReceipt] = tx.splitCoins(tx.gas, [minTransfer]);
      tx.transferObjects([claimReceipt], PROTOCOL_FEE_ADDRESS);

      setClaimStatus("signing");

      const result = await signAndExecute({ transaction: tx });
      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction signing failed");

      setClaimStatus("verifying");

      const verification = await waitForFinalized(txDigest);
      if (verification.status !== "success") {
        throw new Error(verification.error || "Claim transaction did not finalize on-chain");
      }

      setClaimStatus("transferring");

      const response = await apiRequest("POST", "/api/rewards/claim-all", { txDigest, walletAddress: account.address });
      const data = await response.json();
      return data;
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      const transferredAmount = data.totalTransferred ? Number(data.totalTransferred).toFixed(4) : "0";
      const txDigest = data.transferTxDigest || "";
      toast({
        title: `${transferredAmount} SUI claimed successfully`,
        description: txDigest ? `${data.claimed} reward(s) | TX: ${txDigest.slice(0, 12)}...` : `${data.claimed} reward(s) claimed on-chain`,
      });
      setClaimDialog({ open: false });
      setClaimStatus("idle");
    },
    onError: (error: Error) => {
      toast({ title: "Claim failed", description: error.message, variant: "destructive" });
      setClaimStatus("idle");
    },
  });

  const getAgent = (agentId: string) => agents?.find((a) => a.id === agentId);
  const getAgentName = (agentId: string, reward?: any) => {
    const agent = getAgent(agentId);
    if (agent) return agent.name;
    if (reward?.agentName) return reward.agentName;
    return "Test Agent";
  };

  const allRewards = rewardSummary?.rewards || [];
  const verifiableRewards = allRewards.filter((r) => {
    if (r.status === "claimed") return true;
    if (r.status === "pending") return true;
    return false;
  }).sort((a, b) => {
    const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return dateB - dateA;
  });
  const pendingRewards = allRewards.filter((r) => r.status === "pending" && r.escrowTxDigest && r.escrowTxDigest !== "pending_escrow");
  const claimableTotal = pendingRewards.reduce((sum, r) => sum + r.amount, 0);
  const walletConnected = !!account?.address;

  const rewardsByAgent = new Map<string, { agentName: string; agentId: string; venue: string; pending: number; claimed: number; total: number; count: number; isDeleted: boolean }>();
  for (const r of allRewards) {
    const agent = getAgent(r.agentId);
    const existing = rewardsByAgent.get(r.agentId) || {
      agentName: getAgentName(r.agentId, r),
      agentId: r.agentId,
      venue: agent?.venue || "unknown",
      pending: 0, claimed: 0, total: 0, count: 0,
      isDeleted: !agent,
    };
    existing.total += r.amount;
    existing.count += 1;
    if (r.status === "pending") existing.pending += r.amount;
    else existing.claimed += r.amount;
    rewardsByAgent.set(r.agentId, existing);
  }
  const agentRewardsList = Array.from(rewardsByAgent.values()).sort((a, b) => b.total - a.total);

  if (isLoading) {
    return (
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader className="pb-2"><Skeleton className="h-4 w-24" /></CardHeader>
              <CardContent><Skeleton className="h-6 w-28" /></CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const totalPending = pendingRewards.reduce((sum, r) => sum + r.amount, 0);
  const verifiedClaimed = allRewards.filter((r) => r.status === "claimed" && r.txDigest && r.verified);
  const totalClaimed = verifiedClaimed.reduce((sum, r) => sum + r.amount, 0);
  const totalEarned = totalPending + totalClaimed;

  const topAgents = leaderboard?.agents?.slice(0, 5) || [];

  return (
    <div className="p-3 md:p-6 space-y-3 md:space-y-4" data-testid="page-claim-rewards">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg md:text-xl font-bold tracking-tight">Claim Rewards</h2>
          <p className="text-xs md:text-sm text-muted-foreground">Real-time rewards dashboard with on-chain verification</p>
        </div>
        {pendingRewards.length > 0 && (
          <Button
            onClick={() => setClaimDialog({ open: true, isAll: true, amount: claimableTotal })}
            disabled={!walletConnected}
            data-testid="button-claim-all"
          >
            <Gift className="h-4 w-4 mr-1" />
            Claim All ({pendingRewards.length})
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card data-testid="stat-pending-rewards">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Pending Rewards</CardTitle>
            <Clock className="h-4 w-4 text-chart-4" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold font-mono text-chart-4" data-testid="text-pending-amount">
              {totalPending.toFixed(4)} SUI
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {pendingRewards.length} reward{pendingRewards.length !== 1 ? "s" : ""} available
            </p>
          </CardContent>
        </Card>

        <Card data-testid="stat-claimed-rewards">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Total Claimed</CardTitle>
            <CheckCircle className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold font-mono text-emerald-500" data-testid="text-claimed-amount">
              {totalClaimed.toFixed(4)} SUI
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {verifiedClaimed.length} verified on-chain claims
            </p>
          </CardContent>
        </Card>

        <Card data-testid="stat-total-earned">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Total Earned</CardTitle>
            <TrendingUp className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold font-mono" data-testid="text-total-amount">
              {totalEarned.toFixed(4)} SUI
            </div>
            {totalEarned > 0 && (
              <Progress
                value={(totalClaimed / totalEarned) * 100}
                className="mt-2 h-1.5"
              />
            )}
          </CardContent>
        </Card>
      </div>

      {totalPending > 0 && (
        <Card className="border-primary/30 bg-primary/5" data-testid="card-claim-hero">
          <CardContent className="flex flex-col md:flex-row items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-md bg-primary/20 flex items-center justify-center">
                <Coins className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h3 className="text-base font-bold">{totalPending.toFixed(4)} SUI</h3>
                <p className="text-xs text-muted-foreground">Ready to claim</p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Shield className="h-3 w-3" />
              <span>Wallet-signed claim</span>
              <ArrowRight className="h-3 w-3" />
              <Wallet className="h-3 w-3" />
              <span>On-chain verified</span>
            </div>
          </CardContent>
        </Card>
      )}

      {!walletConnected && pendingRewards.length > 0 && (
        <Card className="border-destructive/30">
          <CardContent className="flex items-center gap-3 py-3">
            <Wallet className="h-4 w-4 text-destructive shrink-0" />
            <p className="text-xs text-muted-foreground">
              Connect your SUI wallet to claim rewards. All claims require wallet signature for on-chain verification.
            </p>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="sources" data-testid="tabs-rewards">
        <TabsList className="w-full grid grid-cols-3">
          <TabsTrigger value="sources" className="text-[10px]" data-testid="tab-sources">
            <Bot className="h-3 w-3 mr-1" />
            By Agent
          </TabsTrigger>
          <TabsTrigger value="history" className="text-[10px]" data-testid="tab-history">
            <Activity className="h-3 w-3 mr-1" />
            History
          </TabsTrigger>
          <TabsTrigger value="leaderboard" className="text-[10px]" data-testid="tab-leaderboard">
            <Trophy className="h-3 w-3 mr-1" />
            Top Earners
          </TabsTrigger>
        </TabsList>

        <TabsContent value="sources" className="mt-3 space-y-2">
          {agentRewardsList.length === 0 ? (
            <Card>
              <CardContent className="text-center py-10">
                <Bot className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <h3 className="text-sm font-medium mb-1">No reward sources yet</h3>
                <p className="text-xs text-muted-foreground">
                  Deploy agents and trade profitably to generate rewards
                </p>
              </CardContent>
            </Card>
          ) : (
            agentRewardsList.map((ar) => {
              const agentData = getAgent(ar.agentId);
              const agentLeaderEntry = leaderboard?.agents?.find(a => a.id === ar.agentId);
              return (
                <Card key={ar.agentId} data-testid={`agent-reward-source-${ar.agentId}`}>
                  <CardContent className="py-3 space-y-2">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${agentData?.status === "running" ? "bg-primary/20" : "bg-muted"}`}>
                          <Bot className={`h-3.5 w-3.5 ${agentData?.status === "running" ? "text-primary" : "text-muted-foreground"}`} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1">
                            <p className="text-xs font-medium truncate" data-testid={`text-agent-name-${ar.agentId}`}>{ar.agentName}</p>
                            {ar.isDeleted && <Badge variant="outline" className="text-[7px] px-1 py-0 text-muted-foreground">deleted</Badge>}
                          </div>
                          <p className="text-[10px] text-muted-foreground">{ar.venue === "typus" ? "Typus Perps" : ar.venue}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-mono font-bold text-primary" data-testid={`text-agent-total-${ar.agentId}`}>{ar.total.toFixed(4)} SUI</p>
                        <p className="text-[10px] text-muted-foreground">{ar.count} reward{ar.count !== 1 ? "s" : ""}</p>
                      </div>
                    </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div className="bg-muted rounded-md p-2 text-center">
            <p className="text-[10px] text-muted-foreground uppercase">Pending</p>
            <p className="text-sm font-mono font-bold text-chart-4">{ar.pending.toFixed(4)}</p>
          </div>
          <div className="bg-muted rounded-md p-2 text-center">
            <p className="text-[10px] text-muted-foreground uppercase">Claimed</p>
            <p className="text-sm font-mono font-bold text-emerald-500">{ar.claimed.toFixed(4)}</p>
          </div>
          {agentLeaderEntry && (
            <>
              <div className="bg-muted rounded-md p-2 text-center">
                <p className="text-[10px] text-muted-foreground uppercase">Agent PnL</p>
                <p className={`text-sm font-mono font-bold ${agentLeaderEntry.totalPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {agentLeaderEntry.totalPnl >= 0 ? "+" : ""}{agentLeaderEntry.totalPnl.toFixed(4)}
                </p>
              </div>
              <div className="bg-muted rounded-md p-2 text-center">
                <p className="text-[10px] text-muted-foreground uppercase">Win Rate</p>
                <p className="text-sm font-mono font-bold">{(agentLeaderEntry.winRate * 100).toFixed(0)}%</p>
              </div>
            </>
          )}
        </div>
                    {agentData && (
                      <div className="flex items-center gap-2 text-[9px] text-muted-foreground flex-wrap">
                        <Badge variant={agentData.status === "running" ? "default" : "secondary"} className="text-[8px]">
                          {agentData.status}
                        </Badge>
                        <span>{agentData.leverage}x leverage</span>
                        <span>{(agentData.rewardSharePct ?? 50)}% to rewards</span>
                        {agentLeaderEntry && <span>{agentLeaderEntry.totalTrades} trades</span>}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-3 space-y-2">
          <p className="text-[10px] text-muted-foreground">
            Pending rewards can be claimed via wallet signature. Claimed rewards show on-chain verification status.
          </p>
          {verifiableRewards.length === 0 ? (
            <Card>
              <CardContent className="text-center py-10">
                <Gift className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <h3 className="text-sm font-medium mb-1">No rewards yet</h3>
                <p className="text-xs text-muted-foreground">
                  Deploy and run an agent to start earning rewards. Claims are verified on-chain.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-1.5">
              {verifiableRewards.map((reward, i) => (
                <Card key={reward.id} data-testid={`reward-row-${i}`}>
                  <CardContent className="flex items-center justify-between py-3 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                        reward.status === "pending" ? "bg-chart-4/20" : "bg-emerald-500/20"
                      }`}>
                        {reward.status === "pending" ? (
                          <Clock className="h-3.5 w-3.5 text-chart-4" />
                        ) : (
                          <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-medium truncate">{getAgentName(reward.agentId, reward)}</p>
                          <ArrowUpRight className="h-2.5 w-2.5 text-emerald-500 shrink-0" />
                        </div>
                        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span className="font-mono">
                            {reward.createdAt ? new Date(reward.createdAt).toLocaleDateString() : "N/A"}
                          </span>
                          <span className="font-mono">
                            {reward.createdAt ? new Date(reward.createdAt).toLocaleTimeString() : ""}
                          </span>
                          {reward.verified && reward.txDigest && (
                            <Badge variant="outline" className="text-[9px] gap-0.5 py-0">
                              <FileCheck className="h-2.5 w-2.5" />
                              On-Chain
                            </Badge>
                          )}
                          {reward.txDigest && (
                            <a
                              href={`https://suiscan.xyz/mainnet/tx/${reward.txDigest}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-[9px] text-primary/70 hover:text-primary"
                            >
                              {reward.txDigest.slice(0, 8)}...
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs font-mono font-bold">
                        +{reward.amount.toFixed(4)} SUI
                      </span>
                      {reward.status === "pending" ? (
                        <Button
                          size="sm"
                          onClick={() => setClaimDialog({ open: true, rewardId: reward.id, amount: reward.amount })}
                          disabled={!walletConnected}
                          data-testid={`button-claim-${reward.id}`}
                        >
                          <Wallet className="h-3 w-3 mr-1" />
                          Claim
                        </Button>
                      ) : (
                        <Badge variant="secondary">
                          <CheckCircle className="h-3 w-3 mr-1" />
                          Claimed
                        </Badge>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="leaderboard" className="mt-3 space-y-2">
          <p className="text-[10px] text-muted-foreground">
            Top agents ranked by total rewards generated. Updated in real-time.
          </p>
          {topAgents.length === 0 ? (
            <Card>
              <CardContent className="text-center py-10">
                <Trophy className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <h3 className="text-sm font-medium mb-1">No leaderboard data yet</h3>
                <p className="text-xs text-muted-foreground">Agents need to earn rewards to appear here</p>
              </CardContent>
            </Card>
          ) : (
            topAgents.map((agent, i) => (
              <Card key={agent.id} data-testid={`leaderboard-agent-${i}`}>
                <CardContent className="py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-6 h-6 rounded-md bg-muted flex items-center justify-center shrink-0">
                        {i === 0 ? <Trophy className="h-3 w-3 text-chart-4" /> : <span className="text-[10px] font-mono text-muted-foreground">{i + 1}</span>}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate">{agent.name}</p>
                        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span>{agent.venue === "typus" ? "Typus Perps" : agent.venue}</span>
                          <span>{agent.totalTrades} trades</span>
                          <span>{(agent.winRate * 100).toFixed(0)}% win</span>
                        </div>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-mono font-bold text-primary">{agent.totalRewards.toFixed(4)} SUI</p>
                      <p className={`text-[10px] font-mono ${agent.totalPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                        PnL: {agent.totalPnl >= 0 ? "+" : ""}{agent.totalPnl.toFixed(4)}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}

          {(leaderboard?.users?.length || 0) > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <Users className="h-3 w-3" />
                Top Users by Rewards
              </p>
              {leaderboard!.users.slice(0, 5).map((user, i) => (
                <Card key={user.walletAddress} data-testid={`leaderboard-user-${i}`}>
                  <CardContent className="py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] font-mono text-muted-foreground w-4 text-center shrink-0">{i + 1}</span>
                        <div className="min-w-0">
                          {user.nsName && <p className="text-xs font-semibold text-primary truncate">{user.nsName}</p>}
                          <p className="text-[10px] font-mono text-muted-foreground truncate">{user.walletAddress.slice(0, 8)}...{user.walletAddress.slice(-4)}</p>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs font-mono font-bold text-primary">{user.totalRewards.toFixed(4)} SUI</p>
                        <p className="text-[10px] text-muted-foreground">{user.agentCount} agent{user.agentCount !== 1 ? "s" : ""}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={claimDialog.open} onOpenChange={(v) => { if (!v) { setClaimDialog({ open: false }); setClaimStatus("idle"); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{claimDialog.isAll ? "Claim All Rewards" : "Claim Reward"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="flex items-center justify-between py-3 px-4 rounded-md bg-muted/30">
              <span className="text-sm text-muted-foreground">Amount</span>
              <span className="text-lg font-bold font-mono" data-testid="text-claim-amount">
                {(claimDialog.amount ?? 0).toFixed(4)} SUI
              </span>
            </div>

            <div className="space-y-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <Shield className="h-3.5 w-3.5 text-primary shrink-0" />
                <span>Sign a small authorization transaction (~0.000001 SUI)</span>
              </div>
              <div className="flex items-center gap-2">
                <FileCheck className="h-3.5 w-3.5 text-primary shrink-0" />
                <span>Exact reward amount transferred from secure escrow wallet</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                <span>Rewards are pre-funded and guaranteed on-chain</span>
              </div>
            </div>

            {claimStatus !== "idle" && (
              <div className="flex items-center gap-2 py-2 px-3 rounded-md bg-primary/5 border border-primary/20">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span className="text-xs font-medium">
                  {claimStatus === "signing" ? "Waiting for wallet approval..." : claimStatus === "transferring" ? "Transferring SUI to your wallet..." : "Verifying on-chain..."}
                </span>
              </div>
            )}

            <Button
              className="w-full"
              onClick={() => {
                if (claimDialog.isAll) {
                  claimAllMutation.mutate({ totalAmount: claimDialog.amount ?? 0 });
                } else if (claimDialog.rewardId) {
                  claimMutation.mutate({ rewardId: claimDialog.rewardId, amount: claimDialog.amount ?? 0 });
                }
              }}
              disabled={claimMutation.isPending || claimAllMutation.isPending || !walletConnected}
              data-testid="button-confirm-claim"
            >
              {claimMutation.isPending || claimAllMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  {claimStatus === "signing" ? "Sign in Wallet..." : claimStatus === "transferring" ? "Transferring..." : "Verifying..."}
                </>
              ) : (
                <>
                  <Wallet className="h-4 w-4 mr-1" />
                  Sign & Claim
                </>
              )}
            </Button>

            {!walletConnected && (
              <p className="text-[10px] text-center text-destructive">
                Connect your SUI wallet to claim rewards
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
