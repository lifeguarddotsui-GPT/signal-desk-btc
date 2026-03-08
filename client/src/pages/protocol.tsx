import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageSEO } from "@/lib/seo";
import {
  Building2,
  Wallet,
  TrendingUp,
  Users,
  Bot,
  Shield,
  Coins,
  ArrowUpRight,
  CheckCircle,
  Copy,
  Package,
  CheckCircle2,
  XOctagon,
  Timer,
  PlayCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { PROTOCOL_FEE_ADDRESS, PROTOCOL_FEE_RATE } from "@shared/schema";
import type { InstructionBundleRecord } from "@shared/schema";

interface ProtocolOverview {
  protocolWallet: string;
  protocolWalletBalance: number;
  feeRate: number;
  totalFeesCollected: number;
  totalVerifiedFees: number;
  totalDeposited: number;
  totalRewardsPaid: number;
  totalRewardsPending: number;
  rewardWallet: string;
  rewardWalletBalance: number;
  uniqueUsers: number;
  uniqueAgents: number;
  totalAgents: number;
  activeAgents: number;
  recentFees: Array<{
    id: string;
    agentId: string;
    userId: string;
    amount: number;
    feeAddress: string;
    txDigest: string | null;
    verified: boolean;
    createdAt: string;
  }>;
}

function BundleExecutionStats() {
  const { data: bundles } = useQuery<InstructionBundleRecord[]>({
    queryKey: ["/api/bundles"],
    refetchInterval: 15000,
  });

  const total = bundles?.length ?? 0;
  const completed = bundles?.filter(b => b.status === "completed").length ?? 0;
  const failed = bundles?.filter(b => b.status === "failed").length ?? 0;
  const expired = bundles?.filter(b => b.status === "expired").length ?? 0;
  const pending = bundles?.filter(b => b.status === "pending" || b.status === "executing").length ?? 0;

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <Package className="h-3.5 w-3.5" />
        Execution Bundle Pipeline
      </h3>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card data-testid="stat-total-bundles">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Total Bundles</CardTitle>
            <Package className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold" data-testid="text-total-bundles">{total}</div>
          </CardContent>
        </Card>

        <Card data-testid="stat-bundles-pending">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">In Queue</CardTitle>
            <PlayCircle className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-blue-500" data-testid="text-bundles-pending">{pending}</div>
          </CardContent>
        </Card>

        <Card data-testid="stat-bundles-completed">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Completed</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-emerald-500" data-testid="text-bundles-completed">{completed}</div>
          </CardContent>
        </Card>

        <Card data-testid="stat-bundles-failed">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Failed</CardTitle>
            <XOctagon className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-red-500" data-testid="text-bundles-failed">{failed}</div>
          </CardContent>
        </Card>

        <Card data-testid="stat-bundles-expired">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Expired</CardTitle>
            <Timer className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-muted-foreground" data-testid="text-bundles-expired">{expired}</div>
          </CardContent>
        </Card>
      </div>

      {total > 0 && (
        <div className="flex items-center gap-1 h-2">
          {completed > 0 && <div className="bg-emerald-500 rounded-full h-full" style={{ flex: completed }} />}
          {pending > 0 && <div className="bg-blue-500 rounded-full h-full" style={{ flex: pending }} />}
          {failed > 0 && <div className="bg-red-500 rounded-full h-full" style={{ flex: failed }} />}
          {expired > 0 && <div className="bg-muted-foreground/50 rounded-full h-full" style={{ flex: expired }} />}
        </div>
      )}
    </div>
  );
}

export default function Protocol() {
  const { toast } = useToast();

  usePageSEO({
    title: "Blue Water Protocol",
    description: "Protocol overview and fee collection dashboard for the Blue Water Agents platform",
  });

  const { data, isLoading } = useQuery<ProtocolOverview>({
    queryKey: ["/api/protocol/overview"],
    refetchInterval: 15000,
  });

  const { data: agents } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ["/api/agents"],
    refetchInterval: 60000,
  });

  const agentNameMap = useMemo(() => {
    const map = new Map<string, string>();
    if (agents) {
      for (const agent of agents) {
        map.set(agent.id, agent.name);
      }
    }
    return map;
  }, [agents]);

  const copyAddress = () => {
    navigator.clipboard.writeText(PROTOCOL_FEE_ADDRESS);
    toast({ title: "Address copied", description: "Protocol wallet address copied to clipboard" });
  };

  if (isLoading) {
    return (
      <div className="p-3 md:p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}><CardContent className="py-6"><Skeleton className="h-6 w-32" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  const overview = data;

  return (
    <div className="p-3 md:p-6 space-y-4" data-testid="page-protocol">
      <div>
        <h2 className="text-lg md:text-xl font-bold tracking-tight" data-testid="text-protocol-title">Blue Water Protocol</h2>
        <p className="text-xs text-muted-foreground">Protocol fee collection and platform overview</p>
      </div>

      <Card data-testid="card-protocol-wallet">
        <CardContent className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 py-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-primary/20 flex items-center justify-center shrink-0">
              <Building2 className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold">Protocol Fee Wallet</h3>
              <p className="text-[10px] font-mono text-muted-foreground break-all" data-testid="text-protocol-address">
                {PROTOCOL_FEE_ADDRESS}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-right mr-2">
              <p className="text-[8px] text-muted-foreground uppercase">On-Chain Balance</p>
              <p className="text-sm font-bold font-mono text-primary" data-testid="text-protocol-balance">
                {(overview?.protocolWalletBalance ?? 0).toFixed(4)} SUI
              </p>
            </div>
            <Badge variant="outline" className="font-mono text-xs">
              {(PROTOCOL_FEE_RATE * 100).toFixed(0)}% Fee
            </Badge>
            <Button size="icon" variant="ghost" onClick={copyAddress} data-testid="button-copy-address">
              <Copy className="h-4 w-4" />
            </Button>
            <a
              href={`https://suiscan.xyz/mainnet/account/${PROTOCOL_FEE_ADDRESS}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="icon" variant="ghost" data-testid="button-view-protocol-explorer">
                <ArrowUpRight className="h-4 w-4" />
              </Button>
            </a>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card data-testid="stat-total-fees">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Verified Fees Collected</CardTitle>
            <Coins className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold font-mono" data-testid="text-total-fees">
              {(overview?.totalFeesCollected ?? 0).toFixed(4)} SUI
            </div>
          </CardContent>
        </Card>

        <Card data-testid="stat-total-deposited">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Total Deposited</CardTitle>
            <TrendingUp className="h-4 w-4 text-chart-3" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold font-mono text-chart-3" data-testid="text-total-deposited">
              {(overview?.totalDeposited ?? 0).toFixed(4)} SUI
            </div>
          </CardContent>
        </Card>

        <Card data-testid="stat-rewards-paid">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Verified Rewards Paid</CardTitle>
            <CheckCircle className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold font-mono text-emerald-500" data-testid="text-rewards-paid">
              {(overview?.totalRewardsPaid ?? 0).toFixed(4)} SUI
            </div>
          </CardContent>
        </Card>

        <Card data-testid="stat-reward-wallet-balance">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Reward Wallet Balance</CardTitle>
            <Wallet className="h-4 w-4 text-chart-4" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold font-mono text-chart-4" data-testid="text-reward-wallet-balance">
              {(overview?.rewardWalletBalance ?? 0).toFixed(4)} SUI
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Total Agents</CardTitle>
            <Bot className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold" data-testid="text-total-agents">{overview?.totalAgents ?? 0}</div>
            <p className="text-[10px] text-muted-foreground">{overview?.activeAgents ?? 0} active</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Unique Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold" data-testid="text-unique-users">{overview?.uniqueUsers ?? 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Fee-Paying Agents</CardTitle>
            <Shield className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold" data-testid="text-fee-agents">{overview?.uniqueAgents ?? 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Verified Fees</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold font-mono" data-testid="text-verified-fees">
              {(overview?.totalVerifiedFees ?? 0).toFixed(4)}
            </div>
          </CardContent>
        </Card>
      </div>

      <BundleExecutionStats />

      <div className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">Recent Protocol Fees</h3>
        {(overview?.recentFees || []).length === 0 ? (
          <Card>
            <CardContent className="text-center py-10">
              <Building2 className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <h3 className="text-sm font-medium mb-1">No fees collected yet</h3>
              <p className="text-xs text-muted-foreground">
                Fees are collected as a {(PROTOCOL_FEE_RATE * 100).toFixed(0)}% charge on agent deposits
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-1.5">
            {(overview?.recentFees || []).map((fee, i) => (
              <Card key={fee.id} data-testid={`fee-row-${i}`}>
                <CardContent className="flex items-center justify-between py-3 gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-md bg-primary/20 flex items-center justify-center shrink-0">
                      <ArrowUpRight className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate" data-testid={`text-fee-agent-${i}`}>Agent: {agentNameMap.get(fee.agentId) || fee.agentId.slice(0, 8) + "..."}</p>
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className="font-mono">
                          {fee.createdAt ? new Date(fee.createdAt).toLocaleDateString() : "N/A"}
                        </span>
                        {fee.verified && (
                          <Badge variant="outline" className="text-[9px] py-0">
                            <CheckCircle className="h-2.5 w-2.5 mr-0.5" />
                            Verified
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <span className="text-xs font-mono font-bold text-primary shrink-0">
                    +{fee.amount.toFixed(4)} SUI
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
