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
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { usePageSEO } from "@/lib/seo";
import { shortAddress, waitForFinalized } from "@/lib/tx-verify";
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

interface WalletRecoveryResult {
  walletAddress: string;
  agentCount: number;
  items: Array<{
    agentId: string;
    agentName: string;
    agentWallet: string;
    dbBalance: number;
    onChainBalance: number;
    difference: number;
    status: string;
    recoverable: boolean;
  }>;
  totals: {
    dbBalance: number;
    onChainBalance: number;
    recoverable: number;
  };
}

interface SyncResult {
  success: boolean;
  agentId: string;
  agentName: string;
  previousBalance: number;
  newBalance: number;
  recovered: number;
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
  const [recoveryWallet, setRecoveryWallet] = useState("");
  const [walletRecoveryResult, setWalletRecoveryResult] = useState<WalletRecoveryResult | null>(null);

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

  const walletScanMutation = useMutation({
    mutationFn: async (walletAddress: string) => {
      const res = await apiRequest("POST", "/api/recovery/by-wallet", { walletAddress });
      return res.json() as Promise<WalletRecoveryResult>;
    },
    onSuccess: (data) => {
      setWalletRecoveryResult(data);
    },
    onError: (err: Error) => {
      toast({ title: "Scan failed", description: err.message, variant: "destructive" });
    },
  });

  const [claimAllPending, setClaimAllPending] = useState(false);
  const [withdrawingAgentId, setWithdrawingAgentId] = useState<string | null>(null);
  const [withdrawAllPending, setWithdrawAllPending] = useState(false);
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const syncBalanceMutation = useMutation({
    mutationFn: async ({ agentId, walletAddress }: { agentId: string; walletAddress: string }) => {
      const res = await apiRequest("POST", "/api/recovery/sync-balance", { agentId, walletAddress });
      return res.json() as Promise<SyncResult>;
    },
    onSuccess: (data) => {
      toast({ title: "Balance synced", description: data.message });
      if (recoveryWallet) walletScanMutation.mutate(recoveryWallet);
      queryClient.invalidateQueries({ queryKey: ["/api/debug/ledger" + walletParam] });
    },
    onError: (err: Error) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  const handleClaimAll = async () => {
    if (!walletRecoveryResult || !account?.address) return;
    const recoverableItems = walletRecoveryResult.items.filter(i => i.recoverable);
    if (recoverableItems.length === 0) return;
    setClaimAllPending(true);
    let successCount = 0;
    let totalRecovered = 0;
    for (const item of recoverableItems) {
      try {
        const res = await apiRequest("POST", "/api/recovery/sync-balance", { agentId: item.agentId, walletAddress: account.address });
        const data = await res.json() as SyncResult;
        if (data.success) {
          successCount++;
          totalRecovered += data.recovered;
        }
      } catch {}
    }
    setClaimAllPending(false);
    if (successCount > 0) {
      toast({ title: "Funds claimed", description: `${successCount} agent${successCount !== 1 ? "s" : ""} synced, ${totalRecovered.toFixed(4)} SUI recovered` });
    }
    if (recoveryWallet) walletScanMutation.mutate(recoveryWallet);
    queryClient.invalidateQueries({ queryKey: ["/api/debug/ledger" + walletParam] });
  };

  const handleWithdrawToWallet = (agentId: string) => {
    if (!account?.address) return;
    setWithdrawingAgentId(agentId);

    const authTx = new Transaction();
    authTx.setSender(account.address);
    authTx.setGasBudget(10_000_000);
    authTx.transferObjects(
      [authTx.splitCoins(authTx.gas, [authTx.pure.u64(1)])],
      account.address
    );

    signAndExecute(
      { transaction: authTx },
      {
        onSuccess: async (result) => {
          try {
            const txDigest = result.digest;
            await waitForFinalized(txDigest);
            const res = await apiRequest("POST", "/api/recovery/withdraw-to-wallet", {
              agentId,
              walletAddress: account.address,
              authTxDigest: txDigest,
            });
            const data = await res.json();
            if (data.success) {
              toast({ title: "Funds withdrawn", description: `${data.amount.toFixed(4)} SUI sent to your wallet (tx: ${data.txDigest?.slice(0, 12)}...)` });
            } else {
              toast({ title: "Withdrawal failed", description: data.message || "Unknown error", variant: "destructive" });
            }
          } catch (err: any) {
            toast({ title: "Withdrawal failed", description: err.message, variant: "destructive" });
          } finally {
            setWithdrawingAgentId(null);
            if (recoveryWallet) walletScanMutation.mutate(recoveryWallet);
            queryClient.invalidateQueries({ queryKey: ["/api/debug/ledger" + walletParam] });
          }
        },
        onError: (err) => {
          setWithdrawingAgentId(null);
          toast({ title: "Authorization cancelled", description: "You need to approve the wallet transaction to withdraw.", variant: "destructive" });
        },
      }
    );
  };

  const handleWithdrawAll = async () => {
    if (!walletRecoveryResult || !account?.address) return;
    const withdrawableItems = walletRecoveryResult.items.filter(i => i.onChainBalance > 0.01);
    if (withdrawableItems.length === 0) {
      toast({ title: "Nothing to withdraw", description: "No agents have on-chain balance to withdraw.", variant: "destructive" });
      return;
    }
    setWithdrawAllPending(true);

    const authTx = new Transaction();
    authTx.setSender(account.address);
    authTx.setGasBudget(10_000_000);
    authTx.transferObjects(
      [authTx.splitCoins(authTx.gas, [authTx.pure.u64(1)])],
      account.address
    );

    signAndExecute(
      { transaction: authTx },
      {
        onSuccess: async (result) => {
          try {
            const txDigest = result.digest;
            await waitForFinalized(txDigest);
            let successCount = 0;
            let totalWithdrawn = 0;
            for (const item of withdrawableItems) {
              try {
                const res = await apiRequest("POST", "/api/recovery/withdraw-to-wallet", {
                  agentId: item.agentId,
                  walletAddress: account.address,
                  authTxDigest: txDigest,
                });
                const data = await res.json();
                if (data.success) {
                  successCount++;
                  totalWithdrawn += data.amount;
                }
              } catch {}
            }
            if (successCount > 0) {
              toast({ title: "Funds withdrawn", description: `${totalWithdrawn.toFixed(4)} SUI from ${successCount} agent${successCount !== 1 ? "s" : ""} sent to your wallet` });
            }
          } catch (err: any) {
            toast({ title: "Withdrawal failed", description: err.message, variant: "destructive" });
          } finally {
            setWithdrawAllPending(false);
            if (recoveryWallet) walletScanMutation.mutate(recoveryWallet);
            queryClient.invalidateQueries({ queryKey: ["/api/debug/ledger" + walletParam] });
          }
        },
        onError: () => {
          setWithdrawAllPending(false);
          toast({ title: "Authorization cancelled", description: "You need to approve the wallet transaction.", variant: "destructive" });
        },
      }
    );
  };

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
          <CardContent className="p-3 flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary shrink-0" />
            <span className="text-xs text-muted-foreground shrink-0">Connected:</span>
            <span className="text-xs font-mono truncate min-w-0" data-testid="text-debug-wallet">{account.address}</span>
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
              <form onSubmit={(e) => { e.preventDefault(); if (traceDigest && !traceMutation.isPending) traceMutation.mutate(traceDigest); }} className="space-y-2">
                <Input
                  placeholder="Paste a SUI transaction digest..."
                  value={traceDigest}
                  onChange={(e) => setTraceDigest(e.target.value)}
                  className="font-mono text-xs"
                  data-testid="input-trace-digest"
                />
                <Button
                  type="submit"
                  size="sm"
                  className="w-full"
                  disabled={!traceDigest || traceMutation.isPending}
                  data-testid="button-trace"
                >
                  {traceMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Search className="h-3 w-3 mr-1" />Trace</>}
                </Button>
              </form>

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
                Recover Funds
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-[10px] text-muted-foreground">
                Scan your wallet to find any lost or untracked SUI across your agents.
              </p>
              <form onSubmit={(e) => { e.preventDefault(); if (recoveryWallet && !walletScanMutation.isPending) walletScanMutation.mutate(recoveryWallet); }} className="space-y-2">
                <Input
                  placeholder="Paste your SUI wallet address..."
                  value={recoveryWallet}
                  onChange={(e) => setRecoveryWallet(e.target.value)}
                  className="font-mono text-xs"
                  data-testid="input-recovery-wallet"
                />
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    className="flex-1"
                    disabled={!recoveryWallet || walletScanMutation.isPending}
                    data-testid="button-scan-wallet"
                  >
                    {walletScanMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Search className="h-3 w-3 mr-1" />Scan Wallet</>}
                  </Button>
                  {account?.address && !recoveryWallet && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setRecoveryWallet(account.address)}
                      data-testid="button-use-connected-wallet"
                    >
                      <Wallet className="h-3 w-3 mr-1" />
                      Use Mine
                    </Button>
                  )}
                </div>
              </form>

              {walletRecoveryResult && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs font-medium">{walletRecoveryResult.agentCount} Agent{walletRecoveryResult.agentCount !== 1 ? "s" : ""} Found</span>
                    {walletRecoveryResult.totals.recoverable > 0 && (
                      <Badge variant="default" className="text-[8px]" data-testid="badge-total-recoverable">
                        <Download className="h-2 w-2 mr-0.5" />
                        {walletRecoveryResult.totals.recoverable.toFixed(4)} SUI recoverable
                      </Badge>
                    )}
                  </div>

                  {walletRecoveryResult.agentCount === 0 && (
                    <div className="bg-muted rounded-md p-3 text-center">
                      <p className="text-[10px] text-muted-foreground">No agents found for this wallet address</p>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                    <div className="bg-muted rounded px-2 py-1 text-center">
                      <p className="text-muted-foreground">DB Balance</p>
                      <p className="font-mono font-bold" data-testid="text-total-db">{walletRecoveryResult.totals.dbBalance.toFixed(4)}</p>
                    </div>
                    <div className="bg-muted rounded px-2 py-1 text-center">
                      <p className="text-muted-foreground">On-Chain</p>
                      <p className="font-mono font-bold" data-testid="text-total-onchain">{walletRecoveryResult.totals.onChainBalance.toFixed(4)}</p>
                    </div>
                    <div className="bg-muted rounded px-2 py-1 text-center">
                      <p className="text-muted-foreground">Recoverable</p>
                      <p className={`font-mono font-bold ${walletRecoveryResult.totals.recoverable > 0 ? "text-emerald-500" : ""}`} data-testid="text-total-recoverable">
                        {walletRecoveryResult.totals.recoverable.toFixed(4)}
                      </p>
                    </div>
                  </div>

                  {account?.address && walletRecoveryResult.totals.onChainBalance > 0.01 && (
                    <div className="space-y-1.5">
                      <Button
                        className="w-full"
                        onClick={handleWithdrawAll}
                        disabled={withdrawAllPending || withdrawingAgentId !== null}
                        data-testid="button-withdraw-all"
                      >
                        {withdrawAllPending ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                        ) : (
                          <Wallet className="h-4 w-4 mr-1.5" />
                        )}
                        Withdraw All to Wallet ({walletRecoveryResult.totals.onChainBalance.toFixed(4)} SUI)
                      </Button>
                      <p className="text-[9px] text-muted-foreground text-center">
                        Transfers on-chain SUI from all agent wallets to your connected wallet. Requires wallet approval.
                      </p>
                    </div>
                  )}

                  {walletRecoveryResult.totals.recoverable > 0 && account?.address && (
                    <Button
                      className="w-full"
                      variant="outline"
                      onClick={handleClaimAll}
                      disabled={claimAllPending || syncBalanceMutation.isPending}
                      data-testid="button-claim-all"
                    >
                      {claimAllPending ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                      ) : (
                        <Download className="h-4 w-4 mr-1.5" />
                      )}
                      Sync DB Balances ({walletRecoveryResult.totals.recoverable.toFixed(4)} SUI)
                    </Button>
                  )}

                  {walletRecoveryResult.items.map((item) => (
                    <div key={item.agentId} className="bg-muted rounded-md p-2.5 space-y-1.5">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Bot className={`h-3 w-3 shrink-0 ${item.status === "running" ? "text-emerald-500" : "text-muted-foreground"}`} />
                          <span className="text-xs font-bold truncate">{item.agentName}</span>
                          <Badge variant="secondary" className="text-[8px] shrink-0">{item.status}</Badge>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-1 text-[10px]">
                        <div className="min-w-0">
                          <span className="text-muted-foreground">DB: </span>
                          <span className="font-mono">{item.dbBalance.toFixed(4)}</span>
                        </div>
                        <div className="min-w-0">
                          <span className="text-muted-foreground">Chain: </span>
                          <span className="font-mono">{item.onChainBalance >= 0 ? item.onChainBalance.toFixed(4) : "N/A"}</span>
                        </div>
                        <div className="min-w-0">
                          <span className="text-muted-foreground">Diff: </span>
                          <span className={`font-mono ${item.difference > 0.001 ? "text-emerald-500" : ""}`}>
                            {item.difference > 0 ? "+" : ""}{item.difference.toFixed(4)}
                          </span>
                        </div>
                      </div>
                      <div className="text-[9px] text-muted-foreground flex items-center gap-1">
                        <Wallet className="h-2.5 w-2.5 shrink-0" />
                        <span className="font-mono truncate min-w-0">{shortAddress(item.agentWallet)}</span>
                        <CopyBtn text={item.agentWallet} />
                      </div>
                      {account?.address && item.onChainBalance > 0.01 && (
                        <div className="flex gap-1.5">
                          <Button
                            size="sm"
                            className="flex-1"
                            onClick={() => handleWithdrawToWallet(item.agentId)}
                            disabled={withdrawingAgentId !== null || withdrawAllPending}
                            data-testid={`button-withdraw-${item.agentId}`}
                          >
                            {withdrawingAgentId === item.agentId ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <><Wallet className="h-3 w-3 mr-1" />Withdraw {item.onChainBalance.toFixed(2)} SUI</>
                            )}
                          </Button>
                          {item.recoverable && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => syncBalanceMutation.mutate({ agentId: item.agentId, walletAddress: account.address })}
                              disabled={syncBalanceMutation.isPending || claimAllPending}
                              data-testid={`button-sync-${item.agentId}`}
                            >
                              {syncBalanceMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Download className="h-3 w-3 mr-1" />Sync</>}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Tabs defaultValue="deposits" className="w-full">
            <TabsList className="w-full grid grid-cols-4">
              <TabsTrigger value="deposits" className="text-[10px] px-1" data-testid="tab-debug-deposits">
                <Coins className="h-3 w-3 mr-0.5 shrink-0" />
                <span className="truncate">Deposits</span>
              </TabsTrigger>
              <TabsTrigger value="rewards" className="text-[10px] px-1" data-testid="tab-debug-rewards">
                <Shield className="h-3 w-3 mr-0.5 shrink-0" />
                <span className="truncate">Rewards</span>
              </TabsTrigger>
              <TabsTrigger value="agents" className="text-[10px] px-1" data-testid="tab-debug-agents">
                <Bot className="h-3 w-3 mr-0.5 shrink-0" />
                <span className="truncate">Agents</span>
              </TabsTrigger>
              <TabsTrigger value="digests" className="text-[10px] px-1" data-testid="tab-debug-digests">
                <FileText className="h-3 w-3 mr-0.5 shrink-0" />
                <span className="truncate">TXs</span>
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
                      <div className="flex items-center gap-1.5 mt-1.5 text-[9px] text-muted-foreground flex-wrap">
                        <span className="shrink-0">Depositor: {shortAddress(d.depositorAddress)}</span>
                        <span className="shrink-0">Agent: {shortAddress(d.agentId)}</span>
                        {d.date && <span className="shrink-0">{new Date(d.date).toLocaleDateString()}</span>}
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
