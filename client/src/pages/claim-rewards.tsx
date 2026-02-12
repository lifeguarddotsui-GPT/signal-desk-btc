import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
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
} from "lucide-react";
import type { Reward } from "@shared/schema";
import type { AgentWithSignalAgent } from "@shared/schema";
import { PROTOCOL_FEE_ADDRESS } from "@shared/schema";
import { usePageSEO } from "@/lib/seo";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";

interface RewardSummary {
  totalPending: number;
  totalClaimed: number;
  totalEarned: number;
  rewards: Reward[];
}

export default function ClaimRewards() {
  const { toast } = useToast();
  const [claimDialog, setClaimDialog] = useState<{ open: boolean; rewardId?: string; isAll?: boolean; amount?: number }>({ open: false });
  const [claimStatus, setClaimStatus] = useState<"idle" | "signing" | "verifying">("idle");
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

  const claimMutation = useMutation({
    mutationFn: async ({ rewardId, amount }: { rewardId: string; amount: number }) => {
      if (!account?.address) throw new Error("Please connect your SUI wallet first");

      const claimMist = BigInt(Math.floor(amount * 1e9));
      const minTransfer = BigInt(1000);
      const transferAmount = claimMist > minTransfer ? minTransfer : BigInt(1);

      const tx = new Transaction();
      tx.setSender(account.address);

      const [claimReceipt] = tx.splitCoins(tx.gas, [transferAmount]);
      tx.transferObjects([claimReceipt], PROTOCOL_FEE_ADDRESS);

      setClaimStatus("signing");

      const result = await signAndExecute({ transaction: tx });
      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction signing failed");

      setClaimStatus("verifying");
      await new Promise((resolve) => setTimeout(resolve, 2000));

      await apiRequest("POST", `/api/rewards/${rewardId}/claim`, { txDigest });
      return txDigest;
    },
    onSuccess: (txDigest) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/summary"] });
      toast({
        title: "Reward claimed on-chain",
        description: `TX: ${txDigest.slice(0, 12)}...`,
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

      const claimMist = BigInt(Math.floor(totalAmount * 1e9));
      const minTransfer = BigInt(1000);
      const transferAmount = claimMist > minTransfer ? minTransfer : BigInt(1);

      const tx = new Transaction();
      tx.setSender(account.address);

      const [claimReceipt] = tx.splitCoins(tx.gas, [transferAmount]);
      tx.transferObjects([claimReceipt], PROTOCOL_FEE_ADDRESS);

      setClaimStatus("signing");

      const result = await signAndExecute({ transaction: tx });
      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction signing failed");

      setClaimStatus("verifying");
      await new Promise((resolve) => setTimeout(resolve, 2000));

      await apiRequest("POST", "/api/rewards/claim-all", { txDigest });
      return txDigest;
    },
    onSuccess: (txDigest) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/summary"] });
      toast({
        title: "All rewards claimed on-chain",
        description: `TX: ${txDigest.slice(0, 12)}...`,
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
  const getAgentName = (agentId: string) => getAgent(agentId)?.name || "Agent";
  const isAgentActive = (agentId: string) => {
    const agent = getAgent(agentId);
    return agent && agent.status === "running";
  };

  const pendingRewards = (rewardSummary?.rewards || []).filter((r) => r.status === "pending");
  const activeAgentIds = new Set((agents || []).filter((a) => a.status === "running").map((a) => a.id));
  const claimablePending = pendingRewards.filter((r) => activeAgentIds.has(r.agentId));
  const claimableTotal = claimablePending.reduce((sum, r) => sum + r.amount, 0);
  const walletConnected = !!account?.address;

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

  const totalPending = rewardSummary?.totalPending ?? 0;
  const totalClaimed = rewardSummary?.totalClaimed ?? 0;
  const totalEarned = rewardSummary?.totalEarned ?? 0;
  const claimedRewards = (rewardSummary?.rewards || []).filter((r) => r.status === "claimed");

  return (
    <div className="p-3 md:p-6 space-y-3 md:space-y-4" data-testid="page-claim-rewards">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg md:text-xl font-bold tracking-tight">Claim Rewards</h2>
          <p className="text-xs md:text-sm text-muted-foreground">View and claim pending trading rewards</p>
        </div>
        {claimablePending.length > 0 && (
          <Button
            onClick={() => setClaimDialog({ open: true, isAll: true, amount: claimableTotal })}
            disabled={!walletConnected}
            data-testid="button-claim-all"
          >
            <Gift className="h-4 w-4 mr-1" />
            Claim All ({claimablePending.length})
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
              {claimedRewards.length} claimed
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

      <div className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">Reward History</h3>
        {(rewardSummary?.rewards || []).length === 0 ? (
          <Card>
            <CardContent className="text-center py-10">
              <Gift className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <h3 className="text-sm font-medium mb-1">No rewards yet</h3>
              <p className="text-xs text-muted-foreground">
                Deploy and run an agent to start earning rewards
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-1.5">
            {(rewardSummary?.rewards || []).map((reward, i) => (
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
                      <p className="text-xs font-medium truncate">{getAgentName(reward.agentId)}</p>
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className="font-mono">
                          {reward.createdAt ? new Date(reward.createdAt).toLocaleDateString() : "N/A"}
                        </span>
                        {reward.verified && (
                          <Badge variant="outline" className="text-[9px] gap-0.5 py-0">
                            <FileCheck className="h-2.5 w-2.5" />
                            Verified
                          </Badge>
                        )}
                        {reward.txDigest && (
                          <span className="font-mono text-[9px] text-muted-foreground/70">
                            {reward.txDigest.slice(0, 8)}...
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-mono font-bold">
                      +{reward.amount.toFixed(4)} SUI
                    </span>
                    {reward.status === "pending" ? (
                      isAgentActive(reward.agentId) ? (
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
                        <Badge variant="outline" className="text-[10px]">
                          Agent Inactive
                        </Badge>
                      )
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
      </div>

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
                <span>Your wallet will be prompted to sign the claim transaction</span>
              </div>
              <div className="flex items-center gap-2">
                <FileCheck className="h-3.5 w-3.5 text-primary shrink-0" />
                <span>Transaction is verified on SUI mainnet before processing</span>
              </div>
            </div>

            {claimStatus !== "idle" && (
              <div className="flex items-center gap-2 py-2 px-3 rounded-md bg-primary/5 border border-primary/20">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span className="text-xs font-medium">
                  {claimStatus === "signing" ? "Waiting for wallet approval..." : "Verifying on-chain..."}
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
                  {claimStatus === "signing" ? "Sign in Wallet..." : "Verifying..."}
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
