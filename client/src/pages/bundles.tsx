import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageSEO } from "@/lib/seo";
import type { InstructionBundleRecord, BundleExecutionRecord } from "@shared/schema";
import {
  Package,
  Clock,
  PlayCircle,
  CheckCircle2,
  XOctagon,
  Timer,
  TrendingUp,
  TrendingDown,
  XCircle,
  Shield,
  Bot,
  ExternalLink,
} from "lucide-react";

const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle2; color: string; label: string }> = {
  pending: { icon: Clock, color: "text-yellow-500", label: "Pending" },
  executing: { icon: PlayCircle, color: "text-blue-500", label: "Executing" },
  completed: { icon: CheckCircle2, color: "text-emerald-500", label: "Completed" },
  recorded: { icon: CheckCircle2, color: "text-teal-500", label: "Recorded" },
  failed: { icon: XOctagon, color: "text-red-500", label: "Failed" },
  expired: { icon: Timer, color: "text-muted-foreground", label: "Expired" },
};

export default function Bundles() {
  usePageSEO({
    title: "Execution Bundles - Blue Water Agents",
    description: "View all instruction bundles and their execution status across all agents",
  });

  const { data: bundles, isLoading } = useQuery<InstructionBundleRecord[]>({
    queryKey: ["/api/bundles"],
    refetchInterval: 10000,
  });

  if (isLoading) {
    return (
      <div className="p-3 md:p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <Card key={i}><CardContent className="py-6"><Skeleton className="h-6 w-20" /></CardContent></Card>
          ))}
        </div>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      </div>
    );
  }

  const total = bundles?.length ?? 0;
  const completed = bundles?.filter(b => b.status === "completed" || b.status === "recorded").length ?? 0;
  const failed = bundles?.filter(b => b.status === "failed").length ?? 0;
  const expired = bundles?.filter(b => b.status === "expired").length ?? 0;
  const pending = bundles?.filter(b => b.status === "pending" || b.status === "executing").length ?? 0;
  const successRate = total > 0 ? ((completed / total) * 100).toFixed(1) : "0";

  return (
    <div className="p-3 md:p-6 space-y-4" data-testid="page-bundles">
      <div>
        <h2 className="text-lg md:text-xl font-bold tracking-tight" data-testid="text-bundles-title">Execution Bundles</h2>
        <p className="text-xs text-muted-foreground">On-chain instruction bundles emitted by AI agents and processed by the executor service</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card data-testid="stat-total-bundles">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Total</CardTitle>
            <Package className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold" data-testid="text-total">{total}</div>
            <p className="text-[10px] text-muted-foreground">{successRate}% success</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">In Queue</CardTitle>
            <PlayCircle className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold text-blue-500">{pending}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Completed</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold text-emerald-500">{completed}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Failed</CardTitle>
            <XOctagon className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold text-red-500">{failed}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground">Expired</CardTitle>
            <Timer className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold text-muted-foreground">{expired}</div>
          </CardContent>
        </Card>
      </div>

      {total > 0 && (
        <div className="flex items-center gap-1 h-2.5 rounded-full overflow-hidden bg-muted">
          {completed > 0 && <div className="bg-emerald-500 h-full" style={{ flex: completed }} />}
          {pending > 0 && <div className="bg-blue-500 h-full" style={{ flex: pending }} />}
          {failed > 0 && <div className="bg-red-500 h-full" style={{ flex: failed }} />}
          {expired > 0 && <div className="bg-muted-foreground/40 h-full" style={{ flex: expired }} />}
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">Bundle History</h3>
        {(!bundles || bundles.length === 0) ? (
          <Card>
            <CardContent className="text-center py-12">
              <Package className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <h3 className="text-sm font-medium mb-1">No execution bundles</h3>
              <p className="text-xs text-muted-foreground">Bundles are emitted when agents detect strong trading signals</p>
              <p className="text-[10px] text-muted-foreground mt-1">Deploy an agent with auto-trade enabled and fund it to start generating bundles</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {bundles.map((bundle) => (
              <BundleRow key={bundle.id} bundle={bundle} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BundleRow({ bundle }: { bundle: InstructionBundleRecord }) {
  const config = STATUS_CONFIG[bundle.status] || STATUS_CONFIG.pending;
  const StatusIcon = config.icon;
  const actions = (bundle.actions as any[]) || [];
  const risk = bundle.risk as any;
  const isExpired = Date.now() > bundle.expiresAtMs;

  return (
    <Card data-testid={`bundle-card-${bundle.id}`}>
      <CardContent className="py-3 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <StatusIcon className={`h-4 w-4 ${config.color} shrink-0`} />
            <div className="min-w-0">
              <span className="text-xs font-mono font-medium" data-testid={`text-bundle-id-${bundle.id}`}>
                {bundle.bundleId.slice(0, 12)}...{bundle.bundleId.slice(-4)}
              </span>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <Bot className="h-2.5 w-2.5" />
                <span className="font-mono">{bundle.agentId.slice(0, 8)}...</span>
              </div>
            </div>
          </div>
          <Badge
            variant={bundle.status === "completed" || bundle.status === "recorded" ? "default" : bundle.status === "failed" ? "destructive" : "secondary"}
            data-testid={`badge-status-${bundle.id}`}
          >
            {config.label}
            {isExpired && bundle.status === "pending" ? " (Expired)" : ""}
          </Badge>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {actions.map((action: any, i: number) => (
            <Badge key={i} variant="outline" className="text-[9px] gap-1">
              {action.type === "OPEN" && (
                <>
                  {action.side === "LONG" ? (
                    <TrendingUp className="h-2.5 w-2.5 text-emerald-500" />
                  ) : (
                    <TrendingDown className="h-2.5 w-2.5 text-red-500" />
                  )}
                  {action.side} {action.market} {action.leverage}x
                  <span className="text-muted-foreground">${action.notionalUsd?.toFixed(2)}</span>
                </>
              )}
              {action.type === "CLOSE" && (
                <>
                  <XCircle className="h-2.5 w-2.5" />
                  Close {action.market} {(action.pct * 100).toFixed(0)}%
                </>
              )}
              {action.type === "SET_SLTP" && (
                <>
                  <Shield className="h-2.5 w-2.5" />
                  SL/TP {action.market}
                </>
              )}
              {action.type === "CLAIM_REWARDS" && "Claim Rewards"}
              {action.type === "NOOP" && `Skip: ${action.reason}`}
            </Badge>
          ))}
        </div>

        {risk && (
          <div className="flex items-center gap-4 text-[9px] text-muted-foreground flex-wrap">
            <span>Max Notional: ${risk.maxNotionalUsd?.toFixed(2)}</span>
            <span>Max Leverage: {risk.maxLeverage}x</span>
            <span>Daily Loss Cap: ${risk.maxDailyLossUsd?.toFixed(2)}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 flex-wrap text-[9px] text-muted-foreground">
          <span>{bundle.createdAt ? new Date(bundle.createdAt).toLocaleString() : ""}</span>
          <span className="font-mono">TTL: {Math.max(0, Math.round((bundle.expiresAtMs - Date.now()) / 1000))}s</span>
        </div>
      </CardContent>
    </Card>
  );
}
