import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { usePageSEO } from "@/lib/seo";
import { shortAddress } from "@/lib/tx-verify";
import {
  Search,
  Wallet,
  ArrowDownRight,
  ArrowUpRight,
  Shield,
  CheckCircle,
  XCircle,
  ExternalLink,
  FileText,
  Activity,
  Bot,
  Coins,
  Loader2,
  AlertTriangle,
  Copy,
  Download,
  Import,
  RefreshCw,
} from "lucide-react";

interface LedgerData {
  wallet: string;
  agents: Array<{
    id: string;
    name: string;
    balance: number;
    walletAddress: string;
    status: string;
    totalDeposited: number;
    totalPnl: number;
  }>;
  deposits: Array<{
    id: string;
    agentId: string;
    depositorAddress: string;
    grossAmount: number;
    netAmount: number;
    protocolFee: number;
    txDigest: string | null;
    verified: boolean;
    checkpoint: number | null;
    date: string;
  }>;
  rewards: Array<{
    id: string;
    agentId: string;
    amount: number;
    status: string;
    txDigest: string | null;
    verified: boolean;
    date: string;
  }>;
  recentDigests: Array<{
    type: string;
    digest: string;
    date: string;
    amount: number | null;
    agentId: string;
  }>;
  totals: {
    totalDeposited: number;
    totalFees: number;
    totalNetDeposited: number;
    totalAgentBalance: number;
    pendingRewards: number;
    claimedRewards: number;
    agentCount: number;
    depositCount: number;
    verifiedDepositCount: number;
    orderCount: number;
    positionCount: number;
  };
  feeAddress: string;
}

interface TraceResult {
  digest: string;
  status: string;
  sender?: string;
  checkpoint?: number;
  suiChanges?: Array<{
    owner: string;
    amountMist: string;
    amountSui: number;
    direction: string;
  }>;
  error?: string;
}

interface AnalysisResult {
  txDigest: string;
  status: string;
  sender: string;
  checkpoint: number;
  transfers: Array<{ address: string; amount: number; role: string; rawMist: string }>;
  agentWallet: string | null;
  agentWalletBalance: number | null;
  protocolFee: number;
  grossDeposit: number | null;
  netDeposit: number | null;
  alreadyTracked: boolean;
  agentExists: boolean;
  agentId: string | null;
  recoverable: boolean;
}

interface ImportResult {
  success: boolean;
  txDigest: string;
  agentId: string;
  agentWallet: string;
  netDeposit: number;
  protocolFee: number;
  grossAmount: number;
  sender: string;
  agentBalance: number;
  recoveredAgent: boolean;
  message: string;
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="icon"
      variant="ghost"
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      data-testid="button-copy-debug"
    >
      {copied ? <CheckCircle className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

function DigestLink({ digest }: { digest: string | null }) {
  if (!digest) return <span className="text-muted-foreground text-[10px]">No digest</span>;
  return (
    <a
      href={`https://suiscan.xyz/mainnet/tx/${digest}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary text-[10px] font-mono hover:underline flex items-center gap-1"
      data-testid="link-digest"
    >
      {shortAddress(digest)}
      <ExternalLink className="h-2.5 w-2.5" />
    </a>
  );
}

function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <Badge variant="default" className="text-[8px]" data-testid="badge-verified">
      <CheckCircle className="h-2 w-2 mr-0.5" />
      Verified
    </Badge>
  ) : (
    <Badge variant="secondary" className="text-[8px]" data-testid="badge-unverified">
      <XCircle className="h-2 w-2 mr-0.5" />
      Unverified
    </Badge>
  );
}

export default function DebugLedger() {
  usePageSEO({
    title: "Money Flow Debugger",
    description: "Track all deposits, withdrawals, rewards, and on-chain transactions",
  });

  const account = useCurrentAccount();
  const { toast } = useToast();
  const [traceDigest, setTraceDigest] = useState("");
  const [traceResult, setTraceResult] = useState<TraceResult | null>(null);
  const [recoveryDigest, setRecoveryDigest] = useState("");
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const walletParam = account?.address ? `?wallet=${account.address}` : "";

  const { data: ledger, isLoading } = useQuery<LedgerData>({
    queryKey: ["/api/debug/ledger" + walletParam],
    refetchInterval: 15000,
  });

  const traceMutation = useMutation({
    mutationFn: async (digest: string) => {
      const res = await apiRequest("POST", "/api/debug/trace", { digest });
      return res.json() as Promise<TraceResult>;
    },
    onSuccess: (data) => {
      setTraceResult(data);
    },
    onError: (err: Error) => {
      toast({ title: "Trace failed", description: err.message, variant: "destructive" });
    },
  });

  const analyzeMutation = useMutation({
    mutationFn: async (txDigest: string) => {
      const res = await apiRequest("POST", "/api/recovery/analyze-tx", { txDigest });
      return res.json() as Promise<AnalysisResult>;
    },
    onSuccess: (data) => {
      setAnalysisResult(data);
      setImportResult(null);
    },
    onError: (err: Error) => {
      toast({ title: "Analysis failed", description: err.message, variant: "destructive" });
    },
  });

  const importMutation = useMutation({
    mutationFn: async ({ txDigest, walletAddress }: { txDigest: string; walletAddress: string }) => {
      const res = await apiRequest("POST", "/api/recovery/import-deposit", { txDigest, walletAddress });
      return res.json() as Promise<ImportResult>;
    },
    onSuccess: (data) => {
      setImportResult(data);
      toast({ title: "Deposit recovered", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/debug/ledger" + walletParam] });
    },
    onError: (err: Error) => {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
  });

  const totals = ledger?.totals;

  return (
    <div className="p-4 md:p-6 pb-20 md:pb-6 space-y-4 max-w-4xl mx-auto" data-testid="page-debug-ledger">
      <div className="space-y-0.5">
        <h2 className="text-lg md:text-xl font-bold tracking-tight flex items-center gap-2">
          <Search className="h-5 w-5 text-primary" />
          Money Flow Debugger
        </h2>
        <p className="text-xs text-muted-foreground">
          Track all deposits, rewards, agent balances, and on-chain transaction digests
        </p>
      </div>

      {account?.address && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 flex-wrap">
            <Wallet className="h-4 w-4 text-primary" />
            <span className="text-xs text-muted-foreground">Connected:</span>
            <span className="text-xs font-mono" data-testid="text-debug-wallet">{account.address}</span>
            <CopyBtn text={account.address} />
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
            <Card>
              <CardContent className="p-3 text-center">
                <p className="text-[9px] text-muted-foreground">Total Deposited</p>
                <p className="text-sm font-mono font-bold" data-testid="text-debug-deposited">
                  {(totals?.totalDeposited ?? 0).toFixed(4)}
                </p>
                <p className="text-[8px] text-muted-foreground">{totals?.depositCount ?? 0} deposits</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 text-center">
                <p className="text-[9px] text-muted-foreground">Protocol Fees</p>
                <p className="text-sm font-mono font-bold text-chart-4" data-testid="text-debug-fees">
                  {(totals?.totalFees ?? 0).toFixed(4)}
                </p>
                <p className="text-[8px] text-muted-foreground">2% on deposits</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 text-center">
                <p className="text-[9px] text-muted-foreground">Agent Balances</p>
                <p className="text-sm font-mono font-bold" data-testid="text-debug-balance">
                  {(totals?.totalAgentBalance ?? 0).toFixed(4)}
                </p>
                <p className="text-[8px] text-muted-foreground">{totals?.agentCount ?? 0} agents</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 text-center">
                <p className="text-[9px] text-muted-foreground">Pending Rewards</p>
                <p className="text-sm font-mono font-bold text-emerald-500" data-testid="text-debug-pending">
                  {(totals?.pendingRewards ?? 0).toFixed(4)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 text-center">
                <p className="text-[9px] text-muted-foreground">Verified Claims</p>
                <p className="text-sm font-mono font-bold" data-testid="text-debug-claimed">
                  {(totals?.claimedRewards ?? 0).toFixed(4)}
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Search className="h-4 w-4" />
                Trace Transaction
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Input
                  placeholder="Paste a SUI transaction digest..."
                  value={traceDigest}
                  onChange={(e) => setTraceDigest(e.target.value)}
                  className="font-mono text-xs"
                  data-testid="input-trace-digest"
                />
                <Button
                  size="sm"
                  onClick={() => traceMutation.mutate(traceDigest)}
                  disabled={!traceDigest || traceMutation.isPending}
                  data-testid="button-trace"
                >
                  {traceMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Trace"}
                </Button>
              </div>

              {traceResult && (
                <div className="mt-3 bg-muted rounded-md p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs font-medium">Result</span>
                    <Badge variant={traceResult.status === "success" ? "default" : "destructive"} className="text-[8px]">
                      {traceResult.status}
                    </Badge>
                  </div>
                  {traceResult.error && (
                    <div className="flex items-center gap-1 text-xs text-destructive">
                      <AlertTriangle className="h-3 w-3" />
                      {traceResult.error}
                    </div>
                  )}
                  {traceResult.sender && (
                    <div className="text-[10px] flex items-center gap-1">
                      <span className="text-muted-foreground">Sender:</span>
                      <span className="font-mono">{traceResult.sender}</span>
                      <CopyBtn text={traceResult.sender} />
                    </div>
                  )}
                  {traceResult.checkpoint && (
                    <div className="text-[10px]">
                      <span className="text-muted-foreground">Checkpoint: </span>
                      <span className="font-mono">{traceResult.checkpoint}</span>
                    </div>
                  )}
                  {traceResult.suiChanges && traceResult.suiChanges.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">SUI Balance Changes</p>
                      {traceResult.suiChanges.map((c, i) => (
                        <div key={i} className="flex items-center gap-2 text-[10px] bg-background rounded px-2 py-1">
                          {c.direction === "RECEIVED" ? (
                            <ArrowDownRight className="h-3 w-3 text-emerald-500 shrink-0" />
                          ) : (
                            <ArrowUpRight className="h-3 w-3 text-red-500 shrink-0" />
                          )}
                          <span className={`font-mono ${c.direction === "RECEIVED" ? "text-emerald-500" : "text-red-500"}`}>
                            {c.direction === "RECEIVED" ? "+" : ""}{c.amountSui.toFixed(4)} SUI
                          </span>
                          <span className="font-mono text-muted-foreground truncate">{shortAddress(c.owner)}</span>
                          <CopyBtn text={c.owner} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Download className="h-4 w-4" />
                Recover Deposit
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Input
                  placeholder="Paste a SUI transaction digest..."
                  value={recoveryDigest}
                  onChange={(e) => setRecoveryDigest(e.target.value)}
                  className="font-mono text-xs"
                  data-testid="input-recovery-digest"
                />
                <Button
                  size="sm"
                  onClick={() => analyzeMutation.mutate(recoveryDigest)}
                  disabled={!recoveryDigest || analyzeMutation.isPending}
                  data-testid="button-analyze"
                >
                  {analyzeMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Analyze"}
                </Button>
              </div>

              {analysisResult && (
                <div className="mt-3 bg-muted rounded-md p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs font-medium">Analysis Result</span>
                    <Badge variant={analysisResult.status === "success" ? "default" : "destructive"} className="text-[8px]" data-testid="badge-analysis-status">
                      {analysisResult.status}
                    </Badge>
                  </div>

                  <div className="text-[10px] flex items-center gap-1">
                    <span className="text-muted-foreground">Sender:</span>
                    <span className="font-mono" data-testid="text-analysis-sender">{shortAddress(analysisResult.sender)}</span>
                    <CopyBtn text={analysisResult.sender} />
                  </div>

                  {analysisResult.agentWallet && (
                    <div className="text-[10px] flex items-center gap-1">
                      <span className="text-muted-foreground">Agent Wallet:</span>
                      <span className="font-mono" data-testid="text-analysis-agent-wallet">{shortAddress(analysisResult.agentWallet)}</span>
                      <CopyBtn text={analysisResult.agentWallet} />
                    </div>
                  )}

                  {analysisResult.agentWalletBalance !== null && (
                    <div className="text-[10px]">
                      <span className="text-muted-foreground">Agent Wallet On-Chain Balance: </span>
                      <span className="font-mono" data-testid="text-analysis-wallet-balance">{analysisResult.agentWalletBalance.toFixed(4)} SUI</span>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-2 mt-2 text-[10px]">
                    <div className="bg-background rounded px-2 py-1 text-center">
                      <p className="text-muted-foreground">Gross Deposit</p>
                      <p className="font-mono font-bold" data-testid="text-analysis-gross">{analysisResult.grossDeposit !== null ? analysisResult.grossDeposit.toFixed(4) : "—"} SUI</p>
                    </div>
                    <div className="bg-background rounded px-2 py-1 text-center">
                      <p className="text-muted-foreground">Net Deposit</p>
                      <p className="font-mono font-bold" data-testid="text-analysis-net">{analysisResult.netDeposit !== null ? analysisResult.netDeposit.toFixed(4) : "—"} SUI</p>
                    </div>
                    <div className="bg-background rounded px-2 py-1 text-center">
                      <p className="text-muted-foreground">Protocol Fee</p>
                      <p className="font-mono font-bold text-chart-4" data-testid="text-analysis-fee">{analysisResult.protocolFee.toFixed(4)} SUI</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap mt-2">
                    <Badge variant={analysisResult.alreadyTracked ? "default" : "secondary"} className="text-[8px]" data-testid="badge-already-tracked">
                      {analysisResult.alreadyTracked ? <CheckCircle className="h-2 w-2 mr-0.5" /> : <XCircle className="h-2 w-2 mr-0.5" />}
                      {analysisResult.alreadyTracked ? "Already Tracked" : "Not Tracked"}
                    </Badge>
                    <Badge variant={analysisResult.agentExists ? "default" : "secondary"} className="text-[8px]" data-testid="badge-agent-exists">
                      {analysisResult.agentExists ? <CheckCircle className="h-2 w-2 mr-0.5" /> : <XCircle className="h-2 w-2 mr-0.5" />}
                      {analysisResult.agentExists ? "Agent Exists" : "No Agent"}
                    </Badge>
                    <Badge variant={analysisResult.recoverable ? "default" : "destructive"} className="text-[8px]" data-testid="badge-recoverable">
                      {analysisResult.recoverable ? <CheckCircle className="h-2 w-2 mr-0.5" /> : <XCircle className="h-2 w-2 mr-0.5" />}
                      {analysisResult.recoverable ? "Recoverable" : "Not Recoverable"}
                    </Badge>
                  </div>

                  {analysisResult.recoverable && !analysisResult.alreadyTracked && account?.address && (
                    <Button
                      size="sm"
                      className="mt-2"
                      onClick={() => importMutation.mutate({ txDigest: recoveryDigest, walletAddress: account.address })}
                      disabled={importMutation.isPending}
                      data-testid="button-import-deposit"
                    >
                      {importMutation.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : (
                        <Import className="h-3 w-3 mr-1" />
                      )}
                      Import Deposit
                    </Button>
                  )}
                </div>
              )}

              {importResult && (
                <div className="mt-3 bg-muted rounded-md p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs font-medium flex items-center gap-1">
                      <RefreshCw className="h-3 w-3" />
                      Import Result
                    </span>
                    <Badge variant={importResult.success ? "default" : "destructive"} className="text-[8px]" data-testid="badge-import-status">
                      {importResult.success ? "Success" : "Failed"}
                    </Badge>
                  </div>
                  <p className="text-[10px] text-muted-foreground" data-testid="text-import-message">{importResult.message}</p>
                  {importResult.success && (
                    <>
                      <div className="text-[10px] flex items-center gap-1">
                        <span className="text-muted-foreground">Agent ID:</span>
                        <span className="font-mono" data-testid="text-import-agent-id">{shortAddress(importResult.agentId)}</span>
                        <CopyBtn text={importResult.agentId} />
                      </div>
                      <div className="text-[10px]">
                        <span className="text-muted-foreground">Recovered Amount: </span>
                        <span className="font-mono font-bold text-emerald-500" data-testid="text-import-amount">{importResult.netDeposit.toFixed(4)} SUI</span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Tabs defaultValue="deposits" className="w-full">
            <TabsList className="w-full grid grid-cols-4">
              <TabsTrigger value="deposits" className="text-[10px]" data-testid="tab-debug-deposits">
                <Coins className="h-3 w-3 mr-1" />
                Deposits
              </TabsTrigger>
              <TabsTrigger value="rewards" className="text-[10px]" data-testid="tab-debug-rewards">
                <Shield className="h-3 w-3 mr-1" />
                Rewards
              </TabsTrigger>
              <TabsTrigger value="agents" className="text-[10px]" data-testid="tab-debug-agents">
                <Bot className="h-3 w-3 mr-1" />
                Agents
              </TabsTrigger>
              <TabsTrigger value="digests" className="text-[10px]" data-testid="tab-debug-digests">
                <FileText className="h-3 w-3 mr-1" />
                Recent TXs
              </TabsTrigger>
            </TabsList>

            <TabsContent value="deposits" className="mt-2 space-y-1.5">
              {(ledger?.deposits || []).length === 0 ? (
                <Card>
                  <CardContent className="text-center py-8">
                    <Coins className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">No deposits recorded yet</p>
                  </CardContent>
                </Card>
              ) : (
                (ledger?.deposits || []).map((d) => (
                  <Card key={d.id}>
                    <CardContent className="p-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <ArrowDownRight className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                          <div>
                            <p className="text-xs font-mono font-bold">{d.grossAmount.toFixed(4)} SUI</p>
                            <p className="text-[9px] text-muted-foreground">
                              Net: {d.netAmount.toFixed(4)} | Fee: {d.protocolFee.toFixed(4)}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <VerifiedBadge verified={d.verified} />
                          <DigestLink digest={d.txDigest} />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 text-[9px] text-muted-foreground flex-wrap">
                        <span>Depositor: {shortAddress(d.depositorAddress)}</span>
                        <span>Agent: {shortAddress(d.agentId)}</span>
                        {d.checkpoint && <span>CP: {d.checkpoint}</span>}
                        {d.date && <span>{new Date(d.date).toLocaleString()}</span>}
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>

            <TabsContent value="rewards" className="mt-2 space-y-1.5">
              {(ledger?.rewards || []).length === 0 ? (
                <Card>
                  <CardContent className="text-center py-8">
                    <Shield className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">No rewards recorded yet</p>
                  </CardContent>
                </Card>
              ) : (
                (ledger?.rewards || []).map((r) => (
                  <Card key={r.id}>
                    <CardContent className="p-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <Shield className={`h-3.5 w-3.5 shrink-0 ${r.status === "claimed" ? "text-emerald-500" : "text-chart-4"}`} />
                          <div>
                            <p className="text-xs font-mono font-bold">{r.amount.toFixed(4)} SUI</p>
                            <p className="text-[9px] text-muted-foreground">Agent: {shortAddress(r.agentId)}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Badge variant={r.status === "claimed" ? "default" : "secondary"} className="text-[8px]">
                            {r.status}
                          </Badge>
                          {r.status === "claimed" && <VerifiedBadge verified={r.verified} />}
                          <DigestLink digest={r.txDigest} />
                        </div>
                      </div>
                      {r.date && (
                        <p className="text-[9px] text-muted-foreground mt-1">{new Date(r.date).toLocaleString()}</p>
                      )}
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>

            <TabsContent value="agents" className="mt-2 space-y-1.5">
              {(ledger?.agents || []).length === 0 ? (
                <Card>
                  <CardContent className="text-center py-8">
                    <Bot className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">No agents found</p>
                  </CardContent>
                </Card>
              ) : (
                (ledger?.agents || []).map((a) => (
                  <Card key={a.id}>
                    <CardContent className="p-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <Bot className={`h-3.5 w-3.5 shrink-0 ${a.status === "running" ? "text-primary" : "text-muted-foreground"}`} />
                          <div>
                            <p className="text-xs font-bold">{a.name}</p>
                            <p className="text-[9px] text-muted-foreground font-mono">{shortAddress(a.id)}</p>
                          </div>
                        </div>
                        <Badge variant={a.status === "running" ? "default" : "secondary"} className="text-[8px]">
                          {a.status}
                        </Badge>
                      </div>
                      <div className="grid grid-cols-3 gap-2 mt-2 text-[10px]">
                        <div className="bg-muted rounded px-2 py-1 text-center">
                          <p className="text-muted-foreground">Balance</p>
                          <p className="font-mono font-bold">{a.balance.toFixed(4)}</p>
                        </div>
                        <div className="bg-muted rounded px-2 py-1 text-center">
                          <p className="text-muted-foreground">Deposited</p>
                          <p className="font-mono font-bold">{(a.totalDeposited || 0).toFixed(4)}</p>
                        </div>
                        <div className="bg-muted rounded px-2 py-1 text-center">
                          <p className="text-muted-foreground">PnL</p>
                          <p className={`font-mono font-bold ${a.totalPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                            {a.totalPnl >= 0 ? "+" : ""}{a.totalPnl.toFixed(4)}
                          </p>
                        </div>
                      </div>
                      {a.walletAddress && (
                        <div className="flex items-center gap-1 mt-1.5 text-[9px] text-muted-foreground">
                          <Wallet className="h-2.5 w-2.5" />
                          <span className="font-mono">{a.walletAddress}</span>
                          <CopyBtn text={a.walletAddress} />
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>

            <TabsContent value="digests" className="mt-2 space-y-1.5">
              {(ledger?.recentDigests || []).length === 0 ? (
                <Card>
                  <CardContent className="text-center py-8">
                    <FileText className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">No transaction digests recorded yet</p>
                  </CardContent>
                </Card>
              ) : (
                (ledger?.recentDigests || []).map((d, i) => (
                  <Card key={`${d.digest}-${i}`}>
                    <CardContent className="p-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[8px]">{d.type}</Badge>
                          <DigestLink digest={d.digest} />
                        </div>
                        <div className="flex items-center gap-1.5">
                          {d.amount !== null && (
                            <span className="text-[10px] font-mono">{d.amount.toFixed(4)} SUI</span>
                          )}
                          <span className="text-[9px] text-muted-foreground">
                            {d.date ? new Date(d.date).toLocaleString() : ""}
                          </span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>
          </Tabs>

          <Card>
            <CardContent className="p-3">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Shield className="h-3 w-3" />
                <span>Protocol Fee Address: </span>
                <span className="font-mono">{ledger?.feeAddress}</span>
                {ledger?.feeAddress && <CopyBtn text={ledger.feeAddress} />}
              </div>
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-1">
                <Activity className="h-3 w-3" />
                <span>
                  {totals?.verifiedDepositCount ?? 0} verified deposits |{" "}
                  {totals?.orderCount ?? 0} verified orders |{" "}
                  {totals?.positionCount ?? 0} verified positions
                </span>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
