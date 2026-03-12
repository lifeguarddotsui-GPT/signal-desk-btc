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
  Vault,
  Skull,
  RefreshCw,
} from "lucide-react";
import type { Reward } from "@shared/schema";
import { usePageSEO } from "@/lib/seo";
import { useCurrentAccount, useSignPersonalMessage } from "@mysten/dapp-kit";

interface AgentClaimableBalance {
  agentId: string;
  agentName: string;
  claimableBalance: number;
  totalEarned?: number;
  venue: string;
  status: string;
  walletAddress: string | null;
  pendingEscrow?: number;
  escrowedAmount?: number;
}

interface OrphanedAgent {
  agentId: string;
  agentName: string;
  total: number;
}

interface GraveyardEntry {
  id: string;
  originalAgentId: string;
  agentName: string;
  walletAddress: string;
  userId: string | null;
  totalDeposited: number | null;
  totalPnl: number | null;
  totalTrades: number | null;
  balanceAtDeletion: number | null;
  deletedAt: string | null;
  recoveredAt: string | null;
  recoveredTxDigest: string | null;
  recoveredAmount: number | null;
  onChainBalance: number;
  recoverable: boolean;
}

interface GraveyardData {
  entries: GraveyardEntry[];
  totalRecoverable: number;
}

interface RewardSummary {
  totalClaimable: number;
  totalAgentClaimable: number;
  totalLegacyClaimable: number;
  totalClaimed: number;
  totalEarned: number;
  agentClaimableBalances: AgentClaimableBalance[];
  legacyEscrowedRewards: Reward[];
  rewards: Reward[];
  rewardWalletBalance: number;
  rewardWalletAddress: string;
  totalPendingEscrow: number;
  totalOrphaned: number;
  orphanedByAgent: OrphanedAgent[];
  directlyClaimable: number;
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
  const [claimDialog, setClaimDialog] = useState<{ open: boolean; agentId?: string; agentName?: string; isAll?: boolean; amount?: number }>({ open: false });
  const [claimStatus, setClaimStatus] = useState<"idle" | "signing" | "transferring">("idle");
  const account = useCurrentAccount();
  const { mutateAsync: signMessage } = useSignPersonalMessage();

  usePageSEO({
    title: "Claim Rewards",
    description: "View and claim your pending SUI trading rewards earned by AI agents on Blue Water Agents",
  });

  const { data: rewardSummary, isLoading } = useQuery<RewardSummary>({
    queryKey: ["/api/rewards/summary"],
    refetchInterval: 10000,
  });

  const { data: leaderboard } = useQuery<LeaderboardData>({
    queryKey: ["/api/leaderboard"],
    refetchInterval: 30000,
  });

  const claimAgentMutation = useMutation({
    mutationFn: async ({ agentId, amount }: { agentId: string; amount: number }) => {
      if (!account?.address) throw new Error("Please connect your SUI wallet first");

      setClaimStatus("signing");
      const message = `Blue Water Agents: Claim ${amount.toFixed(4)} SUI from agent ${agentId} to ${account.address}`;
      const messageBytes = new TextEncoder().encode(message);
      const result = await signMessage({ message: messageBytes });
      if (!result.signature) throw new Error("Message signing failed");

      setClaimStatus("transferring");
      const response = await apiRequest("POST", `/api/agents/${agentId}/claim-rewards`, {
        signature: result.signature,
        message,
        walletAddress: account.address,
      });
      return await response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({
        title: `${Number(data.amount).toFixed(4)} SUI claimed from ${data.agentName}`,
        description: data.txDigest ? `TX: ${data.txDigest.slice(0, 12)}...` : "Claimed on-chain",
      });
      setClaimDialog({ open: false });
      setClaimStatus("idle");
    },
    onError: (error: Error) => {
      const isRateLimit = error.message?.includes("429") || error.message?.includes("rate limit");
      toast({ title: isRateLimit ? "Network busy" : "Claim failed", description: isRateLimit ? "SUI network is busy. Please wait and try again." : error.message, variant: "destructive" });
      setClaimStatus("idle");
    },
  });

  const claimAllMutation = useMutation({
    mutationFn: async ({ totalAmount }: { totalAmount: number }) => {
      if (!account?.address) throw new Error("Please connect your SUI wallet first");

      setClaimStatus("signing");
      const message = `Blue Water Agents: Claim all rewards (${totalAmount.toFixed(4)} SUI) to ${account.address}`;
      const messageBytes = new TextEncoder().encode(message);
      const result = await signMessage({ message: messageBytes });
      if (!result.signature) throw new Error("Message signing failed");

      setClaimStatus("transferring");
      const response = await apiRequest("POST", "/api/rewards/claim-all-agents", {
        signature: result.signature,
        message,
        walletAddress: account.address,
      });
      return await response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      const totalStr = Number(data.totalTransferred).toFixed(4);
      const failedResults = (data.results || []).filter((r: any) => r.error);
      const failedMsg = failedResults.length > 0 ? failedResults[0].error : `${data.failed} agent(s) failed`;
      if (data.claimed === 0 && data.failed > 0) {
        toast({
          title: "Could not claim rewards",
          description: failedMsg,
          variant: "destructive",
        });
      } else {
        toast({
          title: `${totalStr} SUI claimed from ${data.claimed} agent${data.claimed !== 1 ? "s" : ""}`,
          description: data.failed > 0 ? failedMsg : "All claims successful",
        });
      }
      setClaimDialog({ open: false });
      setClaimStatus("idle");
    },
    onError: (error: Error) => {
      const isRateLimit = error.message?.includes("429") || error.message?.includes("rate limit");
      toast({ title: isRateLimit ? "Network busy" : "Claim failed", description: isRateLimit ? "SUI network is busy. Please wait and try again." : error.message, variant: "destructive" });
      setClaimStatus("idle");
    },
  });

  const claimWalletBalanceMutation = useMutation({
    mutationFn: async () => {
      if (!account?.address) throw new Error("Please connect your SUI wallet first");
      const response = await apiRequest("POST", "/api/rewards/claim-wallet-balance", {
        walletAddress: account.address,
      });
      return await response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/summary"] });
      toast({
        title: `${Number(data.amount).toFixed(4)} SUI claimed from reward wallet`,
        description: data.txDigest ? `TX: ${data.txDigest.slice(0, 12)}...` : "Transferred on-chain",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Claim failed", description: error.message, variant: "destructive" });
    },
  });

  const processEscrowMutation = useMutation({
    mutationFn: async () => {
      if (!account?.address) throw new Error("Please connect your SUI wallet first");
      const response = await apiRequest("POST", "/api/rewards/process-pending-escrow", {
        walletAddress: account.address,
      });
      return await response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/summary"] });
      if (data.success) {
        toast({
          title: `${Number(data.totalEscrowed).toFixed(4)} SUI escrowed to reward wallet`,
          description: `Rewards are now claimable. ${data.results?.map((r: any) => r.agentName).join(", ")}`,
        });
      } else {
        toast({
          title: "Escrow processed",
          description: data.message || "Some rewards could not be escrowed yet.",
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Escrow failed", description: error.message, variant: "destructive" });
    },
  });

  const { data: graveyardData, refetch: refetchGraveyard } = useQuery<GraveyardData>({
    queryKey: ["/api/rewards/graveyard"],
    refetchInterval: 30000,
  });

  const recoverGraveyardMutation = useMutation({
    mutationFn: async ({ id, agentName }: { id: string; agentName: string }) => {
      if (!account?.address) throw new Error("Please connect your SUI wallet first");
      const response = await apiRequest("POST", `/api/rewards/graveyard/${id}/recover`, {
        walletAddress: account.address,
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Recovery failed");
      }
      return await response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/graveyard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/summary"] });
      toast({
        title: `${Number(data.amount).toFixed(4)} SUI recovered from ${data.agentName}`,
        description: data.txDigest ? `TX: ${data.txDigest.slice(0, 12)}...` : "Transferred on-chain",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Recovery failed", description: error.message, variant: "destructive" });
    },
  });

  const walletConnected = !!account?.address;
  const agentBalances = rewardSummary?.agentClaimableBalances || [];
  const totalClaimable = rewardSummary?.totalClaimable || 0;
  const totalClaimed = rewardSummary?.totalClaimed || 0;
  const totalEarned = rewardSummary?.totalEarned || 0;
  const rewardWalletBalance = rewardSummary?.rewardWalletBalance ?? 0;
  const rewardWalletAddress = rewardSummary?.rewardWalletAddress || "";
  const totalPendingEscrow = rewardSummary?.totalPendingEscrow || 0;
  const totalOrphaned = rewardSummary?.totalOrphaned || 0;
  const orphanedByAgent = rewardSummary?.orphanedByAgent || [];
  const directlyClaimable = rewardSummary?.directlyClaimable ?? 0;
  const allRewards = rewardSummary?.rewards || [];

  const claimedRewards = allRewards.filter(r => r.status === "claimed");
  const pendingRewards = allRewards.filter(r => r.status === "pending");
  const historyRewards = [...claimedRewards, ...pendingRewards].sort((a, b) => {
    const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return dateB - dateA;
  });

  const topAgents = leaderboard?.agents?.slice(0, 5) || [];

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

  return (
    <div className="p-3 md:p-6 space-y-3 md:space-y-4" data-testid="page-claim-rewards">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg md:text-xl font-bold tracking-tight">Claim Rewards</h2>
          <p className="text-xs md:text-sm text-muted-foreground">Profit share escrowed to reward wallet — claim to your SUI wallet</p>
        </div>
        {totalClaimable > 0 && (
          <Button
            onClick={() => setClaimDialog({ open: true, isAll: true, amount: totalClaimable })}
            disabled={!walletConnected}
            data-testid="button-claim-all"
          >
            <Gift className="h-4 w-4 mr-1" />
            Claim All ({agentBalances.length} agent{agentBalances.length !== 1 ? "s" : ""})
          </Button>
        )}
      </div>

      {/* Reward Wallet Balance Banner */}
      <Card className="border-primary/40 bg-primary/5" data-testid="card-reward-wallet-balance">
        <CardContent className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 py-3 px-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-md bg-primary/20 flex items-center justify-center shrink-0">
              <Vault className="h-4 w-4 text-primary" />
            </div>
            <div>
              <div className="text-xs text-muted-foreground font-medium">Reward Wallet (On-Chain)</div>
              <div className="text-lg font-bold font-mono text-primary" data-testid="text-reward-wallet-balance">
                {rewardWalletBalance.toFixed(4)} SUI
              </div>
              {rewardWalletAddress && (
                <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                  {rewardWalletAddress.slice(0, 6)}…{rewardWalletAddress.slice(-6)}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-1.5 text-xs text-muted-foreground items-end">
            {directlyClaimable > 0.001 && (
              <Button
                size="sm"
                className="h-8 text-[11px] bg-primary hover:bg-primary/90"
                disabled={!walletConnected || claimWalletBalanceMutation.isPending}
                onClick={() => claimWalletBalanceMutation.mutate()}
                data-testid="button-claim-wallet-balance"
              >
                {claimWalletBalanceMutation.isPending ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <Wallet className="h-3 w-3 mr-1" />
                )}
                Claim {directlyClaimable.toFixed(4)} SUI
              </Button>
            )}
            <div className="flex items-center gap-1.5 justify-end">
              <CheckCircle className="h-3 w-3 text-emerald-500" />
              <span className="text-emerald-400 font-medium">{directlyClaimable.toFixed(4)} SUI in wallet</span>
            </div>
            {totalPendingEscrow > 0.001 && (
              <div className="flex flex-col gap-1 items-end">
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3 w-3 text-yellow-500" />
                  <span className="text-yellow-400">{totalPendingEscrow.toFixed(4)} SUI pending escrow (live agents)</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px] border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10"
                  disabled={!walletConnected || processEscrowMutation.isPending}
                  onClick={() => processEscrowMutation.mutate()}
                  data-testid="button-process-escrow"
                >
                  {processEscrowMutation.isPending ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Vault className="h-3 w-3 mr-1" />
                  )}
                  Process Pending Escrow
                </Button>
              </div>
            )}
            {totalOrphaned > 0.001 && (
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground/60">{totalOrphaned.toFixed(4)} SUI orphaned (deleted agents)</span>
              </div>
            )}
            <div className="flex items-center gap-1.5 justify-end">
              <Coins className="h-3 w-3" />
              <span>{totalClaimed.toFixed(4)} SUI claimed total</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
              {claimedRewards.length} verified claims
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

      {!walletConnected && (totalClaimable > 0 || directlyClaimable > 0) && (
        <Card className="border-destructive/30">
          <CardContent className="flex items-center gap-3 py-3">
            <Wallet className="h-4 w-4 text-destructive shrink-0" />
            <p className="text-xs text-muted-foreground">
              Connect your SUI wallet to claim rewards. All claims require wallet signature for on-chain verification.
            </p>
          </CardContent>
        </Card>
      )}

      {totalOrphaned > 0.001 && (
        <Card className="border-orange-500/30 bg-orange-500/5" data-testid="card-orphaned-rewards">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium flex items-center gap-2">
              <span className="text-orange-400">⚠</span>
              Orphaned Reward Records
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[11px] text-muted-foreground">
              {totalOrphaned.toFixed(4)} SUI in reward records are linked to deleted agents.
              Check the Agent Graveyard below — if the wallet still has on-chain balance, you can recover it directly.
            </p>
            <div className="space-y-1">
              {orphanedByAgent.slice(0, 10).map((oa) => (
                <div key={oa.agentId} className="flex items-center justify-between text-[10px] text-muted-foreground border border-border/30 rounded px-2 py-1">
                  <span className="font-medium">{oa.agentName}</span>
                  <span className="font-mono text-orange-400">{oa.total.toFixed(4)} SUI</span>
                </div>
              ))}
              {orphanedByAgent.length > 10 && (
                <p className="text-[9px] text-muted-foreground">+ {orphanedByAgent.length - 10} more deleted agents</p>
              )}
            </div>
            {directlyClaimable > 0.001 && (
              <div className="flex items-center gap-2 pt-1">
                <Button
                  size="sm"
                  className="h-7 text-[10px]"
                  disabled={!walletConnected || claimWalletBalanceMutation.isPending}
                  onClick={() => claimWalletBalanceMutation.mutate()}
                >
                  {claimWalletBalanceMutation.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Wallet className="h-3 w-3 mr-1" />}
                  Claim {directlyClaimable.toFixed(4)} SUI from Reward Wallet
                </Button>
                <span className="text-[9px] text-muted-foreground">Already escrowed on-chain</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Agent Graveyard — recovered keypairs for deleted agents */}
      {(graveyardData?.entries?.length ?? 0) > 0 && (
        <Card className="border-purple-500/30 bg-purple-500/5" data-testid="card-graveyard">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs font-medium flex items-center gap-2">
                <Skull className="h-3.5 w-3.5 text-purple-400" />
                Agent Graveyard
                {(graveyardData?.totalRecoverable ?? 0) > 0.001 && (
                  <Badge variant="outline" className="text-[9px] border-purple-500/40 text-purple-400 ml-1">
                    {(graveyardData!.totalRecoverable).toFixed(4)} SUI recoverable
                  </Badge>
                )}
              </CardTitle>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => refetchGraveyard()}
                data-testid="button-refresh-graveyard"
              >
                <RefreshCw className="h-3 w-3 text-muted-foreground" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              Deleted agents whose keypairs were preserved. Any on-chain balance can be recovered to your wallet.
              Going forward, all agent wallets are preserved here when deleted.
            </p>
            <div className="space-y-2">
              {graveyardData!.entries.map((entry) => (
                <div
                  key={entry.id}
                  className={`rounded-lg border px-3 py-2.5 space-y-1.5 ${
                    entry.recoveredAt
                      ? "border-border/20 bg-muted/10"
                      : entry.recoverable
                      ? "border-purple-500/30 bg-purple-500/5"
                      : "border-border/30"
                  }`}
                  data-testid={`graveyard-entry-${entry.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Skull className={`h-3 w-3 shrink-0 ${entry.recoveredAt ? "text-muted-foreground/40" : "text-purple-400"}`} />
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate">{entry.agentName}</p>
                        <p className="text-[10px] font-mono text-muted-foreground truncate">
                          {entry.walletAddress.slice(0, 10)}...{entry.walletAddress.slice(-6)}
                        </p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      {entry.recoveredAt ? (
                        <div className="text-right">
                          <Badge variant="outline" className="text-[9px] border-emerald-500/40 text-emerald-400">
                            <CheckCircle className="h-2.5 w-2.5 mr-1" />
                            Recovered
                          </Badge>
                          <p className="text-[9px] text-muted-foreground mt-0.5">
                            {(entry.recoveredAmount ?? 0).toFixed(4)} SUI
                          </p>
                        </div>
                      ) : (
                        <div className="text-right">
                          <p className={`text-xs font-mono font-bold ${entry.onChainBalance > 0.001 ? "text-purple-400" : "text-muted-foreground/50"}`}>
                            {entry.onChainBalance.toFixed(4)} SUI
                          </p>
                          <p className="text-[9px] text-muted-foreground">on-chain</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
                    <span>{entry.totalTrades ?? 0} trades</span>
                    <span className={(entry.totalPnl ?? 0) >= 0 ? "text-emerald-500" : "text-red-400"}>
                      PnL: {(entry.totalPnl ?? 0) >= 0 ? "+" : ""}{(entry.totalPnl ?? 0).toFixed(4)}
                    </span>
                    <span>deposited: {(entry.totalDeposited ?? 0).toFixed(2)}</span>
                    {entry.deletedAt && (
                      <span>deleted {new Date(entry.deletedAt).toLocaleDateString()}</span>
                    )}
                  </div>

                  {!entry.recoveredAt && entry.recoverable && (
                    <Button
                      size="sm"
                      className="h-7 text-[10px] w-full mt-1 bg-purple-600 hover:bg-purple-700"
                      disabled={!walletConnected || recoverGraveyardMutation.isPending}
                      onClick={() => recoverGraveyardMutation.mutate({ id: entry.id, agentName: entry.agentName })}
                      data-testid={`button-recover-graveyard-${entry.id}`}
                    >
                      {recoverGraveyardMutation.isPending ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <Wallet className="h-3 w-3 mr-1" />
                      )}
                      Recover {entry.onChainBalance.toFixed(4)} SUI to My Wallet
                    </Button>
                  )}

                  {!entry.recoveredAt && !entry.recoverable && entry.onChainBalance <= 0.001 && (
                    <p className="text-[9px] text-muted-foreground/50 italic">
                      No on-chain balance — wallet is empty
                    </p>
                  )}

                  {entry.recoveredAt && entry.recoveredTxDigest && (
                    <p className="text-[9px] text-muted-foreground font-mono">
                      TX: {entry.recoveredTxDigest.slice(0, 16)}...
                    </p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="agents" data-testid="tabs-rewards">
        <TabsList className="w-full grid grid-cols-3">
          <TabsTrigger value="agents" className="text-[10px]" data-testid="tab-agents">
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

        <TabsContent value="agents" className="mt-3 space-y-2">
          {agentBalances.length === 0 ? (
            <Card>
              <CardContent className="text-center py-10">
                <Bot className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <h3 className="text-sm font-medium mb-1">No claimable agent balances</h3>
                <p className="text-xs text-muted-foreground">
                  Trade profitably to accumulate claimable rewards in agent wallets
                </p>
              </CardContent>
            </Card>
          ) : (
            agentBalances.map((ab) => {
              const agentLeaderEntry = leaderboard?.agents?.find(a => a.id === ab.agentId);
              return (
                <Card key={ab.agentId} data-testid={`agent-claimable-${ab.agentId}`}>
                  <CardContent className="py-3 space-y-2">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${ab.status === "running" ? "bg-primary/20" : "bg-muted"}`}>
                          <Bot className={`h-3.5 w-3.5 ${ab.status === "running" ? "text-primary" : "text-muted-foreground"}`} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-medium truncate" data-testid={`text-agent-name-${ab.agentId}`}>{ab.agentName}</p>
                          <p className="text-[10px] text-muted-foreground">{ab.venue === "typus" ? "Typus Perps" : ab.venue}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <p className="text-sm font-mono font-bold text-chart-4" data-testid={`text-agent-claimable-${ab.agentId}`}>
                            {ab.claimableBalance.toFixed(4)} SUI
                          </p>
                          {ab.totalEarned && ab.totalEarned > ab.claimableBalance + 0.001 && (
                            <p className="text-[9px] text-muted-foreground">
                              {(ab.totalEarned - ab.claimableBalance).toFixed(4)} locked
                            </p>
                          )}
                        </div>
                        <Button
                          size="sm"
                          onClick={() => setClaimDialog({ open: true, agentId: ab.agentId, agentName: ab.agentName, amount: ab.claimableBalance })}
                          disabled={!walletConnected || ab.claimableBalance < 0.001}
                          data-testid={`button-claim-agent-${ab.agentId}`}
                        >
                          <Wallet className="h-3 w-3 mr-1" />
                          {ab.claimableBalance < 0.001 ? "Locked" : "Claim"}
                        </Button>
                      </div>
                    </div>

                    {agentLeaderEntry && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
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
                        <div className="bg-muted rounded-md p-2 text-center">
                          <p className="text-[10px] text-muted-foreground uppercase">Total Rewards</p>
                          <p className="text-sm font-mono font-bold text-primary">{agentLeaderEntry.totalRewards.toFixed(4)}</p>
                        </div>
                        <div className="bg-muted rounded-md p-2 text-center">
                          <p className="text-[10px] text-muted-foreground uppercase">Trades</p>
                          <p className="text-sm font-mono font-bold">{agentLeaderEntry.totalTrades}</p>
                        </div>
                      </div>
                    )}

                    <div className="flex items-center gap-2 text-[9px] text-muted-foreground flex-wrap">
                      <Badge variant={ab.status === "running" ? "default" : "secondary"} className="text-[8px]">
                        {ab.status}
                      </Badge>
                      {ab.escrowedAmount && ab.escrowedAmount > 0.001 ? (
                        <span className="text-emerald-400">✓ Escrowed in reward wallet</span>
                      ) : ab.pendingEscrow && ab.pendingEscrow > 0.001 ? (
                        <span className="text-yellow-400">⏳ {ab.pendingEscrow.toFixed(4)} SUI pending escrow</span>
                      ) : (
                        <span>Profit share tracked</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-3 space-y-2">
          <p className="text-[10px] text-muted-foreground">
            Reward history showing escrowed and claimed rewards.
          </p>
          {historyRewards.length === 0 ? (
            <Card>
              <CardContent className="text-center py-10">
                <Gift className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <h3 className="text-sm font-medium mb-1">No rewards yet</h3>
                <p className="text-xs text-muted-foreground">
                  Deploy and run an agent to start earning rewards.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-1.5">
              {historyRewards.slice(0, 50).map((reward, i) => (
                <Card key={reward.id} data-testid={`reward-row-${i}`}>
                  <CardContent className="flex items-center justify-between py-3 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                        reward.status === "claimed" ? "bg-emerald-500/20" : "bg-chart-4/20"
                      }`}>
                        {reward.status === "claimed" ? (
                          <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <Coins className="h-3.5 w-3.5 text-chart-4" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-medium truncate">{reward.agentName || reward.agentId.slice(0, 8)}</p>
                          {reward.status === "claimed" && (
                            <Badge variant="outline" className="text-[8px] py-0 text-emerald-400 border-emerald-500/30">Claimed</Badge>
                          )}
                          {reward.status === "pending" && reward.escrowTxDigest === "agent_retained" && (
                            <Badge variant="outline" className="text-[8px] py-0">Legacy</Badge>
                          )}
                          {reward.status === "pending" && reward.escrowTxDigest === "pending_escrow" && (
                            <Badge variant="outline" className="text-[8px] py-0 text-yellow-400 border-yellow-500/30">Pending Escrow</Badge>
                          )}
                          {reward.status === "pending" && reward.escrowTxDigest && reward.escrowTxDigest !== "agent_retained" && reward.escrowTxDigest !== "pending_escrow" && (
                            <Badge variant="outline" className="text-[8px] py-0 text-primary/80 border-primary/30">Escrowed</Badge>
                          )}
                          {reward.status === "claimed" && (
                            <ArrowUpRight className="h-2.5 w-2.5 text-emerald-500 shrink-0" />
                          )}
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
                    <span className="text-xs font-mono font-bold shrink-0">
                      +{reward.amount.toFixed(4)} SUI
                    </span>
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
            <DialogTitle>{claimDialog.isAll ? "Claim All Agent Rewards" : `Claim from ${claimDialog.agentName || "Agent"}`}</DialogTitle>
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
                <span>Sign a message to verify wallet ownership (no gas cost)</span>
              </div>
              <div className="flex items-center gap-2">
                <FileCheck className="h-3.5 w-3.5 text-primary shrink-0" />
                <span>{(claimDialog.amount ?? 0).toFixed(4)} SUI transferred directly from agent wallet{claimDialog.isAll ? "s" : ""}</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                <span>On-chain verified transfer to your wallet</span>
              </div>
            </div>

            {claimStatus !== "idle" && (
              <div className="flex items-center gap-2 py-2 px-3 rounded-md bg-primary/5 border border-primary/20">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span className="text-xs font-medium">
                  {claimStatus === "signing" ? "Sign message in wallet..." : "Transferring SUI from agent wallet..."}
                </span>
              </div>
            )}

            <Button
              className="w-full"
              onClick={() => {
                if (claimDialog.isAll) {
                  claimAllMutation.mutate({ totalAmount: claimDialog.amount ?? 0 });
                } else if (claimDialog.agentId) {
                  claimAgentMutation.mutate({ agentId: claimDialog.agentId, amount: claimDialog.amount ?? 0 });
                }
              }}
              disabled={claimAgentMutation.isPending || claimAllMutation.isPending || !walletConnected}
              data-testid="button-confirm-claim"
            >
              {claimAgentMutation.isPending || claimAllMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  {claimStatus === "signing" ? "Sign in Wallet..." : claimStatus === "transferring" ? "Transferring..." : "Processing..."}
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
