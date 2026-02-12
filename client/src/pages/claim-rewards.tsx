import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
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
} from "lucide-react";
import type { Reward, Agent } from "@shared/schema";
import { usePageSEO } from "@/lib/seo";

interface RewardSummary {
  totalPending: number;
  totalClaimed: number;
  totalEarned: number;
  rewards: Reward[];
}

export default function ClaimRewards() {
  const { toast } = useToast();

  usePageSEO({
    title: "Claim Rewards",
    description: "View and claim your pending SUI trading rewards earned by AI agents on Lifeguard.sui",
  });

  const { data: rewardSummary, isLoading } = useQuery<RewardSummary>({
    queryKey: ["/api/rewards/summary"],
    refetchInterval: 10000,
  });

  const { data: agents } = useQuery<Agent[]>({
    queryKey: ["/api/agents"],
  });

  const claimMutation = useMutation({
    mutationFn: async (rewardId: string) => {
      await apiRequest("POST", `/api/rewards/${rewardId}/claim`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/summary"] });
      toast({ title: "Rewards claimed successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to claim", description: error.message, variant: "destructive" });
    },
  });

  const claimAllMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/rewards/claim-all");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/summary"] });
      toast({ title: "All rewards claimed successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to claim all", description: error.message, variant: "destructive" });
    },
  });

  const getAgentName = (agentId: string) => {
    return agents?.find((a) => a.id === agentId)?.name || "Unknown Agent";
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader className="pb-2"><Skeleton className="h-4 w-24" /></CardHeader>
              <CardContent><Skeleton className="h-8 w-32" /></CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardContent className="pt-6"><Skeleton className="h-48 w-full" /></CardContent>
        </Card>
      </div>
    );
  }

  const totalPending = rewardSummary?.totalPending ?? 0;
  const totalClaimed = rewardSummary?.totalClaimed ?? 0;
  const totalEarned = rewardSummary?.totalEarned ?? 0;
  const pendingRewards = (rewardSummary?.rewards || []).filter((r) => r.status === "pending");
  const claimedRewards = (rewardSummary?.rewards || []).filter((r) => r.status === "claimed");

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6" data-testid="page-claim-rewards">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Claim Rewards</h2>
          <p className="text-sm text-muted-foreground">View and claim your pending trading rewards</p>
        </div>
        {pendingRewards.length > 0 && (
          <Button
            onClick={() => claimAllMutation.mutate()}
            disabled={claimAllMutation.isPending}
            data-testid="button-claim-all"
          >
            <Gift className="h-4 w-4 mr-1" />
            {claimAllMutation.isPending ? "Claiming..." : "Claim All"}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card data-testid="stat-pending-rewards">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Pending Rewards</CardTitle>
            <Clock className="h-4 w-4 text-chart-4" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-chart-4" data-testid="text-pending-amount">
              {totalPending.toFixed(4)} SUI
            </div>
            <p className="text-xs text-muted-foreground mt-1">
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
            <div className="text-2xl font-bold font-mono text-emerald-500" data-testid="text-claimed-amount">
              {totalClaimed.toFixed(4)} SUI
            </div>
            <p className="text-xs text-muted-foreground mt-1">
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
            <div className="text-2xl font-bold font-mono" data-testid="text-total-amount">
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
          <CardContent className="flex flex-col md:flex-row items-center justify-between gap-4 py-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-md bg-primary/20 flex items-center justify-center">
                <Coins className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-bold">{totalPending.toFixed(4)} SUI</h3>
                <p className="text-sm text-muted-foreground">Ready to claim</p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Shield className="h-4 w-4" />
              <span>Non-custodial</span>
              <ArrowRight className="h-4 w-4" />
              <Wallet className="h-4 w-4" />
              <span>Your wallet</span>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">Reward History</h3>
        {(rewardSummary?.rewards || []).length === 0 ? (
          <Card>
            <CardContent className="text-center py-12">
              <Gift className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <h3 className="text-sm font-medium mb-1">No rewards yet</h3>
              <p className="text-xs text-muted-foreground">
                Deploy and start an agent to begin earning rewards
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {(rewardSummary?.rewards || []).map((reward, i) => (
              <Card key={reward.id} data-testid={`reward-row-${i}`}>
                <CardContent className="flex items-center justify-between py-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-md flex items-center justify-center ${
                      reward.status === "pending" ? "bg-chart-4/20" : "bg-emerald-500/20"
                    }`}>
                      {reward.status === "pending" ? (
                        <Clock className="h-4 w-4 text-chart-4" />
                      ) : (
                        <CheckCircle className="h-4 w-4 text-emerald-500" />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{getAgentName(reward.agentId)}</p>
                      <p className="text-xs text-muted-foreground font-mono">
                        {reward.createdAt ? new Date(reward.createdAt).toLocaleDateString() : "N/A"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-mono font-bold">
                      +{reward.amount.toFixed(4)} SUI
                    </span>
                    {reward.status === "pending" ? (
                      <Button
                        size="sm"
                        onClick={() => claimMutation.mutate(reward.id)}
                        disabled={claimMutation.isPending}
                        data-testid={`button-claim-${reward.id}`}
                      >
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
      </div>
    </div>
  );
}
